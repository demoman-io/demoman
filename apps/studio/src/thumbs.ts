import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type Library, LibraryError } from "@demoman/runner/studio";
import type { Refusal } from "@demoman/studio-protocol";
import { createChains, isMissing, messageOf, readIfPresent } from "./files.js";

/** The long side of a preview, in pixels (spec §7.1). */
export const THUMB_MAX_SIDE = 640;
/** How many `sips` run at once: a library of twenty takes asks for twenty
 *  previews in the same second, and the machine is also running a browser. */
export const THUMB_CONCURRENCY = 4;

/** How long one make may run before the studio stops waiting for it. One
 *  `sips` of a 1280x800 keyframe took 0.04 s here (2026-10-17, M-series
 *  Mac); 20 s is room for four at once on a machine also running a browser
 *  and an export. A `sips` that hangs past it would otherwise hold its slot
 *  for good, and with four of them every later card would wait for a
 *  preview with no deadline and no word. */
export const THUMB_DEADLINE_MS = 20_000;

/** Writes a JPEG of `src` at most THUMB_MAX_SIDE on its long side to `out`;
 *  rejects with the tool's own words. `signal` aborts when the studio stops
 *  waiting (THUMB_DEADLINE_MS), so the tool can be stopped too. */
export type MakeThumb = (
  src: string,
  out: string,
  signal?: AbortSignal,
) => Promise<void>;

export const sipsThumb: MakeThumb = (src, out, signal) =>
  new Promise((resolve, reject) => {
    execFile(
      "sips",
      ["-s", "format", "jpeg", "-Z", String(THUMB_MAX_SIDE), src, "--out", out],
      // Killed on the deadline's abort: the slot it frees must not leave a
      // fifth sips running beside the next four.
      signal === undefined ? {} : { signal },
      (error, _stdout, stderr) => {
        if (error) {
          reject(new Error(stderr.trim() || error.message));
          return;
        }
        resolve();
      },
    );
  });

export type ThumbAnswer =
  | { ok: true; bytes: Buffer }
  | { ok: false; status: number; refusal: Refusal };

/**
 * Previews of a take's keyframes, made on first request and cached at
 * `takes/<id>/thumbs/<encodeURIComponent(ref)>.jpg`. A failed make is a
 * `thumbFailed` refusal carrying the tool's words, and caches nothing, so the
 * next request tries again.
 */
export function createThumbs(o: {
  library: Library;
  make?: MakeThumb;
  concurrency?: number;
  /** Injected by tests; THUMB_DEADLINE_MS otherwise. */
  deadlineMs?: number;
}): { get(id: string, ref: string): Promise<ThumbAnswer> } {
  const { library } = o;
  const make = o.make ?? sipsThumb;
  const limit = o.concurrency ?? THUMB_CONCURRENCY;
  const deadlineMs = o.deadlineMs ?? THUMB_DEADLINE_MS;
  const perPath = createChains();

  let running = 0;
  const waiting: Array<() => void> = [];
  async function gated<T>(work: () => Promise<T>): Promise<T> {
    if (running >= limit) {
      await new Promise<void>((resolve) => waiting.push(resolve));
    } else {
      running += 1;
    }
    // A finished make hands its slot straight to the next waiter.
    try {
      return await work();
    } finally {
      const next = waiting.shift();
      if (next === undefined) running -= 1;
      else next();
    }
  }

  /** The make, or the studio's own sentence once the deadline passes. The
   *  race, not the abort alone, is what frees the slot: a make that does not
   *  heed its signal still stops holding it. Such a make may still write
   *  `out` after the request has cleaned up, so `out` is removed again once
   *  it settles — otherwise it sits in `thumbs/` for good, counted in the
   *  take's size. */
  async function makeInTime(src: string, out: string): Promise<void> {
    const abort = new AbortController();
    const made = make(src, out, abort.signal);
    let timer: NodeJS.Timeout | undefined;
    const late = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        abort.abort();
        const sweep = () =>
          rm(out, { force: true }).catch((error: unknown) => {
            console.error(
              `studio: ${out} was left by a preview past its deadline and could not be removed (${messageOf(error)})`,
            );
          });
        void made.then(sweep, sweep);
        reject(new Error(`sips did not finish within ${deadlineMs / 1000} s`));
      }, deadlineMs);
    });
    try {
      await Promise.race([made, late]);
    } finally {
      clearTimeout(timer);
    }
  }

  const refused = (
    status: number,
    reason: Refusal["reason"],
    detail: string,
  ): ThumbAnswer => ({ ok: false, status, refusal: { reason, detail } });

  async function takeExists(id: string): Promise<boolean> {
    if (!library.isTakeId(id)) return false;
    const path = join(library.takeDir(id), "scene.json");
    try {
      await stat(path);
      return true;
    } catch (error) {
      if (isMissing(error)) return false;
      throw new LibraryError(
        "libraryUnreadable",
        `could not read ${path} (${messageOf(error)})`,
      );
    }
  }

  const noTake = (id: string): ThumbAnswer =>
    refused(
      404,
      "takeNotFound",
      `There is no take "${id}" in ${library.root}.`,
    );

  return {
    async get(id, ref) {
      if (!(await takeExists(id))) return noTake(id);
      const store = library.frameStore(id);
      let bundle: Awaited<ReturnType<typeof store.getBundle>>;
      try {
        bundle = await store.getBundle(id);
      } catch (error) {
        throw new LibraryError(
          "libraryUnreadable",
          `could not read take ${id}'s frame bundle (${messageOf(error)})`,
        );
      }
      // Only a keyframe the bundle lists: a motion span is not a picture.
      if (!(bundle?.keyframes ?? []).some((k) => k.ref === ref)) {
        return refused(
          404,
          "frameNotFound",
          `Take ${id} holds no frame "${ref}".`,
        );
      }
      const dir = join(library.takeDir(id), "thumbs");
      const cached = join(dir, `${encodeURIComponent(ref)}.jpg`);
      return perPath<ThumbAnswer>(cached, async () => {
        // Re-checked inside the chain: the request ahead of this one made it.
        const hit = await readIfPresent(cached);
        if (hit !== null) return { ok: true, bytes: hit };
        return gated(async (): Promise<ThumbAnswer> => {
          // Not recursive: the take may have been deleted while this request
          // waited for a slot, and a recursive mkdir would make its folder
          // again — a ghost with no scene.json, never listed and so never
          // deletable from the page.
          try {
            await mkdir(dir);
          } catch (error) {
            if (isMissing(error)) return noTake(id);
            if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
          }
          const tag = randomUUID();
          const src = join(dir, `.src-${tag}`);
          const out = join(dir, `.out-${tag}.jpg`);
          try {
            await writeFile(src, await store.load(ref));
            try {
              await makeInTime(src, out);
            } catch (error) {
              return refused(
                500,
                "thumbFailed",
                `Couldn't make a preview of ${ref}: ${messageOf(error)}.`,
              );
            }
            await rename(out, cached);
            return { ok: true, bytes: await readFile(cached) };
          } catch (error) {
            // Deleted between the mkdir and here: the folder is gone, and so
            // is the take, which is what the page should hear.
            if (isMissing(error) && !(await takeExists(id))) return noTake(id);
            throw error;
          } finally {
            // Both, whatever happened: a rename or read that failed after a
            // good make leaves no `.out-*` behind either.
            await rm(src, { force: true });
            await rm(out, { force: true });
          }
        });
      });
    },
  };
}

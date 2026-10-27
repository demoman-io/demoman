import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SceneDocument } from "@demoman/scene-schema";
import type { Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bundleEntry } from "../src/bundle-js.js";
import type {
  DecodeProbeEntry,
  PictureDiff,
  PictureOptions,
} from "../src/decode-probe-entry.js";
import { DECODE_PROBE_GLOBAL } from "../src/entry-globals.js";
import {
  type BrowserSession,
  createBrowserSession,
} from "../src/executor/browser.js";
import { exportTake } from "../src/executor/export.js";
import { createLibrary, type Library } from "../src/executor/library.js";
import {
  CHANGED_SHARE,
  PICTURE_OPTIONS,
  REST_SHARE,
  samePicture,
} from "../src/executor/same-picture.js";
import { createVideoStore } from "../src/executor/videos.js";
import { listenOnLoopback } from "../src/loopback.js";
import { makeDiskTake, putTake } from "./disk-take.js";
import { LOGO_SVG } from "./fixture.js";
import {
  capturedAt,
  HELD_FILM_GLOBAL,
  type HeldFilm,
  SLIDE_FROM,
  SLIDE_SEC,
} from "./held-film-entry.js";

// Measured locally (2026-10-27, M-series Mac, headless): the disk take
// about 2 s, each export 2-4 s, each comparison 2-6 s. x5 for CI
// (fff4505) with margin.
const SETUP_MS = 180_000;
const CASE_MS = 60_000;

let home: string;
let library: Library;
let session: BrowserSession;
const files: Record<string, string> = {};

async function exported(
  name: string,
  takeId: string,
  fileType: "mp4" | "gif",
  aspect?: "9:16",
): Promise<string> {
  const outDir = join(home, name);
  const answer = await exportTake(
    {
      takeId,
      fileType,
      unlisted: true,
      ...(aspect === undefined ? {} : { aspect }),
    },
    {
      library,
      videos: createVideoStore(home, library),
      session,
      door: "agent",
      home,
      outDir,
      log: () => undefined,
    },
    () => undefined,
  );
  if (answer.outcome !== "saved" || answer.fileType === "stills")
    throw new Error(JSON.stringify(answer));
  return answer.file.path;
}

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), "demoman-same-picture-"));
  library = createLibrary(home);
  session = createBrowserSession({ headless: true, log: () => undefined });
  const { takeId, original, bundle } = await makeDiskTake(home);
  // The pointer holds still, as a run's does between steps: the disk take's
  // own glides for all 9 s, and a film never still is never at rest.
  const still = { sourceTimeMs: 0, x: 900, y: 600 };
  await putTake(home, takeId, original, {
    ...bundle,
    cursorSamples: [still, { ...still, sourceTimeMs: 9000 }],
  });
  files.mp4 = await exported("plain-mp4", takeId, "mp4");
  files.gif = await exported("plain-gif", takeId, "gif");
  files.tall = await exported("tall", takeId, "mp4", "9:16");
  // The same take with a logo in one corner: one region of every frame.
  await writeFile(join(home, "acme.svg"), LOGO_SVG);
  const withLogo: SceneDocument = {
    ...original,
    branding: {
      ...original.branding,
      logo: { ref: "acme.svg", corner: "top-right", size: 0.06, opacity: 1 },
    },
  };
  await library.putScene(withLogo);
  files.mp4Logo = await exported("logo-mp4", takeId, "mp4");
  files.gifLogo = await exported("logo-gif", takeId, "gif");
}, SETUP_MS);

afterAll(async () => {
  await session?.close();
  if (home) await rm(home, { recursive: true, force: true });
});

/**
 * `fn` on a loopback page of the session's, with `files` served at their
 * keys and `bundles` installed: a secure context, so WebCodecs is there.
 */
async function onPage<T>(
  files: Record<string, string>,
  bundles: string[],
  fn: (page: Page) => Promise<T>,
): Promise<T> {
  const bytes = new Map<string, Buffer>();
  for (const [at, path] of Object.entries(files))
    bytes.set(at, await readFile(path));
  const server = createServer((req, res) => {
    const body = bytes.get(req.url ?? "");
    res.writeHead(200, {
      "content-type": body === undefined ? "text/html" : "video/mp4",
    });
    res.end(body ?? "<!doctype html><meta charset=utf-8><title>t</title>");
  });
  const work = await session.openWorkPage();
  if (!work.ok) throw new Error(work.detail);
  try {
    await work.page.goto(await listenOnLoopback(server));
    for (const b of bundles)
      await work.page.addScriptTag({ content: await bundleEntry(b) });
    return await fn(work.page);
  } finally {
    server.close();
    await work.page.close();
  }
}

/** A `HeldFilm`, encoded in the page through the export's MP4 sink. */
async function heldFilm(name: string, spec: HeldFilm): Promise<string> {
  const base64 = await onPage(
    {},
    [join(import.meta.dirname, "held-film-entry.ts")],
    (page) =>
      page.evaluate(
        ([g, s]) =>
          (
            globalThis as unknown as Record<
              string,
              (s: HeldFilm) => Promise<string>
            >
          )[g as string]?.(s as HeldFilm) as Promise<string>,
        [HELD_FILM_GLOBAL, spec] as const,
      ),
  );
  const path = join(home, `${name}.mp4`);
  await writeFile(path, Buffer.from(base64, "base64"));
  return path;
}

/** `pictureDiff`'s raw reading of two MP4s, at `options`. */
async function rawDiff(
  a: string,
  b: string,
  options: PictureOptions,
): Promise<PictureDiff> {
  const out = await onPage(
    { "/a": a, "/b": b },
    [join(import.meta.dirname, "..", "src", "decode-probe-entry.ts")],
    (page) =>
      page.evaluate(
        ([g, o]) =>
          (globalThis as unknown as Record<string, DecodeProbeEntry>)[
            g as string
          ]?.pictureDiff("/a", "/b", "video/mp4", o as PictureOptions),
        [DECODE_PROBE_GLOBAL, options] as const,
      ),
  );
  if (out === undefined || "unreadable" in out)
    throw new Error(JSON.stringify(out));
  return out;
}

/** samePicture's answer when both files decoded; throws otherwise. */
async function compared(
  ...args: Parameters<typeof samePicture>
): Promise<{ same: boolean; detail: string }> {
  const out = await samePicture(...args);
  if (!("same" in out)) throw new Error(JSON.stringify(out));
  return out;
}

describe("samePicture", () => {
  it(
    "an MP4 against a copy of itself is the same",
    async () => {
      const copy = join(home, "copy.mp4");
      await copyFile(files.mp4 as string, copy);
      const out = await compared(files.mp4 as string, copy, "mp4", {
        session,
      });
      expect(out.same, out.detail).toBe(true);
      expect(out.detail).toMatch(
        /^at most 0\.000% of the picture changed, over \d+ moments at rest$/,
      );
    },
    CASE_MS,
  );

  it(
    "an MP4 with a logo in one corner is not the same",
    async () => {
      const out = await compared(
        files.mp4 as string,
        files.mp4Logo as string,
        "mp4",
        { session },
      );
      expect(out.same, out.detail).toBe(false);
      expect(out.detail).toMatch(
        /% of the picture changed at [\d.]+s, over the 0\.015% allowed, of \d+ moments at rest$/,
      );
    },
    CASE_MS,
  );

  it(
    "a GIF against itself is the same, and with the logo is not",
    async () => {
      const gif = files.gif as string;
      expect((await compared(gif, gif, "gif", { session })).same).toBe(true);
      const out = await compared(gif, files.gifLogo as string, "gif", {
        session,
      });
      expect(out.same, out.detail).toBe(false);
      expect(out.detail).toMatch(/% of the picture changed/);
    },
    CASE_MS,
  );

  it(
    "another frame size is not the same",
    async () => {
      const out = await compared(
        files.mp4 as string,
        files.tall as string,
        "mp4",
        {
          session,
        },
      );
      expect(out).toMatchObject({ same: false });
      expect(out.detail).toMatch(
        /^the frame size changed, \d+x\d+ to \d+x\d+$/,
      );
    },
    CASE_MS,
  );

  // Decided by the kept output's type, never guessed from a file name.
  it(
    "reads a GIF as a GIF whatever its file is called",
    async () => {
      const bin = join(home, "order.bin");
      await copyFile(files.gif as string, bin);
      const out = await samePicture(bin, bin, "gif", { session });
      expect(out, JSON.stringify(out)).toMatchObject({ same: true });
    },
    CASE_MS,
  );

  it(
    "says which file could not be decoded, and throws when no page opens",
    async () => {
      const junk = join(home, "junk.mp4");
      await writeFile(junk, "not a video");
      const mp4 = files.mp4 as string;
      expect(await samePicture(junk, mp4, "mp4", { session })).toMatchObject({
        undecodable: "committed",
      });
      expect(await samePicture(mp4, junk, "mp4", { session })).toMatchObject({
        undecodable: "new",
      });
      await expect(
        samePicture(mp4, mp4, "mp4", {
          session: {
            openWorkPage: async () => ({
              ok: false,
              reason: "windowDidNotOpen",
              detail: "injected",
            }),
          },
        }),
      ).rejects.toThrow("no page to decode on: injected");
    },
    CASE_MS,
  );

  // A slow screencast catches an animation at a few captures a second, and
  // the export holds each capture until the next: mid-slide, a frame equal
  // to the one before it. Another film of the same script catches the slide
  // at other instants. Neither is a change to the app.
  it(
    "a slide held mid-way by a slow capture is the same as the slide filmed fast",
    async () => {
      const slow = await heldFilm("slow", { captureEvery: 4 });
      const fast = await heldFilm("fast", {});
      // The premise: at 1.25 s the slow film holds a capture from mid-slide,
      // which a one-frame look back reads as at rest, and no frame of the
      // fast film matches it; the fast film is moving there.
      const t = 1.25;
      const shown = capturedAt(t, { captureEvery: 4 });
      expect(shown).toBeGreaterThan(SLIDE_FROM);
      expect(shown).toBeLessThan(SLIDE_FROM + SLIDE_SEC);
      const oneFrame = { ...PICTURE_OPTIONS, restSec: 1 / 30 };
      const held = (await rawDiff(slow, fast, oneFrame)).samples.find(
        (s) => s.t === t,
      );
      expect(held?.moving, JSON.stringify(held)).toBeLessThan(REST_SHARE);
      expect(held?.changed, JSON.stringify(held)).toBeGreaterThan(
        CHANGED_SHARE,
      );
      const moving = (await rawDiff(fast, slow, oneFrame)).samples.find(
        (s) => s.t === t,
      );
      expect(moving?.moving, JSON.stringify(moving)).toBeGreaterThan(
        REST_SHARE,
      );
      const out = await compared(slow, fast, "mp4", { session });
      expect(out.same, out.detail).toBe(true);
      expect(out.detail).toMatch(/over \d+ moments at rest$/);
    },
    CASE_MS,
  );

  it(
    "a block drawn once the slide has stopped is not the same, slow capture or not",
    async () => {
      const slow = await heldFilm("slow-a", { captureEvery: 4 });
      const marked = await heldFilm("marked", { mark: true });
      const out = await compared(slow, marked, "mp4", { session });
      expect(out.same, out.detail).toBe(false);
      // Caught where the panel rests, after the slide.
      const at = Number(/changed at ([\d.]+)s/.exec(out.detail)?.[1]);
      expect(at, out.detail).toBeGreaterThanOrEqual(SLIDE_FROM + SLIDE_SEC);
      expect(out.detail).toMatch(
        /over the 0\.015% allowed, of \d+ moments at rest$/,
      );
    },
    CASE_MS,
  );
});

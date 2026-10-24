import { randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { messageOf } from "../report.js";
import { type Library, pidAlive, readLeases } from "./library.js";
import type { Version, VideoStore } from "./videos.js";

export const EXPIRE_AFTER_MS = 30 * 86_400_000;
export const MIN_INTERVAL_MS = 3_600_000;

export type ExpiryResult =
  | {
      ranAt: string;
      expired: number;
      freedBytes: number;
      skippedLeased: number;
    }
  | { ranAt: string; failed: string };

/** What `status` answers: the last result, none yet, or a state file that
 *  will not read (said, never read as "never ran"). */
export type ExpiryStatus =
  | ExpiryResult
  | { never: true }
  | { unreadable: string };

const isMissing = (e: unknown) => (e as { code?: string }).code === "ENOENT";

const statePath = (library: Library) =>
  join(dirname(library.root), "videos", ".expiry.json");

/** The bytes `rm` frees at `path`, 0 when absent: a link (even to a folder)
 *  counts as itself, since `rm` removes the link and not what it names. */
async function sizeOf(path: string): Promise<number> {
  let s: Awaited<ReturnType<typeof lstat>>;
  try {
    s = await lstat(path);
  } catch (error) {
    if (isMissing(error)) return 0;
    throw error;
  }
  if (!s.isDirectory()) return s.size;
  let total = 0;
  for (const name of await readdir(path))
    total += await sizeOf(join(path, name));
  return total;
}

/** The versions expiry must leave whole (local video library §5). */
async function keptOf(
  versions: Version[],
  library: Library,
): Promise<Set<string>> {
  const kept = new Set<string>();
  const current = versions.filter((v) => v.complete).at(-1);
  if (current) kept.add(current.takeId);
  let newest: { takeId: string; at: string } | null = null;
  for (const v of versions) {
    if (v.edited || !v.hasScript) kept.add(v.takeId);
    for (const row of await library.outputs(v.takeId)) {
      if (newest === null || row.renderedAt > newest.at) {
        newest = { takeId: v.takeId, at: row.renderedAt };
      }
    }
  }
  if (newest !== null) kept.add(newest.takeId);
  return kept;
}

async function readState(
  library: Library,
): Promise<{ lastRanAt: string; result: ExpiryResult } | null> {
  const text = await readFile(statePath(library), "utf8").catch(
    (e: unknown) => {
      if (isMissing(e)) return null;
      throw e;
    },
  );
  return text === null ? null : JSON.parse(text);
}

/** `status`'s `expiry`. */
export async function expiryStatus(library: Library): Promise<ExpiryStatus> {
  try {
    const state = await readState(library);
    return state === null ? { never: true } : state.result;
  } catch (error) {
    return {
      unreadable: `could not read ${statePath(library)} (${messageOf(error)})`,
    };
  }
}

/**
 * Removes the frames and thumbnails of every version over 30 days old that
 * is not kept, at most once an hour. Only `takes/<id>/frames/` and
 * `takes/<id>/thumbs/` go: scene, script, report, status, outputs and every
 * exported file stay. Never throws: a failure is the result, and is saved
 * for `status` like any other.
 */
export async function expireOld(
  store: VideoStore,
  library: Library,
  now: Date,
  opts: { minIntervalMs?: number } = {},
): Promise<ExpiryResult | { skipped: "ranRecently"; lastRanAt: string }> {
  const ranAt = now.toISOString();
  try {
    const last = await readState(library);
    if (
      last !== null &&
      now.getTime() - Date.parse(last.lastRanAt) <
        (opts.minIntervalMs ?? MIN_INTERVAL_MS)
    ) {
      return { skipped: "ranRecently", lastRanAt: last.lastRanAt };
    }
  } catch {
    // A state file that will not read only costs the throttle: this run
    // writes a fresh one, and until then `status` says it is unreadable.
  }
  const tally = { expired: 0, freedBytes: 0, skippedLeased: 0 };
  let result: ExpiryResult;
  try {
    await expire(store, library, now, tally);
    result = { ranAt, ...tally };
  } catch (error) {
    // What was marked before the failure is said too: those versions are gone.
    result = {
      ranAt,
      failed: `${messageOf(error)} (by then ${tally.expired} versions were marked expired, ${tally.freedBytes} bytes)`,
    };
  }
  const path = statePath(library);
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(temp, JSON.stringify({ lastRanAt: ranAt, result }), {
      mode: 0o600,
    });
    await rename(temp, path);
  } catch (error) {
    await rm(temp, { force: true }).catch(() => undefined);
    const lost = `could not write ${path} (${messageOf(error)}), so status cannot say this run's result`;
    return {
      ranAt,
      failed: "failed" in result ? `${result.failed}; and ${lost}` : lost,
    };
  }
  return result;
}

async function expire(
  store: VideoStore,
  library: Library,
  now: Date,
  tally: { expired: number; freedBytes: number; skippedLeased: number },
): Promise<void> {
  const ranAt = now.toISOString();
  for (const video of await store.list()) {
    // An unreadable record is listed as such by the videos tool; its takes
    // are left alone rather than judged without it.
    if ("unreadable" in video) continue;
    const versions = await store.versions(video.id);
    const kept = await keptOf(versions, library);
    for (const v of versions) {
      if (v.expired !== null || kept.has(v.takeId)) continue;
      // NaN (an unreadable date) is never old.
      if (!(now.getTime() - Date.parse(v.createdAt) > EXPIRE_AFTER_MS))
        continue;
      const dir = library.takeDir(v.takeId);
      const leases = await readLeases(join(dir, ".busy"));
      if (leases.some((l) => pidAlive(l.holder.pid))) {
        tally.skippedLeased++;
        continue;
      }
      // shortcut: a lease taken between this check and the rm is not seen; one process, fine; lock when two servers share a library.
      const paths = [join(dir, "frames"), join(dir, "thumbs")];
      let bytes = 0;
      for (const path of paths) {
        try {
          bytes += await sizeOf(path);
        } catch (error) {
          throw new Error(`could not measure ${path} (${messageOf(error)})`);
        }
      }
      // Marked before anything goes: a removal that stops part-way leaves a
      // take that says it expired, never files gone with no record. A mark
      // that will not write throws here, and nothing of the take is removed.
      await store.markExpired(v.takeId, ranAt, bytes);
      tally.expired++;
      tally.freedBytes += bytes;
      for (const path of paths) {
        try {
          await rm(path, { recursive: true, force: true });
        } catch (error) {
          throw new Error(
            `could not remove ${path} (${messageOf(error)}); take ${v.takeId} is marked expired`,
          );
        }
      }
    }
  }
}

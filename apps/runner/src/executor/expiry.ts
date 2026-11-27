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
import { type KeepFootage, keepFootageDays } from "@demoman/run-core";
import { messageOf } from "../report.js";
import { type Library, readLeases } from "./library.js";
import { pidAlive } from "./pid-lock.js";
import { readUserSettings } from "./user-settings.js";
import type { Version, VideoStore } from "./videos.js";

export const DAY_MS = 86_400_000;
export const MIN_INTERVAL_MS = 3_600_000;

/** One video whose footage a pass removed: said by name, never
 *  only counted. */
export type RemovedVideo = {
  videoId: string;
  name: string;
  takeId: string;
  /** When the version was recorded. */
  recordedAt: string;
  bytes: number;
};

/** The most removals a result or the state file names; the rest are a
 *  count (`more`), as `skippedUnreadable` is capped. */
export const REMOVED_SAID = 50;

/** The last pass that removed anything, kept across the passes after it
 *  that removed nothing, so "what went" is never answered by "nothing". */
export type LastRemoval = {
  at: string;
  videos: RemovedVideo[];
  /** Removed but not listed, past `REMOVED_SAID`. */
  more: number;
  bytes: number;
};

export type ExpiryResult =
  | {
      ranAt: string;
      /** The Keep footage setting the pass ran under. Absent from a state
       *  file saved before it existed (then 30 days). */
      keepFootage?: KeepFootage;
      expired: number;
      freedBytes: number;
      skippedLeased: number;
      /** What this pass removed, at most `REMOVED_SAID`. */
      removed?: RemovedVideo[];
      /** One sentence per flow or video left alone because a file it is
       *  judged by would not read; empty when none, at most
       *  SKIPPED_SAID and a count of the rest. Absent from a state file saved
       *  before 0.9.7: read it through `skippedOf`. */
      skippedUnreadable?: string[];
    }
  | { ranAt: string; failed: string };

/** What `status` answers: the last result, none yet, or a state file that
 *  will not read (said, never read as "never ran"). */
export type ExpiryStatus = (
  | ExpiryResult
  | { never: true }
  | { unreadable: string }
) & { lastRemoval?: LastRemoval };

/** The most skips a result names: one cause across a library (a restore
 *  with the wrong owner) would otherwise put thousands of sentences into
 *  status, the state file and the Studio. */
export const SKIPPED_SAID = 20;

const capped = (list: string[]): string[] =>
  list.length <= SKIPPED_SAID
    ? list
    : [
        ...list.slice(0, SKIPPED_SAID),
        `and ${list.length - SKIPPED_SAID} more flows or videos left alone the same way`,
      ];

/** What any expiry answer says it left alone: a result, a status, a pass put
 *  off by the lock (its own list, never the last saved one), or none. */
export function skippedOf(answer: object): string[] {
  return "skippedUnreadable" in answer &&
    Array.isArray(answer.skippedUnreadable)
    ? answer.skippedUnreadable
    : [];
}

const isOld = (v: Version, now: Date, days: number) =>
  // NaN (an unreadable date) is never old.
  now.getTime() - Date.parse(v.createdAt) > days * DAY_MS;

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

type State = {
  lastRanAt: string;
  /** Absent when no pass has finished yet, though one the lock cut short
   *  removed something (`lastRemoval`). */
  result?: ExpiryResult;
  lastRemoval?: LastRemoval;
};

async function readState(library: Library): Promise<State | null> {
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
    if (state === null) return { never: true };
    const result = state.result ?? { never: true as const };
    return state.lastRemoval === undefined
      ? result
      : { ...result, lastRemoval: state.lastRemoval };
  } catch (error) {
    return {
      unreadable: `could not read ${statePath(library)} (${messageOf(error)})`,
    };
  }
}

/**
 * Removes the frames and thumbnails of every version older than the user's
 * Keep footage setting (30 days unless changed) that is not kept,
 * at most once an hour. Only `takes/<id>/frames/` and `takes/<id>/thumbs/`
 * go: scene, script, report, status, outputs and every exported file stay.
 * Forever removes nothing, and so does a setting that will not read: the
 * result says which. What a pass removes is named, and kept as the state's
 * `lastRemoval` until a later pass removes something. Never throws: a
 * failure is the result, and is saved for `status` like any other.
 */
export async function expireOld(
  store: VideoStore,
  library: Library,
  now: Date,
  opts: { minIntervalMs?: number } = {},
): Promise<
  | ExpiryResult
  | { skipped: "ranRecently"; lastRanAt: string }
  /** Another call held the videos lock: the pass stopped at the first take
   *  it could not mark, counting what it did before. The throttle is not
   *  moved, so the next pass is not held back; what it removed is saved. */
  | ({ skipped: "lockHeld"; held: string } & Said)
> {
  const ranAt = now.toISOString();
  let last: State | null = null;
  try {
    last = await readState(library);
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
  const settings = await readUserSettings(dirname(library.root));
  const keep = settings.keepFootage;
  const tally = emptyTally();
  let result: ExpiryResult;
  if (keep === null || keep === undefined) {
    // A choice it cannot read may be Forever: nothing goes until it reads.
    result = {
      ranAt,
      failed: `the Keep footage setting cannot be used (${settings.problems?.keepFootage ?? "it was not read"}), so no footage was removed`,
    };
  } else {
    const days = keepFootageDays(keep);
    try {
      const held =
        days === null ? null : await expire(store, library, now, days, tally);
      const said = saidOf(tally);
      if (held !== null) {
        // Saved only when it removed something: the throttle and last result
        // stay as they were (an empty throttle when there was none), so the
        // next pass goes on from here, and what went is still named.
        const notSaved =
          tally.removed.length === 0
            ? null
            : await save(library, {
                lastRanAt: last?.lastRanAt ?? "",
                // Never a made-up finished result: a pass the lock cut short
                // is not one that looked at the whole library.
                ...(last?.result === undefined ? {} : { result: last.result }),
                ...(await removal(library, last, ranAt, tally)),
              }).then(
                () => null,
                (e: unknown) => messageOf(e),
              );
        return {
          skipped: "lockHeld",
          held:
            notSaved === null
              ? held
              : `${held}; and what it removed could not be saved (${notSaved})`,
          ...said,
        };
      }
      result = { ranAt, keepFootage: keep, ...said };
    } catch (error) {
      // What was marked before the failure is said too: those versions are gone.
      result = {
        ranAt,
        failed: `${messageOf(error)} (by then ${tally.expired} videos were marked expired, ${tally.freedBytes} bytes${namesOf(tally)}${tally.skippedUnreadable.length === 0 ? "" : `; and left alone: ${capped(tally.skippedUnreadable).join("; ")}`})`,
      };
    }
  }
  try {
    await save(library, {
      lastRanAt: ranAt,
      result,
      ...(await removal(library, last, ranAt, tally)),
    });
  } catch (error) {
    const lost = `could not write ${statePath(library)} (${messageOf(error)}), so status cannot say this run's result${tally.removed.length === 0 ? "" : ` or what it removed${namesOf(tally)}`}`;
    return {
      ranAt,
      failed: "failed" in result ? `${result.failed}; and ${lost}` : lost,
    };
  }
  return result;
}

type Tally = {
  expired: number;
  freedBytes: number;
  skippedLeased: number;
  skippedUnreadable: string[];
  removed: RemovedVideo[];
};
type Said = Tally;

const emptyTally = (): Tally => ({
  expired: 0,
  freedBytes: 0,
  skippedLeased: 0,
  skippedUnreadable: [],
  removed: [],
});

const saidOf = (t: Tally): Said => ({
  ...t,
  skippedUnreadable: capped(t.skippedUnreadable),
  removed: t.removed.slice(0, REMOVED_SAID),
});

/** ": <name>, <name>" for a sentence, or nothing; at most REMOVED_SAID
 *  names and a count of the rest. */
const namesOf = (t: Tally): string => {
  if (t.removed.length === 0) return "";
  const named = t.removed.slice(0, REMOVED_SAID).map((r) => r.name);
  const rest = t.removed.length - named.length;
  return `: ${named.join(", ")}${rest > 0 ? ` and ${rest} more` : ""}`;
};

/** This pass's removals as the state's `lastRemoval`, or the last one kept
 *  when it removed nothing. The state is read again first: another pass
 *  (the Studio's start and a run, at once) may have saved its own since
 *  this one began, and neither list may wipe out the other. */
async function removal(
  library: Library,
  last: State | null,
  at: string,
  t: Tally,
): Promise<{ lastRemoval?: LastRemoval }> {
  const now = await readState(library).catch(() => last);
  const theirs = now?.lastRemoval ?? last?.lastRemoval;
  if (t.removed.length === 0)
    return theirs === undefined ? {} : { lastRemoval: theirs };
  const mine: LastRemoval = {
    at,
    videos: t.removed.slice(0, REMOVED_SAID),
    more: Math.max(0, t.removed.length - REMOVED_SAID),
    bytes: t.removed.reduce((n, r) => n + r.bytes, 0),
  };
  // Another pass removed something after this one started: both are named.
  const since = last?.lastRemoval?.at;
  if (theirs === undefined || theirs.at === since) return { lastRemoval: mine };
  const videos = [...mine.videos, ...theirs.videos];
  return {
    lastRemoval: {
      at: mine.at > theirs.at ? mine.at : theirs.at,
      videos: videos.slice(0, REMOVED_SAID),
      more: mine.more + theirs.more + Math.max(0, videos.length - REMOVED_SAID),
      bytes: mine.bytes + theirs.bytes,
    },
  };
}

async function save(library: Library, state: State): Promise<void> {
  const path = statePath(library);
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(temp, JSON.stringify(state), { mode: 0o600 });
    await rename(temp, path);
  } catch (error) {
    await rm(temp, { force: true }).catch(() => undefined);
    throw error;
  }
}

/** Take by take, as before: judged, marked, then its files removed. Only the
 *  mark holds the videos lock, so a merge cannot land between its read and
 *  its write of video.json, and it never waits on the lock: while
 *  another holds it, the pass stops there and answers who, and the next
 *  pass goes on from what is not yet marked. */
async function expire(
  store: VideoStore,
  library: Library,
  now: Date,
  days: number,
  tally: Tally,
): Promise<string | null> {
  const ranAt = now.toISOString();
  for (const video of await store.list()) {
    // An unreadable record is listed as such by the videos tool; its takes
    // are left alone rather than judged without it.
    if ("unreadable" in video) continue;
    // A file that will not read leaves its flow or video alone and is
    // said, rather than failing every pass at the same place.
    const notJudged = (error: unknown) =>
      tally.skippedUnreadable.push(
        `flow ${video.id}: ${messageOf(error)}, so none of its old videos were judged`,
      );
    let versions: Version[];
    try {
      versions = await store.versions(video.id);
    } catch (error) {
      notJudged(error);
      continue;
    }
    // A flow with nothing old to expire is not judged, so a file of it that
    // will not read costs expiry nothing and is no skip.
    if (!versions.some((v) => v.expired === null && isOld(v, now, days)))
      continue;
    let kept: Set<string>;
    try {
      kept = await keptOf(versions, library);
    } catch (error) {
      notJudged(error);
      continue;
    }
    for (const v of versions) {
      if (v.expired !== null || kept.has(v.takeId)) continue;
      if (!isOld(v, now, days)) continue;
      const dir = library.takeDir(v.takeId);
      let leases: Awaited<ReturnType<typeof readLeases>>;
      try {
        leases = await readLeases(join(dir, ".busy"));
      } catch (error) {
        tally.skippedUnreadable.push(
          `video ${v.takeId}: ${messageOf(error)}, so it was kept`,
        );
        continue;
      }
      if (leases.some((l) => pidAlive(l.holder.pid))) {
        tally.skippedLeased++;
        continue;
      }
      // shortcut: a lease taken between this check and the rm is not seen; one process, fine; lock when two servers share a library.
      const paths = [join(dir, "frames"), join(dir, "thumbs")];
      let bytes = 0;
      let unmeasured: string | null = null;
      for (const path of paths) {
        try {
          bytes += await sizeOf(path);
        } catch (error) {
          unmeasured = `could not measure ${path} (${messageOf(error)})`;
          break;
        }
      }
      if (unmeasured !== null) {
        tally.skippedUnreadable.push(
          `video ${v.takeId}: ${unmeasured}, so it was kept`,
        );
        continue;
      }
      // Marked before anything goes: a removal that stops part-way leaves a
      // take that says it expired, never files gone with no record. A mark
      // that will not write throws here, and nothing of the take is removed.
      const marked = await store.exclusive((locked) =>
        locked.markExpired(v.takeId, ranAt, bytes),
      );
      if (!marked.ok) return marked.held;
      tally.expired++;
      tally.freedBytes += bytes;
      tally.removed.push({
        videoId: video.id,
        name: video.name,
        takeId: v.takeId,
        recordedAt: v.createdAt,
        bytes,
      });
      for (const path of paths) {
        try {
          await rm(path, { recursive: true, force: true });
        } catch (error) {
          throw new Error(
            `could not remove ${path} (${messageOf(error)}); video ${v.takeId} is marked expired`,
          );
        }
      }
    }
  }
  return null;
}

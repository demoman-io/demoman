import { sceneLabel } from "@demoman/run-core";
import { messageOf } from "../report.js";
import type { Library } from "./library.js";
import { normaliseName, sameName, startPageOf } from "./video-match.js";
import type { Made, TakeVideo, VideoStore } from "./videos.js";

const NOT_RECORDED = { none: "not recorded: made before videos" };
const MADE: Made = {
  repo: NOT_RECORDED,
  agent: NOT_RECORDED,
  by: NOT_RECORDED,
  door: "migration",
};

/** A run writes its scene before it joins its video; a take younger than
 *  this may still be joining one, so another process must not migrate it. */
export const JOIN_GRACE_MS = 10 * 60_000;

// Ruling 7: never throws over one take; a missing URL is "", an unparseable one stays as written.
export function startPage(originUrl: string | undefined): string {
  if (!originUrl) return "";
  try {
    return startPageOf(originUrl);
  } catch {
    return originUrl;
  }
}

export function hostOf(page: string): string {
  try {
    return new URL(page).host || page;
  } catch {
    return page;
  }
}

type Take = Extract<
  Awaited<ReturnType<Library["list"]>>[number],
  { name: string }
>;
/** A take in no video's versions, and why; `videoId` when its video.json
 *  names one (a member that will not read). */
export type Skipped = { takeId: string; reason: string; videoId?: string };
/** A take to join: `old` is its membership naming a video that is gone. */
type Loose = { take: Take; old: TakeVideo | null };

/** Whether a membership's video is gone. Read fresh past the listing, so a
 *  record made since is not; one that will not read is not gone either,
 *  and `list()` names it. */
async function isGone(
  store: VideoStore,
  listed: Set<string>,
  videoId: string,
): Promise<boolean> {
  if (listed.has(videoId)) return false;
  try {
    return (await store.get(videoId)) === null;
  } catch {
    return false;
  }
}

/**
 * The takes to join: each with no `video.json`, or whose `video.json` names a
 * video that is gone, once older than `JOIN_GRACE_MS`. A take whose
 * `video.json` will not read is skipped, said, and so is a member its video's
 * `versions()` leaves out (a status, script or scene that will not read); one
 * whose video's record will not read is left alone, since `list()` names
 * that record.
 */
async function looseTakes(
  store: VideoStore,
  takes: Take[],
  now: number,
): Promise<{ loose: Loose[]; skipped: Skipped[] }> {
  const records = new Set((await store.list()).map((v) => v.id));
  const loose: Loose[] = [];
  const skipped: Skipped[] = [];
  for (const take of takes) {
    let old: TakeVideo | null;
    try {
      old = await store.videoOf(take.id);
    } catch (error) {
      skipped.push({
        takeId: take.id,
        reason: `its video.json will not read, so no video lists it (${messageOf(error)})`,
      });
      continue;
    }
    if (old !== null && !(await isGone(store, records, old.videoId))) {
      const why = await store.leftOut(take.id, old);
      if (why !== null) {
        skipped.push({
          takeId: take.id,
          reason: `left out of video ${old.videoId}: ${why}`,
          videoId: old.videoId,
        });
      }
      continue;
    }
    if (now - Date.parse(take.createdAt) < JOIN_GRACE_MS) continue;
    loose.push({ take, old });
  }
  return { loose, skipped };
}

/**
 * Every readable take with no `video.json` (or one naming a video that is
 * gone) joins a video: an existing one with the same name and start page,
 * else a new repo-unknown one. An unnamed take is never grouped: it gets a
 * video of its own, named by its start page. Idempotent; also the catch-up
 * path for takes made by something that did not join them, once they are
 * older than `JOIN_GRACE_MS`. Holds the store's lock while it joins; when
 * another process holds it, `deferred` says so and a later call joins them.
 * `skipped` is every take in no video's versions and why, a folder the
 * library cannot read among them. Never throws over one take.
 */
export async function ensureVideos(
  store: VideoStore,
  library: Library,
  now: number = Date.now(),
): Promise<{
  made: number;
  fromTakes: number;
  unreadable: number;
  skipped: Skipped[];
  /** Why takes waiting to join a video were not joined (another process
   *  holds the lock), or null. Those takes are healthy, never `skipped`. */
  deferred: string | null;
}> {
  const entries = await library.list();
  const broken: Skipped[] = [];
  for (const e of entries) {
    if (!("unreadable" in e)) continue;
    // Its video, if its video.json reads: that video is missing a version.
    // One that will not read only leaves the link out; the take is named
    // either way.
    const videoId = await store.videoOf(e.id).then(
      (m) => m?.videoId,
      () => undefined,
    );
    broken.push({
      takeId: e.id,
      reason: e.unreadable,
      ...(videoId === undefined ? {} : { videoId }),
    });
  }
  const takes = entries
    .filter((e): e is Take => "name" in e)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const first = await looseTakes(store, takes, now);
  const done = (
    made: number,
    fromTakes: number,
    skipped: Skipped[],
    deferred: string | null = null,
  ) => ({
    made,
    fromTakes,
    unreadable: broken.length + skipped.length,
    skipped: [...broken, ...skipped],
    deferred,
  });
  if (first.loose.length === 0) return done(0, 0, first.skipped);
  const r = await store.exclusive((locked) =>
    migrate(locked, library, takes, now),
  );
  if (!r.ok) return done(0, 0, first.skipped, r.held);
  return done(r.value.made, r.value.fromTakes, r.value.skipped);
}

async function migrate(
  store: VideoStore,
  library: Library,
  takes: Take[],
  now: number,
): Promise<{ made: number; fromTakes: number; skipped: Skipped[] }> {
  // Again under the lock: another process may have joined some meanwhile.
  const { loose, skipped } = await looseTakes(store, takes, now);
  const videos = (await store.list()).filter((v) => !("unreadable" in v));
  let made = 0;
  let fromTakes = 0;

  for (const { take, old } of loose) {
    try {
      const scene = await library.getScene(take.id);
      if (!scene) {
        skipped.push({
          takeId: take.id,
          reason:
            "not joined to a video: listed as readable but its scene.json was gone when read",
        });
        continue;
      }
      const page = startPage(scene.meta.capture.originUrl);
      // An empty name is no name: unnamed takes are never one video.
      const unnamed = normaliseName(take.name) === "";
      // Ruling 6: the same name on another start page is its own video, named by host, then " 2", " 3".
      const base = unnamed
        ? sceneLabel({ ...scene.meta, name: "" })
        : take.name;
      const bases = unnamed ? [base] : [base, `${base} (${hostOf(page)})`];
      const candidates = [
        ...bases,
        ...Array.from(
          { length: 50 },
          (_, i) => `${bases[bases.length - 1]} ${i + 2}`,
        ),
      ];
      let video = unnamed
        ? undefined
        : videos.find(
            (v) =>
              "startPage" in v &&
              v.startPage === page &&
              candidates.some((c) => sameName(v.name, c)),
          );
      if (!video) {
        for (const name of candidates) {
          const r = await store.create({
            name,
            repo: { unknown: true },
            startPage: page,
          });
          if (r.ok) {
            video = r.video;
            videos.push(video);
            made++;
            break;
          }
        }
        if (!video) {
          // The bound stops a runaway loop; one take must not abort the migration (ruling 7).
          skipped.push({
            takeId: take.id,
            reason: `not joined to a video: no free video name for "${base}" after ${candidates.length} tries`,
          });
          continue;
        }
      }
      // A membership whose video is gone keeps what it recorded (who made
      // it, its revision, an expiry) and only changes video.
      await store.join(take.id, {
        ...(old ?? { made: MADE, recordedRevision: null }),
        videoId: video.id,
      });
      fromTakes++;
    } catch (error) {
      skipped.push({
        takeId: take.id,
        reason: `could not join a video (${messageOf(error)})`,
      });
    }
  }
  return { made, fromTakes, skipped };
}

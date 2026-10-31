import {
  type RefilmInfo,
  type RefusedBeforeRun,
  refilmScript,
} from "@demoman/run-core";
import { messageOf } from "../report.js";
import { type Library, LibraryError } from "./library.js";
import type { VideoRecord, VideoStore } from "./videos.js";

/** A take's re-record: its first half (spec 2026-10-14 re-film §2): the take
 *  and its skeleton, merged into a script — or the reason there is none,
 *  in the door's own shape. */
export async function refilmFromLibrary(
  library: Library,
  takeId: unknown,
): Promise<
  | { ok: true; script: Record<string, unknown>; refilm: RefilmInfo }
  | { ok: false; refusal: RefusedBeforeRun }
> {
  const refuse = (
    reason: string,
    detail: string,
    field: string | null = null,
  ) => ({
    ok: false as const,
    refusal: { outcome: "refusedBeforeRun" as const, reason, detail, field },
  });
  const id = typeof takeId === "string" ? takeId.trim() : "";
  if (id === "" || !library.isTakeId(id)) {
    return refuse(
      "takeNotFound",
      `no video has the id ${JSON.stringify(takeId)} — flows({}) lists each flow's videos and, under outsideFlows, those in none`,
      "takeId",
    );
  }
  let read: Awaited<ReturnType<Library["getSceneRead"]>>;
  try {
    read = await library.getSceneRead(id);
  } catch (error) {
    return refuse(
      "takeUnreadable",
      error instanceof LibraryError ? error.message : messageOf(error),
      "takeId",
    );
  }
  if (read === null) {
    return refuse(
      "takeNotFound",
      `no video has the id ${id} — flows({}) lists each flow's videos and, under outsideFlows, those in none`,
      "takeId",
    );
  }
  const { scene, notes } = read;
  const skeleton = await library.getSkeleton(id);
  let built: ReturnType<typeof refilmScript>;
  try {
    built = refilmScript(scene, skeleton);
  } catch (error) {
    // A scene.json the schema read but the merge could not build from is a
    // take that cannot be read for a re-film: said, never a crashed run.
    return refuse(
      "takeUnreadable",
      `video ${id} could not be built into a script (${messageOf(error)})`,
      "takeId",
    );
  }
  if (!built.ok) return refuse(built.reason, built.detail, built.field);
  built.refilm.notes.push(
    ...notes.map((sentence) => ({ kind: "migrated" as const, sentence })),
  );
  return built;
}

/** `run({ video: { id } })` with no script (local video library §4): the
 *  video's current version re-recorded, or its newest when none completed
 *  (ruling 9). A refusal names the version it came from, under `video`. */
export async function refilmFromVideo(
  store: VideoStore,
  library: Library,
  video: VideoRecord,
  /** The video's takes that will not read (ensureVideos' `skipped`). */
  leftOut: { takeId: string; reason: string }[] = [],
): Promise<
  | {
      ok: true;
      script: Record<string, unknown>;
      refilm: RefilmInfo;
      takeId: string;
    }
  | { ok: false; refusal: RefusedBeforeRun }
> {
  const all = await store.versions(video.id);
  const from = all.filter((v) => v.complete).at(-1) ?? all.at(-1);
  if (from === undefined && leftOut.length > 0) {
    return {
      ok: false,
      refusal: {
        outcome: "refusedBeforeRun",
        reason: "videoUnreadable",
        detail: `flow "${video.name}" has no video that reads — ${leftOut.map((s) => `video ${s.takeId}: ${s.reason}`).join("; ")}`,
        field: "video",
      },
    };
  }
  if (from === undefined) {
    return {
      ok: false,
      refusal: {
        outcome: "refusedBeforeRun",
        reason: "invalidScript",
        detail: `flow "${video.name}" has no video to film again — pass a script to film one into it`,
        field: "script",
      },
    };
  }
  const built = await refilmFromLibrary(library, from.takeId);
  if (built.ok) return { ...built, takeId: from.takeId };
  const { refusal } = built;
  return {
    ok: false,
    refusal: {
      ...refusal,
      detail: `video ${from.number} of flow "${video.name}" (${from.takeId}) cannot be filmed again — ${refusal.detail}`,
      field: refusal.field === "takeId" ? "video" : refusal.field,
    },
  };
}

import { readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { failure, type Outcome } from "@demoman/agent-bridge";
import {
  type FileType,
  isFlowId,
  type KeptDeliver,
  parseKept,
} from "@demoman/run-core";
import { messageOf } from "../report.js";
import { readTag } from "./export-tag.js";
import { adoptKept, findKept } from "./kept-flows.js";
import { type Library, LibraryError } from "./library.js";
import { ensureVideos, startPage } from "./migrate-videos.js";
import { readRepo } from "./repo.js";
import { phraseHits, similarNames } from "./video-match.js";
import {
  sharesRepo,
  VideoError,
  type VideoRecord,
  type VideoRepo,
  type VideoStore,
} from "./videos.js";

/** One video as an agent reads it (spec §3): the duplicate check's matches
 *  and, from Task 7, the `videos` answer. */
export interface VideoSummary {
  id: string;
  name: string;
  repo: VideoRepo;
  startPage: string;
  versions: number;
  current: {
    version: number;
    takeId: string;
    recordedAt: string;
    expired: boolean;
  } | null;
  pages: string[];
  /** The first `STEPS_MAX` steps; a query searches them all. */
  steps: string[];
  /** Where every version's exports went, oldest version first; a version
   *  whose outputs.json will not read is said, never listed as none. */
  exports: Array<
    | { takeId: string; path: string; fileType: FileType; exists: boolean }
    | { takeId: string; unreadable: string }
  >;
  /** The recipe that keeps this flow, null when none does, or `unknown` when
   *  the record says one does and the checkout's file is gone, will not read
   *  or keeps another flow. */
  kept:
    | { file: string; root: string; deliver: KeptDeliver }
    | null
    | {
        unknown: string;
      };
}

/** Reads the recipe a record points at (the same parser the kept folder's
 *  reader uses); anything but a recipe for this flow is `unknown`, said. */
export async function keptOf(
  video: VideoRecord,
): Promise<VideoSummary["kept"]> {
  if (video.kept === undefined) return null;
  const { root, file } = video.kept;
  let text: string;
  try {
    text = await readFile(join(root, file), "utf8");
  } catch (error) {
    const gone = (error as NodeJS.ErrnoException).code === "ENOENT";
    return {
      unknown: gone
        ? `${file} in ${root} is gone (${messageOf(error)})`
        : `${file} in ${root} will not read: ${messageOf(error)}`,
    };
  }
  const parsed = parseKept(text, file);
  if (!parsed.ok) {
    return {
      unknown: `${file} in ${root} will not read: ${parsed.detail}`,
    };
  }
  if (parsed.kept.flow !== video.id) {
    return {
      unknown: `${file} in ${root} keeps flow ${parsed.kept.flow}`,
    };
  }
  return { file, root, deliver: parsed.kept.deliver };
}

const STEPS_MAX = 12;

export async function summarise(
  store: VideoStore,
  library: Library,
  video: VideoRecord,
): Promise<VideoSummary> {
  return (await described(store, library, video)).summary;
}

/** A video's summary, and every step it shows (the summary lists only the
 *  first `STEPS_MAX`). */
async function described(
  store: VideoStore,
  library: Library,
  video: VideoRecord,
): Promise<{ summary: VideoSummary; steps: string[] }> {
  const all = await store.versions(video.id);
  const current = all.filter((v) => v.complete).at(-1) ?? null;
  // What the video shows: its current version, else the newest it has.
  const shown = current ?? all.at(-1);
  const scene =
    shown === undefined ? null : await library.getScene(shown.takeId);
  const nameOf = new Map<string, string | null>(
    (scene?.anchors ?? []).map((a) => [
      a.id,
      a.fingerprint.accessibleName ?? a.fingerprint.textContent,
    ]),
  );
  const steps = (scene?.actions ?? []).map((a) =>
    `${a.kind} ${(a.anchorId === null ? null : nameOf.get(a.anchorId)) ?? ""}`.trim(),
  );
  const exports: VideoSummary["exports"] = [];
  for (const v of all) {
    let rows: Awaited<ReturnType<Library["outputs"]>>;
    try {
      rows = await library.outputs(v.takeId);
    } catch (error) {
      exports.push({ takeId: v.takeId, unreadable: messageOf(error) });
      continue;
    }
    for (const o of rows) {
      exports.push({
        takeId: v.takeId,
        path: o.path,
        fileType: o.fileType,
        exists: o.exists,
      });
    }
  }
  const summary: VideoSummary = {
    id: video.id,
    name: video.name,
    repo: video.repo,
    startPage: video.startPage,
    versions: all.length,
    current:
      current === null
        ? null
        : {
            version: current.number,
            takeId: current.takeId,
            recordedAt: current.createdAt,
            expired: current.expired !== null,
          },
    pages: [
      ...new Set(
        (scene?.sideChannels.urlTrace ?? []).map((u) => startPage(u.url)),
      ),
    ],
    steps: steps.slice(0, STEPS_MAX),
    exports,
    kept: await keptOf(video),
  };
  return { summary, steps };
}

/** Videos in `repo` (or of unknown repo) whose name is similar to `name`
 *  (spec §4). An unreadable record has no name to compare, so it cannot
 *  match; `videos` lists it as unreadable. */
export async function matchesFor(
  store: VideoStore,
  library: Library,
  name: string,
  repo: VideoRepo,
): Promise<VideoSummary[]> {
  const out: VideoSummary[] = [];
  for (const v of await store.list()) {
    if ("unreadable" in v) continue;
    if (sharesRepo(v.repo, repo) && similarNames(v.name, name)) {
      out.push(await summarise(store, library, v));
    }
  }
  return out;
}

/** Readable takes in no video (spec §2.1 `outsideFlows`), newest first: one
 *  still inside `JOIN_GRACE_MS`, or waiting on another process's lock, after
 *  a run could not join it. A take already under `unreadable` is not repeated. */
async function outsideFlows(
  store: VideoStore,
  library: Library,
  records: Array<VideoRecord | { id: string }>,
  unreadable: { id: string; unreadable: string }[],
): Promise<{ takeId: string; name: string; createdAt: string }[]> {
  const videoIds = new Set(records.map((v) => v.id));
  const said = new Set(unreadable.map((u) => u.id));
  const out: { takeId: string; name: string; createdAt: string }[] = [];
  // library.list() is newest first.
  for (const t of await library.list()) {
    if ("unreadable" in t || said.has(t.id)) continue;
    let member: Awaited<ReturnType<VideoStore["videoOf"]>>;
    try {
      member = await store.videoOf(t.id);
    } catch (error) {
      unreadable.push({
        id: t.id,
        unreadable: `its video.json will not read, so no video lists it (${messageOf(error)})`,
      });
      continue;
    }
    if (member === null || !videoIds.has(member.videoId)) {
      out.push({ takeId: t.id, name: t.name, createdAt: t.createdAt });
    }
  }
  return out;
}

export interface VideosDeps {
  store: VideoStore;
  library: Library;
  /** The checkout "this repo" means: the executor's own, or the resolved `project`. */
  dir: string;
}

/**
 * The `videos` op (spec §3): this repo's videos, the ones matching a phrase,
 * or the one an exported file came from. Every take that never joined a video
 * is joined first, and each one that could not be is listed under
 * `unreadable` beside the unreadable records (controller ruling 8); when
 * another process holds the lock, `deferred` says so instead.
 */
export async function videosOp(
  deps: VideosDeps,
  args: { file?: unknown; query?: unknown },
): Promise<Outcome> {
  const { store, library } = deps;
  const { file, query } = args;
  if (file !== undefined && query !== undefined) {
    return failure("invalidArgs", "pass file or query, not both");
  }
  if (file !== undefined && (typeof file !== "string" || !isAbsolute(file))) {
    return failure(
      "invalidArgs",
      `file must be an absolute path; got ${JSON.stringify(file)}`,
    );
  }
  if (query !== undefined && typeof query !== "string") {
    return failure("invalidArgs", "query must be a string");
  }
  try {
    const joined = await ensureVideos(store, library);
    const { deferred } = joined;
    const unreadable: { id: string; unreadable: string }[] = joined.skipped.map(
      (s) => ({ id: s.takeId, unreadable: s.reason }),
    );
    const records = await store.list();
    for (const v of records) {
      if ("unreadable" in v) unreadable.push(v);
    }

    if (typeof file === "string") {
      let bytes: Uint8Array;
      try {
        bytes = await readFile(file);
      } catch (error) {
        return (error as { code?: string }).code === "ENOENT"
          ? failure("fileNotFound", `no file at ${file}`)
          : failure(
              "invalidArgs",
              `could not read ${file} (${messageOf(error)})`,
            );
      }
      const tag = readTag(bytes);
      if ("none" in tag || "unreadable" in tag) {
        return failure(
          "noTag",
          `${file} carries no readable Demoman tag (${"none" in tag ? tag.none : tag.unreadable})`,
        );
      }
      let video = await store.get(tag.found.flow);
      let notKept = "";
      if (video === null && isFlowId(tag.found.flow)) {
        // A flow kept in this checkout is one flow on every machine: open it
        // by its committed id, as a run does.
        // The repo's kept folder, as keep and refresh read it.
        const read = await readRepo(deps.dir);
        const root = read.ok ? read.repo.root : deps.dir;
        const found = await findKept(root, tag.found.flow);
        if (found !== null && "duplicate" in found) {
          return failure(
            "duplicateFlow",
            `${found.duplicate.join(" and ")} both name the flow ${tag.found.flow} — delete one of them, then ask again`,
          );
        }
        if (found !== null && "unreadable" in found) {
          notKept = `; a kept file that would not read might keep it — ${found.unreadable.join("; ")}`;
        } else if (found !== null) {
          const adopted = await adoptKept(
            store,
            root,
            found,
            read.ok ? { key: read.repo.key } : { none: read.none },
          );
          if (!adopted.ok) {
            return failure(
              "repoFlowNameTaken",
              `flow "${found.kept.name}" is kept in ${found.file} as ${tag.found.flow}, but this library's flow ${adopted.holder.id} has that name — run \`npx demoman join-flow ${adopted.holder.id} ${tag.found.flow}\` to move its videos into the kept flow`,
            );
          }
          video = adopted.video;
        }
      }
      if (video === null) {
        return failure(
          "unknownVideo",
          `${file} was exported from flow ${tag.found.flow}, which is not in this library${notKept}`,
        );
      }
      // Which version the file is of: the tag names its take.
      const takeId = tag.found.video;
      const madeAt =
        tag.found.commit === null
          ? ""
          : ` — filmed at commit ${tag.found.commit.slice(0, 7)}`;
      const summary = await summarise(store, library, video);
      const version = (await store.versions(video.id)).find(
        (v) => v.takeId === takeId,
      );
      return {
        ok: true,
        value: {
          videos: [summary],
          file:
            version === undefined
              ? {
                  takeId,
                  notInVideo: `video ${takeId} is no longer in "${video.name}" (it was deleted, or its video.json will not read)${madeAt}`,
                }
              : {
                  takeId,
                  version: version.number,
                  current: summary.current?.takeId === takeId,
                  expired: version.expired !== null,
                },
          unreadable,
          deferred,
        },
      };
    }

    const read = await readRepo(deps.dir);
    const here: VideoRepo = read.ok
      ? { key: read.repo.key }
      : { none: read.none };
    const found: { summary: VideoSummary; hits: number }[] = [];
    for (const v of records) {
      if ("unreadable" in v || !sharesRepo(v.repo, here)) continue;
      const { summary, steps } = await described(store, library, v);
      found.push({
        summary,
        // Every step, not only the ones the summary lists.
        hits:
          query === undefined
            ? 0
            : phraseHits(query as string, { ...summary, steps }),
      });
    }
    const newest = (v: VideoSummary) => v.current?.recordedAt ?? "";
    const byNewest = (
      a: { summary: VideoSummary },
      b: { summary: VideoSummary },
    ) => newest(b.summary).localeCompare(newest(a.summary));
    const videos = (
      query === undefined
        ? found.sort(byNewest)
        : found
            .filter((v) => v.hits > 0)
            .sort((a, b) => b.hits - a.hits || byNewest(a, b))
    ).map((v) => v.summary);
    return {
      ok: true,
      value: {
        videos,
        outsideFlows: await outsideFlows(store, library, records, unreadable),
        unreadable,
        deferred,
      },
    };
  } catch (error) {
    if (error instanceof VideoError)
      return failure(error.reason, error.message);
    return failure(
      "libraryUnreadable",
      error instanceof LibraryError ? error.message : messageOf(error),
    );
  }
}

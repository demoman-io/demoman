import { readFile, stat } from "node:fs/promises";
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
import { followHere } from "./repo-aliases.js";
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
  /** The recipe that keeps this flow, null when none does (also when the
   *  record's checkout is gone, or no recipe in it keeps this flow any
   *  more), or `unknown` when one might and cannot be read: a recipe that
   *  will not read, or two that name the flow. */
  kept:
    | { file: string; root: string; deliver: KeptDeliver; key: string | null }
    | null
    | {
        unknown: string;
      };
  /** The repo key the flow was added to, as its kept mark recorded it,
   *  whether or not that checkout still exists (a worktree removed after
   *  the merge); null when there is no mark or it has no key. */
  addedTo: string | null;
}

/** Reads the recipe a record points at (the same parser the kept folder's
 *  reader uses), else the one in its checkout that keeps this flow now.
 *  Whether a marked flow is still in the repo is decided here, once: the
 *  library's listing and the Studio's rename both read this answer. */
export async function keptOf(
  video: VideoRecord,
): Promise<VideoSummary["kept"]> {
  if (video.kept === undefined) return null;
  const { root, file } = video.kept;
  // A deleted worktree is normal: its flows are this library's alone now.
  const there = await stat(root).then(
    () => null,
    (error: unknown) =>
      (error as NodeJS.ErrnoException).code === "ENOENT"
        ? "gone"
        : `${root} cannot be read (${messageOf(error)})`,
  );
  if (there === "gone") return null;
  if (there !== null) return { unknown: there };
  const text = await readFile(join(root, file), "utf8").catch(() => null);
  const parsed = text === null ? null : parseKept(text, file);
  if (parsed?.ok === true && parsed.kept.flow === video.id)
    return {
      file,
      root,
      deliver: parsed.kept.deliver,
      key: video.kept.key ?? null,
    };
  // The marked file is gone, moved or another flow's: the folder says
  // which recipe, if any, keeps this flow.
  let found: Awaited<ReturnType<typeof findKept>>;
  try {
    found = await findKept(root, video.id);
  } catch (error) {
    return {
      unknown: `the flows in ${root} could not be listed (${messageOf(error)})`,
    };
  }
  if (found === null) return null;
  if ("kept" in found)
    return {
      file: found.file,
      root,
      deliver: found.kept.deliver,
      key: video.kept.key ?? null,
    };
  if ("duplicate" in found)
    return {
      unknown: `${found.duplicate.join(" and ")} in ${root} both name this flow`,
    };
  return {
    unknown: `a recipe in ${root} will not read, so whether it holds this flow is unknown: ${found.unreadable.join("; ")}`,
  };
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
    addedTo: video.kept?.key ?? null,
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
  const mine = await store.resolve(repo);
  for (const v of await store.list()) {
    if ("unreadable" in v) continue;
    if (sharesRepo(v.repo, mine) && similarNames(v.name, name)) {
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
    // A query follows its own checkout before reading the records (ruling
    // R14): a checkout whose key moved still lists its old flows.
    const read = typeof file === "string" ? null : await readRepo(deps.dir);
    if (read?.ok) {
      for (const m of await followHere(store, library, read))
        unreadable.push({ id: m.id, unreadable: m.why });
    }
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
          notKept = `; a recipe in this repo that would not read might be it — ${found.unreadable.join("; ")}`;
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
              `flow "${found.kept.name}" is in the repo in ${found.file} as ${tag.found.flow}, but this library's flow ${adopted.holder.id} has that name — run \`npx demoman join-flow ${adopted.holder.id} ${tag.found.flow}\` to move its videos into the repo flow`,
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
          : ` — recorded at commit ${tag.found.commit.slice(0, 7)}`;
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

    // Read above, before the records; never null for a query.
    const repoRead = read ?? (await readRepo(deps.dir));
    // A clone still on a repo's old remote lists the repo's flows.
    const here = await store.resolve(
      repoRead.ok ? { key: repoRead.repo.key } : { none: repoRead.none },
    );
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

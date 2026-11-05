import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import {
  DEFAULT_EXPORT_QUALITY,
  type FilmedCode,
  parseFilmedCode,
} from "@demoman/run-core";
import {
  checkAddable,
  createVideoStore,
  describeVideo,
  ensureVideos,
  execGit,
  expireOld,
  expiryStatus,
  followCheckouts,
  hasCommit,
  keptOf,
  keyKeptMarks,
  type Library,
  LibraryError,
  pidAlive,
  readLeases,
  readLogo,
  readRepo,
  readUserSettings,
  readWallpaper,
  renameKept,
  VideoError,
} from "@demoman/runner/studio";
import { migrateToCurrent, type SceneDocument } from "@demoman/scene-schema";
import {
  type Addable,
  type BundleAnswer,
  type DeleteAnswer,
  type ExportQualityAnswer,
  type ExportQualityChoice,
  FILE_NAME_HEADER,
  isLibraryViewChoice,
  type LibraryViewAnswer,
  type OutputsAnswer,
  type PingAnswer,
  type PullRequestsAnswer,
  type PullRequestsChoice,
  type Refusal,
  type SceneAnswer,
  type ScenePutAnswer,
  type StudioReason,
  type TakesAnswer,
  type UnreadableTake,
  type VideoSummary as VideoListing,
} from "@demoman/studio-protocol";
import { saveLogo, saveWallpaper } from "./assets.js";
import type { EventHub } from "./events.js";
import { createChains, isMissing, messageOf, readIfPresent } from "./files.js";
import { createKitsFile } from "./kits.js";
import type { CiRoute } from "./repo-ci.js";
import type { Handler, StudioHandlers, StudioResponse } from "./server.js";
import { readLibraryView, writeSetting } from "./settings.js";
import { folderBytes } from "./sizes.js";
import type { createThumbs } from "./thumbs.js";
import type { HomeFeeds } from "./watch.js";

/** The Global Constraints sentence for a lost save race, with what to do
 *  (ruling R19): the page keeps refusing until it is reopened. */
export const CHANGED_ELSEWHERE =
  "This video changed in another window. Reopen it to keep editing.";
/** The Global Constraints sentences for a delete during an export. */
export const TAKE_BUSY = {
  agent: "This video is being exported by an agent.",
  studio: "This video is being exported by the Studio.",
} as const;

/** What a delete cleared or left behind, each said as a clause. */
const noteParts = (done: {
  clearedLeases: { pid: number }[];
  leftBehind: string | null;
}): string[] => [
  ...done.clearedLeases.map(
    (h) => `cleared a stale export lock left by process ${h.pid}`,
  ),
  ...(done.leftBehind === null
    ? []
    : [`${done.leftBehind} could not be removed — delete it by hand`]),
];
const noteOf = (parts: string[]): string | null =>
  parts.length === 0
    ? null
    : `${parts.join("; ").replace(/^./, (c) => c.toUpperCase())}.`;

/** Keyframes and spans are content-addressed by ref and never rewritten. */
export const FRAME_CACHE = "private, max-age=31536000, immutable";

const json = (status: number, body: unknown): StudioResponse => ({
  status,
  json: body,
});
const refuse = (
  status: number,
  reason: StudioReason,
  detail: string,
): StudioResponse => {
  const body: Refusal = { reason, detail };
  return { status, json: body };
};

/** `open -R`, which shows the file selected in a Finder window. */
export function revealInFinder(path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile("open", ["-R", path], (error, _stdout, stderr) => {
      if (error) {
        reject(new Error(stderr.trim() || error.message));
        return;
      }
      resolve();
    });
  });
}

/**
 * Every studio route but `window` and `exportStart` (Task 7's). A
 * `LibraryError` from any of them answers 500 with its own reason and
 * sentence; anything else that throws reaches the door's 500 internalError.
 */
export function createRoutes(o: {
  home: string;
  library: Library;
  events: EventHub;
  log: (line: string) => void;
  /** `ping`'s version: the bin's, which `openStudio` compares. */
  version: string;
  /** `ping`'s `queued`: the export queue's size (Task 7's queue). */
  queued: () => number;
  /** The watch feeds: why each is down, and the kits write's announcement. */
  feeds: HomeFeeds;
  /** Previews of keyframes (`createThumbs`; tests inject its thumbnailer). */
  thumbs: ReturnType<typeof createThumbs>;
  /** Injected by tests; `open -R` otherwise. */
  reveal?: (path: string) => Promise<void>;
  /** Join loose takes to videos and expire old recordings now, as well as
   *  on each listing: the studio's server starting (spec §5). Off in the
   *  route tests, whose homes are removed under a pass still writing. */
  upkeepOnStart?: boolean;
  /** At most one follow pass per this many ms (60 s unless given; 0 in the
   *  route tests, so each listing follows). */
  followEveryMs?: number;
  /** The follow throttle's clock; injected by tests. */
  now?: () => number;
}): Omit<
  StudioHandlers,
  "window" | "exportStart" | "repoAdd" | "repoRemove" | CiRoute
> {
  const { library, home, log } = o;
  const reveal = o.reveal ?? revealInFinder;
  const sceneWrites = createChains();
  const kits = createKitsFile(home);
  const videos = createVideoStore(home, library, { log });

  // One at a time in this process: upkeep, renames and deletes. The store's
  // lock keeps two processes' migrations apart; this chain also keeps a
  // delete out of a migration, whose join into the deleted take would fail
  // (a join never makes a take's folder) and list it as in no video.
  let videoChain: Promise<unknown> = Promise.resolve();
  const onVideoChain = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = videoChain.then(fn, fn);
    videoChain = run.catch(() => undefined);
    return run;
  };

  // The follow pass spawns git in every recorded checkout, so it runs on
  // start and then at most once per `followEveryMs`, as expireOld throttles
  // itself; a skipped listing says the last pass's rows again, so a row does
  // not flicker in and out between listings. A rename or a flow's delete
  // clears them, so a row it settled, or one naming a gone flow, is not said.
  const followEvery = o.followEveryMs ?? 60_000;
  const now = o.now ?? Date.now;
  let lastFollow: { at: number; rows: UnreadableTake[] } | null = null;
  const followed = async (): Promise<UnreadableTake[]> => {
    if (lastFollow !== null && now() - lastFollow.at < followEvery)
      return lastFollow.rows;
    const at = now();
    const rows: UnreadableTake[] = [];
    const folder = "following projects' checkouts";
    try {
      const f = await followCheckouts(videos, library, readRepo, hasCommit);
      // A re-keying that failed still says the checkouts that would not read.
      const said = [
        ...(f.error === undefined
          ? []
          : [`projects could not follow their checkouts (${f.error})`]),
        ...f.failed.map(
          (x) => `flow "${x.name}" (${x.flow}) at ${x.root}: ${x.why}`,
        ),
        ...f.collisions.map(
          (c) =>
            `flows "${c.name}" (${c.ids.join(") and (")}) are now in one project; rename one`,
        ),
      ];
      if (said.length > 0)
        rows.push({ folder, kind: "upkeep", reason: said.join("; ") });
    } catch (error) {
      rows.push({
        folder,
        kind: "upkeep",
        reason: `projects could not follow their checkouts (${messageOf(error)})`,
      });
    }
    lastFollow = { at, rows };
    return rows;
  };

  /**
   * Joins every loose take to a video, then expires old recordings (at most
   * once an hour; expireOld throttles itself). Never throws: the listing
   * answers whatever happens here, and each failure is logged and comes
   * back as a row — a take in no video's versions as a `take` row, the
   * lock held elsewhere or a pass that failed as one `upkeep` row (which
   * has no Delete).
   */
  const upkeep = (): Promise<UnreadableTake[]> =>
    onVideoChain(async () => {
      const rows: UnreadableTake[] = [];
      try {
        const joined = await ensureVideos(videos, library);
        for (const s of joined.skipped) {
          rows.push({ folder: s.takeId, reason: s.reason, kind: "take" });
        }
        if (joined.deferred !== null) {
          rows.push({
            folder: "joining videos to flows",
            reason: `some videos are not in a flow yet: ${joined.deferred}; they join next time`,
            kind: "upkeep",
          });
        }
      } catch (error) {
        rows.push({
          folder: "joining videos to flows",
          reason: `videos could not be grouped into flows (${messageOf(error)})`,
          kind: "upkeep",
        });
      }
      try {
        const keyed = await keyKeptMarks(videos, readRepo);
        if (keyed.failed.length > 0) {
          rows.push({
            folder: "telling kept flows' projects",
            kind: "upkeep",
            reason: keyed.failed
              .map((f) => `flow "${f.name}" (${f.flow}) at ${f.root}: ${f.why}`)
              .join("; "),
          });
        }
      } catch (error) {
        rows.push({
          folder: "telling kept flows' projects",
          kind: "upkeep",
          reason: `could not be told (${messageOf(error)})`,
        });
      }
      // After keying marks, so a mark keyed just now is followed too.
      rows.push(...(await followed()));
      const expiry = await expireOld(videos, library, new Date());
      // A pass that ran within the hour is not run again, so a failure it
      // met is read back from the state file rather than said only once.
      const last = "skipped" in expiry ? await expiryStatus(library) : expiry;
      if ("failed" in last || "unreadable" in last) {
        rows.push({
          folder: "expiring old videos",
          kind: "upkeep",
          reason: `old videos could not be expired (${"failed" in last ? last.failed : last.unreadable})`,
        });
      }
      for (const r of rows) log(`studio: ${r.folder}: ${r.reason}`);
      return rows;
    });
  if (o.upkeepOnStart === true) void upkeep();

  /** A version's exported files; an outputs.json that will not read is
   *  said as itself, never as no exports. */
  async function exportsOf(
    takeId: string,
  ): Promise<TakesAnswer["videoOf"][string]["exports"]> {
    try {
      return (await library.outputs(takeId)).map((o) => ({
        path: o.path,
        fileType: o.fileType,
        exists: o.exists,
      }));
    } catch (error) {
      log(`studio: take ${takeId}'s exports: ${messageOf(error)}`);
      return { unreadable: messageOf(error) };
    }
  }

  /** The code a version filmed, from its report. A missing report is null
   *  quietly (old takes have none); one that will not read, or has no usable
   *  filmedCode, is null and said. */
  async function filmedCodeOf(takeId: string): Promise<FilmedCode | null> {
    const report = await library
      .getJson(takeId, "report.json")
      .catch((e: unknown) => ({ unreadable: messageOf(e) }));
    if ("missing" in report) return null;
    if ("unreadable" in report) {
      log(`studio: take ${takeId}'s report.json: ${report.unreadable}`);
      return null;
    }
    const value = report.value as { filmedCode?: unknown } | null;
    // No key: a take recorded before filmedCode, not a fault.
    if (
      value !== null &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      !("filmedCode" in value)
    )
      return null;
    const code = value?.filmedCode;
    const parsed = parseFilmedCode(code);
    if (parsed !== null) return parsed;
    log(
      `studio: video ${takeId}'s report.json has no usable filmedCode (${JSON.stringify(code ?? null)})`,
    );
    return null;
  }

  /** Every video and which take is which version of which; a video that
   *  will not read is a row saying so, never a missing card. */
  async function videoListing(
    unreadable: UnreadableTake[],
  ): Promise<Pick<TakesAnswer, "videos" | "videoOf" | "addable">> {
    const listed: VideoListing[] = [];
    const videoOf: TakesAnswer["videoOf"] = {};
    const addable: Record<string, Addable> = {};
    // One cache for this listing, so flows in one checkout read its
    // accounts.json once; never kept across requests.
    const deps: Parameters<typeof checkAddable>[1] = {
      videos,
      library,
      home,
      git: execGit,
      accounts: new Map(),
      repos: new Map(),
    };
    const say = (row: UnreadableTake): void => {
      unreadable.push(row);
      log(`studio: ${row.folder}: ${row.reason}`);
    };
    let records: Awaited<ReturnType<typeof videos.list>>;
    try {
      records = await videos.list();
    } catch (error) {
      say({
        folder: "listing videos",
        reason: messageOf(error),
        kind: "upkeep",
      });
      return { videos: listed, videoOf, addable };
    }
    for (const v of records) {
      if ("unreadable" in v) {
        say({ folder: v.id, reason: v.unreadable, kind: "video" });
        continue;
      }
      try {
        const { summary, steps } = await describeVideo(videos, library, v);
        for (const version of await videos.versions(v.id)) {
          videoOf[version.takeId] = {
            videoId: v.id,
            version: version.number,
            expired: version.expired !== null,
            exports: await exportsOf(version.takeId),
            filmedCode: await filmedCodeOf(version.takeId),
          };
        }
        // The row shows Add when keptOf says the flow is not in the repo
        // (its mark may be stale): the same answer decides here. A failed
        // check leaves the flow listed, with no button.
        if (summary.kept === null) {
          try {
            addable[v.id] = await checkAddable({ video: v }, deps);
          } catch (error) {
            log(`studio: flow ${v.id}'s add check: ${messageOf(error)}`);
          }
        }
        listed.push({ ...summary, steps });
      } catch (error) {
        say({
          folder: v.id,
          reason: `the flow "${v.name}" could not be read (${messageOf(error)})`,
          kind: "video",
        });
      }
    }
    return { videos: listed, videoOf, addable };
  }

  const noTake = (id: string): StudioResponse =>
    refuse(
      404,
      "takeNotFound",
      `There is no video "${id}" in ${library.root}.`,
    );

  /** Whether `id` names a take on disk; false for an id that could not. */
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

  async function bodyJson(
    req: Parameters<Handler>[0],
  ): Promise<{ ok: true; value: unknown } | { ok: false; error: string }> {
    const bytes = await req.body();
    try {
      return { ok: true, value: JSON.parse(bytes.toString("utf8")) };
    } catch (error) {
      return { ok: false, error: `the body is not JSON (${messageOf(error)})` };
    }
  }

  const ifMatchOf = (req: Parameters<Handler>[0]): string | null => {
    const value = req.headers["if-match"];
    return typeof value === "string" && value !== "" ? value : null;
  };

  /** A LibraryError or VideoError is the store's own refusal, with its
   *  own sentence. */
  const guarded =
    (handler: Handler): Handler =>
    async (req) => {
      try {
        return await handler(req);
      } catch (error) {
        if (error instanceof LibraryError || error instanceof VideoError) {
          return refuse(500, error.reason, `${error.message}.`);
        }
        throw error;
      }
    };

  const noVideo = (id: string): StudioResponse =>
    refuse(404, "videoNotFound", `There is no flow "${id}".`);

  /** A delete refused over an export lease, by the first live holder's door. */
  const busy = (
    holders: { door: keyof typeof TAKE_BUSY }[],
    more = "",
  ): StudioResponse => {
    const first = holders[0];
    if (first === undefined) {
      throw new Error("a delete was refused with no holder to name");
    }
    return refuse(409, "takeBusy", `${TAKE_BUSY[first.door]}${more}`);
  };

  const handlers: Omit<
    StudioHandlers,
    "window" | "exportStart" | "repoAdd" | "repoRemove" | CiRoute
  > = {
    async ping() {
      const answer: PingAnswer = {
        version: o.version,
        pid: process.pid,
        queued: o.queued(),
      };
      return json(200, answer);
    },

    async takes() {
      const scenes: SceneDocument[] = [];
      const unreadable: UnreadableTake[] = await upkeep();
      const sizes: Record<string, number> = {};
      /** Each folder on its own: a folder that will not measure (a
       *  root-owned `.busy/`, say) leaves its size out, and its card says
       *  nothing rather than "0 B"; it never costs every other take. */
      const measure = async (id: string): Promise<void> => {
        try {
          sizes[id] = await folderBytes(library.takeDir(id));
        } catch (error) {
          log(`studio: video ${id}'s size is left out: ${messageOf(error)}`);
        }
      };
      // Every take at once, then put back in the listing's order: each
      // scene save sends every open library here again, and one take after
      // another made it wait on every folder's walk in turn.
      const read = await Promise.all(
        (await library.list()).map(async (entry) => {
          if ("unreadable" in entry) {
            await measure(entry.id);
            return entry;
          }
          const [scene] = await Promise.all([
            library.getScene(entry.id),
            measure(entry.id),
          ]);
          return { id: entry.id, scene };
        }),
      );
      for (const entry of read) {
        if ("unreadable" in entry) {
          // A row, so the person can see the folder and delete it; once,
          // though upkeep, which names every take in no video, has it too.
          if (
            !unreadable.some((u) => u.kind === "take" && u.folder === entry.id)
          )
            unreadable.push({
              folder: entry.id,
              reason: entry.unreadable,
              kind: "take",
            });
        } else if (entry.scene === null) {
          // Deleted between the listing and this read: no longer a take,
          // and not a size either.
          delete sizes[entry.id];
        } else {
          scenes.push(entry.scene);
        }
      }
      const answer: TakesAnswer = {
        ...(await videoListing(unreadable)),
        scenes,
        sizes,
        unreadable,
        unwatched: o.feeds.unwatched().takes,
      };
      return json(200, answer);
    },

    async sceneGet(req) {
      const id = req.params.id as string;
      if (!library.isTakeId(id)) return noTake(id);
      const read = await library.getSceneRead(id);
      if (read === null) return noTake(id);
      let videoId: string | null = null;
      let videoError: string | null = null;
      try {
        videoId = (await videos.videoOf(id))?.videoId ?? null;
      } catch (error) {
        videoError = messageOf(error);
        log(`studio: take ${id}'s video: ${videoError}`);
      }
      const answer: SceneAnswer = { ...read, videoId, videoError };
      return json(200, answer);
    },

    async scenePut(req) {
      const id = req.params.id as string;
      if (!library.isTakeId(id)) return noTake(id);
      const ifMatch = ifMatchOf(req);
      if (ifMatch === null) {
        return refuse(
          428,
          "changedElsewhere",
          "The save carried no revision (If-Match), so it could not be checked against the video on disk.",
        );
      }
      const body = await bodyJson(req);
      if (!body.ok) {
        return refuse(
          400,
          "sceneInvalid",
          `The scene was not saved: ${body.error}.`,
        );
      }
      let doc: SceneDocument;
      try {
        doc = migrateToCurrent(body.value);
      } catch (error) {
        return refuse(
          400,
          "sceneInvalid",
          `The scene was not saved: ${messageOf(error)}.`,
        );
      }
      if (doc.meta.id !== id) {
        return refuse(
          400,
          "sceneInvalid",
          `The scene was not saved: it is video "${doc.meta.id}", sent to video "${id}".`,
        );
      }
      return sceneWrites(id, async () => {
        const put = await library.putSceneIf(doc, ifMatch);
        if (put.ok) {
          const answer: ScenePutAnswer = { revision: put.revision };
          return json(200, answer);
        }
        // No scene.json at all: the take was deleted, not edited.
        if (put.current === null) return noTake(id);
        return refuse(409, "changedElsewhere", CHANGED_ELSEWHERE);
      });
    },

    async takeDelete(req) {
      const id = req.params.id as string;
      if (!library.isTakeId(id)) return noTake(id);
      // On the same chain as the scene's saves: a save queued behind the
      // delete then finds no scene.json and answers takeNotFound. Off it, a
      // save between its hash check and its rename re-creates
      // `takes/<id>/scene.json` after the folder went to `.trash-*` — a
      // frameless ghost take, and "saved" to an editor whose take is gone.
      return sceneWrites(id, async () => {
        // Read before the folder goes, since video.json goes with it.
        let videoId: string | null = null;
        let unread: string | null = null;
        try {
          videoId = (await videos.videoOf(id))?.videoId ?? null;
        } catch (error) {
          unread = messageOf(error);
        }
        return onVideoChain(async () => {
          const done = await library.deleteTake(id);
          if (!done.ok) {
            if ("missing" in done) return noTake(id);
            return busy(done.holders);
          }
          const parts = noteParts(done);
          if (unread !== null) {
            parts.push(
              `which flow this video was in could not be read (${unread}), so that flow may be left with no videos`,
            );
          } else if (videoId !== null) {
            // Its last version gone, the video goes too: a video with no
            // versions has nothing to show, and would hold its name forever.
            try {
              if ((await videos.versions(videoId)).length === 0) {
                await videos.remove(videoId);
                lastFollow = null;
              }
            } catch (error) {
              parts.push(
                `its flow could not be checked for videos left (${messageOf(error)})`,
              );
            }
          }
          const answer: DeleteAnswer = { note: noteOf(parts) };
          return json(200, answer);
        });
      });
    },

    async videoRename(req) {
      const id = req.params.id as string;
      const body = await bodyJson(req);
      if (!body.ok) {
        return refuse(
          400,
          "videoNameInvalid",
          `The flow was not renamed: ${body.error}.`,
        );
      }
      const name = (body.value as { name?: unknown } | null)?.name;
      if (typeof name !== "string" || name.trim() === "") {
        return refuse(
          400,
          "videoNameInvalid",
          "The flow was not renamed: a flow needs a name.",
        );
      }
      // A kept flow's name is its recipe's too: both are renamed, or
      // neither, and never the record alone (renameKept).
      const done = await onVideoChain(async () => {
        const rec = await videos.get(id);
        if (rec?.kept === undefined) return videos.rename(id, name.trim());
        const kept = await keptOf(rec);
        if (kept === null) {
          // Its checkout is gone or keeps it no more (keptOf decides): the
          // flow is this library's alone, so its stale mark goes with it.
          const renamed = await videos.rename(id, name.trim());
          if (!renamed.ok) return renamed;
          const cleared = await videos.setKept(id, null);
          if (cleared.ok)
            log(
              `studio: flow ${id}'s recipe is no longer in ${rec.kept.root}; its mark was cleared`,
            );
          return cleared;
        }
        if ("unknown" in kept) {
          return {
            ok: false as const,
            reason: "repoCheckoutMissing" as const,
            detail: `${kept.unknown}, so the flow keeps its name.`,
          };
        }
        return renameKept(
          { root: kept.root, file: kept.file, name: name.trim() },
          { videos },
        );
      });
      if (done.ok) {
        // A rename may settle a collision the last follow pass named.
        lastFollow = null;
        return json(200, {});
      }
      if (done.reason === "videoNotFound") return noVideo(id);
      if ("detail" in done) {
        return refuse(
          done.reason === "repoFlowUnwritable" ? 500 : 409,
          done.reason,
          done.detail.replace(/[^.]$/, "$&."),
        );
      }
      return refuse(
        409,
        "nameTaken",
        `Another flow is already called "${done.holder.name}".`,
      );
    },

    async repoAddable(req) {
      const id = req.params.id as string;
      const video = await videos.get(id);
      if (video === null) return noVideo(id);
      // A fresh cache per request: a hand sign-in answer must not go stale.
      const answer: Addable = await checkAddable(
        { video },
        {
          videos,
          library,
          home,
          git: execGit,
          accounts: new Map(),
          repos: new Map(),
        },
      );
      return json(200, answer);
    },

    async videoDelete(req) {
      const id = req.params.id as string;
      // Every version is checked before any goes: one under an export lease
      // keeps the whole video. The chain is let go before the deletes, which
      // take each scene's chain first and then this one, as takeDelete does:
      // held across them, a takeDelete waiting on it would wait forever.
      const checked = await onVideoChain(async () => {
        let readable: boolean;
        try {
          readable = (await videos.get(id)) !== null;
        } catch (error) {
          if (!(error instanceof VideoError)) throw error;
          // A record that will not read: its "Couldn't read" row's Delete
          // removes the record alone, and its recordings stay as takes.
          await videos.remove(id);
          lastFollow = null;
          const answer: DeleteAnswer = {
            note: "Only the unreadable record was removed; its videos stay.",
          };
          return json(200, answer);
        }
        if (!readable) return noVideo(id);
        const versions = await videos.versions(id);
        for (const v of versions) {
          const leases = await readLeases(
            join(library.takeDir(v.takeId), ".busy"),
          );
          const live = leases.filter((l) => pidAlive(l.holder.pid));
          if (live.length > 0) return busy(live.map((l) => l.holder));
        }
        return versions;
      });
      if (!Array.isArray(checked)) return checked;
      const parts: string[] = [];
      let deleted = 0;
      const total = checked.length;
      for (const v of checked) {
        const done = await sceneWrites(v.takeId, () =>
          onVideoChain(() => library.deleteTake(v.takeId)),
        );
        if (!done.ok) {
          if ("missing" in done) continue;
          // Leased after the check above. Nothing gone yet is a refusal;
          // anything gone is a partial delete, and says so.
          if (deleted === 0) return busy(done.holders);
          const door = done.holders[0]?.door ?? "agent";
          const answer: DeleteAnswer = {
            note: noteOf(parts),
            partly: `only ${deleted} of its ${total} videos went, then one was refused — ${TAKE_BUSY[door].replace(/\.$/, "")}`,
          };
          return json(200, answer);
        }
        deleted += 1;
        parts.push(...noteParts(done));
      }
      try {
        await onVideoChain(() => videos.remove(id));
        lastFollow = null;
      } catch (error) {
        const answer: DeleteAnswer = {
          note: noteOf(parts),
          partly: `${total === 1 ? "its video" : `its ${total} videos`} went, but its record could not be removed (${messageOf(error)})`,
        };
        return json(200, answer);
      }
      const answer: DeleteAnswer = { note: noteOf(parts) };
      return json(200, answer);
    },

    async bundle(req) {
      const id = req.params.id as string;
      // An unknown take is not a take without frames: answered as itself,
      // never as `bundle: null` ("no frames yet").
      if (!(await takeExists(id))) return noTake(id);
      let bundle: BundleAnswer["bundle"];
      try {
        bundle = await library.frameStore(id).getBundle(id);
      } catch (error) {
        throw new LibraryError(
          "libraryUnreadable",
          `could not read video ${id}'s frame bundle (${messageOf(error)})`,
        );
      }
      const statusPath = join(library.takeDir(id), "status.json");
      let replay: unknown = null;
      let bytes: Buffer | null;
      try {
        bytes = await readIfPresent(statusPath);
      } catch (error) {
        throw new LibraryError(
          "libraryUnreadable",
          `could not read ${statusPath} (${messageOf(error)})`,
        );
      }
      if (bytes !== null) {
        try {
          replay = JSON.parse(bytes.toString("utf8"));
        } catch (error) {
          throw new LibraryError(
            "libraryUnreadable",
            `${statusPath} is not JSON (${messageOf(error)})`,
          );
        }
      }
      const answer: BundleAnswer = { bundle, replay, capture: null };
      return json(200, answer);
    },

    async thumb(req) {
      const made = await o.thumbs.get(
        req.params.id as string,
        req.params.ref as string,
      );
      if (!made.ok) return json(made.status, made.refusal);
      return {
        status: 200,
        body: made.bytes,
        contentType: "image/jpeg",
        headers: { "Cache-Control": FRAME_CACHE },
      };
    },

    async frame(req) {
      const id = req.params.id as string;
      const ref = req.params.ref as string;
      if (!library.isTakeId(id)) return noTake(id);
      const store = library.frameStore(id);
      // Only a ref the take's own store lists: never a path built from
      // what the request said.
      if (!(await store.refs()).includes(ref)) {
        return refuse(
          404,
          "frameNotFound",
          `Video ${id} holds no frame "${ref}".`,
        );
      }
      const bytes = await store.load(ref);
      return {
        status: 200,
        body: bytes,
        contentType: "application/octet-stream",
        headers: { "Cache-Control": FRAME_CACHE },
      };
    },

    async outputs(req) {
      const id = req.params.id as string;
      if (!(await takeExists(id))) return noTake(id);
      const answer: OutputsAnswer = { outputs: await library.outputs(id) };
      return json(200, answer);
    },

    async kitsGet() {
      return json(200, {
        ...(await kits.read()),
        unwatched: o.feeds.unwatched().kits,
      });
    },

    async kitsPut(req) {
      const ifMatch = ifMatchOf(req);
      if (ifMatch === null) {
        return refuse(
          428,
          "changedElsewhere",
          "The kits carried no revision (If-Match), so they could not be checked against the file on disk.",
        );
      }
      const body = await bodyJson(req);
      if (!body.ok) {
        return refuse(
          400,
          "kitsInvalid",
          `The kits were not saved: ${body.error}.`,
        );
      }
      const put = await kits.put(body.value, ifMatch);
      if (!put.ok) return json(put.status, put.refusal);
      await o.feeds.kitsWritten();
      return json(200, put.answer);
    },

    async kitsReset() {
      const reset = await kits.reset();
      if (!reset.ok) return json(reset.status, reset.refusal);
      if (reset.answer.backup !== null) {
        log(`studio: kits reset; the old file is ${reset.answer.backup}`);
      }
      await o.feeds.kitsWritten();
      return json(200, reset.answer);
    },

    async assetPut(req) {
      const rawName = req.headers[FILE_NAME_HEADER.toLowerCase()];
      if (typeof rawName !== "string" || rawName === "") {
        return refuse(
          400,
          "logoRefused",
          `The logo upload carried no file name (${FILE_NAME_HEADER}).`,
        );
      }
      let name: string;
      try {
        name = decodeURIComponent(rawName);
      } catch {
        return refuse(
          400,
          "logoRefused",
          `The logo upload's file name (${FILE_NAME_HEADER}) is not URI-encoded.`,
        );
      }
      const type =
        (req.headers["content-type"] ?? "").split(";")[0]?.trim() ?? "";
      const saved = await saveLogo(home, {
        name,
        type,
        bytes: await req.body(),
      });
      if (!saved.ok) return json(saved.status, saved.refusal);
      return json(200, saved.answer);
    },

    async logo(req) {
      const ref = req.query.get("ref");
      if (ref === null || ref === "") {
        return refuse(400, "logoRefused", "The logo request named no ref.");
      }
      const read = await readLogo(home, ref);
      if (!read.ok) return refuse(422, "logoRefused", read.error);
      return {
        status: 200,
        body: read.bytes,
        contentType: read.contentType,
        headers: { "Cache-Control": "no-cache" },
      };
    },

    async wallpaperPut(req) {
      const rawName = req.headers[FILE_NAME_HEADER.toLowerCase()];
      if (typeof rawName !== "string" || rawName === "") {
        return refuse(
          400,
          "wallpaperRefused",
          `The image upload carried no file name (${FILE_NAME_HEADER}).`,
        );
      }
      let name: string;
      try {
        name = decodeURIComponent(rawName);
      } catch {
        return refuse(
          400,
          "wallpaperRefused",
          `The image upload's file name (${FILE_NAME_HEADER}) is not URI-encoded.`,
        );
      }
      const type =
        (req.headers["content-type"] ?? "").split(";")[0]?.trim() ?? "";
      const saved = await saveWallpaper(home, {
        name,
        type,
        bytes: await req.body(),
      });
      if (!saved.ok) return json(saved.status, saved.refusal);
      return json(200, saved.answer);
    },

    async wallpaper(req) {
      const ref = req.query.get("ref");
      if (ref === null || ref === "") {
        return refuse(
          400,
          "wallpaperRefused",
          "The wallpaper request named no ref.",
        );
      }
      // An uploaded image only; a built-in id is the pages' own file. The
      // directory of built-ins is never read for an image.
      const read = await readWallpaper(
        home,
        "",
        { kind: "image", ref },
        "landscape",
      );
      if (read === null || !read.ok) {
        return refuse(
          422,
          "wallpaperRefused",
          read === null ? `"${ref}" names no image.` : read.error,
        );
      }
      return {
        status: 200,
        body: read.bytes,
        contentType: read.contentType,
        headers: { "Cache-Control": "no-cache" },
      };
    },

    async exportQualityGet() {
      const got = await readUserSettings(home);
      const unreadable = got.problems?.exportQuality;
      const answer: ExportQualityAnswer =
        unreadable === undefined
          ? { exportQuality: got.exportQuality }
          : { exportQuality: DEFAULT_EXPORT_QUALITY, unreadable };
      if (unreadable !== undefined) {
        log(
          `studio: Export quality is ${DEFAULT_EXPORT_QUALITY}: ${unreadable}`,
        );
      }
      return json(200, answer);
    },

    async exportQualityPut(req) {
      const body = await bodyJson(req);
      if (!body.ok) {
        return refuse(
          400,
          "exportQualityInvalid",
          `The Export quality setting was not saved: ${body.error}.`,
        );
      }
      const quality = (body.value as { exportQuality?: unknown } | null)
        ?.exportQuality;
      const refused = await writeSetting(home, "exportQuality", quality);
      if ("reason" in refused) {
        return json(
          refused.reason === "exportQualityInvalid" ? 400 : 500,
          refused,
        );
      }
      const answer: ExportQualityAnswer = {
        exportQuality: quality as ExportQualityChoice,
        ...refused,
      };
      return json(200, answer);
    },

    async libraryViewGet() {
      const answer: LibraryViewAnswer = await readLibraryView(home);
      if (answer.unreadable !== undefined) {
        log(`studio: Library view is the default: ${answer.unreadable}`);
      }
      return json(200, answer);
    },

    async libraryViewPut(req) {
      const body = await bodyJson(req);
      if (!body.ok) {
        return refuse(
          400,
          "libraryViewInvalid",
          `The Library view setting was not saved: ${body.error}.`,
        );
      }
      const sent = (body.value as { view?: unknown } | null)?.view;
      // The view's fields only: a choice that carries more is stored without it.
      const view = isLibraryViewChoice(sent)
        ? {
            layout: sent.layout,
            sort: {
              column: sent.sort.column,
              descending: sent.sort.descending,
            },
            project: sent.project ?? null,
          }
        : sent;
      const refused = await writeSetting(home, "libraryView", view);
      if ("reason" in refused) {
        return json(
          refused.reason === "libraryViewInvalid" ? 400 : 500,
          refused,
        );
      }
      const answer: LibraryViewAnswer = {
        view: view as LibraryViewAnswer["view"],
        ...refused,
      };
      return json(200, answer);
    },

    async pullRequestsGet() {
      const got = await readUserSettings(home);
      const unreadable = got.problems?.pullRequests;
      const answer: PullRequestsAnswer =
        unreadable === undefined
          ? { value: got.pullRequests }
          : { value: null, unreadable };
      if (answer.unreadable !== undefined) {
        log(`studio: Pull requests is unset: ${answer.unreadable}`);
      }
      return json(200, answer);
    },

    async pullRequestsPut(req) {
      const body = await bodyJson(req);
      if (!body.ok) {
        return refuse(
          400,
          "pullRequestsInvalid",
          `The Pull requests setting was not saved: ${body.error}.`,
        );
      }
      const value = (body.value as { value?: unknown } | null)?.value;
      const refused = await writeSetting(home, "pullRequests", value);
      if ("reason" in refused) {
        return json(
          refused.reason === "pullRequestsInvalid" ? 400 : 500,
          refused,
        );
      }
      const answer: PullRequestsAnswer = {
        value: value as PullRequestsChoice,
        ...refused,
      };
      return json(200, answer);
    },

    async reveal(req) {
      const body = await bodyJson(req);
      if (!body.ok) {
        return refuse(
          400,
          "revealRefused",
          `Nothing was shown: ${body.error}.`,
        );
      }
      const path = (body.value as { path?: unknown } | null)?.path;
      if (typeof path !== "string" || path === "") {
        return refuse(
          400,
          "revealRefused",
          "The reveal request named no path.",
        );
      }
      const listed = await listedOutput(path);
      if (listed === "unlisted") {
        return refuse(
          403,
          "revealRefused",
          `${path} is not an export any video lists, so it is not shown.`,
        );
      }
      if (listed === "gone") {
        return refuse(404, "revealRefused", `${path} was moved or deleted.`);
      }
      try {
        await reveal(path);
      } catch (error) {
        return refuse(
          500,
          "revealRefused",
          `${path} could not be shown in Finder (${messageOf(error)}).`,
        );
      }
      return json(200, {});
    },

    events: (req) => o.events.handler(req),
  };

  /** Whether some take's `outputs.json` lists exactly `path`. A take whose
   *  file will not read cannot vouch for a path; the log says which. */
  async function listedOutput(
    path: string,
  ): Promise<"listed" | "gone" | "unlisted"> {
    for (const entry of await library.list()) {
      let rows: Awaited<ReturnType<Library["outputs"]>>;
      try {
        rows = await library.outputs(entry.id);
      } catch (error) {
        log(
          `studio: reveal could not check video ${entry.id}'s exports: ${messageOf(error)}`,
        );
        continue;
      }
      const row = rows.find((r) => r.path === path);
      if (row !== undefined) return row.exists ? "listed" : "gone";
    }
    return "unlisted";
  }

  const wrapped = Object.fromEntries(
    Object.entries(handlers).map(([id, h]) => [id, guarded(h)]),
  ) as Omit<
    StudioHandlers,
    "window" | "exportStart" | "repoAdd" | "repoRemove"
  >;
  return wrapped;
}

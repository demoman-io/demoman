import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { DEFAULT_EXPORT_QUALITY } from "@demoman/run-core";
import {
  type Library,
  LibraryError,
  readLogo,
  readUserSettings,
} from "@demoman/runner/studio";
import { migrateToCurrent, type SceneDocument } from "@demoman/scene-schema";
import {
  type BundleAnswer,
  type DeleteAnswer,
  type ExportQualityAnswer,
  type ExportQualityChoice,
  FILE_NAME_HEADER,
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
} from "@demoman/studio-protocol";
import { saveLogo } from "./assets.js";
import type { EventHub } from "./events.js";
import { createChains, isMissing, messageOf, readIfPresent } from "./files.js";
import { createKitsFile } from "./kits.js";
import type { Handler, StudioHandlers, StudioResponse } from "./server.js";
import { writeSetting } from "./settings.js";
import { folderBytes } from "./sizes.js";
import type { createThumbs } from "./thumbs.js";
import type { HomeFeeds } from "./watch.js";

/** The Global Constraints sentence for a lost save race, with what to do
 *  (ruling R19): the page keeps refusing until it is reopened. */
export const CHANGED_ELSEWHERE =
  "This take changed in another window. Reopen it to keep editing.";
/** The Global Constraints sentences for a delete during an export. */
export const TAKE_BUSY = {
  agent: "This take is being exported by an agent.",
  studio: "This take is being exported by the Studio.",
} as const;

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
}): Omit<StudioHandlers, "window" | "exportStart"> {
  const { library, home, log } = o;
  const reveal = o.reveal ?? revealInFinder;
  const sceneWrites = createChains();
  const kits = createKitsFile(home);

  const noTake = (id: string): StudioResponse =>
    refuse(404, "takeNotFound", `There is no take "${id}" in ${library.root}.`);

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

  /** A LibraryError is the library's own refusal, with its own sentence. */
  const guarded =
    (handler: Handler): Handler =>
    async (req) => {
      try {
        return await handler(req);
      } catch (error) {
        if (error instanceof LibraryError) {
          return refuse(500, error.reason, `${error.message}.`);
        }
        throw error;
      }
    };

  const handlers: Omit<StudioHandlers, "window" | "exportStart"> = {
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
      const unreadable: UnreadableTake[] = [];
      const sizes: Record<string, number> = {};
      /** Each folder on its own: a folder that will not measure (a
       *  root-owned `.busy/`, say) leaves its size out, and its card says
       *  nothing rather than "0 B"; it never costs every other take. */
      const measure = async (id: string): Promise<void> => {
        try {
          sizes[id] = await folderBytes(library.takeDir(id));
        } catch (error) {
          log(`studio: take ${id}'s size is left out: ${messageOf(error)}`);
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
          // A row, so the person can see the folder and delete it.
          unreadable.push({ folder: entry.id, reason: entry.unreadable });
        } else if (entry.scene === null) {
          // Deleted between the listing and this read: no longer a take,
          // and not a size either.
          delete sizes[entry.id];
        } else {
          scenes.push(entry.scene);
        }
      }
      const answer: TakesAnswer = {
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
      const answer: SceneAnswer = read;
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
          "The save carried no revision (If-Match), so it could not be checked against the take on disk.",
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
          `The scene was not saved: it is take "${doc.meta.id}", sent to take "${id}".`,
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
      const done = await sceneWrites(id, () => library.deleteTake(id));
      if (!done.ok) {
        if ("missing" in done) return noTake(id);
        const first = done.holders[0];
        if (first === undefined) {
          throw new Error("deleteTake refused with no holder to name");
        }
        return refuse(409, "takeBusy", TAKE_BUSY[first.door]);
      }
      const parts = [
        ...done.clearedLeases.map(
          (h) => `cleared a stale export lock left by process ${h.pid}`,
        ),
        ...(done.leftBehind === null
          ? []
          : [`${done.leftBehind} could not be removed — delete it by hand`]),
      ];
      const note =
        parts.length === 0
          ? null
          : `${parts.join("; ").replace(/^./, (c) => c.toUpperCase())}.`;
      const answer: DeleteAnswer = { note };
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
          `could not read take ${id}'s frame bundle (${messageOf(error)})`,
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
          `Take ${id} holds no frame "${ref}".`,
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

    async exportQualityGet() {
      const got = await readUserSettings(home);
      const unreadable = got.problems?.exportQuality;
      const answer: ExportQualityAnswer =
        unreadable === undefined
          ? { exportQuality: got.exportQuality }
          : { exportQuality: DEFAULT_EXPORT_QUALITY, unreadable };
      if (unreadable !== undefined) {
        log(`studio: Export quality is High: ${unreadable}`);
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
          `${path} is not an export any take lists, so it is not shown.`,
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
          `studio: reveal could not check take ${entry.id}'s exports: ${messageOf(error)}`,
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
  ) as Omit<StudioHandlers, "window" | "exportStart">;
  return wrapped;
}

// The studio's wire contract. Runtime is ROUTES/pathFor/matchRoute and three
// constants; every other package is imported as a type only, so loading this
// under raw node pulls in nothing else.
import type { FrameBundle } from "@demoman/compositor";
import type {
  ExportAnswer,
  ExportQuality,
  FileType,
  OutputListing,
  PullRequestsValue,
} from "@demoman/run-core";
import type { SceneDocument } from "@demoman/scene-schema";

/** Sent on every state-changing request; its value is "1". */
export const STUDIO_HEADER = "X-Demoman-Studio";
export const STUDIO_COOKIE = "studio";

export const ROUTES = {
  ping: { method: "GET", path: "/api/ping" },
  takes: { method: "GET", path: "/api/takes" },
  sceneGet: { method: "GET", path: "/api/takes/:id/scene" },
  scenePut: { method: "PUT", path: "/api/takes/:id/scene" },
  takeDelete: { method: "DELETE", path: "/api/takes/:id" },
  bundle: { method: "GET", path: "/api/takes/:id/bundle" },
  frame: { method: "GET", path: "/api/takes/:id/frames/:ref" },
  thumb: { method: "GET", path: "/api/takes/:id/thumbs/:ref" },
  outputs: { method: "GET", path: "/api/takes/:id/outputs" },
  exportStart: { method: "POST", path: "/api/takes/:id/exports" },
  kitsGet: { method: "GET", path: "/api/kits" },
  kitsPut: { method: "PUT", path: "/api/kits" },
  kitsReset: { method: "POST", path: "/api/kits/reset" },
  assetPut: { method: "POST", path: "/api/assets" },
  logo: { method: "GET", path: "/api/logo" },
  pullRequestsGet: { method: "GET", path: "/api/settings/pull-requests" },
  pullRequestsPut: { method: "PUT", path: "/api/settings/pull-requests" },
  exportQualityGet: { method: "GET", path: "/api/settings/export-quality" },
  exportQualityPut: { method: "PUT", path: "/api/settings/export-quality" },
  reveal: { method: "POST", path: "/api/reveal" },
  window: { method: "POST", path: "/api/window" },
  events: { method: "GET", path: "/api/events" },
} as const;

export type RouteId = keyof typeof ROUTES;

/**
 * The route's path with each `:param` encoded. Throws, naming the route and
 * the param, when one is missing: a path with a hole in it would address a
 * different route.
 */
export function pathFor(
  id: RouteId,
  params: Record<string, string> = {},
): string {
  return ROUTES[id].path
    .split("/")
    .map((seg) => {
      if (!seg.startsWith(":")) return seg;
      const name = seg.slice(1);
      const value = params[name];
      if (value === undefined) {
        throw new Error(`pathFor("${id}") needs the param "${name}"`);
      }
      return encodeURIComponent(value);
    })
    .join("/");
}

/**
 * The route a request addresses, params decoded, or null. Method is part of
 * the match. The caller strips the query string first.
 */
export function matchRoute(
  method: string,
  pathname: string,
): { id: RouteId; params: Record<string, string> } | null {
  const parts = pathname.split("/");
  for (const id of Object.keys(ROUTES) as RouteId[]) {
    const route = ROUTES[id];
    if (route.method !== method) continue;
    const pattern = route.path.split("/");
    if (pattern.length !== parts.length) continue;
    const params: Record<string, string> = {};
    let ok = true;
    for (let i = 0; i < pattern.length; i++) {
      const p = pattern[i] as string;
      const seg = parts[i] as string;
      if (p.startsWith(":")) {
        if (seg === "") {
          ok = false;
          break;
        }
        try {
          params[p.slice(1)] = decodeURIComponent(seg);
        } catch {
          // A malformed escape addresses nothing; the caller answers
          // routeNotFound, so nothing is lost by declining here.
          ok = false;
          break;
        }
      } else if (p !== seg) {
        ok = false;
        break;
      }
    }
    if (ok) return { id, params };
  }
  return null;
}

export type StudioReason =
  | "hostRefused"
  | "tokenMissing"
  | "tokenWrong"
  | "headerMissing"
  | "takeNotFound"
  | "frameNotFound"
  | "thumbFailed"
  | "sceneInvalid"
  | "changedElsewhere"
  | "sceneNotSaved"
  | "takeBusy"
  | "kitsInvalid"
  | "kitsBusy"
  | "logoRefused"
  | "revealRefused"
  | "pullRequestsInvalid"
  | "exportQualityInvalid"
  | "invalidFileType"
  | "routeNotFound"
  | "studioDidNotStart"
  | "browserMissing"
  | "windowDidNotOpen"
  | "studioUnwritable"
  /** The take library would not read or write (the runner's LibraryError). */
  | "libraryUnreadable"
  | "libraryUnwritable"
  /** A handler or the page server threw; `detail` is the error's message. */
  | "internalError";

/** Every refusal: a reason to branch on, a sentence fit to show the person. */
export interface Refusal {
  reason: StudioReason;
  detail: string;
}

export interface PingAnswer {
  version: string;
  pid: number;
  queued: number;
}
export interface SceneAnswer {
  scene: SceneDocument;
  revision: string;
  /** What reading the take took away from it (`migrateToCurrent`'s notes):
   *  schema 12 removed text overlays. Empty when nothing was. */
  notes: string[];
}
export interface ScenePutAnswer {
  revision: string;
}
/** A take folder the library could not read, said as a row, not dropped. */
export interface UnreadableTake {
  folder: string;
  reason: string;
}
export interface TakesAnswer {
  scenes: SceneDocument[];
  /** Bytes on disk per take folder, for every scene and unreadable folder
   *  listed — except a folder that could not be measured, which is left
   *  out (the studio's log says why), never counted as 0. */
  sizes: Record<string, number>;
  unreadable: UnreadableTake[];
  /** Why `takes` events will not come (Task 3), or null while they do. */
  unwatched: string | null;
}
export interface BundleAnswer {
  bundle: FrameBundle | null;
  replay: unknown;
  capture: null;
}
export interface ExportStartBody {
  fileType: FileType;
  revision: string;
}
export interface ExportStartAnswer {
  jobId: string;
  position: number;
}
/** `note` says what was cleared or left behind, or null. */
export interface DeleteAnswer {
  note: string | null;
}
export interface KitsAnswer {
  stored: { kits: unknown[]; default: string | null };
  revision: string;
}
/**
 * `GET /api/kits`: the stored list, or the file `coerceBrandKits` (or the
 * read) refused, with its reason, so the page shows its unreadable state.
 * `storageRefused` marks a file that would not read at all, as
 * `BrandKitsRead` does. The revision is the file's either way.
 */
export type KitsRead = (
  | KitsAnswer
  | {
      invalid: { reason: string; storageRefused?: true };
      revision: string;
    }
) & {
  /** Why `kits` events will not come, or null while they do. */
  unwatched: string | null;
};
/** `PUT /api/kits`'s body: the file's own shape. Sent with `If-Match`. */
export interface KitsPutBody {
  kits: unknown[];
  default: string | null;
}
export interface KitsPutAnswer {
  revision: string;
}
/** The old file's copy, or null when there was no file to keep. */
export interface KitsResetAnswer {
  backup: string | null;
}
/** `POST /api/assets`: sent with `X-File-Name` (URI-encoded) and
 *  `Content-Type`; the body is the file's bytes. */
export interface AssetAnswer {
  ref: string;
}
export const FILE_NAME_HEADER = "X-File-Name";
export interface OutputsAnswer {
  outputs: OutputListing[];
}
export interface RevealBody {
  path: string;
}
/** The user's own `pullRequests` value (a repo's file is the repo's and is
 *  not served here). `value` is null when none is set, or when the file could
 *  not be used, in which case `unreadable` says why. */
export type PullRequestsChoice = PullRequestsValue;
export interface PullRequestsAnswer {
  value: PullRequestsChoice | null;
  unreadable?: string;
  /** On a PUT: the file was not a JSON object and was replaced; says so. */
  replaced?: string;
}
/** The user's Export quality: how the studio sizes an MP4 (`share` is the
 *  default and the answer when nothing is set). `unreadable` says why the
 *  file or value could not be used; `exportQuality` is then `share`. */
export type ExportQualityChoice = ExportQuality;
export interface ExportQualityAnswer {
  exportQuality: ExportQualityChoice;
  unreadable?: string;
  /** On a PUT: the file was not a JSON object and was replaced; says so. */
  replaced?: string;
}
export interface WindowBody {
  takeId?: string;
}

/** `POST /api/window`: the page the window was opened or sent to
 *  (`/editor.html?scene=<id>`, or `/` for the library), and an entry URL to
 *  the same page for openStudio to print. `url` carries a fresh single-use
 *  ticket (good once, for 60 s), never the session token. */
export interface WindowAnswer {
  path: string;
  url: string;
}

export type StudioEvent =
  | {
      type: "export";
      takeId: string;
      jobId: string;
      phase: "queued";
      position: number;
    }
  | {
      type: "export";
      takeId: string;
      jobId: string;
      phase: "rendering";
      done: number;
      total: number;
    }
  | { type: "export"; takeId: string; jobId: string; phase: "saving" }
  | {
      type: "export";
      takeId: string;
      jobId: string;
      phase: "saved";
      report: ExportAnswer;
    }
  | {
      type: "export";
      takeId: string;
      jobId: string;
      phase: "failed";
      reason: string;
      detail: string;
    }
  | { type: "kits" }
  | { type: "takes" }
  | { type: "watchFailed"; feed: "takes" | "kits"; detail: string }
  | { type: "open"; path: string }
  | { type: "server:stopping" };

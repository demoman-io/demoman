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
  videoRename: { method: "PUT", path: "/api/videos/:id/name" },
  videoDelete: { method: "DELETE", path: "/api/videos/:id" },
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
  /** An uploaded wallpaper: the page's resized WebP (`fitWallpaperImage`),
   *  sent as `assetPut` sends a logo. Answers an `AssetAnswer`. */
  wallpaperPut: { method: "POST", path: "/api/wallpapers" },
  wallpaper: { method: "GET", path: "/api/wallpaper" },
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
  /** Another video in the same repo already has this name (spec §1). */
  | "nameTaken"
  | "videoNotFound"
  /** A rename's body named no name, or a blank one. */
  | "videoNameInvalid"
  /** The video records would not read or write (the runner's VideoError). */
  | "videoUnreadable"
  | "videoUnwritable"
  | "kitsInvalid"
  | "kitsBusy"
  | "logoRefused"
  /** An uploaded wallpaper the studio would not store, or one `?ref=` names
   *  that it could not serve; `detail` names the file. */
  | "wallpaperRefused"
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
  /** The video this take is a version of, or null when it is in none or
   *  `videoError` says why it could not be read. */
  videoId: string | null;
  /** Why the take's video.json would not read, or null. */
  videoError: string | null;
  /** What reading the take took away from it (`migrateToCurrent`'s notes):
   *  schema 12 removed text overlays. Empty when nothing was. */
  notes: string[];
}
export interface ScenePutAnswer {
  revision: string;
}
/** Something under the studio's home that could not be read, said as a
 *  row, not dropped. `kind` says what its Delete removes: a take folder
 *  (`take`, `folder` its name), a video record (`video`, `folder` its id;
 *  its recordings stay), or nothing (`upkeep`: joining takes to videos or
 *  expiring old recordings failed, and `folder` names which). */
export interface UnreadableTake {
  folder: string;
  reason: string;
  kind: "take" | "video" | "upkeep";
}
/** Where a video was recorded: a repo, no repo (why), or not known (a
 *  video migrated from takes made before videos). The runner's `VideoRepo`. */
export type VideoRepo = { key: string } | { none: string } | { unknown: true };
/** One video as the library lists it: the runner's `VideoSummary`
 *  (`apps/runner/src/executor/videos-op.ts`), which the studio's routes
 *  assign to this type, so the two cannot drift apart unnoticed. */
export interface VideoSummary {
  id: string;
  name: string;
  repo: VideoRepo;
  startPage: string;
  versions: number;
  /** The newest complete version, or null while none completed. */
  current: {
    version: number;
    takeId: string;
    recordedAt: string;
    expired: boolean;
  } | null;
  pages: string[];
  steps: string[];
  /** Every version's exports, each with its take; a version whose list
   *  will not read is `{ takeId, unreadable }`. */
  exports: Array<
    | { takeId: string; path: string; fileType: FileType; exists: boolean }
    | { takeId: string; unreadable: string }
  >;
}
export interface VersionExport {
  path: string;
  fileType: FileType;
  exists: boolean;
}
export interface TakesAnswer {
  /** The videos the takes belong to. */
  videos: VideoSummary[];
  /** Each take that is a version of a video: which, its number, and
   *  whether its recording expired (its frames were removed). A take not
   *  here belongs to no video yet. */
  videoOf: Record<
    string,
    {
      videoId: string;
      version: number;
      expired: boolean;
      /** The files exported from this version, or why they could not be
       *  read. A file that was moved or deleted is `exists: false`. */
      exports: VersionExport[] | { unreadable: string };
    }
  >;
  scenes: SceneDocument[];
  /** Bytes on disk per take folder, for every scene and unreadable folder
   *  listed — except a folder that could not be measured, which is left
   *  out (the studio's log says why), never counted as 0. */
  sizes: Record<string, number>;
  unreadable: UnreadableTake[];
  /** Why `takes` events will not come (Task 3), or null while they do. */
  unwatched: string | null;
}
/** `PUT /api/videos/:id/name`'s body. */
export interface VideoRenameBody {
  name: string;
}
export interface BundleAnswer {
  bundle: FrameBundle | null;
  replay: unknown;
  capture: null;
}
export interface ExportStartBody {
  fileType: FileType;
  revision: string;
  /** An MP4's quality for this export. Absent: the Export quality setting. */
  quality?: ExportQuality;
}
export interface ExportStartAnswer {
  jobId: string;
  position: number;
}
/** `note` says what was cleared or left behind, or null. `partly`, on a
 *  video's delete, says what was left when it stopped part-way. */
export interface DeleteAnswer {
  note: string | null;
  partly?: string;
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
/** No link: the window is open already, and a live entry ticket in an
 *  answer that reaches agent transcripts and stdout is a credential. */
export interface WindowAnswer {
  path: string;
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

// The studio's wire contract. Runtime is ROUTES/pathFor/matchRoute and three
// constants; every other package is imported as a type only, so loading this
// under raw node pulls in nothing else.
import type { FrameBundle } from "@demoman/compositor";
import type {
  AppDraft,
  AppSpec,
  ExportAnswer,
  ExportQuality,
  FileType,
  FilmedCode,
  KeptDeliver,
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
  repoAddable: { method: "GET", path: "/api/videos/:id/repo" },
  repoAdd: { method: "POST", path: "/api/videos/:id/repo" },
  repoRemove: { method: "DELETE", path: "/api/videos/:id/repo" },
  /** `?root=`: the repo's CI state (`CiState`). */
  repoCiState: { method: "GET", path: "/api/repo/ci" },
  repoCiPlan: { method: "POST", path: "/api/repo/ci/plan" },
  repoCiApply: { method: "POST", path: "/api/repo/ci/apply" },
  repoPr: { method: "POST", path: "/api/repo/pr" },
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
  libraryViewGet: { method: "GET", path: "/api/settings/library-view" },
  libraryViewPut: { method: "PUT", path: "/api/settings/library-view" },
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
  /** A kept flow's recipe cannot be read where its record says, so it is
   *  not renamed: the recipe would keep the old name. */
  | "repoCheckoutMissing"
  /** A kept flow's rename could not write its checkout or its record;
   *  `detail` says what was done before it stopped. */
  | "repoFlowUnwritable"
  /** An add's body: a path that is empty or absolute, an unknown delivery
   *  or quality. */
  | "repoBodyInvalid"
  /** The flow could not be added when the button was pressed; `detail` is
   *  the check's label and sentence. */
  | "notAddable"
  /** A remove of a flow whose recipe is not in the repo (the runner's). */
  | "notInRepo"
  /** The flow is being added to its repo; it cannot be added or removed
   *  until that ends. */
  | "repoBusy"
  /** A CI request's body: no root, or a field of the wrong shape. */
  | "ciBodyInvalid"
  /** A CI job for this repo is running; it ends before another starts. */
  | "ciBusy"
  /** A pull request named a file no add wrote in that repo, or one that
   *  resolves outside it. */
  | "prFileRefused"
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
  | "libraryViewInvalid"
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
  /** Every step of the shown version, uncut: the library searches them. */
  steps: string[];
  /** Every version's exports, each with its take; a version whose list
   *  will not read is `{ takeId, unreadable }`. */
  exports: Array<
    | { takeId: string; path: string; fileType: FileType; exists: boolean }
    | { takeId: string; unreadable: string }
  >;
  /** The recipe that keeps this flow; `unknown` says why a kept record's
   *  file cannot be used. */
  kept:
    | { file: string; root: string; deliver: KeptDeliver; key: string | null }
    | null
    | {
        unknown: string;
      };
  /** The repo key the flow was added to, as its kept mark recorded it,
   *  whether or not that checkout still exists; null when there is no mark
   *  or it has no key. The flow's project (spec "The model", rule 1). */
  addedTo: string | null;
}
/** What the person chose to add a flow to its repo. */
export interface RepoAddBody {
  path: string;
  deliver: KeptDeliver;
  quality: ExportQuality;
}
/** `repoAdd`'s 202: the outcome comes as `repo` events. */
export interface RepoAddStarted {
  jobId: string;
}
/** `repoRemove`'s 200. */
export interface RepoRemoveAnswer {
  removed: string[];
  exportsLeft: string[];
  notes: string[];
}

/** Whether a flow can be added to its repo: the runner's `Addable`
 *  (`apps/runner/src/executor/addable.ts`), which the studio's routes assign
 *  to this type, so the two cannot drift apart unnoticed. `label` is the
 *  short reason and `detail` the sentence. */
export type Addable =
  | { ok: true; root: string; defaultPath: string }
  | { ok: false; reason: string; label: string; detail: string };
export interface VersionExport {
  path: string;
  fileType: FileType;
  exists: boolean;
}
export interface TakesAnswer {
  /** The videos the takes belong to. */
  videos: VideoSummary[];
  /** Whether each video, by id, can be added to its repo. A video that
   *  will not read has none: its row says why. */
  addable: Record<string, Addable>;
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
      /** The code this version's run filmed, from its report.json; null
       *  when the report is missing or will not read (the log says why). */
      filmedCode: FilmedCode | null;
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

export type LibraryLayout = "list" | "grid";
/** Length is deliberately not a sort column (spec 2026-10-31 §3). */
export type LibrarySortColumn =
  | "name"
  | "where"
  | "videos"
  | "recorded"
  | "size";
/** The Library's layout and sort, kept in `<home>/settings.json`. */
export interface LibraryViewChoice {
  layout: LibraryLayout;
  sort: { column: LibrarySortColumn; descending: boolean };
  /** The saved pick: a `placeSearch` value without the `?project=`
   *  ("all", "none", "unreadable" or a project key), or null for none. */
  project: string | null;
}
/** Decided here once; the studio serves it when nothing is stored. Frozen:
 *  every reader is handed this one object. */
export const DEFAULT_LIBRARY_VIEW: LibraryViewChoice = Object.freeze({
  layout: "list",
  sort: Object.freeze({ column: "recorded", descending: true }),
  project: null,
});
const LAYOUTS: readonly string[] = ["list", "grid"];
const SORT_COLUMNS: readonly string[] = [
  "name",
  "where",
  "videos",
  "recorded",
  "size",
];
export function isLibraryViewChoice(v: unknown): v is LibraryViewChoice {
  if (typeof v !== "object" || v === null) return false;
  const { layout, sort, project } = v as {
    layout?: unknown;
    sort?: unknown;
    project?: unknown;
  };
  // Absent in files written before the project model; read as null.
  if (project !== undefined && project !== null && typeof project !== "string")
    return false;
  if (typeof layout !== "string" || !LAYOUTS.includes(layout)) return false;
  if (typeof sort !== "object" || sort === null) return false;
  const { column, descending } = sort as {
    column?: unknown;
    descending?: unknown;
  };
  return (
    typeof column === "string" &&
    SORT_COLUMNS.includes(column) &&
    typeof descending === "boolean"
  );
}
/** `unreadable` says why the stored value could not be used; `view` is then
 *  the default. */
export interface LibraryViewAnswer {
  view: LibraryViewChoice;
  unreadable?: string;
  /** On a PUT: the file was not a JSON object and was replaced; says so. */
  replaced?: string;
}
export interface WindowBody {
  takeId?: string;
  /** The caller's repo key: the library opens on that project. */
  project?: string;
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
  | {
      type: "repo";
      videoId: string;
      jobId: string;
      phase: "queued";
      position: number;
    }
  | {
      type: "repo";
      videoId: string;
      jobId: string;
      phase: "adding";
      line: string;
    }
  | {
      type: "repo";
      videoId: string;
      jobId: string;
      phase: "added";
      file: string;
      written: string[];
      notes: string[];
      root: string;
    }
  | {
      type: "repo";
      videoId: string;
      jobId: string;
      phase: "failed";
      reason: string;
      detail: string;
    }
  | { type: "ci"; jobId: string; phase: "progress"; line: string }
  | {
      type: "ci";
      jobId: string;
      phase: "done";
      step: "plan" | "apply";
      answer: CiAnswerWire;
    }
  | { type: "kits" }
  | { type: "takes" }
  | { type: "watchFailed"; feed: "takes" | "kits"; detail: string }
  | { type: "open"; path: string }
  | { type: "server:stopping" };

// CI setup's wire (Part C, Task 5): the CLI's Part B types without anything
// that can hold a secret value (`values`, a plan's `contents`, `root`, the
// app file's text, a local env file's path). The CLI's adapter assigns B's
// results to these, so its typecheck fails if the two drift apart.

/** B's `CiOptions["trigger"]`. */
export type CiTriggerWire =
  | "push"
  | "release"
  | "daily"
  | { deployment: string };
export interface CiChoicesWire {
  trigger?: CiTriggerWire;
  route?: "pr" | "main";
  artifact?: boolean;
  app?: AppSpec;
  appBy?: "agent" | "person";
  replaceSecrets?: string[];
}
/** The runner's `AppSource`, and B's `{ kind: "file" }`. */
export type CiAppSourceWire =
  | {
      kind: "playwright" | "copilot" | "packageJson" | "file";
      file: string;
    }
  | { kind: "workflow"; file: string; job: string }
  | { kind: "agent" }
  | { kind: "person" };
export interface CiPlanWire {
  repo: { slug: string; defaultBranch: string; remote: string };
  trigger: CiTriggerWire;
  offers: Array<{
    trigger: CiTriggerWire;
    label: string;
    offered: boolean;
    why: string;
    transient?: boolean;
  }>;
  route: "pr" | "main";
  artifact: boolean;
  app: { spec: AppSpec; source: CiAppSourceWire } | null;
  deployment: { environment: string; url: string } | null;
  check:
    | {
        passed: true;
        flow: string;
        outcome: string;
        recordSeconds: number;
        appSeconds: number;
        lines: string[];
      }
    | { skipped: string };
  secrets: Array<{
    name: string;
    status: "set" | "replace" | "keep" | "missing";
  }>;
  actionsSetting: "turnOn" | "alreadyOn" | "notNeeded";
  files: string[];
  scriptOnly: Array<{ flow: string; why: string }>;
  branch: string;
  title: string;
  pushCost: string | null;
  offBase: { head: string; base: string } | null;
}
/** A plan the CLI holds, by `planId`: apply names it, never resends it. */
export interface CiPlannedWire {
  planId: string;
  plan: CiPlanWire;
  /** B's `planLines`: the confirmation text. */
  lines: string[];
}
/** `reason` is B's open string (about 30 values). */
export interface CiStopWire {
  reason: string;
  detail: string;
  step?: string;
  tail?: string;
  proposal?: {
    draft: AppDraft;
    source: CiAppSourceWire;
    holes: Array<{ field: string; why: string }>;
  };
  secrets?: Array<{ name: string; for: "account" | "app"; why: string }>;
}
export type SetupPrWire =
  | { opened: { number: number; url: string; branch: string; sha: string } }
  | {
      failed: "push" | "pr" | "worktree";
      detail: string;
      branchUrl?: string;
    };
export type CiWatchedWire =
  | { passed: { runUrl: string; artifactUrl: string; lines: string[] } }
  | {
      failed: {
        runUrl: string;
        step: string;
        tail: string;
        failedRuns: number | null;
        gaveUp: boolean;
        note?: string;
      };
    }
  | { cancelled: { runUrl: string } }
  | { unknown: { runUrl: string | null; why: string } };
export interface CiAppliedWire {
  pr: SetupPrWire;
  secrets: {
    set: string[];
    kept: string[];
    failed: Array<{ name: string; said: string }>;
  };
  setting:
    | { kind: "alreadyOn" }
    | { kind: "turnedOn" }
    | { kind: "refused"; detail: string; url: string }
    | { kind: "unknown"; detail: string; url: string }
    | null;
  watched: CiWatchedWire;
  /** The run's verdict as the terminal says it. */
  lines: string[];
}
export type CiAnswerWire = CiPlannedWire | CiAppliedWire | CiStopWire;
/** `repoCiState`'s answer. `finished`: the last job for this repo that
 *  ended, until another starts or the repo is set up. */
export type CiState =
  | { kind: "setUp" }
  | { kind: "notSetUp" }
  | { kind: "noGh"; detail: string }
  | { kind: "unreadable"; detail: string }
  | { kind: "running"; jobId: string }
  | {
      kind: "finished";
      jobId: string;
      step: "plan" | "apply";
      answer: CiAnswerWire;
    };
/** `repoCiPlan`'s body: the only request that carries secret values. */
export interface CiPlanBody {
  root: string;
  choices: CiChoicesWire;
  secrets: Record<string, string>;
}
export interface CiApplyBody {
  root: string;
  planId: string;
}
/** `repoCiPlan` and `repoCiApply`'s 202: the outcome comes as `ci` events. */
export interface CiStarted {
  jobId: string;
}
export interface RepoPrBody {
  root: string;
  branch: string;
  title: string;
  body: string;
  /** Repo paths, relative to `root`. */
  files: string[];
}

/** Where the library page is looking: one project (a repo key), everything,
 *  the takes with no project, or the folders that would not read. The page
 *  and the server write and read `/?project=` with these two functions. */
export type Place = { project: string } | "all" | "none" | "unreadable";

const RESERVED_PLACES = ["all", "none", "unreadable"] as const;

/** Reads `?project=`. `all`, `none` and `unreadable` are reserved; any other
 *  value is a project key; absent or empty is null. */
export function parsePlace(search: string): Place | null {
  const v = new URLSearchParams(search).get("project");
  if (v === null || v === "") return null;
  return (RESERVED_PLACES as readonly string[]).includes(v)
    ? (v as Place)
    : { project: v };
}

/** The inverse of `parsePlace`. */
export function placeSearch(p: Place): string {
  return `?project=${encodeURIComponent(typeof p === "string" ? p : p.project)}`;
}

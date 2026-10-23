// apps/studio/pages/src/platform/http.ts
import type { FrameImage } from "@demoman/compositor";
import {
  type ExportAnswer,
  exportCaveats,
  type OutputListing,
} from "@demoman/run-core";
import { decodeLogo } from "@demoman/run-core/logo";
import type { LogoLoad } from "@demoman/run-core/render";
import type { SceneDocument } from "@demoman/scene-schema";
import {
  type AssetAnswer,
  type BundleAnswer,
  type DeleteAnswer,
  type ExportQualityAnswer,
  type ExportStartAnswer,
  type ExportStartBody,
  FILE_NAME_HEADER,
  type KitsPutAnswer,
  type KitsPutBody,
  type KitsRead,
  type KitsResetAnswer,
  type OutputsAnswer,
  type PingAnswer,
  type PullRequestsAnswer,
  pathFor,
  ROUTES,
  type RouteId,
  type SceneAnswer,
  type ScenePutAnswer,
  STUDIO_HEADER,
  type StudioEvent,
  type TakesAnswer,
} from "@demoman/studio-protocol";
import {
  type BrandKitStore,
  createBrandKitStore,
  type KitLock,
  type KitStorageArea,
} from "../adapters/brand-kit-store";
import { decodeFrame } from "../adapters/frame-decode";
import {
  BRAND_KITS_KEY,
  type BrandKitsRead,
  coerceBrandKits,
  DEFAULT_KIT_KEY,
} from "../core/brand-kit";
import type { ReplayStatus } from "../core/replay/status";
import type { SaveView } from "../editor/export-run";
import { GONE_LINES, type GoneKind, showGone } from "./gone";
import type {
  ExportEvent,
  FolderListing,
  OutputRow,
  Platform,
  RemoveReply,
} from "./types";

export type {
  ExportEvent,
  OutputRow,
  Platform,
  RemoveReply,
  RevealTarget,
} from "./types";

/**
 * A refusal the studio answered, or one this side makes in its place:
 * `message` is the sentence to show (`detail`), `reason` the identifier to
 * branch on. `status` is the HTTP status, 0 when no answer came at all.
 */
export class StudioError extends Error {
  readonly reason: string;
  readonly status: number;
  constructor(reason: string, detail: string, status: number) {
    super(detail);
    this.name = "StudioError";
    this.reason = reason;
    this.status = status;
  }
}

/** The guard's own refusals (spec §4.1): the session is gone, whatever the
 *  route. A 403 for any other reason (`revealRefused`) is that route's. */
const SESSION_REASONS: ReadonlySet<string> = new Set([
  "hostRefused",
  "tokenMissing",
  "tokenWrong",
  "headerMissing",
]);

/** How many times a kits write is tried against a list that keeps
 *  changing under it (spec §7.2). */
export const KITS_TRIES = 3;
export const KITS_BUSY =
  "Your brand kits kept changing in another window, so this change was not saved.";

/** The empty library's hint in the studio, which has no toolbar icon. */
const STUDIO_FIRST_TAKE_HINT =
  "Ask your agent for a demo video. Each take shows up here, grouped by the day you made it.";

/** The line that replaces every Runs link in the studio (spec §5). */
export const refilmLine = (takeId: string): string =>
  `Ask your agent to re-record this take — \`run({ takeId: "${takeId}" })\``;

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const baseName = (path: string): string =>
  path.slice(path.lastIndexOf("/") + 1) || path;

/** One SSE frame's fields: `event:` and the `data:` lines joined. Comments
 *  (`: keep-alive`) carry nothing. */
function parseFrame(frame: string): { type: string; data: string } | null {
  let type = "message";
  const data: string[] = [];
  for (const line of frame.split("\n")) {
    if (line === "" || line.startsWith(":")) continue;
    const colon = line.indexOf(":");
    const field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") type = value;
    else if (field === "data") data.push(value);
  }
  return data.length === 0 ? null : { type, data: data.join("\n") };
}

/** What "Show in folder" and the outcome row say for a saved report: the
 *  file for MP4 and GIF, the folder and its stills for stills. */
function saveViewOf(
  report: Extract<ExportAnswer, { outcome: "saved" }>,
): Extract<SaveView, { kind: "saved" }> {
  if (report.fileType === "stills") {
    return {
      kind: "saved",
      names: report.folder.files.map((f) => f.name),
      byteLength: report.folder.files.reduce((n, f) => n + f.byteLength, 0),
      reveal: { kind: "path", path: report.folder.path },
      summary: report.summary,
      outputRefs: [],
    };
  }
  return {
    kind: "saved",
    names: [baseName(report.file.path)],
    byteLength: report.file.byteLength,
    reveal: { kind: "path", path: report.file.path },
    summary: report.summary,
    outputRefs: [],
  };
}

/** A listed export's caveats. The record is a file on disk an older studio
 *  may have written; one whose warnings cannot be read says so as its one
 *  caveat rather than reading as a clean export. */
function caveatsOf(
  report: Extract<ExportAnswer, { outcome: "saved" }>,
): string[] {
  try {
    return exportCaveats(report);
  } catch (error) {
    return [
      `its warnings could not be read: ${error instanceof Error ? error.message : String(error)}`,
    ];
  }
}

/** A row of `outputs.json` as the export panel draws it. */
function outputRowOf(listing: OutputListing): OutputRow {
  const { report } = listing;
  // The row says its size, time and frame, not the summary sentence, which
  // restates the path and size and carries the warnings already said when
  // the export was made (the author, 2026-10-19). `outputs.json` records
  // saved exports only, so a frame is there to read.
  const saved = report.outcome === "saved" ? report : null;
  const frame =
    saved === null
      ? null
      : saved.fileType === "stills"
        ? `${saved.width}×${saved.height}`
        : `${saved.width}×${saved.height} · ${saved.fps} fps`;
  return {
    kind: "file",
    key: `${listing.path}@${listing.renderedAt}`,
    name: baseName(listing.path),
    byteLength: listing.byteLength,
    path: listing.path,
    exists: listing.exists,
    sceneDigest: listing.sceneDigest,
    renderedAt: listing.renderedAt,
    detail: frame,
    caveats: saved === null ? [] : caveatsOf(saved),
  };
}

interface RequestInit {
  params?: Record<string, string>;
  query?: Record<string, string>;
  /** Sent as JSON, with its content type. */
  json?: unknown;
  /** Sent as is (a logo's bytes). */
  raw?: Blob;
  headers?: Record<string, string>;
  signal?: AbortSignal;
  /** The event stream's own: a lost connection is retried once before the
   *  page says the studio stopped, so `request` does not say it here. */
  retried?: boolean;
}

/**
 * The studio's side of `#platform` (spec 2026-10-15 §5): every member over
 * the studio's loopback HTTP API, its events over one `GET /api/events`
 * stream. Built into the studio's pages by `vite.studio.config.ts`; nothing
 * picks this side at run time.
 *
 * Every failure is the studio's `{ reason, detail }` as a `StudioError`.
 * Three take the whole page instead (`gone.ts`): the session refused (403),
 * the server gone (a `fetch` that rejects, an event stream that will not
 * come back), and a page from another version than the server's — after
 * which no write is sent.
 */
export function createPlatform(
  o: {
    /** The brand kits' lock; Web Locks otherwise, as on the extension. */
    kitLock?: KitLock;
    /** Tests: `location.reload()` otherwise. */
    reload?: () => void;
  } = {},
): Platform {
  /** Set while the page is navigating away: a stream or request cut short
   *  by that is the page leaving, not the studio stopping. */
  let leaving = false;
  let goneKind: GoneKind | null = null;
  const gone = (kind: GoneKind): void => {
    if (leaving) return;
    goneKind ??= kind;
    showGone(kind);
  };

  /**
   * Every call to the studio. Sends the studio header and the session
   * cookie; a write waits for the version check and is refused unsent when
   * it failed. Resolves the 2xx answer, rejects every other as its
   * `StudioError`.
   */
  async function request(
    id: RouteId,
    init: RequestInit = {},
  ): Promise<Response> {
    const route = ROUTES[id];
    if (route.method !== "GET") await versionChecked;
    let url = pathFor(id, init.params);
    if (init.query !== undefined) {
      url += `?${new URLSearchParams(init.query).toString()}`;
    }
    const headers: Record<string, string> = {
      [STUDIO_HEADER]: "1",
      ...init.headers,
    };
    let body: string | Blob | undefined;
    if (init.json !== undefined) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(init.json);
    } else if (init.raw !== undefined) {
      body = init.raw;
    }
    let res: Response;
    try {
      res = await fetch(url, {
        method: route.method,
        headers,
        body,
        credentials: "same-origin",
        signal: init.signal,
      });
    } catch (error) {
      if (init.retried !== true) gone("stopped");
      throw new StudioError(
        "studioGone",
        `The studio did not answer ${route.method} ${url} (${messageOf(error)}).`,
        0,
      );
    }
    if (res.ok) return res;
    let refusal: { reason?: unknown; detail?: unknown } | null = null;
    try {
      refusal = (await res.json()) as { reason?: unknown; detail?: unknown };
    } catch {
      // Said below: an answer with no reason is reported as exactly that.
    }
    const reason =
      typeof refusal?.reason === "string" ? refusal.reason : "noReason";
    const detail =
      typeof refusal?.detail === "string"
        ? refusal.detail
        : `The studio answered ${res.status} to ${route.method} ${url} without saying why.`;
    if (
      res.status === 403 &&
      (reason === "noReason" || SESSION_REASONS.has(reason))
    ) {
      gone("expired");
    }
    throw new StudioError(reason, detail, res.status);
  }

  async function answer<T>(res: Response): Promise<T> {
    try {
      return (await res.json()) as T;
    } catch (error) {
      throw new StudioError(
        "internalError",
        `The studio's answer was not JSON (${messageOf(error)}).`,
        res.status,
      );
    }
  }

  /**
   * The version check (spec §8): a page built for another studio than the
   * one answering says so and sends no edit. Every write awaits it.
   */
  const expected: unknown = import.meta.env.STUDIO_VERSION;
  const versionChecked: Promise<void> = (async () => {
    const ping = await answer<PingAnswer>(await request("ping"));
    if (typeof expected !== "string" || ping.version !== expected) {
      gone("updated");
      throw new StudioError(
        "versionSkew",
        `${GONE_LINES.updated} (this page is ${typeof expected === "string" ? expected : "unversioned"}, the studio ${ping.version})`,
        0,
      );
    }
  })();
  // The page says it (`gone`); every write that awaits this rejects with it.
  versionChecked.catch((error: unknown) => {
    console.info("demoman studio: no edits will be sent:", messageOf(error));
  });

  // ---- events ------------------------------------------------------------

  const exportListeners = new Set<(e: ExportEvent) => void>();
  const kitListeners = new Set<() => void>();
  const takesListeners = new Set<() => void>();
  const openListeners = new Set<(path: string) => void>();

  /** Each listener on its own: one that throws stops neither the rest nor
   *  the stream. */
  const each = <A>(fns: Set<(a: A) => void>, arg: A, what: string): void => {
    for (const fn of [...fns]) {
      try {
        fn(arg);
      } catch (error) {
        console.error(`demoman studio: a ${what} listener failed`, error);
      }
    }
  };
  const emit = (e: ExportEvent): void => each(exportListeners, e, "export");

  /** The jobs this page started (`Platform.exports.onEvent`'s rule). */
  const ownJobs = new Set<string>();
  /** Starts posted and not yet answered: the queue sends `queued` before
   *  the POST's answer names the job, so events for jobs this page does not
   *  know yet are held until it does. */
  let starting = 0;
  let held: Extract<StudioEvent, { type: "export" }>[] = [];

  function onExport(e: Extract<StudioEvent, { type: "export" }>): void {
    if (!ownJobs.has(e.jobId)) {
      if (starting > 0) {
        held.push(e);
        return;
      }
      // Another window's job: its file is in this take's list now.
      if (e.phase === "saved") emit({ kind: "outputsChanged" });
      return;
    }
    switch (e.phase) {
      case "queued":
        emit({ kind: "queued", jobId: e.jobId, position: e.position });
        return;
      case "rendering":
        emit({
          kind: "rendering",
          jobId: e.jobId,
          done: e.done,
          total: e.total,
        });
        return;
      case "saving":
        emit({ kind: "saving", jobId: e.jobId });
        return;
      case "saved": {
        ownJobs.delete(e.jobId);
        const report = e.report;
        if (report.outcome === "saved") {
          emit({
            kind: "saved",
            jobId: e.jobId,
            save: saveViewOf(report),
            summary: report.summary,
          });
        } else {
          // The queue sends `saved` only for a saved report; one that is not
          // is said as what it is, never drawn as a save.
          emit({ kind: "failed", jobId: e.jobId, detail: report.summary });
        }
        emit({ kind: "outputsChanged" });
        return;
      }
      case "failed":
        ownJobs.delete(e.jobId);
        emit({ kind: "failed", jobId: e.jobId, detail: e.detail });
        emit({ kind: "outputsChanged" });
        return;
    }
  }

  function dispatch(type: string, data: string): void {
    let event: StudioEvent;
    try {
      event = JSON.parse(data) as StudioEvent;
    } catch (error) {
      console.error(
        `demoman studio: the "${type}" event was not JSON, so it was dropped`,
        error,
      );
      return;
    }
    switch (event.type) {
      case "export":
        onExport(event);
        return;
      case "kits":
        each(kitListeners, undefined, "kits");
        return;
      case "takes":
        each(takesListeners, undefined, "takes");
        return;
      case "watchFailed":
        // Only a trigger to read again: the GET answer carries the reason
        // (`unwatched`), so a page that opens after this still hears it.
        switch (event.feed) {
          case "takes":
            each(takesListeners, undefined, "takes");
            return;
          case "kits":
            each(kitListeners, undefined, "kits");
            return;
          default: {
            // A feed added to the protocol must be routed here, not left
            // to ring the kits page's listeners.
            const feed: never = event.feed;
            console.info(
              `demoman studio: a watchFailed for a feed this page does not know: ${String(feed)}`,
            );
            return;
          }
        }
      case "open":
        each(openListeners, event.path, "open");
        return;
      case "server:stopping":
        gone("stopped");
        return;
      default:
        console.info(
          `demoman studio: an event this page does not know: ${type}`,
        );
    }
  }

  const streamAbort = new AbortController();
  globalThis.addEventListener?.("pagehide", () => {
    leaving = true;
    streamAbort.abort();
  });
  // A page Chrome restores from the back/forward cache comes back with its
  // event stream aborted and `leaving` set: deaf to its exports and to the
  // server going, for good. Loaded again instead, which also checks the
  // version and reads the take's revision afresh. (The pages are served
  // `no-store`, which keeps most of them out of that cache to begin with.)
  const reload = o.reload ?? (() => location.reload());
  globalThis.addEventListener?.("pageshow", (event) => {
    if ((event as PageTransitionEvent).persisted) reload();
  });

  /**
   * The event stream (ruling R10: `fetch`, so it can carry the studio
   * header, which `EventSource` cannot). A stream that fails or ends is
   * opened again once; a second failure in a row is the studio gone. A
   * stream that delivered anything has proved the studio is there, so the
   * next drop gets its one retry again.
   */
  async function follow(): Promise<void> {
    let failures = 0;
    for (;;) {
      if (leaving || goneKind !== null) return;
      let why: string;
      try {
        const res = await request("events", {
          signal: streamAbort.signal,
          retried: true,
        });
        const body = res.body;
        if (body === null) throw new Error("the event stream has no body");
        const reader = body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          failures = 0;
          buffer += decoder
            .decode(value, { stream: true })
            .replace(/\r\n?/g, "\n");
          let at = buffer.indexOf("\n\n");
          while (at >= 0) {
            const frame = parseFrame(buffer.slice(0, at));
            buffer = buffer.slice(at + 2);
            if (frame !== null) dispatch(frame.type, frame.data);
            at = buffer.indexOf("\n\n");
          }
        }
        why = "the studio closed the event stream";
      } catch (error) {
        // A 403 has already taken the page (`request`).
        if (error instanceof StudioError && error.status === 403) return;
        why = messageOf(error);
      }
      if (leaving || goneKind !== null) return;
      failures += 1;
      if (failures >= 2) {
        console.info(`demoman studio: the event stream is gone (${why})`);
        gone("stopped");
        return;
      }
      console.info(`demoman studio: reconnecting the event stream (${why})`);
    }
  }
  void follow();

  // ---- members -----------------------------------------------------------

  /** Which take each frame ref belongs to, from the bundles this page has
   *  read: the frame route is per take, and `load` is given a ref alone. */
  const takeOfRef = new Map<string, string>();

  /** The kits' revision as last read under the kit lock; a write sends it as
   *  `If-Match`. Only `area` touches it, and only under the lock. */
  let kitsRevision: string | null = null;
  /** Why kit events will not come, from the last kits GET; null before one
   *  has been read, and while they do come. */
  let kitsUnwatched: string | null = null;
  const area: KitStorageArea = {
    async get() {
      const read = await answer<KitsRead>(await request("kitsGet"));
      kitsRevision = read.revision;
      kitsUnwatched = read.unwatched;
      if ("invalid" in read) throw new Error(read.invalid.reason);
      return {
        [BRAND_KITS_KEY]: read.stored.kits,
        [DEFAULT_KIT_KEY]: read.stored.default,
      };
    },
    async set(items) {
      if (kitsRevision === null) {
        throw new Error("the brand kits were written before they were read");
      }
      const put: KitsPutBody = {
        kits: (items[BRAND_KITS_KEY] as unknown[] | undefined) ?? [],
        default: (items[DEFAULT_KIT_KEY] as string | null | undefined) ?? null,
      };
      const done = await answer<KitsPutAnswer>(
        await request("kitsPut", {
          json: put,
          headers: { "If-Match": kitsRevision },
        }),
      );
      kitsRevision = done.revision;
    },
    async remove() {
      // `get` never hands back the old single-kit key, so the store never
      // owes its removal here.
      throw new Error("the studio keeps no old brand kit key to remove");
    },
  };
  const kitStore = createBrandKitStore(() => area, o.kitLock);
  const kits: Omit<BrandKitStore, "reset"> &
    Required<Pick<Platform["kits"], "reset" | "onChange" | "unwatched">> = {
    async read(): Promise<BrandKitsRead> {
      // Not through `area`: a read must not move the revision an update
      // under the lock is holding.
      let read: KitsRead;
      try {
        read = await answer<KitsRead>(await request("kitsGet"));
        kitsUnwatched = read.unwatched;
      } catch (error) {
        return {
          state: "invalid",
          storageRefused: true,
          reason: `the studio did not answer the kits read: ${messageOf(error)}`,
        };
      }
      if ("invalid" in read) {
        return {
          state: "invalid",
          reason: read.invalid.reason,
          ...(read.invalid.storageRefused === true
            ? { storageRefused: true as const }
            : {}),
        };
      }
      return coerceBrandKits(read.stored.kits, read.stored.default);
    },
    readStored: () => kitStore.readStored(),
    /** A 409 is another window's write landing between this read and this
     *  write: the change is read and applied again, up to `KITS_TRIES`
     *  times, then refused `kitsBusy`. */
    async update(change) {
      for (let attempt = 1; ; attempt += 1) {
        try {
          return await kitStore.update(change);
        } catch (error) {
          if (!(error instanceof StudioError && error.status === 409)) {
            throw error;
          }
          if (attempt >= KITS_TRIES) {
            throw new StudioError("kitsBusy", KITS_BUSY, 409);
          }
        }
      }
    },
    async reset() {
      const done = await answer<KitsResetAnswer>(await request("kitsReset"));
      return { backup: done.backup };
    },
    onChange(fn) {
      kitListeners.add(fn);
      return () => kitListeners.delete(fn);
    },
    unwatched: () => kitsUnwatched,
  };

  async function readFolder(): Promise<FolderListing> {
    const got = await answer<TakesAnswer>(await request("takes"));
    return {
      scenes: got.scenes,
      sizes: got.sizes,
      unreadable: got.unreadable,
      unwatched: got.unwatched,
    };
  }

  return {
    scenes: {
      async get(id) {
        try {
          const got = await answer<SceneAnswer>(
            await request("sceneGet", { params: { id } }),
          );
          return { scene: got.scene, revision: got.revision, notes: got.notes };
        } catch (error) {
          // Not stored is the null this member promises; anything else is
          // the read failing, and rejects with why.
          if (error instanceof StudioError && error.reason === "takeNotFound") {
            return null;
          }
          throw error;
        }
      },
      async put(doc: SceneDocument, revision) {
        // No revision sends no If-Match, and the studio refuses it (428)
        // with its own sentence rather than writing blind.
        const done = await answer<ScenePutAnswer>(
          await request("scenePut", {
            params: { id: doc.meta.id },
            json: doc,
            headers: revision === null ? {} : { "If-Match": revision },
          }),
        );
        return { revision: done.revision };
      },
      async list() {
        return (await readFolder()).scenes;
      },
      async remove(id): Promise<RemoveReply> {
        try {
          const done = await answer<DeleteAnswer>(
            await request("takeDelete", { params: { id } }),
          );
          return done.note === null
            ? { ok: true }
            : { ok: true, note: done.note };
        } catch (error) {
          // No answer at all is a request that could not be made.
          if (!(error instanceof StudioError) || error.status === 0)
            throw error;
          // The library says "Not deleted: <detail>." — the detail without
          // its own full stop.
          return {
            ok: false,
            error: error.reason,
            detail: error.message.replace(/\.$/, ""),
          };
        }
      },
    },
    folder: {
      read: readFolder,
      onChange(fn) {
        takesListeners.add(fn);
        return () => takesListeners.delete(fn);
      },
      async thumb(ref) {
        const id = takeOfRef.get(ref);
        if (id === undefined) {
          throw new Error(
            `the frame "${ref}" is in no take this page has read a bundle for, so its preview cannot be asked for`,
          );
        }
        const res = await request("thumb", { params: { id, ref } });
        return createImageBitmap(await res.blob());
      },
    },
    bundles: {
      async active(sceneId) {
        const got = await answer<BundleAnswer>(
          await request("bundle", { params: { id: sceneId } }),
        );
        for (const k of got.bundle?.keyframes ?? [])
          takeOfRef.set(k.ref, sceneId);
        for (const s of got.bundle?.motionSpans ?? [])
          takeOfRef.set(s.ref, sceneId);
        return {
          bundle: got.bundle,
          replay: (got.replay ?? null) as ReplayStatus | null,
          capture: null,
        };
      },
      async load(ref): Promise<Uint8Array | FrameImage> {
        const id = takeOfRef.get(ref);
        if (id === undefined) {
          throw new Error(
            `the frame "${ref}" is in no take this page has read a bundle for`,
          );
        }
        const res = await request("frame", { params: { id, ref } });
        return decodeFrame(ref, new Uint8Array(await res.arrayBuffer()));
      },
    },
    outputs: {
      async list(takeId) {
        const got = await answer<OutputsAnswer>(
          await request("outputs", { params: { id: takeId } }),
        );
        // Newest first, as the extension lists its stored outputs.
        return [...got.outputs]
          .sort((a, b) => b.renderedAt.localeCompare(a.renderedAt))
          .map(outputRowOf);
      },
    },
    logos: {
      async put(file) {
        const done = await answer<AssetAnswer>(
          await request("assetPut", {
            raw: file,
            headers: {
              [FILE_NAME_HEADER]: encodeURIComponent(file.name),
              "Content-Type": file.type,
            },
          }),
        );
        return { ref: done.ref };
      },
      async load(ref): Promise<LogoLoad> {
        // `loadLogo`'s shape: a reason, never a frame drawn without the logo
        // and nothing said.
        let res: Response;
        try {
          res = await request("logo", { query: { ref } });
        } catch (error) {
          return { ok: false, error: messageOf(error) };
        }
        try {
          const bytes = new Uint8Array(await res.arrayBuffer());
          const type = (res.headers.get("Content-Type") ?? "").split(";")[0];
          return {
            ok: true,
            source: await decodeLogo(bytes, type?.trim() ?? ""),
          };
        } catch (error) {
          return { ok: false, error: messageOf(error) };
        }
      },
    },
    kits,
    pullRequests: {
      async read() {
        return answer<PullRequestsAnswer>(await request("pullRequestsGet"));
      },
      async write(value) {
        const got = await answer<PullRequestsAnswer>(
          await request("pullRequestsPut", { json: { value } }),
        );
        return got.replaced === undefined ? {} : { replaced: got.replaced };
      },
    },
    exportQuality: {
      async read() {
        const got = await answer<ExportQualityAnswer>(
          await request("exportQualityGet"),
        );
        return {
          quality: got.exportQuality,
          ...(got.unreadable === undefined
            ? {}
            : { unreadable: got.unreadable }),
        };
      },
      async write(exportQuality) {
        const got = await answer<ExportQualityAnswer>(
          await request("exportQualityPut", { json: { exportQuality } }),
        );
        return got.replaced === undefined ? {} : { replaced: got.replaced };
      },
    },
    exports: {
      async start(takeId, { fileType, revision }) {
        // `aspect` is not sent: the revision pins the scene, and the scene
        // pins it (Global Constraints).
        if (revision === null) {
          throw new StudioError(
            "sceneNotSaved",
            "The export was not started: this page has no saved revision of the take to name.",
            0,
          );
        }
        const body: ExportStartBody = { fileType, revision };
        starting += 1;
        let started: ExportStartAnswer | null = null;
        try {
          started = await answer<ExportStartAnswer>(
            await request("exportStart", {
              params: { id: takeId },
              json: body,
            }),
          );
          ownJobs.add(started.jobId);
        } finally {
          starting -= 1;
          // This job's held events, in the order they came; once no start
          // is waiting, the rest too, as the other windows' jobs they are.
          const jobId = started?.jobId;
          const replay = held.filter(
            (e) => e.jobId === jobId || starting === 0,
          );
          held = held.filter((e) => !replay.includes(e));
          for (const e of replay) onExport(e);
        }
        return { jobId: started.jobId };
      },
      onEvent(fn) {
        exportListeners.add(fn);
        return () => exportListeners.delete(fn);
      },
    },
    files: {
      async reveal(target) {
        if (target.kind !== "path") {
          throw new Error(
            "the studio shows a file by its path, not a download",
          );
        }
        await request("reveal", { json: { path: target.path } });
      },
    },
    nav: {
      editor: (id) => `/editor.html?scene=${encodeURIComponent(id)}`,
      library: () => "/",
      kits: () => "/settings.html",
      firstTakeHint: () => STUDIO_FIRST_TAKE_HINT,
      rerun: (id) => ({ kind: "line", text: refilmLine(id) }),
      onOpen(fn) {
        openListeners.add(fn);
      },
    },
  };
}

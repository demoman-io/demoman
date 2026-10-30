import { execFile } from "node:child_process";
import type { EventEmitter } from "node:events";
import { mkdir } from "node:fs/promises";
import { basename, join } from "node:path";
import {
  EXPORT_QUALITY_VALUES,
  type FileType,
  isExportQuality,
} from "@demoman/run-core";
import {
  createBrowserSession,
  createLibrary,
  createVideoStore,
  exportTake,
  fullChromiumPath,
  type Library,
  LibraryError,
  ownHome,
} from "@demoman/runner/studio";
import type {
  ExportStartAnswer,
  Refusal,
  StudioEvent,
  StudioReason,
  WindowAnswer,
} from "@demoman/studio-protocol";
import { createEventHub, type EventHub } from "./events.js";
import { messageOf, readIfPresent } from "./files.js";
import { createPageServer } from "./pages.js";
import {
  createExportQueue,
  type ExportQueue,
  type QueueRefusal,
  type RunExport,
} from "./queue.js";
import { createRoutes } from "./routes.js";
import { createRunExport } from "./run-export.js";
import {
  createStudioServer,
  type Handler,
  type StudioHandlers,
  type StudioResponse,
} from "./server.js";
import { BUILD_STAMP, checkPagesFresh } from "./stale.js";
import { removeStudioState, writeStudioState } from "./state-file.js";
import { createThumbs } from "./thumbs.js";
import { type HomeFeeds, watchHome } from "./watch.js";
import { createStudioWindow, type StudioWindow } from "./window.js";

const FILE_TYPES: readonly FileType[] = ["mp4", "gif", "stills"];

/** How long the no-window wait, deferred behind an open that then failed,
 *  waits again before stopping: time for that open's answer to reach its
 *  caller. */
const NO_WINDOW_GRACE_MS = 1_000;

/** Each refusal `start` can answer, with its status. */
const QUEUE_STATUS: Record<QueueRefusal["reason"], number> = {
  takeNotFound: 404,
  sceneNotSaved: 409,
  libraryUnreadable: 500,
};

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

/** The body as JSON; an empty body is `{}` (a window with no take). */
async function bodyOf(
  req: Parameters<Handler>[0],
): Promise<{ ok: true; value: unknown } | { ok: false; error: string }> {
  const text = (await req.body()).toString("utf8");
  if (text.trim() === "") return { ok: true, value: {} };
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (error) {
    return { ok: false, error: `the body is not JSON (${messageOf(error)})` };
  }
}

/**
 * The whole handler table (ruling R5): `createRoutes`' routes plus this
 * task's `window` and `exportStart`.
 */
export function buildHandlers(o: {
  home: string;
  library: Library;
  events: EventHub;
  feeds: HomeFeeds;
  log: (line: string) => void;
  version: string;
  queue: ExportQueue;
  window: Pick<StudioWindow, "open">;
  /** Told after each window that opened, so the lifetime knows. */
  onWindowOpened?: () => void;
  reveal?: (path: string) => Promise<void>;
  /** `createRoutes`' own: join and expire now, as the server starts. */
  upkeepOnStart?: boolean;
}): StudioHandlers {
  const { library } = o;
  const noTake = (id: string): StudioResponse =>
    refuse(404, "takeNotFound", `There is no take "${id}" in ${library.root}.`);

  /** Whether `id` is a take now; a library that will not read throws. */
  const exists = async (id: string): Promise<boolean> =>
    library.isTakeId(id) && (await library.getSceneRead(id)) !== null;

  const libraryRefusal = (error: unknown): StudioResponse => {
    if (error instanceof LibraryError) {
      return refuse(500, error.reason, `${error.message}.`);
    }
    throw error;
  };

  return {
    ...createRoutes({
      home: o.home,
      library,
      events: o.events,
      log: o.log,
      version: o.version,
      queued: () => o.queue.size(),
      feeds: o.feeds,
      thumbs: createThumbs({ library }),
      ...(o.reveal === undefined ? {} : { reveal: o.reveal }),
      upkeepOnStart: o.upkeepOnStart === true,
    }),

    async window(req) {
      const body = await bodyOf(req);
      if (!body.ok) {
        return refuse(
          400,
          "windowDidNotOpen",
          `No window was opened: ${body.error}.`,
        );
      }
      const takeId = (body.value as { takeId?: unknown } | null)?.takeId;
      if (takeId !== undefined && typeof takeId !== "string") {
        return refuse(
          400,
          "windowDidNotOpen",
          "No window was opened: takeId is not a string.",
        );
      }
      if (takeId !== undefined) {
        // An unknown take is refused; the library is not opened instead.
        try {
          if (!(await exists(takeId))) return noTake(takeId);
        } catch (error) {
          return libraryRefusal(error);
        }
      }
      const opened = await o.window.open(
        takeId === undefined ? {} : { takeId },
      );
      if (!("ok" in opened)) return json(500, opened);
      o.onWindowOpened?.();
      const answer: WindowAnswer = { path: opened.path };
      return json(200, answer);
    },

    async exportStart(req) {
      const id = req.params.id as string;
      if (!library.isTakeId(id)) return noTake(id);
      const body = await bodyOf(req);
      if (!body.ok) {
        return refuse(
          400,
          "invalidFileType",
          `Nothing was exported: ${body.error}.`,
        );
      }
      const { fileType, revision, quality } = (body.value ?? {}) as {
        fileType?: unknown;
        revision?: unknown;
        quality?: unknown;
      };
      if (!FILE_TYPES.includes(fileType as FileType)) {
        return refuse(
          400,
          "invalidFileType",
          `Nothing was exported: ${JSON.stringify(fileType) ?? "no file type"} is not mp4, gif or stills.`,
        );
      }
      if (quality !== undefined && !isExportQuality(quality)) {
        return refuse(
          400,
          "exportQualityInvalid",
          `Nothing was exported: ${JSON.stringify(quality)} is not ${EXPORT_QUALITY_VALUES.join(", ")}.`,
        );
      }
      // Only an MP4 has a quality: on a GIF or stills it would be ignored.
      if (quality !== undefined && fileType !== "mp4") {
        return refuse(
          400,
          "exportQualityInvalid",
          `Nothing was exported: only an MP4 has a quality, not ${fileType === "gif" ? "a GIF" : "stills"}.`,
        );
      }
      if (typeof revision !== "string" || revision === "") {
        return refuse(
          428,
          "sceneNotSaved",
          "The export carried no revision, so it could not be checked against the take on disk.",
        );
      }
      const started = await o.queue.start(id, {
        fileType: fileType as FileType,
        revision,
        ...(quality === undefined ? {} : { quality }),
      });
      if ("reason" in started) {
        return json(QUEUE_STATUS[started.reason], started);
      }
      const answer: ExportStartAnswer = started;
      return json(200, answer);
    },
  };
}

export interface ServeOptions {
  home: string;
  outDir: string;
  pagesDir: string;
  version: string;
  executablePath?: string;
  headless?: boolean;
  log: (line: string) => void;
  /** Tests: a window that is not a browser. */
  createWindow?: (w: {
    origin: string;
    /** A fresh entry URL: a single-use ticket, never the token (R12). */
    entryUrl: (takeId?: string) => string;
    events: EventHub;
    log: (line: string) => void;
  }) => StudioWindow;
  /** Tests: `process.exit` otherwise. */
  exit?: (code: number) => void;
  /** Tests: `process` otherwise (SIGTERM, SIGINT). */
  signals?: EventEmitter;
  /** How long the studio waits for its first window (30 s). */
  noWindowMs?: number;
  /** Tests: the export itself; `exportTake` in a headless browser of the
   *  studio's own otherwise. */
  run?: RunExport;
  /** Tests: a stand-in; `notifyOnMac` otherwise. */
  notify?: (title: string, body: string) => Promise<void>;
}

/** A macOS notification through `osascript`; the text travels as argv, so
 *  nothing in it is read as AppleScript. */
export function notifyOnMac(title: string, body: string): Promise<void> {
  if (process.platform !== "darwin") {
    return Promise.reject(new Error("notifications are shown on macOS only"));
  }
  return new Promise((resolve, reject) => {
    execFile(
      "osascript",
      [
        "-e",
        "on run argv",
        "-e",
        "display notification (item 2 of argv) with title (item 1 of argv)",
        "-e",
        "end run",
        title,
        body,
      ],
      (error, _stdout, stderr) => {
        if (error) {
          reject(new Error(stderr.trim() || error.message));
          return;
        }
        resolve();
      },
    );
  });
}

/** What a notification says for an export that ended; null for any other
 *  event. */
function endedSentence(e: StudioEvent): string | null {
  if (e.type !== "export") return null;
  if (e.phase === "failed") return e.detail;
  if (e.phase !== "saved") return null;
  const r = e.report;
  if (r.outcome !== "saved") return r.summary;
  return `Saved ${basename(r.fileType === "stills" ? r.folder.path : r.file.path)}`;
}

/** The build's sha, from `<pagesDir>/studio-build.json`, said either way. */
async function logBuild(
  pagesDir: string,
  log: (line: string) => void,
): Promise<void> {
  const path = join(pagesDir, BUILD_STAMP);
  try {
    const bytes = await readIfPresent(path);
    if (bytes === null) {
      log(`studio: no ${path}, so the pages' build is unknown`);
      return;
    }
    const stamp = JSON.parse(bytes.toString("utf8")) as {
      sha?: unknown;
      builtAt?: unknown;
    };
    log(
      `studio: pages built from ${String(stamp.sha)} at ${String(stamp.builtAt)}`,
    );
  } catch (error) {
    log(`studio: ${path} could not be read (${messageOf(error)})`);
  }
}

/**
 * `demoman studio --serve`: the detached studio process (spec §4.3). It
 * serves until its window has closed and its queue has drained, until no
 * window opened within `noWindowMs` of starting, or until SIGTERM/SIGINT.
 * Every way it ends removes `studio.json` and says why in the log.
 */
export async function runServe(o: ServeOptions): Promise<never> {
  const { home, log } = o;
  const exit = o.exit ?? ((code: number) => process.exit(code));
  const signals: EventEmitter = o.signals ?? process;
  const forever = new Promise<never>(() => {});

  // A dev checkout's pages older than their source would be a check of the
  // previous build (CLAUDE.md); the packaged pages are not checked.
  const fresh = checkPagesFresh(o.pagesDir);
  if (!fresh.ok) {
    log(`studio: refusing to start: ${fresh.reason}`);
    exit(1);
    return forever;
  }
  await logBuild(o.pagesDir, log);

  const library = createLibrary(home);
  const events = createEventHub({ log });
  try {
    // Owner-only, an older home included: takes show signed-in pages.
    await ownHome(home);
  } catch (error) {
    log(
      `studio: ${home} could not be made owner-only (${messageOf(error)}), so other users on this machine may read its takes`,
    );
  }
  try {
    // A fresh home has no takes/ yet, and a watch on a missing folder fails.
    await mkdir(join(home, "takes"), { recursive: true, mode: 0o700 });
  } catch (error) {
    // Not a crash: the watch below fails on the same folder and says so in
    // that feed's sentence.
    log(
      `studio: ${join(home, "takes")} could not be made (${messageOf(error)})`,
    );
  }
  const feeds = await watchHome({ home, events, log });
  // Assigned once the server has an origin; no request reaches a handler
  // before it does.
  let window: StudioWindow | null = null;
  const theWindow = (): StudioWindow => {
    if (window === null) throw new Error("the Studio window is not made yet");
    return window;
  };

  // Exports render headless, apart from the person's windows: a visible
  // work window could not be kept off screen (macOS Chrome pulls it back to
  // leave 40px showing; minimised throttles its timers 3.5x, 2026-10-23).
  // Launched on the first export and kept until the studio stops.
  const renderer = createBrowserSession({
    headless: true,
    // Left to itself, headless launches the headless shell, which draws in
    // software (`fullChromiumPath`).
    executablePath: o.executablePath ?? fullChromiumPath(),
    log,
  });
  const run: RunExport =
    o.run ??
    createRunExport({
      exportTake,
      deps: {
        library,
        videos: createVideoStore(home, library, { log }),
        session: renderer,
        home,
        wallpapersDir: join(o.pagesDir, "wallpapers"),
        outDir: o.outDir,
        log,
        door: "studio",
      },
    });
  let everOpened = false;
  let windowOpen = false;
  let stopping = false;
  const notify = o.notify ?? notifyOnMac;
  /** Notifications still on their way, awaited before the process exits. */
  const notices = new Set<Promise<void>>();
  /** An export that ends with no window open would otherwise be said only
   *  in studio.log; a notification that cannot show says so there. */
  const tellIfUnseen = (e: StudioEvent): void => {
    if (windowOpen) return;
    const sentence = endedSentence(e);
    if (sentence === null) return;
    const notice = notify("Demoman", sentence)
      .catch((error: unknown) => {
        log(
          `studio: an export ended with no window open, and its notification did not show (${messageOf(error)}): ${sentence}`,
        );
      })
      .finally(() => notices.delete(notice));
    notices.add(notice);
  };
  const queue = createExportQueue({
    library,
    events: {
      send: (e) => {
        events.send(e);
        tellIfUnseen(e);
      },
    },
    run,
    log,
  });
  /** Opens still in flight. A first Chrome launch can take longer than the
   *  no-window wait; the wait must not stop the studio underneath it. */
  let opening = 0;
  /** The no-window wait ran out while an open was in flight: decided again
   *  when the last one settles. */
  let noWindowDue = false;
  let graceTimer: ReturnType<typeof setTimeout> | null = null;

  const handlers = buildHandlers({
    home,
    library,
    events,
    feeds,
    log,
    version: o.version,
    queue,
    upkeepOnStart: true,
    window: {
      open: async (t) => {
        opening += 1;
        try {
          const opened = await theWindow().open(t);
          // Marked here as well as in onWindowOpened, so the deferred check
          // below already knows an open that worked.
          if ("ok" in opened) {
            everOpened = true;
            windowOpen = true;
          }
          return opened;
        } finally {
          opening -= 1;
          if (opening === 0 && noWindowDue) {
            noWindowDue = false;
            // Re-armed briefly, not decided now: a failed open's refusal is
            // still on its way to the caller, and stopping closes every
            // connection — the caller would read a hang-up, not the reason.
            graceTimer = setTimeout(
              noWindowCheck,
              Math.min(NO_WINDOW_GRACE_MS, o.noWindowMs ?? 30_000),
            );
            graceTimer.unref?.();
          }
        }
      },
    },
    onWindowOpened: () => {
      everOpened = true;
      windowOpen = true;
    },
  });

  let server: Awaited<ReturnType<typeof createStudioServer>>;
  try {
    server = await createStudioServer({
      handlers,
      pages: createPageServer({ dir: o.pagesDir }),
    });
  } catch (error) {
    log(`studio: could not listen: ${messageOf(error)}`);
    // As `stop` does: a watcher left open keeps the process alive.
    events.close();
    feeds.close();
    exit(1);
    return forever;
  }
  const studioServer = server;

  window = (o.createWindow ?? defaultWindow(o))({
    origin: studioServer.origin,
    entryUrl: (takeId) => studioServer.entryUrl(takeId),
    events,
    log,
  });

  const noWindowSeconds = Math.round((o.noWindowMs ?? 30_000) / 1000);
  /** The no-window wait's verdict: stop unless a window opened — or, while
   *  an open is still in flight, wait for it and decide when it settles. */
  function noWindowCheck(): void {
    if (everOpened || stopping) return;
    if (opening > 0) {
      if (!noWindowDue) {
        log(
          `studio: no window yet after ${noWindowSeconds} s, but one is still opening; waiting for it`,
        );
      }
      noWindowDue = true;
      return;
    }
    log(
      `studio: no window opened within ${noWindowSeconds} s of starting; stopping`,
    );
    void settle();
  }
  const noWindow = setTimeout(noWindowCheck, o.noWindowMs ?? 30_000);
  noWindow.unref?.();

  const onSignal = (name: string) => () => {
    const left = queue.size();
    log(
      left === 0
        ? `studio: ${name}; stopping`
        : `studio: ${name}; stopping with ${left} export${left === 1 ? "" : "s"} unfinished`,
    );
    void stop(0);
  };
  const onTerm = onSignal("SIGTERM");
  const onInt = onSignal("SIGINT");
  signals.on("SIGTERM", onTerm);
  signals.on("SIGINT", onInt);

  /** Ends the process: the pages are told, then the server, the browser
   *  and `studio.json` go. Each step that fails is said and the rest run. */
  async function stop(code: number): Promise<void> {
    if (stopping) return;
    stopping = true;
    clearTimeout(noWindow);
    if (graceTimer !== null) clearTimeout(graceTimer);
    signals.off("SIGTERM", onTerm);
    signals.off("SIGINT", onInt);
    events.send({ type: "server:stopping" });
    // Before server.close(): an open event stream otherwise holds the
    // server open, and its close never resolves.
    events.close();
    // A watcher left open keeps the process alive.
    feeds.close();
    try {
      await studioServer.close();
    } catch (error) {
      log(`studio: the server would not close cleanly (${messageOf(error)})`);
    }
    try {
      await theWindow().close();
    } catch (error) {
      log(`studio: the browser would not close cleanly (${messageOf(error)})`);
    }
    try {
      await renderer.close();
    } catch (error) {
      log(
        `studio: the render browser would not close cleanly (${messageOf(error)})`,
      );
    }
    try {
      await removeStudioState(home, process.pid);
    } catch (error) {
      log(`studio: studio.json could not be removed (${messageOf(error)})`);
    }
    await Promise.all(notices);
    exit(code);
  }

  /** Stops once no window is open and the queue is empty; with a queue,
   *  after it drains (and only if no window opened meanwhile). */
  async function settle(): Promise<void> {
    if (stopping || windowOpen) return;
    const left = queue.size();
    if (left > 0) {
      log(
        `studio: the window closed; finishing ${left} export${left === 1 ? "" : "s"} first`,
      );
      await queue.drained();
      if (stopping || windowOpen) return;
    }
    await stop(0);
  }

  window.onAllClosed(() => {
    windowOpen = false;
    log("studio: every studio window has closed");
    void settle();
  });

  try {
    await writeStudioState(home, {
      pid: process.pid,
      port: studioServer.port,
      token: studioServer.token,
      startedAt: new Date().toISOString(),
      version: o.version,
    });
  } catch (error) {
    log(`studio: could not write studio.json: ${messageOf(error)}`);
    await stop(1);
    return forever;
  }
  log(`studio: serving ${studioServer.origin} (pid ${process.pid})`);
  return forever;
}

const defaultWindow =
  (o: ServeOptions): NonNullable<ServeOptions["createWindow"]> =>
  (w) =>
    createStudioWindow({
      home: o.home,
      origin: w.origin,
      entryUrl: w.entryUrl,
      events: w.events,
      log: w.log,
      ...(o.executablePath === undefined
        ? {}
        : { executablePath: o.executablePath }),
      ...(o.headless === undefined ? {} : { headless: o.headless }),
    });

import type { CdpSession, Clock } from "@demoman/replay-engine";
import {
  type Browser,
  type BrowserContext,
  type CDPSession,
  chromium,
  type Page,
} from "playwright";

/**
 * What the browser context is created with — and deliberately **not** what
 * the engine emulates.
 *
 * This makes the same argument `apps/extension/test/helpers/cdp-playwright
 * .ts` makes for the browser-lane tests, restated for the runner: the
 * engine's own job is to call `Emulation.setDeviceMetricsOverride` at the
 * scene's viewport and `REPLAY_DPR`, and that call can only be proven to
 * matter if the numbers it sets disagree with whatever the numbers were
 * before it ran. If this context were created at the scene's own viewport
 * and DPR, a harvested keyframe would come back the right size — 3840x2400
 * for a 1280x800 scene at `REPLAY_DPR` 3 — regardless of whether the
 * override ever ran. Deleting `Emulation.setDeviceMetricsOverride` from the
 * engine would leave that assertion green, checked against a coincidence
 * rather than the override.
 *
 * So the context is created smaller and unscaled: 1024x640 at DPR 1, a size
 * no real scene in this repo uses. `launch.test.ts` pins both constants and
 * asserts `CONTEXT_DPR !== REPLAY_DPR`, so nobody can make this true by
 * accident either.
 */
export const CONTEXT_VIEWPORT = { width: 1024, height: 640 };
export const CONTEXT_DPR = 1;

export interface Launched {
  browser: Browser;
  context: BrowserContext;
  page: Page;
  cdp: CdpSession;
  clock: Clock;
  /** Ends the browser process. `crashed` is whether the browser was
   *  already disconnected when this ran — it did not shut down on
   *  request, it died or was killed mid-run — and is the caller's to turn
   *  into a line. Runner audit 2026-09-14, finding 2: this used to be a
   *  `console.warn` inside `close()`, which the pipeline's `finally`
   *  printed ABOVE the result it explains, and which an in-process caller
   *  never saw. */
  close(): Promise<CloseOutcome>;
}

export interface CloseOutcome {
  crashed: boolean;
}

/**
 * Adapts a Playwright CDP session to the engine's `CdpSession` port.
 *
 * Verbatim in shape to `apps/extension/test/helpers/cdp-playwright.ts`'s
 * `withReplayBrowser` — same three methods, same casts, same swallow on
 * `detach`. That file backs the engine's own browser-lane tests against a
 * Playwright session; this backs production. One adapter shape, two
 * transports (the other being `chrome.debugger` in the extension), so the
 * engine itself never needs to know which browser it is driving.
 */
function toCdpSession(session: CDPSession): CdpSession {
  return {
    send: (method, params) =>
      session.send(method as never, params as never) as Promise<
        Record<string, unknown>
      >,
    on: (event, handler) => {
      const wrapped = (params: unknown): void =>
        handler((params ?? {}) as Record<string, unknown>);
      session.on(event as never, wrapped as never);
      return () => session.off(event as never, wrapped as never);
    },
    detach: async () => {
      // The whole browser is about to go away with it (launch()'s close()
      // calls browser.close(), which tears every session down regardless).
      // A session that cannot be told to detach cleanly first — the
      // debugger connection already gone, say — has lost nothing a caller
      // needs: the goal ("this session is no longer attached to anything")
      // is achieved either way. Swallowing this one is the codebase's own
      // worked example (see cdp-playwright.ts).
      await session.detach().catch(() => undefined);
    },
  };
}

/**
 * A fresh CDP session on `page`, as the engine's port: what `launch` gives
 * its first page, for a page opened later in the same context (the CLI
 * executor opens one per call — `executor/browser.ts`'s `stage()`).
 */
export async function openCdpSession(
  context: BrowserContext,
  page: Page,
): Promise<CdpSession> {
  return toCdpSession(await context.newCDPSession(page));
}

/**
 * Node's clock: no worker, no throttle-avoidance, just the real timers.
 *
 * `@demoman/replay-engine`'s `createWorkerClock` (in `apps/extension`) exists
 * because Chrome throttles a *hidden tab's* main-thread timers to 1/s (and
 * to 1/min after five minutes), which turned a 240-700ms cursor segment
 * into 30-88s while the editor tab sat behind another window. This process
 * is a headless Node CLI: there is no tab, no visibility state, and no such
 * throttle on `setTimeout` here. A plain `Date.now()`/`setTimeout` clock is
 * the correct answer for this port, not a stand-in for the worker clock —
 * so nobody "fixes" this later by porting the worker machinery over, this
 * comment is the reason not to.
 */
function nodeClock(): Clock {
  return {
    now: () => Date.now(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  };
}

/** A screen's size in CSS pixels and its device pixel ratio. */
export interface Display {
  width: number;
  height: number;
  scale: number;
}

/** The flags that put a headless Chrome on `display`: `--screen-info` takes
 *  the size in device pixels. */
export function displayArgs(display: Display): string[] {
  const w = Math.round(display.width * display.scale);
  const h = Math.round(display.height * display.scale);
  return [
    `--screen-info={${w}x${h} devicePixelRatio=${display.scale}}`,
    `--window-size=${display.width},${display.height}`,
  ];
}

/** The browser's own user agent with `HeadlessChrome` said as `Chrome`. */
async function visibleUserAgent(browser: Browser): Promise<string> {
  const session = await browser.newBrowserCDPSession();
  try {
    const { userAgent } = (await session.send("Browser.getVersion")) as {
      userAgent: string;
    };
    return userAgent.replace("HeadlessChrome/", "Chrome/");
  } finally {
    await session.detach();
  }
}

/**
 * The visible user agent for the context, or none when it cannot be read: it
 * only renames `HeadlessChrome`, so a failure keeps the browser's own and
 * the launch goes on, said in the log.
 */
async function visibleUserAgentOr(
  browser: Browser,
  read: (browser: Browser) => Promise<string>,
  log: ((line: string) => void) | undefined,
): Promise<{ userAgent?: string }> {
  try {
    return { userAgent: await read(browser) };
  } catch (error) {
    log?.(
      `the browser's user agent could not be read (${error instanceof Error ? error.message : String(error)}); pages see its own, which says HeadlessChrome`,
    );
    return {};
  }
}

/**
 * Launches a real Chromium, wires up the two ports the replay engine cannot
 * get from Node itself (`CdpSession`, `Clock`), and hands both back next to
 * the `Page` the engine will drive. Task 8+ supply the remaining three
 * ports (`PageAgent`, `EngineStore`, the navigating/occlusion guards) on top
 * of what this returns.
 *
 * `options.headless` defaults to Playwright's own default (headless) — the
 * override exists for a developer watching a run locally, not for
 * production, which is why it is optional and unused unless asked for.
 *
 * Launches with `chromium.launch()`, never `launchServer()`: a browser
 * server listens on loopback, answers `GET /json` with its secret path to
 * anyone, and hands browser-level CDP — every saved sign-in's cookies,
 * `file://` reads — to any local peer that connects (audit run 1).
 *
 * `launchServer()` was chosen once for `BrowserServer.close()`'s guarantee
 * to end the OS process. Measured directly (a real crash reproducing Task
 * 6's ~70-large-frame page.evaluate boundary): after that crash, a client's
 * `browser.close()` resolves in 1-2ms while the Chromium OS process is still
 * alive, and Node's transport to it — a `ChildProcess` plus its stdio
 * `Socket`s — keeps the event loop alive, so a Node process with nothing
 * left to do never exits and reports nothing. `endBrowser` keeps that
 * guarantee itself: a bounded `browser.close()`, then SIGKILL to the
 * process group of whatever is still running, waited for. Playwright's
 * `Browser` has no `process()`, so the pid is the browser's own answer, over
 * the pipe Playwright already holds.
 */
export async function launch(options?: {
  headless?: boolean;
  /** Tests only: a path that does not exist reaches `browserMissing`. */
  executablePath?: string;
  /**
   * Headless only: the display a visible window would have been on. Chrome
   * is told it is there (`--screen-info`), so `screen` reads its size and the
   * screencast films motion at its scale, as a visible window does — without
   * it a headless screencast films at 1x (measured 2026-10-20: 1280x800
   * spans against 2560x1600 with it, both 60 fps). The page also gets the
   * user agent string a visible Chrome sends, not `HeadlessChrome` (its
   * client hints already name "Chromium" either way: measured 2026-10-21,
   * and held by launch.test.ts). Without it, headless keeps the fixed
   * viewport the runner's lanes measure.
   */
  display?: Display;
  /** Where a launch that went on past a cosmetic failure says so. */
  log?: (line: string) => void;
  /** Tests only: stands in for reading the browser's user agent. */
  userAgentOf?: (browser: Browser) => Promise<string>;
}): Promise<Launched> {
  const headless = options?.headless ?? true;
  const display = headless ? options?.display : undefined;
  const browser = await chromium.launch({
    headless,
    ...(options?.executablePath === undefined
      ? {}
      : { executablePath: options.executablePath }),
    ...(display === undefined ? {} : { args: displayArgs(display) }),
  });
  let pid: number | null = null;
  try {
    pid = await browserPid(browser);
    // Headed: no viewport emulation, so a page is the size of its window
    // and a new page does not open a window at 1024x640 (parked R12, plan
    // 2 Task 5). The engine's own metrics override still sets the filmed
    // size. Headless keeps the fixed viewport the runner's lanes measure,
    // unless it was given a display to stand in for.
    const context = await browser.newContext(
      display !== undefined
        ? {
            viewport: null,
            ...(await visibleUserAgentOr(
              browser,
              options?.userAgentOf ?? visibleUserAgent,
              options?.log,
            )),
          }
        : headless
          ? { viewport: CONTEXT_VIEWPORT, deviceScaleFactor: CONTEXT_DPR }
          : { viewport: null },
    );
    const page = await context.newPage();
    const session = await context.newCDPSession(page);
    const cdp = toCdpSession(session);
    const clock = nodeClock();

    let closed = false;
    return {
      browser,
      context,
      page,
      cdp,
      clock,
      async close() {
        // Idempotent: a caller that already closed once (or a `finally`
        // that runs after an earlier explicit close) gets a plain no-op,
        // not a second warning about a state it already knows about.
        if (closed) return { crashed: false };
        closed = true;

        // Checked BEFORE closing anything, not after: both close calls
        // below are safe on a browser that is already gone (measured),
        // so checking afterward would just report the outcome closing
        // itself produced, and this branch would never see the crash —
        // it would see its own successful shutdown instead.
        const alreadyDead = !browser.isConnected();

        // Ends the OS process either way — see the module docblock for
        // the measurement this depends on.
        await endBrowser(browser, pid, options?.log);

        // This is the failure path CLAUDE.md's "report before you
        // forgive" rule is about: a browser that crashed mid-run and a
        // browser that closed cleanly must not produce the same
        // observable outcome from close(). The return value is the
        // channel; `runPipeline` turns `crashed: true` into a note that
        // prints under the run's own sentence. (Task 6's report has the
        // known ~70-large-frame page.evaluate crossing that reproduces
        // it.)
        return { crashed: alreadyDead };
      },
    };
  } catch (error) {
    // Setup after the launch (context, page, or CDP session creation)
    // failed. The process must not leak: without this, every failed
    // launch would leave a live Chromium behind, one per attempt. If
    // ending it *also* fails here, that failure is not this catch's to
    // report — `error` below already is the real, caller-visible failure,
    // and a secondary teardown error piled on top would only bury it.
    await endBrowser(browser, pid, options?.log).catch(() => undefined);
    throw error;
  }
}

/** How long a graceful `browser.close()` gets before the process is killed. */
const CLOSE_GRACE_MS = 5_000;
/** How long a killed browser may take to be gone. */
const KILL_WAIT_MS = 5_000;

/** The browser's OS pid, from the browser itself. */
async function browserPid(browser: Browser): Promise<number> {
  const session = await browser.newBrowserCDPSession();
  try {
    const { processInfo } = await session.send("SystemInfo.getProcessInfo");
    const own = processInfo.find((p) => p.type === "browser");
    if (own === undefined) throw new Error("the browser named no process");
    return own.id;
  } finally {
    await session.detach();
  }
}

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/**
 * Ends the browser and its OS process, crashed or not. The graceful close
 * is best-effort and bounded: a crashed browser's resolves at once with the
 * process still alive, and a hung one may never resolve. Whatever is left
 * is killed with its process group (Playwright starts Chromium detached, as
 * a group leader, so the renderers go with it), and its end is awaited.
 */
async function endBrowser(
  browser: Browser,
  pid: number | null,
  log: ((line: string) => void) | undefined,
): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  await Promise.race([
    browser.close().catch(() => undefined),
    new Promise((resolve) => {
      timer = setTimeout(resolve, CLOSE_GRACE_MS);
    }),
  ]);
  clearTimeout(timer);
  if (pid === null || !alive(pid)) return;
  if (!killBrowser(pid, log)) return;
  const deadline = Date.now() + KILL_WAIT_MS;
  while (alive(pid)) {
    if (Date.now() >= deadline) {
      log?.(`the browser (pid ${pid}) was still running after SIGKILL`);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/**
 * SIGKILLs the browser's process group, else the process itself. False when
 * it is already gone: it may exit between the `alive` check and the kill,
 * and that is the end being waited for, not a failed close.
 */
export function killBrowser(
  pid: number,
  log: ((line: string) => void) | undefined,
  kill: (pid: number, signal: NodeJS.Signals) => void = process.kill,
): boolean {
  try {
    kill(-pid, "SIGKILL");
    return true;
  } catch {
    // Not a group leader (or Windows): the process itself, at least.
  }
  try {
    kill(pid, "SIGKILL");
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    log?.(`the browser (pid ${pid}) could not be killed (${String(error)})`);
    return false;
  }
}

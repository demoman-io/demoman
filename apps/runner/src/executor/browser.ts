// apps/runner/src/executor/browser.ts
import {
  type CdpSession,
  type Clock,
  withAnswerDeadline,
} from "@demoman/replay-engine";
import { type BrowserContext, chromium, type Page } from "playwright";
import { type DisplayUnread, displayUnreadSentence } from "../display.js";
import {
  chromiumDepsCommand,
  chromiumInstallCommand,
  loadedPlaywrightVersion,
  type PlaywrightVersion,
} from "../install-advice.js";
import {
  type Display,
  type Launched,
  launch,
  openCdpSession,
} from "../launch.js";
import { recorderPlatform } from "../platform.js";
import { messageOf } from "../report.js";
import { readScreen } from "./page-ops.js";

export type BrowserFailure = {
  ok: false;
  reason: "browserMissing" | "windowDidNotOpen" | "unsupportedPlatform";
  detail: string;
};

/**
 * What a failed launch said, read once for setup and `classifyLaunchError`:
 * a missing library is the dynamic linker's line from the browser log (or,
 * for Playwright's own executable, its host check's), never Playwright's
 * first line, which says only that the browser closed. Anything else is
 * that first line.
 */
export function launchFailure(said: string): {
  missingLibraries: boolean;
  line: string;
} {
  const lines = said
    .split("\n")
    .map((l) => l.replace(/^[\s║]+|[\s║]+$/g, ""))
    .filter((l) => l !== "");
  for (const l of lines) {
    const linker = /error while loading shared libraries:.*/i.exec(l);
    if (linker !== null) return { missingLibraries: true, line: linker[0] };
  }
  const host = lines.find((l) =>
    /Host system is missing dependencies/i.test(l),
  );
  if (host !== undefined) return { missingLibraries: true, line: host };
  return {
    missingLibraries: false,
    line: lines[0] ?? "it failed and said nothing",
  };
}

/**
 * Playwright's missing-browser error says "Executable doesn't exist at …".
 * On Linux, missing system libraries say "Host system is missing
 * dependencies" only for Playwright's own executable; a named one (every
 * production launch, `fullChromiumPath`) skips that check, and the dynamic
 * linker's "error while loading shared libraries" arrives in the browser
 * log instead. Those are the launch failures the author fixes with a
 * command, so they get their own reason. Every other launch
 * failure is said in Playwright's words. `installCommand`, the published
 * package's setup command, answers a missing Chromium only: setup cannot
 * install libraries without root.
 */
export function classifyLaunchError(
  error: unknown,
  playwright: PlaywrightVersion = loadedPlaywrightVersion(),
  installCommand?: string,
): BrowserFailure & { reason: "browserMissing" | "windowDidNotOpen" } {
  const said = messageOf(error);
  const read = launchFailure(said);
  if (read.missingLibraries) {
    const lib = /shared libraries: ([^:\s]+)/i.exec(read.line);
    const missing = `Chromium's system libraries are missing${lib === null ? "" : ` (${lib[1]})`}`;
    const deps = chromiumDepsCommand();
    return {
      ok: false,
      reason: "browserMissing",
      detail: deps.ok
        ? `${missing} — run \`sudo ${[deps.command, ...deps.args].join(" ")}\` once, then call this again`
        : `${missing}, and Demoman cannot name the command that installs them (${deps.why}): ${said}`,
    };
  }
  if (/Executable doesn't exist/i.test(said)) {
    if (installCommand !== undefined) {
      return {
        ok: false,
        reason: "browserMissing",
        detail: `Demoman's browser is not installed — run \`${installCommand}\` once, then call this again`,
      };
    }
    const install = chromiumInstallCommand(playwright);
    return {
      ok: false,
      reason: "browserMissing",
      detail: install.ok
        ? `Demoman's browser is not installed — run \`${install.command}\` once, then call this again`
        : `Demoman's browser is not installed, and ${install.detail}: ${said}`,
    };
  }
  return {
    ok: false,
    reason: "windowDidNotOpen",
    detail: `the browser would not launch: ${said}`,
  };
}

/**
 * The page one call drives, and the CDP session attached to it. Never shared
 * with an earlier call: see `BrowserSession.stage`.
 */
export interface Stage {
  context: BrowserContext;
  page: Page;
  cdp: CdpSession;
  clock: Clock;
}

export type WorkWindow = "tab" | "background" | "minimized";
/** Set from apps/runner/scripts/probe-windows.mjs, run 2026-10-12:
 *    work: tab export 5.5 s (1.00x the tab)
 *    work: background export 5.3 s (0.97x the tab)
 *    work: minimized export 13.1 s (2.41x the tab)
 *  Rule: the first of minimized/background that renders within 1.5x of a
 *  tab, else tab. */
export const DEFAULT_WORK_WINDOW: WorkWindow = "background";

export interface BrowserSession {
  /** The live browser, launching or relaunching it as needed. */
  ensure(): Promise<{ ok: true; launched: Launched } | BrowserFailure>;
  /**
   * A page for one call (a snapshot, a run) that carries nothing from any
   * earlier call: the live browser's first page if no call has had it yet,
   * else a new page in the same context, opened BEFORE the previous call's
   * page is closed so a visible window stays up between calls.
   *
   * Why a page and not a reset (final review 2026-10-12, Critical 1): the
   * engine puts state on the page's target that nothing takes off —
   * `applyDevice`'s metrics, touch, mouse-as-touch and user agent, and the
   * occlusion guard's heartbeat script (`Page.addScriptToEvaluateOnNewDocument`)
   * and binding listener, once per call. On one reused page a desktop
   * snapshot after a phone one saw the iPhone user agent, and N calls ran N
   * heartbeat loops. All of that lives on the target and its CDP session,
   * so a new target with a new session starts clean, and a reset that has
   * to name every override (and grows a hole with each one added) is not
   * needed. The resolver and the executor's entry are on the CONTEXT
   * (`context.addInitScript`, `onLaunched`), so every page has them.
   */
  stage(): Promise<{ ok: true; stage: Stage } | BrowserFailure>;
  /**
   * Before a call loads sessions into the shared context: every page no call
   * owns — one a recorded page opened, a pop-out, a tab — is closed, and the
   * previous call's page is sent to about:blank, which stops its scripts and
   * keeps a visible window up until `stage()` replaces it. Without this, a
   * page from one account's call kept running while the next account's
   * sessions loaded, and the run's write-back saved what it wrote under the
   * wrong account (audit run 1). Work pages are left alone. A page that will
   * not close or blank is said in the log.
   */
  retire(): Promise<void>;
  /** A page for encoding or rendering: never the stage, never the author's
   *  view. Headless always opens a tab. Closing it is the caller's.
   *  `relaunch` (default true) lets a dead or author-closed browser be
   *  replaced first; `false` uses the live connected browser as it is, even
   *  with the author's page closed, and answers windowDidNotOpen if there is
   *  none (the mux must not relaunch Chrome just to encode). */
  openWorkPage(options?: {
    relaunch?: boolean;
  }): Promise<{ ok: true; page: Page } | BrowserFailure>;
  /**
   * True once the page the latest call is using (`stage`'s, else the
   * launch's) has closed by something other than this session — the author
   * closing its window. A page or browser this session closed itself, or one
   * that failed preparation, never sets it.
   */
  closedSinceEnsure(): boolean;
  /** Whether a browser is up right now. */
  running(): boolean;
  /** `browser.version()` of the live browser, else null. */
  version(): string | null;
  /**
   * Why the page's `screen` is not this computer's: headless could not read
   * the display it stands in for, so the page sees Chrome's own stand-in. A
   * size taken from that screen would be reported as the author's; callers
   * film at the window instead and report this. Null when the screen is
   * real, or before any launch.
   */
  screenUnknown(): string | null;
  /**
   * The scale the live browser films motion at, as its launch decided it
   * (`meta.capture.displayScale`): headless, the display it stands in for,
   * else 1 (an unplaced headless screencast films at 1x). Null for a visible
   * window, whose scale is the OS's and never read here, and before any
   * launch.
   */
  filmScale(): number | null;
  /**
   * The screen `page` is on, as a run or a snapshot chooses its size from:
   * the page's own `screen`, or, when that is Chrome's stand-in for a
   * display headless could not read, the reason (`screenUnknown`) instead,
   * so no caller reports the stand-in as the author's. Undefined when the
   * page could not answer (said in the log).
   */
  screen(
    page: Page,
  ): Promise<{ width: number; height: number } | { error: string } | undefined>;
  /** Whether this session's browser is headless: no window anyone can see,
   *  so a page that goes away was not closed by a person. */
  readonly headless: boolean;
  /** Terminal: closes any browser, including one still launching. */
  close(): Promise<void>;
}

/**
 * The full Chromium this Playwright installs, which is what `npx demoman
 * setup` installs and the published package launches. Named in headless too:
 * left to itself, headless Playwright launches its headless shell, which
 * draws in software — an export there took 44.1 s against 4.7 s on this
 * Chromium (measured 2026-10-20).
 */
export function fullChromiumPath(): string {
  return chromium.executablePath();
}

/**
 * One Chromium per executor, launched on the first call that needs a page,
 * reused after, and relaunched when the author closed its window (with
 * `--headed`). Headless stands in for this computer's display when
 * `readDisplay` is given, so it films motion at the display's scale as a
 * visible window does; without one, a headless screencast films at 1x
 * (measured 2026-09-21, and again 2026-10-20).
 *
 * `close()` is terminal: after it, `ensure()` answers windowDidNotOpen and
 * launches nothing, so an executor that is shutting down cannot leave a
 * browser behind. A launch still in flight when `close()` runs is closed as
 * soon as it finishes, and `close()` waits for that.
 */
export function createBrowserSession(options: {
  headless: boolean;
  executablePath?: string;
  log: (line: string) => void;
  /** Named by `browserMissing` instead of the default advice: the published
   *  package's own setup command (launch B). */
  installCommand?: string;
  onLaunched?: (launched: Launched) => Promise<void>;
  launchFn?: typeof launch;
  workWindow?: WorkWindow;
  /** The stage session's per-call deadline; `ANSWER_DEADLINE_MS` unless a
   *  test needs a hang said sooner. */
  answerDeadlineMs?: number;
  /** Headless only: where the display a visible window would have used comes
   *  from (`readDisplay` in production). Read on every launch: a laptop
   *  docked or undocked between two launches is on another screen, and a
   *  relaunch after a crash films at the one it is on now. A read that
   *  throws counts as one that failed. Absent, headless launches with no
   *  display, as the runner's lanes measure it. */
  readDisplay?: () => Promise<Display | DisplayUnread>;
  /** The machine this records on; `process` unless a test stands in. */
  host?: { platform: string; arch: string };
}): BrowserSession {
  const launchFn = options.launchFn ?? launch;
  const workWindow = options.workWindow ?? DEFAULT_WORK_WINDOW;
  let live: Launched | null = null;
  /** The page the latest call uses, and whether a call has had it yet. The
   *  launch's own page starts untaken; `stage()` takes it once. */
  let current: { page: Page; cdp: CdpSession; taken: boolean } | null = null;
  /** Pages `openWorkPage` handed out and their callers have not closed. */
  const workPages = new Set<Page>();
  const working = (page: Page): { ok: true; page: Page } => {
    workPages.add(page);
    page.on("close", () => workPages.delete(page));
    return { ok: true, page };
  };
  let pageClosed = false;
  /** The browser context's id, read off the launch page while it is open. */
  let contextId: string | null = null;
  let closed = false;
  let starting: Promise<
    { ok: true; launched: Launched } | BrowserFailure
  > | null = null;
  let screenUnknown: string | null = null;
  let filmScale: number | null = null;

  /** The display this launch stands in for, or why there is none. Never
   *  throws: a read that throws is a read that failed, and says what threw. */
  async function readDisplayNow(
    read: () => Promise<Display | DisplayUnread>,
  ): Promise<Display | DisplayUnread> {
    try {
      return await read();
    } catch (error) {
      return { failed: messageOf(error) };
    }
  }

  const SESSION_CLOSED: BrowserFailure = {
    ok: false,
    reason: "windowDidNotOpen",
    detail: "the browser session is closed; the executor is shutting down",
  };

  /** Closes a browser this session no longer wants, saying why if it fails. */
  async function closeUnwanted(launched: Launched, why: string): Promise<void> {
    try {
      await launched.close();
    } catch (error) {
      options.log(`${why} would not close cleanly (${messageOf(error)})`);
    }
  }

  async function start(): Promise<
    { ok: true; launched: Launched } | BrowserFailure
  > {
    const host = options.host ?? process;
    const platform = recorderPlatform(host.platform, host.arch);
    if (!platform.ok) {
      options.log(`${platform.reason} — ${platform.detail}`);
      return { ok: false, reason: platform.reason, detail: platform.detail };
    }
    let launched: Launched;
    let display: Display | undefined;
    if (options.headless && options.readDisplay !== undefined) {
      const read = await readDisplayNow(options.readDisplay);
      if ("failed" in read) {
        // Headless still films, at Chrome's stand-in screen and a 1x
        // screencast. Said here when the reason is new, and on every size
        // the snapshot and run report (`screenUnknown`), so the film's size
        // and scale have their reason.
        const why = displayUnreadSentence(read, "recorded");
        if (why !== screenUnknown) options.log(why);
        screenUnknown = why;
      } else {
        display = read;
        screenUnknown = null;
      }
    }
    try {
      launched = await launchFn({
        headless: options.headless,
        log: options.log,
        ...(display === undefined ? {} : { display }),
        ...(options.executablePath === undefined
          ? {}
          : { executablePath: options.executablePath }),
      });
    } catch (error) {
      const failure = classifyLaunchError(
        error,
        undefined,
        options.installCommand,
      );
      options.log(`${failure.reason} — ${failure.detail}`);
      return failure;
    }
    if (options.onLaunched !== undefined) {
      try {
        await options.onLaunched(launched);
      } catch (error) {
        await closeUnwanted(launched, "the unprepared browser");
        return {
          ok: false,
          reason: "windowDidNotOpen",
          detail: `the browser opened but Demoman could not prepare its page: ${messageOf(error)}`,
        };
      }
    }
    if (closed) {
      // close() ran while this launch was in flight: it must not go live.
      await closeUnwanted(launched, "the browser that finished after close()");
      return SESSION_CLOSED;
    }
    contextId = null;
    if (!options.headless) {
      try {
        const { targetInfo } = (await launched.cdp.send(
          "Target.getTargetInfo",
          {},
        )) as { targetInfo: { browserContextId: string } };
        contextId = targetInfo.browserContextId;
      } catch (error) {
        options.log(
          `the browser context's id could not be read (${messageOf(error)}); work windows cannot open apart from the stage`,
        );
      }
    }
    live = launched;
    filmScale = options.headless ? (display?.scale ?? 1) : null;
    pageClosed = false;
    current = { page: launched.page, cdp: launched.cdp, taken: false };
    watch(launched, launched.page);
    return { ok: true, launched };
  }

  /**
   * Takes Playwright's own viewport off a page a call is about to use.
   *
   * The context is created at `CONTEXT_VIEWPORT` (launch.ts), and Playwright
   * puts that on every page as a metrics override that also fakes
   * `window.screen` at 1024x640. A run with no viewport films at the screen's
   * size (`chooseRunSize`), so on a page still carrying it every such run
   * filmed 1024x640 and reported it as `from: "screen"`. Until each call got
   * its own page this was hidden after the first call: the engine's own
   * override, left behind by the call before, had already replaced it. Thrown,
   * never forgiven: a page that keeps it films a size nobody chose.
   *
   * An override of zeros (no size, no scale, no screen), not
   * `clearDeviceMetricsOverride`: overrides are per CDP session and the
   * latest one set wins, so a clear from this session removes only this
   * session's own and left Playwright's 1024x640 screen in place (measured,
   * 2026-10-12). The zeros win the same way the engine's own override does,
   * and the engine's, sent later on this same session, replaces them.
   */
  async function dropContextViewport(cdp: CdpSession): Promise<void> {
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width: 0,
      height: 0,
      deviceScaleFactor: 0,
      mobile: false,
    });
  }

  /** A visible stage fills the screen it films: maximized, the window the
   *  author watches. Cosmetic, so a refusal is said and the call goes on. */
  async function placeStage(cdp: CdpSession): Promise<void> {
    if (options.headless) return;
    try {
      const { windowId } = (await cdp.send(
        "Browser.getWindowForTarget",
        {},
      )) as { windowId: number };
      await cdp.send("Browser.setWindowBounds", {
        windowId,
        bounds: { windowState: "maximized" },
      });
    } catch (error) {
      options.log(
        `the browser window could not be maximized (${messageOf(error)}); this call's window keeps its size`,
      );
    }
  }

  async function openWorkPage(
    workOptions: { relaunch?: boolean } = {},
  ): Promise<{ ok: true; page: Page } | BrowserFailure> {
    let launched: Launched;
    if (workOptions.relaunch === false) {
      // The mux after a run: the author may have closed the window mid-run,
      // and the surviving context is still good for encoding. Relaunching a
      // browser just to encode would open a second window for nothing.
      if (closed) return SESSION_CLOSED;
      if (live === null || !live.browser.isConnected()) {
        return {
          ok: false,
          reason: "windowDidNotOpen",
          detail: "the browser was gone before it could be encoded",
        };
      }
      launched = live;
    } else {
      const got = await ensure();
      if (!got.ok) return got;
      launched = got.launched;
    }
    const failed = (error: unknown): BrowserFailure => ({
      ok: false,
      reason: "windowDidNotOpen",
      detail: `the browser would not open a page to encode or render in: ${messageOf(error)}`,
    });
    if (options.headless || workWindow === "tab") {
      try {
        return working(await launched.context.newPage());
      } catch (error) {
        return failed(error);
      }
    }
    // Its own window, opened behind the stage and in the stage's browser
    // context (so the resolver and entry init scripts are there too): the
    // mux and the render never take the author's view, and the stage's
    // window never loses its tab.
    try {
      // The context id was read off the launch page while it was open
      // (`start`): the stage page may be gone by now (the author closed it),
      // and a closed page's session cannot answer.
      if (contextId === null) {
        throw new Error(
          "the browser context's id was never read at launch, so a window cannot be opened in it",
        );
      }
      const browserCdp = await launched.browser.newBrowserCDPSession();
      try {
        const opened = launched.context.waitForEvent("page", {
          timeout: 10_000,
        });
        // Created before createTarget so the event cannot be missed; if
        // createTarget fails nothing awaits it, and its later rejection
        // would be unhandled and kill the process. This handler is what
        // consumes it, and says it.
        let created = false;
        opened.catch((late: unknown) => {
          if (!created) {
            options.log(
              `no work window opened after the browser refused it (${messageOf(late)})`,
            );
          }
        });
        await browserCdp.send("Target.createTarget", {
          url: "about:blank",
          newWindow: true,
          background: true,
          browserContextId: contextId,
        });
        created = true;
        const page = await opened;
        if (workWindow === "minimized") {
          // Cosmetic, like maximizing: a window that stays open behind the
          // stage is still a page to work in.
          let cdp: CdpSession | null = null;
          try {
            cdp = await openCdpSession(launched.context, page);
            const { windowId } = (await cdp.send(
              "Browser.getWindowForTarget",
              {},
            )) as { windowId: number };
            await cdp.send("Browser.setWindowBounds", {
              windowId,
              bounds: { windowState: "minimized" },
            });
          } catch (error) {
            options.log(
              `the work window could not be minimized (${messageOf(error)}); it stays open behind the stage`,
            );
          }
          if (cdp !== null) {
            await cdp.detach().catch((error: unknown) => {
              options.log(
                `the work window's session would not detach (${messageOf(error)})`,
              );
            });
          }
        }
        return working(page);
      } finally {
        await browserCdp.detach().catch((error: unknown) => {
          options.log(
            `the browser-level session for the work window would not detach (${messageOf(error)})`,
          );
        });
      }
    } catch (error) {
      return failed(error);
    }
  }

  /** Only a browser that is live may set the flag, and only for the page the
   *  latest call uses: a page this session replaced is closed by `stage()`
   *  after `current` has moved on, so its close is not the author's. */
  function watch(launched: Launched, page: Page): void {
    page.on("close", () => {
      if (live === launched && current?.page === page) pageClosed = true;
    });
  }

  async function ensure(): Promise<
    { ok: true; launched: Launched } | BrowserFailure
  > {
    if (closed) return SESSION_CLOSED;
    if (live !== null && (pageClosed || !live.browser.isConnected())) {
      const was = live;
      live = null;
      current = null;
      pageClosed = false;
      try {
        const { crashed } = await was.close();
        options.log(
          crashed
            ? "the browser had died; starting a new one"
            : options.headless
              ? "the headless browser's page closed; starting a new one"
              : "the browser window was closed; starting a new one",
        );
      } catch (error) {
        options.log(
          `the previous browser would not close cleanly (${messageOf(error)}); starting a new one`,
        );
      }
      // close() may have run while the old browser was closing: it is
      // terminal, so no launch may start after it (T7 ledger).
      if (closed) return SESSION_CLOSED;
    }
    if (live !== null) return { ok: true, launched: live };
    starting ??= start().finally(() => {
      starting = null;
    });
    return starting;
  }

  return {
    ensure,
    openWorkPage,
    async retire() {
      const launched = live;
      if (launched === null) return;
      for (const page of launched.context.pages()) {
        if (workPages.has(page)) continue;
        if (page === current?.page) {
          // The launch's own page before any call is nobody's yet.
          if (!current.taken) continue;
          await page.goto("about:blank").catch((error: unknown) => {
            options.log(
              `the previous call's page would not stop (${messageOf(error)}); it may still be running as the next call's sessions load`,
            );
          });
          continue;
        }
        await page.close().catch((error: unknown) => {
          options.log(
            `a page an earlier call's site opened would not close (${messageOf(error)}); it may still be running as the next call's sessions load`,
          );
        });
      }
    },
    async stage() {
      const got = await ensure();
      if (!got.ok) return got;
      const launched = got.launched;
      // Every call on the stage has a deadline, not just the walk's own:
      // the guard's navigation, the snapshot's reads and the run's
      // navigation watch all go out on this session, and one the browser
      // never answers held the executor's single slot for good (review
      // 2026-10-13, #3).
      const stageOf = (page: Page, cdp: CdpSession): Stage => ({
        context: launched.context,
        page,
        cdp: withAnswerDeadline(cdp, options.answerDeadlineMs).cdp,
        clock: launched.clock,
      });
      const was = current;
      if (was !== null && !was.taken) {
        was.taken = true;
        try {
          await dropContextViewport(was.cdp);
        } catch (error) {
          return {
            ok: false,
            reason: "windowDidNotOpen",
            detail: `the browser would not let Demoman size its page: ${messageOf(error)}`,
          };
        }
        await placeStage(was.cdp);
        return { ok: true, stage: stageOf(was.page, was.cdp) };
      }
      let page: Page | null = null;
      let cdp: CdpSession;
      try {
        page = await launched.context.newPage();
        cdp = await openCdpSession(launched.context, page);
        await dropContextViewport(cdp);
        await placeStage(cdp);
      } catch (error) {
        if (page !== null) {
          await page.close().catch((closing: unknown) => {
            options.log(
              `the page opened for this call would not close (${messageOf(closing)})`,
            );
          });
        }
        return {
          ok: false,
          reason: "windowDidNotOpen",
          detail: `the browser is open but would not open a fresh page for this call: ${messageOf(error)}`,
        };
      }
      if (closed || live !== launched) {
        // The session closed (or the browser went) while the page opened.
        // Its browser is being closed with every page in it, so a page that
        // will not close here has nothing left to say that the answer below
        // does not.
        await page.close().catch(() => undefined);
        return closed
          ? SESSION_CLOSED
          : {
              ok: false,
              reason: "windowDidNotOpen",
              detail:
                "the browser went away while a page was being opened for this call; call this again",
            };
      }
      current = { page, cdp, taken: true };
      pageClosed = false;
      watch(launched, page);
      // After the new page is up, so a visible window never has zero tabs
      // between calls. A previous page that will not close holds no state
      // this call can see (each page is its own target), so it is said and
      // forgiven.
      if (was !== null) {
        await was.page.close().catch((error: unknown) => {
          options.log(
            `the previous call's page would not close (${messageOf(error)}); this call uses a fresh one`,
          );
        });
      }
      return { ok: true, stage: stageOf(page, cdp) };
    },
    closedSinceEnsure: () => pageClosed,
    screen: async (page) =>
      screenUnknown === null
        ? await readScreen(page, options.log)
        : { error: screenUnknown },
    headless: options.headless,
    running: () => live !== null && !pageClosed && live.browser.isConnected(),
    version: () =>
      live?.browser.isConnected() ? live.browser.version() : null,
    screenUnknown: () => screenUnknown,
    filmScale: () => filmScale,
    async close() {
      closed = true;
      pageClosed = false;
      current = null;
      if (starting !== null) {
        try {
          await starting;
        } catch (error) {
          options.log(`the browser launch failed (${messageOf(error)})`);
        }
      }
      const was = live;
      live = null;
      if (was === null) return;
      try {
        await was.close();
      } catch (error) {
        options.log(
          `the browser would not close cleanly (${messageOf(error)})`,
        );
      }
    },
  };
}

import { join } from "node:path";
import {
  type BrowserFailure,
  classifyLaunchError,
} from "@demoman/runner/studio";
import type { Refusal } from "@demoman/studio-protocol";
import { type BrowserContext, chromium, type Page } from "playwright";
import type { EventHub } from "./events.js";
import { messageOf } from "./files.js";
import { pagePathFor } from "./paths.js";

export interface StudioWindow {
  /** Opens the studio on `takeId`'s editor (the library without one), or
   *  sends a live window there. Answers the page's path; a window that could
   *  not be opened, moved there or brought forward is refused. */
  open(target: {
    takeId?: string;
  }): Promise<{ ok: true; path: string } | Refusal>;
  /** Called each time the last page the person can see closes. */
  onAllClosed(fn: () => void): void;
  close(): Promise<void>;
}

/** The profile the studio's browser keeps between starts. */
export const studioProfileDir = (home: string): string =>
  join(home, "profiles", "studio");

export type LaunchOptions = NonNullable<
  Parameters<typeof chromium.launchPersistentContext>[1]
>;
/** `chromium.launchPersistentContext`, or a test's stand-in. */
export type LaunchContext = (
  userDataDir: string,
  options: LaunchOptions,
) => Promise<BrowserContext>;

/** How long a window Demoman asked for may take to appear. */
const PAGE_WAIT_MS = 10_000;

const STOPPING: BrowserFailure = {
  ok: false,
  reason: "windowDidNotOpen",
  detail: "the Studio is stopping, so no window opens",
};

type Started =
  | { ok: true; context: BrowserContext; launched: boolean }
  | BrowserFailure;

/**
 * The studio's browser: a persistent Chromium context launched on the first
 * `open`, whose first window is an app window (`--app=`) on an entry link.
 * Every page in it is the person's: exports render in a headless browser of
 * their own (serve.ts), so nothing Demoman works in appears on screen.
 */
export function createStudioWindow(o: {
  home: string;
  origin: string;
  /** A fresh entry URL with a single-use ticket (ruling R12): the session
   *  token never goes into the browser's argv or a window's address. */
  entryUrl: (takeId?: string) => string;
  events: Pick<EventHub, "send" | "size">;
  executablePath?: string;
  headless?: boolean;
  log: (line: string) => void;
  /** Tests: a context that is not a browser. */
  launchContext?: LaunchContext;
  /** Tests: how long a window may take to appear (10 s). */
  pageWaitMs?: number;
}): StudioWindow {
  const { log } = o;
  const pageWaitMs = o.pageWaitMs ?? PAGE_WAIT_MS;
  const launchContext: LaunchContext =
    o.launchContext ??
    ((dir, options) => chromium.launchPersistentContext(dir, options));
  let context: BrowserContext | null = null;
  let starting: Promise<Started> | null = null;
  let closed = false;
  /** Whether the person had a page open at the last count. */
  let hadViewer = false;
  const listeners: (() => void)[] = [];

  const livePages = (): Page[] =>
    context === null ? [] : context.pages().filter((p) => !p.isClosed());

  /** Fires `onAllClosed` once per change from some window to none. */
  const count = (): void => {
    if (livePages().length > 0) {
      hadViewer = true;
      return;
    }
    if (!hadViewer) return;
    hadViewer = false;
    for (const fn of listeners) fn();
  };

  const watch = (ctx: BrowserContext): void => {
    const onPage = (page: Page) => {
      page.on("close", () => count());
      // The editor's preview line (what playback drew, at what bitmap, at
      // what cost) reaches studio.log, so a soft preview on the person's own
      // machine can be read without opening DevTools.
      page.on("console", (message) => {
        const text = message.text();
        if (text.startsWith("[demoman] preview:")) log(`studio: ${text}`);
      });
    };
    for (const page of ctx.pages()) onPage(page);
    ctx.on("page", (page) => {
      onPage(page);
      count();
    });
    ctx.on("close", () => {
      // The person quit the browser: every window is gone at once.
      if (context === ctx) context = null;
      count();
    });
  };

  /**
   * The context, launched when there is none, with the app window on
   * `appUrl()`.
   */
  function ensure(appUrl: () => string): Promise<Started> {
    if (closed) return Promise.resolve(STOPPING);
    if (context !== null) {
      return Promise.resolve({ ok: true, context, launched: false });
    }
    starting ??= launch(appUrl()).finally(() => {
      starting = null;
    });
    return starting;
  }

  async function launch(appUrl: string): Promise<Started> {
    let ctx: BrowserContext;
    try {
      ctx = await launchContext(studioProfileDir(o.home), {
        headless: o.headless ?? false,
        ...(o.executablePath === undefined
          ? {}
          : { executablePath: o.executablePath }),
        viewport: null,
        args: [
          // A ticket, not the token: argv is readable by any local user.
          `--app=${appUrl}`,
          // A fresh macOS profile otherwise asks the login keychain for
          // "Chrome Safe Storage" in a modal prompt (CLAUDE.md).
          "--use-mock-keychain",
          "--password-store=basic",
        ],
        // Playwright opens a persistent context on about:blank; with an app
        // window that would be a second, blank window the person did not
        // ask for, and one that kept the studio alive after they closed it.
        ignoreDefaultArgs: ["about:blank"],
        // runServe's own SIGTERM/SIGINT handlers close the browser, after
        // telling the pages the studio is stopping.
        handleSIGTERM: false,
        handleSIGINT: false,
      });
    } catch (error) {
      return classifyLaunchError(error);
    }
    if (closed) {
      // close() ran while the browser was starting, and it is terminal.
      await ctx.close().catch((error: unknown) => {
        log(
          `studio: a browser started during shutdown would not close (${messageOf(error)})`,
        );
      });
      return STOPPING;
    }
    context = ctx;
    watch(ctx);
    return { ok: true, context: ctx, launched: true };
  }

  /** The app window a launch with `--app` opened: Chrome opens it itself. */
  async function appWindow(): Promise<Page | null> {
    const deadline = Date.now() + pageWaitMs;
    for (;;) {
      const page = livePages().find((p) => p.url().startsWith(o.origin));
      if (page !== undefined) return page;
      if (Date.now() >= deadline) return null;
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  const didNotOpen = (detail: string): Refusal => ({
    reason: "windowDidNotOpen",
    detail,
  });

  return {
    async open(target) {
      const path = pagePathFor(target.takeId);
      const got = await ensure(() => o.entryUrl(target.takeId));
      if (!got.ok) return { reason: got.reason, detail: got.detail };

      if (got.launched) {
        const page = await appWindow();
        if (page === null) {
          return didNotOpen(
            `the Studio's browser started, but its window did not appear within ${pageWaitMs / 1000} s`,
          );
        }
        count();
        return { ok: true, path };
      }

      const live = livePages()[0];
      if (live !== undefined) {
        if (o.events.size() > 0) {
          // The page navigates itself after its owed writes (Task 12); a
          // server-side goto could drop an edit still being saved.
          o.events.send({ type: "open", path });
        } else {
          // No page is listening, so no editor holds a write this could
          // drop (one still loading has none yet): navigated from here,
          // through an entry link, so its cookie is set whatever it held.
          try {
            await live.goto(o.entryUrl(target.takeId));
          } catch (error) {
            return didNotOpen(
              `the Studio's window could not be sent to ${path} (${messageOf(error)})`,
            );
          }
        }
        try {
          await live.bringToFront();
        } catch (error) {
          return didNotOpen(
            `the Studio's window was sent to ${path} but could not be brought forward (${messageOf(error)})`,
          );
        }
        return { ok: true, path };
      }

      // The browser is running and the person closed every window (during
      // a drain). `--app` is a launch flag, so this is an ordinary window,
      // not an app window: it has an address bar and tabs.
      try {
        const page = await got.context.newPage();
        await page.goto(o.entryUrl(target.takeId));
      } catch (error) {
        return didNotOpen(
          `the Studio's window would not open: ${messageOf(error)}`,
        );
      }
      count();
      return { ok: true, path };
    },

    onAllClosed(fn) {
      listeners.push(fn);
    },

    async close() {
      closed = true;
      const pending = starting;
      if (pending !== null) await pending;
      const ctx = context;
      context = null;
      if (ctx !== null) await ctx.close();
    },
  };
}

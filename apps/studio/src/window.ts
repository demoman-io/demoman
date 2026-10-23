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
  /** A page to render in, behind the person's window (ruling R1: the
   *  runner's `openWorkPage` shape, since it is passed as exactly that). */
  workPage(): Promise<{ ok: true; page: Page } | BrowserFailure>;
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
  detail: "the studio is stopping, so no window opens",
};

type Started =
  | { ok: true; context: BrowserContext; launched: "app" | "work" | null }
  | BrowserFailure;

/**
 * The studio's browser: a persistent Chromium context launched on the first
 * `open`, whose first window is an app window (`--app=`) on an entry link.
 * Work pages are background windows of the same context, so an export never
 * takes the person's view, and they never count as the person's window.
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
  /** Pages Demoman opened to render in: never the person's. */
  const work = new WeakSet<Page>();
  /** Whether the person had a page open at the last count. */
  let hadViewer = false;
  /** Work pages being opened now (see the `page` listener). */
  let openingWork = 0;
  const listeners: (() => void)[] = [];

  const livePages = (): Page[] =>
    context === null ? [] : context.pages().filter((p) => !p.isClosed());
  const viewers = (): Page[] => livePages().filter((p) => !work.has(p));

  /** Fires `onAllClosed` once per change from some window to none. */
  const count = (): void => {
    if (viewers().length > 0) {
      hadViewer = true;
      return;
    }
    if (!hadViewer) return;
    hadViewer = false;
    for (const fn of listeners) fn();
  };

  const watch = (ctx: BrowserContext): void => {
    const onPage = (page: Page) => page.on("close", () => count());
    for (const page of ctx.pages()) onPage(page);
    ctx.on("page", (page) => {
      onPage(page);
      // While a work page is being opened, the page arriving may be it,
      // not marked yet: counting it as the person's would make the next
      // count fire `onAllClosed` for a window nobody closed. `workPage`
      // counts once it has marked it.
      if (openingWork === 0) count();
    });
    ctx.on("close", () => {
      // The person quit the browser: every window is gone at once.
      if (context === ctx) context = null;
      count();
    });
  };

  /**
   * The context, launched when there is none: for `open`, with the app
   * window on `appUrl()`; for a render after the person quit the browser,
   * with no app window, its first blank page being the work page.
   */
  function ensure(appUrl?: () => string): Promise<Started> {
    if (closed) return Promise.resolve(STOPPING);
    if (context !== null) {
      return Promise.resolve({ ok: true, context, launched: null });
    }
    starting ??= launch(appUrl?.()).finally(() => {
      starting = null;
    });
    return starting;
  }

  async function launch(appUrl: string | undefined): Promise<Started> {
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
          ...(appUrl === undefined ? [] : [`--app=${appUrl}`]),
          // A fresh macOS profile otherwise asks the login keychain for
          // "Chrome Safe Storage" in a modal prompt (CLAUDE.md).
          "--use-mock-keychain",
          "--password-store=basic",
        ],
        // Playwright opens a persistent context on about:blank; with an app
        // window that would be a second, blank window the person did not
        // ask for, and one that kept the studio alive after they closed it.
        ...(appUrl === undefined ? {} : { ignoreDefaultArgs: ["about:blank"] }),
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
    if (appUrl === undefined) {
      for (const page of ctx.pages()) work.add(page);
    }
    context = ctx;
    watch(ctx);
    return {
      ok: true,
      context: ctx,
      launched: appUrl === undefined ? "work" : "app",
    };
  }

  /** The app window a launch with `--app` opened: Chrome opens it itself. */
  async function appWindow(): Promise<Page | null> {
    const deadline = Date.now() + pageWaitMs;
    for (;;) {
      const page = viewers().find((p) => p.url().startsWith(o.origin));
      if (page !== undefined) return page;
      if (Date.now() >= deadline) return null;
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  /** The CDP target id of `page`, asked of the page's own session. */
  async function targetIdOf(ctx: BrowserContext, page: Page): Promise<string> {
    const cdp = await ctx.newCDPSession(page);
    try {
      const { targetInfo } = (await cdp.send("Target.getTargetInfo")) as {
        targetInfo: { targetId: string };
      };
      return targetInfo.targetId;
    } finally {
      await cdp.detach().catch((error: unknown) => {
        log(`studio: a page's session would not detach (${messageOf(error)})`);
      });
    }
  }

  /**
   * A new top-level window in `ctx`, opened over a page-level CDP session
   * (ruling R2: a persistent context has no Browser to open a
   * browser-level session on). Its page is the one whose target id is the
   * one `Target.createTarget` answered — never just the next `page` event,
   * which a second window opening at the same time (a render and a reopen
   * during a drain) or a tab the person opened could be.
   */
  async function newWindow(
    ctx: BrowserContext,
    url: string,
    background: boolean,
  ): Promise<Page> {
    const anchor = livePages()[0];
    if (anchor === undefined) {
      // No page left to open a session on (every window was closed, the
      // browser still running): an ordinary page, in front. `newPage`
      // answers its own page, so two at once cannot swap.
      const page = await ctx.newPage();
      if (url !== "about:blank") await page.goto(url);
      return page;
    }
    // Listening before createTarget, so the page cannot arrive unseen.
    const arrived: Page[] = [];
    let wake: (() => void) | null = null;
    const onPage = (page: Page) => {
      arrived.push(page);
      wake?.();
    };
    ctx.on("page", onPage);
    try {
      const cdp = await ctx.newCDPSession(anchor);
      let targetId: string;
      try {
        ({ targetId } = (await cdp.send("Target.createTarget", {
          url,
          newWindow: true,
          ...(background ? { background: true } : {}),
        })) as { targetId: string });
      } finally {
        await cdp.detach().catch((error: unknown) => {
          log(
            `studio: the session that opened a window would not detach (${messageOf(error)})`,
          );
        });
      }
      const deadline = Date.now() + pageWaitMs;
      let checked = 0;
      for (;;) {
        while (checked < arrived.length) {
          const page = arrived[checked] as Page;
          checked += 1;
          if (page.isClosed()) continue;
          let id: string;
          try {
            id = await targetIdOf(ctx, page);
          } catch (error) {
            // A page that closed while being asked is not the new window.
            log(
              `studio: a page's target could not be read (${messageOf(error)})`,
            );
            continue;
          }
          if (id === targetId) return page;
        }
        const left = deadline - Date.now();
        if (left <= 0) {
          throw new Error(
            `the browser opened window ${targetId}, but it did not reach Demoman within ${pageWaitMs / 1000} s`,
          );
        }
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, left);
          wake = () => {
            clearTimeout(timer);
            resolve();
          };
        });
        wake = null;
      }
    } finally {
      ctx.off("page", onPage);
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

      if (got.launched === "app") {
        const page = await appWindow();
        if (page === null) {
          return didNotOpen(
            `the studio's browser started, but its window did not appear within ${pageWaitMs / 1000} s`,
          );
        }
        count();
        return { ok: true, path };
      }

      const live = viewers()[0];
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
              `the studio's window could not be sent to ${path} (${messageOf(error)})`,
            );
          }
        }
        try {
          await live.bringToFront();
        } catch (error) {
          return didNotOpen(
            `the studio's window was sent to ${path} but could not be brought forward (${messageOf(error)})`,
          );
        }
        return { ok: true, path };
      }

      // The browser is running and the person closed every window (during
      // a drain). `--app` is a launch flag, so this is an ordinary window,
      // not an app window: it has an address bar and tabs.
      try {
        await newWindow(got.context, o.entryUrl(target.takeId), false);
      } catch (error) {
        return didNotOpen(
          `the studio's window would not open: ${messageOf(error)}`,
        );
      }
      count();
      return { ok: true, path };
    },

    async workPage() {
      const got = await ensure();
      if (!got.ok) return got;
      if (got.launched === "work") {
        // Relaunched for this render: its blank page is the work page.
        const first = livePages().find((p) => work.has(p));
        if (first !== undefined) return { ok: true, page: first };
      }
      openingWork += 1;
      try {
        const page = await newWindow(got.context, "about:blank", true);
        work.add(page);
        return { ok: true, page };
      } catch (error) {
        return {
          ok: false,
          reason: "windowDidNotOpen",
          detail: `the browser would not open a page to render in: ${messageOf(error)}`,
        };
      } finally {
        openingWork -= 1;
        count();
      }
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

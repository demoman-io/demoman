// apps/runner/test/executor-browser.test.ts
import { EventEmitter } from "node:events";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import type { CdpSession } from "@demoman/replay-engine";
import { describe, expect, it, vi } from "vitest";
import type { WorkWindow } from "../src/executor/browser.js";
import {
  classifyLaunchError,
  createBrowserSession,
} from "../src/executor/browser.js";
import { chromiumDepsCommand } from "../src/install-advice.js";
import type { Launched, launch } from "../src/launch.js";

const log = (_: string) => undefined;

describe("classifyLaunchError", () => {
  it("names a missing Chromium and gives the install command", () => {
    const failure = classifyLaunchError(
      // Playwright's real text, captured from launch() with a missing path.
      new Error(
        "Failed to launch chromium because executable doesn't exist at /nonexistent/demoman/chrome Failed to launch browser.",
      ),
    );
    expect(failure.reason).toBe("browserMissing");
  });

  // Launch prep defect 1 (2026-10-14): outside this repo an unpinned
  // `npx playwright install chromium` fetches npm's latest Playwright
  // (measured: 1.64.0, chromium-1248), while the loaded one (1.62.1) looks
  // for chromium-1234, so the next call answered browserMissing again with
  // the same advice. 1.62.1 is not npm's latest; the advice must name it.
  it("advises installing the Chromium of the Playwright that is loaded, pinned", () => {
    const failure = classifyLaunchError(
      new Error("browserType.launch: Executable doesn't exist at /x"),
      { ok: true, version: "1.62.1" },
    );
    expect(failure.reason).toBe("browserMissing");
    expect(failure.detail).toContain("npx playwright@1.62.1 install chromium");
    expect(failure.detail).not.toContain("npx playwright install");
  });

  it("pins the advice to the version this process loads by default", () => {
    const loaded = createRequire(import.meta.url)("playwright/package.json")
      .version as string;
    // The premise: a real version was read, so the pin below is not "@".
    expect(loaded).toMatch(/^\d+\.\d+\.\d+/);
    const failure = classifyLaunchError(
      new Error("Executable doesn't exist at /x"),
    );
    expect(failure.detail).toContain(
      `npx playwright@${loaded} install chromium`,
    );
  });

  it("says so when the loaded Playwright's version cannot be read", () => {
    const failure = classifyLaunchError(
      new Error("Executable doesn't exist at /x"),
      { ok: false, why: "Cannot find module 'playwright/package.json'" },
    );
    expect(failure.reason).toBe("browserMissing");
    expect(failure.detail).toContain(
      "Cannot find module 'playwright/package.json'",
    );
    expect(failure.detail).not.toMatch(/npx playwright(@\S*)? install/);
  });

  // Every production launch names its executable (fullChromiumPath), and
  // Playwright skips its host check for a custom executable
  // (playwright-core 1.62.1 coreBundle.js, launch: `if (customExecutablePath)`),
  // so missing libraries arrive as the dynamic linker's line in the browser
  // log. The shape of Playwright's launch error around it, from that file;
  // not captured on a machine missing libnss3.
  const MISSING_LIBRARY = [
    "browserType.launch: Target page, context or browser has been closed",
    "Browser logs:",
    "",
    "<launching> /home/u/.cache/ms-playwright/chromium-1234/chrome-linux/chrome --disable-field-trial-config --headless",
    "<launched> pid=4242",
    "[pid=4242][err] /home/u/.cache/ms-playwright/chromium-1234/chrome-linux/chrome: error while loading shared libraries: libnss3.so: cannot open shared object file: No such file or directory",
    "Call log:",
    "  - <launching> /home/u/.cache/ms-playwright/chromium-1234/chrome-linux/chrome",
  ].join("\n");

  it("names install-deps when a library is missing at a custom executable's launch", () => {
    // Premise: the fixture is not the host-check text, which a custom
    // executable never gets.
    expect(MISSING_LIBRARY).not.toContain("Host system is missing");
    const failure = classifyLaunchError(new Error(MISSING_LIBRARY));
    expect(failure.reason).toBe("browserMissing");
    expect(failure.detail).toContain("libnss3.so");
    expect(failure.detail).toContain("install-deps chromium");
  });

  // sudo resets PATH, and an nvm, fnm or volta npx is not on root's: the
  // command runs this node and this Playwright's CLI by absolute path, the
  // same one setup names (chromiumDepsCommand).
  it("names the one install-deps command setup names, by absolute path", () => {
    const deps = chromiumDepsCommand();
    expect(deps.ok, JSON.stringify(deps)).toBe(true);
    if (!deps.ok) return;
    expect(deps.command).toBe(process.execPath);
    expect(deps.args.slice(-2)).toEqual(["install-deps", "chromium"]);
    const failure = classifyLaunchError(
      new Error("Host system is missing dependencies to run browsers."),
    );
    expect(failure.detail).toContain(
      `sudo ${[deps.command, ...deps.args].join(" ")}`,
    );
    expect(failure.detail).not.toContain("npx");
  });

  // The published package's setup command answers a missing Chromium; it
  // cannot install libraries without root, so it must not replace this one.
  it("keeps install-deps when the package names its own install command", () => {
    const failure = classifyLaunchError(
      new Error("Host system is missing dependencies to run browsers."),
      { ok: true, version: "1.62.1" },
      "npx demoman@9.9.9 setup",
    );
    expect(failure.detail).toContain("install-deps chromium");
    expect(failure.detail).not.toContain("npx demoman@9.9.9 setup");
  });

  it("calls any other launch failure windowDidNotOpen, with Playwright's words", () => {
    const failure = classifyLaunchError(new Error("spawn EACCES"));
    expect(failure).toEqual({
      ok: false,
      reason: "windowDidNotOpen",
      detail: "the browser would not launch: spawn EACCES",
    });
  });
});

describe("createBrowserSession", () => {
  it("answers browserMissing for a browser that is not there", async () => {
    const session = createBrowserSession({
      headless: true,
      executablePath: "/nonexistent/demoman/chrome",
      log,
    });
    const got = await session.ensure();
    expect(got.ok).toBe(false);
    if (!got.ok) expect(got.reason).toBe("browserMissing");
    expect(session.running()).toBe(false);
  }, 30_000);

  // Launch B: the published package names its own setup command, which
  // installs the Chromium revision its pinned Playwright looks for.
  it("names the install command it was given in browserMissing", async () => {
    const session = createBrowserSession({
      headless: true,
      executablePath: "/nonexistent/demoman/chrome",
      installCommand: "npx demoman@9.9.9 setup",
      log,
    });
    const got = await session.ensure();
    expect(got).toEqual({
      ok: false,
      reason: "browserMissing",
      detail:
        "Demoman's browser is not installed — run `npx demoman@9.9.9 setup` once, then call this again",
    });
  }, 30_000);

  it("leaves a failure that is not browserMissing in Playwright's words", async () => {
    const session = createBrowserSession({
      headless: true,
      installCommand: "npx demoman@9.9.9 setup",
      launchFn: async () => {
        throw new Error("spawn EACCES");
      },
      log,
    });
    const got = await session.ensure();
    expect(got.ok).toBe(false);
    if (!got.ok) {
      expect(got.reason).toBe("windowDidNotOpen");
      expect(got.detail).not.toContain("npx demoman");
    }
  });

  it("refuses arm64 Linux by name before launching anything", async () => {
    let launches = 0;
    const session = createBrowserSession({
      headless: true,
      host: { platform: "linux", arch: "arm64" },
      launchFn: async () => {
        launches++;
        throw new Error("launched");
      },
      log,
    });
    const got = await session.ensure();
    expect(got).toMatchObject({ ok: false, reason: "unsupportedPlatform" });
    if (!got.ok) expect(got.detail).toContain("no H.264 encoder");
    expect(launches).toBe(0);
  });

  it("launches on x86_64 Linux", async () => {
    let launches = 0;
    const session = createBrowserSession({
      headless: true,
      host: { platform: "linux", arch: "x64" },
      launchFn: async () => {
        launches++;
        throw new Error("launched");
      },
      log,
    });
    await session.ensure();
    expect(launches).toBe(1);
  });

  it("launches once, lazily, and hands back the same browser", async () => {
    const session = createBrowserSession({ headless: true, log });
    expect(session.running()).toBe(false);
    const a = await session.ensure();
    const b = await session.ensure();
    expect(a.ok && b.ok).toBe(true);
    if (a.ok && b.ok) expect(b.launched.page).toBe(a.launched.page);
    expect(session.version()).toMatch(/\d+\.\d+/);
    await session.close();
    expect(session.running()).toBe(false);
  }, 60_000);

  it("relaunches after the window is closed, and says it was closed", async () => {
    const session = createBrowserSession({ headless: true, log });
    const first = await session.ensure();
    if (!first.ok) throw new Error(JSON.stringify(first));
    await first.launched.page.close();
    expect(session.closedSinceEnsure()).toBe(true);
    expect(session.running()).toBe(false);
    const second = await session.ensure();
    if (!second.ok) throw new Error(JSON.stringify(second));
    // A new page, and the closed flag is about the new one.
    expect(second.launched.page).not.toBe(first.launched.page);
    expect(session.closedSinceEnsure()).toBe(false);
    await session.close();
  }, 90_000);

  // Final review 2026-10-12, Critical 1: a call's emulation and heartbeat
  // stay on its page, so each call gets one. Red if stage() hands back the
  // page an earlier call used, or closes it before the next is open, or
  // counts its own close of the old page as the author's.
  it("stage() gives each call its own page, opened before the last one closes", async () => {
    const lines: string[] = [];
    const session = createBrowserSession({
      headless: true,
      log: (line) => lines.push(line),
    });
    try {
      const launched = await session.ensure();
      if (!launched.ok) throw new Error(JSON.stringify(launched));
      const a = await session.stage();
      if (!a.ok) throw new Error(JSON.stringify(a));
      // The launch's own page is the first call's: no tab is opened for it.
      expect(a.stage.page).toBe(launched.launched.page);
      // How many pages the context held when the next page appeared: two
      // means the previous call's page was still open (the window stays).
      let pagesWhenOpened = -1;
      launched.launched.context.once("page", () => {
        pagesWhenOpened = launched.launched.context.pages().length;
      });
      const b = await session.stage();
      if (!b.ok) throw new Error(JSON.stringify(b));
      expect(b.stage.page).not.toBe(a.stage.page);
      expect(b.stage.cdp).not.toBe(a.stage.cdp);
      expect(pagesWhenOpened).toBe(2);
      expect(a.stage.page.isClosed()).toBe(true);
      expect(launched.launched.context.pages()).toEqual([b.stage.page]);
      // The session closed a's page itself: not the author's close.
      expect(session.closedSinceEnsure(), JSON.stringify(lines)).toBe(false);
      expect(session.running()).toBe(true);
      // The author closing the page the call is using is.
      await b.stage.page.close();
      expect(session.closedSinceEnsure()).toBe(true);
    } finally {
      await session.close();
    }
  }, 90_000);

  // Audit run 1. Red if retire() closes a work page or the unused launch
  // page, leaves a stray open, or leaves the previous call's page running.
  it("retire() stops every page of an earlier call and keeps work pages", async () => {
    const lines: string[] = [];
    const session = createBrowserSession({
      headless: true,
      log: (line) => lines.push(line),
    });
    try {
      const launched = await session.ensure();
      if (!launched.ok) throw new Error(JSON.stringify(launched));
      const { context } = launched.launched;
      // Before any call, the launch's page is nobody's: left as it is.
      await session.retire();
      expect(launched.launched.page.isClosed()).toBe(false);

      const a = await session.stage();
      if (!a.ok) throw new Error(JSON.stringify(a));
      await a.stage.page.goto("data:text/html,<h1>call a</h1>");
      const stray = await context.newPage();
      const work = await session.openWorkPage();
      if (!work.ok) throw new Error(JSON.stringify(work));
      // Premise: three pages, the stage's on what call a opened.
      expect(context.pages()).toHaveLength(3);
      expect(a.stage.page.url()).toMatch(/^data:/);

      await session.retire();
      expect(stray.isClosed()).toBe(true);
      expect(work.page.isClosed()).toBe(false);
      expect(a.stage.page.isClosed()).toBe(false);
      expect(a.stage.page.url()).toBe("about:blank");
      // The session stopped them itself: not the author's close.
      expect(session.closedSinceEnsure(), JSON.stringify(lines)).toBe(false);
      await work.page.close();
    } finally {
      await session.close();
    }
  }, 90_000);

  // Review 2026-10-13, #3: the guard's navigation, the snapshot's reads and
  // the navigation watch all go out on the stage's session, and a server
  // that takes the connection and never answers held `Page.navigate` — and
  // with it the executor's one slot — for good. Red if `stage()` hands back
  // the session undeadlined. The premise: the server really was reached,
  // and really never answered.
  it("stage()'s session refuses a call the browser never answers", async () => {
    let reached = 0;
    const server = createServer(() => {
      reached++;
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const { port } = server.address() as AddressInfo;
    const session = createBrowserSession({
      headless: true,
      log,
      answerDeadlineMs: 1_000,
    });
    try {
      const staged = await session.stage();
      if (!staged.ok) throw new Error(JSON.stringify(staged));
      await expect(
        staged.stage.cdp.send("Page.navigate", {
          url: `http://127.0.0.1:${port}/`,
        }),
      ).rejects.toThrow("Page.navigate got no answer from the browser in 1 s");
      expect(reached).toBeGreaterThan(0);
    } finally {
      await session.close();
      server.closeAllConnections();
      server.close();
    }
  }, 90_000);
});

// A fake Launched for the session's bookkeeping: no browser process, a page
// that is an EventEmitter (so a test can close it), and a close that counts
// its calls and can be made to reject.
type Fake = {
  launched: Launched;
  page: EventEmitter;
  closeCalls: () => number;
};
function fakeLaunched(options: { closeRejects?: boolean } = {}): Fake {
  const page = new EventEmitter();
  let calls = 0;
  const launched = {
    browser: { isConnected: () => true, version: () => "1.0" },
    page,
    async close() {
      calls++;
      if (options.closeRejects) throw new Error("server would not stop");
      return { crashed: false };
    },
  } as unknown as Launched;
  return { launched, page, closeCalls: () => calls };
}

describe("createBrowserSession bookkeeping (fake launcher)", () => {
  it("launches headless on the display it reads, and says when it cannot read one", async () => {
    const display = { width: 1710, height: 1107, scale: 2 };
    const launchedWith: Parameters<typeof launch>[0][] = [];
    const launchFn = async (o?: (typeof launchedWith)[number]) => {
      launchedWith.push(o);
      return fakeLaunched().launched;
    };
    const read = createBrowserSession({
      headless: true,
      log,
      launchFn,
      readDisplay: async () => display,
    });
    expect((await read.ensure()).ok).toBe(true);
    expect(launchedWith[0]?.display).toEqual(display);
    await read.close();

    expect(read.screenUnknown()).toBeNull();
    // Read again on every launch: a laptop docked between two launches is on
    // another screen, and a relaunch after a crash must film at that one.
    const docked = { width: 2560, height: 1440, scale: 1 };
    let reads = 0;
    const counted = createBrowserSession({
      headless: true,
      log,
      launchFn: async (o) => {
        const fake = fakeLaunched();
        launchedWith.push(o);
        setTimeout(() => fake.page.emit("close"), 0);
        return fake.launched;
      },
      readDisplay: async () => {
        reads++;
        return reads === 1 ? display : docked;
      },
    });
    await counted.ensure();
    // Waited for, never slept on (CLAUDE.md: no fixed sleeps).
    await vi.waitFor(() => {
      expect(counted.closedSinceEnsure()).toBe(true);
    });
    await counted.ensure();
    expect(launchedWith.slice(1).map((o) => o?.display)).toEqual([
      display,
      docked,
    ]);
    expect(reads).toBe(2);
    await counted.close();
    launchedWith.length = 1;

    const logs: string[] = [];
    const refused = createBrowserSession({
      headless: true,
      log: (line) => logs.push(line),
      launchFn,
      readDisplay: async () => ({ failed: "osascript refused: no" }),
    });
    expect(refused.screenUnknown()).toBeNull();
    expect((await refused.ensure()).ok).toBe(true);
    expect(launchedWith[1]).not.toHaveProperty("display");
    // The reason a size report carries, not only a log line.
    const why =
      "Demoman could not read this computer's display (osascript refused: no), so headless recorded at 1x, and at its own window size unless the script or its device named one — set DEMOMAN_DISPLAY to <width>x<height>@<scale> (such as 1710x1107@2), or start Demoman with --headed";
    expect(refused.screenUnknown()).toBe(why);
    expect(logs).toEqual([why]);
    await refused.close();

    // A read that throws is a read that failed, said the same way: the
    // launch goes on without a display, and the next launch reads again.
    const thrown: string[] = [];
    let attempts = 0;
    const throwing = createBrowserSession({
      headless: true,
      log: (line) => thrown.push(line),
      launchFn: async (o) => {
        const fake = fakeLaunched();
        launchedWith.push(o);
        setTimeout(() => fake.page.emit("close"), 0);
        return fake.launched;
      },
      readDisplay: async () => {
        attempts++;
        if (attempts === 1) throw new Error("spawn osascript ENOENT");
        return display;
      },
    });
    const first = await throwing.ensure();
    expect(first.ok, JSON.stringify(first)).toBe(true);
    expect(throwing.screenUnknown()).toContain(
      "Demoman could not read this computer's display (spawn osascript ENOENT)",
    );
    expect(thrown[0]).toContain("spawn osascript ENOENT");
    await vi.waitFor(() => {
      expect(throwing.closedSinceEnsure()).toBe(true);
    });
    expect((await throwing.ensure()).ok).toBe(true);
    expect(attempts).toBe(2);
    expect(launchedWith.at(-1)?.display).toEqual(display);
    expect(throwing.screenUnknown()).toBeNull();
    await throwing.close();
    launchedWith.length = 2;

    // A visible window is on its display already: nothing is read.
    reads = 0;
    const visible = createBrowserSession({
      headless: false,
      log,
      launchFn,
      readDisplay: async () => {
        reads++;
        return display;
      },
    });
    expect((await visible.ensure()).ok).toBe(true);
    expect(reads).toBe(0);
    expect(launchedWith[2]).not.toHaveProperty("display");
    await visible.close();
  });

  it("a close that rejects is logged, and the session still relaunches", async () => {
    const logs: string[] = [];
    const fakes: Fake[] = [];
    const session = createBrowserSession({
      headless: true,
      log: (line) => logs.push(line),
      launchFn: async () => {
        const fake = fakeLaunched({ closeRejects: true });
        fakes.push(fake);
        return fake.launched;
      },
    });
    const first = await session.ensure();
    expect(first.ok).toBe(true);
    fakes[0]?.page.emit("close");
    expect(session.closedSinceEnsure()).toBe(true);
    const second = await session.ensure();
    expect(second.ok, JSON.stringify(logs)).toBe(true);
    expect(fakes.length).toBe(2);
    expect(logs).toContain(
      "the previous browser would not close cleanly (server would not stop); starting a new one",
    );
    await expect(session.close()).resolves.toBeUndefined();
    expect(logs).toContain(
      "the browser would not close cleanly (server would not stop)",
    );
  });

  it("closedSinceEnsure is false after session.close() and after a failed onLaunched", async () => {
    const afterClose = fakeLaunched();
    const s1 = createBrowserSession({
      headless: true,
      log: () => undefined,
      launchFn: async () => afterClose.launched,
    });
    expect((await s1.ensure()).ok).toBe(true);
    await s1.close();
    expect(s1.closedSinceEnsure()).toBe(false);

    const unprepared = fakeLaunched();
    const s2 = createBrowserSession({
      headless: true,
      log: () => undefined,
      launchFn: async () => unprepared.launched,
      onLaunched: async () => {
        throw new Error("no page");
      },
    });
    const got = await s2.ensure();
    expect(got.ok).toBe(false);
    if (!got.ok) expect(got.reason).toBe("windowDidNotOpen");
    expect(unprepared.closeCalls()).toBe(1);
    // The browser this session closed itself reports no page closure.
    unprepared.page.emit("close");
    expect(s2.closedSinceEnsure()).toBe(false);
  });

  it("close() during a pending launch closes what the launch produced", async () => {
    let release!: (fake: Fake) => void;
    const deferred = new Promise<Fake>((resolve) => {
      release = resolve;
    });
    const session = createBrowserSession({
      headless: true,
      log: () => undefined,
      launchFn: () => deferred.then((fake) => fake.launched),
    });
    const pending = session.ensure();
    const closing = session.close();
    const fake = fakeLaunched();
    release(fake);
    const got = await pending;
    await closing;
    expect(got.ok, `pending ensure answered ${JSON.stringify(got)}`).toBe(
      false,
    );
    expect(fake.closeCalls()).toBe(1);
    expect(session.running()).toBe(false);
    // Terminal: a later ensure launches nothing.
    expect((await session.ensure()).ok).toBe(false);
  });

  // T7 ledger: close() is terminal, including while a relaunch is waiting
  // for the old browser to close. Red if ensure() starts a launch after it.
  it("close() while a relaunch waits on the old browser launches nothing", async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let launches = 0;
    const first = fakeLaunched();
    first.launched.close = async () => {
      await held;
      return { crashed: false };
    };
    const session = createBrowserSession({
      headless: true,
      log: () => undefined,
      launchFn: async () => {
        launches++;
        return launches === 1 ? first.launched : fakeLaunched().launched;
      },
    });
    expect((await session.ensure()).ok).toBe(true);
    first.page.emit("close");
    // The relaunch is now waiting on the old browser's close.
    const relaunch = session.ensure();
    await session.close();
    release();
    const got = await relaunch;
    expect(got.ok, JSON.stringify(got)).toBe(false);
    if (!got.ok) expect(got.reason).toBe("windowDidNotOpen");
    expect(launches).toBe(1);
  });

  it("two concurrent ensure() calls share one launch", async () => {
    let launches = 0;
    const session = createBrowserSession({
      headless: true,
      log: () => undefined,
      launchFn: async () => {
        launches++;
        return fakeLaunched().launched;
      },
    });
    const [a, b] = await Promise.all([session.ensure(), session.ensure()]);
    expect(launches).toBe(1);
    if (a.ok && b.ok) expect(b.launched).toBe(a.launched);
    await session.close();
  });
});

type Sent = { method: string; params: unknown };

/**
 * A session over a fake browser that records every CDP call: `sent` is what
 * the stage pages were told, `browserSent` the browser-level session's,
 * `workSent` the work page's own. `refuse` / `refuseBrowser` name a method
 * whose send rejects with "refused".
 */
function fakeSession(opts: {
  headless: boolean;
  workWindow?: WorkWindow;
  refuse?: string;
  refuseBrowser?: string;
  refuseWork?: string;
  /** waitForEvent rejects this many ms after it is called. */
  waitRejectsAfter?: number;
  connected?: () => boolean;
}) {
  const sent: Sent[] = [];
  const browserSent: Sent[] = [];
  const workSent: Sent[] = [];
  const lines: string[] = [];
  const recorder = (
    into: Sent[],
    refuse: string | undefined,
    answers: Record<string, Record<string, unknown>>,
    dead: () => boolean = () => false,
  ): CdpSession =>
    ({
      send: async (method: string, params: unknown) => {
        into.push({ method, params });
        // Like a real session whose page has closed.
        if (dead()) throw new Error("Target closed");
        if (method === refuse) throw new Error("refused");
        return answers[method] ?? {};
      },
      on: () => () => undefined,
      detach: async () => undefined,
    }) as unknown as CdpSession;
  const stageAnswers = {
    "Browser.getWindowForTarget": { windowId: 7 },
    "Target.getTargetInfo": { targetInfo: { browserContextId: "ctx-1" } },
  };
  const closedPages = new WeakSet<object>();
  const newPage = () => {
    const page = Object.assign(new EventEmitter(), {
      close: async () => undefined,
      isClosed: () => false,
    });
    page.once("close", () => closedPages.add(page));
    return page;
  };
  const workPage = newPage();
  const workPages = new Set<unknown>([workPage]);
  const context = {
    pages: () => [],
    newPage: async () => newPage(),
    newCDPSession: async (page: object) =>
      workPages.has(page)
        ? recorder(workSent, opts.refuseWork, stageAnswers)
        : recorder(sent, opts.refuse, stageAnswers, () =>
            closedPages.has(page as object),
          ),
    waitForEvent: () =>
      opts.waitRejectsAfter === undefined
        ? Promise.resolve(workPage)
        : new Promise((_, reject) =>
            setTimeout(
              () => reject(new Error("waitForEvent timed out")),
              opts.waitRejectsAfter,
            ),
          ),
  };
  const browser = {
    isConnected: () => opts.connected?.() ?? true,
    version: () => "1.0",
    newBrowserCDPSession: async () =>
      recorder(browserSent, opts.refuseBrowser, {
        "Target.createTarget": { targetId: "work-1" },
      }),
  };
  const launchPage = newPage();
  const launched = {
    browser,
    context,
    page: launchPage,
    cdp: recorder(sent, opts.refuse, stageAnswers, () =>
      closedPages.has(launchPage),
    ),
    clock: {},
    async close() {
      return { crashed: false };
    },
  } as unknown as Launched;
  let launches = 0;
  const session = createBrowserSession({
    headless: opts.headless,
    ...(opts.workWindow === undefined ? {} : { workWindow: opts.workWindow }),
    log: (line) => lines.push(line),
    launchFn: async () => {
      launches++;
      return launched;
    },
    onLaunched: async () => undefined,
  });
  return {
    session,
    sent,
    browserSent,
    workSent,
    lines,
    launched,
    launches: () => launches,
  };
}

describe("headed windows (R12)", () => {
  // Red before this task: each call's page opened at the context's 1024x640
  // viewport, and the window snapped to ~1026x720 (parked R12).
  it("maximizes the stage window of every call, headed", async () => {
    const { session, sent } = fakeSession({ headless: false });
    for (let i = 0; i < 3; i++) {
      const s = await session.stage();
      expect(s.ok).toBe(true);
    }
    const max = sent.filter(
      (m) =>
        m.method === "Browser.setWindowBounds" &&
        (m.params as { bounds: { windowState: string } }).bounds.windowState ===
          "maximized",
    );
    expect(max, JSON.stringify(sent)).toHaveLength(3);
  });

  it("leaves window state alone headless", async () => {
    const { session, sent } = fakeSession({ headless: true });
    expect((await session.stage()).ok).toBe(true);
    // Positive control: the stage was prepared (a viewport drop was sent).
    expect(
      sent.some((m) => m.method === "Emulation.setDeviceMetricsOverride"),
    ).toBe(true);
    expect(sent.some((m) => m.method.startsWith("Browser."))).toBe(false);
  });

  // Cosmetic, so forgiven — but said.
  it("logs, and still stages, when the window will not maximize", async () => {
    const { session, lines } = fakeSession({
      headless: false,
      refuse: "Browser.setWindowBounds",
    });
    expect((await session.stage()).ok).toBe(true);
    expect(lines.join("\n")).toMatch(/could not be maximized/);
  });
});

describe("openWorkPage", () => {
  it("opens a tab headless, whatever the mode", async () => {
    const { session, browserSent } = fakeSession({
      headless: true,
      workWindow: "minimized",
    });
    expect((await session.openWorkPage()).ok).toBe(true);
    expect(browserSent.some((m) => m.method === "Target.createTarget")).toBe(
      false,
    );
  });

  it("opens its own background window in the stage's browser context, headed", async () => {
    const { session, browserSent } = fakeSession({
      headless: false,
      workWindow: "background",
    });
    await session.stage();
    expect((await session.openWorkPage()).ok).toBe(true);
    expect(browserSent).toContainEqual({
      method: "Target.createTarget",
      params: {
        url: "about:blank",
        newWindow: true,
        background: true,
        browserContextId: "ctx-1",
      },
    });
  });

  it("minimizes that window when the mode says so", async () => {
    const { session, workSent } = fakeSession({
      headless: false,
      workWindow: "minimized",
    });
    await session.stage();
    await session.openWorkPage();
    expect(workSent).toContainEqual({
      method: "Browser.setWindowBounds",
      params: { windowId: 7, bounds: { windowState: "minimized" } },
    });
  });

  // Report before you forgive: no work page is a failure with the reason,
  // never a silent fallback onto the stage.
  it("answers windowDidNotOpen with the browser's words when the window will not open", async () => {
    const { session } = fakeSession({
      headless: false,
      workWindow: "background",
      refuseBrowser: "Target.createTarget",
    });
    await session.stage();
    const out = await session.openWorkPage();
    expect(out).toMatchObject({ ok: false, reason: "windowDidNotOpen" });
    expect(out.ok ? "" : out.detail).toMatch(/refused/);
  });

  // The brief's version left waitForEvent un-consumed when createTarget
  // failed: ~10 s later it rejected unhandled and Node killed the process.
  it("consumes the page event it armed when the window will not open", async () => {
    const stray: unknown[] = [];
    const onStray = (reason: unknown) => stray.push(reason);
    process.on("unhandledRejection", onStray);
    try {
      const { session, lines } = fakeSession({
        headless: false,
        workWindow: "background",
        refuseBrowser: "Target.createTarget",
        waitRejectsAfter: 20,
      });
      await session.stage();
      const out = await session.openWorkPage();
      expect(out).toMatchObject({ ok: false, reason: "windowDidNotOpen" });
      // Let the armed event reject, then let Node report anything unhandled.
      await new Promise((r) => setTimeout(r, 80));
      await new Promise((r) => setImmediate(r));
      expect(stray.map(String)).toEqual([]);
      expect(lines.join("\n")).toMatch(/waitForEvent timed out/);
    } finally {
      process.off("unhandledRejection", onStray);
    }
  });

  it("keeps the page, and says so, when the window will not minimize", async () => {
    const { session, lines } = fakeSession({
      headless: false,
      workWindow: "minimized",
      refuseWork: "Browser.setWindowBounds",
    });
    await session.stage();
    const out = await session.openWorkPage();
    expect(out.ok).toBe(true);
    expect(lines.join("\n")).toMatch(/could not be minimized \(refused\)/);
  });

  it("relaunch:false encodes in the live browser after the author closed the stage page", async () => {
    const { session, launched, launches, browserSent } = fakeSession({
      headless: false,
      workWindow: "background",
    });
    await session.stage();
    (launched.page as unknown as EventEmitter).emit("close");
    expect(session.closedSinceEnsure()).toBe(true);
    const out = await session.openWorkPage({ relaunch: false });
    expect(out.ok).toBe(true);
    expect(launches()).toBe(1);
    // Background mode still found its context with the stage page gone.
    expect(browserSent).toContainEqual({
      method: "Target.createTarget",
      params: {
        url: "about:blank",
        newWindow: true,
        background: true,
        browserContextId: "ctx-1",
      },
    });
  });

  it("relaunch:false answers windowDidNotOpen for a disconnected browser, launching nothing", async () => {
    let up = true;
    const { session, launches } = fakeSession({
      headless: true,
      connected: () => up,
    });
    await session.stage();
    up = false;
    const out = await session.openWorkPage({ relaunch: false });
    expect(out).toMatchObject({ ok: false, reason: "windowDidNotOpen" });
    expect(out.ok ? "" : out.detail).toMatch(/gone before it could be encoded/);
    expect(launches()).toBe(1);
  });
});

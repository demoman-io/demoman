import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import { request } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { STUDIO_HEADER } from "@demoman/studio-protocol";
import { type BrowserContext, chromium, type Page } from "playwright";
import { vi } from "vitest";
import { runServe } from "../../src/serve.js";
import { readStudioState, type StudioState } from "../../src/state-file.js";
import { createStudioWindow } from "../../src/window.js";

// The studio as the browser lanes run it: the real server (`runServe`) on a
// home of the test's own, with the real built pages, and its window
// (`window.ts` as it ships, only the launch wrapped so a test can hold the
// context); and its API, called with the studio's header and cookie.

/** `apps/studio/.output/pages`, which `pnpm -r build` writes. */
export const PAGES = fileURLToPath(
  new URL("../../.output/pages", import.meta.url),
);

export interface Studio {
  state: StudioState;
  origin: string;
  logs: string[];
  context(): BrowserContext;
  stop(): Promise<number>;
}

export async function startStudio(
  home: string,
  outDir: string,
): Promise<Studio> {
  const logs: string[] = [];
  // The pages' own version: a studio of any other answers every save with
  // the version-skew line, as a real update would.
  const stamp = JSON.parse(
    await readFile(join(PAGES, "studio-build.json"), "utf8"),
  ) as { version?: unknown };
  if (typeof stamp.version !== "string") {
    throw new Error(
      `${join(PAGES, "studio-build.json")} names no version: ${JSON.stringify(stamp)}`,
    );
  }
  const signals = new EventEmitter();
  let context: BrowserContext | null = null;
  let exited: ((code: number) => void) | null = null;
  const exit = new Promise<number>((resolve) => {
    exited = resolve;
  });
  let stopped = false;
  void runServe({
    home,
    outDir,
    pagesDir: PAGES,
    version: stamp.version,
    headless: true,
    executablePath: chromium.executablePath(),
    log: (line) => logs.push(line),
    // window.ts as it ships; only the launch is wrapped, to hold the
    // context the app window lives in.
    createWindow: (w) =>
      createStudioWindow({
        home,
        origin: w.origin,
        entryUrl: w.entryUrl,
        events: w.events,
        log: w.log,
        headless: true,
        // As the CLI names it (apps/cli/src/main.ts): the full Chromium.
        // Headless with no executable, Playwright picks the headless shell,
        // which ignores --app: no page ever opens and the launch waits out
        // Playwright's 180 s timeout (measured 2026-10-16).
        executablePath: chromium.executablePath(),
        launchContext: async (dir, options) => {
          const ctx = await chromium.launchPersistentContext(dir, options);
          context = ctx;
          return ctx;
        },
      }),
    exit: (code) => exited?.(code),
    signals,
  });
  const state = await vi.waitFor(
    async () => {
      const s = await readStudioState(home);
      if (s === null || "unreadable" in s) {
        throw new Error(`no studio.json yet; log: ${logs.join(" | ")}`);
      }
      return s;
    },
    { timeout: 15_000, interval: 50 },
  );
  return {
    state,
    origin: `http://127.0.0.1:${state.port}`,
    logs,
    context() {
      if (context === null)
        throw new Error("the Studio's browser never launched");
      return context;
    },
    async stop() {
      if (!stopped) {
        stopped = true;
        signals.emit("SIGTERM");
      }
      let timer: NodeJS.Timeout | undefined;
      const late = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error(
                `the Studio did not exit within 30 s of SIGTERM; log: ${logs.join(" | ")}`,
              ),
            ),
          30_000,
        );
      });
      try {
        return await Promise.race([exit, late]);
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

/** How long one studio request may take: every route this test calls
 *  answers in milliseconds here (the window's launch, the slowest, in
 *  ~0.4 s), so x5 with room. */
export const API_TIMEOUT_MS = 15_000;

/** A studio API call. A request that fails or does not answer in time
 *  rejects with the studio's log, which is where its reason would be. */
export function api(
  studio: Studio,
  path: string,
  o: { method?: string; body?: unknown } = {},
): Promise<{ status: number; text: string; json: () => unknown }> {
  const s = studio.state;
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const fail = (why: string) =>
      reject(
        new Error(
          `${o.method ?? "GET"} ${path}: ${why} after ${Date.now() - started} ms\nstudio log:\n${studio.logs.join("\n")}`,
        ),
      );
    const req = request(
      {
        host: "127.0.0.1",
        port: s.port,
        path,
        method: o.method ?? "GET",
        timeout: API_TIMEOUT_MS,
        headers: {
          Host: `127.0.0.1:${s.port}`,
          Cookie: `studio=${s.token}`,
          [STUDIO_HEADER]: "1",
          ...(o.body === undefined
            ? {}
            : { "Content-Type": "application/json" }),
        },
      },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (c: string) => {
          text += c;
        });
        res.on("error", (error) => fail(String(error)));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            text,
            json: () => JSON.parse(text) as unknown,
          }),
        );
      },
    );
    req.on("timeout", () => {
      req.destroy();
      fail(`no answer within ${API_TIMEOUT_MS / 1000} s`);
    });
    req.on("error", (error) => fail(String(error)));
    if (o.body !== undefined) req.write(JSON.stringify(o.body));
    req.end();
  });
}

/** What the page says about itself, for a failure message: its notes and
 *  notices, and where focus is. */
export async function pageEvidence(page: Page): Promise<string> {
  return page
    .evaluate(() => {
      const notes = [
        ...document.querySelectorAll("#notes, .notice, [role=alert]"),
      ].map((n) => (n as HTMLElement).innerText.trim());
      return JSON.stringify({
        notes: notes.filter((n) => n !== ""),
        active: document.activeElement?.outerHTML.slice(0, 120) ?? null,
      });
    })
    .catch(
      (error: unknown) => `(the page could not be read: ${String(error)})`,
    );
}

/**
 * Sizes the app window so its page is exactly `width` x `height` CSS px:
 * the window's bounds are set, the frame around the page measured, and the
 * bounds grown by it. Resolves once the page reports that size, and says
 * what it reported if it never does.
 */
export async function sizeWindow(
  context: BrowserContext,
  page: Page,
  width: number,
  height: number,
): Promise<void> {
  const cdp = await context.newCDPSession(page);
  try {
    const { windowId } = (await cdp.send("Browser.getWindowForTarget")) as {
      windowId: number;
    };
    const inner = () =>
      page.evaluate(() => ({ w: innerWidth, h: innerHeight }));
    const setBounds = (w: number, h: number) =>
      cdp.send("Browser.setWindowBounds", {
        windowId,
        bounds: { width: w, height: h, windowState: "normal" },
      });
    await setBounds(width, height);
    let now = await inner();
    if (now.w !== width || now.h !== height) {
      await setBounds(width * 2 - now.w, height * 2 - now.h);
    }
    await vi.waitFor(
      async () => {
        now = await inner();
        if (now.w !== width || now.h !== height) {
          throw new Error(
            `the page is ${now.w}x${now.h}, not ${width}x${height}`,
          );
        }
      },
      { timeout: 10_000, interval: 50 },
    );
  } finally {
    await cdp.detach();
  }
}

/**
 * Waits until the page has stopped moving: no transition or finite
 * animation running (one still in its delay counts), checked after two
 * frames so a resize's own redraw has landed. For geometry read after a
 * resize, a close or a hover change — the condition, not a fixed sleep,
 * which the root CLAUDE.md rules out for the browser lane. The error names
 * what was still moving.
 */
export async function settled(page: Page, timeout = 10_000): Promise<void> {
  await vi.waitFor(
    async () => {
      const moving = await page.evaluate(async () => {
        await new Promise((done) =>
          requestAnimationFrame(() => requestAnimationFrame(done)),
        );
        return document
          .getAnimations()
          .filter(
            (a) =>
              a.playState === "running" &&
              Number.isFinite(a.effect?.getComputedTiming().endTime),
          )
          .map((a) =>
            a instanceof CSSTransition
              ? `transition ${a.transitionProperty}`
              : a instanceof CSSAnimation
                ? `animation ${a.animationName}`
                : "an animation",
          );
      });
      if (moving.length > 0) {
        throw new Error(`still moving: ${moving.join(", ")}`);
      }
    },
    { timeout, interval: 50 },
  );
}

/** Every console line, page error and failed response of `page` from now,
 *  for a failure message and for the no-fault assertion at the end. */
export function watchConsole(page: Page): {
  lines: string[];
  faults: () => string[];
} {
  const lines: string[] = [];
  page.on("console", (m) =>
    lines.push(`${m.type()}: ${m.text()} (${m.location().url})`),
  );
  page.on("pageerror", (e) => lines.push(`pageerror: ${e.message}`));
  page.on("response", (r) => {
    if (r.status() >= 400) {
      lines.push(`response: ${r.status()} ${r.request().method()} ${r.url()}`);
    }
  });
  return {
    lines,
    faults: () =>
      lines.filter(
        (l) =>
          l.startsWith("error") ||
          l.startsWith("warning") ||
          l.startsWith("pageerror") ||
          l.startsWith("response"),
      ),
  };
}

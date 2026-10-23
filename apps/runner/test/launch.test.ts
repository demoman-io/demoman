import { REPLAY_DPR } from "@demoman/replay-engine";
import { chromium } from "playwright";
import { describe, expect, it } from "vitest";
import {
  CONTEXT_DPR,
  CONTEXT_VIEWPORT,
  type Display,
  displayArgs,
  launch,
} from "../src/launch.js";

/**
 * A headless launch's screen, user agent and the decoded size of one
 * screencast frame under the engine's regime (a metrics override at
 * `REPLAY_DPR`). Full Chromium, as the CLI launches it (`apps/cli`'s
 * `executablePath`), not the headless shell a bare `launch()` finds.
 */
async function headlessFilm(display?: Display) {
  const launched = await launch({
    headless: true,
    executablePath: chromium.executablePath(),
    ...(display === undefined ? {} : { display }),
  });
  try {
    const { page, cdp } = launched;
    await page.goto("data:text/html,<body style='margin:0'>");
    const seen = await page.evaluate(() => ({
      screen: [screen.width, screen.height],
      userAgent: navigator.userAgent,
    }));
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width: 640,
      height: 400,
      deviceScaleFactor: REPLAY_DPR,
      mobile: false,
    });
    const errors: string[] = [];
    const heard = (what: string) => (error: unknown) =>
      void errors.push(`${what}: ${String(error)}`);
    // The fifth frame, not the first: the first can be captured while the
    // surface is still resizing to the override (1280x785 seen once).
    let frames = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const frame = new Promise<string>((resolve, reject) => {
      timer = setTimeout(
        () =>
          reject(
            new Error(`no screencast frame in 20 s; ${JSON.stringify(errors)}`),
          ),
        20_000,
      );
      const off = cdp.on("Page.screencastFrame", (params) => {
        const f = params as { data: string; sessionId: number };
        void cdp
          .send("Page.screencastFrameAck", { sessionId: f.sessionId })
          .catch(heard("ack"));
        if (++frames < 5) return;
        off();
        resolve(f.data);
      });
    });
    await cdp.send("Page.startScreencast", { format: "jpeg", quality: 80 });
    // A paint for the screencast to send, repeated until it has.
    let painted = 0;
    const paint = setInterval(() => {
      void page
        .evaluate((n) => {
          document.body.style.background = `hsl(${n * 40} 80% 50%)`;
        }, painted++)
        .catch(heard("paint"));
    }, 50);
    let data: string;
    try {
      data = await frame;
    } finally {
      clearInterval(paint);
      clearTimeout(timer);
    }
    await cdp.send("Page.stopScreencast");
    const decoded = await page.evaluate(async (b64) => {
      const blob = await (await fetch(`data:image/jpeg;base64,${b64}`)).blob();
      const bitmap = await createImageBitmap(blob);
      return [bitmap.width, bitmap.height];
    }, data);
    return { ...seen, frame: decoded };
  } finally {
    await launched.close();
  }
}

describe("launch", () => {
  it("gives the engine a CdpSession whose send/on/detach reach a real browser", async () => {
    const launched = await launch();
    try {
      const result = await launched.cdp.send("Runtime.evaluate", {
        expression: "1 + 1",
        returnByValue: true,
      });
      expect((result.result as { value: number }).value).toBe(2);

      // `Runtime.consoleAPICalled` is only emitted once the domain is
      // enabled — in production the engine itself sends this
      // (`engine.ts`'s own `Runtime.enable`/disable pair); this test drives
      // the raw port directly, with no engine in between, so it has to ask
      // for the same thing the engine otherwise would.
      await launched.cdp.send("Runtime.enable");

      // `on` returns an unsubscribe, and the engine relies on it: the
      // occlusion guard subscribes per run and a leak would accumulate.
      let beats = 0;
      const off = launched.cdp.on("Runtime.consoleAPICalled", () => {
        beats++;
      });
      await launched.page.evaluate(() => console.log("x"));
      await expect.poll(() => beats).toBeGreaterThan(0);
      const seen = beats;
      off();
      await launched.page.evaluate(() => console.log("y"));
      // Poll for a condition, never sleep: the assertion is that the count
      // stays put while another event definitely arrives at the page.
      await launched.page.evaluate(() => console.log("z"));
      expect(beats).toBe(seen);
    } finally {
      await launched.close();
    }
    // Measured here (this developer's Mac, three repeated runs): the whole
    // test, launch through close, is consistently ~105-106ms. CI is ~5x
    // slower at browser work (see vitest.config.ts's own note), which would
    // put it at ~550ms — but a first-ever launch anywhere (cold OS file
    // cache for the Chromium binary, a container with less to spare) can
    // cost far more than a warm repeated one, so this keeps the 30s already
    // used by cdp-playwright.ts's own browser-lane tests and by this task's
    // brief rather than tightening to the measured number.
  }, 30_000);

  it("puts a headless Chrome on the display it is given, and films motion at that display's scale", async () => {
    const display = { width: 1000, height: 700, scale: 2 };
    expect(displayArgs(display)).toEqual([
      "--screen-info={2000x1400 devicePixelRatio=2}",
      "--window-size=1000,700",
    ]);
    const on = await headlessFilm(display);
    const off = await headlessFilm();
    // The control: without a display, a headless screencast films the
    // override's CSS size at 1x, which is the gap this closes.
    expect(off.frame, JSON.stringify(off)).toEqual([640, 400]);
    expect(off.userAgent).toContain("HeadlessChrome/");
    expect(on.frame, JSON.stringify(on)).toEqual([1280, 800]);
    expect(on.screen).toEqual([1000, 700]);
    expect(on.userAgent).not.toContain("Headless");
    expect(on.userAgent).toContain("Chrome/");
  }, 60_000);

  // The user agent is cosmetic: a launch whose rewrite of it fails still
  // films, with the browser's own, and says why.
  it("launches on its display when the user agent cannot be read, and says so", async () => {
    const said: string[] = [];
    const launched = await launch({
      headless: true,
      executablePath: chromium.executablePath(),
      display: { width: 1000, height: 700, scale: 2 },
      log: (line) => said.push(line),
      userAgentOf: async () => {
        throw new Error("Browser.getVersion refused");
      },
    });
    try {
      await launched.page.goto("data:text/html,<p>x");
      const seen = await launched.page.evaluate(() => [
        navigator.userAgent,
        screen.width,
      ]);
      // Premise: still on the display it was given.
      expect(seen[1]).toBe(1000);
      expect(seen[0]).toContain("HeadlessChrome/");
      expect(said.join("\n")).toContain("Browser.getVersion refused");
    } finally {
      await launched.close();
    }
  }, 30_000);

  // Measured 2026-10-21 on full Chromium 151: headless's client hints already
  // name "Chromium", as a visible window's do, so the user agent string is
  // the one thing that said headless. This holds that, so a Chromium that
  // starts naming HeadlessChrome in Sec-CH-UA turns this red.
  it("sends client hints that name no headless brand", async () => {
    const { createServer } = await import("node:http");
    const server = createServer((_q, r) => void r.end("<p>x")).listen(0);
    const address = server.address() as { port: number };
    const launched = await launch({
      headless: true,
      executablePath: chromium.executablePath(),
      display: { width: 1000, height: 700, scale: 2 },
    });
    try {
      let header: string | undefined;
      launched.page.on("request", (r) => {
        header ??= r.headers()["sec-ch-ua"];
      });
      await launched.page.goto(`http://localhost:${address.port}/`);
      const brands = await launched.page.evaluate(() =>
        (
          navigator as unknown as {
            userAgentData?: { brands: { brand: string }[] };
          }
        ).userAgentData?.brands.map((b) => b.brand),
      );
      // Premise: both were read (a secure context, a request seen).
      expect(header, String(header)).toContain("Chromium");
      expect(brands).toContain("Chromium");
      expect(header).not.toMatch(/headless/i);
      expect(brands?.join(",")).not.toMatch(/headless/i);
    } finally {
      await launched.close();
      server.close();
    }
  }, 30_000);

  it("creates the context at a viewport no scene uses, so the emulation override can be proved", () => {
    expect(CONTEXT_VIEWPORT).toEqual({ width: 1024, height: 640 });
    expect(CONTEXT_DPR).toBe(1);
    // The scene the acceptance test replays is 1280x800 at DPR 3. If these
    // ever coincide, Task 10's keyframe-dimension assertion proves nothing.
    expect(CONTEXT_DPR).not.toBe(REPLAY_DPR);
  });

  it("close() is a no-op the second time, and warns neither time when the browser closed cleanly", async () => {
    const launched = await launch();
    const warnings: unknown[][] = [];
    const originalWarn = console.warn;
    // vi.spyOn(console, "warn") is a known trap in this repo's *other*
    // browser lane (apps/extension's @vitest/browser project): the module
    // under test runs inside the browser page, in a different console
    // binding than the spy patches, so the spy observes nothing and the
    // assertion passes vacuously (see the "Browser-lane spy trap" note).
    // That trap does not apply here — launch.ts runs in this same Node
    // process as the test, there is no page-injected module — but this
    // reassignment is the repo's own established workaround, so it is used
    // here too rather than trusting vi.spyOn to reach across a boundary
    // that, in this file, does not exist.
    console.warn = (...args: unknown[]) => {
      warnings.push(args);
    };
    try {
      await expect(launched.close()).resolves.toEqual({ crashed: false });
      expect(warnings).toEqual([]);
      // A second close, on a browser this close() itself already closed
      // cleanly: still a no-op, still no warning about a crash that never
      // happened.
      await expect(launched.close()).resolves.toEqual({ crashed: false });
      expect(warnings).toEqual([]);
    } finally {
      console.warn = originalWarn;
    }
    // Measured here (three repeated runs): ~82-90ms (one Chromium launch +
    // a clean close). Same 30s floor as the test above, for the same
    // first-launch-anywhere reason.
  }, 30_000);

  it("close() on a browser that died before close() ran is safe, and says so instead of reporting a clean shutdown", async () => {
    const launched = await launch();
    const warnings: unknown[][] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(args);
    };
    try {
      // Stands in for Task 6's measured cause (a page.evaluate call
      // carrying ~70+ large frames' base64 kills the whole browser, not
      // just the page) without paying for an 80MB transfer in every test
      // run: from launch()'s own close() forward, "the browser was already
      // disconnected when close() ran" is the same state whether it got
      // there by a giant page.evaluate or by this direct call. Reaching
      // for the real crash here would make this test slow and, per one
      // reproduction that hung rather than crashed, nondeterministic —
      // this reaches the exact state close() branches on, reliably.
      await launched.browser.close();
      expect(launched.browser.isConnected()).toBe(false);

      // Safe to call: does not throw, does not hang — and not a silent
      // success either. Runner audit 2026-09-14, finding 2: this used to
      // be a `console.warn`, which the pipeline's `finally` emitted BEFORE
      // the CLI printed the result it explains (the same ordering defect
      // the whole-branch review's finding 9 fixed for the scratch notes),
      // and which an in-process consumer never saw at all. The distinction
      // rides on the return value now, for `runPipeline` to turn into a
      // note; nothing is written to the console here.
      await expect(launched.close()).resolves.toEqual({ crashed: true });
      expect(warnings).toEqual([]);
    } finally {
      console.warn = originalWarn;
    }
    // Measured here (three repeated runs): ~82-86ms (one Chromium launch +
    // an already-closed browser, no page work). Same 30s floor, same reason.
  }, 30_000);
});

import { execFileSync } from "node:child_process";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REPLAY_DPR } from "@demoman/replay-engine";
import { type Browser, chromium } from "playwright";
import { describe, expect, it } from "vitest";
import {
  CONTEXT_DPR,
  CONTEXT_VIEWPORT,
  type Display,
  displayArgs,
  HEADLESS_GPU_ARGS,
  killBrowser,
  launch,
  launchFailure,
  macUserAgent,
  sandboxBlockers,
} from "../src/launch.js";

// Red when a cause is dropped, claimed from a setting that could not be
// read, or claimed off Linux (DEM-120).
describe("sandboxBlockers", () => {
  const proc = (values: Record<string, string>) => (path: string) => {
    const v = values[path];
    if (v === undefined) throw new Error(`ENOENT: ${path}`);
    return v;
  };
  it("names root and each user-namespace rule this Linux has", () => {
    expect(
      sandboxBlockers(
        proc({
          "/proc/sys/kernel/apparmor_restrict_unprivileged_userns": "1",
          "/proc/sys/kernel/unprivileged_userns_clone": "0",
          "/proc/sys/user/max_user_namespaces": "0",
        }),
        0,
        "linux",
      ),
    ).toEqual([
      "it runs as root",
      "AppArmor restricts unprivileged user namespaces (kernel.apparmor_restrict_unprivileged_userns=1)",
      "unprivileged user namespaces are off (kernel.unprivileged_userns_clone=0)",
      "user namespaces are off (user.max_user_namespaces=0)",
    ]);
  });
  it("claims nothing it could not read, and nothing off Linux", () => {
    expect(sandboxBlockers(proc({}), 1000, "linux")).toEqual([]);
    expect(
      sandboxBlockers(
        proc({ "/proc/sys/user/max_user_namespaces": "63000" }),
        1000,
        "linux",
      ),
    ).toEqual([]);
    expect(sandboxBlockers(proc({}), 0, "darwin")).toBeNull();
  });
});

// Red when the FATAL line loses to an earlier stderr line, the reason is
// dropped for Playwright's first line alone (DEM-120), unrelated stderr
// is offered as the reason, or a boxed error says only its prefix.
describe("launchFailure", () => {
  const closed =
    "browserType.launch: Target page, context or browser has been closed";
  const bus =
    "[pid=812][err] [812:830:ERROR:bus.cc(407)] Failed to connect to the bus";
  it("names Chromium's FATAL line after Playwright's first", () => {
    const message = [
      closed,
      "Browser logs:",
      "",
      "<launching> /ms-playwright/chromium/chrome --headless",
      "<launched> pid=812",
      bus,
      "[pid=812][err] [812:812:FATAL:zygote_host_impl_linux.cc(128)] No usable sandbox!",
      "Call log:",
      "  - <launching> /ms-playwright/chromium/chrome",
    ].join("\n");
    expect(launchFailure(message)).toEqual({
      missingLibraries: false,
      line: `${closed}: [812:812:FATAL:zygote_host_impl_linux.cc(128)] No usable sandbox!`,
    });
  });
  it("takes a namespace line without FATAL, and never unrelated stderr", () => {
    const ns =
      "[pid=812][err] [812:812:ERROR:namespace_sandbox.cc] Failed to move to new namespace: errno = Operation not permitted";
    expect(launchFailure([closed, bus, ns].join("\n")).line).toBe(
      `${closed}: ${ns.replace("[pid=812][err] ", "")}`,
    );
    expect(launchFailure([closed, bus].join("\n")).line).toBe(closed);
  });
  it("reads a boxed error past its bare first line", () => {
    const boxed = [
      "browserType.launch: ",
      "╔══════════════════════╗",
      "║ Looks like Playwright was just installed or updated. ║",
      "╚══════════════════════╝",
    ].join("\n");
    expect(launchFailure(boxed).line).toBe(
      "browserType.launch: Looks like Playwright was just installed or updated.",
    );
  });
});

/**
 * A headless launch's screen, user agent and the decoded size of one
 * screencast frame under the engine's regime (a metrics override at
 * `REPLAY_DPR`). Full Chromium, as the CLI launches it (`apps/cli`'s
 * `executablePath`), not the headless shell a bare `launch()` finds.
 */
async function headlessFilm(display?: Display, scale?: number) {
  const launched = await launch({
    headless: true,
    executablePath: chromium.executablePath(),
    ...(display === undefined ? {} : { display }),
    ...(scale === undefined ? {} : { scale }),
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

/** TCP servers listening in this process: where a browser server would be. */
const listeners = (): number =>
  process.getActiveResourcesInfo().filter((r) => r === "TCPServerWrap").length;

/** Whether `pid` is still a live process. */
const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe("launch", () => {
  // Red: `chromium.launchServer()` + `connect()`, whose loopback listener
  // answers GET /json with its secret path and hands browser-level CDP to
  // any local peer (audit run 1).
  it("opens no listening port while its browser runs", async () => {
    const before = listeners();
    const launched = await launch();
    try {
      // Premise: the browser is up and answering.
      expect(launched.browser.isConnected()).toBe(true);
      expect(listeners()).toBe(before);
    } finally {
      await launched.close();
    }
  }, 30_000);

  // DEM-120. Red: drop `chromiumSandbox: true` from `launchSandboxed`;
  // Playwright then adds `--no-sandbox`. Strict on macOS, which always
  // sandboxes; a Linux that cannot must say so, and only then go without.
  it("runs Chromium with its sandbox, or says why it cannot", async () => {
    const logs: string[] = [];
    const launched = await launch({ log: (l) => logs.push(l) });
    try {
      // The process's own argv: Browser.getBrowserCommandLine answers only
      // under --enable-automation, which Playwright does not pass.
      const cdp = await launched.browser.newBrowserCDPSession();
      const { processInfo } = await cdp.send("SystemInfo.getProcessInfo");
      await cdp.detach();
      const pid = processInfo.find((p) => p.type === "browser")?.id;
      expect(pid, JSON.stringify(processInfo)).toBeTypeOf("number");
      const argv = execFileSync(
        "ps",
        ["-ww", "-o", "args=", "-p", String(pid)],
        {
          encoding: "utf8",
        },
      ).split(" ");
      const evidence = `${argv.join(" ")}\nlog: ${logs.join("\n")}`;
      // Premise: this is the command line launch() built, not some other.
      expect(argv, evidence).toContain("--headless");
      // Either line: this launch's own failure, or one earlier in the file
      // (a launch with no log, as GitHub's Ubuntu runners give, 2026-11-18).
      const without = logs.some((l) => l.includes("runs without"));
      if (process.platform === "darwin") expect(without, evidence).toBe(false);
      expect(argv.includes("--no-sandbox"), evidence).toBe(without);
    } finally {
      await launched.close();
    }
  }, 30_000);

  // Red: rethrow instead of relaunching, relaunch without the log line,
  // relaunch only on Playwright's "Chromium sandboxing failed!" rewrite, or
  // stay quiet on a launch after the first.
  it("launches without the sandbox on a machine that cannot run it, and says so every time", async () => {
    const dir = await mkdtemp(join(tmpdir(), "demoman-nosandbox-"));
    const exe = join(dir, "chrome");
    const tries = join(dir, "tries");
    // Fails unless told --no-sandbox, then is the real browser. Its words
    // are a namespace failure Playwright does not rewrite. Each sandboxed
    // try leaves a line in `tries`.
    await writeFile(
      exe,
      `#!/bin/sh\ncase " $* " in *" --no-sandbox "*) exec "${chromium.executablePath()}" "$@";; esac\necho x >> "${tries}"\necho "Failed to move to new namespace (stand-in)" >&2\nexit 1\n`,
    );
    await chmod(exe, 0o755);
    const logs: string[] = [];
    const log = (l: string) => logs.push(l);
    const launched = await launch({ executablePath: exe, log });
    try {
      // Premise: the relaunch reached a real browser.
      expect(launched.browser.isConnected()).toBe(true);
      expect(logs.join("\n")).toContain(
        "would not start with Chromium's sandbox",
      );
      // Red when only Playwright's first line is kept: on CI that was
      // "Target page, context or browser has been closed", with Chromium's
      // own reason (its stderr, under "Browser logs") dropped.
      expect(logs.join("\n")).toContain(
        "Failed to move to new namespace (stand-in)",
      );
      // Red when the fallback stops saying what this Linux shows.
      if (process.platform === "linux")
        expect(logs.join("\n")).toContain("; this machine");
    } finally {
      await launched.close();
    }
    // The next launch, with another log, goes straight without it (no
    // second sandboxed try) and still says so.
    const later: string[] = [];
    const again = await launch({
      executablePath: exe,
      log: (l) => later.push(l),
    });
    try {
      expect(again.browser.isConnected()).toBe(true);
      expect(await readFile(tries, "utf8")).toBe("x\n");
      expect(later.join("\n")).toContain("earlier in this process");
    } finally {
      await again.close();
    }
  }, 30_000);

  // Red: throw the relaunch's error without the first one's words.
  it("names both failures when the browser will not start either way", async () => {
    const dir = await mkdtemp(join(tmpdir(), "demoman-nobrowser-"));
    const exe = join(dir, "chrome");
    await writeFile(
      exe,
      `#!/bin/sh\necho "nothing here (stand-in)" >&2\nexit 1\n`,
    );
    await chmod(exe, 0o755);
    const logs: string[] = [];
    const failed = await launch({
      executablePath: exe,
      log: (l) => logs.push(l),
    })
      .then(() => null)
      .catch((error: unknown) => String(error));
    expect(failed).toContain("with its sandbox, it had failed first");
    // Nothing claims a browser runs.
    expect(logs).toEqual([]);
  }, 30_000);

  // Red: drop endBrowser's kill, leaving only `browser.close()`, which waits
  // on a browser that will never answer. A stopped process stands in for a
  // hung one; SIGKILL still reaches it.
  it("close() ends a browser that will not answer, within its grace", async () => {
    const launched = await launch();
    const cdp = await launched.browser.newBrowserCDPSession();
    const { processInfo } = await cdp.send("SystemInfo.getProcessInfo");
    await cdp.detach();
    const pid = processInfo.find((p) => p.type === "browser")?.id as number;
    expect(alive(pid)).toBe(true);
    process.kill(pid, "SIGSTOP");
    const started = Date.now();
    await launched.close();
    expect(alive(pid), "the browser outlived close()").toBe(false);
    // Measured: the 5 s grace, then the kill.
    expect(Date.now() - started).toBeLessThan(15_000);
  }, 30_000);

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
    // Every launch presents as macOS, display or not (DEM-154).
    expect(off.userAgent).toContain("(Macintosh;");
    expect(off.userAgent).not.toContain("Headless");
    expect(on.frame, JSON.stringify(on)).toEqual([1280, 800]);
    expect(on.screen).toEqual([1000, 700]);
    expect(on.userAgent).not.toContain("Headless");
    expect(on.userAgent).toContain("Chrome/");
  }, 60_000);

  // Spec 2026-11-13 part 2, a machine with no readable display: Chrome's own
  // stand-in screen is given the scale and no size. Turns red when launch()
  // drops the `--screen-info={devicePixelRatio=S}` line (launch.ts): the
  // frame decodes at the override's CSS size, 640x400.
  it("gives Chrome's own stand-in screen a scale without naming its size", async () => {
    const scaled = await headlessFilm(undefined, 2);
    const off = await headlessFilm();
    // Premise: the control films at 1x, so 2x below came from the scale.
    expect(off.frame, JSON.stringify(off)).toEqual([640, 400]);
    expect(scaled.frame, JSON.stringify(scaled)).toEqual([1280, 800]);
    // The screen is Chrome's own, as without a scale: no size was guessed.
    expect(scaled.screen).toEqual(off.screen);
  }, 60_000);

  // Headless draws a page's 2D canvas on the CPU without HEADLESS_GPU_ARGS:
  // the same sample-app export rendered in 174.7 s without them and 9.6 s
  // with (measured 2026-10-25, M4, `compare/export-variants.mjs`). That
  // cost is a measurement, not a test; this holds that the flag reaches the
  // browser, which an args object built beside the launch once did not.
  it.runIf(HEADLESS_GPU_ARGS.length > 0)(
    "asks a headless Chrome for the GPU",
    async () => {
      // The browser process's own argv, read from the OS: CDP's
      // Browser.getBrowserCommandLine refuses without --enable-automation.
      const commandLine = async (browser: Browser) => {
        const session = await browser.newBrowserCDPSession();
        try {
          const { processInfo } = await session.send(
            "SystemInfo.getProcessInfo",
          );
          const pid = processInfo.find((p) => p.type === "browser")?.id;
          return execFileSync("ps", ["-o", "command=", "-p", String(pid)])
            .toString()
            .trim()
            .split(" ");
        } finally {
          await session.detach();
        }
      };
      const launched = await launch({
        headless: true,
        executablePath: chromium.executablePath(),
      });
      const asked = await commandLine(launched.browser).finally(() =>
        launched.close(),
      );
      const bare = await chromium.launch({
        headless: true,
        executablePath: chromium.executablePath(),
      });
      const control = await commandLine(bare).finally(() => bare.close());
      // Premise: the command line is readable, and Chrome does not ask for
      // the GPU by itself.
      expect(control, control.join(" ")).toContain("--headless");
      for (const arg of HEADLESS_GPU_ARGS) expect(control).not.toContain(arg);
      expect(asked, asked.join(" ")).toEqual(
        expect.arrayContaining(HEADLESS_GPU_ARGS),
      );
    },
    30_000,
  );

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
    // vi.spyOn(console, "warn") is a known trap in a @vitest/browser lane
    // (it bit the retired apps/extension's): the module
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

describe("the Mac platform script", () => {
  // The host's own platform is hidden by overriding it over CDP, so these
  // read the same on a Mac and on Linux.
  const platformUnder = async (
    userAgent: string,
    platform: string,
    plain = false,
  ) => {
    const launched = await launch({
      headless: true,
      executablePath: chromium.executablePath(),
    });
    try {
      // The plain context has no init script: the premise's control.
      const context = plain
        ? await launched.browser.newContext()
        : launched.context;
      const page = plain ? await context.newPage() : launched.page;
      const session = await context.newCDPSession(page);
      await session.send("Emulation.setUserAgentOverride", {
        userAgent,
        platform,
      });
      await page.goto("data:text/html,<p>x");
      await page.reload();
      return await page.evaluate(() => navigator.platform);
    } finally {
      await launched.close();
    }
  };
  const iPhone =
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";

  it("makes a Mac page say MacIntel even on another host", async () => {
    const browser = await chromium.launch({
      executablePath: chromium.executablePath(),
    });
    const mac = macUserAgent(browser.version());
    await browser.close();
    // Premise: without the init script (a plain context) the override reads
    // as the host Linux, so the script is what changes it.
    expect(await platformUnder(mac, "Linux x86_64", true)).toBe("Linux x86_64");
    expect(await platformUnder(mac, "Linux x86_64")).toBe("MacIntel");
  }, 60_000);

  it("keeps a non-Mac user agent's own platform", async () => {
    expect(await platformUnder(iPhone, "iPhone")).toBe("iPhone");
  }, 60_000);
});

describe("killBrowser", () => {
  const gone = () => {
    throw Object.assign(new Error("kill ESRCH"), { code: "ESRCH" });
  };

  it("answers that a browser which exited before the kill is gone, and throws nothing", () => {
    // Red: the fallback kill unguarded, so close() rejected on a browser that
    // ended itself between the alive check and the SIGKILL (audit review).
    const lines: string[] = [];
    expect(killBrowser(4242, (l) => lines.push(l), gone)).toBe(false);
    expect(lines).toEqual([]);
  });

  it("says why when the kill is refused for another reason", () => {
    const lines: string[] = [];
    const refused = () => {
      throw Object.assign(new Error("kill EPERM"), { code: "EPERM" });
    };
    expect(killBrowser(4242, (l) => lines.push(l), refused)).toBe(false);
    expect(lines).toEqual([
      "the browser (pid 4242) could not be killed (Error: kill EPERM)",
    ]);
  });

  it("kills the group when it can", () => {
    const sent: number[] = [];
    expect(killBrowser(4242, undefined, (pid) => sent.push(pid))).toBe(true);
    expect(sent).toEqual([-4242]);
  });
});

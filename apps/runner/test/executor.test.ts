import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type RunReport, verdictLine } from "@demoman/run-core";
import type { Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLibrary } from "../src/executor/library.js";
import {
  createLocalExecutor,
  type LocalExecutor,
} from "../src/package-entry.js";
import {
  makeFixtureTake,
  ownVideo,
  serveFixtureApp,
  WALLPAPERS_DIR,
} from "./fixture.js";

// Measured locally (2026-10-12, M-series Mac, headless) inside the full
// runner suite, x5 for CI (fff4505). A run: 6.2 s at the slowest. An export
// at 9:16 (1080x1920): 21.8 s at the slowest. Every export in this file is
// 9:16: the landscape tier for these takes is 4K, about 6x slower headless.
const RUN_MS = 31_000;
const VERTICAL_EXPORT_MS = 120_000;

let app: { url: string; close(): void };
let home: string;
let outDir: string;
let executor: ReturnType<typeof createLocalExecutor>;
const homes: string[] = [];

const freshHome = async () => {
  const made = await mkdtemp(join(tmpdir(), "demoman-exec-"));
  homes.push(made);
  return made;
};

beforeAll(async () => {
  app = await serveFixtureApp();
  home = await freshHome();
  // Never ~/Downloads: a test's export lands in its own temp folder.
  outDir = join(home, "out");
  executor = createLocalExecutor({
    wallpapersDir: WALLPAPERS_DIR,
    home,
    headless: true,
    outDir,
    log: () => undefined,
  });
}, 30_000);
afterAll(async () => {
  await executor.close();
  app.close();
  for (const made of homes) await rm(made, { recursive: true, force: true });
}, 30_000);

/**
 * An executor (on this file's home) whose browser launch stays pending until
 * `release()` rejects it with "launch gave way" — at once if the launch was
 * already asked for, else the moment it is. So a run holds the slot, with no
 * browser, for as long as a case needs it to.
 */
function executorWithPendingLaunch(): {
  executor: LocalExecutor;
  release(): void;
  launchRequested(): boolean;
} {
  let released = false;
  let requested = false;
  let reject: ((error: Error) => void) | null = null;
  const pending = createLocalExecutor({
    wallpapersDir: WALLPAPERS_DIR,
    home,
    headless: true,
    outDir,
    log: () => undefined,
    launchFn: () =>
      new Promise((_resolve, fail) => {
        requested = true;
        if (released) fail(new Error("launch gave way"));
        else reject = fail;
      }),
  });
  return {
    executor: pending,
    release() {
      released = true;
      reject?.(new Error("launch gave way"));
    },
    launchRequested: () => requested,
  };
}

/**
 * Starts an export and resolves `reached` once its progress (what `report`
 * reads) satisfies `until` — the condition, not a duration. Rejects
 * `reached` with the answer if the export settles first.
 */
function exportUntil(
  ex: LocalExecutor,
  args: Record<string, unknown>,
  until: (progress: Record<string, unknown>) => boolean,
): { settled: ReturnType<LocalExecutor["request"]>; reached: Promise<void> } {
  let hit: () => void = () => undefined;
  const seen = new Promise<void>((resolve) => {
    hit = resolve;
  });
  const settled = ex.request("export", args, (progress) => {
    if (until(progress as Record<string, unknown>)) hit();
  });
  const reached = Promise.race([
    seen,
    settled.then((answer) => {
      throw new Error(
        `the export settled before its progress met the condition: ${JSON.stringify(answer)}`,
      );
    }),
  ]);
  return { settled, reached };
}

const fixtureScript = () => ({
  scriptVersion: 1,
  name: "place an order",
  target: app.url,
  viewport: { width: 1280, height: 800 },
  steps: [{ do: "waitForLoad" }, { do: "click", on: { text: "Place order" } }],
});

describe("createLocalExecutor", () => {
  it("answers status without launching a browser", async () => {
    const out = await executor.request("status", {});
    expect(out).toEqual({
      ok: true,
      value: expect.objectContaining({
        executor: "cli",
        allowAgentRuns: true,
        browserRunning: false,
        runPage: null,
      }),
    });
    expect(executor.browser()).toBeNull();
  }, 30_000);

  // Launch B: status tells "not installed" from "not started yet", which
  // browserRunning: false cannot, without launching anything.
  it("says whether Chromium is installed, without launching it", async () => {
    const missing = createLocalExecutor({
      wallpapersDir: WALLPAPERS_DIR,
      home,
      headless: true,
      log: () => undefined,
      executablePath: join(home, "no-chromium-here"),
    });
    try {
      const a = await missing.request("status", {});
      const b = await executor.request("status", {});
      expect(
        a.ok && (a.value as { browserInstalled: boolean }).browserInstalled,
      ).toBe(false);
      // The control: this machine runs the lane, so its Chromium is there.
      expect(
        b.ok && (b.value as { browserInstalled: boolean }).browserInstalled,
      ).toBe(true);
      expect(missing.browser()).toBeNull();
    } finally {
      await missing.close();
    }
  });

  // Before the first film, not after it: a headless server that cannot read
  // the display films every take at 1x, and the first call an agent makes
  // is where it can tell the user how to fix that.
  it("says, in status, the display headless films as, or why it cannot read one", async () => {
    const blind = createLocalExecutor({
      wallpapersDir: WALLPAPERS_DIR,
      home,
      headless: true,
      standInDisplay: true,
      env: { DEMOMAN_DISPLAY: "nonsense" },
      log: () => undefined,
    });
    const seeing = createLocalExecutor({
      wallpapersDir: WALLPAPERS_DIR,
      home,
      headless: true,
      standInDisplay: true,
      env: { DEMOMAN_DISPLAY: "1710x1107@2" },
      log: () => undefined,
    });
    try {
      const a = await blind.request("status", {});
      const b = await seeing.request("status", {});
      const shown = (o: typeof a) =>
        o.ok ? (o.value as { display?: unknown }).display : o;
      expect(shown(a), JSON.stringify(a)).toEqual({
        unreadable: expect.stringContaining('DEMOMAN_DISPLAY is "nonsense"'),
      });
      expect(JSON.stringify(shown(a))).toContain("--headed");
      expect(shown(b), JSON.stringify(b)).toEqual({
        width: 1710,
        height: 1107,
        scale: 2,
      });
      // Read without launching anything.
      expect(blind.browser()).toBeNull();
      expect(seeing.browser()).toBeNull();
    } finally {
      await blind.close();
      await seeing.close();
    }
  });

  it("refuses an invalid script before opening anything", async () => {
    const out = await executor.request("run", {
      video: ownVideo(),
      script: { name: "x" },
      callId: "c0",
    });
    expect(out.ok).toBe(true);
    if (out.ok)
      expect(out.value).toMatchObject({
        outcome: "refusedBeforeRun",
        reason: "invalidScript",
      });
    expect(executor.browser()).toBeNull();
  }, 30_000);

  it("refuses a kit the library does not have as unknownKit", async () => {
    const out = await executor.request("run", {
      video: ownVideo(),
      script: { ...fixtureScript(), scriptVersion: 2, look: { kit: "Nope" } },
      callId: "c1",
    });
    if (!out.ok) throw new Error(JSON.stringify(out));
    expect(out.value).toMatchObject({
      outcome: "refusedBeforeRun",
      reason: "unknownKit",
      field: "look.kit",
    });
  }, 30_000);

  it("a second run while one is in flight is refused, and the first is untouched", async () => {
    const progress: unknown[] = [];
    const first = executor.request(
      "run",
      { video: ownVideo(), script: fixtureScript(), callId: "r1" },
      (v) => progress.push(v),
    );
    // Wait until the first run has taken the slot (its first paint), bounded.
    const deadline = Date.now() + 60_000;
    while (progress.length === 0) {
      if (Date.now() > deadline)
        throw new Error("the first run never painted progress within 60 s");
      await new Promise((r) => setTimeout(r, 50));
    }
    const second = await executor.request("run", {
      video: ownVideo(),
      script: fixtureScript(),
      callId: "r2",
    });
    expect(second).toMatchObject({
      ok: true,
      value: { outcome: "refusedBeforeRun", reason: "alreadyRunning" },
    });
    // While in flight, report(r1) is the running envelope.
    const mid = await executor.request("report", { id: "r1", of: "run" });
    expect(mid).toMatchObject({ ok: true, value: { outcome: "running" } });
    const done = await first;
    expect(done).toMatchObject({
      ok: true,
      value: { outcome: "complete", run: { executor: "cli" } },
    });
    // The run page's own line, which the agent's terminal shows first.
    // Red without the summary field in the run's answer.
    const report = (done as { value: RunReport }).value;
    expect((done as { value: { summary?: string } }).value.summary).toBe(
      verdictLine(report),
    );
    expect(verdictLine(report)).toMatch(/^Complete/);
    // The line a person reads names each step. Red if the engine's step
    // count stops agreeing with the script's: runningWords then says only
    // the number, and no step is named.
    const doing = progress.map((v) => (v as { doing?: string }).doing);
    expect(doing[0], JSON.stringify(doing)).toBe("starting");
    expect(
      doing.some((d) => /^step 1 of \d+ · \S/.test(d ?? "")),
      JSON.stringify(doing),
    ).toBe(true);
    expect(await executor.request("report", { id: "r1", of: "run" })).toEqual(
      done,
    );
    expect(executor.browser()).toMatch(/\d+\.\d+/);
  }, 180_000);

  it("report and status show the running run while the browser launch is still pending", async () => {
    const {
      executor: slow,
      release,
      launchRequested,
    } = executorWithPendingLaunch();
    try {
      const pending = slow.request("run", {
        video: ownVideo(),
        script: fixtureScript(),
        callId: "slow1",
      });
      // Before anything was awaited, the run is already listed.
      expect(
        await slow.request("report", { id: "slow1", of: "run" }),
      ).toMatchObject({ ok: true, value: { outcome: "running", step: 0 } });
      // The launch is requested after the video is found and the kits are
      // read; wait for it, bounded.
      const deadline = Date.now() + 10_000;
      while (!launchRequested()) {
        if (Date.now() > deadline)
          throw new Error("the run never asked to launch a browser");
        await new Promise((r) => setTimeout(r, 20));
      }
      // The launch has not resolved: the run holds the slot and no browser exists.
      const mid = await slow.request("report", { id: "slow1", of: "run" });
      expect(slow.browser()).toBeNull();
      expect(mid).toMatchObject({
        ok: true,
        value: {
          outcome: "running",
          summary: "Running — starting.",
          step: 0,
          of: expect.any(Number),
        },
      });
      const status = await slow.request("status", {});
      expect(status).toMatchObject({
        ok: true,
        value: { runPage: { outcome: "running", step: 0 } },
      });
      release();
      // The launch failure ends the run with a refusal, not a hang.
      expect(await pending).toMatchObject({
        ok: true,
        value: { outcome: "refusedBeforeRun" },
      });
    } finally {
      release();
      await slow.close();
    }
  }, 30_000);

  // Review Focus 5. Red if export does not check the slot.
  it("refuses an export while a run holds the browser, as busy, and leaves the run alone", async () => {
    const { executor: held, release } = executorWithPendingLaunch();
    try {
      const running = held.request("run", {
        video: ownVideo(),
        callId: "r-busy",
        script: fixtureScript(),
      });
      const out = await held.request("export", {
        takeId: "scene-x",
        callId: "e-busy",
      });
      expect(out).toMatchObject({
        ok: true,
        value: { outcome: "refusedBeforeExport", reason: "busy" },
      });
      expect((out as { value: { detail: string } }).value.detail).toMatch(
        /report/,
      );
      expect((out as { value: { summary: string } }).value.summary).toMatch(
        /^Not exported: /,
      );
      release();
      const ran = await running;
      // The run ends as its own launch failure says, not as the export's.
      expect(ran).toMatchObject({
        ok: true,
        value: { outcome: "refusedBeforeRun", reason: "windowDidNotOpen" },
      });
      expect(await held.request("report", { id: "r-busy", of: "run" })).toEqual(
        ran,
      );
    } finally {
      release();
      await held.close();
    }
  }, 30_000);

  it("answers noReport for a call it never ran", async () => {
    expect(
      await executor.request("report", { id: "never", of: "run" }),
    ).toMatchObject({
      ok: false,
      reason: "noReport",
    });
  }, 30_000);

  it("lists the take the run made and derives a script from it", async () => {
    const takes = await executor.request("takes", {});
    if (!takes.ok) throw new Error(JSON.stringify(takes));
    const list = takes.value as Array<{ id: string }>;
    expect(list.length).toBeGreaterThan(0);
    const derived = await executor.request("derive", { takeId: list[0]?.id });
    expect(derived).toMatchObject({
      ok: true,
      value: { report: { outcome: "derived" } },
    });
  }, 60_000);

  it(
    "exports a take it made, and refuses one it did not",
    async () => {
      const takes = await executor.request("takes", {});
      if (!takes.ok) throw new Error(JSON.stringify(takes));
      const id = (takes.value as Array<{ id: string }>)[0]?.id;
      // The premise: an earlier case in this file made a take.
      expect(id).toBeDefined();
      // 9:16: 1080x1920, where this take's landscape tier is 4K and ~6x
      // slower headless. What is pinned here is "saved", not the shape.
      const lib = createLibrary(home);
      const doc = await lib.getScene(id as string);
      if (doc === null) throw new Error(`take ${id} is not in the library`);
      await lib.putScene({ ...doc, canvas: { aspect: "9:16" } });
      const saved = await executor.request("export", {
        takeId: id,
        callId: "e1",
      });
      expect(saved, JSON.stringify(saved)).toMatchObject({
        ok: true,
        value: { outcome: "saved" },
      });
      expect(
        (saved as { value: { file: { path: string } } }).value.file.path,
      ).toContain(outDir);
      expect(
        await executor.request("export", { takeId: "x", callId: "e2" }),
      ).toMatchObject({
        ok: true,
        value: { outcome: "refusedBeforeExport", reason: "takeNotFound" },
      });
    },
    VERTICAL_EXPORT_MS,
  );

  it("says where exports go in status", async () => {
    const ex = createLocalExecutor({
      wallpapersDir: WALLPAPERS_DIR,
      home: await freshHome(),
      headless: true,
      outDir: "/tmp/x",
      log: () => undefined,
    });
    expect(await ex.request("status", {})).toMatchObject({
      ok: true,
      value: { exportsTo: "/tmp/x" },
    });
    await ex.close();
  });

  describe("status.pullRequests", () => {
    const repoWith = async (config: string | null) => {
      const repo = await mkdtemp(join(tmpdir(), "demoman-prrepo-"));
      homes.push(repo);
      await mkdir(join(repo, ".git"));
      if (config !== null) {
        await mkdir(join(repo, ".demoman"));
        await writeFile(join(repo, ".demoman", "config.json"), config);
      }
      return repo;
    };
    const statusIn = async (
      startedIn: string,
      args: Record<string, unknown>,
    ) => {
      const ex = createLocalExecutor({
        wallpapersDir: WALLPAPERS_DIR,
        home: await freshHome(),
        headless: true,
        outDir: "/tmp/x",
        projectDir: startedIn,
        log: () => undefined,
      });
      try {
        return await ex.request("status", args);
      } finally {
        await ex.close();
      }
    };

    it("status reports pullRequests for project", async () => {
      const started = await repoWith(null);
      const other = await repoWith(JSON.stringify({ pullRequests: "attach" }));
      const without = await statusIn(started, {});
      const withProject = await statusIn(started, { project: other });
      // Premise: the started-in repo has none, so the answer below came from
      // `project` and not from where the executor started.
      expect(without).toMatchObject({
        value: { pullRequests: { value: "ask", from: "default" } },
      });
      expect(withProject).toMatchObject({
        ok: true,
        value: {
          pullRequests: {
            value: "attach",
            from: "repo",
            file: join(other, ".demoman", "config.json"),
          },
        },
      });
    }, 30_000);

    // Code review finding 7. Red while a bad project fails status outright:
    // the browser, sessions, accounts and update facts are lost with it.
    it("a relative project costs only pullRequests, which says why", async () => {
      const out = await statusIn(await repoWith(null), {
        project: "relative/path",
      });
      expect(out, JSON.stringify(out)).toMatchObject({
        ok: true,
        value: {
          executor: "cli",
          exportsTo: "/tmp/x",
          browserRunning: false,
          sessions: expect.anything(),
          accounts: expect.anything(),
          pullRequests: {
            unreadable: expect.stringMatching(
              /^project must be an absolute path .*"relative\/path"/,
            ),
            file: null,
          },
        },
      });
      const pr = (out as { value: { pullRequests: object } }).value
        .pullRequests;
      expect(pr).not.toHaveProperty("value");
    }, 30_000);

    it("a project that is not a folder costs only pullRequests, which says why", async () => {
      const out = await statusIn(await repoWith(null), {
        project: "/no/such/folder/anywhere",
      });
      expect(out, JSON.stringify(out)).toMatchObject({
        ok: true,
        value: {
          executor: "cli",
          sessions: expect.anything(),
          accounts: expect.anything(),
          pullRequests: {
            unreadable: "project /no/such/folder/anywhere is not a folder",
            file: null,
          },
        },
      });
    }, 30_000);

    it("an unusable repo file is reported, never off", async () => {
      const bad = await repoWith("{");
      const out = await statusIn(bad, {});
      expect(out).toMatchObject({
        ok: true,
        value: {
          pullRequests: { file: join(bad, ".demoman", "config.json") },
        },
      });
      const pr = (out as { value: { pullRequests: object } }).value
        .pullRequests;
      expect(pr).toHaveProperty("unreadable");
      expect(pr).not.toHaveProperty("value");
    }, 30_000);
  });
});

describe("an export in progress", () => {
  let takeId: string;
  beforeAll(async () => {
    // 9:16: nothing here samples a picture, and its render is ~6x quicker.
    takeId = await makeFixtureTake(executor, {
      home,
      url: app.url,
      aspect: "9:16",
    });
  }, RUN_MS);

  it(
    "refuses a run and a snapshot while an export holds the browser",
    async () => {
      const { settled, reached } = exportUntil(
        executor,
        { takeId, callId: "e-hold" },
        (p) => p.outcome === "exporting",
      );
      try {
        await reached;
        expect(
          await executor.request("report", { id: "e-hold", of: "export" }),
        ).toMatchObject({ ok: true, value: { outcome: "exporting" } });
        expect(
          await executor.request("run", {
            video: ownVideo(),
            callId: "r-hold",
            script: fixtureScript(),
          }),
        ).toMatchObject({
          ok: true,
          value: { outcome: "refusedBeforeRun", reason: "alreadyRunning" },
        });
        expect(
          await executor.request("snapshot", { url: app.url }),
        ).toMatchObject({ ok: false, reason: "alreadyRunning" });
      } finally {
        // Settled whatever failed above: an export left running holds the
        // shared executor's slot, and every later case would read busy.
        await settled;
      }
      expect(await settled).toMatchObject({
        ok: true,
        value: { outcome: "saved" },
      });
    },
    VERTICAL_EXPORT_MS,
  );

  it(
    "answers report(id) for an export in progress as exporting",
    async () => {
      const { settled, reached } = exportUntil(
        executor,
        { takeId, callId: "e-report" },
        () => true,
      );
      try {
        // Asked before anything is awaited: the export has made no progress
        // of its own yet, and is under way all the same — not noReport.
        const seeded = await executor.request("report", {
          id: "e-report",
          of: "export",
        });
        expect(seeded).toMatchObject({
          ok: true,
          value: { outcome: "exporting", phase: "rendering" },
        });
        // M1: in flight, the answer carries its sentence as a settled one does.
        expect(
          (seeded as { value: { summary?: string } }).value.summary,
        ).toMatch(/^Exporting/);
        await reached;
        // The first progress there is: the render has begun, nothing is saved.
        const first = await executor.request("report", {
          id: "e-report",
          of: "export",
        });
        expect(first).toMatchObject({
          ok: true,
          value: { outcome: "exporting", phase: "rendering" },
        });
        expect(
          (first as { value: { summary?: string } }).value.summary,
        ).toMatch(/^Exporting/);
      } finally {
        // As in the case above: never leave the slot held.
        await settled;
      }
      const done = await settled;
      expect(done).toMatchObject({ ok: true, value: { outcome: "saved" } });
      expect(
        await executor.request("report", { id: "e-report", of: "export" }),
      ).toEqual(done);
    },
    VERTICAL_EXPORT_MS,
  );

  // Review Focus 3.
  it(
    "answers renderFailed, saying headless lost its page, when the work page closes mid-render",
    async () => {
      const workPages: Page[] = [];
      const closer = createLocalExecutor({
        wallpapersDir: WALLPAPERS_DIR,
        home,
        headless: true,
        outDir,
        log: () => undefined,
        onWorkPage: (page) => void workPages.push(page),
      });
      try {
        const { settled, reached } = exportUntil(
          closer,
          { takeId, callId: "e-close" },
          (p) => p.outcome === "exporting" && (p.total as number) > 0,
        );
        await reached;
        // The premise: the hook handed over the page the render is on.
        expect(workPages.length).toBe(1);
        await workPages[0]?.close();
        const out = await settled;
        expect(out).toMatchObject({
          ok: true,
          value: { outcome: "renderFailed" },
        });
        // Headless: no window anyone could close, so none is named.
        const error = (out as { value: { error: string } }).value.error;
        expect(error).toContain(
          "Demoman's headless browser lost the page it renders in",
        );
        expect(error).not.toContain("leave it open");
        // The browser is still usable: the next call works.
        expect(
          await closer.request("snapshot", { url: app.url }),
        ).toMatchObject({ ok: true });
      } finally {
        await closer.close();
      }
    },
    VERTICAL_EXPORT_MS,
  );
});

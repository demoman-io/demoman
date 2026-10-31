// apps/runner/test/executor-run.test.ts
import { access, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Degradation, FrameBundle } from "@demoman/compositor";
import { replayPolicy } from "@demoman/replay-engine";
import type { BrandKitsRead, EndPage, RunReport } from "@demoman/run-core";
import type { BrowserContext } from "playwright";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import { readDisplay } from "../src/display.js";
import { createBrowserSession } from "../src/executor/browser.js";
import {
  finalStillFor,
  renderFinalStill,
} from "../src/executor/final-still.js";
import { createLibrary } from "../src/executor/library.js";
import { installExecutorEntry } from "../src/executor/page-ops.js";
import {
  encodeLossesOf,
  recordEncodeLosses,
  runScript,
} from "../src/executor/run.js";
import {
  createSessionStore,
  type SessionFile,
  siteOf,
} from "../src/executor/sessions.js";
import type { RunnerStore } from "../src/frame-store.js";
import { installResolver } from "../src/page-agent.js";
import { serveFixtureApp, WALLPAPERS_DIR } from "./fixture.js";
import { sampleImage } from "./mp4-probe.js";

const lines: string[] = [];
const log = (line: string) => void lines.push(line);
let app: { url: string; close(): void };
let home: string;
const session = createBrowserSession({
  headless: true,
  log,
  onLaunched: async ({ context }) => {
    await installResolver(context);
    await installExecutorEntry(context);
  },
});
const kits: BrandKitsRead = {
  state: "ready",
  kits: [],
  defaultId: null,
  migrationPending: false,
};

beforeAll(async () => {
  app = await serveFixtureApp();
  home = await mkdtemp(join(tmpdir(), "demoman-run-"));
}, 30_000);
afterAll(async () => {
  await session.close();
  app.close();
  await rm(home, { recursive: true, force: true });
});

const script = () => ({
  scriptVersion: 1,
  name: "place an order",
  target: app.url,
  viewport: { width: 1280, height: 800 },
  steps: [
    { do: "waitForLoad" as const },
    { do: "click" as const, on: { text: "Place order" } },
  ],
});

/** The take's first keyframe on disk, decoded in the browser: its pixel
 *  size and how many distinct colours a sparse sample of it holds. */
async function firstKeyframe(
  library: ReturnType<typeof createLibrary>,
  takeId: string,
): Promise<{ w: number; h: number; colors: number }> {
  const store = library.frameStore(takeId);
  const bundle = await store.getBundle(takeId);
  const firstRef = bundle?.keyframes[0]?.ref;
  expect(firstRef, JSON.stringify(bundle?.keyframes.length)).toBeDefined();
  const bytes = await store.load(firstRef as string);
  const ok = await session.ensure();
  if (!ok.ok) throw new Error(JSON.stringify(ok));
  const probe = await ok.launched.context.newPage();
  try {
    const b64 = Buffer.from(bytes).toString("base64");
    return await probe.evaluate(async (data) => {
      const img = new Image();
      img.src = `data:image/jpeg;base64,${data}`;
      await img.decode();
      const c = document.createElement("canvas");
      c.width = img.naturalWidth;
      c.height = img.naturalHeight;
      const g = c.getContext("2d") as CanvasRenderingContext2D;
      g.drawImage(img, 0, 0);
      const px = g.getImageData(0, 0, c.width, c.height).data;
      const seenColors = new Set<number>();
      for (let i = 0; i < px.length; i += 4 * 997) {
        seenColors.add(
          ((px[i] as number) << 16) |
            ((px[i + 1] as number) << 8) |
            (px[i + 2] as number),
        );
      }
      return {
        w: img.naturalWidth,
        h: img.naturalHeight,
        colors: seenColors.size,
      };
    }, b64);
  } finally {
    await probe.close();
  }
}

// Launch C: the executor loads saved sessions into the context `ensure()`
// handed it, and the run stages its own page afterwards. A browser that
// relaunched in between would run signed out and be told "expired".
//
// Which files a run used is read off the write-back: a run that holds the
// fixture site's file writes its state back to it (`refreshedAt` set), and
// one that does not leaves the file alone.
describe("runScript's saved sessions", () => {
  let sessionsHome: string;
  beforeEach(async () => {
    sessionsHome = await mkdtemp(join(tmpdir(), "demoman-run-sessions-"));
  });
  afterEach(async () => {
    await rm(sessionsHome, { recursive: true, force: true });
  });
  const fileFor = (savedAt: string): SessionFile => ({
    sessionVersion: 1,
    site: "localhost",
    savedAt,
    refreshedAt: null,
    startUrl: app.url,
    signInUrl: null,
    state: { cookies: [], origins: [] },
  });
  const onDisk = async () =>
    JSON.parse(
      await readFile(
        createSessionStore(sessionsHome).pathOf("localhost"),
        "utf8",
      ),
    ) as SessionFile;
  const deps = (
    sessions: SessionFile[],
    loadSessions: Parameters<typeof runScript>[1]["loadSessions"],
    sessionsContext: BrowserContext,
  ) => ({
    session,
    library: createLibrary(home),
    kits,
    log,
    sessions,
    sessionStore: createSessionStore(sessionsHome),
    signinCommand: "npx demoman signin",
    loadSessions,
    sessionsContext,
  });
  const stagedContext = async () => {
    const ok = await session.ensure();
    if (!ok.ok) throw new Error(JSON.stringify(ok));
    return ok.launched.context;
  };
  const SAVED = "2026-10-15T09:00:00.000Z";

  it("are loaded again into the staged context when it is not the one they were loaded into, and used", async () => {
    // Premise: the fixture app is the site the file is for.
    expect(siteOf(app.url)).toBe("localhost");
    await createSessionStore(sessionsHome).save(fileFor(SAVED));
    const seen: BrowserContext[] = [];
    const report = await runScript(
      script() as never,
      // What the executor loaded holds no file; the reload holds the site's.
      deps(
        [],
        async (context) => {
          seen.push(context);
          return { ok: true, files: [fileFor(SAVED)] };
        },
        {} as BrowserContext,
      ),
      () => undefined,
    );
    expect(report.outcome, JSON.stringify({ report, lines })).toBe("complete");
    expect(seen).toHaveLength(1);
    expect(seen[0] === (await stagedContext())).toBe(true);
    expect((await onDisk()).refreshedAt, JSON.stringify(report)).not.toBeNull();
  }, 60_000);

  it("are not loaded again when the staged context is the one they were loaded into", async () => {
    await createSessionStore(sessionsHome).save(fileFor(SAVED));
    let calls = 0;
    const report = await runScript(
      script() as never,
      // The loaded files hold the site's; a reload would answer none.
      deps(
        [fileFor(SAVED)],
        async () => {
          calls += 1;
          return { ok: true, files: [] };
        },
        await stagedContext(),
      ),
      () => undefined,
    );
    expect(report.outcome, JSON.stringify({ report, lines })).toBe("complete");
    expect(calls).toBe(0);
    expect((await onDisk()).refreshedAt, JSON.stringify(report)).not.toBeNull();
  }, 60_000);

  it("run nothing, and say why, when they cannot be loaded again", async () => {
    const report = await runScript(
      script() as never,
      deps(
        [],
        async () => ({
          ok: false,
          reason: "sessionNotLoaded",
          detail: "the browser would not take them",
        }),
        {} as BrowserContext,
      ),
      () => undefined,
    );
    expect(report.stopped?.reason, JSON.stringify(report)).toBe("portFailure");
    expect(report.stopped?.detail).toBe(
      "the browser restarted after its saved sessions were loaded, and they could not be loaded again: the browser would not take them",
    );
    expect(report.provenance.takeId).toBeNull();
  }, 60_000);

  it("are not written back over a file that changed during the run", async () => {
    // On disk: a newer sign-in than the one the run loaded.
    const newer = fileFor("2026-10-15T10:00:00.000Z");
    await createSessionStore(sessionsHome).save(newer);
    const report = await runScript(
      script() as never,
      deps(
        [fileFor(SAVED)],
        async () => ({ ok: true, files: [] }),
        await stagedContext(),
      ),
      () => undefined,
    );
    expect(report.outcome, JSON.stringify({ report, lines })).toBe("complete");
    expect(report.notStored).toBeUndefined();
    expect(await onDisk()).toEqual(newer);
    expect(lines).toContain(
      "the session for localhost changed during the run; it was not written back",
    );
  }, 60_000);
});

describe("runScript", () => {
  it("runs the fixture, says it was the CLI, and leaves the take and its frames on disk", async () => {
    const library = createLibrary(home);
    const report = await runScript(
      script() as never,
      {
        session,
        library,
        kits,
        log,
        sessions: [],
        sessionStore: createSessionStore(home),
        signinCommand: "npx demoman signin",
        loadSessions: async () => ({ ok: true as const, files: [] }),
        // Not the staged context: the run reloads into it, harmlessly.
        sessionsContext: {} as BrowserContext,
      },
      () => undefined,
    );
    expect(report.outcome, JSON.stringify({ report, lines })).toBe("complete");
    expect(report.run.executor).toBe("cli");
    const takeId = report.provenance.takeId;
    expect(takeId).not.toBeNull();
    const doc = await library.getScene(takeId as string);
    // `waitForLoad` commits an action of its own (a `waitFor` navigation
    // wait, authored.ts), so the take holds two: the wait and the click.
    expect(doc?.actions.map((a) => a.kind)).toEqual(["waitFor", "click"]);
    // An unplaced headless browser films motion at 1x, and the take says so.
    expect(doc?.meta.capture.displayScale).toBe(1);
    // The picture, not the bundle: a keyframe on disk decodes to the
    // run's size at a real DPR, and is not one flat colour.
    const seen = await firstKeyframe(library, takeId as string);
    expect(seen.w / seen.h, JSON.stringify(seen)).toBeCloseTo(1280 / 800, 2);
    expect(seen.w, JSON.stringify(seen)).toBeGreaterThanOrEqual(1280);
    expect(seen.colors, JSON.stringify(seen)).toBeGreaterThan(8);
    expect(
      JSON.parse(
        await readFile(
          join(library.takeDir(takeId as string), "report.json"),
          "utf8",
        ),
      ).outcome,
    ).toBe("complete");
  }, 180_000);

  it("films a script that names no viewport at the screen's size, and says so", async () => {
    const library = createLibrary(home);
    const { viewport: _none, ...noViewport } = script();
    const report = await runScript(
      noViewport as never,
      {
        session,
        library,
        kits,
        log,
        sessions: [],
        sessionStore: createSessionStore(home),
        signinCommand: "npx demoman signin",
        loadSessions: async () => ({ ok: true as const, files: [] }),
        // Not the staged context: the run reloads into it, harmlessly.
        sessionsContext: {} as BrowserContext,
      },
      () => undefined,
    );
    expect(report.outcome, JSON.stringify({ report, lines })).toBe("complete");
    // run.ts's own choice, not the script's: the screen the window is on.
    const size = report.size;
    expect(size?.from, JSON.stringify(size)).toBe("screen");
    expect(size?.error).toBeNull();
    // The premise: that size is not the context's own 1024x640
    // (launch.ts's CONTEXT_VIEWPORT), so a run that never applied it would
    // decode to a different shape than the one asserted below.
    expect(
      (size?.width as number) / (size?.height as number),
      JSON.stringify(size),
    ).not.toBeCloseTo(1024 / 640, 2);
    const seen = await firstKeyframe(
      library,
      report.provenance.takeId as string,
    );
    expect(seen.w / seen.h, JSON.stringify({ seen, size })).toBeCloseTo(
      (size?.width as number) / (size?.height as number),
      2,
    );
    expect(seen.w, JSON.stringify({ seen, size })).toBeGreaterThanOrEqual(
      size?.width as number,
    );
    expect(seen.colors, JSON.stringify(seen)).toBeGreaterThan(8);
  }, 180_000);

  // Report before you forgive: a headless run that could not read the
  // display it stands in for still films, at its own window, and its report
  // says so — never `from: "screen"` for Chrome's stand-in.
  it("says so when headless could not read the display, and films at its window", async () => {
    const why = "osascript refused: no window server";
    const blind = createBrowserSession({
      headless: true,
      log,
      readDisplay: async () => ({ failed: why }),
      onLaunched: async ({ context }) => {
        await installResolver(context);
        await installExecutorEntry(context);
      },
    });
    try {
      const { viewport: _none, ...noViewport } = script();
      const report = await runScript(
        noViewport as never,
        {
          session: blind,
          library: createLibrary(home),
          kits,
          log,
          sessions: [],
          sessionStore: createSessionStore(home),
          signinCommand: "npx demoman signin",
          loadSessions: async () => ({ ok: true as const, files: [] }),
          sessionsContext: {} as BrowserContext,
        },
        () => undefined,
      );
      // Premise: the page itself would have read a screen — Chrome's
      // stand-in — so `from: "screen"` is what this would say without the
      // reason.
      const ensured = await blind.ensure();
      if (!ensured.ok) throw new Error(JSON.stringify(ensured));
      const standIn = await ensured.launched.page.evaluate(() => [
        screen.width,
        screen.height,
      ]);
      expect(standIn[0], JSON.stringify(standIn)).toBeGreaterThan(0);
      expect(report.outcome, JSON.stringify({ report, lines })).toBe(
        "complete",
      );
      expect(report.size?.from, JSON.stringify(report.size)).toBe("window");
      expect(report.size?.error).toContain(
        `Demoman could not read this computer's display (${why})`,
      );
      expect(report.size?.error).toContain("DEMOMAN_DISPLAY");

      // A script that names its own viewport films at that size, but still
      // at 1x, and says so: the size is right and the scale is not.
      const sized = await runScript(
        script() as never,
        {
          session: blind,
          library: createLibrary(home),
          kits,
          log,
          sessions: [],
          sessionStore: createSessionStore(home),
          signinCommand: "npx demoman signin",
          loadSessions: async () => ({ ok: true as const, files: [] }),
          sessionsContext: {} as BrowserContext,
        },
        () => undefined,
      );
      // Premise: the script named its size.
      expect(script().viewport).toEqual({ width: 1280, height: 800 });
      expect(sized.outcome, JSON.stringify({ sized, lines })).toBe("complete");
      expect(sized.size, JSON.stringify(sized.size)).toMatchObject({
        width: 1280,
        height: 800,
        from: "script",
      });
      expect(sized.size?.error).toContain(
        `Demoman could not read this computer's display (${why}), so headless recorded at 1x`,
      );
    } finally {
      await blind.close();
    }
  }, 180_000);

  // Decide once, record it: the scale the launch put the browser on is the
  // one the take records, so keep never has to guess it from the frames.
  it("records the display scale it filmed at on the take", async () => {
    const placed = createBrowserSession({
      headless: true,
      log,
      readDisplay: () => readDisplay({ DEMOMAN_DISPLAY: "1280x800@2" }),
      onLaunched: async ({ context }) => {
        await installResolver(context);
        await installExecutorEntry(context);
      },
    });
    try {
      const library = createLibrary(home);
      const report = await runScript(
        script() as never,
        {
          session: placed,
          library,
          kits,
          log,
          sessions: [],
          sessionStore: createSessionStore(home),
          signinCommand: "npx demoman signin",
          loadSessions: async () => ({ ok: true as const, files: [] }),
          sessionsContext: {} as BrowserContext,
        },
        () => undefined,
      );
      expect(report.outcome, JSON.stringify({ report, lines })).toBe(
        "complete",
      );
      const takeId = report.provenance.takeId as string;
      const doc = await library.getScene(takeId);
      expect(doc?.meta.capture.displayScale).toBe(2);
      // The record agrees with the picture: the motion was filmed at 2x.
      const spans =
        (await library.frameStore(takeId).getBundle(takeId))?.motionSpans ?? [];
      expect(spans.length, JSON.stringify(spans)).toBeGreaterThan(0);
      expect(
        Math.max(...spans.map((s) => s.width)),
        JSON.stringify(spans),
      ).toBeGreaterThan(1280 * 1.5);
    } finally {
      await placed.close();
    }
  }, 180_000);

  // Headless has no window for anyone to close: a page that goes away mid-run
  // is the browser crashing or the page closing itself, and the report says
  // that, never "leave the window open" about a window nobody saw.
  it("names a headless page lost mid-run as lost, not as a closed window", async () => {
    const library = createLibrary(home);
    const long = {
      ...script(),
      steps: [
        { do: "waitForLoad" as const },
        { do: "pause" as const, ms: 4000 },
        { do: "click" as const, on: { text: "Place order" } },
      ],
    };
    const ok = await session.ensure();
    if (!ok.ok) throw new Error(JSON.stringify(ok));
    // Closed on a condition, not after a duration (CLAUDE.md: no fixed
    // sleeps in a browser lane): the first tick past `waitForLoad` means the
    // page loaded and the walk is now in the pause the close interrupts.
    let closing: Promise<void> | null = null;
    const report = await runScript(
      long as never,
      {
        session,
        library,
        kits,
        log,
        sessions: [],
        sessionStore: createSessionStore(home),
        signinCommand: "npx demoman signin",
        loadSessions: async () => ({ ok: true as const, files: [] }),
        // Not the staged context: the run reloads into it, harmlessly.
        sessionsContext: {} as BrowserContext,
      },
      (progress) => {
        if (closing === null && progress.step >= 1) {
          // The run's own page: the only one in the context while it walks
          // (each call gets a page of its own, and the previous is closed).
          const pages = ok.launched.context.pages();
          closing = Promise.all(pages.map((p) => p.close())).then(
            () => undefined,
          );
        }
      },
    );
    // The premise: the close happened during the run, not never.
    expect(closing, JSON.stringify({ report, lines })).not.toBeNull();
    expect(report.outcome, JSON.stringify({ report, lines })).toBe("stopped");
    expect(report.stopped?.reason, JSON.stringify(report.stopped)).toBe(
      "portFailure",
    );
    expect(report.stopped?.detail, JSON.stringify(report.stopped)).toContain(
      "Demoman's headless browser lost the run's page before the run finished",
    );
  }, 180_000);

  // Author's ruling 2026-10-20: the CLI films any target, headless or not —
  // the v8 §491 refusal (a published target, nobody watching) would have
  // refused every staging host and cloud development environment.
  it("films a published target, which the old unattended rule refused", async () => {
    const target = "https://staging.demoman-example.com/";
    const ensured = await session.ensure();
    if (!ensured.ok) throw new Error(JSON.stringify(ensured));
    // The published host answers with the fixture app, so nothing leaves
    // this machine.
    await ensured.launched.context.route(`${target}**`, async (route) => {
      const path = new URL(route.request().url()).pathname;
      route.fulfill({
        response: await route.fetch({ url: new URL(path, app.url).href }),
      });
    });
    const report = await runScript(
      { ...script(), target } as never,
      {
        session,
        library: createLibrary(home),
        kits,
        log,
        sessions: [],
        sessionStore: createSessionStore(home),
        signinCommand: "npx demoman signin",
        loadSessions: async () => ({ ok: true as const, files: [] }),
        // Not the staged context: the run reloads into it, harmlessly.
        sessionsContext: {} as BrowserContext,
      },
      () => undefined,
    );
    // Premise: v8 §491's gate, asked as the runner's `replay` asks it, still
    // refuses this target — so a complete run is the ruling, not a host the
    // gate happens to admit.
    expect(
      replayPolicy(
        { flags: { mutating: true }, sideChannels: { network: [] } },
        { attended: false, targetUrl: target },
      ),
    ).toMatchObject({
      mayReplay: false,
      refusal: "unverifiableTargetUnattended",
    });
    expect(report.outcome, JSON.stringify({ report, lines })).toBe("complete");
    expect(report.refused).toBeUndefined();
  }, 60_000);
});

describe("recordEncodeLosses", () => {
  const span = (index: number, ref: string) => ({
    index,
    ref,
    startMs: index * 1000,
    endMs: index * 1000 + 500,
    firstFrameIndex: index * 10,
    frames: 10,
    frameMs: Array.from({ length: 10 }, (_, i) => index * 1000 + i * 25),
    width: 100,
    height: 100,
    kept: true,
  });
  const bundleWith = (refs: string[]) =>
    ({
      motionSpans: refs.map((ref, i) => ({
        startMs: i * 1000,
        endMs: i * 1000 + 500,
        ref,
        width: 100,
        height: 100,
        fps: 30,
        byteLength: 0,
      })),
      degradations: [],
    }) as unknown as FrameBundle;

  it("takes a span the mux lost out of the bundle and says why on the bundle and the walk, then rewrites the row", async () => {
    const bundle = bundleWith(["a", "b"]);
    // The walk's array is a different one here, as it may be when the
    // engine hands back a copy: both must carry the entry.
    const walk: Degradation[] = [];
    const written: FrameBundle[] = [];
    const store = {
      putBundle: async (_: string, b: FrameBundle) => void written.push(b),
    } as unknown as RunnerStore;
    const said: string[] = [];
    await recordEncodeLosses(
      bundle,
      walk,
      [
        {
          span: span(1, "b"),
          refused: 10,
          why: "VideoEncoder refused",
          removed: true,
        },
      ],
      store,
      "scene-x",
      (line) => void said.push(line),
    );
    expect(bundle.motionSpans.map((m) => m.ref)).toEqual(["a"]);
    expect(bundle.degradations).toEqual([
      expect.objectContaining({
        kind: "encodeRefused",
        startMs: 1000,
        endMs: 1500,
        note: "the encoder refused 10 of 10 frames of a span that opened on 100x100 (VideoEncoder refused)",
      }),
    ]);
    expect(walk).toEqual(bundle.degradations);
    expect(written).toEqual([bundle]);
    expect(said).toEqual([]);
  });

  it("says when the rewritten row could not be stored", async () => {
    const bundle = bundleWith(["a"]);
    const store = {
      putBundle: async () => {
        throw new Error("EACCES");
      },
    } as unknown as RunnerStore;
    const said: string[] = [];
    await recordEncodeLosses(
      bundle,
      bundle.degradations,
      [{ span: span(0, "a"), refused: 10, why: "no page", removed: true }],
      store,
      "scene-x",
      (line) => void said.push(line),
    );
    // One array, one entry: not pushed twice when the walk shares the
    // bundle's array.
    expect(bundle.degradations).toHaveLength(1);
    expect(said.join("\n")).toContain("EACCES");
  });

  it("keeps a span that lost frames inside it, and says k of n over its range", async () => {
    const bundle = bundleWith(["a", "b"]);
    const walk: Degradation[] = [];
    const store = {
      putBundle: async () => undefined,
    } as unknown as RunnerStore;
    await recordEncodeLosses(
      bundle,
      walk,
      [{ span: span(1, "b"), refused: 3, why: "missing", removed: false }],
      store,
      "scene-x",
      () => undefined,
    );
    expect(bundle.motionSpans.map((m) => m.ref)).toEqual(["a", "b"]);
    expect(walk).toEqual([
      {
        kind: "encodeRefused",
        startMs: 1000,
        endMs: 1500,
        note: "the encoder refused 3 of 10 frames of a span that opened on 100x100 (missing)",
      },
    ]);
  });
});

describe("encodeLossesOf", () => {
  const parked = (index: number) => ({
    index,
    ref: `r${index}`,
    startMs: index * 1000,
    endMs: index * 1000 + 500,
    firstFrameIndex: index * 10,
    frames: 10,
    frameMs: Array.from({ length: 10 }, (_, i) => index * 1000 + i * 25),
    width: 100,
    height: 100,
    kept: true,
  });

  it("names a span lost whole and a kept span with frames missing, and not a clean one", () => {
    const kept = [parked(0), parked(1), parked(2)];
    const losses = encodeLossesOf(
      {
        muxed: [
          { index: 0, spanIndex: 0, kept: true, lost: 0, reason: null },
          { index: 1, spanIndex: 1, kept: true, lost: 4, reason: null },
          { index: 2, spanIndex: 2, kept: false, lost: 10, reason: "boom" },
        ],
        shortfall: 14,
      },
      kept,
    );
    expect(
      losses.map((l) => [l.span.ref, l.refused, l.removed, l.why]),
    ).toEqual([
      [
        "r1",
        4,
        false,
        "frames missing or unreadable when the span was encoded",
      ],
      ["r2", 10, true, "boom"],
    ]);
  });
});

describe("runScript when the encode throws", () => {
  it("removes the take's folder before it rethrows, so no raw frames are left", async () => {
    const own = await mkdtemp(join(tmpdir(), "demoman-run-throw-"));
    try {
      const library = createLibrary(own);
      // Filled in by the mux seam (a holder, so the narrowing survives).
      const atMux: { dir: string | null; files: string[] } = {
        dir: null,
        files: [],
      };
      await expect(
        runScript(
          script() as never,
          {
            session,
            library,
            kits,
            log,
            sessions: [],
            sessionStore: createSessionStore(home),
            signinCommand: "npx demoman signin",
            loadSessions: async () => ({ ok: true as const, files: [] }),
            // Not the staged context: the run reloads into it, harmlessly.
            sessionsContext: {} as BrowserContext,
            muxSpans: async ({ sceneId }) => {
              atMux.dir = library.takeDir(sceneId);
              atMux.files = await readdir(join(atMux.dir, "frames"));
              throw new Error("mux setup fell over");
            },
          },
          () => undefined,
        ),
      ).rejects.toThrow("mux setup fell over");
      // The premise: the mux was reached, and the take's folder held frames
      // (raw parked ones among them) when it threw.
      expect(atMux.dir).not.toBeNull();
      expect(
        atMux.files.some((name) => name.startsWith("park")),
        JSON.stringify(atMux.files),
      ).toBe(true);
      await expect(access(atMux.dir as string)).rejects.toMatchObject({
        code: "ENOENT",
      });
      expect(await readdir(library.root)).toEqual([]);
    } finally {
      await rm(own, { recursive: true, force: true });
    }
  }, 180_000);
});

// 2026-10-13: the click check's evidence has to reach the report an agent
// keeps. The walk said it only on a progress note and a degradation's note,
// and the report carried the reason and the kind: which click, and how far
// off, never arrived. The stage's own CDP is wrapped so the check's read
// answers what the browser did on the day, and nothing else changes.
describe("a click the check could not pass, in the report", () => {
  type Seen = {
    down: { x: number; y: number } | null;
    up: { x: number; y: number } | null;
  };
  /** The session, with every click check's read on the stage rewritten by
   *  `rewrite`, and a count of the reads it rewrote. */
  function rewritingSession(rewrite: (seen: Seen) => void) {
    const rewrote = { count: 0 };
    const wrapped: typeof session = {
      ...session,
      stage: async () => {
        const staged = await session.stage();
        if (staged.ok) {
          const { cdp } = staged.stage;
          const send = cdp.send.bind(cdp);
          cdp.send = async (method, params) => {
            const reply = await send(method, params);
            const value = (reply.result as { value?: Seen } | undefined)?.value;
            if (
              method === "Runtime.callFunctionOn" &&
              params?.returnByValue === true &&
              String(params.functionDeclaration).includes(
                "__demomanClickProbe",
              ) &&
              value !== undefined
            ) {
              rewrite(value);
              rewrote.count++;
            }
            return reply;
          };
        }
        return staged;
      },
    };
    return { wrapped, rewrote };
  }

  it("stops a click that arrived elsewhere and says where it went", async () => {
    const { wrapped, rewrote } = rewritingSession((seen) => {
      // The whole click at 2/3 of where it arrived: the shape measured.
      for (const key of ["down", "up"] as const) {
        const p = seen[key];
        if (p !== null) seen[key] = { x: (p.x * 2) / 3, y: (p.y * 2) / 3 };
      }
    });
    const report = await runScript(
      script() as never,
      {
        session: wrapped,
        library: createLibrary(home),
        kits,
        log,
        sessions: [],
        sessionStore: createSessionStore(home),
        signinCommand: "npx demoman signin",
        loadSessions: async () => ({ ok: true as const, files: [] }),
        // Not the staged context: the run reloads into it, harmlessly.
        sessionsContext: {} as BrowserContext,
      },
      () => undefined,
    );
    expect(rewrote.count, JSON.stringify(report.stopped)).toBe(1);
    expect(report.stopped?.reason).toBe("clickNotDelivered");
    expect(report.stopped?.at.label).toBe(
      'script step 2: click text "Place order"',
    );
    expect(report.stopped?.detail ?? "").toMatch(
      /^the click was sent to \(\d+, \d+\), the press arrived at \(\d+, \d+\) and the release arrived at \(\d+, \d+\), so the page never saw a click on its target — .*run it again, and say so if it repeats$/,
    );
  }, 180_000);

  // A press the page's own code hid from the check is no evidence of a miss
  // (review I3): the run goes on, and the report names the step to look at.
  it("goes on past a click it could not confirm, and names the step", async () => {
    const { wrapped, rewrote } = rewritingSession((seen) => {
      seen.down = null;
    });
    const report = await runScript(
      script() as never,
      {
        session: wrapped,
        library: createLibrary(home),
        kits,
        log,
        sessions: [],
        sessionStore: createSessionStore(home),
        signinCommand: "npx demoman signin",
        loadSessions: async () => ({ ok: true as const, files: [] }),
        // Not the staged context: the run reloads into it, harmlessly.
        sessionsContext: {} as BrowserContext,
      },
      () => undefined,
    );
    expect(rewrote.count).toBe(1);
    expect(report.outcome, JSON.stringify(report.stopped)).toBe("complete");
    expect(report.frames.degradations).toContain("clickUnconfirmed");
    expect(report.frames.unconfirmedClicks).toEqual([
      {
        step: 'script step 2: click text "Place order"',
        note: expect.stringMatching(
          /^the click: sent to \(\d+, \d+\), the press was never seen and the release arrived at \(\d+, \d+\) — /,
        ),
      },
    ]);
  }, 180_000);
});

// Spec 2026-10-30 A1/A2: a run's answer shows where it ended — the film's
// own last frame on disk, and the page as text — so an agent can judge it
// against its brief without pulling frames itself.
describe("a run's end state", () => {
  let report: RunReport;
  let library: ReturnType<typeof createLibrary>;
  beforeAll(async () => {
    library = createLibrary(home);
    report = await runScript(
      script() as never,
      {
        session,
        library,
        kits,
        log,
        sessions: [],
        sessionStore: createSessionStore(home),
        signinCommand: "npx demoman signin",
        loadSessions: async () => ({ ok: true as const, files: [] }),
        sessionsContext: {} as BrowserContext,
        finalStill: finalStillFor({
          session,
          library,
          home,
          wallpapersDir: WALLPAPERS_DIR,
          log,
        }),
      },
      () => undefined,
    );
  }, 180_000);

  it("a run answer names its final still and its end page", async () => {
    const said = JSON.stringify({ report, lines });
    expect(report.outcome, said).toBe("complete");
    const takeId = report.provenance.takeId as string;
    expect(report.still, said).toEqual({
      path: join(library.takeDir(takeId), "final-still.png"),
    });
    // The picture: a PNG no wider than 1280 px that is not one flat colour
    // — the page's dark header (and the panel the click opened) beside the
    // light table. Which frame it is, the last, is final-still.test.ts's.
    const DARK: [number, number, number] = [17, 24, 39];
    const WHITE: [number, number, number] = [255, 255, 255];
    const read = await sampleImage(
      await readFile(join(library.takeDir(takeId), "final-still.png")),
      "image/png",
      { colors: [DARK, WHITE] },
    );
    const [dark = 0, white = 0] = read.readings.at(-1)?.colorCounts ?? [];
    const seen = JSON.stringify({ width: read.width, dark, white });
    expect(read.width, seen).toBeLessThanOrEqual(1280);
    expect(dark, seen).toBeGreaterThan(1000);
    expect(white, seen).toBeGreaterThan(1000);

    const end = report.endPage as EndPage;
    expect(end.url, said).toBe(`${app.url}/`);
    expect(end.text, said).toContain("Invoice 8891");
    // The one field on the page, the search box, empty.
    expect(
      end.fields.map((f) => f.value),
      said,
    ).toEqual([""]);
  }, 120_000);

  it("report.json carries the path, never image bytes", async () => {
    const takeId = report.provenance.takeId as string;
    const text = await readFile(
      join(library.takeDir(takeId), "report.json"),
      "utf8",
    );
    // The premise: the run made a still, so there is a path to carry.
    expect(report.still, JSON.stringify(report.still)).toHaveProperty("path");
    expect(JSON.parse(text).still).toEqual(report.still);
    // The premise: the still is a PNG, whose base64 starts with this.
    const png = await readFile(
      join(library.takeDir(takeId), "final-still.png"),
    );
    expect(png.toString("base64").startsWith("iVBORw0KGgo")).toBe(true);
    expect(text).not.toContain("iVBORw0KGgo");
  });

  // A still that cannot be rendered is said, and never costs the run.
  it("a still whose render throws is unavailable with the reason, and the run completes", async () => {
    const launched = await session.ensure();
    if (!launched.ok) throw new Error(JSON.stringify(launched));
    const gone = await launched.launched.context.newPage();
    await gone.close();
    const lib = createLibrary(home);
    const failed = await runScript(
      script() as never,
      {
        session,
        library: lib,
        kits,
        log,
        sessions: [],
        sessionStore: createSessionStore(home),
        signinCommand: "npx demoman signin",
        loadSessions: async () => ({ ok: true as const, files: [] }),
        sessionsContext: {} as BrowserContext,
        // The render's page is closed before it starts: renderToFiles throws.
        finalStill: (takeId) =>
          renderFinalStill({
            library: lib,
            takeId,
            page: gone,
            home,
            wallpapersDir: WALLPAPERS_DIR,
          }),
      },
      () => undefined,
    );
    const said = JSON.stringify({ still: failed.still, lines });
    expect(failed.outcome, said).toBe("complete");
    expect(failed.verdict.kind, said).toBe("matches");
    const why = (failed.still as { unavailable: string }).unavailable;
    expect(why, said).toMatch(
      /^the film's last frame could not be rendered \(.*closed/,
    );
  }, 180_000);

  // A finalStill that breaks its never-throw contract is named as a throw,
  // not as the deadline's "took longer" (review round 1 found the mislabel).
  it("a still that throws says it threw, not that it was slow", async () => {
    const thrown = await runScript(
      script() as never,
      {
        session,
        library: createLibrary(home),
        kits,
        log,
        sessions: [],
        sessionStore: createSessionStore(home),
        signinCommand: "npx demoman signin",
        loadSessions: async () => ({ ok: true as const, files: [] }),
        sessionsContext: {} as BrowserContext,
        finalStill: async () => {
          throw new Error("boom");
        },
      },
      () => undefined,
    );
    expect(thrown.outcome).toBe("complete");
    expect(thrown.still).toEqual({
      unavailable: "rendering the final still threw (boom)",
    });
  }, 180_000);
});

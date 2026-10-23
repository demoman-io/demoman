/**
 * `runPipeline`'s own wiring and branching, unit-tested against fakes for
 * `launch`, `replayPhase`, `muxSpans` and `renderPhase` — every one of
 * which already has its own real-browser coverage elsewhere
 * (`launch.test.ts`, `replay.test.ts`, `mux.test.ts`, `render.slow.test.ts`).
 * What THIS file is the only place to prove is the ORDER those pieces run
 * in and what each branch reports — `pipeline.ts` imports them directly
 * rather than accepting them as ports, so `vi.mock` on the local modules is
 * the seam a real browser is not needed to exercise it through.
 *
 * `apps/runner/test/acceptance.slow.test.ts` (a later task) is where the whole
 * wiring runs for real, against a real browser, and asserts on decoded
 * pixels — this file is deliberately narrower than that.
 */
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ReplayResult } from "@demoman/replay-engine";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PipelineResult } from "../src/pipeline.js";
import { scene as sceneFixture } from "./fixtures/scene.js";

const launchMock = vi.fn();
const replayPhaseMock = vi.fn();
const muxSpansMock = vi.fn();
const renderPhaseMock = vi.fn();
/** What the real `renderPhase` resolves: the file's facts, no logo warning. */
const RENDERED = {
  bytes: Buffer.alloc(0),
  detailViolations: [],
  unavailableSpans: [],
  loweredZooms: [],
  logoWarning: null,
};
const closeMock = vi.fn(async () => ({ crashed: false }));
const cdpDetachMock = vi.fn(async () => undefined);
const pageGotoMock = vi.fn(async () => undefined);
// `pipeline.ts` builds its OWN store from `mkdtempSync` (mocked below,
// defaulting to the real one) — recording the path it was called with
// (rather than faking it) is what lets the cleanup tests assert on
// `existsSync` against the actual directory `runPipeline` created, the
// same one its own cleanup logic acts on.
const createFileFrameStoreMock = vi.fn((root: string) => ({ root }));

vi.mock("../src/launch.js", () => ({ launch: launchMock }));
vi.mock("../src/replay.js", () => ({ replayPhase: replayPhaseMock }));
vi.mock("../src/mux.js", () => ({ muxSpans: muxSpansMock }));
vi.mock("../src/render.js", () => ({ renderPhase: renderPhaseMock }));
vi.mock("../src/frame-store.js", () => ({
  createFileFrameStore: createFileFrameStoreMock,
}));
// `node:fs/promises` and `node:fs` are real ESM builtins — their namespaces
// are not configurable, so `vi.spyOn` on an imported namespace object
// throws ("Cannot redefine property"). `vi.mock` with `importOriginal` is
// the documented way around that. Both mocks default to the REAL function
// (other tests below rely on cleanup and directory creation actually
// happening on disk); individual tests override one call at a time.
type RmArgs = Parameters<typeof import("node:fs/promises").rm>;
const rmMock = vi.fn(async (path: RmArgs[0], options: RmArgs[1]) => {
  const actual =
    await vi.importActual<typeof import("node:fs/promises")>(
      "node:fs/promises",
    );
  return actual.rm(path, options);
});
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    rm: (path: RmArgs[0], options: RmArgs[1]) => rmMock(path, options),
  };
});
// Fix round 2's "point --out inside the run root" test needs to know the
// run root BEFORE calling `runPipeline` — impossible against the real
// `mkdtempSync`'s random suffix, so this mock lets that one test pin it,
// the same way the reviewer's own repro did.
// `mkdtempSync` is SYNCHRONOUS — unlike `rmMock` above, its default
// implementation cannot be `await vi.importActual(...)` on every call (that
// would make `pipeline.ts`'s `const runRoot = mkdtempSync(...)` receive a
// Promise instead of a path). And a plain top-level `const mkdtempSyncMock
// = vi.fn()` referenced from the `vi.mock("node:fs", …)` factory below hits
// vitest's own hoisting: `vi.mock` calls are hoisted above every regular
// `const` in this file, so the factory ran before this declaration did and
// threw "Cannot access 'mkdtempSyncMock' before initialization". `vi.hoisted`
// is the documented way around both problems at once: it runs its callback
// immediately, hoisted to the very top — ABOVE the `vi.mock` calls it feeds
// — so the factory below can synchronously call `.mockImplementation` on
// the real (already-resolved-by-then) `actual.mkdtempSync`.
type MkdtempArgs = Parameters<typeof import("node:fs").mkdtempSync>;
const { mkdtempSyncMock } = vi.hoisted(() => ({
  mkdtempSyncMock: vi.fn<(...args: MkdtempArgs) => string>(() => {
    throw new Error("mkdtempSyncMock used before its default was installed");
  }),
}));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  mkdtempSyncMock.mockImplementation(
    (...args) => actual.mkdtempSync(...args) as string,
  );
  return {
    ...actual,
    mkdtempSync: (...args: MkdtempArgs) => mkdtempSyncMock(...args),
  };
});

const SCENE = sceneFixture(false);
const TARGET_URL = "https://app.example.com/";
const OUT_PATH = "/tmp/does-not-matter.mp4";

function bareReplayResult(overrides: Partial<ReplayResult>): ReplayResult {
  return {
    bundle: null,
    outcome: "complete",
    completed: 0,
    total: 0,
    lastCompletedActionId: null,
    reason: null,
    degradations: [],
    storageRefused: false,
    hoverSensitive: false,
    counters: {} as ReplayResult["counters"],
    ...overrides,
  };
}

function bundleWith(degradations: ReplayResult["degradations"] = []) {
  return {
    bundleVersion: 1,
    sceneId: SCENE.meta.id,
    source: "replay",
    dpr: 1,
    viewport: { width: 1280, height: 800 },
    keyframes: [
      {
        sourceTimeMs: 0,
        ref: "kf:s1:0",
        width: 100,
        height: 50,
        actionId: null,
        byteLength: 0,
      },
    ],
    motionSpans: [],
    cursorSamples: [{ sourceTimeMs: 0, x: 0, y: 0 }],
    cursorGaps: [],
    anchorRects: [],
    markers: [],
    degradations,
  } as never;
}

/** The real `mkdtempSync`'d directory `runPipeline` created for this call —
 *  read off the mocked `createFileFrameStore`'s own argument, not guessed. */
function capturedRunRoot(): string {
  const root = createFileFrameStoreMock.mock.calls.at(-1)?.[0];
  if (typeof root !== "string") {
    throw new Error("createFileFrameStore was never called");
  }
  return root;
}

/** The teardown lines this run produced.
 *
 *  Whole-branch review finding 9 moved these off `console.error` and onto
 *  the result: written straight to stderr from `runPipeline`'s `finally`,
 *  they printed BEFORE the caller's failure sentence, because a `finally`
 *  unwinds before its caller's switch runs — so stderr read bottom-up on
 *  every failing run. `cli.ts` prints them last now. */
function notesText(result: PipelineResult): string {
  return (result.notes ?? []).join("\n");
}

/** What reached `console.error` or `console.warn` directly — asserted to
 *  NOT carry the notes, which is the half of finding 9 that a notes-only
 *  assertion would miss. Both levels: the crash line this file now checks
 *  used to go out at `warn`. */
function consoleText(): string {
  return [...errorSpy.mock.calls, ...warnSpy.mock.calls]
    .map((call) => String(call[0]))
    .join("\n");
}

let errorSpy: ReturnType<typeof vi.spyOn>;
let warnSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  launchMock.mockResolvedValue({
    page: { goto: pageGotoMock },
    cdp: { detach: cdpDetachMock },
    close: closeMock,
  });
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(async () => {
  errorSpy.mockRestore();
  warnSpy.mockRestore();
  // These tests deliberately exercise `runPipeline`'s REAL `mkdtempSync`
  // (only `createFileFrameStore` is faked), and several of them prove the
  // directory survives a failure or a deliberately-blocked cleanup. Left
  // alone, a full run of this file would accumulate one real
  // `demoman-run-*` directory per test, every time it runs, in the
  // machine's own TMPDIR. `rmMock` here (not the raw `rm`) so this reaches
  // the real filesystem call even in the one test that overrode `rmMock`
  // for a single rejection — that "Once" queue is already drained by the
  // time its own test body finishes.
  const root = createFileFrameStoreMock.mock.calls.at(-1)?.[0];
  if (typeof root === "string") {
    await rmMock(root, { recursive: true, force: true }).catch(() => undefined);
  }
});

describe("runPipeline", () => {
  it("returns replayStopped without touching mux or render when the replay stopped", async () => {
    const { runPipeline } = await import("../src/pipeline.js");
    replayPhaseMock.mockResolvedValue({
      result: bareReplayResult({
        outcome: "partial",
        reason: "anchorNotRendered",
        completed: 2,
        total: 4,
      }),
      spans: [],
      navigationError: null,
    });

    const result = await runPipeline({
      scene: SCENE,
      targetUrl: TARGET_URL,
      outPath: OUT_PATH,
    });

    expect(result).toMatchObject({
      kind: "replayStopped",
      reason: "anchorNotRendered",
      completed: 2,
      total: 4,
    });
    expect(muxSpansMock).not.toHaveBeenCalled();
    expect(renderPhaseMock).not.toHaveBeenCalled();
    expect(cdpDetachMock).toHaveBeenCalled();
    expect(closeMock).toHaveBeenCalled();

    // Task 12 fix round 1: a run that did not render is a failure this
    // pipeline must not tidy away — its frames are exactly what someone
    // debugging the stop needs, so the scratch directory stays, and its
    // path is named as part of the failure output.
    const root = capturedRunRoot();
    expect(existsSync(root)).toBe(true);
    // Finding 9: on the result, for the CLI to print AFTER the failure
    // sentence — and NOT straight to stderr from the `finally`, which is
    // what put it above the sentence.
    expect(notesText(result)).toContain(root);
    expect(consoleText()).not.toContain(root);
  });

  it("reports renderFailed, without calling mux or render, when replay completed with no bundle to render", async () => {
    const { runPipeline } = await import("../src/pipeline.js");
    replayPhaseMock.mockResolvedValue({
      result: bareReplayResult({
        outcome: "complete",
        completed: 0,
        total: 0,
        bundle: null,
      }),
      spans: [],
      navigationError: null,
    });

    const result = await runPipeline({
      scene: SCENE,
      targetUrl: TARGET_URL,
      outPath: OUT_PATH,
    });

    expect(result.kind).toBe("renderFailed");
    expect(muxSpansMock).not.toHaveBeenCalled();
    expect(renderPhaseMock).not.toHaveBeenCalled();
    expect(existsSync(capturedRunRoot())).toBe(true);
  });

  it("returns muxFailed without calling render when a span could not be muxed", async () => {
    const { runPipeline } = await import("../src/pipeline.js");
    const bundle = bundleWith();
    replayPhaseMock.mockResolvedValue({
      result: bareReplayResult({
        outcome: "complete",
        completed: 4,
        total: 4,
        bundle,
      }),
      spans: [{ ref: "span:s1:0" }],
      navigationError: null,
    });
    muxSpansMock.mockResolvedValue({
      muxed: [
        {
          index: 1,
          // Review finding 3: the sentence names the PARKED index (the
          // number in the span's own ref), not the position among kept
          // spans — here they differ, so the assertion below can tell.
          spanIndex: 4,
          kept: false,
          lost: 3,
          reason: "screenshot is not a JPEG this parser understands",
        },
      ],
      shortfall: 3,
    });

    const result = await runPipeline({
      scene: SCENE,
      targetUrl: TARGET_URL,
      outPath: OUT_PATH,
    });

    expect(result.kind).toBe("muxFailed");
    if (result.kind === "muxFailed") {
      expect(result.spanIndex).toBe(4);
      expect(result.message).toContain("3");
      // Runner audit 2026-09-14, finding 1: the reason used to live only on
      // the process's stderr, above the sentence it explains. It is in the
      // sentence now.
      expect(result.message).toContain("not a JPEG");
    }
    expect(renderPhaseMock).not.toHaveBeenCalled();
    // The blank-page navigation happens before mux, not after a stopped run.
    expect(pageGotoMock).toHaveBeenCalledWith("about:blank");
    expect(existsSync(capturedRunRoot())).toBe(true);
  });

  it("renders, maps degradations to note (falling back to kind when empty), and removes the scratch directory", async () => {
    const { runPipeline } = await import("../src/pipeline.js");
    const bundle = bundleWith([
      { kind: "keyframeOnly", note: "", startMs: 0, endMs: 100 },
      {
        kind: "occlusionPause",
        note: "paused for 400ms",
        startMs: 100,
        endMs: 500,
      },
    ] as never);
    replayPhaseMock.mockResolvedValue({
      result: bareReplayResult({
        outcome: "complete",
        completed: 4,
        total: 4,
        bundle,
        storageRefused: false,
      }),
      spans: [],
      navigationError: null,
    });
    muxSpansMock.mockResolvedValue({ muxed: [], shortfall: 0 });
    renderPhaseMock.mockResolvedValue(RENDERED);

    const result = await runPipeline({
      scene: SCENE,
      targetUrl: TARGET_URL,
      outPath: OUT_PATH,
    });

    expect(result).toEqual({
      kind: "rendered",
      outPath: OUT_PATH,
      completed: 4,
      total: 4,
      degradations: ["keyframeOnly", "paused for 400ms"],
      storageRefused: false,
    });
    expect(renderPhaseMock).toHaveBeenCalledTimes(1);
    expect(closeMock).toHaveBeenCalled();

    // Task 12 fix round 1: the deliverable is written, so the scratch
    // directory `runPipeline` made for this run is gone — the output is
    // the deliverable, the scratch is not.
    expect(existsSync(capturedRunRoot())).toBe(false);
  });

  it("reports renderFailed — not an exit-70 internal error — when render itself throws", async () => {
    const { runPipeline } = await import("../src/pipeline.js");
    const bundle = bundleWith();
    replayPhaseMock.mockResolvedValue({
      result: bareReplayResult({
        outcome: "complete",
        completed: 1,
        total: 1,
        bundle,
      }),
      spans: [],
      navigationError: null,
    });
    muxSpansMock.mockResolvedValue({ muxed: [], shortfall: 0 });
    renderPhaseMock.mockRejectedValue(
      new Error("mp4 sink finished with no frame added"),
    );

    // DELIBERATELY CHANGED by the whole-branch review's finding 2. This
    // assertion used to be `.rejects.toThrow(/no frame added/)`, and it
    // pinned the defect rather than the contract: `renderPhase` throws on
    // every genuine render failure (sink error, WebCodecs failure, ENOSPC,
    // an unwritable `--out`), `runPipeline` caught none of it, and cli.ts's
    // top-level handler printed "internal error — this is a bug in the
    // runner, not a problem with your scene" and exited 70 over a full
    // disk. Design §5's exit-5 render row was unreachable on the real path.
    // The sink's own error still reaches the user; it now arrives as the
    // row that describes it.
    const result = await runPipeline({
      scene: SCENE,
      targetUrl: TARGET_URL,
      outPath: OUT_PATH,
    });
    expect(result.kind).toBe("renderFailed");
    if (result.kind === "renderFailed") {
      expect(result.message).toMatch(/no frame added/);
    }

    expect(closeMock).toHaveBeenCalled();
    const root = capturedRunRoot();
    expect(existsSync(root)).toBe(true);
    expect(notesText(result)).toContain(root);
    expect(consoleText()).not.toContain(root);
  });

  it("returns internalError — not a rejection — for an engine invariant violation", async () => {
    // The exit-70 row still exists and still says the same thing; what
    // changed (finding 9) is that it comes back as a value, so the teardown
    // notes can ride along and print after its sentence rather than above
    // it. cli.ts's own top-level catch remains for anything that escapes a
    // `RunPipeline` implementation entirely — `cli.test.ts` pins that.
    const { runPipeline } = await import("../src/pipeline.js");
    replayPhaseMock.mockResolvedValue({
      // "Every mid-run stop breaks before its completed++": a partial
      // outcome carrying no reason is the engine breaking its own
      // invariant, not a scene problem.
      result: bareReplayResult({
        outcome: "partial",
        reason: null,
        completed: 1,
        total: 4,
      }),
      spans: [],
      navigationError: null,
    });

    const result = await runPipeline({
      scene: SCENE,
      targetUrl: TARGET_URL,
      outPath: OUT_PATH,
    });

    expect(result.kind).toBe("internalError");
    if (result.kind === "internalError") {
      expect(result.message).toMatch(/invariant violation/i);
      expect(result.stack).toBeTruthy();
    }
    expect(notesText(result)).toContain(capturedRunRoot());
  });

  it("reports startupFailed, and leaves no scratch directory, when the browser cannot be launched", async () => {
    // Whole-branch review findings 2 and 6, in one run: `launch()` sat
    // OUTSIDE the try, so a machine with no Chromium was told "this is a
    // bug in the runner" (exit 70), AND the `mkdtempSync` above it had
    // already created a scratch directory the `finally` would never reach —
    // one leaked directory per failed launch, through the one door Task
    // 12's cleanup fix did not cover.
    launchMock.mockRejectedValueOnce(
      new Error(
        "Executable doesn't exist at /ms-playwright/chromium-1/chrome-mac/Chromium",
      ),
    );
    const { runPipeline } = await import("../src/pipeline.js");

    const result = await runPipeline({
      scene: SCENE,
      targetUrl: TARGET_URL,
      outPath: OUT_PATH,
    });

    expect(result.kind).toBe("startupFailed");
    if (result.kind === "startupFailed") {
      expect(result.message).toMatch(/could not start a browser/i);
      // The real cause, verbatim — not paraphrased away.
      expect(result.message).toContain("Executable doesn't exist");
      // Launch prep defect 1: the install advice names the loaded
      // Playwright, never `pnpm exec` (this repo only) or a bare `npx`
      // (npm's latest, whose Chromium this Playwright does not look for).
      const loaded = createRequire(import.meta.url)("playwright/package.json")
        .version as string;
      expect(loaded).toMatch(/^\d+\.\d+\.\d+/);
      expect(result.message).toContain(
        `npx playwright@${loaded} install chromium`,
      );
      expect(result.message).not.toContain("pnpm exec");
    }
    // Nothing was created to leak: the scratch directory is made only once
    // there is a browser to fill it. `createFileFrameStore` is the only
    // consumer of `mkdtempSync`'s result, so never being called is the
    // assertion — `capturedRunRoot()` would throw here.
    expect(createFileFrameStoreMock).not.toHaveBeenCalled();
    expect(mkdtempSyncMock).not.toHaveBeenCalled();
    expect(replayPhaseMock).not.toHaveBeenCalled();
  });

  it("reports targetUnreachable, without blaming the scene, when the URL did not load", async () => {
    // Whole-branch review finding 3: `Page.navigate`'s `errorText` was
    // dropped unread, so an unreachable `--url` replayed against
    // `about:blank`, failed to resolve, and exited 4 telling the author to
    // re-record a step that was never broken.
    const { runPipeline } = await import("../src/pipeline.js");
    replayPhaseMock.mockResolvedValue({
      result: bareReplayResult({
        outcome: "partial",
        reason: "anchorUnreachable",
        completed: 0,
        total: 4,
      }),
      spans: [],
      navigationError: "net::ERR_CONNECTION_REFUSED",
    });

    const result = await runPipeline({
      scene: SCENE,
      targetUrl: TARGET_URL,
      outPath: OUT_PATH,
    });

    // The navigation failure outranks the stop reason it caused: the stop
    // describes `about:blank`, not the author's scene.
    expect(result.kind).toBe("targetUnreachable");
    if (result.kind === "targetUnreachable") {
      expect(result.errorText).toBe("net::ERR_CONNECTION_REFUSED");
      expect(result.targetUrl).toBe(TARGET_URL);
    }
    expect(muxSpansMock).not.toHaveBeenCalled();
    expect(renderPhaseMock).not.toHaveBeenCalled();
  });

  it("reports frames a KEPT span silently dropped as degradations", async () => {
    // Whole-branch review finding 5: `shortfall` and per-span `lost` were
    // computed and never read — `pipeline.ts` consulted only `!kept` — so a
    // span that muxed while dropping 40 of its 150 frames exited 0 with
    // output indistinguishable from a lossless run.
    const { runPipeline } = await import("../src/pipeline.js");
    const bundle = bundleWith();
    replayPhaseMock.mockResolvedValue({
      result: bareReplayResult({
        outcome: "complete",
        completed: 4,
        total: 4,
        bundle,
      }),
      spans: [],
      navigationError: null,
    });
    muxSpansMock.mockResolvedValue({
      muxed: [
        { index: 0, spanIndex: 0, kept: true, lost: 0, reason: null },
        // Review finding 3: named by the parked index (2), not the kept
        // position (1) — an unkept static span sat between them.
        { index: 1, spanIndex: 2, kept: true, lost: 40, reason: null },
      ],
      shortfall: 40,
    });
    renderPhaseMock.mockResolvedValue(RENDERED);

    const result = await runPipeline({
      scene: SCENE,
      targetUrl: TARGET_URL,
      outPath: OUT_PATH,
    });

    expect(result.kind).toBe("rendered");
    if (result.kind === "rendered") {
      const notes = result.degradations.join("\n");
      expect(notes).toContain("40");
      expect(notes).toMatch(/missing from the video/i);
      // The span, named — a total with no span to look at is not actionable
      // — by its parked index, the number in its own ref.
      expect(notes).toMatch(/span 2/);
      expect(notes).not.toMatch(/span 1/);
      // And span 0, which lost nothing, is not accused of losing anything.
      expect(notes).not.toMatch(/span 0/);
    }
  });

  it("carries every failed span's reason, not only the first, when more than one span would not mux", async () => {
    // Review of the runner audit, finding 2. `muxFailed` is built from the
    // FIRST unkept span and returned; the deleted per-span `console.warn`
    // used to print every failed span's reason, so a run with two failures
    // lost the second one entirely — a regression in the reporting this
    // branch exists to fix. The others ride on `notes`.
    const { runPipeline } = await import("../src/pipeline.js");
    replayPhaseMock.mockResolvedValue({
      result: bareReplayResult({
        outcome: "complete",
        completed: 4,
        total: 4,
        bundle: bundleWith(),
      }),
      spans: [],
      navigationError: null,
    });
    muxSpansMock.mockResolvedValue({
      muxed: [
        { index: 0, spanIndex: 1, kept: false, lost: 3, reason: "not a JPEG" },
        { index: 1, spanIndex: 2, kept: true, lost: 0, reason: null },
        { index: 2, spanIndex: 3, kept: false, lost: 5, reason: "ENOSPC" },
      ],
      shortfall: 8,
    });

    const result = await runPipeline({
      scene: SCENE,
      targetUrl: TARGET_URL,
      outPath: OUT_PATH,
    });

    expect(result.kind).toBe("muxFailed");
    if (result.kind === "muxFailed") {
      expect(result.spanIndex).toBe(1);
      expect(result.message).toContain("not a JPEG");
    }
    const notes = notesText(result);
    expect(notes, notes).toMatch(/span 3.*ENOSPC/);
    // The one already in the sentence is not repeated as a note.
    expect(notes, notes).not.toContain("not a JPEG");
  });

  it("still says the browser crashed when the run failed before its finally — the scratch-directory failure path", async () => {
    // Review of the runner audit, finding 4. The `mkdtempSync` failure
    // path closes the browser itself and returns before the `finally` that
    // reads `CloseOutcome` — so a browser that died between launching and
    // the scratch directory failing reported only the directory.
    const { runPipeline } = await import("../src/pipeline.js");
    mkdtempSyncMock.mockImplementationOnce(() => {
      throw new Error("ENOSPC: no space left on device, mkdtemp");
    });
    closeMock.mockResolvedValueOnce({ crashed: true });

    const result = await runPipeline({
      scene: SCENE,
      targetUrl: TARGET_URL,
      outPath: OUT_PATH,
    });

    expect(result.kind).toBe("startupFailed");
    const notes = notesText(result);
    expect(notes, notes).toMatch(/crashed|did not shut down cleanly/i);
    expect(consoleText()).not.toMatch(/crashed|did not shut down cleanly/i);
  });

  it("hands the phases a reporter whose lines land on the result's notes, not on the console", async () => {
    // Runner audit 2026-09-14, finding 1. `replayPhase` — and through it
    // the page agent and the parking encoder — wrote its diagnostics to
    // `console.error`/`console.warn`. The pipeline now hands them a
    // reporter, and what they say rides on `notes`: printed by `cli.ts`
    // AFTER the result's own sentence, and visible to a caller that drove
    // `main` in-process with its own `RunnerIo`.
    const { runPipeline } = await import("../src/pipeline.js");
    const LINE = 'demoman: anchor "a-search" has an unparseable tree path';
    replayPhaseMock.mockImplementationOnce(
      async (input: { report: (line: string) => void }) => {
        input.report(LINE);
        return {
          result: bareReplayResult({
            outcome: "complete",
            completed: 4,
            total: 4,
            bundle: bundleWith(),
          }),
          spans: [],
          navigationError: null,
        };
      },
    );
    muxSpansMock.mockResolvedValue({ muxed: [], shortfall: 0 });
    renderPhaseMock.mockResolvedValue(RENDERED);

    const result = await runPipeline({
      scene: SCENE,
      targetUrl: TARGET_URL,
      outPath: OUT_PATH,
    });

    expect(result.kind).toBe("rendered");
    expect(notesText(result)).toContain(LINE);
    expect(consoleText()).not.toContain(LINE);
  });

  it("says on the notes why the file has no logo, and only when it has none", async () => {
    // Report before you forgive: `renderPhase` forgives a logo it cannot
    // draw (the file is still whole), so the reason has to reach the notes.
    // Red if pipeline.ts stops printing `logoWarning`.
    const { runPipeline } = await import("../src/pipeline.js");
    const WARNING = "The logo was left out: demoman render reads no logo files";
    const replayed = {
      result: bareReplayResult({
        outcome: "complete",
        completed: 4,
        total: 4,
        bundle: bundleWith(),
      }),
      spans: [],
      navigationError: null,
    };
    replayPhaseMock.mockResolvedValue(replayed);
    muxSpansMock.mockResolvedValue({ muxed: [], shortfall: 0 });

    renderPhaseMock.mockResolvedValueOnce({
      ...RENDERED,
      logoWarning: WARNING,
    });
    const warned = await runPipeline({
      scene: SCENE,
      targetUrl: TARGET_URL,
      outPath: OUT_PATH,
    });
    expect(warned.kind).toBe("rendered");
    expect(notesText(warned)).toContain(WARNING);

    renderPhaseMock.mockResolvedValueOnce(RENDERED);
    const clean = await runPipeline({
      scene: SCENE,
      targetUrl: TARGET_URL,
      outPath: OUT_PATH,
    });
    expect(clean.kind).toBe("rendered");
    expect(notesText(clean)).not.toContain("logo");
  });

  it("says the browser crashed, on the notes, when close() reports it did not shut down cleanly", async () => {
    // Runner audit 2026-09-14, finding 2. `launch.ts`'s `close()` warned
    // straight to the console during the pipeline's `finally` — above the
    // sentence the CLI was about to print — and an in-process caller never
    // saw it. It returns `{ crashed }` now, and this is where it becomes a
    // line, in the right place.
    const { runPipeline } = await import("../src/pipeline.js");
    replayPhaseMock.mockRejectedValueOnce(
      new Error("Target page, context or browser has been closed"),
    );
    closeMock.mockResolvedValueOnce({ crashed: true });

    const result = await runPipeline({
      scene: SCENE,
      targetUrl: TARGET_URL,
      outPath: OUT_PATH,
    });

    expect(result.kind).toBe("internalError");
    const notes = notesText(result);
    expect(notes, notes).toMatch(/crashed|did not shut down cleanly/i);
    expect(consoleText()).not.toMatch(/crashed|did not shut down cleanly/i);
  });

  it("does not accuse a browser that closed cleanly of crashing", async () => {
    // The fallback half: a note that fires either way is the row of
    // CLAUDE.md's table this fix is not allowed to add.
    const { runPipeline } = await import("../src/pipeline.js");
    replayPhaseMock.mockResolvedValue({
      result: bareReplayResult({
        outcome: "complete",
        completed: 1,
        total: 1,
        bundle: bundleWith(),
      }),
      spans: [],
      navigationError: null,
    });
    muxSpansMock.mockResolvedValue({ muxed: [], shortfall: 0 });
    renderPhaseMock.mockResolvedValue(RENDERED);

    const result = await runPipeline({
      scene: SCENE,
      targetUrl: TARGET_URL,
      outPath: OUT_PATH,
    });

    expect(result.kind).toBe("rendered");
    expect(notesText(result)).not.toMatch(/crashed|did not shut down cleanly/i);
  });

  it("reports a failed cleanup rather than turning a successful run into a failed one", async () => {
    rmMock.mockRejectedValueOnce(new Error("EBUSY: directory in use"));
    const { runPipeline } = await import("../src/pipeline.js");
    const bundle = bundleWith();
    replayPhaseMock.mockResolvedValue({
      result: bareReplayResult({
        outcome: "complete",
        completed: 1,
        total: 1,
        bundle,
      }),
      spans: [],
      navigationError: null,
    });
    muxSpansMock.mockResolvedValue({ muxed: [], shortfall: 0 });
    renderPhaseMock.mockResolvedValue(RENDERED);

    // The removal failing must not turn this into a rejection or a
    // different `PipelineResult.kind` — the run itself succeeded.
    const result = await runPipeline({
      scene: SCENE,
      targetUrl: TARGET_URL,
      outPath: OUT_PATH,
    });
    expect(result.kind).toBe("rendered");

    const notes = notesText(result);
    expect(notes).toContain(capturedRunRoot());
    expect(notes.toLowerCase()).toContain("ebusy");
    expect(consoleText()).not.toContain(capturedRunRoot());
  });

  it("keeps the scratch directory — and does not delete the mp4 — when --out lives inside it", async () => {
    // Pins the run root to a KNOWN directory before `runPipeline` ever
    // runs, the same way the reviewer's own repro did: against the real
    // `mkdtempSync`, the random suffix means nothing can be pointed inside
    // it in advance, which is exactly why this is not reachable today.
    // `mkdtempSyncMock`'s default implementation is still the real
    // `mkdtempSync` here, so this call really creates the directory.
    const fixedRoot = mkdtempSyncMock(join(tmpdir(), "demoman-run-"));
    mkdtempSyncMock.mockImplementationOnce(() => fixedRoot);
    const outPath = join(fixedRoot, "demo.mp4");

    const { runPipeline } = await import("../src/pipeline.js");
    const bundle = bundleWith();
    replayPhaseMock.mockResolvedValue({
      result: bareReplayResult({
        outcome: "complete",
        completed: 1,
        total: 1,
        bundle,
      }),
      spans: [],
      navigationError: null,
    });
    muxSpansMock.mockResolvedValue({ muxed: [], shortfall: 0 });
    // The real `renderPhase` writes `outPath`; this fake stands in for it
    // and does the one thing this test actually needs: the file exists at
    // `outPath`, inside `fixedRoot`, by the time `renderPhase` resolves —
    // exactly the state the reviewer's repro found `rm` deleting.
    renderPhaseMock.mockImplementation(async () => {
      await writeFile(
        outPath,
        "not a real mp4 — this test only needs a file at outPath",
      );
      return RENDERED;
    });

    const result = await runPipeline({
      scene: SCENE,
      targetUrl: TARGET_URL,
      outPath,
    });

    expect(result.kind).toBe("rendered");
    // The defect this fix round closes: a successful run reporting a path
    // that no longer exists. Both must survive here — the file-level
    // `afterEach` above still removes `fixedRoot` once this test finishes,
    // same as every other test in this file.
    expect(existsSync(outPath)).toBe(true);
    expect(existsSync(fixedRoot)).toBe(true);

    const notes = notesText(result);
    expect(notes).toContain(fixedRoot);
    expect(notes.toLowerCase()).toContain("kept");
    expect(consoleText()).not.toContain(fixedRoot);
  });

  it("keeps the run's result — and still cleans up — when the browser will not close", async () => {
    // Round 2's finding 4. `await launched.close()` in the `finally` was
    // unguarded, and `launch.ts`'s `close()` has exactly one unguarded await
    // of its own (`server.close()`), with its idempotence flag already set
    // before it — so a rejection there is final. An exception in a `finally`
    // completes it ABRUPTLY: the scratch-directory block below it never ran,
    // and `result` — decided, `rendered`, with the mp4 already written — was
    // thrown away as a rejection, which `cli.ts` prints as "internal error —
    // this is a bug in the runner" and exits 70 over a successful run.
    const { runPipeline } = await import("../src/pipeline.js");
    replayPhaseMock.mockResolvedValue({
      result: bareReplayResult({
        outcome: "complete",
        completed: 4,
        total: 4,
        bundle: bundleWith(),
      }),
      spans: [],
      navigationError: null,
    });
    muxSpansMock.mockResolvedValue({ muxed: [], shortfall: 0 });
    renderPhaseMock.mockResolvedValue(RENDERED);
    closeMock.mockRejectedValueOnce(
      new Error("Target page, context or browser has been closed"),
    );

    const result = await runPipeline({
      scene: SCENE,
      targetUrl: TARGET_URL,
      outPath: OUT_PATH,
    });

    // The run is still what it was: rendered, not an internal error.
    expect(result.kind).toBe("rendered");
    // And the reason is not swallowed — CLAUDE.md's rule is that the control
    // flow may be forgiven and the reason may not. A Chromium process may
    // still be running, and this is the only thing that would ever say so.
    const notes = notesText(result);
    expect(notes, notes).toMatch(/could not be closed/i);
    expect(notes, notes).toContain("Target page, context or browser");
    // The block AFTER the failed close still ran: on a rendered run the
    // scratch directory goes away. Unguarded, this stayed on disk.
    expect(existsSync(capturedRunRoot())).toBe(false);
  });

  it("keeps the run's result when the debugger session will not detach", async () => {
    // The same shape one door earlier. `toCdpSession.detach` swallows
    // `session.detach()` internally, so this guard is on the PORT rather
    // than on the session — `Launched.cdp` is the engine's own injectable
    // type, and nothing about it promises a `detach` that cannot reject.
    const { runPipeline } = await import("../src/pipeline.js");
    replayPhaseMock.mockResolvedValue({
      result: bareReplayResult({
        outcome: "complete",
        completed: 1,
        total: 1,
        bundle: bundleWith(),
      }),
      spans: [],
      navigationError: null,
    });
    muxSpansMock.mockResolvedValue({ muxed: [], shortfall: 0 });
    renderPhaseMock.mockResolvedValue(RENDERED);
    cdpDetachMock.mockRejectedValueOnce(new Error("session already gone"));

    const result = await runPipeline({
      scene: SCENE,
      targetUrl: TARGET_URL,
      outPath: OUT_PATH,
    });

    expect(result.kind).toBe("rendered");
    // The browser is still closed after it: a detach that threw must not
    // skip the close below it, which is the call that ends the OS process.
    expect(closeMock).toHaveBeenCalled();
    const notes = notesText(result);
    expect(notes, notes).toMatch(/could not be detached/i);
    expect(existsSync(capturedRunRoot())).toBe(false);
  });
});

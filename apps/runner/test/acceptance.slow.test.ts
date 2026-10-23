// Slow tier: replays and renders a 1080p mp4 in software, then decodes it. `pnpm test:fast` skips it; `pnpm test` and CI run it.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  contentScale,
  derivePresentation,
  LANDSCAPE_1080P,
} from "@demoman/compositor";
import { migrateToCurrent, type SceneDocument } from "@demoman/scene-schema";
import type { Page } from "playwright";
import { afterAll, beforeAll, expect, it } from "vitest";
import { fixtureScene } from "../../../packages/compositor/scripts/fixture-scene.js";
import { bundleEntry } from "../src/bundle-js.js";
import type {
  DecodeProbeEntry,
  FrameReading,
  RectReading,
  Rgb,
  SampleRequest,
} from "../src/decode-probe-entry.js";
import { DECODE_PROBE_GLOBAL } from "../src/entry-globals.js";
import { type Launched, launch } from "../src/launch.js";
import { installResolver } from "../src/page-agent.js";
import { runPipeline } from "../src/pipeline.js";
import { fixtureDriftComplaints, serveFixtureApp } from "./fixture.js";

/**
 * The whole runner, end to end: a scene document and a URL in, an mp4 on
 * disk out, and pixels decoded from that mp4 asserted against what
 * `fixture-app.html` actually paints.
 *
 * Everything else in this lane is a component test. This is the one that
 * fails if the product does not work — the automated stand-in for the human
 * who watched a render and found typing that never appeared, a take that
 * flipped between two pages, and a cursor painted far to the right of its
 * target, all of which had shipped past a full green suite (CLAUDE.md,
 * "Assert on the picture, not the bundle").
 *
 * ## Why these three assertions
 *
 * 1. **It is the app, and not a blank page.** `fixture-app.html`'s header is
 *    a solid 72px band of `#1f2937` across the top. Proven from the outside,
 *    this is the whole navigation coupling: the frames in the mp4 came from
 *    the page at `--url` and from nowhere else.
 * 2. **The panel opened, and it opened over time.** The panel is the only
 *    in-app motion in the fixture — an 800ms slide over the checkout button.
 *    Asserted as "there are frames in which the panel and the button are on
 *    screen AT ONCE", which is a state the app only ever passes THROUGH: a
 *    keyframe-only bundle has the button-and-no-panel keyframe and the
 *    panel-and-no-button keyframe and nothing between them, so it cannot
 *    produce one. That is the point — design §-decision 8 rejects a
 *    keyframe-only v1, and this is the assertion that holds it to that.
 * 3. **The cursor is painted.** Replay's whole output is a cursor moving
 *    over an app; a video of the app with no pointer has lost half the
 *    product.
 *
 * ## Why fractions, block means, and counted colours
 *
 * Every sample is a fraction of the frame, never an absolute pixel, so a
 * target-size change cannot silently move a sample off the thing it samples.
 * Points are read as the MEAN of a small block, because the fixture's own
 * body text is `#111827` — the panel's exact colour — and a one-pixel sample
 * that lands on a glyph would read as "panel" over a white table.
 *
 * Assertion 2 counts colours over the whole frame rather than sampling fixed
 * coordinates, and that is deliberate: the camera zooms in on the checkout
 * button and back out again across exactly the stretch it cares about, so
 * any fixed coordinate is a bet on where the camera happens to be. "How much
 * `#3b5bdb` is on screen" does not move when the camera does. The panel's
 * count is eroded before it is compared, because the app's body text shares
 * the panel's colour and the camera magnifies it — see `PANEL_ERODE_PX`.
 *
 * Nor is anything here stated as a timestamp. The render's own duration
 * varies run to run (8.15-8.52 s across three 1080p renders of
 * `acceptanceScene()`, 2026-10-17), so every absolute time in it is a
 * property of one run and not of the fixture.
 *
 * The measurements below were taken by decoding EVERY frame of those three
 * renders, at 1920x1080. The 4K figures they replace (2026-09) are in git.
 */

/**
 * The shared fixture scene, its actions a second apart.
 *
 * `fixtureScene()` keeps the author's recorded gaps (400, 3200, 9000 and
 * 12000 ms), and a recorded gap longer than the motion it holds becomes a
 * pace: 5.1 s of the 13.8 s that render ran. Nothing here asserts on a pace,
 * so this copy closes the gaps to 1 s; the render runs 8.2-8.5 s (measured
 * 2026-10-17). The anchors, the camera and the branding are the shared
 * fixture's, which `fixture-guard` keeps true to `fixture-app.html`.
 */
function acceptanceScene(): SceneDocument {
  const scene = fixtureScene();
  return {
    ...scene,
    actions: scene.actions.map((action, i) => ({
      ...action,
      timestamp: 400 + i * 1000,
    })),
  };
}

/** `fixture-app.html`'s `header { background: #1f2937 }`. */
const APP_HEADER: Rgb = [31, 41, 55];
/** `#checkout-btn { background: #3b5bdb }` — the app's accent, and the only
 *  place in `fixture-app.html` that colour appears. */
const APP_ACCENT: Rgb = [59, 91, 219];
/** `#panel { background: #111827 }` — also the body text colour, which is
 *  why nothing here samples it one pixel at a time. */
const APP_PANEL: Rgb = [17, 24, 39];

/**
 * Three points along `fixture-app.html`'s header band, in the first frame.
 *
 * DERIVED from the presentation, not written down. These were three literal
 * frame fractions — `[0.45, 0.09]` and friends — chosen from a render at the
 * 0.05 landscape inset, where the content box occupied x 0.094-0.905 and y
 * 0.041-0.955 of the frame. Raising the landscape inset to 0.15 on
 * 2026-09-21 moved the content box inward, and y 0.09 stopped being the
 * header at all: it landed on the branded background, the probe read
 * rgb(197,219,252), and the failure claimed "the video does not open on the
 * app" about a render that was perfectly correct.
 *
 * So the points are computed from `derivePresentation`, the fixture's own
 * branding (its padding is the inset) and the capture viewport, exactly as
 * the compositor computes where to draw. The FRACTIONS
 * OF THE CONTENT BOX are what the original reasoning actually fixed — 0.44,
 * 0.62 and 0.87 across the band, clear of the brand wordmark (x ~0.11) and
 * the search input (x 0.17-0.37), which are the only two things drawn inside
 * it — and those are unchanged. Only their position in the frame moves.
 *
 * Read off `LANDSCAPE_1080P`, the tier this test renders at, and correct
 * for every landscape preset: all three are 16:9 and share `fit`, and the
 * padding is the branding's, so the content box lands on the same fractions
 * of the frame at every one of them.
 */
const HEADER_POINTS: [number, number][] = (() => {
  const scene = fixtureScene();
  const viewport = scene.meta.capture.viewport;
  const { frameRect } = derivePresentation(
    scene.branding,
    LANDSCAPE_1080P,
    viewport,
  );
  const scale = contentScale(frameRect, viewport);
  // `header { height: 72px }`, at the top of the page: sample its middle.
  const y = (frameRect.y + 36 * scale) / LANDSCAPE_1080P.height;
  return [0.44, 0.62, 0.87].map((fx): [number, number] => [
    (frameRect.x + fx * frameRect.width) / LANDSCAPE_1080P.width,
    y,
  ]);
})();

/**
 * Where the cursor rests through the click, as a fraction of the frame.
 *
 * The pointer is parked on the checkout button from the moment the path
 * lands until it leaves for the nav link, and once the panel is open the
 * button is BEHIND the panel — so this rect is a flat field of `#111827`
 * with a white arrow on it and nothing else. That is the whole reason the
 * cursor check is made here and not over the table: the app paints plenty of
 * white of its own, and the panel paints none.
 *
 * Read at full resolution, unlike everything else: the arrow's white core
 * measures about 19x31 output px at 1080p, which the 960-wide working copy's
 * average blends into the dark behind it. Where in the frame that core sits
 * is NOT a fixture constant — it depends on where the camera is when the
 * sweep happens to sample, and the camera pulls out across this stretch.
 * This rect is sized to hold the whole of that travel with room around it,
 * which is why it is ~14x the core's width and ~6x its height rather than a
 * tight crop.
 */
const CURSOR_RECT: [number, number, number, number] = [0.68, 0.66, 0.82, 0.84];

/**
 * How far apart the sweep's frames are, in seconds of the mp4.
 *
 * Sized against the window assertion 2 needs — the panel on screen with the
 * button not yet covered — measured by decoding EVERY frame of three
 * separate renders rather than by sampling one:
 *
 *   render duration   8.517 s   8.450 s   8.150 s
 *   window opens      5.373 s   5.350 s   5.073 s
 *   window closes     5.739 s   5.700 s   5.422 s
 *   window width      ~383 ms   ~367 ms   ~366 ms   (23, 22, 22 frames)
 *
 * Nothing in that table is a fixture constant. Run to run the render's own
 * duration varies and every absolute time moves with it — which is why the
 * assertion counts qualifying frames instead of naming timestamps.
 *
 * A SPACING, not a count. This was 120 frames spread across whatever
 * duration the file had, which was one every ~64 ms at ~7.7 s. Recorded
 * paces (rebuild mode's reconstruction of the author's own waits) took the
 * fixture to ~13.3 s — 5.1 s of it paces — and the same 120 frames landed
 * every ~122 ms: the window caught one sample or two against the two this
 * asks for, and the test flaked from 2026-09-22 with nothing wrong in it
 * but its density. The window is a property of the panel's slide, so the
 * density is stated against the window.
 *
 * One every 64 ms puts five or six inside the narrowest window measured.
 * The assertion asks for two, so the window would have to lose well over
 * half its width before this went red for a reason that is not a defect.
 * At that spacing an ~8.5 s file is ~133 frames to read.
 */
const SWEEP_SPACING_SEC = 0.064;

/**
 * Counting the panel, and why it is counted ERODED.
 *
 * `#111827` is the panel's fill and also the app's body-text colour, so a
 * plain match count answers "how much #111827 is on screen" and not "is the
 * panel on screen". The camera magnifies that text as it zooms into the
 * table, and the count follows it. At 4K (2026-09) the highest plain
 * `#111827` count on a frame with no panel on screen reached 1,686, a margin
 * of only 3.0x under a 5,000 threshold, and it errs in the direction that
 * reports success: a frame over 5,000 with NO panel satisfies both halves of
 * `midSlide`, and `midSlide` is the one assertion that rejects a
 * keyframe-only bundle.
 *
 * So the count is eroded by `PANEL_ERODE_PX` (see
 * `SampleRequest.colorErode`) before it is compared. Over every frame of the
 * three 1080p renders (frames before the panel first clears 5,000, less the
 * three before that):
 *
 *   panel-closed frames      320       318       302
 *   worst plain count        590       588       582
 *   worst eroded (6 px)        0         0         0
 *
 * At radius 6 the ceiling is ZERO: no panel-closed frame contributes a
 * single pixel. The panel itself keeps plenty — the first frame it clears
 * 5,000 in counts 5,983-7,838, and fully open it counts up to 89,000-91,000.
 * The counts are on the 960-wide working copy, the same size at every
 * render tier.
 *
 * 5,000 is therefore not the thing separating panel from text; the erosion
 * is. It means only "a fill of some size", and nothing measured approaches
 * it from below.
 *
 * `ACCENT_STILL_SHOWING` at 200 is ~16% of the smallest unobstructed button
 * (1,217-6,276 across these renders; the camera's zoom is the range) — a
 * strip of it a viewer can still see. `#3b5bdb` appears nowhere else in
 * `fixture-app.html`, so it needs no erosion.
 */
const COLOR_TOLERANCE = 8;
const PANEL_ERODE_PX = 6;
const PANEL_ON_SCREEN = 5_000;
const ACCENT_STILL_SHOWING = 200;

/**
 * A pixel counts as the cursor's white at or above this in every channel,
 * and the rect counts as "the flat panel behind it" below that mean luma.
 * Measured over every frame of the three 1080p renders, on the 45-48 frames
 * a render has whose rect is the flat open panel (mean luma 23.0-39.4; the
 * panel is luma 23.6): 22-25 of them hold the arrow, at 250-281 near-white
 * px, in a box 0.0094-0.0104 x 0.0278-0.0296 of the 1920x1080 frame.
 *
 * `CURSOR_BLOB_MIN` is a 1080p count, and the test asserts it renders at
 * 1920x1080 before reading it: 80 is ~a third of the smallest core, the
 * ratio the 4K value (150 of 466) had. The size bounds are ~2x the core:
 * loose enough that a differently-shaped pointer still counts, tight enough
 * that the slivers of white table that leak in as the camera pulls out —
 * 8-9 frames a render, 194-3,559 px, every one 0.1796 of the frame tall —
 * do not.
 */
const NEAR_WHITE_MIN = 200;
const CURSOR_BLOB_MIN = 80;
const CURSOR_BLOB_MAX_WIDTH = 0.02;
const CURSOR_BLOB_MAX_HEIGHT = 0.065;
const PANEL_FLAT_MAX_LUMA = 40;

/**
 * Timeouts.
 *
 * Measured on this machine (Apple silicon, 2026-10-17), the file alone, two
 * runs, while macOS's media services were loading it (load 13-37):
 *
 *   `main(...)`: replay, then a 1920x1080 render of an ~8.3 s take   57.0 s   84.9 s
 *   the sweep, ~130 frames read back                                2.3 s    2.3 s
 *   this test, end to end                                          59.5 s   87.4 s
 *
 * Before this test rendered `acceptanceScene()` at 1080p it rendered the
 * shared scene at 4K: 308 s of render in a 323 s test, and ~34 min at CI's
 * pace. The take is shorter (paces closed) and each frame is a quarter of
 * the pixels.
 *
 * CI is a further ~5x slower than this machine at browser work (CLAUDE.md,
 * `fff4505`): 87.4 s here is ~440 s there. 900 s is ~2x that: a ceiling on
 * a hang, not a budget.
 *
 * Nothing here sleeps for a duration. The one wait is `page.goto`'s own
 * `load`, and the pipeline's own waits are the engine's condition-based
 * ones.
 */
const TEST_TIMEOUT_MS = 900_000;
const HOOK_TIMEOUT_MS = 30_000;

let launched: Launched;
let page: Page;
let server: { url: string; close(): void };

beforeAll(async () => {
  server = await serveFixtureApp();
  launched = await launch();
  page = launched.page;

  // The fixture guard (Task 9), run here rather than restated: if
  // `fixture-app.html` has drifted from `fixture-scene.ts`, this hook fails
  // naming the anchor, instead of the pixel assertions below failing with a
  // colour comparison nobody can act on. `installResolver` before the first
  // navigation and the scene's own viewport for the layout, both for the
  // reasons `fixture-guard.test.ts`'s own `beforeAll` gives.
  await installResolver(page);
  const { width, height } = fixtureScene().meta.capture.viewport;
  await page.setViewportSize({ width, height });
  await page.goto(server.url, { waitUntil: "load" });
  const complaints = await fixtureDriftComplaints(page);
  if (complaints.length > 0) {
    throw new Error(
      "fixture-app.html has drifted from fixture-scene.ts, so the " +
        "acceptance test's pixel samples no longer point at what they were " +
        `chosen to sample:\n  ${complaints.join("\n  ")}`,
    );
  }
}, HOOK_TIMEOUT_MS);

afterAll(async () => {
  await launched?.close();
  server?.close();
});

/**
 * Reads the produced mp4 in the page — node has no WebCodecs, so there is
 * nowhere else — and hands back only the reductions the assertions use.
 *
 * Runs on the page this file already has open on the fixture's own
 * `http://127.0.0.1` origin. That is not incidental: `about:blank` is not a
 * secure context and `VideoDecoder` is undefined there, which is the first
 * thing this probe hit. Never on the pipeline's browser, which `runPipeline`
 * owns and closes.
 */
async function sweep(
  target: Page,
  bytes: Buffer,
): Promise<{
  durationSec: number;
  width: number;
  height: number;
  readings: FrameReading[];
}> {
  await target.addScriptTag({
    content: await bundleEntry(
      join(import.meta.dirname, "..", "src", "decode-probe-entry.ts"),
    ),
  });
  const request: SampleRequest = {
    spacingSec: SWEEP_SPACING_SEC,
    blockPoints: HEADER_POINTS,
    // ~1.2% of the frame's width: 23px at 1920, 12px on the 960-wide
    // working copy. Wide enough to average a text glyph away, far narrower
    // than the 72px header band it is read inside.
    blockFraction: 0.012,
    colors: [APP_ACCENT, APP_PANEL],
    colorTolerance: COLOR_TOLERANCE,
    colorErode: [0, PANEL_ERODE_PX],
    rects: [CURSOR_RECT],
    nearWhiteMin: NEAR_WHITE_MIN,
  };
  return target.evaluate(
    ([globalName, base64, req]) => {
      const entry = (
        globalThis as unknown as Record<string, DecodeProbeEntry | undefined>
      )[globalName as string];
      if (entry === undefined) {
        throw new Error(
          `${globalName} is not installed on this page — the acceptance ` +
            "test must inject decode-probe-entry.ts's bundle before " +
            "calling into it",
        );
      }
      return entry.sampleFrames(base64 as string, req as SampleRequest);
    },
    [DECODE_PROBE_GLOBAL, bytes.toString("base64"), request] as const,
  );
}

/** The largest per-channel difference between two colours — the measure
 *  "close to this colour" is stated in, so a failure reads as a number of
 *  levels rather than as a distance in an unnamed space. */
function channelDelta(a: Rgb, b: Rgb): number {
  return Math.max(
    Math.abs(a[0] - b[0]),
    Math.abs(a[1] - b[1]),
    Math.abs(a[2] - b[2]),
  );
}

function rgb(color: Rgb): string {
  return `rgb(${color[0]},${color[1]},${color[2]})`;
}

it(
  "renders fixture-app.html to an mp4 whose frames show the app",
  async () => {
    const sceneDir = mkdtempSync(join(tmpdir(), "demoman-acc-scene-"));
    const scenePath = join(sceneDir, "scene.json");
    // Written to disk and read back through `migrateToCurrent`, so the
    // scene survives a JSON round trip, and a red run keeps the exact
    // scene that produced it.
    writeFileSync(scenePath, JSON.stringify(acceptanceScene()));

    // Deliberately NOT inside `runPipeline`'s own scratch directory: that
    // path has its own test (Task 12's `--out`-inside-the-scratch guard),
    // and this one has to exercise the ordinary case, where the run's
    // scratch directory is removed on success and `--out` survives it.
    const outDir = mkdtempSync(join(tmpdir(), "demoman-acc-out-"));
    const outPath = join(outDir, "demo.mp4");

    try {
      await runAndAssert(scenePath, outPath);
    } catch (error) {
      // KEPT, and named, on a failure — the same rule `runPipeline`'s own
      // `finally` follows for its scratch root, and for the same reason: the
      // mp4 and the exact scene that produced it are what someone debugging
      // a red run needs, and an artefact nobody is told about is the same
      // defect in a different coat. Removed on a pass, because then nobody
      // wants either of them and two directories per run is a leak.
      console.error(
        `demoman: this acceptance run failed — its scene was kept at ` +
          `${scenePath} and its output at ${outPath}`,
      );
      throw error;
    }
    rmSync(sceneDir, { recursive: true, force: true });
    rmSync(outDir, { recursive: true, force: true });
  },
  TEST_TIMEOUT_MS,
);

/** The run and the three assertions, split out only so the caller's
 *  keep-on-failure/remove-on-pass decision reads as the two lines it is. */
async function runAndAssert(scenePath: string, outPath: string): Promise<void> {
  // Where the time goes: the run, then the sweep, stamped with the ms since
  // the run began. Printed at the end, and carried by the outcome
  // assertion, so a slow or failed CI run says which phase.
  const started = performance.now();
  const timeline: string[] = [];
  const stamp = (what: string) =>
    timeline.push(`${Math.round(performance.now() - started)} ms  ${what}`);

  const scene = migrateToCurrent(JSON.parse(readFileSync(scenePath, "utf8")));
  const result = await runPipeline({
    scene,
    targetUrl: server.url,
    outPath,
    // 1080p, not the 4K these keyframes back: the render is the run, and in
    // software 4K cost 308 of this test's 323 s (2026-10-17). What that
    // leaves uncovered, by choice (the author, 2026-10-17): no test renders
    // a recorded replay at 4K. The encode itself is shared — `renderPhase`
    // and the CLI export both go through `renderToFiles` — and the export's
    // 4K runs in executor-export-4k(-auto).slow.test.ts; `renderPhase`'s own
    // choice of the 4K target is checked by nothing end to end.
    maxTier: LANDSCAPE_1080P,
  });
  stamp(`runPipeline answered ${result.kind}`);
  expect(
    result.kind,
    `the pipeline answered ${JSON.stringify(result)}\ntimeline:\n${timeline.join("\n")}`,
  ).toBe("rendered");

  const bytes = readFileSync(outPath);
  const { durationSec, width, height, readings } = await sweep(page, bytes);
  // Premise: the cap took, so every size below is a 1080p one.
  expect([width, height], "the render's size").toEqual([1920, 1080]);
  stamp(
    `sweep read ${readings.length} frames of a ${durationSec.toFixed(3)} s ${width}x${height} mp4 (${bytes.byteLength} bytes)`,
  );
  console.info(`acceptance timeline:\n${timeline.join("\n")}`);

  // Not an assertion about the product so much as about this test: a sweep
  // that came back short, empty or sparse would make all three assertions
  // vacuous rather than false — and a sparse one is what made assertion 2
  // flaky. So the spacing the window needs is checked, not assumed.
  const gaps = readings
    .slice(1)
    .map((r, i) => r.tSec - (readings[i] as FrameReading).tSec);
  const widest = Math.max(0, ...gaps);
  expect(
    readings.length,
    `the sweep read ${readings.length} frames of a ${durationSec.toFixed(3)}s ${width}x${height} mp4`,
  ).toBeGreaterThan(durationSec / SWEEP_SPACING_SEC);
  expect(
    widest,
    `the sweep's widest gap is ${widest.toFixed(3)}s across a ` +
      `${durationSec.toFixed(3)}s mp4 — too sparse for the panel's window`,
  ).toBeLessThanOrEqual(SWEEP_SPACING_SEC + 1e-6);

  // ---- 1. It is the app, not a blank page. ---------------------------
  // The fixture's header is a solid band of #1f2937 across the top of the
  // first frame. A blank page — or the app's DOM with its stylesheet gone,
  // or any other page the runner might have navigated to instead — is
  // white there.
  const first = readings[0] as FrameReading;
  HEADER_POINTS.forEach((point, i) => {
    const sampled = first.blocks[i] as Rgb;
    expect(
      channelDelta(sampled, APP_HEADER),
      `the first frame is ${rgb(sampled)} at (${point[0]}, ${point[1]}), ` +
        `where fixture-app.html's header paints ${rgb(APP_HEADER)}. ` +
        "The video does not open on the app at --url.",
    ).toBeLessThanOrEqual(12);
  });

  // ---- 2. The panel opened, and it opened over time. -----------------
  // The button and the panel share the frame only while the panel is
  // sliding across the button. Before the click there is a button and no
  // panel; after it there is a panel and no button, because the panel
  // covers the button completely. A bundle of keyframes alone holds those
  // two states and nothing in between.
  const withButtonNoPanel = readings.filter(
    (r) =>
      (r.colorCounts[0] as number) >= ACCENT_STILL_SHOWING &&
      (r.colorCounts[1] as number) < PANEL_ON_SCREEN,
  );
  const withPanelNoButton = readings.filter(
    (r) =>
      (r.colorCounts[0] as number) < ACCENT_STILL_SHOWING &&
      (r.colorCounts[1] as number) >= PANEL_ON_SCREEN,
  );
  const midSlide = readings.filter(
    (r) =>
      (r.colorCounts[0] as number) >= ACCENT_STILL_SHOWING &&
      (r.colorCounts[1] as number) >= PANEL_ON_SCREEN,
  );
  const trace = readings
    .map(
      (r) =>
        `${r.tSec.toFixed(3)}s accent=${r.colorCounts[0]} panel=${r.colorCounts[1]}`,
    )
    .join("\n  ");
  expect(
    withButtonNoPanel.length,
    `no frame shows the checkout button with the panel closed:\n  ${trace}`,
  ).toBeGreaterThan(0);
  expect(
    withPanelNoButton.length,
    `no frame shows the panel covering the checkout button — the click ` +
      `never opened it:\n  ${trace}`,
  ).toBeGreaterThan(0);
  expect(
    midSlide.length,
    "no frame catches the panel part-way across the checkout button: the " +
      "panel snapped from closed to open, which is what a keyframe-only " +
      `bundle renders and what design decision 8 refuses.\n  ${trace}`,
  ).toBeGreaterThanOrEqual(2);

  // ---- 3. The cursor is painted. -------------------------------------
  // Sampled where the pointer rests through the click, once the panel has
  // slid under it: a flat dark field, so the only white in the rect is the
  // arrow. `overPanel` is the fixture check for this assertion — with no
  // frame whose rect is the flat panel there would be nothing to look for
  // the cursor ON, and "no cursor found" would then mean nothing.
  const overPanel = readings.filter(
    (r) => (r.rects[0] as RectReading).meanLuma <= PANEL_FLAT_MAX_LUMA,
  );
  const cursorTrace = overPanel
    .map((r) => {
      const rect = r.rects[0] as RectReading;
      const box = rect.nearWhiteBox;
      return (
        `${r.tSec.toFixed(3)}s white=${rect.nearWhite} ` +
        `box=${box === null ? "none" : `${box.width.toFixed(4)}x${box.height.toFixed(4)}`}`
      );
    })
    .join("\n  ");
  expect(
    overPanel.length,
    "no frame has the open panel behind where the pointer rests, so " +
      "there is nowhere to look for the cursor — the sample rect " +
      `${JSON.stringify(CURSOR_RECT)} no longer lands on the panel`,
  ).toBeGreaterThan(0);
  // Count AND shape. A count on its own passed a render with the cursor
  // switched off, because as the camera pulls out the rect's left side
  // comes to rest on the panel's own left edge and a few columns of white
  // table leak in — at 1080p up to 3,559 near-white pixels, over ten times
  // the arrow's own 250-281. Those columns span the rect's full height
  // (0.1796 of the frame); the arrow's core is about 0.010 x 0.029. So the
  // blob has to be the right SIZE to count.
  const withCursor = overPanel.filter((r) => {
    const rect = r.rects[0] as RectReading;
    const box = rect.nearWhiteBox;
    return (
      rect.nearWhite >= CURSOR_BLOB_MIN &&
      box !== null &&
      box.width <= CURSOR_BLOB_MAX_WIDTH &&
      box.height <= CURSOR_BLOB_MAX_HEIGHT
    );
  });
  expect(
    withCursor.length,
    "the pointer is not painted: no frame whose sample rect is the flat " +
      "open panel holds a compact white blob the size of the cursor " +
      `(~250-280 px, ~0.010x0.029 of a 1080p frame).\n  ${cursorTrace}`,
  ).toBeGreaterThan(0);
}

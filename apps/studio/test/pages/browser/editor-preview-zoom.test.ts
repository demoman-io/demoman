import {
  composeForTarget,
  LANDSCAPE_1080P,
  planScene,
  type RenderTarget,
  resolvePlan,
} from "@demoman/compositor";
import type { SceneDocument } from "@demoman/scene-schema";
import { page } from "@vitest/browser/context";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { proceduralBundle } from "../../../../../packages/replay-engine/test/helpers/bundles";
import { readonlyScene } from "../../../../../packages/replay-engine/test/helpers/scenes";
// The shell itself, markup and stylesheet both — the same reason
// `editor-shell-layout.test.ts` reads it raw rather than approximating it:
// every assertion here is about what the page's own grid, stylesheet and
// container queries produce.
import shell from "../../../pages/entrypoints/editor/index.html?raw";
import { renderRail } from "../../../pages/entrypoints/editor/rail";
import { renderTimeline } from "../../../pages/entrypoints/editor/timeline-view";
import {
  renderStageBar,
  renderTransport,
} from "../../../pages/entrypoints/editor/view";
import {
  buildLaneModel,
  type LaneModel,
} from "../../../pages/src/editor/lanes";
import { previewTarget } from "../../../pages/src/editor/preview";
import {
  type OverlayHandlers,
  type OverlayProps,
  renderStageOverlay,
} from "../../../pages/src/editor/stage-overlay";
import { buildTimelineView } from "../../../pages/src/editor/timeline";
import { fitAll } from "../../../pages/src/editor/viewport";
import { mountShell } from "../helpers/shell-css";

const css = /<style>([\s\S]*?)<\/style>/.exec(shell)?.[1];
const bodyHtml = /<body>([\s\S]*?)<\/body>/.exec(shell)?.[1];

/** `readonlyScene` with one authored mask, so the Mask lane has a segment
 *  to render and select. Copied from `editor-shell-layout.test.ts`'s own
 *  `maskedScene` rather than exported — each browser-lane file carries its
 *  own fixtures, per that file's own comment on `mountMaskOverlay`.
 *
 *  The rect is authored at the capture's own top-left (`x:0, y:0`) so it
 *  starts near an edge rather than mid-frame: a mask far from every edge
 *  leaves "inside the drawn box" too much margin to notice a lost
 *  letterbox offset. It does NOT land at the drawn box's own `(0, 0)`,
 *  though — `cssRectToCanvas` maps it through the camera at whatever time
 *  it is read, and this file's own test reads it at `mask.startMs + 200`,
 *  where the camera is not sitting at zero pan/zoom. Measured: `place()`
 *  writes it ~121.6px/36px in from the drawn box's corner, not `0, 0` — see
 *  that test's own comment on the bound it asserts instead. */
function maskedScene(): SceneDocument {
  const scene = readonlyScene();
  return {
    ...scene,
    edits: {
      ...scene.edits,
      masks: [
        {
          id: "mask-1",
          rect: { x: 0, y: 0, width: 80, height: 40 },
          start: { actionId: "act-1", offsetMs: 0 },
          end: { actionId: "act-3", offsetMs: 0 },
        },
      ],
    },
  };
}

/**
 * Mounts the shell exactly as `main.ts` leaves it before the first zoom
 * toggle: the timeline, the rail, the transport and the stage bar all
 * drawn from a real `LaneModel`, `--frame-ratio`/`--frame-px` published on
 * `#stage` the way `retarget` does (this lane never runs `main.ts`, so
 * nothing else would set them). Every test in this file mounts at the
 * default `target` below, which happens to equal the stylesheet's own
 * `16 / 9` / `1280` defaults exactly — see the `setProperty` calls' own
 * comment for what that does and does not prove here.
 *
 * Copied from `editor-shell-layout.test.ts`'s own `mount()` rather than
 * imported — that file does not export it, and each browser-lane file
 * carries its own fixtures.
 */
function mount(
  scheme: "light" | "dark",
  laneModel: LaneModel | null = null,
  target: RenderTarget = previewTarget(LANDSCAPE_1080P),
) {
  if (!css?.includes("#stage")) {
    throw new Error("index.html no longer carries the editor's stylesheet");
  }
  if (!bodyHtml?.includes('id="timeline"')) {
    throw new Error("index.html no longer carries the editor's shell markup");
  }

  mountShell(scheme, css ?? "");
  document.body.innerHTML = bodyHtml.replace(/<script[\s\S]*?<\/script>/g, "");
  document.body.removeAttribute("data-panel");
  // The attribute is never absent in the real page (`main.ts` sets it once
  // at boot) — start every fixture the same way, so a test that forgets to
  // set `data-zoom="actual"` is exercising fit, not an undefined rule.
  document.body.dataset.zoom = "fit";

  const scene = readonlyScene();
  const bundle = proceduralBundle();
  const resolved = resolvePlan(planScene(scene), bundle, scene);
  const model =
    laneModel ??
    buildLaneModel({
      scene,
      view: buildTimelineView({ scene, bundle, resolved }),
      bundle,
      resolved,
      hoverReport: null,
    });
  const root = document.querySelector<HTMLElement>("#timeline");
  if (!root) throw new Error("no #timeline in the shell");
  renderTimeline(
    root,
    model,
    {
      viewport: fitAll(model.durationMs),
      selection: null,
      positionMs: 2_000,
      refusal: null,
      snapping: true,
    },
    {
      onSelect: vi.fn(),
      onSnapping: vi.fn(),
      onSplit: vi.fn(),
      onRestorePiece: vi.fn(),
      onOpenJoin: vi.fn(),
      onSeek: vi.fn(),
      onSeekStart: vi.fn(),
      onGesture: vi.fn(),
      onViewport: vi.fn(),
    },
  );

  const canvas = document.querySelector<HTMLCanvasElement>("#preview");
  if (!canvas) throw new Error("no #preview in the shell");
  canvas.width = target.width;
  canvas.height = target.height;

  // What `retarget` publishes in the page. Every test in this file mounts
  // at the default `target` (landscape, 1280x720 — `MASK_TARGET` below is
  // the same value), which is numerically IDENTICAL to the stylesheet's
  // own `16 / 9` / `1280` defaults — so, unlike `editor-shell-layout.test.ts`'s
  // `mount()` (which this is copied from, and which DOES exercise a
  // vertical target), deleting these two `setProperty` calls would not
  // redden anything in THIS file today. Kept for convention parity with
  // that file and so a future case here that passes a non-default `target`
  // is covered without anyone having to remember to add this back.
  const stage = document.querySelector<HTMLElement>("#stage");
  if (!stage) throw new Error("no #stage in the shell");
  stage.style.setProperty(
    "--frame-ratio",
    `${target.width} / ${target.height}`,
  );
  stage.style.setProperty("--frame-px", String(target.width));

  const railRoot = document.querySelector<HTMLElement>("#rail");
  if (!railRoot) throw new Error("no #rail in the shell");
  renderRail(
    railRoot,
    { rail: "export", panelOpen: true, hasSelection: false },
    { onPick: vi.fn() },
  );

  const transportRoot = document.querySelector<HTMLElement>("#transport");
  if (!transportRoot) throw new Error("no #transport in the shell");
  renderTransport(
    transportRoot,
    { authored: false, playing: false, enabled: true, rate: 1, looping: false },
    {
      onToggle: vi.fn(),
      onShuttle: vi.fn(),
      onLooping: vi.fn(),
      onSkipToStart: vi.fn(),
    },
  );

  const stageBarRoot = document.querySelector<HTMLElement>("#stage-bar");
  if (!stageBarRoot) throw new Error("no #stage-bar in the shell");
  renderStageBar(
    stageBarRoot,
    {
      authored: false,
      positionMs: 2_000,
      durationMs: 12_000,
      aspect: target.fit === "cover" ? "9:16" : "16:9",
      enabled: true,
      fullscreen: document.fullscreenElement !== null,
      error: null,
      zoom: "fit",
    },
    {
      onAspect: vi.fn(),
      onFullscreen: vi.fn(),
      onZoom: vi.fn(),
      onDismissError: vi.fn(),
    },
  );

  const node = (selector: string): HTMLElement => {
    const found = document.querySelector<HTMLElement>(selector);
    if (!found) throw new Error(`no ${selector}`);
    return found;
  };
  const rect = (selector: string) => node(selector).getBoundingClientRect();

  return { node, rect, canvas, model };
}

/** Landscape, at its full-size preview target — the same default `mount()`
 *  and `mountMaskOverlay` use elsewhere, kept explicit here since Step 6's
 *  test needs the same target twice (once through `mount`, once through
 *  `overlayProps`). */
const MASK_TARGET = previewTarget(LANDSCAPE_1080P);

/**
 * The mask fixture, built once per call: the scene, its resolved plan and
 * presentation for `MASK_TARGET`, and the lane model it produces. Shared by
 * `maskedModel` and `overlayProps` so both read the same authored mask
 * (`mask-1`, from `maskedScene`) without threading state between them —
 * `composeForTarget` is deterministic over the same inputs, so calling it
 * twice in one test costs nothing but produces identical numbers.
 */
function maskFixture() {
  const scene = maskedScene();
  const bundle = proceduralBundle();
  const { resolved, presentation } = composeForTarget({
    plan: planScene(scene),
    bundle,
    scene,
    target: MASK_TARGET,
  });
  const model = buildLaneModel({
    scene,
    view: buildTimelineView({ scene, bundle, resolved }),
    bundle,
    resolved,
    hoverReport: null,
  });
  const mask = model.masks[0];
  if (!mask) throw new Error("fixture has no mask to select");
  return { model, resolved, presentation, mask };
}

function maskedModel(): LaneModel {
  return maskFixture().model;
}

/** `renderStageOverlay`'s props for the same mask `maskedModel` builds,
 *  reading the canvas back off the document — `mount()` has already sized
 *  and mounted it by the time this is called. */
function overlayProps(): OverlayProps {
  const { model, resolved, presentation, mask } = maskFixture();
  const canvas = document.querySelector<HTMLCanvasElement>("#preview");
  if (!canvas) throw new Error("no #preview in the shell");
  return {
    canvas,
    selection: { kind: "mask", id: mask.id },
    model,
    resolved,
    presentation,
    target: MASK_TARGET,
    outputTimeMs: mask.startMs + 200,
  };
}

function overlayHandlers(): OverlayHandlers {
  return { onMaskRect: vi.fn(), onZoomPoint: vi.fn() };
}

beforeEach(async () => {
  document.body.innerHTML = "";
});

describe("the preview at 100%", () => {
  for (const scheme of ["light", "dark"] as const) {
    /* `place-content: center` puts an overflowing grid item's start edge at
       a NEGATIVE offset the scroll container cannot reach, so the frame's
       top-left corner would be permanently unreachable at 100%. `safe`
       falls back to start alignment on overflow. One keyword, and its
       absence is invisible until a frame is larger than the well. */
    it(`lets the author reach the frame's top-left corner in ${scheme}`, async () => {
      await page.viewport(1000, 620);
      const { rect, node } = mount(scheme);
      // Fit's own width, measured before the chip is ever pressed — the
      // baseline "100%" has to differ from.
      const fitWidth = rect("#stage-frame").width;
      document.body.setAttribute("data-zoom", "actual");
      const box = node("#stage-box");
      const well = rect("#stage-box");
      const frame = rect("#stage-frame");
      // Nothing above asserts what "100%" actually MEANS: the overflow
      // guard, the corner check and (in the sibling test) the box-equality
      // check are all satisfied by any frame big enough to overflow the
      // well, whether `--frame-w` reads `--frame-px` correctly, doubles
      // it, or ignores it and hard-codes something oversized. Pin it to
      // the bitmap's own width (1280, `MASK_TARGET`/`LANDSCAPE_1080P`'s
      // preview target) and to differing from fit, which a `--frame-w`
      // that silently stayed on the fit formula would fail.
      expect(
        frame.width,
        "100% did not resolve to the preview bitmap's own width",
      ).toBeCloseTo(1280, 0);
      expect(
        frame.width,
        "fit and 100% rendered at the same width",
      ).not.toBeCloseTo(fitWidth, 0);
      // Fixture guard FIRST: "it scrolls" says nothing unless the frame is
      // genuinely larger than the well in both axes. 1280x720 against a
      // well this size is the case this test exists for; if the floor ever
      // makes the well bigger than the bitmap, this guard fails loudly
      // rather than the assertions below passing vacuously.
      expect(
        box.scrollWidth,
        `frame ${frame.width}x${frame.height} in a ${well.width}x${well.height} well`,
      ).toBeGreaterThan(well.width);
      expect(box.scrollHeight).toBeGreaterThan(well.height);
      box.scrollTo(0, 0);
      const corner = node("#stage-frame").getBoundingClientRect();
      expect(
        corner.left,
        `scrolled to the origin, the frame starts at ${corner.left} against a well at ${well.left}`,
      ).toBeGreaterThanOrEqual(well.left - 1);
      expect(corner.top).toBeGreaterThanOrEqual(well.top - 1);
    });

    it(`keeps a selected mask's handle on the picture at 100%, scrolled, in ${scheme}`, async () => {
      await page.viewport(1000, 620);
      const { node, rect } = mount(scheme, maskedModel());
      document.body.setAttribute("data-zoom", "actual");
      const box = node("#stage-box");
      box.scrollTo(120, 80);
      renderStageOverlay(
        node("#stage-overlay"),
        overlayProps(),
        overlayHandlers(),
      );
      const overlay = node('[data-overlay="mask"]').getBoundingClientRect();
      const overlayRoot = rect("#stage-overlay");
      const canvas = rect("#preview");
      const frame = rect("#stage-frame");
      // Fixture guard: a scroll that did not happen makes this identical to
      // the unscrolled case, which the fit tests already cover.
      expect(box.scrollLeft, "the stage did not scroll").toBeGreaterThan(0);
      // `drawnBox` (stage-overlay.ts) computes its offsets from
      // `canvas.getBoundingClientRect()` — the claim `place()`'s math
      // actually depends on is overlay-box ≡ CANVAS-box, not overlay-box ≡
      // frame-box. Those coincide today only because `#preview` is
      // `100%/100%` of `#stage-frame`; comparing against `#stage-frame`
      // would still pass if that 100%/100% rule broke while `#stage-frame`
      // itself stayed put. Compare against `#preview` to assert the exact
      // thing `drawnBox` reads. (`#stage-overlay` at `inset: 0` inside
      // `#stage-frame` is still the mechanism that makes this hold — see
      // `index.html`'s comment on the drawn box — it's the ASSERTION that
      // needed to name the canvas, not the mechanism.)
      //
      // When both axes overflow the well, `place-content: safe center`'s
      // start fallback and `#stage-overlay`'s `inset: 0` anchor at the SAME
      // corner of whichever box actually contains the overlay — so a
      // mask-inside-frame-bounds check alone stays green even with the
      // overlay parked on `#stage-box` (measured directly: reverting the
      // overlay's parent left the mask's own position numerically
      // unchanged, because only the shared corner mattered to `place()`'s
      // math, not the overlay's size). Comparing the BOXES catches what
      // comparing only the mask could not: `#stage-box` is 568x217.7 here
      // against the canvas's 1280x720, a difference no in-bounds check on
      // the mask would ever see.
      expect(overlayRoot.left).toBeCloseTo(canvas.left, 0);
      expect(overlayRoot.top).toBeCloseTo(canvas.top, 0);
      expect(overlayRoot.width).toBeCloseTo(canvas.width, 0);
      expect(overlayRoot.height).toBeCloseTo(canvas.height, 0);
      // The handle is inside the PICTURE, measured against the frame's own
      // painted box — which has moved under the scroll.
      expect(overlay.left).toBeGreaterThanOrEqual(frame.left - 1);
      expect(overlay.right).toBeLessThanOrEqual(frame.right + 1);
      expect(overlay.top).toBeGreaterThanOrEqual(frame.top - 1);
      expect(overlay.bottom).toBeLessThanOrEqual(frame.bottom + 1);
      // The in-bounds checks above only catch NEGATIVE drift (a handle
      // pushed past the frame's near edges) — a handle pushed hundreds of
      // pixels toward the FAR edges would still read "inside" a 1280x720
      // frame. `maskedScene`'s rect (`x:0, y:0`) is authored at the
      // capture's own top-left, but `cssRectToCanvas` maps it through the
      // camera at `outputTimeMs` (`mask.startMs + 200`), which is not
      // sitting at zero zoom/pan there — measured directly (verified with
      // `getComputedStyle` before writing this bound): `place()` writes
      // `left: 121.6px; top: 36px` relative to the frame's own corner, not
      // `0, 0`. So the honest bound is "close to the near edge", not "at
      // it": well under half the frame in each axis, comfortably past the
      // measured 121.6/36 with margin for the fixture changing scale, and
      // still tight enough that a three-figure-or-more drift — which the
      // in-bounds checks above cannot see, since it stays inside a
      // 1280x720 frame either way — fails it.
      expect(
        overlay.left - frame.left,
        "the mask drifted far from the frame's near edge in x",
      ).toBeLessThan(300);
      expect(
        overlay.top - frame.top,
        "the mask drifted far from the frame's near edge in y",
      ).toBeLessThan(300);
    });
  }
});

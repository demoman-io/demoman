import {
  composeForTarget,
  LANDSCAPE_1080P,
  planScene,
  type RenderTarget,
  resolvePlan,
  VERTICAL_1080,
} from "@demoman/compositor";
import type { SceneDocument } from "@demoman/scene-schema";
import { page, userEvent } from "@vitest/browser/context";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { proceduralBundle } from "../../../../../packages/replay-engine/test/helpers/bundles";
import {
  everyVerbScene,
  readonlyScene,
} from "../../../../../packages/replay-engine/test/helpers/scenes";
// The shell itself, markup and stylesheet both. Every assertion in this file
// is about what the page's own grid and palette produce, so a hand-built
// approximation of either would only prove something about the approximation.
import shell from "../../../pages/entrypoints/editor/index.html?raw";
import {
  renderExportDoor,
  renderRail,
} from "../../../pages/entrypoints/editor/rail";
import {
  renderTimeline,
  renderTimelineTools,
  STEP_GLYPH,
} from "../../../pages/entrypoints/editor/timeline-view";
import {
  renderFailure,
  renderHeaderIcons,
  renderNotesButton,
  renderStageBar,
  renderTakeNotes,
  renderTransport,
} from "../../../pages/entrypoints/editor/view";
import type { HoverReport } from "../../../pages/src/editor/hover-report";
import {
  buildLaneModel,
  type LaneModel,
} from "../../../pages/src/editor/lanes";
import { previewTarget } from "../../../pages/src/editor/preview";
import {
  drawnBox,
  renderStageOverlay,
} from "../../../pages/src/editor/stage-overlay";
import { buildTimelineView } from "../../../pages/src/editor/timeline";
import { fitAll } from "../../../pages/src/editor/viewport";
import {
  contrast,
  length,
  luminance,
  mountShell,
  over,
  parse,
  type Rgba,
  token,
} from "../helpers/shell-css";

const css = /<style>([\s\S]*?)<\/style>/.exec(shell)?.[1];
const bodyHtml = /<body>([\s\S]*?)<\/body>/.exec(shell)?.[1];

/* The browser lane runs light and cannot be asked for a different
 * preference, so dark is exercised the way the theme toggle sets it —
 * `data-theme="dark"` on the root, through `mountShell` — which applies
 * both the shell's and the editor's own `:root[data-theme="dark"]` blocks
 * out of the shipped stylesheets rather than a restated copy. */

/** The window the author reported the overlap from. */
const PAGE = { width: 1155, height: 896 };

/** `readonlyScene` with one authored zoom, so the Zoom lane has a segment
 *  to measure a colour against — the same fixture shape
 *  `editor-main-drag.test.ts` uses for the same reason. */
function zoomedScene(): SceneDocument {
  const scene = readonlyScene();
  return {
    ...scene,
    camera: [
      {
        id: "cam-1",
        kind: "zoom" as const,
        anchorId: "a-checkout",
        marker: { actionId: "act-3", offsetMs: -350 },
        scale: 1.6,
      },
    ],
  };
}

/** `readonlyScene` with one authored mask, so the Mask lane has a segment
 *  to render and select — the same shape `editor-stage-overlay.test.ts`
 *  builds via `applyCommand`, but constructed directly here since only the
 *  document needs to exist, not the command that produced it.
 *
 *  The rect is pinned to the frame's top-left corner rather than sitting
 *  mid-frame: `mountMaskOverlay`'s own comment explains why — a mask far
 *  from every edge leaves the "inside the drawn box" check with too much
 *  margin to notice a lost letterbox offset. */
function maskedScene(
  rect: { x: number; y: number; width: number; height: number } = {
    x: 0,
    y: 0,
    width: 80,
    height: 40,
  },
): SceneDocument {
  const scene = readonlyScene();
  return {
    ...scene,
    edits: {
      ...scene.edits,
      masks: [
        {
          id: "mask-1",
          rect,
          start: { actionId: "act-1", offsetMs: 0 },
          end: { actionId: "act-3", offsetMs: 0 },
        },
      ],
    },
  };
}

/**
 * The same mask, moved to where a `cover` target can still see it.
 *
 * The default rect above is pinned to the capture's top-LEFT corner, and a
 * vertical cut crops the capture to 9:16: at this fixture's 1280x800
 * viewport the crop keeps roughly the middle 434 CSS px of width, so
 * x = 0..80 is not in the picture at all. Measured before this rect
 * existed, the overlay for it landed at left -728 against a drawn box
 * starting at left 16 — correct behaviour, and a test that could never go
 * green.
 *
 * `cover` fills the short edge, so the capture's full HEIGHT is still
 * visible: y = 0 keeps the mask pinned to an edge of the drawn box, which
 * is what gives the "inside the box" assertions something to catch (see
 * the docblock above). x sits at the capture's horizontal centre, which is
 * where the crop is.
 */
const VERTICAL_MASK_RECT = { x: 600, y: 0, width: 80, height: 40 };

/** Window sizes a Chrome window actually takes: maximised on two common
 *  displays, and the sizes a half-tiled or merely un-maximised window lands
 *  on. The overlap this file exists to catch appeared at every one of them
 *  except 1155x896 — which is the size the author happened to measure first,
 *  and the reason the geometry looked innocent for a whole round trip. */
/** Each row is a window and the height of `mount`'s status stand-in to
 *  show in it. 156px unless a row says otherwise: the status row has had
 *  no resident since 2026-09-28, and the stand-in is what keeps these
 *  cases as short as the windows they were written against. A row with 0
 *  checks the page as it ships, with the status row collapsed. */
const WINDOWS: [width: number, height: number, statusPx?: number][] = [
  [1440, 900],
  // The three-column layout's own working size, added with the rail on
  // 2026-09-14: the rail-and-panel checks below measure at 1440x860, and a
  // window that is not in this list is a window the overlap checks have
  // never seen.
  [1440, 860],
  [1280, 800],
  [1155, 896],
  [1100, 700],
  [1000, 620],
  // The narrowest window the three columns survive, and the tightest the
  // dock is ever squeezed: 952 is `STACKED_FLOOR` itself. It took this job
  // from [920, 560] on 2026-10-07, when the 16px seams and the rail's own
  // track moved the floor from 920 to 952 — and 920 from [900, 560] before
  // that, when the 8px seams first moved it. Without it the narrowest
  // three-column window in this list would be 1000.
  //
  // It is also where the shell's fixed `100vh` costs the most. The video
  // has a floor (`minmax(220px, 1fr)`) and the lanes have none, so at this
  // height the dock is squeezed to little more than its transport row and
  // the lanes scroll inside a few pixels of box. Looked at, in both
  // themes, on 2026-09-21 (at 920, the floor then): the timeline is
  // present and reachable but not usable, and the task-1 report records it
  // as a design question rather than a defect this pass invents an answer
  // to. What is asserted here is that the lanes stay INSIDE their card
  // while that happens.
  //
  // Checked twice, because the stand-in no longer fits at 560 tall.
  //
  // As shipped, at 560: the status row is collapsed (no resident since
  // 2026-09-28), so this is the tightest window the real page is ever
  // given at the floor. The cases below assert the premise — `#status`
  // takes no space — when a row shows no stand-in.
  [952, 560, 0],
  // With the 156px stand-in, at 600: the 16px seams cost 40px more height
  // than the 8px ones did (the shell's inset top and bottom plus the three
  // gaps around the status row and the dock, 80 against 40), so 952x600
  // leaves the dock the same squeeze 920x560 gave it with the stand-in. At
  // 952x560 with the stand-in the lanes run out of the card's bottom
  // (measured 2026-10-07: lanes end at 550, the card at 544) — the video's
  // row is at its 220px floor and the dock's transport row cannot squeeze,
  // so there is no height left to give.
  [952, 600],
  // The last three are STACKED. Each was the three-column layout at its
  // tightest once — 900 one pixel above the old 887px breakpoint, 920 the
  // floor from 2026-09-21 to 2026-10-07 — and fell into the stacked bucket
  // as the floor moved. Kept anyway: a window the overlap checks have seen
  // is worth keeping, and they bracket the stacked case from just under
  // the floor down to the narrowest the list reaches.
  [920, 560],
  [900, 560],
  // The tightest window in this list, and stacked well below the 952px
  // floor. Here the page scrolls by design: the stacking media query sets
  // `height: auto; min-height: 100vh` and puts the panel BELOW the dock
  // (the rail keeps its track beside the stage), so with the status
  // fixture `body` is far taller than the 560px window. The overlap check
  // still applies; the "fits in the window" check does not, and is gated
  // on `STACKED_FLOOR` below — the else branch below prints the row
  // breakdown when it fails, so a red run says which row grew.
  [880, 560],
];

/**
 * The narrowest window the columns fit with the panel open: 16 of the
 * shell's own inset + 520 of stage floor + (320 of panel + 16 of the seam
 * its track carries) + (48 of rail + 16 of the seam its track carries) + 16
 * of inset = 952, the same arithmetic as `index.html`'s
 * `@media (max-width: 951px)` (951 being the last width BELOW this one).
 *
 * At or above it the shell is `body { height: 100vh }`, so the whole page
 * is inside the window and the dock has to be too. Below it the shell
 * stacks — the picture and the rail over the dock, the panel under it —
 * and the document itself scrolls, so that is no longer an invariant: see
 * the branch in the loop below, which asserts the scroll instead of
 * skipping.
 *
 * A literal, and deliberately so: it mirrors the media query's own
 * hand-written literal, and "the stacking floors are the real floors"
 * below exists to catch the two drifting apart when `--seam` is tuned.
 * Re-derive both whenever it moves.
 */
const STACKED_FLOOR = 952;

/**
 * The same floor with the panel closed: 16 of inset + 520 of stage + (48 of
 * rail + 16 of its seam) + 16 of inset = 616, matching
 * `@media (max-width: 615px)`. Closing the panel takes its column AND the
 * seam that column carries, which is why the panel's 336 is not in this
 * sum. Re-derive it whenever `--seam` moves.
 */
const STACKED_CLOSED_FLOOR = 616;

function mount(
  scheme: "light" | "dark",
  refusal: string | null = null,
  statusPx = 0,
  laneModel: LaneModel | null = null,
  /** The bitmap `render()` would leave on the canvas — the preview target
   *  for whichever format is selected on the stage, since 2026-09-14.
   *  Parameterised because the canvas's intrinsic aspect ratio is half of
   *  what the stage row has to survive (see the docblock on the overlap
   *  checks below), and the vertical cut hands it a portrait one. */
  target: RenderTarget = previewTarget(LANDSCAPE_1080P),
  /** Play state and shuttle rate, as `renderTransport` needs them — split
   *  out for "centres the controls on the dock", whose positive control is
   *  the rate badge, which only shows while shuttling. */
  transport: { playing: boolean; rate: number } = { playing: false, rate: 1 },
  /** `renderStageBar`'s `error` — the full-screen refusal, drawn into both
   *  roots: on the picture's own bar (shown only in full screen) and over
   *  the toolbar's stage group. Defaulted to `null` so every existing call site renders the
   *  banner hidden, same as before this parameter existed. */
  stageError: string | null = null,
  /** The timeline's `.bar` carries only the hover report now (`Snap`
   *  and `Fit` moved to `#transport`), and that row collapses to
   *  nothing when there is no report — so a test that needs the bar to
   *  take up space has to ask for one. Defaulted to `null` so every
   *  existing call site keeps rendering the bar collapsed, same as before
   *  this parameter existed. */
  hoverReport: HoverReport | null = null,
  /** The picture's clock, as `renderStageBar` is handed it. Defaulted to
   *  the 0:02 / 0:12 every existing call site has always drawn; the
   *  clearance case passes a ten-minute take, whose readout is the longest
   *  the toolbar has to hold. */
  clock: { positionMs: number; durationMs: number } = {
    positionMs: 2_000,
    durationMs: 12_000,
  },
) {
  if (!css?.includes("#stage")) {
    throw new Error("index.html no longer carries the editor's stylesheet");
  }
  if (!bodyHtml?.includes('id="timeline"')) {
    throw new Error("index.html no longer carries the editor's shell markup");
  }

  // The shell the page links, then the page's own rules, under the theme
  // the toggle would set — so the shell's `:root[data-theme="dark"]` block
  // and the editor's own both apply the way they do in the shipped page.
  // No `html, body { width/height }` pin here: the shell carries a
  // `max-width: 860px` breakpoint, and a CSS-pinned body would sit in one
  // layout while the media query answered for the runner's real viewport.
  // Callers size the real viewport with `page.viewport` instead.
  mountShell(scheme, css ?? "");

  document.body.innerHTML = bodyHtml.replace(/<script[\s\S]*?<\/script>/g, "");
  // `data-panel` is an attribute on `body`, and `beforeEach` only clears
  // `body.innerHTML` — so without this the first test to close the panel
  // would leave it closed for every test after it in the file.
  document.body.removeAttribute("data-panel");
  // And body's inline style, for the same reason: a test that takes the
  // panel's transition out with `document.body.style.transition = "none"`
  // would otherwise hand that to every test after it.
  document.body.removeAttribute("style");
  // A card in the status row, which can push the stage down. Its resident
  // was `#develop`, the rebuild's panel, from 2026-09-22 (the take-wide
  // cards moved into the `#notes` popover) until the rebuild left the
  // editor on 2026-09-28. The row and its rules stay, so a stand-in card of
  // the same shape keeps the short windows these cases were written against.
  if (statusPx > 0) {
    const status = document.querySelector<HTMLElement>("#status");
    if (!status) throw new Error("no #status in the shell");
    const card = document.createElement("div");
    card.setAttribute("data-status-standin", "");
    card.style.height = `${statusPx}px`;
    card.style.background = "var(--card)";
    card.style.borderRadius = "var(--radius-card)";
    card.textContent = "A status card";
    status.append(card);
  }

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
      hoverReport,
    });
  const root = document.querySelector<HTMLElement>("#timeline");
  if (!root) throw new Error("no #timeline in the shell");
  const timelineState = {
    viewport: fitAll(model.durationMs),
    selection: null,
    positionMs: 2_000,
    refusal,
    hoverReport,
    snapping: true,
  };
  renderTimeline(root, model, timelineState, {
    onSelect: vi.fn(),
    onSnapping: vi.fn(),
    onSplit: vi.fn(),
    onRestorePiece: vi.fn(),
    onOpenJoin: vi.fn(),
    onSeek: vi.fn(),
    onSeekStart: vi.fn(),
    onGesture: vi.fn(),
    onViewport: vi.fn(),
  });

  // `+ Mask`, `Snap` and `Fit`, on `#transport` now — rendered here too, for
  // the same fixture-realism reason `renderTransport` is below: a test that
  // measures `#transport`'s row (its width, what shares it with the shuttle
  // cluster) has to measure the row the page actually draws, not an empty
  // `#timeline-tools`.
  const timelineToolsRoot =
    document.querySelector<HTMLElement>("#timeline-tools");
  if (!timelineToolsRoot) throw new Error("no #timeline-tools in the shell");
  renderTimelineTools(timelineToolsRoot, model, timelineState, {
    onGesture: vi.fn(),
    onSnapping: vi.fn(),
    onSplit: vi.fn(),
    onViewport: vi.fn(),
  });

  // The canvas as `render()` leaves it: a bitmap the size of the output, which
  // is also its intrinsic size for layout.
  const canvas = document.querySelector<HTMLCanvasElement>("#preview");
  if (!canvas) throw new Error("no #preview in the shell");
  canvas.width = target.width;
  canvas.height = target.height;

  // What `retarget` publishes in the page. Without this the stylesheet's
  // 16/9 default answers for every fixture, and the vertical cases below
  // would measure a landscape frame while claiming to measure a portrait
  // one.
  const stage = document.querySelector<HTMLElement>("#stage");
  if (!stage) throw new Error("no #stage in the shell");
  stage.style.setProperty(
    "--frame-ratio",
    `${target.width} / ${target.height}`,
  );
  stage.style.setProperty("--frame-px", String(target.width));

  // The rail with its three entries, as `main.ts` draws it. The 48px comes
  // from CSS either way, but an empty `<nav>` has no height of its own, so
  // the stacked-row check below would be measuring nothing.
  const railRoot = document.querySelector<HTMLElement>("#rail");
  if (!railRoot) throw new Error("no #rail in the shell");
  renderRail(
    railRoot,
    { rail: "export", panelOpen: true, hasSelection: false },
    { onPick: vi.fn() },
  );
  renderExportDoor(
    document.querySelector("#export-open") as HTMLButtonElement,
    { rail: "export", panelOpen: true },
    { onPick: vi.fn() },
  );

  // The transport row too, for fixture realism: it is the dock's first
  // row, so every height the tests below measure — where `#preview`'s
  // bottom lands, how much of the dock is left for the lanes — is measured
  // against a dock that has it. An empty `#transport` is 0px tall, which is
  // not the dock the page ever draws.
  //
  // It IS what `body.scrollWidth` measures, since 2026-09-21.
  //
  // This note used to say the opposite, and was right at the time: the row
  // was the second row of `#stage` inside `<main>`, and `main { overflow-y:
  // auto }` made `main` a scroll container on both axes — a non-`visible`
  // `overflow-y` forces `overflow-x` to `auto` — so a row too wide for its
  // column scrolled inside `main` and never reached the document. All three
  // of those premises are gone: the row is in `#dock`, `main` has no
  // `overflow`, and `#dock` carries `min-width: 0` but is NOT a scroll
  // container. A transport row too wide for the dock therefore overflows
  // straight onto `document.body.scrollWidth`.
  //
  // Which means the row's own fit is measurable now, and is measured: the
  // `scrollWidth` assertions in "the shell below its own two-column floor",
  // in "keeps the columns at 800px once the panel is closed", in "stacks
  // below the 952px column floor" and in "the stacking floors are the
  // real floors" all mount this row and all run at or below the three-column
  // floor, which is where it is most cramped.
  //
  // It has far more room than it used to. As `#stage`'s second row it was
  // one column wide — 488px at the old 888px floor, exactly what it wanted,
  // which it got by wrapping the format pills onto a second line. In the
  // dock it is the width of the whole shell: 892px of content box at the
  // 952px floor (952 less the two 16px insets and the dock's own 28px of
  // horizontal padding).
  const transportRoot = document.querySelector<HTMLElement>("#transport");
  if (!transportRoot) throw new Error("no #transport in the shell");
  renderTransport(
    transportRoot,
    {
      authored: false,
      playing: transport.playing,
      enabled: true,
      rate: transport.rate,
      looping: false,
    },
    {
      onToggle: vi.fn(),
      onShuttle: vi.fn(),
      onLooping: vi.fn(),
      onSkipToStart: vi.fn(),
    },
  );

  // The picture's controls, into both of `main.ts`'s roots: `#stage-tools`
  // in the timeline toolbar, which is the copy the author uses, and
  // `#stage-bar` on the picture, which the stylesheet shows only in full
  // screen. Fixture realism, the same way `#transport` above needs it: the
  // toolbar's width at the 952px floor is the clock, the shape switch, the
  // zoom chip and the full-screen button as drawn, and an empty
  // `#stage-tools` would let the row fit by measuring nothing.
  //
  // Each with the clock root `main.ts` gives it: the toolbar's clock goes
  // to `#toolbar-clock`, the grid's first column; the floating bar keeps
  // its own.
  for (const [selector, clockSelector] of [
    ["#stage-bar", "#stage-bar"],
    ["#stage-tools", "#toolbar-clock"],
  ] as const) {
    const stageBarRoot = document.querySelector<HTMLElement>(selector);
    if (!stageBarRoot) throw new Error(`no ${selector} in the shell`);
    const clockRoot = document.querySelector<HTMLElement>(clockSelector);
    if (!clockRoot) throw new Error(`no ${clockSelector} in the shell`);
    renderStageBar(
      stageBarRoot,
      {
        authored: false,
        positionMs: clock.positionMs,
        durationMs: clock.durationMs,
        // From the target, not hard-coded: `cover` is what makes a target
        // the vertical cut (see `cameraIntentsForTarget`), and a vertical
        // mount that showed 16:9 on the toggle would be showing a control
        // that contradicts the canvas beside it.
        aspect: target.fit === "cover" ? "9:16" : "16:9",
        enabled: true,
        fullscreen: document.fullscreenElement !== null,
        error: stageError,
        // `mount()` itself never toggles zoom — the tests that care set
        // `body[data-zoom]` directly (see `editor-preview-zoom.test.ts`) —
        // so this is always the state before the chip is ever pressed.
        zoom: "fit",
      },
      {
        onAspect: vi.fn(),
        onFullscreen: vi.fn(),
        onZoom: vi.fn(),
        onDismissError: vi.fn(),
      },
      clockRoot,
    );
  }

  const node = (selector: string): HTMLElement => {
    const found = document.querySelector<HTMLElement>(selector);
    if (!found) throw new Error(`no ${selector}`);
    return found;
  };
  const rect = (selector: string) => node(selector).getBoundingClientRect();
  /** A selector's background composited up the stack onto the body — which
   *  both sheets paint opaque, in the shell's ground — the first selector
   *  being the bottom layer and the last what is seen.
   *
   *  `reduce`, not `reduceRight`. The right-to-left version painted the
   *  FIRST selector last, so `surface("#dock", ".track")` ended with the
   *  panel on top of the lane bed. Every layer was translucent then, which
   *  made the order nearly commutative and the mistake invisible; an opaque
   *  panel made every stack come out the panel's own colour. */
  const surface = (...selectors: string[]): Rgba =>
    selectors
      .map((s) => parse(getComputedStyle(node(s)).backgroundColor))
      .reduce(
        (bg, fg) => over(fg, bg),
        parse(getComputedStyle(node("body")).backgroundColor),
      );

  return { node, rect, surface, canvas, model };
}

/**
 * Mounts the shell with one authored mask and draws the stage overlay for
 * it — the wiring `main.ts` performs right after `renderTimeline`, and
 * which `mount()` itself never reaches (it only calls `renderTimeline`).
 * Returns the overlay's own rect and the canvas it must stay inside.
 *
 * `target` is the preview target of the format selected on the stage. The
 * overlay is placed over the canvas's *drawn* box, and switching format
 * changes that box's shape, its scale and its letterbox offsets all at
 * once — so the landscape case alone would leave the switch untested.
 */
function mountMaskOverlay(
  scheme: "light" | "dark",
  target: RenderTarget = previewTarget(LANDSCAPE_1080P),
  maskRect?: { x: number; y: number; width: number; height: number },
) {
  const scene = maskedScene(maskRect);
  const bundle = proceduralBundle();
  // `composeForTarget`, the way `main.ts`'s `refreshDerived` produces the
  // pair it then hands `renderStageOverlay` — so the overlay is placed over
  // the same camera the preview draws with, vertical cap included. The
  // front half alone (`resolvePlan` + `derivePresentation`) skips that cap,
  // which is the one thing that differs between the two targets here.
  const { resolved, presentation } = composeForTarget({
    plan: planScene(scene),
    bundle,
    scene,
    target,
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
  const { node, rect, canvas } = mount(scheme, null, 0, model, target);
  const overlayRoot = node("#stage-overlay");
  renderStageOverlay(
    overlayRoot,
    {
      canvas,
      selection: { kind: "mask", id: mask.id },
      model,
      resolved,
      presentation,
      target,
      outputTimeMs: mask.startMs + 200,
    },
    { onMaskRect: vi.fn(), onZoomPoint: vi.fn() },
  );
  return { rect, canvas };
}

beforeEach(async () => {
  document.body.innerHTML = "";
  await page.viewport(PAGE.width, PAGE.height);
});

describe("the editor shell docks the timeline under the stage", () => {
  /**
   * `#stage` is a box; the canvas inside it is what the author sees, and a
   * canvas overflows its box visibly. That is the whole history of this
   * suite — the rect-on-the-box assertion stayed green while the canvas
   * painted 111px past it and across the lanes.
   *
   * So: the painted canvas against the painted card, and the seam between
   * them asserted too. "Does not overlap" is satisfied by a preview that
   * has collapsed to nothing; the seam is what says the two are still
   * laid out rather than merely not colliding.
   */
  it("keeps a full seam between the painted preview and the dock", () => {
    const { rect } = mount("light");
    const gap = rect("#dock").top - rect("#preview").bottom;
    expect(
      rect("#preview").height,
      "the preview collapsed, which satisfies every overlap check trivially",
    ).toBeGreaterThan(100);
    // The gap is TWO tracks, not one: `main`'s own padding (`--gap`, the
    // inset a card holds its content off its edge by) plus the row-gap
    // between the view and dock rows (`--seam`). A threshold of `--seam`
    // alone passed with either one zeroed out — this is "a FULL seam",
    // both of them.
    expect(gap, `preview bottom to dock top: ${gap}px`).toBeGreaterThanOrEqual(
      length("--seam") + length("--gap"),
    );
  });

  it("keeps two take notes on separate lines", async () => {
    // Reported by the author 2026-09-26, reading their own take:
    // "keyframeOnly: debugger detached1 hover move changed nothing on
    // screen." Each notice is its own <span>, spans are inline, and the
    // `.notice` box around them is a plain block — so the moment a take has
    // two notes they run together, with a digit glued to a word.
    //
    // The notes live in a popover, and a closed popover lays nothing out:
    // the first version of this test measured two all-zero rects and passed
    // `0 >= 0` with and without any fix. Hence the height premise below.
    await page.viewport(1280, 900);
    const scene = readonlyScene();
    const bundle = proceduralBundle();
    const resolved = resolvePlan(planScene(scene), bundle, scene);
    const model = {
      ...buildLaneModel({
        scene,
        view: buildTimelineView({ scene, bundle, resolved }),
        bundle,
        resolved,
        hoverReport: null,
      }),
      notices: [
        "keyframeOnly: debugger detached",
        "1 hover move changed nothing on screen.",
      ],
    };
    const { node } = mount("light", null, 156, model);
    renderTakeNotes(node("#take-notes"), {
      notices: model.notices,
      hoverReport: null,
    });
    renderNotesButton(node("#notes-open"), node("#notes"));
    node("#notes-open").click();

    const lines = [
      ...node("#take-notes").querySelectorAll("[data-take-notice]"),
    ];
    expect(lines).toHaveLength(2);
    const [first, second] = lines.map((l) => l.getBoundingClientRect());
    if (first === undefined || second === undefined) throw new Error("fixture");
    // The premise the first version lacked: both notes are actually painted.
    expect(first.height, "the notes popover laid nothing out").toBeGreaterThan(
      0,
    );
    expect(second.height).toBeGreaterThan(0);
    expect(
      second.top,
      "two take notes painted on the same line, running together",
    ).toBeGreaterThanOrEqual(first.bottom);
  });

  it("keeps the whole timeline inside the window", () => {
    const { rect } = mount("light");
    expect(rect("#dock").bottom).toBeLessThanOrEqual(PAGE.height);
  });

  /**
   * The canvas, not the stage.
   *
   * `#stage` is a box; the canvas inside it is what the author sees, and a
   * canvas overflows its box visibly. The two parted company exactly here:
   * `render()` gives the canvas a bitmap the size of the output, so it has an
   * intrinsic aspect ratio, and a `height: 100%` that cannot resolve against a
   * content-sized row fell back to `width / aspect`. The canvas then painted
   * 111px past `#stage` and across the timeline while `#stage`'s own rect
   * still reported a clean 16px gutter — which is why the first assertion in
   * this suite stayed green through the whole bug.
   */
  for (const [width, height, statusPx = 156] of WINDOWS) {
    /** The premise of a row that shows no stand-in: the page as shipped,
     *  with the status row collapsed. Without it a stand-in that crept
     *  back in would make the row measure a different page from the one
     *  its comment names. The positive half is the stand-in rows'. */
    const statusPremise = (rect: (q: string) => DOMRect) => {
      if (statusPx === 0) {
        expect(
          rect("#status").height,
          `the status row takes space at ${width}x${height}, which is meant to be the page as shipped`,
        ).toBe(0);
      } else {
        expect(
          rect("[data-status-standin]").height,
          "the status stand-in is not drawn",
        ).toBeCloseTo(statusPx, 0);
      }
    };

    it(`keeps the video off the timeline at ${width}x${height}`, async () => {
      await page.viewport(width, height);
      const { rect } = mount("light", null, statusPx);
      statusPremise(rect);
      expect(rect("#preview").bottom).toBeLessThanOrEqual(rect("#dock").top);
    });

    it(`keeps the video off the timeline with a notice line at ${width}x${height}`, async () => {
      // A rebuild that reports something grows the page by a line. Until
      // 2026-09-22 that line grew the DOCK — the notices were a list under
      // the lanes — so this case existed because the readout must not be
      // paid for with the video painting over the lanes it is drawn on.
      //
      // From then until later that day it grew the STATUS ROW, which pushed
      // the stage and the dock down. Since then it grows nothing: the card
      // is drawn in the `#notes` popover, off a header button. So the
      // claim here is the strongest one — the page is laid out exactly as
      // it is with no notice at all — and the card is still rendered for
      // real, so a notice that went nowhere cannot pass it.
      await page.viewport(width, height);
      const scene = readonlyScene();
      const bundle = proceduralBundle();
      const resolved = resolvePlan(planScene(scene), bundle, scene);
      const model = {
        ...buildLaneModel({
          scene,
          view: buildTimelineView({ scene, bundle, resolved }),
          bundle,
          resolved,
          hoverReport: null,
        }),
        notices: [
          "pacingUnplaced: 2 recorded pauses could not be placed. Re-shoot it in Runs to restore them.",
        ],
      };
      const { rect, node } = mount("light", null, statusPx, model);
      statusPremise(rect);
      const before = ["main", "#preview", "#dock"].map((q) => rect(q).toJSON());
      renderTakeNotes(node("#take-notes"), {
        notices: model.notices,
        hoverReport: null,
      });
      renderNotesButton(node("#notes-open"), node("#notes"));
      // Fixture guard: without the notice in the DOM this is the test above
      // with extra steps — and the button has to be up, or the note is
      // somewhere the author has no way to reach.
      node("[data-take-notice]");
      expect(
        getComputedStyle(node("#notes-open")).display,
        "the notes button stayed hidden over a take note",
      ).not.toBe("none");
      expect(
        ["main", "#preview", "#dock"].map((q) => rect(q).toJSON()),
        "a take note moved the page — it is back in the page's flow",
      ).toEqual(before);
      // Unconditional: the video painting over the lanes is the defect this
      // whole file exists to catch, and it is a defect in either layout.
      expect(rect("#preview").bottom).toBeLessThanOrEqual(rect("#dock").top);
      // And the other end of the same picture: the lanes inside the card
      // that paints around them.
      //
      // `#dock` is a grid whose lane row is `minmax(0, 1fr)` precisely so
      // the lanes can be handed LESS than they want and scroll — as a
      // plain block they cannot shrink, and in a short window they run out
      // of the card's painted bottom and off the foot of the page while
      // `#dock`'s own rect, stretched to its grid track, still reports a
      // box inside the window. Every other check in this file reads the
      // card's edge, so without this one that failure is invisible.
      expect(
        rect("#timeline").bottom,
        `the lanes end at ${rect("#timeline").bottom}, past the dock's own bottom ${rect("#dock").bottom}, at ${width}x${height} — they overflowed the card instead of scrolling inside it`,
      ).toBeLessThanOrEqual(rect("#dock").bottom);
      if (width >= STACKED_FLOOR) {
        expect(
          rect("#dock").bottom,
          `timeline bottom ${rect("#dock").bottom} past the ${height}px window at ${width}x${height}`,
        ).toBeLessThanOrEqual(height);
      } else {
        // The stacked page scrolls; a stacked page that fits is a page that
        // dropped a row. Below the floor the panel is stacked UNDER the
        // timeline (the rail keeps its track beside the stage) and `body` is
        // `height: auto`, so with the stand-in showing the document is far
        // taller than any stacked window here — asserting it fits would be
        // asserting the panel had gone missing.
        expect(
          document.body.scrollHeight,
          `stacked page at ${width}x${height} is ${document.body.scrollHeight}px tall — a stacked page that fits in the window has dropped a row; rows: ${[
            "header",
            "#status",
            "main",
            "#dock",
            "#rail",
            "aside",
          ]
            .map((q) => `${q}=${rect(q).height}`)
            .join(" ")}`,
        ).toBeGreaterThan(height);
      }
    });

    it(`keeps the video usable at ${width}x${height}`, async () => {
      await page.viewport(width, height);
      const { rect } = mount("light", null, statusPx);
      statusPremise(rect);
      // The floor at `body`'s wide-layout row (`grid-template-rows`'s
      // `minmax(220px, 1fr)` track) exists
      // because flooring the row at 0 fixed the overlap by letting the
      // video shrink to 22px, and then to nothing. An editor whose video
      // has vanished is not fixed.
      expect(rect("#preview").height).toBeGreaterThanOrEqual(150);
      // Below `STACKED_FLOOR`, `body` is `height: auto` and nothing floors
      // the `view` row any more (a floor was tried here and reverted — see
      // the comment beside the two stacked `@media` blocks in index.html).
      // Instead `#stage-box` carries its own `aspect-ratio:
      // var(--frame-ratio)` in that media query, so its height is DERIVED
      // from its width rather than handed down from a row — the same way
      // the canvas's own intrinsic ratio sized it before 2026-09-21.
      // Asserted against that derivation, not a pixel literal: a literal
      // would go stale the moment the ratio or the column width moved, and
      // — proven in fix round 1 — would have stayed green through a floor
      // that pinned the picture at the wrong size instead of restoring it.
      if (width < STACKED_FLOOR) {
        const stageBox = rect("#stage-box");
        const target = previewTarget(LANDSCAPE_1080P); // `mount()`'s own default
        const expectedHeight = stageBox.width / (target.width / target.height);
        expect(
          stageBox.height,
          `#stage-box is ${stageBox.width}x${stageBox.height} at ${width}x${height} — not derived from its own width and --frame-ratio (expected height ${expectedHeight})`,
        ).toBeCloseTo(expectedHeight, 0);
        // And the picture fills that box exactly — `#stage-frame`'s own
        // `min(100cqw, calc(100cqh * ratio))` picks the same number either
        // way once `#stage-box`'s aspect already matches, so there is no
        // second letterbox layer between the stage box and the drawn box
        // here.
        expect(rect("#preview").height).toBeCloseTo(stageBox.height, 0);
      }
    });

    for (const scheme of ["light", "dark"] as const) {
      it(`keeps the video off the four-lane timeline with a mask on it at ${width}x${height} in ${scheme}`, async () => {
        // Three lanes are taller than two, so a mask exercises the tallest
        // timeline the shell draws — a stricter version of the overlap
        // check above. Turns red the same way: if `#preview` in
        // `index.html` regresses from `height: 100%` back to `height:
        // auto`, the canvas resumes sizing itself off its own intrinsic
        // bitmap ratio instead of the row `object-fit: contain` gives it,
        // and paints past `#stage` and across the lanes again — the bug
        // this file's opening docblock describes. Verified: reverting that
        // one declaration turns the two-lane check above red at 5 of these
        // 6 window sizes, but at 1155x896 it stays green — the extra
        // height a shown Mask lane adds is what turns THIS check red there
        // too, catching the same regression the two-lane check misses at
        // that size.
        await page.viewport(width, height);
        const scene = maskedScene();
        const bundle = proceduralBundle();
        const resolved = resolvePlan(planScene(scene), bundle, scene);
        const model = buildLaneModel({
          scene,
          view: buildTimelineView({ scene, bundle, resolved }),
          bundle,
          resolved,
          hoverReport: null,
        });
        // The Mask lane is always drawn since 2026-09-14 (a click on its
        // empty track adds a mask), so the two-lane check above is a
        // three-lane check too; this one keeps a mask segment on the lane
        // and the taller notices column, the tallest the timeline gets.
        // Three since 2026-09-22, when the beats' own strip folded back
        // into the Clip track.
        const { rect } = mount(scheme, null, statusPx, model);
        statusPremise(rect);
        // Fixture guard: without the mask lane actually drawn, this is the
        // check above with extra steps.
        const lanes = document.querySelectorAll("[data-lane]");
        expect(
          lanes.length,
          `expected 3 lanes (clip/zoom/mask) at ${width}x${height} in ${scheme}, found ${lanes.length}`,
        ).toBe(3);
        const preview = rect("#preview");
        // The DOCK's top edge, not `#timeline`'s: the card's padding moved
        // up to `#dock` on 2026-09-21, so the lanes start 10px inside the
        // painted edge and a canvas that crossed the card would still clear
        // them.
        const dock = rect("#dock");
        expect(
          preview.bottom,
          `canvas bottom ${preview.bottom} overran the dock's top ${dock.top} at ${width}x${height} in ${scheme} with the mask lane shown`,
        ).toBeLessThanOrEqual(dock.top);
      });
    }
  }

  /**
   * What gives when the window cannot hold everything: the LANES, and they
   * give by scrolling.
   *
   * The shell is `height: 100vh`, the video's row is floored at 220px and
   * the dock's row is `auto` — so in a short window the dock is the one
   * track that can be handed less than it wants. It can only do that if
   * something inside it shrinks: `#dock` is a grid whose lane row is
   * `minmax(0, 1fr)`, and `#timeline`'s `overflow-x: auto` makes it a
   * scroll container, whose automatic minimum size is 0.
   *
   * Written as a plain block instead, the dock keeps its full content
   * height, the lanes paint out through the card's bottom edge and off the
   * foot of the page — measured before this rule existed: the dock's bottom
   * landed at 736 in a 620px window. The old layout got the same behaviour
   * for free, from `#timeline` being an `auto` row inside a scrolling
   * `main`; moving the timeline into `#dock` is what took it away.
   *
   * 1000x620 with a notice showing is one of the two `WINDOWS` entries that
   * produced that 736, so this is the same input, asserted on the lanes'
   * own box rather than the card's.
   */
  it("squeezes the lanes rather than the video when the window is short", async () => {
    await page.viewport(1000, 620);
    const scene = readonlyScene();
    const bundle = proceduralBundle();
    const resolved = resolvePlan(planScene(scene), bundle, scene);
    const model = {
      ...buildLaneModel({
        scene,
        view: buildTimelineView({ scene, bundle, resolved }),
        bundle,
        resolved,
        hoverReport: null,
      }),
      notices: [
        "pacingUnplaced: 2 recorded pauses could not be placed. Re-shoot it in Runs to restore them.",
      ],
    };
    const { rect, node } = mount("light", null, 156, model);
    renderTakeNotes(node("#take-notes"), {
      notices: model.notices,
      hoverReport: null,
    });
    // Fixture guard: the status card is what makes this window short
    // enough to squeeze anything. That was the notice's line until
    // 2026-09-22, when the notice moved into the `#notes` popover and
    // stopped taking room; it was `#develop` until 2026-09-28, and is
    // `mount`'s stand-in card now, the status row having no resident. Without it the three assertions below hold in a window
    // with room to spare and say nothing.
    expect(
      rect("#status").height,
      "the status row drew nothing, so this window is not short",
    ).toBeGreaterThan(0);
    const lanes = node("#timeline");
    // The squeeze happened AND it was absorbed by scrolling. Equal heights
    // here mean the lanes were given everything they asked for, which at
    // this window size means the dock pushed past the bottom of the shell
    // instead of shrinking.
    expect(
      lanes.scrollHeight,
      `the lanes are ${lanes.clientHeight}px of box holding ${lanes.scrollHeight}px of content at 1000x620 — nothing was squeezed, so the dock took its full height and the card went off the foot of the page`,
    ).toBeGreaterThan(lanes.clientHeight);
    // And the squeeze stayed inside the card.
    expect(
      rect("#timeline").bottom,
      `the lanes end at ${rect("#timeline").bottom}, past the dock's own bottom ${rect("#dock").bottom}`,
    ).toBeLessThanOrEqual(rect("#dock").bottom);
    // The video is the thing that did NOT give: it has a floor and the
    // lanes do not, which is the whole reason the squeeze lands here.
    expect(
      rect("#preview").height,
      `the video shrank to ${rect("#preview").height} instead of the lanes`,
    ).toBeGreaterThanOrEqual(150);
  });

  /**
   * Five cards floating on the ground, with a seam between them: the two
   * header cards, the panel, the rail, and the dock under the middle row.
   * The ground is the stage bed since 2026-10-07, and the picture sits on
   * it directly — `#stage` paints nothing, so there is no well between the
   * frame and the page.
   *
   * The seam is asserted against its own token, never against a number:
   * it is a value to tune by eye, and a test that pinned 16 would argue
   * with the next tune instead of catching a regression.
   *
   * History: the chrome was one unbroken container until 2026-09-21; then
   * two cards (panel, dock) and a well (`#stage` painting `--stage-bed`)
   * on a `--shell` ground, with the rail floating on the picture; since
   * 2026-10-07 the well became the ground and the rail a card of its own.
   */
  it("lays the shell out as floating cards on the ground, with a seam between them", () => {
    const { rect, node } = mount("light");
    const seam = length("--seam");
    for (const id of [
      "#inspector",
      "#dock",
      "#rail",
      "header .head-take",
      "header .actions",
    ]) {
      const painted = getComputedStyle(node(id));
      expect(painted.display, `${id} is not painted`).not.toBe("none");
      expect(rect(id).width, `${id} has no width`).toBeGreaterThan(0);
      expect(parse(painted.backgroundColor), `${id} is not a card`).toEqual(
        token("--card"),
      );
      expect(
        Number.parseFloat(painted.borderTopLeftRadius),
        `${id}'s corner`,
      ).toBe(length("--radius-float"));
      expect(painted.boxShadow, `${id} does not float`).not.toBe("none");
    }
    // The stage paints nothing: neither a fill nor a corner. Asserted on
    // alpha, because a transparent black reads as "darker than anything"
    // to a luminance check. And the ground is the bed, so what shows around
    // the picture is the bed — otherwise "the stage is not a well" would be
    // satisfied by a region painting the old `--shell` around it.
    const stage = getComputedStyle(node("#stage"));
    expect(
      parse(stage.backgroundColor)[3],
      "the stage paints a well again",
    ).toBe(0);
    expect(stage.backgroundImage, "the stage paints a glow again").toBe("none");
    expect(stage.borderTopLeftRadius, "the stage rounds a corner again").toBe(
      "0px",
    );
    expect(
      parse(getComputedStyle(document.body).backgroundColor),
      "the ground is not the stage bed",
    ).toEqual(token("--stage-bed"));
    // Edge to edge: the stage fills its grid area with nothing between it
    // and the region's own boundary. Put `padding` back on `main` and every
    // one of these four moves.
    expect(rect("#stage").top, "the stage is inset from the top").toBe(
      rect("main").top,
    );
    expect(rect("#stage").left, "the stage is inset from the left").toBe(
      rect("main").left,
    );
    expect(rect("#stage").right, "the stage is inset from the right").toBe(
      rect("main").right,
    );
    expect(rect("#stage").bottom, "the stage is inset from the bottom").toBe(
      rect("main").bottom,
    );
    // The seams across the middle row, measured between painted edges.
    // `toBeCloseTo`, not `toBe`: the first column is `minmax(520px, 1fr)`
    // and resolves to a fractional width at most window sizes, so the
    // edges either side of a seam land on subpixels.
    expect(
      rect("#rail").left - rect("main").right,
      "stage→rail seam",
    ).toBeCloseTo(seam, 0);
    expect(
      rect("#inspector").left - rect("#rail").right,
      "rail→panel seam",
    ).toBeCloseTo(seam, 0);
    // And the shell's own inset on the right, which the panel reaches while
    // it is open.
    expect(
      window.innerWidth - rect("#inspector").right,
      "panel→window inset",
    ).toBeCloseTo(seam, 0);
    // The one under the middle row, measured off the panel: it stretches
    // to its row, where the rail is only as tall as its entries.
    expect(
      rect("#dock").top - rect("#inspector").bottom,
      "middle→dock seam",
    ).toBeCloseTo(seam, 0);
    // The header's cards, one seam above every card in the middle row.
    // The empty status row between them took a gutter of its own on each
    // side until fix round 1 of 2026-10-07, which put the header 32px up.
    const head = rect("header .head-take").bottom;
    expect(
      rect("header .actions").bottom,
      "the header's cards are not level",
    ).toBeCloseTo(head, 0);
    expect(
      rect("#status").height,
      "the status row takes space in a mount that shows no status card",
    ).toBe(0);
    for (const below of ["#stage", "#inspector", "#rail"]) {
      expect(rect(below).top - head, `header→${below} seam`).toBeCloseTo(
        seam,
        0,
      );
    }
  });

  /* The other half of the header seam: with a status card showing, the
     row takes its place between the header and the middle row with one
     seam on each side — not none, which a fix for the empty row's double
     gutter could easily leave it with. */
  it("keeps a seam above and below the status row when a card shows", () => {
    const { rect } = mount("light", null, 40);
    const seam = length("--seam");
    const card = rect("[data-status-standin]");
    expect(card.height, "the status card is not drawn").toBeCloseTo(40, 0);
    expect(
      card.top - rect("header .head-take").bottom,
      "header→status seam",
    ).toBeCloseTo(seam, 0);
    for (const below of ["#stage", "#inspector", "#rail"]) {
      expect(rect(below).top - card.bottom, `status→${below} seam`).toBeCloseTo(
        seam,
        0,
      );
    }
  });

  it("runs the dock the full width of the shell", () => {
    const { rect } = mount("light");
    // Left edge with the stage, right edge with the panel: the dock is under
    // all three columns, not docked inside the first one the way it was
    // when it lived in `main`. The panel is the rightmost card again since
    // the rail moved between the stage and it (2026-10-07); with the panel
    // closed the rail is, see the next test.
    expect(rect("#dock").left, "dock vs stage left").toBeCloseTo(
      rect("main").left,
      0,
    );
    expect(rect("#dock").right, "dock vs panel right").toBeCloseTo(
      rect("#inspector").right,
      0,
    );
    // The premise that makes the right edge mean something: the panel is
    // past the rail, so a dock that stopped at the rail would fail.
    expect(rect("#inspector").left).toBeGreaterThan(rect("#rail").right);
  });

  /**
   * The failure the obvious implementation has. `column-gap` paints its
   * gutter beside a zero-width track too, so a closed panel would leave a
   * second seam's worth of dead strip between the stage and the rail. The
   * seam lives in the track instead, so it collapses with the panel.
   *
   * With the panel closed it is the rail that reaches the shell's right
   * inset (open, the panel does: see the seams test above), and the stage
   * that ends one seam short of the rail.
   */
  it("reaches the shell's right inset with the panel closed", async () => {
    const { rect } = mount("light");
    document.body.setAttribute("data-panel", "closed");
    // Wait on the column itself, not on the 180ms `--panel-ms` transition
    // taking some hand-picked multiple of its own duration: `vi.waitFor`
    // polls `#inspector`'s own width, which is what "settled" means here.
    await vi.waitFor(() => {
      if (rect("#inspector").width !== 0) {
        throw new Error(
          `panel still closing: #inspector is ${rect("#inspector").width}px wide`,
        );
      }
    });
    const seam = length("--seam");
    expect(
      window.innerWidth - rect("#rail").right,
      "rail vs window",
    ).toBeCloseTo(seam, 0);
    expect(
      rect("#rail").left - rect("#stage").right,
      `the stage ends at ${rect("#stage").right} and the rail starts at ${rect("#rail").left} — a gutter is still painted beside the closed panel's zero-width track`,
    ).toBeCloseTo(seam, 0);
    expect(rect("#dock").right, "dock vs rail").toBeCloseTo(
      rect("#rail").right,
      0,
    );
  });

  /**
   * The WINDOWS loop above proves the OPEN stacked template
   * (`body:not([data-panel="closed"])`, index.html's `@media (max-width:
   * 951px)` block) sizes `#stage-box` from its own `aspect-ratio`. Nothing
   * there closes the panel, so the CLOSED template
   * (`body[data-panel="closed"]`, `@media (max-width: 615px)`) has its own
   * squeeze case here — dropping ITS `aspect-ratio` back to nothing is a
   * change neither this file's other stacked-floor tests (which mount at
   * 860px tall, well above where anything here would even be missed — see
   * "stacks one pixel below the closed floor") nor the WINDOWS loop (which
   * never closes the panel) would notice.
   */
  it("keeps the video usable stacked, squeezed, with the panel closed", async () => {
    await page.viewport(STACKED_CLOSED_FLOOR - 1, 560);
    const { rect } = mount("light", null, 156);
    document.body.setAttribute("data-panel", "closed");
    await vi.waitFor(() => {
      if (rect("#inspector").width !== 0) {
        throw new Error(
          `panel still closing: #inspector is ${rect("#inspector").width}px wide`,
        );
      }
    });
    expect(rect("#preview").height).toBeGreaterThanOrEqual(150);
    // See the open-panel case above for why this is asserted against
    // `#stage-box`'s own width and `--frame-ratio` rather than a literal.
    const stageBox = rect("#stage-box");
    const target = previewTarget(LANDSCAPE_1080P);
    const expectedHeight = stageBox.width / (target.width / target.height);
    expect(
      stageBox.height,
      `#stage-box is ${stageBox.width}x${stageBox.height} — not derived from its own width and --frame-ratio (expected height ${expectedHeight})`,
    ).toBeCloseTo(expectedHeight, 0);
    expect(rect("#preview").height).toBeCloseTo(stageBox.height, 0);
  });
});

describe("the shell below its own two-column floor", () => {
  it("stacks to one column instead of running the inspector off-screen", async () => {
    await page.viewport(800, 700);
    const { rect } = mount("light");
    // 520px of stage plus a 340px inspector does not fit in 800px. Before the
    // breakpoint the grid simply overflowed: body.scrollWidth pinned at 860
    // and the inspector's right edge sat past the window.
    expect(document.body.scrollWidth).toBeLessThanOrEqual(800);
    expect(rect("aside").right).toBeLessThanOrEqual(800);
    expect(rect("aside").top).toBeGreaterThanOrEqual(rect("#dock").top);
  });

  it("still puts the inspector beside the stage above the floor", async () => {
    await page.viewport(1100, 700);
    const { rect } = mount("light");
    expect(rect("aside").left).toBeGreaterThanOrEqual(rect("main").right);
  });
});

describe("the rail and the panel", () => {
  for (const scheme of ["light", "dark"] as const) {
    /* The rail is a card in a track of its own since 2026-10-07, between the
       stage and the panel (the author moved it from the window's edge the
       same day). It floated on the picture before that, inside `#stage`,
       which is what the four tests this replaced measured. */
    it(`puts the rail between the stage and the panel, and gives the panel 320px, in ${scheme}`, () => {
      const { node, rect } = mount(scheme);
      expect(
        node("#stage").contains(node("#rail")),
        "the rail is still inside the stage",
      ).toBe(false);
      const rail = rect("#rail");
      const panel = rect("#inspector");
      const stage = rect("#stage");
      expect(rail.width, "the rail painted nothing").toBeGreaterThan(0);
      expect(panel.width).toBeCloseTo(320, 0);
      expect(rail.left - stage.right, "stage → rail").toBeCloseTo(16, 0);
      expect(panel.left - rail.right, "rail → panel").toBeCloseTo(16, 0);
      expect(
        window.innerWidth - panel.right,
        "panel → window edge",
      ).toBeCloseTo(16, 0);
      expect(rail.top).toBeCloseTo(panel.top, 0);
    });

    it(`moves the rail to the window's edge and gives the stage the panel's width when it closes, in ${scheme}`, () => {
      const { rect } = mount(scheme);
      document.body.style.transition = "none";
      const stageBefore = rect("#stage");
      const railBefore = rect("#rail");
      // The premise: open, the panel is to the rail's right.
      expect(rect("#inspector").left).toBeGreaterThan(railBefore.right);
      document.body.setAttribute("data-panel", "closed");
      const rail = rect("#rail");
      expect(window.innerWidth - rail.right, "rail → window edge").toBeCloseTo(
        16,
        0,
      );
      expect(rail.top).toBeCloseTo(railBefore.top, 0);
      // The panel's track, less the spacer that mirrors the rail's on the
      // left (author, 2026-10-07): the stage is centred, not left-packed.
      expect(rect("#stage").width - stageBefore.width).toBeCloseTo(
        320 + 16 - (48 + 16),
        0,
      );
      expect(rail.left - rect("#stage").right, "stage → rail").toBeCloseTo(
        16,
        0,
      );
    });

    // Red without the spacer: the picture sat half a rail's track (32px)
    // left of the timeline's centre with the panel closed. Open, it is
    // allowed off centre — the premise half — so the closed assertion is
    // not passing on a layout that centres everything regardless.
    it(`centres the picture over the timeline with the panel closed, in ${scheme}`, () => {
      const { rect } = mount(scheme);
      document.body.style.transition = "none";
      const centre = (r: DOMRect) => r.left + r.width / 2;
      expect(
        Math.abs(centre(rect("#stage")) - centre(rect("#dock"))),
        "open, the panel pushes the picture over",
      ).toBeGreaterThan(100);
      document.body.setAttribute("data-panel", "closed");
      expect(centre(rect("#stage"))).toBeCloseTo(centre(rect("#dock")), 0);
      expect(centre(rect("#stage-frame"))).toBeCloseTo(
        centre(rect("#dock")),
        0,
      );
    });

    it(`stacks one pixel under the open floor with nothing overlapping in ${scheme}`, async () => {
      await page.viewport(951, 800);
      const { rect } = mount(scheme);
      const boxes = {
        take: rect("header .head-take"),
        actions: rect("header .actions"),
        stage: rect("#stage"),
        rail: rect("#rail"),
        dock: rect("#dock"),
        panel: rect("#inspector"),
      };
      // The premise: it really stacked — the panel is under the dock.
      expect(boxes.panel.top).toBeGreaterThanOrEqual(boxes.dock.bottom);
      expect(boxes.rail.left).toBeGreaterThanOrEqual(boxes.stage.right);
      const names = Object.keys(boxes) as Array<keyof typeof boxes>;
      for (const a of names) {
        for (const b of names) {
          if (a >= b) continue;
          const p = boxes[a];
          const q = boxes[b];
          const overlap =
            p.left < q.right &&
            q.left < p.right &&
            p.top < q.bottom &&
            q.top < p.bottom;
          expect(overlap, `${a} overlaps ${b}: ${JSON.stringify([p, q])}`).toBe(
            false,
          );
        }
      }
    });

    it(`puts the take on the left and the actions on the right in ${scheme}`, async () => {
      const { node } = mount(scheme);
      renderHeaderIcons();
      const ids = (selector: string) =>
        [...node(selector).querySelectorAll<HTMLElement>("button")].map(
          (b) => b.id,
        );
      // The length-and-size line between them is Take info's button since
      // 2026-10-19 (it was a span).
      expect(ids("header .head-take")).toEqual(["back", "take-meta", "delete"]);
      expect(ids("header .actions")).toEqual([
        "notes-open",
        "shortcuts-open",
        "undo",
        "redo",
        "export-open",
      ]);
      const take = node("header .head-take").getBoundingClientRect();
      const actions = node("header .actions").getBoundingClientRect();
      expect(take.right).toBeLessThan(actions.left);
      expect(node("#export-open").checkVisibility()).toBe(true);
    });

    it(`keeps Export on screen beside an 80-character name at the floor in ${scheme}`, async () => {
      await page.viewport(952, 800);
      const { node } = mount(scheme);
      const name = node("#name") as HTMLInputElement;
      name.value = "A".repeat(80);
      // The premise: the name really is longer than its field.
      expect(name.scrollWidth).toBeGreaterThan(name.clientWidth);
      const door = node("#export-open").getBoundingClientRect();
      expect(door.width).toBeGreaterThan(0);
      expect(door.right).toBeLessThanOrEqual(window.innerWidth);
      expect(
        name.getBoundingClientRect().right,
        "the name ran under the actions card",
      ).toBeLessThanOrEqual(
        node("header .actions").getBoundingClientRect().left,
      );
    });

    it(`reads the take meta at 4.5:1 on its card in ${scheme}`, () => {
      const { node, surface } = mount(scheme);
      node("#take-meta").textContent = "0:09 · 1920 × 1080";
      expect(
        contrast(
          parse(getComputedStyle(node("#take-meta")).color),
          surface("header .head-take"),
        ),
      ).toBeGreaterThanOrEqual(4.5);
    });

    /* Closing animates the column shut since 2026-09-20, so `display: none`
       had to go: `display` cannot be transitioned before `allow-discrete`
       (Chrome 117), and the panel has to stay painted while its column
       collapses under it. `visibility: hidden` replaces it in the
       three-column layout. The part `display` was ALSO doing — making a
       closed panel unreachable — is what this pins, because it is the half
       a later refactor would drop silently. */
    it(`keeps a closed panel painted out and out of reach in ${scheme}`, async () => {
      await page.viewport(1440, 860);
      const { rect, node } = mount(scheme);
      // A stand-in for the panel's own controls: this mount leaves the
      // inspector empty, and the claim is about anything inside it. The
      // guard below is what makes it a valid subject — it has to be
      // reachable while the panel is open, or "unreachable when closed"
      // is true of a button that was never reachable at all.
      const probe = document.createElement("button");
      probe.id = "panel-probe";
      node("#inspector").append(probe);
      probe.focus();
      expect(document.activeElement, "the probe was never focusable").toBe(
        probe,
      );
      probe.blur();

      document.body.dataset.panel = "closed";
      const style = getComputedStyle(node("#inspector"));
      expect(style.visibility).toBe("hidden");
      expect(rect("#inspector").width).toBe(0);
      expect(document.body.scrollWidth).toBeLessThanOrEqual(1440);

      probe.focus();
      expect(
        document.activeElement === probe,
        "focus reached a control inside the closed panel",
      ).toBe(false);
      document.body.dataset.panel = "open";
    });

    /* The one claim this lane cannot measure. `mountShell` injects
       `* { transition: none !important }`, so no transition runs here at
       all — which is also why every "closed ⇒ width 0" assertion above
       still reads the end state immediately. The declaration is therefore
       read out of the CSSOM, exactly as the popup's `.shake` is.

       What is asserted is the invariant, not the number: the column's
       duration and the delay that hides the panel afterwards must come from
       the SAME custom property. Written as two literals they would drift,
       and the panel would go invisible either before its column finished
       closing or after the stage had already taken the width. */
    it(`animates the panel from one duration, ungated, in ${scheme}`, async () => {
      await page.viewport(1440, 860);
      mount(scheme);
      const sheet = [...document.styleSheets].find((x) =>
        (x.ownerNode as HTMLElement | null)?.hasAttribute("data-shell"),
      );
      if (!sheet) throw new Error("the editor's stylesheet is not mounted");
      // Carries whether a rule sits inside a media block, because the two
      // rules that close the panel share a selector and differ only by
      // where they live — matching on the selector alone found whichever
      // came first in the sheet, which is the stacked one.
      type Found = { rule: CSSStyleRule; media: string | null };
      const flatten = (list: CSSRuleList, media: string | null): Found[] =>
        [...list].flatMap((r) =>
          r instanceof CSSStyleRule
            ? [{ rule: r, media }]
            : r instanceof CSSMediaRule
              ? flatten(r.cssRules, r.conditionText)
              : [],
        );
      const found = flatten(sheet.cssRules, null);
      const all = found.map((f) => f.rule);

      const column = all.find((r) =>
        r.style.transition.includes("grid-template-columns"),
      );
      expect(column, "nothing transitions the panel's column").toBeDefined();
      expect(column?.style.transition).toContain("var(--panel-ms)");

      // TWO rules close the panel, and they must close it differently.
      const closers = found.filter(
        (f) => f.rule.selectorText === 'body[data-panel="closed"] aside',
      );
      // Unmediated: the three-column layout, where a column animates shut.
      const byVisibility = closers.find((f) => f.media === null)?.rule;
      // Inside a width media block: the stacked layout, where none does.
      const byDisplay = closers.find((f) => f.media !== null)?.rule;
      expect(byVisibility?.style.visibility).toBe("hidden");
      expect(byDisplay?.style.display).toBe("none");
      expect(
        byVisibility,
        "nothing hides the panel in the column layout",
      ).toBeDefined();
      // The same token, so the hide lands exactly when the column finishes.
      expect(byVisibility?.style.transition).toContain(
        "visibility 0s var(--panel-ms)",
      );
      // Stacked, the panel is a ROW with no column animating shut, and
      // `visibility` would hold a full-height row open with nothing painted
      // in it — which is exactly what replacing `display` here did before it
      // was caught. `display` is still what closing means in that layout.
      expect(
        byDisplay,
        "the stacked layout no longer takes the closed panel out of the flow",
      ).toBeDefined();

      // And it is NOT gated on `prefers-reduced-motion`. That gate was
      // written first and removed: the preference is aimed at decorative
      // motion nobody asked for, and this runs only in answer to a press on
      // the rail — the same call `library/preview.ts` records for its
      // flipbook. Asserted rather than merely deleted, because re-adding
      // the gate is the obvious "fix" for a future reader who reaches for
      // it on principle, and with the setting on it makes the panel look
      // like a transition that was never shipped.
      const gated = found.filter(
        (f) =>
          f.media?.includes("prefers-reduced-motion") === true &&
          f.rule.style.transition === "none" &&
          /body|aside/.test(f.rule.selectorText),
      );
      expect(
        gated.map((f) => f.rule.selectorText),
        "the panel's transition is gated on reduced motion again",
      ).toEqual([]);
    });

    /* `mount()` draws no panel into `#inspector` (the rail and the header's
       door are all it renders), so the long panel is a stand-in in the
       real wrapper: a `.inspector` box of rows ending in a button, which
       is what every panel ends in. What it measures is the card's own CSS —
       that the card scrolls and that `.inspector`'s padding is what is left
       under the last control at the end of the scroll. */
    it(`scrolls a long panel inside its card with the bottom padding intact in ${scheme}`, async () => {
      await page.viewport(1440, 860);
      const { node } = mount(scheme);
      const box = document.createElement("div");
      box.className = "inspector";
      for (let i = 0; i < 40; i++) {
        const row = document.createElement("p");
        row.textContent = `Row ${i}, a control's worth of height.`;
        box.append(row);
      }
      const last = document.createElement("button");
      last.type = "button";
      last.textContent = "Last control";
      box.append(last);
      node("#inspector").replaceChildren(box);
      const aside = node("#inspector");
      // The premise: the panel is taller than the card, so the card has to
      // scroll, and the card itself did not grow to hold it.
      expect(aside.scrollHeight).toBeGreaterThan(aside.clientHeight);
      expect(aside.clientHeight).toBeLessThan(860);
      expect(getComputedStyle(aside).overflowY).toBe("auto");
      aside.scrollTop = aside.scrollHeight;
      expect(aside.scrollTop).toBeGreaterThan(0);
      expect(last.checkVisibility()).toBe(true);
      const room =
        aside.getBoundingClientRect().bottom -
        last.getBoundingClientRect().bottom;
      expect(
        room,
        `${room}px under the last control at the end of the scroll`,
      ).toBeGreaterThanOrEqual(12);
    });

    /* The contents hold still while the column moves. The panel's RIGHT
       edge is the window's and its left edge is what sweeps inward, so the
       box inside is pinned to the right at a fixed width and clipped as
       that edge passes over it — left-anchored it would slide, auto-width
       it would re-wrap every line the whole way.

       Measured at the END states, because `mountShell` disables transitions
       and there is no mid-animation to sample here: a box that still
       measures the full panel width with the column at ZERO is one that did
       not re-lay-out, which is the property that makes it hold still. */
    it(`keeps the panel's contents fixed while the column moves in ${scheme}`, async () => {
      await page.viewport(1440, 860);
      const { rect, node } = mount(scheme);
      const box = document.createElement("div");
      box.className = "inspector";
      box.innerHTML = "<p data-probe-line>A sentence long enough to wrap.</p>";
      node("#inspector").replaceChildren(box);
      const width = () => box.getBoundingClientRect().width;
      const lines = () => {
        const p = box.querySelector("[data-probe-line]");
        // Fixture guard: no paragraph means `lines()` would compare
        // nothing to nothing and the re-wrap check would say nothing.
        if (!p) throw new Error("the probe paragraph is not in the panel");
        return p.getClientRects().length;
      };

      expect(width()).toBe(length("--panel-w"));
      expect(box.getBoundingClientRect().right).toBeCloseTo(
        rect("#inspector").right,
        0,
      );
      const wrapped = lines();

      document.body.dataset.panel = "closed";
      expect(rect("#inspector").width).toBe(0);
      // Same width, same number of wrapped lines, still pinned to the right
      // edge the panel shares with the window — with the column at 0.
      expect(
        width(),
        `the contents re-laid-out to ${width()} when the column closed`,
      ).toBe(length("--panel-w"));
      expect(lines()).toBe(wrapped);
      expect(box.getBoundingClientRect().right).toBeCloseTo(
        node("#inspector").getBoundingClientRect().right,
        0,
      );
      document.body.dataset.panel = "open";
    });

    it(`collapses the panel and hands the stage the width in ${scheme}`, async () => {
      await page.viewport(1440, 860);
      const { rect } = mount(scheme);
      const before = rect("#stage").width;
      document.body.dataset.panel = "closed";
      expect(rect("#inspector").width).toBe(0);
      // The panel's 336px track, less the 64px spacer that keeps the
      // picture centred once it closes.
      expect(rect("#stage").width).toBeGreaterThan(before + 250);
      // The rail bounds the stage, one seam to its right, with the panel
      // shut as with it open — it has its own track since 2026-10-07 and
      // sits next to the stage in both. A rail that drifted back onto the
      // picture would still let the width assertion above pass; this is the
      // half it would fail.
      expect(rect("#rail").left - rect("#stage").right).toBeCloseTo(
        length("--seam"),
        0,
      );
    });
  }

  it("keeps the columns at 800px once the panel is closed, and stacks with it open", async () => {
    // FINDING 9. The stacking rule keyed on width alone, at the OPEN-panel
    // floor (888 then, 952 now). Closing the panel takes its 320px column
    // and that column's seam away, so the layout floor drops to 616 — and
    // an 800px window has that comfortably. Yet it
    // stacked, which made closing the panel (whose whole job is to hand the
    // width to the stage) do nothing an author could see.
    await page.viewport(800, 700);
    const { rect } = mount("light");
    document.body.dataset.panel = "closed";
    // Columns, not stacked: the panel sits BESIDE the stage rather than
    // under the dock. Read off the panel since 2026-09-21 — the rail used
    // to be the tell, flipping from column to row across this boundary,
    // and it is a column at every width now with no orientation to read.
    // The rail is checked separately, below.
    expect(
      rect("#inspector").top,
      `panel at y=${rect("#inspector").top} vs dock bottom ${rect("#dock").bottom} at 800x700, panel closed — that is stacked, not columns`,
    ).toBeLessThan(rect("#dock").top);
    expect(rect("#stage").right).toBeLessThanOrEqual(rect("#inspector").left);
    // The columns really do fit: nothing runs off the right edge.
    expect(document.body.scrollWidth).toBeLessThanOrEqual(800);

    // And the other half of the split: at the same width with the panel
    // OPEN, 952 of layout does not fit in 800 and the page still stacks.
    document.body.dataset.panel = "open";
    expect(
      rect("#inspector").top,
      `panel at y=${rect("#inspector").top} vs dock bottom ${rect("#dock").bottom} at 800x700, panel open — 952px of columns cannot fit in 800`,
    ).toBeGreaterThanOrEqual(rect("#dock").bottom);
    expect(rect("aside").right).toBeLessThanOrEqual(800);
    // Stacked or not, the rail keeps its track beside the stage, level
    // with its top. This is the case the change is most likely to have
    // broken and the one nothing else here would catch, because every
    // assertion above is about the panel.
    expect(rect("#rail").left).toBeGreaterThanOrEqual(rect("#stage").right);
    expect(rect("#rail").top).toBeCloseTo(rect("#stage").top, 0);
  });

  /* Stacked, the rail keeps its own track beside the stage rather than
     taking a row of its own: 48px costs the picture little, and the rail
     stays next to what it acts on. It had a row between the dock and the
     panel until 2026-09-21, then floated on the picture until 2026-10-07. */
  it("stacks below the 952px column floor, with the rail beside the stage", async () => {
    await page.viewport(STACKED_FLOOR - 1, 860);
    const { rect, node, surface } = mount("light");
    // The premise: it really stacked — the panel is under the dock.
    expect(rect("#inspector").top).toBeGreaterThanOrEqual(rect("#dock").bottom);
    expect(
      rect("#rail").left,
      `the rail starts at ${rect("#rail").left} against a stage ending at ${rect("#stage").right} when stacked`,
    ).toBeGreaterThanOrEqual(rect("#stage").right);
    expect(rect("#rail").top).toBeCloseTo(rect("#stage").top, 0);
    expect(document.body.scrollWidth).toBeLessThanOrEqual(STACKED_FLOOR - 1);
    // The panel carries no rule on either edge: it separates on tone in
    // both layouts, so there is no line for the stacked block to move.
    expect(getComputedStyle(node("#inspector")).borderLeftWidth).toBe("0px");
    expect(getComputedStyle(node("#inspector")).borderTopWidth).toBe("0px");
    // The chrome is one tone, and stacking is where that could stop being
    // true unnoticed: this media block rewrites the grid, so a fill keyed
    // on the stacked case would land here and nowhere else.
    expect(surface("#dock")).toEqual(surface("#inspector"));
    expect(surface("#rail")).toEqual(surface("#inspector"));
    expect(contrast(surface("#dock"), surface("body"))).toBeGreaterThanOrEqual(
      1.15,
    );
  });
});

/**
 * Both stacking breakpoints are hand-written literals, because a media
 * query cannot read `--seam`. So this asserts the RELATIONSHIP rather than
 * either number: AT each floor the three columns fit with no horizontal
 * overflow, and one pixel below it the shell has stacked. (The floor is
 * the narrowest width that fits; the media query's own literal is one
 * below it, because `max-width` reads inclusively.)
 *
 * That holds whatever the seam is tuned to, and fails the moment a tune
 * moves the real floor and leaves a query behind — which is the failure
 * that otherwise shows up only as a window width nobody happens to try.
 */
describe("the stacking floors are the real floors", () => {
  for (const [label, floor, panel] of [
    ["open", STACKED_FLOOR, null],
    ["closed", STACKED_CLOSED_FLOOR, "closed"],
  ] as const) {
    it(`fits three columns at the ${label} floor`, async () => {
      await page.viewport(floor, 860);
      const { rect, node } = mount("light");
      if (panel) {
        document.body.setAttribute("data-panel", panel);
        // Only the closed case animates a column shut; wait on that column
        // itself rather than a multiple of `--panel-ms` guessed by hand.
        await vi.waitFor(() => {
          if (rect("#inspector").width !== 0) {
            throw new Error(
              `panel still closing: #inspector is ${rect("#inspector").width}px wide`,
            );
          }
        });
      }
      // Still side by side: the PANEL's top is level with the preview's,
      // which is only true while they share a row. Not the rail's: it
      // keeps its track beside the stage in BOTH layouts, so its top is
      // level with the preview's either way and could never fail here.
      expect(
        rect("#inspector").top,
        `${label} floor: panel vs preview`,
      ).toBeCloseTo(rect("main").top, 0);
      // Four tracks — spacer, stage, rail, panel — against the stacked
      // layouts' two. The closed panel's is there at 0px, and so is the
      // spacer at either floor (it is the first width to go), so the count
      // is the same either way.
      const columns = getComputedStyle(document.body).gridTemplateColumns;
      expect(
        columns.trim().split(/\s+/).length,
        `${label} floor: the shell stacked when it should have fitted (columns: ${columns})`,
      ).toBe(4);
      expect(
        columns.trim().split(/\s+/)[0],
        `${label} floor: the spacer took width the stage's floor needed`,
      ).toBe("0px");
      // And nothing ran off the edge. The floor guard's own culprit is the
      // columns; the transport row shares this same document width and can
      // overflow it on a wider-glyph machine than this one renders with
      // (see CLAUDE.md's fixture-app note) without a column being wrong at
      // all — so the message carries its own width budget rather than
      // naming only the columns.
      const transport = node("#transport");
      expect(
        document.documentElement.scrollWidth,
        `${label} floor: the columns overflowed instead of fitting (transport row: ${transport.scrollWidth}px needed of ${transport.clientWidth}px given)`,
      ).toBeLessThanOrEqual(floor);
    });

    it(`stacks one pixel below the ${label} floor`, async () => {
      await page.viewport(floor - 1, 860);
      const { rect } = mount("light");
      if (panel) {
        document.body.setAttribute("data-panel", panel);
        await vi.waitFor(() => {
          if (rect("#inspector").width !== 0) {
            throw new Error(
              `panel still closing: #inspector is ${rect("#inspector").width}px wide`,
            );
          }
        });
      }
      // The track COUNT, not any element's position: three wide (stage,
      // panel, rail), two stacked (the stage and the rail's track beside
      // it; the panel takes a row under the dock).
      //
      // This read `#rail`'s top until 2026-09-21, which worked while the
      // rail was a row of its own. The rail sits beside the stage in BOTH
      // layouts now, so its top cannot tell them apart. The obvious
      // substitute — the panel — cannot either in the closed case: a
      // closed panel is painted out, so its rect is 0x0 at the origin and
      // `top > main.bottom` is false whether or not the shell stacked.
      //
      // Counting tracks is the question this test is actually asking, and
      // it answers it the same way whether the panel is open, closed, or
      // painted out entirely. Controlled by breaking both stacking queries
      // — the closed panel has its own floor at 615px, separate from the
      // open one at 951px — which turns both cases red.
      const tracks = () =>
        getComputedStyle(document.body).gridTemplateColumns.trim().split(/\s+/)
          .length;
      expect(
        tracks(),
        `${label} floor - 1: the shell did not stack (columns: ${getComputedStyle(document.body).gridTemplateColumns})`,
      ).toBe(2);
      expect(
        document.documentElement.scrollWidth,
        `${label} floor - 1: stacked and still overflowing`,
      ).toBeLessThanOrEqual(floor - 1);
    });
  }
});

/* The stacked layouts' vertical seams. They ride on the items rather than
   on `row-gap` since fix round 1 of 2026-10-07 (`header`, `#status` and
   `#dock` carry their own, and the stacked panel takes one on top), so
   each one is a declaration that could be dropped without the wide
   layout's checks noticing. These hold them where the rows stack. */
describe("the stacked layouts keep a seam between their rows", () => {
  const seam = () => length("--seam");
  const tracks = () =>
    getComputedStyle(document.body).gridTemplateColumns.trim().split(/\s+/);

  it("keeps the seams with the panel open, one pixel under its floor", async () => {
    await page.viewport(STACKED_FLOOR - 1, 800);
    const { rect } = mount("light");
    // The premise: it really stacked — two tracks, and the panel under the
    // dock rather than beside the stage.
    expect(tracks(), "the shell did not stack").toHaveLength(2);
    expect(rect("#inspector").top).toBeGreaterThanOrEqual(rect("#dock").bottom);
    expect(rect("#status").height, "a status row is showing").toBe(0);
    const head = rect("header").bottom;
    expect(rect("#stage").top - head, "header→stage").toBeCloseTo(seam(), 0);
    expect(rect("#rail").top - head, "header→rail").toBeCloseTo(seam(), 0);
    expect(rect("#dock").top - rect("main").bottom, "view→dock").toBeCloseTo(
      seam(),
      0,
    );
    expect(
      rect("#inspector").top - rect("#dock").bottom,
      "dock→panel",
    ).toBeCloseTo(seam(), 0);
  });

  it("keeps a seam either side of a status card, stacked with the panel open", async () => {
    await page.viewport(STACKED_FLOOR - 1, 800);
    const { rect } = mount("light", null, 40);
    expect(tracks(), "the shell did not stack").toHaveLength(2);
    const card = rect("[data-status-standin]");
    expect(card.height, "the status card is not drawn").toBeCloseTo(40, 0);
    expect(card.top - rect("header").bottom, "header→status").toBeCloseTo(
      seam(),
      0,
    );
    expect(rect("#stage").top - card.bottom, "status→stage").toBeCloseTo(
      seam(),
      0,
    );
    expect(rect("#rail").top - card.bottom, "status→rail").toBeCloseTo(
      seam(),
      0,
    );
  });

  it("keeps the seams with the panel closed, one pixel under its floor", async () => {
    await page.viewport(STACKED_CLOSED_FLOOR - 1, 700);
    const { rect, node } = mount("light");
    document.body.setAttribute("data-panel", "closed");
    // The premise: one content column beside the rail's track, and the
    // closed panel out of the flow altogether.
    const columns = tracks();
    expect(columns, "the shell did not stack").toHaveLength(2);
    expect(Number.parseFloat(columns[1] ?? "")).toBeCloseTo(
      length("--rail-w") + seam(),
      0,
    );
    expect(getComputedStyle(node("#inspector")).display).toBe("none");
    const head = rect("header").bottom;
    expect(rect("#stage").top - head, "header→stage").toBeCloseTo(seam(), 0);
    expect(rect("#rail").top - head, "header→rail").toBeCloseTo(seam(), 0);
    expect(rect("#dock").top - rect("main").bottom, "view→dock").toBeCloseTo(
      seam(),
      0,
    );
  });
});

describe("the reading order", () => {
  it("reaches the rail after the timeline and before the panel it opens", () => {
    mount("light");
    const order = [
      ...document.querySelectorAll<HTMLElement>(
        "main, #dock, #rail, #inspector",
      ),
    ].map((e) => e.id || e.tagName.toLowerCase());
    expect(order).toEqual(["main", "dock", "rail", "inspector"]);
  });
});

describe("the transport row", () => {
  for (const scheme of ["light", "dark"] as const) {
    /* The tool row speaks in glyphs since 2026-09-22, which makes its
       states pictures, and a picture claim is asked of the paint. */
    it(`paints Snap's two states apart, without the brand colour, in ${scheme}`, () => {
      const { node, surface, model } = mount(scheme);
      const snap = () => node(".snap");
      const rendered = (snapping: boolean) =>
        renderTimelineTools(
          node("#timeline-tools"),
          model,
          { snapping, viewport: fitAll(model.durationMs), positionMs: 0 },
          {
            onGesture: vi.fn(),
            onSnapping: vi.fn(),
            onViewport: vi.fn(),
            onSplit: vi.fn(),
          },
        );
      rendered(true);
      // Fixture guard: this really is the on state.
      expect(snap().getAttribute("aria-pressed")).toBe("true");
      const onFill = surface("#dock", ".snap");
      const onInk = parse(getComputedStyle(snap()).color);
      rendered(false);
      expect(snap().getAttribute("aria-pressed")).toBe("false");
      const offFill = surface("#dock", ".snap");
      const offInk = parse(getComputedStyle(snap()).color);
      // On is the filled disc, off is a bare glyph on the dock: an
      // indicator nothing painted until this date.
      expect(onFill, "Snap on paints no disc").not.toEqual(surface("#dock"));
      expect(offFill, "Snap off still paints a disc").toEqual(surface("#dock"));
      expect(onInk).toEqual(token("--ink"));
      expect(offInk).toEqual(token("--ink-muted"));
      expect(onInk, "Snap on is lit in the brand colour").not.toEqual(
        token("--accent"),
      );
    });

    it(`puts Add mask on the Mask lane and leaves the magnifiers bare in ${scheme}`, () => {
      const { node, surface } = mount(scheme);
      const add = node('[data-lane="mask"] [data-add-mask]');
      const glyph = node(
        '[data-lane="mask"] [data-add-mask] svg[data-icon="plus"]',
      );
      // Painted, not merely present: `.lane-head svg` would hand the plus
      // the header disc's 6px padding and leave it 2px wide.
      expect(glyph.checkVisibility(), "the + is not visible").toBe(true);
      expect(glyph.getBoundingClientRect().width).toBe(14);
      expect(
        getComputedStyle(glyph).paddingTop,
        "the + wears the header disc's padding",
      ).toBe("0px");
      const lane = add.closest('[data-lane="mask"]')?.getBoundingClientRect();
      const box = add.getBoundingClientRect();
      expect(
        lane !== undefined && box.top >= lane.top && box.bottom <= lane.bottom,
        `the + sits outside the Mask lane in ${scheme}`,
      ).toBe(true);
      // And it left the transport's tools.
      expect(
        node("#timeline-tools").querySelector("[data-add-mask]"),
        `#timeline-tools still holds Add mask in ${scheme}`,
      ).toBeNull();
      // The magnifiers are the slider's ends, not buttons of their own.
      for (const dir of ["out", "in"]) {
        expect(
          surface("#dock", `[data-zoom-step="${dir}"]`),
          `the zoom-${dir} magnifier paints a disc at rest in ${scheme}`,
        ).toEqual(surface("#dock"));
      }
    });

    /* The three groups share ONE row, and nothing asserted that until the
       author saw the media buttons sitting under the tools instead of
       beside them.

       Every item carries an explicit `grid-column`, which reads as
       sufficient and is not. CSS Grid §8.5's placement cursor is shared
       and never moves backwards. When this was found, DOM order was author
       (column 1), view (column 3), then `.transport-controls` (column 2),
       which `renderTransport` appends after the static markup; the cursor
       reached column 4 before meeting an item asking for column 2, and a
       column behind the cursor costs a NEW ROW — so the controls dropped
       to row 2 with a green suite, because the centring test measures
       horizontal centres and the split test measures left and right.
       Neither can see a vertical break. Since 2026-10-07 both groups sit
       in `.transport-end` (column 3), still ahead of the controls in DOM
       order, so the hazard is the same.

       Asserted on centres rather than on `top`: the groups are different
       heights (a 22px icon button beside 28px pills), so equal tops would
       be the wrong claim and equal centres is what "aligned with them"
       means. */
    it(`keeps the tools on one row with the media buttons in ${scheme}`, async () => {
      await page.viewport(1440, 860);
      const { rect } = mount(scheme);
      const view = rect('[data-timeline-tools="view"]');
      const controls = rect("[data-transport-controls]");
      // Fixture guard: zero-height groups share every row trivially.
      expect(view.height, "the view group rendered nothing").toBeGreaterThan(8);
      const middle = (r: DOMRect) => r.top + r.height / 2;
      expect(
        middle(view),
        `the Snap/Fit group is centred at ${middle(view)} and the media buttons at ${middle(controls)} in ${scheme}`,
      ).toBeCloseTo(middle(controls), 0);
      // The picture's controls, in the same group since 2026-10-07.
      const stageActions = rect("#stage-tools [data-stage-actions]");
      expect(
        stageActions.height,
        "the picture's controls rendered nothing",
      ).toBeGreaterThan(8);
      expect(
        middle(stageActions),
        `the picture's controls are centred at ${middle(stageActions)} and the media buttons at ${middle(controls)} in ${scheme}`,
      ).toBeCloseTo(middle(controls), 0);
    });

    /* The controls are centred on the dock. `#transport` is a three-column
       GRID — `1fr auto minmax(max-content, 1fr)` since the final review of
       2026-10-07 — with the picture's clock in column 1 (`#toolbar-clock`),
       the shuttle cluster, `.transport-controls`, in `grid-column: 2`, and
       one group on the right: `.transport-end`, the picture's own controls
       (`#stage-tools`) beside the timeline's tools (`#timeline-tools`).

       The centring is structural while each side fits its share: two
       tracks given the SAME `fr` value receive an equal share of the row's
       leftover space regardless of what is inside them. Each side's
       minimum is the deliberate exception — the clock's width on the left,
       the group's `max-content` on the right — where the cluster gives up
       centring before anything overlaps or clips (see "the toolbar's clock
       clears the shuttle cluster"), so this is asserted at 1440, where both
       are well under their half.

       What makes the headline non-trivial is the premise below: the two
       sides do NOT carry equal content — the clock on the left, the whole
       end group on the right, several times wider — and the centre holds
       anyway, which is the equal-`fr` mechanism doing the work rather than
       two sides that happen to match.

       The badge-nesting half is unchanged: `.rate` is `position:
       absolute`, so it was never a grid item, and its containing block is
       still `.transport-controls` (`relative`). */
    it(`centres the controls on the dock in ${scheme}`, async () => {
      await page.viewport(1440, 860);
      const { rect, node } = mount(scheme, null, 0, null, undefined, {
        playing: true,
        rate: 4,
      });
      const controls = rect("[data-transport-controls]");
      const dock = rect("#dock");
      const middle = (r: DOMRect) => r.left + r.width / 2;
      expect(
        Math.abs(middle(controls) - middle(dock)),
        `the controls are centred at ${middle(controls)} and the dock at ${middle(dock)} in ${scheme}; tracks ${getComputedStyle(node("#transport")).gridTemplateColumns}`,
      ).toBeLessThan(1);
      // Fixture guard: an empty `.transport-controls` centres exactly as
      // well as a full one — the item's own width never enters the
      // calculation — so the assertion above says nothing about a real
      // render on its own; this confirms the shuttle cluster actually
      // rendered rather than an empty row.
      expect(
        controls.width,
        "transport-controls rendered no content",
      ).toBeGreaterThan(80);
      // The premise: the sides are unequal. The right carries the end
      // group, the left only the clock, and the group is more than twice
      // the clock's width.
      const end = rect("#transport .transport-end");
      const clock = rect("#toolbar-clock [data-transport-time]");
      expect(clock.width, "the clock rendered nothing").toBeGreaterThan(40);
      expect(
        end.width,
        `the end group is ${end.width}px and the clock ${clock.width}px`,
      ).toBeGreaterThan(clock.width * 2);
      // The split itself: the clock on the LEFT of the cluster and the
      // picture's and the timeline's tools on its RIGHT. Swapping the
      // columns leaves the centring green while putting the groups on the
      // wrong sides.
      expect(clock.right).toBeLessThanOrEqual(controls.left);
      expect(end.left).toBeGreaterThanOrEqual(controls.right);
      expect(rect('[data-timeline-tools="view"]').left).toBeGreaterThanOrEqual(
        controls.right,
      );
      // A different invariant, not a second reading of the headline above
      // (see the docblock): the badge has to stay nested inside
      // `.transport-controls`, or it anchors against the wrong positioned
      // ancestor and drifts away from the shuttle button it sits beside.
      const controlsEl = node("[data-transport-controls]");
      const badge = node("[data-transport-rate]");
      expect(badge.parentElement).toBe(controlsEl);
      expect(
        badge.hidden,
        "the rate badge is hidden, so its width below says nothing",
      ).toBe(false);
      expect(badge.getBoundingClientRect().width).toBeGreaterThan(10);
    });

    /* The speed rides beside the button that is running, and showing it
       must not move the controls off the centre they are pinned to — which
       is the entire reason it is positioned out of flow. Both halves
       asserted together: a badge that sits in the right place while shoving
       the cluster sideways is the bug this shape exists to avoid, and the
       centring test above never sees it because it runs at 1x. */
    it(`puts the speed beside the button that is running in ${scheme}`, async () => {
      await page.viewport(1440, 860);
      const { rect, node } = mount(scheme);
      const middle = () => {
        const r = rect("[data-transport-controls]");
        return r.left + r.width / 2;
      };
      const atRest = middle();
      const shuttle = (rate: number) =>
        renderTransport(
          node("#transport"),
          {
            authored: false,
            playing: true,
            enabled: true,
            rate,
            looping: false,
          },
          {
            onToggle: vi.fn(),
            onShuttle: vi.fn(),
            onLooping: vi.fn(),
            onSkipToStart: vi.fn(),
          },
        );

      shuttle(-4);
      const badge = node("[data-transport-rate]");
      expect(badge.textContent).toBe("4x");
      expect(badge.hidden).toBe(false);
      // Left of rewind, which is the leftmost control.
      expect(
        badge.getBoundingClientRect().right,
        `the 4x badge is at ${badge.getBoundingClientRect().right} and rewind starts at ${rect('[data-transport-shuttle="-1"]').left}`,
      ).toBeLessThanOrEqual(rect('[data-transport-shuttle="-1"]').left);
      expect(middle()).toBeCloseTo(atRest, 0);

      shuttle(4);
      // Right of fast-forward, which is the rightmost control.
      expect(
        node("[data-transport-rate]").getBoundingClientRect().left,
      ).toBeGreaterThanOrEqual(rect('[data-transport-shuttle="1"]').right);
      expect(middle()).toBeCloseTo(atRest, 0);

      // And nothing at plain speed, or every ordinary playback would carry
      // a "1x" that says nothing.
      shuttle(1);
      expect(node("[data-transport-rate]").hidden).toBe(true);
      expect(middle()).toBeCloseTo(atRest, 0);
    });

    /* The transport lights exactly one of its three controls, and it is
       the one driving the picture. Asserted as a colour CHANGE against the
       resting ink rather than against a hard-coded hex, because `--accent`
       resolves to a dark green in light and to lime in dark — a literal
       would pin one theme and silently pass the other.

       This comment used to say "exactly one control" on the PAGE. Every
       assertion below is scoped to the three transport buttons, so that
       wider claim was never checked, and on 2026-09-21 it quietly stopped
       being true: the rail's open entry carries the brand lime. The claim
       is narrowed to what this case measures, and the page-wide half is
       asserted separately below, where the sanctioned carriers are named. */
    it(`lights only the running control, in the brand colour in ${scheme}`, async () => {
      await page.viewport(1440, 860);
      const { node } = mount(scheme);
      const back = '[data-transport-shuttle="-1"]';
      const fwd = '[data-transport-shuttle="1"]';
      const play = "[data-transport-play]";
      const resting = getComputedStyle(node(back)).color;
      const lit = (sel: string) => node(sel).hasAttribute("data-active");
      const shuttle = (rate: number, playing = true) =>
        renderTransport(
          node("#transport"),
          { authored: false, playing, enabled: true, rate, looping: false },
          {
            onToggle: vi.fn(),
            onShuttle: vi.fn(),
            onLooping: vi.fn(),
            onSkipToStart: vi.fn(),
          },
        );

      shuttle(1);
      expect([lit(back), lit(play), lit(fwd)]).toEqual([false, true, false]);
      shuttle(-2);
      expect([lit(back), lit(play), lit(fwd)]).toEqual([true, false, false]);
      // The lit one is actually painted differently, not just marked.
      expect(getComputedStyle(node(back)).color).not.toBe(resting);
      expect(parse(getComputedStyle(node(back)).color)).toEqual(
        token("--accent"),
      );
      shuttle(2);
      expect([lit(back), lit(play), lit(fwd)]).toEqual([false, false, true]);
      // Paused, nothing is running, so nothing is lit.
      shuttle(1, false);
      expect([lit(back), lit(play), lit(fwd)]).toEqual([false, false, false]);
      expect(getComputedStyle(node(back)).color).toBe(resting);
    });

    /* The page-wide half of the claim above, which nothing checked while
       it was only a comment.

       The brand colour is a signal, and a signal spent in several places
       stops being one. Three carriers are sanctioned: the repeat toggle,
       the speed badge that rides beside the shuttles (part of the same
       "this is running" signal — `.rate` is `var(--accent)` deliberately,
       see its rule), and the rail entry whose panel is open. A running
       shuttle is a fourth when one runs (see "lights only the running
       control"); this mount plays at 1x, so none does. This walks every
       element the shell paints and fails on anything else.

       Play left the list in the final review of 2026-10-07. It was a
       carrier while playing, and lime on the dark theme's #ececf1 disc is
       about 1.15:1 — a glyph that vanished exactly when it was running.
       Its ink is `--secondary-ink` in every state now (see "keeps play's
       glyph on its disc"), so this mount, which IS playing, has to find
       it among the "no others".

       The badge was found BY this assertion on the first run, which is the
       argument for having written it: the comment above claimed one
       carrier, the real number was two before the rail joined, and nobody
       had counted. Written as a list of SANCTIONED selectors rather than a
       bare count, so a failure names the element that took the colour
       rather than reporting that some number went up. */
    it(`spends the brand colour on three controls and no others in ${scheme}`, async () => {
      await page.viewport(1440, 860);
      const { node } = mount(scheme);
      // Playing AND repeating. Repeating, so the toggle — the one control
      // here reporting a MODE rather than a direction — is genuinely lit,
      // which the fixture guard further down requires. Playing at 1x, so
      // Play is marked running (asserted below): the state in which it
      // used to spend the colour, and must not now.
      //
      // The badge shows only while shuttling, so a 1x mount leaves it
      // empty and hidden — and an empty element still has a computed
      // `color`, which is what this walk reads. It is counted as a carrier
      // here by its rule, not by being on screen.
      renderTransport(
        node("#transport"),
        {
          authored: false,
          playing: true,
          enabled: true,
          rate: 1,
          looping: true,
        },
        {
          onToggle: vi.fn(),
          onShuttle: vi.fn(),
          onLooping: vi.fn(),
          onSkipToStart: vi.fn(),
        },
      );
      // The rail's lit entry is the fourth carrier. Export used to be the
      // one `mount` pressed, but its door is the header's button since
      // 2026-10-07 and the rail draws no Export entry, so Background is
      // pressed here instead. `#export-open` is a primary — a lime FILL
      // with dark ink — so it is no carrier of lime INK, which is what this
      // counts.
      //
      // Re-derived when the rail became a card (2026-10-07): the rail's
      // entry now spends `var(--accent)` like the transport's carriers
      // rather than the fixed `#cdeb45` it wore on footage — so
      // in light it is the olive accent, not the lime literal. `LIME` is
      // kept in the match below as a guard: no rule in the editor's sheet
      // spends that literal now, and one that started to would be counted.
      renderRail(
        node("#rail"),
        { rail: "background", panelOpen: true, hasSelection: false },
        { onPick: vi.fn() },
      );
      const accent = token("--accent");
      const LIME = parse("rgb(205, 235, 69)");
      // The premise Play's absence from the list rests on: it IS the
      // running control in this mount. Without the mark, "Play is not
      // lime" would hold for the trivial reason that nothing asked it to be.
      expect(
        node("[data-transport-play]").hasAttribute("data-active"),
        "play is not marked running, so its absence below proves nothing",
      ).toBe(true);
      const sanctioned = [
        "[data-transport-repeat]",
        "[data-transport-rate]",
        '#rail [data-rail="background"]',
      ];
      const carriers: string[] = [];
      for (const el of document.querySelectorAll<HTMLElement>("body *")) {
        const ink = parse(getComputedStyle(el).color);
        const brand =
          JSON.stringify(ink) === JSON.stringify(accent) ||
          JSON.stringify(ink) === JSON.stringify(LIME);
        // Ink is inherited, so a lit control's children report it too. The
        // carrier is the outermost element holding it.
        if (!brand) continue;
        const parentInk = el.parentElement
          ? parse(getComputedStyle(el.parentElement).color)
          : null;
        if (parentInk && JSON.stringify(parentInk) === JSON.stringify(ink)) {
          continue;
        }
        carriers.push(
          el.id ? `#${el.id}` : `${el.tagName.toLowerCase()}.${el.className}`,
        );
      }
      // Fixture guard: every sanctioned control has to actually be lit in
      // this mount, or "no others" is satisfied by a page carrying the
      // colour nowhere at all.
      for (const sel of sanctioned) {
        expect(
          parse(getComputedStyle(node(sel)).color),
          `${sel} is not lit in this mount, so the case below asserts nothing`,
        ).not.toEqual(parse(getComputedStyle(node("#dock")).color));
      }
      expect(
        carriers.length,
        `the brand colour is on ${carriers.length} elements: ${carriers.join(", ")}`,
      ).toBe(sanctioned.length);
    });

    /* No words and no pill: neutral glyphs floating over the picture. The
       fill is what "floating" rules out, so it is the fill that is
       asserted — a control that kept `btn-primary` would still carry no
       text and still sit in the right place.

       Play is the deliberate exception since 2026-09-21 and is checked as
       one below: it is the row's primary and the only filled control in
       it, which is what the reference mockup's white disc says. */
    it(`draws the controls as neutral icon buttons in ${scheme}`, async () => {
      await page.viewport(1440, 860);
      const { node } = mount(scheme);
      const buttons = [
        ...node("[data-transport-controls]").querySelectorAll<HTMLElement>(
          "button:not([data-transport-play])",
        ),
      ];
      // Jump to start, rewind, fast forward and repeat.
      expect(buttons).toHaveLength(4);
      for (const button of buttons) {
        const style = getComputedStyle(button);
        expect(
          parse(style.backgroundColor)[3],
          `${button.getAttribute("aria-label")} is filled, not floating`,
        ).toBe(0);
        expect(button.textContent).toBe("");
        expect(button.querySelector("svg")).not.toBeNull();
        // The name has to survive the words going.
        expect(button.getAttribute("aria-label")).toBeTruthy();
      }
    });

    /* The repeat toggle says its state three ways, and is checked on all
     * three: the accent on the glyph, the lit pip beneath it, and
     * `aria-pressed`. Colour alone is a hue difference — the one difference
     * a red-green reader does not get — so the pip is not decoration, and a
     * pip that never changed opacity would leave the button reporting its
     * state to exactly the readers who can already see the accent. */
    it(`lights the repeat toggle three ways in ${scheme}`, async () => {
      await page.viewport(1440, 860);
      const { node } = mount(scheme);
      const draw = (looping: boolean) =>
        renderTransport(
          node("#transport"),
          { authored: false, playing: false, enabled: true, rate: 1, looping },
          {
            onToggle: vi.fn(),
            onShuttle: vi.fn(),
            onLooping: vi.fn(),
            onSkipToStart: vi.fn(),
          },
        );
      const button = () => node("[data-transport-repeat]");
      const pip = () => node("[data-transport-repeat] .transport-pip");

      // Off, first — the control this case rests on. Either state alone
      // passes against a button whose paint never changes.
      draw(false);
      const restingInk = getComputedStyle(button()).color;
      expect(parse(restingInk)).not.toEqual(token("--accent"));
      expect(Number(getComputedStyle(pip()).opacity)).toBe(0);
      expect(button().getAttribute("aria-pressed")).toBe("false");
      const restingBox = button().getBoundingClientRect();

      draw(true);
      expect(parse(getComputedStyle(button()).color)).toEqual(
        token("--accent"),
      );
      expect(Number(getComputedStyle(pip()).opacity)).toBe(1);
      expect(button().getAttribute("aria-pressed")).toBe("true");
      // And switching it on did not resize the button: the pip is laid out
      // whether or not it is drawn, so the cluster cannot shift sideways
      // off the centre column it is pinned to.
      const litBox = button().getBoundingClientRect();
      expect(litBox.width).toBe(restingBox.width);
      expect(litBox.left).toBe(restingBox.left);
    });

    /* Play is the primary by SIZE, SHAPE and INK.
     *
     * The reference mockup draws a white disc on a black timeline; here the
     * disc is the shell's `--secondary`, the ink of the primary button of
     * the theme (near-black in light, near-white in dark), so it is the one
     * solid disc in the row. Not the lime: the brand colour stays on the
     * controls that report a state (see "spends the brand colour"). It is
     * also a circle and bigger than everything beside it. */
    it(`makes play the biggest control in the row, and round, in ${scheme}`, async () => {
      await page.viewport(1440, 860);
      const { node, surface, rect } = mount(scheme);
      const play = node("[data-transport-play]");
      const box = rect("[data-transport-play]");
      // A circle, not a pill: `border-radius: 50%` resolves against the
      // box, so the box has to be square for it to draw round. Chrome
      // computes the used value in px, so this is half the side rather
      // than the literal "50%".
      expect(box.width).toBe(box.height);
      expect(
        Number.parseFloat(getComputedStyle(play).borderTopLeftRadius),
      ).toBeGreaterThanOrEqual(box.height / 2);
      // Bigger than its neighbours — the thing that says "primary" here.
      const rewind = rect('[data-transport-shuttle="-1"]');
      // Fixture guard: the shuttle buttons have a size of their own, so
      // "bigger" is a comparison rather than a number beating zero.
      expect(rewind.width).toBeGreaterThan(0);
      expect(box.width).toBeGreaterThan(rewind.width);
      // The ink disc, and a glyph that reads on it. Asserted as the token
      // composited over the dock rather than as a literal colour, which
      // would pin one theme.
      const disc = surface("#dock", "[data-transport-play]");
      expect(disc).toEqual(over(token("--secondary"), surface("#dock")));
      expect(
        contrast(parse(getComputedStyle(play).color), disc),
        `the play glyph does not read on its own disc in ${scheme}`,
      ).toBeGreaterThanOrEqual(4.5);
    });

    /* The glyph has to stay on its disc in every state the disc has, not
       only at rest. Until the final review of 2026-10-07 it did not: the
       transport's generic hover rule (`--ink`, three classes) out-ranked
       Play's own, so hovering drew near-black ink on the light theme's
       near-black hover disc (about 1.2:1) and near-white on the dark one's
       white; and the generic `[data-active]` rule lit the glyph lime
       while playing, which on the dark theme's #ececf1 disc is about
       1.15:1. Play's glyph is `--secondary-ink` in all three states now —
       "running" is said by the play/pause glyph swap, not by the brand
       colour.

       A real pointer, not a class or a synthetic event: `:hover` is what
       broke, and only the browser's own hit-testing sets it. Each state's
       premise is asserted beside its contrast — the disc really is the
       hover tone while hovered, and the button really is marked active
       while playing — or a hover that never landed would measure the rest
       state twice. */
    it(`keeps play's glyph on its disc at rest, hovered and playing in ${scheme}`, async () => {
      await page.viewport(1440, 860);
      const { node, surface } = mount(scheme);
      const play = () => node("[data-transport-play]");
      const draw = (playing: boolean) =>
        renderTransport(
          node("#transport"),
          { authored: false, playing, enabled: true, rate: 1, looping: false },
          {
            onToggle: vi.fn(),
            onShuttle: vi.fn(),
            onLooping: vi.fn(),
            onSkipToStart: vi.fn(),
          },
        );
      const restDisc = over(token("--secondary"), surface("#dock"));
      const hoverDisc = over(token("--secondary-hover"), surface("#dock"));
      // Premise: the two discs differ, or "really hovered" below could not
      // be told from "still at rest".
      expect(hoverDisc).not.toEqual(restDisc);
      const glyphOnDisc = () =>
        contrast(
          parse(getComputedStyle(play()).color),
          surface("#dock", "[data-transport-play]"),
        );

      // At rest, with the pointer parked on the header, away from the row.
      await userEvent.hover(document.querySelector("header") as HTMLElement);
      await vi.waitFor(() =>
        expect(surface("#dock", "[data-transport-play]")).toEqual(restDisc),
      );
      expect(
        glyphOnDisc(),
        `play's glyph at rest is ${getComputedStyle(play()).color} on its disc in ${scheme}`,
      ).toBeGreaterThanOrEqual(3);

      // Hovered. The disc's background transitions (`.btn`, 120ms), so the
      // wait is on the disc reaching the hover tone; the glyph's colour
      // does not transition.
      await userEvent.hover(play());
      await vi.waitFor(() =>
        expect(
          surface("#dock", "[data-transport-play]"),
          "the pointer is on play but its disc is not the hover tone",
        ).toEqual(hoverDisc),
      );
      expect(
        glyphOnDisc(),
        `play's glyph under the pointer is ${getComputedStyle(play()).color} on its hover disc in ${scheme}`,
      ).toBeGreaterThanOrEqual(3);

      // Playing, with the pointer away again.
      draw(true);
      await userEvent.hover(document.querySelector("header") as HTMLElement);
      expect(
        play().hasAttribute("data-active"),
        "play is not marked as the running control, so this state is the rest state again",
      ).toBe(true);
      await vi.waitFor(() =>
        expect(surface("#dock", "[data-transport-play]")).toEqual(restDisc),
      );
      expect(
        glyphOnDisc(),
        `play's glyph while playing is ${getComputedStyle(play()).color} on its disc in ${scheme}`,
      ).toBeGreaterThanOrEqual(3);

      // Playing AND hovered: both rules at once.
      await userEvent.hover(play());
      await vi.waitFor(() =>
        expect(surface("#dock", "[data-transport-play]")).toEqual(hoverDisc),
      );
      expect(
        glyphOnDisc(),
        `play's glyph while playing and hovered is ${getComputedStyle(play()).color} in ${scheme}`,
      ).toBeGreaterThanOrEqual(3);
    });
  }
});

/* The transport sits between the dock card's top edge and the divider over
   the ruler (`.lanes::before`), and reads as centred only if the play disc
   — the row's tallest mark — has the same room on both sides. It had 16px
   above and 12px below until 2026-10-08. */
describe("the transport is centred between the card's edge and the divider", () => {
  for (const scheme of ["light", "dark"] as const) {
    it(`gives the play disc equal room above and below in ${scheme}`, () => {
      const { node, rect } = mount(scheme);
      const play = rect("[data-transport-play]");
      // Fixture guard: the disc is the tallest thing on the row, or a
      // taller control would be what the eye measures from instead.
      const tallest = Math.max(
        ...[...node("#transport").querySelectorAll("button, .segment")].map(
          (el) => el.getBoundingClientRect().height,
        ),
      );
      expect(play.height, "the play disc is not the row's tallest mark").toBe(
        tallest,
      );
      // And the divider is there to measure to: it is the top of `.lanes`.
      const divider = getComputedStyle(node(".lanes"), "::before");
      expect(divider.height, "no divider over the ruler").toBe("1px");
      const above = play.top - rect("#dock").top;
      const below = rect(".lanes").top - play.bottom;
      expect(
        Math.abs(above - below),
        `${above}px above the play disc, ${below}px below it in ${scheme}`,
      ).toBeLessThan(0.5);
    });
  }
});

/* The toolbar's clock keeps its distance from the shuttle cluster at every
   width the dock is given.

   Found in the final review of 2026-10-07: the clock was out of flow
   (`position: absolute; left: 0`) over an EMPTY first column, so nothing
   reserved its width, and the right column's `max-content` floor took
   every pixel the row lost out of the left. Between roughly 821 and 921px
   of window — panel closed, or stacked open — the cluster slid left under
   the clock, and a ten-minute take's longer readout lost its clearance
   even at the 952px floor.

   Measured at the windows that bracket it: the working size, the open
   floor, inside the old overlap band with the panel closed, the stacked
   layout one pixel under the open floor, and the closed floor's stacked
   side, where the right-hand group wraps to a second row and the clock
   has to stay on the first.

   The gap is asserted between the painted boxes, and the right-hand group
   is held to the row as well: a clock that bought its clearance by pushing
   the group out of the dock's right edge would have traded one overlap
   for a clip. */
/* The clock heads the dock's left edge, over the track headers, and
   reads as aligned with them only if its first digit starts where their
   glyphs do — not at their grey discs' outer edge, which is fainter than
   the coloured glyph on it (2026-10-08). And it is in the UI's own face,
   set tabular like the ruler's labels below it. */
describe("the toolbar's clock lines up with the track glyphs", () => {
  for (const scheme of ["light", "dark"] as const) {
    it(`starts its first digit over the glyphs, in Manrope, in ${scheme}`, () => {
      const { node } = mount(scheme);
      const clock = node("#toolbar-clock [data-transport-time]");
      // Fixture guard: a clock with text, starting with a digit, or there
      // is no first digit to place.
      expect(clock.textContent, "the clock rendered no time").toMatch(/^\d/);
      const range = document.createRange();
      range.selectNodeContents(clock);
      const text = range.getBoundingClientRect();
      const glyphs = [
        ...document.querySelectorAll<SVGElement>(".lane-glyph > svg"),
      ];
      // Fixture guard: the three track headers are there to align with.
      expect(glyphs.length, "no track headers rendered").toBe(3);
      for (const svg of glyphs) {
        const disc = svg.getBoundingClientRect();
        const glyphLeft =
          disc.left + Number.parseFloat(getComputedStyle(svg).paddingLeft);
        // Positive control: the glyph really is inset in its disc, or the
        // disc's edge and the glyph's are one line and this asks nothing
        // the old layout did not already satisfy.
        expect(glyphLeft - disc.left).toBeGreaterThan(2);
        expect(
          Math.abs(text.left - glyphLeft),
          `clock text at ${text.left}, glyph at ${glyphLeft}, disc at ${disc.left} in ${scheme}`,
        ).toBeLessThan(0.5);
      }
      const style = getComputedStyle(clock);
      expect(style.fontFamily, "the clock is not in Manrope").toMatch(
        /^Manrope\b/,
      );
      expect(style.fontVariantNumeric).toBe("tabular-nums");
    });
  }
});

describe("the toolbar's clock clears the shuttle cluster", () => {
  const CASES: [
    width: number,
    height: number,
    panel: "open" | "closed",
    wrapped: boolean,
  ][] = [
    [1440, 860, "open", false],
    [952, 800, "open", false],
    [900, 800, "closed", false],
    // Inside the band as this machine measured it (the right-hand group
    // is 496px here): one row with the clock under the cluster before the
    // fix, and wrapped since — the one-row toolbar needs more than this
    // window's 800px of dock once the clock's width is reserved.
    [860, 800, "closed", true],
    [951, 800, "open", false],
    [615, 700, "closed", true],
  ];
  for (const [width, height, panel, wrapped] of CASES) {
    it(`at ${width}x${height} with the panel ${panel}`, async () => {
      await page.viewport(width, height);
      const { rect, node } = mount(
        "light",
        null,
        0,
        null,
        undefined,
        undefined,
        null,
        null,
        { positionMs: 600_000, durationMs: 720_000 },
      );
      if (panel === "closed") {
        document.body.setAttribute("data-panel", "closed");
        await vi.waitFor(() => {
          if (rect("#inspector").width !== 0) {
            throw new Error(
              `panel still closing: #inspector is ${rect("#inspector").width}px wide`,
            );
          }
        });
      }
      const clockEl = node("#transport [data-transport-time]");
      // Premise: the long readout, the one the band was found with. The
      // two-minute default would clear where this one does not.
      expect(clockEl.textContent).toBe("10:00 / 12:00");
      expect(
        clockEl.checkVisibility(),
        "the toolbar clock is not painted",
      ).toBe(true);
      const clock = clockEl.getBoundingClientRect();
      const cluster = rect("[data-transport-controls]");
      const end = rect("#transport .transport-end");
      const row = rect("#transport");
      // Fixture guard: both boxes have a size, or "no overlap" is free.
      expect(clock.width, "the clock rendered nothing").toBeGreaterThan(40);
      expect(cluster.width, "the cluster rendered nothing").toBeGreaterThan(80);
      // Premise: the layout this window is meant to exercise. Wrapped, the
      // right-hand group sits on a row of its own under the cluster; one
      // row, it shares the cluster's.
      const layout = `clock ${clock.left}–${clock.right}, cluster ${cluster.left}–${cluster.right} (top ${cluster.top}), end ${end.left}–${end.right} (top ${end.top}), row ${row.left}–${row.right}; tracks ${getComputedStyle(node("#transport")).gridTemplateColumns}`;
      // The headline: 8px or more between the clock and the cluster.
      expect(
        cluster.left - clock.right,
        `the clock runs into the shuttle cluster: ${layout}`,
      ).toBeGreaterThanOrEqual(8);
      if (wrapped) {
        expect(
          end.top,
          `the end group did not wrap: ${layout}`,
        ).toBeGreaterThanOrEqual(cluster.bottom);
      } else {
        expect(end.top, `the end group wrapped: ${layout}`).toBeLessThan(
          cluster.bottom,
        );
      }
      // The clock on the first row, at the row's left edge.
      expect(
        clock.top,
        `the clock is not on the cluster's row: ${layout}`,
      ).toBeLessThan(cluster.bottom);
      expect(
        clock.left - row.left,
        `the clock left the row's left edge: ${layout}`,
      ).toBeCloseTo(0, 0);
      // On one row, the right-hand group keeps its own distance from the
      // cluster, and stays inside the row rather than running off it.
      if (!wrapped) {
        expect(
          end.left - cluster.right,
          `the right-hand group runs into the cluster: ${layout}`,
        ).toBeGreaterThanOrEqual(8);
      }
      // Against the DOCK's content edge, not `#transport`'s: a row too
      // wide for the dock widens `#transport` with it (measured: 840px of
      // row in an 800px dock), so the row's own edge moves with the
      // overflow and could never catch it.
      const dock = node("#dock");
      const dockInner =
        dock.getBoundingClientRect().right -
        Number.parseFloat(getComputedStyle(dock).paddingRight);
      expect(
        end.right,
        `the right-hand group runs off the dock (content edge ${dockInner}): ${layout}`,
      ).toBeLessThanOrEqual(dockInner + 0.5);
    });
  }
});

/* The toolbar's DOM order is its Tab order, so it has to be the order the
   row is read in: the clock, the shuttle cluster, then the picture's and
   the timeline's tools. `renderTransport` appended the cluster after the
   static right-hand group until the final review of 2026-10-07, so Tab
   went from the zoom slider back to Jump to start. Mounted on the shipped
   markup, because the order is half markup (the clock's slot and the end
   group) and half `renderTransport` (where it puts the cluster). */
describe("the toolbar reads in order", () => {
  it("puts the clock, the cluster and the tools in DOM order", async () => {
    await page.viewport(1440, 860);
    const { node } = mount("light");
    const children = [...node("#transport").children].map((el) =>
      el.id ? `#${el.id}` : `.${el.classList[0]}`,
    );
    expect(children).toEqual([
      "#toolbar-clock",
      ".transport-controls",
      ".transport-end",
    ]);
    // And the focusable controls follow it: the first focusable in the
    // row is the cluster's Jump to start, and every one of the cluster's
    // buttons comes before the first of the end group's.
    const focusables = [
      ...node("#transport").querySelectorAll<HTMLElement>(
        "button, input, select",
      ),
    ];
    // Premise: both groups have focusables, or the order is vacuous.
    const inCluster = (el: HTMLElement) =>
      el.closest("[data-transport-controls]") !== null;
    expect(focusables.filter(inCluster).length).toBe(5);
    expect(
      focusables.filter((el) => el.closest(".transport-end")).length,
    ).toBeGreaterThan(3);
    const lastCluster = focusables.findLastIndex(inCluster);
    const firstEnd = focusables.findIndex(
      (el) => el.closest(".transport-end") !== null,
    );
    expect(
      lastCluster,
      `tab order: ${focusables.map((el) => el.getAttribute("aria-label") ?? el.textContent).join(" → ")}`,
    ).toBeLessThan(firstEnd);
    expect(focusables[0]?.hasAttribute("data-transport-skip")).toBe(true);
  });
});

type MaskRect = { x: number; y: number; width: number; height: number };

/** The two shapes the stage's aspect toggle puts on the canvas — the
 *  landscape cut and the portrait one — each with the mask rect that
 *  format's crop can actually see. */
const OVERLAY_TARGETS: ReadonlyArray<
  [string, RenderTarget, MaskRect | undefined]
> = [
  ["landscape", previewTarget(LANDSCAPE_1080P), undefined],
  ["vertical", previewTarget(VERTICAL_1080), VERTICAL_MASK_RECT],
];

/* The picture on the ground: `#stage` paints nothing since 2026-10-07 (it
   was a `--stage-bed` well before that), so the frame sits on the page's
   own ground and the ring is what edges it — and nothing sits on it
   outside full screen: its controls are in the timeline toolbar. */
describe("the picture carries no controls", () => {
  for (const scheme of ["light", "dark"] as const) {
    /* The ring used to be on `#preview`, whose element box is the WHOLE
       stage under `object-fit: contain` — so it drew a rectangle around
       the letterbox and never around the picture. `#stage-frame` is the
       drawn box as an element, so the ring traces what it claims to. */
    it(`rings the picture rather than the stage in ${scheme}`, async () => {
      await page.viewport(1440, 860);
      const { rect, node } = mount(scheme);
      const frame = rect("#stage-frame");
      const stage = rect("#stage");
      // Fixture guard: this says nothing unless the frame is genuinely
      // letterboxed inside the stage. A frame that filled the stage would
      // satisfy "the ring is on the frame" and "the ring is on the stage"
      // at the same time.
      //
      // At 1440x860 the stage is WIDER than 16:9 — asserted, not assumed —
      // so `min(100cqw, calc(100cqh * ratio))` is height-bound and the
      // letterbox lands on the sides, not top/bottom: a `stage.height -
      // frame.height` check alone reads 0 here and would fail even for a
      // correctly letterboxed frame. Either axis having margin is the real
      // claim; which one carries it depends on the stage's own aspect at
      // the viewport under test.
      expect(
        stage.width / stage.height,
        `the stage is ${stage.width}x${stage.height}, not wider than 16:9`,
      ).toBeGreaterThan(16 / 9);
      expect(
        stage.width - frame.width > 8 || stage.height - frame.height > 8,
        `frame ${frame.width}x${frame.height} in a ${stage.width}x${stage.height} stage`,
      ).toBe(true);
      expect(frame.width / frame.height).toBeCloseTo(16 / 9, 1);
      // The ring itself, not just the frame it traces: `#stage-frame`
      // carries `box-shadow: inset 0 0 0 1px var(--ring)` (moved here from
      // `#preview` on 2026-09-21). `parse` finds the `rgba(...)` inside the
      // full computed shadow string, so this checks the ring's actual
      // colour against the token rather than merely that some shadow
      // exists.
      const shadow = getComputedStyle(node("#stage-frame")).boxShadow;
      expect(shadow).not.toBe("none");
      expect(parse(shadow)).toEqual(token("--ring"));
    });

    /* The picture's controls left it on 2026-10-07 (spec 2026-10-06,
       "Full screen"): the clock, the shape switch, the zoom chip and the
       full-screen button are in the timeline toolbar — the clock in
       `#toolbar-clock`, the grid's first column since the final review of
       2026-10-07, and the rest in `#stage-tools` — and `#stage-bar`, the
       same controls floating on the picture, is
       shown only while `#stage` is full screen, where the dock is not
       painted. The four tests that measured the floating row outside full
       screen (the clock on the picture, a press through its gap, its inset
       from the picture's edges, its end on the stage's inner edge) went
       with it. */
    it(`puts no control on the picture outside full screen in ${scheme}`, async () => {
      await page.viewport(1440, 860);
      const { node, rect } = mount(scheme);
      const frame = rect("#stage-frame");
      // The premise: there is a picture to overlap.
      expect(frame.width).toBeGreaterThan(200);
      // What `main.ts`'s ResizeObserver publishes, taken off the same
      // boxes. Without it the floating row spans the whole stage, and at
      // this window its controls land in the letterbox either side of the
      // picture — so a row left showing would overlap nothing and this
      // test would pass with it there. Measured: it did.
      const stage = node("#stage");
      stage.style.setProperty("--bar-w", `${frame.width}px`);
      stage.style.setProperty(
        "--bar-lift",
        `${Math.max(0, rect("#stage").bottom - frame.bottom)}px`,
      );
      const onPicture = () =>
        [
          ...document.querySelectorAll<HTMLElement>(
            "button, input, select, [data-transport-time]",
          ),
        ]
          .filter((el) => el.checkVisibility())
          .filter((el) => {
            const r = el.getBoundingClientRect();
            return (
              r.right > frame.left &&
              r.left < frame.right &&
              r.bottom > frame.top &&
              r.top < frame.bottom
            );
          })
          .map((el) => el.outerHTML.slice(0, 80));
      expect(onPicture()).toEqual([]);
      for (const selector of [
        "#toolbar-clock [data-transport-time]",
        "#stage-tools [data-aspect-toggle]",
        "#stage-tools [data-stage-zoom]",
        "#stage-tools [data-stage-fullscreen]",
      ]) {
        const control = node(selector);
        expect(control.checkVisibility(), `${selector} in the toolbar`).toBe(
          true,
        );
        expect(node("#dock").contains(control)).toBe(true);
      }
      // The positive control: the same probe, in full screen, does find
      // the floating row's controls on the picture — so the empty list
      // above is the row being hidden, not a probe that sees nothing.
      stage.setAttribute("data-fullscreen", "");
      expect(onPicture().length).toBeGreaterThan(0);
    });

    it(`shows the picture's own bar in full screen, and only there, in ${scheme}`, () => {
      const { node } = mount(scheme);
      expect(node("#stage-bar").checkVisibility()).toBe(false);
      node("#stage").setAttribute("data-fullscreen", "");
      expect(node("#stage-bar [data-stage-fullscreen]").checkVisibility()).toBe(
        true,
      );
      expect(node("#stage-bar [data-transport-time]").checkVisibility()).toBe(
        true,
      );
    });

    it(`shows a full-screen refusal on the picture while full screen in ${scheme}`, () => {
      const { node } = mount(
        scheme,
        null,
        0,
        null,
        previewTarget(LANDSCAPE_1080P),
        { playing: false, rate: 1 },
        "Chrome refused to leave full screen.",
      );
      node("#stage").setAttribute("data-fullscreen", "");
      const banner = node("#stage-bar [data-stage-error]");
      expect(banner.checkVisibility()).toBe(true);
      expect(banner.textContent).toContain("refused");
    });

    /* Both restored in fix round 1, for the full-screen row: it still
       floats on the picture there, so what these two held it to still
       ships. Each marks `#stage` full screen first (the row is
       `display: none` otherwise, and every measurement below would be of
       an empty box) and publishes `--bar-w`/`--bar-lift` the way
       `main.ts`'s ResizeObserver does — this lane does not boot the
       entrypoint, and without them the row spans the whole stage.

       The row lies across the bottom strip of the frame, which is where a
       selected mask's `s`/`sw`/`se` grips are. `pointer-events: none` on
       the row with `auto` on its controls is what keeps that strip
       draggable — the same trick `#stage-overlay` plays one level in.

       Asserted by HIT TESTING rather than by reading `pointerEvents` off
       the computed style: the property having the right value is not the
       claim. The claim is that a press in the gap between the clock and
       the chips reaches what is underneath, and `elementFromPoint` is the
       only thing that answers it. */
    it(`lets a press through the gap in the control row in full screen in ${scheme}`, async () => {
      await page.viewport(1440, 860);
      const { rect, node } = mount(scheme);
      const stage = node("#stage");
      stage.setAttribute("data-fullscreen", "");
      const frame = rect("#stage-frame");
      stage.style.setProperty("--bar-w", `${frame.width}px`);
      stage.style.setProperty(
        "--bar-lift",
        `${Math.max(0, rect("#stage").bottom - frame.bottom)}px`,
      );
      const bar = rect("#stage-bar");
      const clock = rect("#stage-bar [data-transport-time]");
      const actions = rect("#stage-bar [data-stage-actions]");
      // Fixture guard: there has to BE a gap, or this samples a control
      // and passes for the wrong reason.
      expect(
        actions.left - clock.right,
        `clock ends at ${clock.right}, actions start at ${actions.left}`,
      ).toBeGreaterThan(40);
      const midGap = (clock.right + actions.left) / 2;
      const hit = document.elementFromPoint(midGap, bar.top + bar.height / 2);
      expect(hit, "nothing was hit in the gap").not.toBeNull();
      expect(
        node("#stage-bar").contains(hit),
        `the row swallowed the press: hit <${hit?.tagName.toLowerCase()} id="${hit?.id}">`,
      ).toBe(false);
      // And the controls themselves DO take their presses, or the row is
      // simply inert and the assertion above means nothing.
      const onClock = document.elementFromPoint(
        clock.left + clock.width / 2,
        clock.top + clock.height / 2,
      );
      expect(node("#stage-bar").contains(onClock)).toBe(true);
    });

    /* The row sits on the PICTURE's edges, not the stage's — the reference
       mockup caps its readout row to the frame's width so the clock and the
       chips line up with the video rather than with the panel.

       `--bar-w` has to be measured rather than derived: the stylesheet's
       `--frame-w` is built from `100cqw`/`100cqh`, whose container is
       `#stage-box`, and `#stage-bar` is that box's SIBLING — the same
       expression used there resolves against the small viewport instead,
       which is wrong everywhere without looking wrong anywhere. */
    it(`sits the control row on the picture, inset from its edges, in full screen in ${scheme}`, async () => {
      await page.viewport(1440, 860);
      const { rect, node } = mount(scheme);
      node("#stage").setAttribute("data-fullscreen", "");
      const publish = (px: number) => {
        const stage = node("#stage");
        stage.style.setProperty("--bar-w", `${px}px`);
        stage.style.setProperty(
          "--bar-lift",
          `${Math.max(0, rect("#stage").bottom - rect("#stage-frame").bottom)}px`,
        );
      };

      const frame = rect("#stage-frame");
      const well = rect("#stage");
      // Fixture guard, FIRST: the frame has to be genuinely narrower than
      // the stage, or the full-width row this replaced satisfies every
      // assertion below by coincidence and the case says nothing.
      expect(
        well.width - frame.width,
        `the frame is ${frame.width} in a ${well.width} stage, so there is no margin to align within`,
      ).toBeGreaterThan(20);

      publish(frame.width);
      expect(
        rect("#stage-bar").width,
        `the row is ${rect("#stage-bar").width} against a ${frame.width} picture in ${scheme}`,
      ).toBeCloseTo(frame.width, 0);
      expect(
        rect("#stage-bar").left,
        "the row is not on the picture's left edge",
      ).toBeCloseTo(frame.left, 0);

      // The ROW spans the picture and the CONTROLS are inset from it —
      // both halves, because the two assertions above are equally happy
      // with contents jammed against the video's edges, which is what this
      // row looked like before it had padding.
      const pad = Number.parseFloat(
        getComputedStyle(node("#stage-bar")).paddingLeft,
      );
      // Fixture guard: with no inset the two comparisons below collapse
      // into the flush case and stop saying anything.
      expect(pad, "the row has no horizontal inset").toBeGreaterThan(4);
      expect(
        rect("#stage-bar [data-transport-time]").left - frame.left,
        `the clock sits ${rect("#stage-bar [data-transport-time]").left - frame.left} from the picture's left edge against a ${pad} inset`,
      ).toBeCloseTo(pad, 0);
      expect(
        frame.right - rect("#stage-bar [data-stage-actions]").right,
        "the chips are not inset from the picture's right edge",
      ).toBeCloseTo(pad, 0);

      // The other half of `min(…, 100%)`: at 100% the frame is deliberately
      // wider than the box it scrolls inside, and an unclamped row would
      // run off the side.
      document.body.setAttribute("data-zoom", "actual");
      // In a `finally`: `mount()` does not reset `body[data-zoom]`, and a
      // failure here would hand 100% to every test after it (seen while
      // revert-proving this test: two later cases failed on a 1280px frame).
      try {
        const zoomed = rect("#stage-frame");
        publish(zoomed.width);
        // Its own fixture guard: if the frame did not outgrow the stage there
        // is nothing for the clamp to do.
        expect(
          zoomed.width,
          `the frame is ${zoomed.width} against a ${well.width} stage, so the clamp is untested`,
        ).toBeGreaterThan(well.width);
        expect(
          rect("#stage-bar").width,
          "the row ran past the stage at 100%",
        ).toBeLessThanOrEqual(well.width + 1);
      } finally {
        document.body.removeAttribute("data-zoom");
      }
    });

    /* The toolbar's copy of the refusal banner, outside full screen. It
       hung above the toolbar (`bottom: 100%`) until fix round 1, which put
       it across the dock's seam and over the bottom of the stage — 7px for
       one line, 23px for two — painting over the very picture the spec
       keeps clear of controls. It must show, and show off the stage. Hit
       tested at its centre too: hung over the lanes, it has to be on top
       of them rather than under. */
    for (const [w, h, panel] of [
      [1440, 860, "open"],
      [1440, 860, "closed"],
      [STACKED_FLOOR, 560, "open"],
    ] as const) {
      it(`shows the toolbar's refusal off the picture at ${w}x${h}, panel ${panel}, in ${scheme}`, async () => {
        await page.viewport(w, h);
        const { node, rect } = mount(
          scheme,
          null,
          0,
          null,
          undefined,
          undefined,
          "The preview could not go full screen: Permissions check failed",
        );
        if (panel === "closed") {
          document.body.style.transition = "none";
          document.body.setAttribute("data-panel", "closed");
        }
        await document.fonts.ready;
        const banner = node("#stage-tools [data-stage-error]");
        // Premise: a banner with something in it, and a box.
        expect(banner.textContent).toContain("Permissions check failed");
        const b = banner.getBoundingClientRect();
        expect(b.height, "the banner has no height").toBeGreaterThan(0);
        expect(banner.checkVisibility(), "the banner is hidden").toBe(true);
        const stage = rect("#stage");
        const overlaps =
          b.right > stage.left &&
          b.left < stage.right &&
          b.bottom > stage.top &&
          b.top < stage.bottom;
        expect(
          overlaps,
          `the banner at ${JSON.stringify(b)} overlaps the stage at ${JSON.stringify(stage)}`,
        ).toBe(false);
        // Inside the dock, too. With the panel open at 1440 the stage
        // stops short of the banner's column, so the check above passes
        // with the banner hanging across the seam over the panel instead —
        // measured: top 566 against a dock that starts at 590.
        const dock = rect("#dock");
        expect(
          b.top,
          `the banner starts at ${b.top}, above the dock at ${dock.top}`,
        ).toBeGreaterThanOrEqual(dock.top);
        expect(b.bottom).toBeLessThanOrEqual(dock.bottom);
        const hit = document.elementFromPoint(
          b.left + b.width / 2,
          b.top + b.height / 2,
        );
        expect(
          hit !== null && banner.contains(hit),
          `the banner is covered by ${hit?.outerHTML.slice(0, 120)}`,
        ).toBe(true);
      });
    }

    it(`keeps every shape on the switch visible at the open floor in ${scheme}`, async () => {
      await page.viewport(STACKED_FLOOR, 860);
      const { node } = mount(scheme);
      const dock = node("#dock").getBoundingClientRect();
      for (const shape of ["auto", "16:9", "9:16"]) {
        const seg = node(`#stage-tools [data-aspect="${shape}"]`);
        const r = seg.getBoundingClientRect();
        expect(seg.checkVisibility(), shape).toBe(true);
        expect(r.right, `${shape} ran past the dock`).toBeLessThanOrEqual(
          dock.right,
        );
      }
      // And the other end of the same squeeze: the right group's
      // `max-content` column takes its width out of the left one, where
      // the clock is. The clock's own column floor keeps the cluster off
      // it now (see "the toolbar's clock clears the shuttle cluster", which
      // measures this across the widths that once overlapped); here it is
      // the short clock, at the floor.
      const clock = node(
        "#toolbar-clock [data-transport-time]",
      ).getBoundingClientRect();
      const controls = node(
        "#transport .transport-controls",
      ).getBoundingClientRect();
      expect(clock.width, "the clock rendered no text").toBeGreaterThan(40);
      expect(
        clock.right,
        `the clock ends at ${clock.right} and the shuttle cluster starts at ${controls.left} at ${STACKED_FLOOR}px; tracks ${getComputedStyle(node("#transport")).gridTemplateColumns}`,
      ).toBeLessThanOrEqual(controls.left);
    });

    it(`wraps the toolbar's end group under the transport when the dock is narrow in ${scheme}`, async () => {
      await page.viewport(STACKED_CLOSED_FLOOR - 1, 700);
      const { node } = mount(scheme);
      document.body.setAttribute("data-panel", "closed");
      const controls = node(
        "#transport .transport-controls",
      ).getBoundingClientRect();
      const end = node("#transport .transport-end").getBoundingClientRect();
      expect(end.top, "the end group did not wrap").toBeGreaterThanOrEqual(
        controls.bottom,
      );
      expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(
        STACKED_CLOSED_FLOOR - 1,
      );
    });

    /* Found looking at the Auto frame plan's 9:16 step (2026-10-06): the
       floating row was capped to the picture's width, and a 9:16 picture at
       an ordinary window is ~270px wide, under what the clock, the
       three-way shape switch, Fit and full screen need. The switch shrank
       inside its own `overflow: hidden` and the CHECKED 9:16 segment was
       cut off entirely — the author could not see which shape they were
       in, nor press the third.

       Both copies of the switch, since 2026-10-07. The toolbar's is the
       one the author uses, and nothing about a portrait picture should
       reach it. The floating row's is the one full screen shows, and it
       still sits on the picture there, so the original regression still
       applies to it: red if that row may narrow below its controls. */
    it(`keeps every shape on the switch visible with a 9:16 picture in ${scheme}`, async () => {
      await page.viewport(1440, 760);
      const { rect, node } = mount(
        scheme,
        null,
        0,
        null,
        previewTarget(VERTICAL_1080),
      );
      const frame = rect("#stage-frame");
      (document.querySelector("#stage") as HTMLElement).style.setProperty(
        "--bar-w",
        `${frame.width}px`,
      );
      const switchIsWhole = (root: string) => {
        const toggle = node(`${root} [data-aspect-toggle]`);
        const buttons = [
          ...toggle.querySelectorAll<HTMLElement>("[data-aspect]"),
        ];
        // Fixture guards: three shapes drawn, 9:16 the checked one, and the
        // switch actually painted — a hidden switch has no box to clip.
        expect(buttons.map((b) => b.dataset.aspect)).toEqual([
          "auto",
          "16:9",
          "9:16",
        ]);
        expect(
          buttons[2]?.getAttribute("aria-checked"),
          `the vertical mount does not check 9:16 in ${root}`,
        ).toBe("true");
        expect(toggle.checkVisibility(), `${root}'s switch is hidden`).toBe(
          true,
        );
        expect(
          toggle.scrollWidth,
          `${root}'s switch holds ${toggle.scrollWidth}px of shapes in ${toggle.clientWidth}px`,
        ).toBeLessThanOrEqual(toggle.clientWidth);
        for (const button of buttons) {
          const r = button.getBoundingClientRect();
          const hit = document.elementFromPoint(
            r.x + r.width / 2,
            r.y + r.height / 2,
          );
          expect(
            hit === button || button.contains(hit),
            `${root}'s ${button.dataset.aspect} is not painted at its centre: hit <${hit?.tagName.toLowerCase()}>`,
          ).toBe(true);
        }
      };

      switchIsWhole("#stage-tools");

      // Full screen: the floating row, over the picture.
      node("#stage").setAttribute("data-fullscreen", "");
      const barNode = node("#stage-bar");
      barNode.style.width = "max-content";
      const natural = barNode.getBoundingClientRect().width;
      barNode.style.width = "";
      // The premise the original bug needs: a picture genuinely narrower
      // than the row's controls, or the switch fits by coincidence.
      expect(
        frame.width,
        `the 9:16 picture is ${frame.width}px, wide enough to hold the row's ${natural}px`,
      ).toBeLessThan(natural);
      switchIsWhole("#stage-bar");
      // And the row still sits on the stage, centred on the picture.
      const bar = rect("#stage-bar");
      expect(bar.left).toBeGreaterThanOrEqual(rect("#stage").left);
      expect(bar.right).toBeLessThanOrEqual(rect("#stage").right);
      expect(bar.left + bar.width / 2).toBeCloseTo(
        frame.left + frame.width / 2,
        0,
      );
    });

    /* Fix round 2, IMPORTANT: `#stage-bar [data-stage-error]`'s
     * `position: absolute` had no assertion anywhere — every node test
     * runs in jsdom (no layout at all) and every browser test left
     * `error: null`, so no real-layout test had ever actually rendered the
     * banner. An in-flow banner would grow the row that carries it exactly
     * when an error is showing: the failure message breaking the layout
     * while reporting the failure.
     *
     * Two rows carry it since 2026-10-07. `#stage-bar` shows only in full
     * screen, so each mount below sets `#stage[data-fullscreen]` first —
     * without it the bar is `display: none`, measures 0px with and without
     * the banner, and the comparison passes on nothing. And the toolbar's
     * copy (`#stage-tools`) is a flex item in `#transport`'s right-hand
     * group, where an in-flow banner widens the group rather than the row
     * (measured: `#transport` kept its height with the banner in flow) —
     * pushing the shuttle cluster off centre and the group toward the
     * dock's edge. So that copy is held to the group's own width, and the
     * row's height besides, because its height comes straight out of the
     * space the picture and the lanes share. */
    it(`keeps a full-screen refusal out of the video's own budget in ${scheme}`, async () => {
      await page.viewport(STACKED_FLOOR, 560);
      const withError = mount(
        scheme,
        null,
        0,
        null,
        undefined,
        undefined,
        "The preview could not go full screen: refused",
      );
      withError.node("#stage").setAttribute("data-fullscreen", "");
      // Both mounts measured with the faces loaded: a group measured in a
      // fallback face against one in Manrope differs by a few pixels with
      // no banner involved (measured: 533 and 530 across two runs).
      await document.fonts.ready;
      // Fixture guards: the banner is actually painted in both rows, or
      // every height below is measured with nothing in it.
      for (const root of ["#stage-bar", "#stage-tools"]) {
        expect(
          withError.node(`${root} [data-stage-error]`).checkVisibility(),
          `${root}'s banner is not showing`,
        ).toBe(true);
      }
      // Half 1: the 150px floor `editor-shell-layout.test.ts` already holds
      // `#preview` to at this exact window — "keeps the video usable at
      // 952x560", the `WINDOWS` row for `STACKED_FLOOR` that checks the page
      // as shipped, with no status card, the same as this mount — must
      // still hold with the banner actually showing.
      expect(withError.rect("#preview").height).toBeGreaterThanOrEqual(150);

      // Half 2: the assertion that actually fails if `position: absolute`
      // is dropped. `getComputedStyle().position` would still read
      // "absolute" on a rule that positioned the banner somewhere useless;
      // comparing each row's own height WITH the banner against the same
      // row with no error at all is what "out of flow" has to mean — an
      // in-flow banner grows the row while it is showing, so the two
      // heights would differ.
      const barWithError = withError.rect("#stage-bar");
      const transportWithError = withError.rect("#transport");
      const endWithError = withError.rect("#transport .transport-end");
      const without = mount(scheme);
      without.node("#stage").setAttribute("data-fullscreen", "");
      await document.fonts.ready;
      const barWithoutError = without.rect("#stage-bar");
      expect(barWithoutError.height, "the bar is not painted").toBeGreaterThan(
        10,
      );
      expect(barWithError.height).toBeCloseTo(barWithoutError.height, 1);
      expect(transportWithError.height).toBeCloseTo(
        without.rect("#transport").height,
        1,
      );
      expect(
        endWithError.width,
        "the toolbar's banner widened its group",
      ).toBeCloseTo(without.rect("#transport .transport-end").width, 1);
    });

    /* The aspect toggle is the one control that says which shape is on,
     * so its two states have to read apart in both themes — in the
     * toolbar, where the author uses it, on the shell's own segment tones.
     * Read off the painted computed style, both segments. */
    it(`paints the checked aspect apart from the other in ${scheme}`, async () => {
      mount(scheme);
      const on = document.querySelector<HTMLElement>(
        '#stage-tools [data-aspect][aria-checked="true"]',
      );
      const off = document.querySelector<HTMLElement>(
        '#stage-tools [data-aspect][aria-checked="false"]',
      );
      // Fixture guard: one of each, painted, or the comparison below is
      // vacuous.
      if (!on || !off) throw new Error("the toolbar drew no aspect toggle");
      expect(on.checkVisibility(), "the toolbar's switch is hidden").toBe(true);
      const onBed = parse(getComputedStyle(on).backgroundColor);
      const offBed = parse(getComputedStyle(off).backgroundColor);
      expect(onBed, "checked and unchecked segments share a fill").not.toEqual(
        offBed,
      );
      expect(getComputedStyle(on).color).not.toBe(getComputedStyle(off).color);
    });

    /* The browser lane cannot request real full screen —
     * `requestFullscreen` needs a user gesture the test runner does not
     * supply — so this cannot drive `main.ts`'s own `requestFullscreen`
     * call or its listener end to end; that pairing (the click, the
     * promise, the rejection) is `editor-main-transport.test.ts`'s node
     * test "says so when full screen is refused", which runs the real
     * entrypoint. What this CAN exercise for real is the other half of the
     * design: a label driven by the `fullscreenchange` EVENT rather than by
     * the click, reading `document.fullscreenElement` the way `main.ts`'s
     * listener does. `document.fullscreenElement` is faked with
     * `defineProperty` rather than earned, because nothing else in this
     * lane can make it non-null. The fixture guard is the state actually
     * flipping BOTH ways below — a listener that always re-renders
     * `fullscreen: false` (the bug this exists to catch: deriving from the
     * click instead of the document) would leave the label "Full screen"
     * throughout and this would still read as a pass without it. */
    it(`follows the document out of full screen in ${scheme}`, async () => {
      await page.viewport(1440, 860);
      const { node } = mount(scheme);
      const stageBarRoot = document.querySelector<HTMLElement>("#stage-bar");
      if (!stageBarRoot) throw new Error("no #stage-bar in the shell");
      const stage = document.querySelector<HTMLElement>("#stage");
      if (!stage) throw new Error("no #stage in the shell");
      // The floating row's own button, the one full screen shows — so the
      // attribute `main.ts`'s listener mirrors `:fullscreen` onto goes on
      // first, and the button is asserted painted before it is read.
      stage.setAttribute("data-fullscreen", "");
      const button = node("#stage-bar [data-stage-fullscreen]");
      expect(button.checkVisibility(), "the full-screen bar is hidden").toBe(
        true,
      );
      expect(button.getAttribute("aria-label")).toBe("Full screen");

      // The same shape `main.ts`'s own listener has: driven by the event,
      // reading `document.fullscreenElement` fresh each time, never by the
      // click (there is none here).
      const renderFromDocument = () => {
        renderStageBar(
          stageBarRoot,
          {
            authored: false,
            positionMs: 0,
            durationMs: 12_000,
            aspect: "16:9",
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
      };
      document.addEventListener("fullscreenchange", renderFromDocument);
      try {
        Object.defineProperty(document, "fullscreenElement", {
          configurable: true,
          get: () => stage,
        });
        document.dispatchEvent(new Event("fullscreenchange"));
        expect(button.getAttribute("aria-label")).toBe("Exit full screen");

        Object.defineProperty(document, "fullscreenElement", {
          configurable: true,
          get: () => null,
        });
        document.dispatchEvent(new Event("fullscreenchange"));
        expect(button.getAttribute("aria-label")).toBe("Full screen");
      } finally {
        document.removeEventListener("fullscreenchange", renderFromDocument);
        Object.defineProperty(document, "fullscreenElement", {
          configurable: true,
          get: () => null,
        });
      }
    });
  }
});

describe("the mask overlay stays inside the canvas's drawn box", () => {
  for (const scheme of ["light", "dark"] as const) {
    for (const [format, target, maskRect] of OVERLAY_TARGETS) {
      it(`keeps a selected mask's overlay inside the letterboxed ${format} canvas in ${scheme}`, async () => {
        // `#stage-overlay` is sized to `#stage-frame` — the canvas's own
        // drawn box, as an element, since 2026-09-21 — and
        // `renderStageOverlay` positions each box in element px against
        // that same drawn area via `drawnBox` (see `stage-overlay.ts`'s
        // docblock on `drawnBox`).
        //
        // This does NOT cover `place()` adding `box.left`/`box.top`:
        // `drawnBox`'s own offsets are ~0 at every viewport here, because
        // `#stage-frame`'s box is defined to match the bitmap's ratio
        // exactly, so dropping the offset from `place()` moves the overlay
        // by less than this test's ±0.5px tolerance and this case stays
        // green either way. That arithmetic is covered directly, by
        // `editor-stage-overlay.test.ts`'s "places the mask box at the
        // drawn box's offset, not the canvas element's own corner", whose
        // fixture canvas does NOT share its target's ratio and so gets a
        // real, non-trivial `drawnBox` offset to assert against.
        //
        // A mask rect pinned to the frame's corner (see `maskedScene`) is
        // kept from before 2026-09-21 for: it puts the overlay close enough
        // to the drawn edge that a regression in `place()`'s SCALE
        // arithmetic (`rect.x * box.scale`, not the offset) would push it
        // outside the bound rather than just shrinking a margin.
        //
        // `STACKED_FLOOR` x 560 — the floor itself, not below it — because
        // below it `#stage-box` carries its own `aspect-ratio:
        // var(--frame-ratio)` (see index.html's `@media (max-width: 951px)`
        // block), which makes `#stage-box` and `#stage-frame` the SAME size
        // by construction: no letterbox margin is left between the stage
        // box and the drawn box down there for the fixture guard below to
        // find. 900x560 (used here before this file's round-2 fix) measured
        // `#stage-box` and `#stage-frame` as identically 852x479.25 and the
        // guard failed outright, and 920x560 did the same once the floor
        // moved to 952 on 2026-10-07. At the floor — the WIDE layout's own
        // narrowest width — `#stage-box` has no `aspect-ratio` of its own
        // and stays letterboxed inside its `minmax(0, 1fr)` row exactly as
        // `#stage-frame`'s ratio dictates, restoring the margin.
        //
        // The vertical case keeps the corner-pinned mask rect and gives up
        // the viewport choice's other half: a 9:16 `cover` crop does not
        // contain the capture's left edge at all, so its mask is pinned to
        // the TOP edge only — `VERTICAL_MASK_RECT` says why.
        await page.viewport(STACKED_FLOOR, 560);
        const { rect, canvas } = mountMaskOverlay(scheme, target, maskRect);
        const box = drawnBox(canvas);
        // Fixture guard, re-derived for 2026-09-21: the letterbox that used
        // to live inside the canvas element now lives between `#stage-box`
        // (the picture's box) and `#stage-frame` (the drawn box) — `drawnBox`'s own
        // offsets can no longer tell the two boxes apart (they're the same
        // box now, by construction). What still can: proving `#stage-box`
        // is genuinely bigger than `#stage-frame`, so an overlay parented to
        // the wrong box (this test's deletion runs move it there) lands
        // against a box other than the drawn one instead of nearly on top
        // of it.
        const stageBox = rect("#stage-box");
        const stageFrame = rect("#stage-frame");
        expect(
          stageBox.width - stageFrame.width > 0.5 ||
            stageBox.height - stageFrame.height > 0.5,
          `stage-box ${stageBox.width}x${stageBox.height} matches stage-frame ${stageFrame.width}x${stageFrame.height} for ${format} in ${scheme} — this test cannot distinguish the two boxes`,
        ).toBe(true);
        // Fixture guard: the helper publishes `--frame-ratio` from `target`,
        // and this case is only about the vertical cut if the frame actually
        // took a portrait shape. A helper that stopped publishing would leave
        // the sheet's 16/9 default in force and every assertion below would
        // be measuring landscape. Checked here, before the real assertions
        // below rather than after them, so a broken fixture is reported as
        // "not a portrait cut" instead of as a confusing failure on the
        // bounds check that follows.
        if (format === "vertical") {
          expect(
            stageFrame.height,
            `the frame is ${stageFrame.width}x${stageFrame.height}, not a portrait cut`,
          ).toBeGreaterThan(stageFrame.width);
        }
        const canvasRect = canvas.getBoundingClientRect();
        const drawnLeft = canvasRect.left + box.left;
        const drawnTop = canvasRect.top + box.top;
        const drawnRight = drawnLeft + canvas.width * box.scale;
        const drawnBottom = drawnTop + canvas.height * box.scale;
        const overlay = rect("#stage-overlay [data-overlay]");
        const evidence = `overlay ${JSON.stringify({
          left: overlay.left,
          top: overlay.top,
          right: overlay.right,
          bottom: overlay.bottom,
        })} vs drawn box ${JSON.stringify({
          left: drawnLeft,
          top: drawnTop,
          right: drawnRight,
          bottom: drawnBottom,
        })} for ${format} in ${scheme}`;
        expect(overlay.left, evidence).toBeGreaterThanOrEqual(drawnLeft - 0.5);
        expect(overlay.top, evidence).toBeGreaterThanOrEqual(drawnTop - 0.5);
        expect(overlay.right, evidence).toBeLessThanOrEqual(drawnRight + 0.5);
        expect(overlay.bottom, evidence).toBeLessThanOrEqual(drawnBottom + 0.5);
        // The docblock above claims the corner-pinned rect "puts the
        // overlay close enough to the drawn edge that a regression in
        // `place()`'s SCALE arithmetic … would push it outside the bound
        // rather than just shrinking a margin" — the four checks above
        // only prove the overlay is somewhere INSIDE the drawn box, which
        // any position (including dead centre) also satisfies, so that
        // claim was unasserted. Reusing the bound shape from
        // `editor-preview-zoom.test.ts`'s "keeps a selected mask's handle
        // on the picture at 100%" test: "close to the near edge, not AT
        // it" — `cssRectToCanvas` maps `maskedScene`'s rect through the
        // camera at `outputTimeMs`, so a naive `toBeCloseTo(drawnLeft, 0)`
        // is wrong here (already measured and caught once on this
        // branch). Measured directly before writing this: 26.6px left /
        // 7.9px top drift on a 280.3x157.7 landscape drawn box, and
        // 36.8px left / 3.5px top on an 88.7x157.7 vertical one — both
        // well under HALF the drawn box in the axis that matters, which a
        // scale doubled, halved or dropped entirely would blow past.
        expect(overlay.left - drawnLeft, evidence).toBeLessThan(
          (drawnRight - drawnLeft) / 2,
        );
        expect(overlay.top - drawnTop, evidence).toBeLessThan(
          (drawnBottom - drawnTop) / 2,
        );
      });
    }
  }
});

describe("the stage and the timeline are two surfaces, not one slab", () => {
  for (const scheme of ["light", "dark"] as const) {
    it(`separates the timeline panel from the ground in ${scheme}`, () => {
      const { surface } = mount(scheme);
      // The ground, not `#stage`: the stage paints nothing since
      // 2026-10-07, and the stage bed it used to carry is the page's own
      // ground now, so the picture and the timeline's card meet across it.
      const ground = surface("body");
      const panel = surface("#dock");
      // The defect this pins: both were rgba(127,127,127,.1x), so the gutter
      // between the video and the lanes carried no boundary at all and the
      // two regions read as one continuous slab.
      expect(contrast(ground, panel)).toBeGreaterThanOrEqual(1.15);
    });

    it(`makes a lane bed visible against its panel in ${scheme}`, () => {
      // Named rather than taken as "the first `.track`": between 2026-09-21
      // and 2026-09-22 the first one was an unbedded strip, and a lane added
      // above the others could make that true again.
      const { surface } = mount(scheme);
      expect(
        contrast(surface("#dock", '[data-track="zoom"]'), surface("#dock")),
      ).toBeGreaterThanOrEqual(1.2);
    });

    it(`makes a segment visible against its lane bed in ${scheme}`, () => {
      // Retargeted in review round 1: the three-lane rewrite draws a
      // segment as `.seg` on `[data-track="zoom"|"mask"]`, not `.clip` on a
      // generic `.track` — the default `mount()` model (`readonlyScene()`,
      // no camera) has no segment at all to measure, so this needs one
      // authored, the same way `editor-main-drag.test.ts` does.
      const scene = zoomedScene();
      const bundle = proceduralBundle();
      const resolved = resolvePlan(planScene(scene), bundle, scene);
      const model = buildLaneModel({
        scene,
        view: buildTimelineView({ scene, bundle, resolved }),
        bundle,
        resolved,
        hoverReport: null,
      });
      const { node, surface } = mount(scheme, null, 0, model);
      // Fixture guard: without the segment in the DOM this is the
      // lane-bed test above with extra steps.
      node('[data-track="zoom"] .seg');
      expect(
        contrast(
          surface("#dock", '[data-track="zoom"]', ".seg"),
          surface("#dock", '[data-track="zoom"]'),
        ),
      ).toBeGreaterThanOrEqual(1.25);
    });

    it(`centres a zoom's scale in ${scheme}`, () => {
      const scene = zoomedScene();
      const bundle = proceduralBundle();
      const resolved = resolvePlan(planScene(scene), bundle, scene);
      const model = buildLaneModel({
        scene,
        view: buildTimelineView({ scene, bundle, resolved }),
        bundle,
        resolved,
        hoverReport: null,
      });
      const { node } = mount(scheme, null, 0, model);
      const seg = node('[data-track="zoom"] .seg');
      const label = seg.querySelector<HTMLElement>(".seg-label");
      if (!label) throw new Error("the zoom segment carries no label");
      expect(label.textContent).toMatch(/^\d+\.\d+x$/);

      const mid = (el: Element) => {
        const r = el.getBoundingClientRect();
        return r.left + r.width / 2;
      };
      // Both widths are set here rather than taken from the fixture: at the
      // default viewport this zoom draws ~25px wide, which is under its own
      // label, so the natural fixture only ever exercises the fallback and
      // a centring assertion on it would pass start-aligned too.
      seg.style.width = "200px";
      expect(
        seg.getBoundingClientRect().width,
        "the widened segment is still too narrow to tell centring from start",
      ).toBeGreaterThan(label.getBoundingClientRect().width + 20);
      expect(mid(label)).toBeCloseTo(mid(seg), 0);
    });

    it(`squares both ends of a zoom, authored or not, in ${scheme}`, () => {
      // Every segment end is the same 6px corner. The attribute is set
      // here rather than fished out of a fixture so the assertion covers
      // the state that used to be drawn as a semicircle.
      const scene = zoomedScene();
      const bundle = proceduralBundle();
      const resolved = resolvePlan(planScene(scene), bundle, scene);
      const model = buildLaneModel({
        scene,
        view: buildTimelineView({ scene, bundle, resolved }),
        bundle,
        resolved,
        hoverReport: null,
      });
      const { node } = mount(scheme, null, 0, model);
      const seg = node('[data-track="zoom"] .seg');
      seg.setAttribute("data-authored-end", "false");
      const style = getComputedStyle(seg);
      const corners = [
        style.borderTopLeftRadius,
        style.borderTopRightRadius,
        style.borderBottomRightRadius,
        style.borderBottomLeftRadius,
      ];
      expect(
        new Set(corners).size,
        `an automatic end is drawn differently again: ${corners.join(", ")}`,
      ).toBe(1);
      expect(corners[0]).toBe("6px");
    });
  }
});

// A four-kind generic clip palette ("action"/"hover"/"camera"/"degradation"
// clips sharing a lane) was retired here in Task 12 (the three-lane
// rewrite): `buildLaneModel`/`renderTimeline` no longer produce it — there
// are three fixed lanes (Clip/Zoom/Mask) now, each with its own hue (see
// `index.html`'s stylesheet comment) — and the four `it`s below it that
// asserted distinctness, on-bed contrast and label-ink contrast for the
// four kinds went with it, leaving a colour/contrast gap the Task 12 report
// named. The two `describe`s below are that gap's replacement, reading the
// three lane tokens straight off `:root` instead of rebuilding a
// per-kind DOM fixture.
const LANE_TOKENS = ["--lane-clip", "--lane-zoom", "--lane-mask"] as const;

describe("each lane's token stands off the track bed", () => {
  for (const scheme of ["light", "dark"] as const) {
    it(`gives every lane token contrast against --track in ${scheme}`, () => {
      // Mirrors the 1.25 luminance margin the retired four-kind block used
      // for "keeps every kind of clip visible on its bed". Turns red if a
      // lane token in `index.html` is ever set close to `--track`'s own
      // composited colour (the four-lane predecessor of this bug: every
      // fill was `rgba(127,127,127,.1x)`, the same tone as the bed under
      // it).
      const { surface } = mount(scheme);
      const bed = surface("#dock", ".track");
      for (const lane of LANE_TOKENS) {
        const fill = token(lane);
        expect(
          contrast(fill, bed),
          `${lane} ${JSON.stringify(fill)} against --track ${JSON.stringify(bed)} in ${scheme}`,
        ).toBeGreaterThanOrEqual(1.25);
      }
    });
  }
});

describe("each lane's ink reads on its own fill", () => {
  for (const scheme of ["light", "dark"] as const) {
    it(`keeps every lane's label ink readable on its fill in ${scheme}`, () => {
      // Restores the retired four-kind block's ink-on-fill check
      // (`gives every clip's label readable on its fill`, contrast >= 3)
      // for the three lanes' `--lane-*-ink` tokens.
      mount(scheme);
      for (const lane of LANE_TOKENS) {
        const ink = token(`${lane}-ink`);
        const fill = token(lane);
        expect(
          contrast(ink, fill),
          `${lane}-ink ${JSON.stringify(ink)} on ${lane} ${JSON.stringify(fill)} in ${scheme}`,
        ).toBeGreaterThanOrEqual(3);
      }
    });
  }
});

/**
 * The track headers, since 2026-09-22: a cell the height of its track,
 * filled like the track's bed, so the name reads as the head of its row.
 * They replaced a column of floating uppercase captions; what went wrong
 * with those was the picture, so these ask about the painted boxes.
 */
describe("each track has a header the height of its track", () => {
  for (const scheme of ["light", "dark"] as const) {
    it(`draws the three headers beside their tracks in ${scheme}`, () => {
      const base = buildLaneModel({
        scene: readonlyScene(),
        view: buildTimelineView({
          scene: readonlyScene(),
          bundle: null,
          resolved: null,
        }),
        bundle: null,
        resolved: null,
        hoverReport: null,
      });
      // A crashed hover pass flags the Clip header — the one header that
      // carries anything extra, and so the one that could come off centre
      // (a line of text under "Clip" lifted it 7px until 2026-09-22).
      const model = { ...base, hoverCheck: { failed: true, unchecked: 0 } };
      const { surface } = mount(scheme, null, 0, model);
      const rows = [...document.querySelectorAll<HTMLElement>("[data-lane]")];
      expect(
        rows.map((r) => r.getAttribute("data-lane")),
        "the lanes are not Clip, Zoom and Mask in that order",
      ).toEqual(["clip", "zoom", "mask"]);
      const glyphContrast: Record<string, number> = {};
      for (const row of rows) {
        const lane = row.getAttribute("data-lane");
        const head = row.querySelector<HTMLElement>(".lane-head");
        const track = row.querySelector<HTMLElement>(".track");
        if (!head || !track)
          throw new Error(`${lane} lane has no header or track`);
        const h = head.getBoundingClientRect();
        const t = track.getBoundingClientRect();
        expect(
          Math.abs(h.height - t.height),
          `${lane} header is ${h.height}px tall beside a ${t.height}px track in ${scheme}`,
        ).toBeLessThanOrEqual(1);
        expect(
          Math.abs(h.top - t.top),
          `${lane} header top ${h.top} against track top ${t.top} in ${scheme}`,
        ).toBeLessThanOrEqual(1);
        // No cell of its own: the header sits on the dock, and the grey
        // disc behind the glyph is the only fill in it.
        expect(
          getComputedStyle(head).backgroundColor,
          `${lane} header paints a cell of its own in ${scheme}`,
        ).toBe("rgba(0, 0, 0, 0)");
        const disc = head.querySelector("svg");
        if (!disc) throw new Error(`${lane} header has no glyph`);
        const d = disc.getBoundingClientRect();
        expect(
          contrast(
            surface("#dock", `[data-lane="${lane}"] .lane-head svg`),
            surface("#dock"),
          ),
          `${lane} glyph's disc does not stand off the dock in ${scheme}`,
        ).toBeGreaterThanOrEqual(1.2);
        expect(
          [
            Math.round(d.width),
            Math.round(d.height),
            getComputedStyle(disc).borderRadius,
          ],
          `${lane} glyph's disc is not a circle in ${scheme}`,
        ).toEqual([22, 22, "50%"]);
        // The glyph's stroke reads on its disc at text contrast. Drawn in
        // the deep lane fill it was 3.0-3.9:1 in dark — a black squiggle —
        // which is why each lane has a `--lane-*-glyph` of its own.
        const discBg = surface("#dock", `[data-lane="${lane}"] .lane-head svg`);
        const stroke = over(parse(getComputedStyle(disc).color), discBg);
        expect(
          contrast(stroke, discBg),
          `${lane} glyph ${JSON.stringify(stroke)} on its disc ${JSON.stringify(discBg)} in ${scheme}`,
        ).toBeGreaterThanOrEqual(4.5);
        glyphContrast[lane ?? ""] = contrast(stroke, discBg);
        // The name fits whole. Its text width against its box, not the
        // box's right edge: `.lane-name` clips with an ellipsis.
        const name = row.querySelector<HTMLElement>(".lane-name");
        if (!name) throw new Error(`${lane} header has no name`);
        expect(
          name.scrollWidth,
          `${lane} header's name needs ${name.scrollWidth}px and has ${name.clientWidth}px in ${scheme}`,
        ).toBeLessThanOrEqual(name.clientWidth);
        // Glyph and name centred on the track, every lane alike.
        const mid = t.top + t.height / 2;
        for (const [what, box] of [
          ["glyph", d],
          ["name", name.getBoundingClientRect()],
        ] as const) {
          expect(
            Math.abs(box.top + box.height / 2 - mid),
            `${lane} header's ${what} is off its track's centre in ${scheme}`,
          ).toBeLessThanOrEqual(1);
        }
        // The name in the inspector's supporting-text tone, not full ink.
        expect(
          parse(
            getComputedStyle(row.querySelector(".lane-name") ?? head).color,
          ),
          `${lane} header name is not --ink-muted in ${scheme}`,
        ).toEqual(token("--ink-muted"));
      }
      // And the three read as one weight: no glyph much lighter than the
      // others. Their tokens share an OKLCH lightness, which WCAG contrast
      // only approximates (it rates a green a little high), so this allows
      // a band rather than equality. At equal saturation instead, dark
      // measured 9.3 / 5.4 / 5.8 — a spread of 1.72 — and Zoom and Mask
      // read dimmed beside Clip.
      const ratios = Object.values(glyphContrast);
      expect(
        Math.max(...ratios) / Math.min(...ratios),
        `the track-head glyphs are uneven in ${scheme}: ${JSON.stringify(glyphContrast)}`,
      ).toBeLessThanOrEqual(1.2);
      // Fixture guard: the flag is really there, so the Clip header above
      // was measured carrying it.
      const flag = document.querySelector<HTMLElement>(
        '[data-lane="clip"] .lane-glyph [data-hover-check]',
      );
      if (!flag)
        throw new Error("the hover-check flag is not on the Clip glyph");
      const f = flag.getBoundingClientRect();
      const disc = document
        .querySelector('[data-lane="clip"] .lane-head svg')
        ?.getBoundingClientRect();
      if (!disc) throw new Error("the Clip header has no glyph");
      // An amber dot on the disc's top-right corner.
      expect(
        parse(getComputedStyle(flag).backgroundColor),
        `the flag is not --warn in ${scheme}`,
      ).toEqual(token("--warn"));
      expect(f.width, "the flag did not paint").toBeGreaterThanOrEqual(8);
      expect(
        [f.right - disc.right, f.top - disc.top].map((v) => Math.abs(v) <= 2),
        `the flag sits at ${f.right - disc.right}, ${f.top - disc.top} from the disc's top-right in ${scheme}`,
      ).toEqual([true, true]);
    });

    it(`centres the beats on the Clip track, over the trim handles, in ${scheme}`, () => {
      const { node } = mount(scheme);
      const track = node('[data-track="clip"]').getBoundingClientRect();
      const ticks = [
        ...document.querySelectorAll<HTMLElement>(
          '[data-track="clip"] [data-tick]',
        ),
      ];
      expect(ticks.length, "the default take drew no beats").toBeGreaterThan(0);
      for (const tick of ticks) {
        const r = tick.getBoundingClientRect();
        expect(
          Math.abs(r.top + r.height / 2 - (track.top + track.height / 2)),
          `beat ${tick.dataset.tick} is not centred on the track in ${scheme}`,
        ).toBeLessThanOrEqual(1);
      }
      // A beat on the trim's edge — where a take's last action usually sits
      // — stays visible over the handle, and the handle is still what a
      // press above or below the beat lands on. Placed onto the handle here
      // rather than found in the fixture, which has no beat on an edge.
      const handle = node('[data-track="clip"] [data-trim="tail"]');
      const beat = ticks[ticks.length - 1] as HTMLElement;
      beat.style.left = handle.style.left;
      const h = handle.getBoundingClientRect();
      const b = beat.getBoundingClientRect();
      // Fixture guard: the beat really does sit over the handle now. The bar
      // is inside the block's end since 2026-09-22 and the beat is centred
      // on the end's instant, so the two overlap rather than share a centre.
      expect(
        b.left < h.right && b.right > h.left,
        `the beat (${b.left}-${b.right}) does not cover the handle (${h.left}-${h.right})`,
      ).toBe(true);
      // Probed just inside the track: an uncut tail sits on the track's own
      // right edge, and the track clips the half of the handle past it.
      const x = Math.min(h.left + h.width / 2, track.right - 2);
      expect(
        document.elementFromPoint(x, b.top + b.height / 2),
        `the trim handle covers a beat on its edge in ${scheme}`,
      ).toBe(beat);
      for (const y of [h.top + 4, h.bottom - 4]) {
        expect(
          document.elementFromPoint(x, y),
          `a press at ${y} beside the beat misses the trim handle in ${scheme}`,
        ).toBe(handle);
      }
    });
  }
});

/**
 * The beats' visual language, since 2026-09-22: shape carries the verb and
 * tone carries the kind — inputs white, the pointer's movement a pale tint
 * of the Clip green, a wait quietest — within the one lane hue. Asked of the
 * painted styles, because every one of these is a picture claim.
 */
describe("each verb draws its own beat", () => {
  const VERBS = [
    "click",
    "type",
    "moveTo",
    "scrollTo",
    "waitFor",
    "drag",
  ] as const;
  const mountEveryVerb = (scheme: "light" | "dark") => {
    const scene = everyVerbScene();
    const bundle = proceduralBundle();
    const resolved = resolvePlan(planScene(scene), bundle, scene);
    const model = buildLaneModel({
      scene,
      view: buildTimelineView({ scene, bundle, resolved }),
      bundle,
      resolved,
      hoverReport: null,
    });
    const mounted = mount(scheme, null, 0, model);
    const tick = (verb: string) =>
      mounted.node(`[data-track="clip"] [data-verb="${verb}"]`);
    // Fixture guard: one beat per verb, or a rule below goes unexercised.
    expect(
      [
        ...document.querySelectorAll<HTMLElement>(
          '[data-track="clip"] [data-tick]',
        ),
      ]
        .map((t) => t.dataset.verb)
        .sort(),
      "the fixture no longer draws every verb once",
    ).toEqual([...VERBS].sort());
    return { ...mounted, tick };
  };

  // The author, 2026-10-19: in the studio each step reads by its icon.
  // Every tick carries its verb's; this page (the extension's) hides them
  // and keeps the shapes below. Red: drop an entry from `STEP_GLYPH`, or
  // the extension's `display: none` on them.
  it("gives every verb its own icon, which this page leaves unpainted", () => {
    const { tick } = mountEveryVerb("dark");
    const icons = VERBS.map((verb) =>
      tick(verb).querySelector("svg[data-icon]")?.getAttribute("data-icon"),
    );
    expect(icons).toEqual(VERBS.map((verb) => STEP_GLYPH[verb]));
    expect(new Set(icons).size, "one icon per verb").toBe(VERBS.length);
    for (const verb of VERBS) {
      const svg = tick(verb).querySelector("svg") as SVGElement;
      expect(getComputedStyle(svg).display, verb).toBe("none");
    }
  });

  for (const scheme of ["light", "dark"] as const) {
    it(`gives every verb a different shape in ${scheme}`, () => {
      const { tick } = mountEveryVerb(scheme);
      const shapes = VERBS.map((verb) => {
        const node = tick(verb);
        const style = getComputedStyle(node);
        const r = node.getBoundingClientRect();
        return `${Math.round(r.width)}x${Math.round(r.height)} r=${style.borderTopLeftRadius} t=${style.transform} hollow=${style.boxShadow.includes("inset")}`;
      });
      expect(
        new Set(shapes).size,
        `two verbs share a shape in ${scheme}: ${JSON.stringify(Object.fromEntries(VERBS.map((v, i) => [v, shapes[i]])))}`,
      ).toBe(VERBS.length);
    });

    it(`tones the beats by kind, within the lane's hue, in ${scheme}`, () => {
      const { tick } = mountEveryVerb(scheme);
      const block = token("--lane-clip");
      const fill = (verb: string) =>
        parse(getComputedStyle(tick(verb)).backgroundColor);
      // A hover's tone is its ring: the disc inside is the lane's own fill,
      // which is what makes it read hollow.
      const hoverRing = (() => {
        // Chrome writes each shadow colour-first — `rgb(…) 0px 0px 0px 2px
        // inset` — so the inset ring is the colour whose shadow ends in the
        // keyword before the next comma.
        const inset = /(rgba?\([^)]*\)|color\([^)]*\))[^,]*\binset\b/.exec(
          getComputedStyle(tick("moveTo")).boxShadow,
        );
        const colour = inset?.[1];
        if (!colour)
          throw new Error(
            `the hover beat has no inset ring: ${getComputedStyle(tick("moveTo")).boxShadow}`,
          );
        return parse(colour);
      })();
      expect(fill("moveTo"), "the hover beat is not hollow").toEqual(block);
      // Inputs share one tone, the pointer's movement another.
      expect(fill("type"), "type is not toned like click").toEqual(
        fill("click"),
      );
      expect(hoverRing, "hover is not toned like scroll").toEqual(
        fill("scrollTo"),
      );
      const input = contrast(fill("click"), block);
      const pointer = contrast(fill("scrollTo"), block);
      const wait = contrast(fill("waitFor"), block);
      const said = `input ${input.toFixed(2)}, pointer ${pointer.toFixed(2)}, wait ${wait.toFixed(2)} on the Clip block in ${scheme}`;
      // Each reads on the block as a non-text mark, and each is a step
      // quieter than the one before: three levels, not one tone or five.
      expect(wait, said).toBeGreaterThanOrEqual(3);
      expect(pointer, said).toBeGreaterThan(wait * 1.15);
      expect(input, said).toBeGreaterThan(pointer * 1.15);
    });

    it(`marks timing and a still hover without a hatch or a dash in ${scheme}`, () => {
      const { tick } = mountEveryVerb(scheme);
      // Fixture guard: the bundle carries markers for the click but not the
      // wait, so the two differ in timing and nothing else asked of them.
      expect(tick("click").dataset.timing).toBe("rendered");
      expect(tick("waitFor").dataset.timing).toBe("estimated");
      expect(getComputedStyle(tick("click")).opacity).toBe("1");
      expect(getComputedStyle(tick("waitFor")).opacity).toBe("0.5");
      expect(
        getComputedStyle(tick("waitFor")).backgroundImage,
        "an estimated beat still draws a hatch",
      ).toBe("none");

      const hover = tick("moveTo");
      const before = getComputedStyle(hover).boxShadow;
      // Set here rather than fished out of a hover report, so the case
      // covers the attribute the view writes for one.
      hover.setAttribute("data-flag", "unchangedHover");
      const warn = token("--warn")
        .slice(0, 3)
        .map((v) => Math.round(v))
        .join(", ");
      const after = getComputedStyle(hover).boxShadow;
      expect(before, "the unflagged hover is already amber").not.toContain(
        warn,
      );
      expect(
        after,
        `a still hover's ring is not --warn in ${scheme}`,
      ).toContain(`rgb(${warn})`);
      expect(getComputedStyle(hover).borderStyle).not.toBe("dashed");
    });
  }
});

/* `describe("the timeline's bar")` stood here until 2026-09-22. Its two
 * cases measured the row that carried the hover report above the ruler —
 * that it collapsed its own margin when the report had nothing to say, and
 * that it took up space when it did. The report is a card in the status row
 * now (`renderTakeNotes`) and the row is gone, so both cases are about a
 * mechanism that no longer exists; the "does it draw / does it clear"
 * half of what they held lives in `editor-view.test.ts`'s
 * `renderTakeNotes` block, and the "does the page still fit with a notice
 * on it" half is the `with a notice line` case in this file, which now
 * renders the real card. */

/**
 * Every block's edge handle, since 2026-09-22: the Clip's trim (`.handle`)
 * and a zoom's or mask's ends (`.cap`) draw as one handle — the 8px ink bar
 * the Clip's trim always was — and all of them show under the pointer
 * rather than all the time (the Clip's) or never (a zoom's or mask's).
 * Hover is asked with a real pointer: `:hover` does not answer a synthetic
 * event.
 */
describe("every block's edge handles", () => {
  const mountEdges = (scheme: "light" | "dark") => {
    const z = zoomedScene();
    const m = maskedScene();
    const scene = { ...z, edits: { ...z.edits, masks: m.edits.masks } };
    const bundle = proceduralBundle();
    const resolved = resolvePlan(planScene(scene), bundle, scene);
    const model = buildLaneModel({
      scene,
      view: buildTimelineView({ scene, bundle, resolved }),
      bundle,
      resolved,
      hoverReport: null,
    });
    const mounted = mount(scheme, null, 0, model);
    const edges = {
      clip: mounted.node('[data-track="clip"] [data-trim="tail"]'),
      zoom: mounted.node('[data-track="zoom"] .cap[data-cap="end"]'),
      mask: mounted.node('[data-track="mask"] .cap[data-cap="end"]'),
    };
    const blocks = {
      clip: mounted.node("[data-clip-block]"),
      zoom: mounted.node('[data-track="zoom"] .seg'),
      mask: mounted.node('[data-track="mask"] .seg'),
    };
    return { ...mounted, edges, blocks };
  };
  const shown = (el: HTMLElement) => getComputedStyle(el).opacity === "1";
  const hidden = (el: HTMLElement) => getComputedStyle(el).opacity === "0";

  for (const scheme of ["light", "dark"] as const) {
    it(`draws one handle for the Clip, a zoom and a mask in ${scheme}`, () => {
      const { edges, blocks } = mountEdges(scheme);
      // One corner shape for all three, whatever it is — read off the Clip's
      // and required of the others, so a corner change made to one kind
      // alone goes red here.
      const corners = (el: HTMLElement) => {
        const st = getComputedStyle(el);
        return [
          st.borderTopLeftRadius,
          st.borderTopRightRadius,
          st.borderBottomRightRadius,
          st.borderBottomLeftRadius,
        ].join(" ");
      };
      const clipCorners = corners(edges.clip);
      for (const [lane, edge] of Object.entries(edges)) {
        const style = getComputedStyle(edge);
        const r = edge.getBoundingClientRect();
        const block =
          blocks[lane as keyof typeof blocks].getBoundingClientRect();
        expect(Math.round(r.width), `${lane}'s handle is not the 4px bar`).toBe(
          4,
        );
        expect(
          corners(edge),
          `${lane}'s handle has other corners than the Clip's`,
        ).toBe(clipCorners);
        expect(
          parse(style.backgroundColor),
          `${lane}'s handle is not ink`,
        ).toEqual(token("--ink"));
        expect(
          Math.round(r.height),
          `${lane}'s handle is not full height`,
        ).toBe(Math.round(block.height));
        // Inside the block's end, flush with its edge — never past it.
        const said = `${lane}'s handle sits at ${r.left}-${r.right}, the block ends at ${block.right}`;
        expect(Math.abs(r.right - block.right), said).toBeLessThanOrEqual(0.5);
        expect(r.left, said).toBeGreaterThanOrEqual(block.left);
        // Drawn 4px, pressed wider: 3px beside the bar still lands on it.
        const y = r.top + r.height / 4;
        expect(
          document.elementFromPoint(r.left - 2.5, y),
          `a press just inside ${lane}'s handle misses it`,
        ).toBe(edge);
      }
    });

    it(`draws a full-length Clip's handles whole, not clipped by the track, in ${scheme}`, () => {
      // An unedited take: the Clip block spans the whole track, so both of
      // its handles sit at the track's own ends — where `.track`'s
      // `overflow: hidden` cut the old straddling bar in half.
      const { node } = mount(scheme);
      const track = node('[data-track="clip"]').getBoundingClientRect();
      const block = node("[data-clip-block]").getBoundingClientRect();
      // Fixture guard: this really is a full-length block.
      expect(Math.abs(block.left - track.left)).toBeLessThanOrEqual(0.5);
      expect(Math.abs(block.right - track.right)).toBeLessThanOrEqual(0.5);
      for (const edge of ["head", "tail"]) {
        const r = node(`[data-trim="${edge}"]`).getBoundingClientRect();
        const said = `the ${edge} handle spans ${r.left}-${r.right}; the track clips at ${track.left}-${track.right}`;
        expect(r.left, said).toBeGreaterThanOrEqual(track.left - 0.01);
        expect(r.right, said).toBeLessThanOrEqual(track.right + 0.01);
        expect(Math.round(r.width), said).toBe(4);
      }
    });
  }

  /**
   * Round on the side facing away from the block, flat on the side facing
   * into it, so each end reads as a bracket closing over the block rather
   * than as a pill. Both ends of every lane: the start and end rules are
   * separate, and a lane whose end is right says nothing about its start.
   */
  it("rounds each handle's outer corners and squares its inner ones", () => {
    const { node } = mountEdges("light");
    const ends = {
      "clip head": ['[data-track="clip"] [data-trim="head"]', "start"],
      "clip tail": ['[data-track="clip"] [data-trim="tail"]', "end"],
      "zoom start": ['[data-track="zoom"] .cap[data-cap="start"]', "start"],
      "zoom end": ['[data-track="zoom"] .cap[data-cap="end"]', "end"],
      "mask start": ['[data-track="mask"] .cap[data-cap="start"]', "start"],
      "mask end": ['[data-track="mask"] .cap[data-cap="end"]', "end"],
    } as const;
    for (const [name, [selector, side]] of Object.entries(ends)) {
      const s = getComputedStyle(node(selector));
      const corners = [
        s.borderTopLeftRadius,
        s.borderTopRightRadius,
        s.borderBottomRightRadius,
        s.borderBottomLeftRadius,
      ];
      expect(corners, `${name}: TL, TR, BR, BL`).toEqual(
        side === "start"
          ? ["3px", "0px", "0px", "3px"]
          : ["0px", "3px", "3px", "0px"],
      );
    }
  });

  it("hides every handle until the pointer is over its block", async () => {
    await page.viewport(1440, 860);
    const { edges, blocks } = mountEdges("light");
    // Parked away from the lanes, so nothing starts hovered.
    await userEvent.hover(document.querySelector("header") as HTMLElement);
    for (const [lane, edge] of Object.entries(edges)) {
      expect(hidden(edge), `${lane}'s handle shows at rest`).toBe(true);
    }
    for (const lane of ["clip", "zoom", "mask"] as const) {
      await userEvent.hover(blocks[lane]);
      expect(
        shown(edges[lane]),
        `${lane}'s handle stays hidden under the pointer`,
      ).toBe(true);
      // And only its own: hovering one block shows no other lane's.
      for (const other of ["clip", "zoom", "mask"] as const) {
        if (other !== lane)
          expect(
            hidden(edges[other]),
            `hovering ${lane} shows ${other}'s handle`,
          ).toBe(true);
      }
    }
  });

  for (const lane of ["zoom", "mask"] as const) {
    it(`rings a selected ${lane} without bulging past its handles`, () => {
      const { node, blocks } = mountEdges("light");
      const block = blocks[lane];
      block.setAttribute("data-selected", "");
      const b = block.getBoundingClientRect();
      const ring = getComputedStyle(block, "::before");
      // No outline: that stands off all four sides equally, which is how the
      // ends came to bulge 3px past the handles.
      expect(getComputedStyle(block).outlineStyle).toBe("none");
      expect(ring.borderTopWidth, "the ring paints nothing").toBe("2px");
      expect(parse(ring.borderTopColor)).toEqual(token("--ink"));
      // The ring's box, from the block's own rect and the pseudo's insets.
      const r = {
        left: b.left + Number.parseFloat(ring.left),
        right: b.right - Number.parseFloat(ring.right),
        top: b.top + Number.parseFloat(ring.top),
        bottom: b.bottom - Number.parseFloat(ring.bottom),
      };
      const start = node(
        `[data-track="${lane}"] .cap[data-cap="start"]`,
      ).getBoundingClientRect();
      const end = node(
        `[data-track="${lane}"] .cap[data-cap="end"]`,
      ).getBoundingClientRect();
      const said = `ring ${r.left}-${r.right} x ${r.top}-${r.bottom}; handles ${start.left} / ${end.right}; block ${b.left}-${b.right} x ${b.top}-${b.bottom}`;
      // The ends close on the handles' outer edges...
      expect(Math.abs(r.left - start.left), said).toBeLessThanOrEqual(0.5);
      expect(Math.abs(r.right - end.right), said).toBeLessThanOrEqual(0.5);
      // ...and the top and bottom sit where they are drawn: inside the
      // track, which clips at its own box. The outline this replaced stood
      // 3px above and below, where the track cut both sides away unseen.
      const track = node(`[data-track="${lane}"]`).getBoundingClientRect();
      expect(r.top, said).toBeGreaterThanOrEqual(track.top - 0.01);
      expect(r.bottom, said).toBeLessThanOrEqual(track.bottom + 0.01);
    });
  }

  it("shows a selected zoom's handles, for a screen with no hover", async () => {
    const { edges, blocks } = mountEdges("light");
    await userEvent.hover(document.querySelector("header") as HTMLElement);
    expect(hidden(edges.zoom)).toBe(true);
    blocks.zoom.setAttribute("data-selected", "");
    expect(shown(edges.zoom), "a selected zoom hides its handles").toBe(true);
  });

  it("keeps a handle showing for the length of its drag", async () => {
    const { edges } = mountEdges("light");
    await userEvent.hover(document.querySelector("header") as HTMLElement);
    // `armDrag` marks the pressed element; the pointer is off the block, as
    // it is when a drag outruns the block it started on.
    edges.mask.dispatchEvent(
      new PointerEvent("pointerdown", { bubbles: true, clientX: 10 }),
    );
    expect(edges.mask.hasAttribute("data-dragging")).toBe(true);
    expect(shown(edges.mask), "the handle vanished mid-drag").toBe(true);
    window.dispatchEvent(
      new PointerEvent("pointerup", { bubbles: true, clientX: 10 }),
    );
    expect(edges.mask.hasAttribute("data-dragging")).toBe(false);
    expect(hidden(edges.mask), "the handle outlived its drag").toBe(true);
  });
});

describe("the playhead spans the lanes and nothing else", () => {
  /* At the take's last frame the playhead sits on the axis's right edge:
     its 2px line starts where the track ends, and half its knob hangs past.
     `#timeline` is a scroll container (`overflow-x: auto`), which clips at
     its own box, so until 2026-09-22 playing to the end hid the line
     entirely and cut the knob in half. Asked of hit-testing and the clip
     box, in both themes' layout, at both ends of the take. */
  for (const [where, at] of [
    ["end", 1],
    ["start", 0],
  ] as const) {
    it(`keeps the whole playhead visible at the take's ${where}`, () => {
      const { node, model } = mount("light");
      renderTimeline(
        node("#timeline"),
        model,
        {
          viewport: fitAll(model.durationMs),
          selection: null,
          positionMs: model.durationMs * at,
          refusal: null,
          snapping: true,
        },
        {
          onSelect: vi.fn(),
          onSeek: vi.fn(),
          onSeekStart: vi.fn(),
          onGesture: vi.fn(),
          onViewport: vi.fn(),
          onSnapping: vi.fn(),
          onSplit: vi.fn(),
          onRestorePiece: vi.fn(),
          onOpenJoin: vi.fn(),
        },
      );
      const clip = node("#timeline").getBoundingClientRect();
      const track = node('[data-track="clip"]').getBoundingClientRect();
      const line = node("[data-playhead]").getBoundingClientRect();
      const grab = node("[data-playhead-grab]");
      const g = grab.getBoundingClientRect();
      // Fixture guard: the playhead really is at the track's edge.
      const edge = at === 1 ? track.right : track.left;
      expect(
        Math.abs(line.left - edge),
        "the playhead is not at the edge",
      ).toBeLessThan(1);
      const said = `line ${line.left}-${line.right}, knob ${g.left}-${g.right}, clip box ${clip.left}-${clip.right}`;
      expect(line.left, said).toBeGreaterThanOrEqual(clip.left);
      expect(line.right, said).toBeLessThanOrEqual(clip.right);
      expect(g.left, said).toBeGreaterThanOrEqual(clip.left);
      expect(g.right, said).toBeLessThanOrEqual(clip.right);
      // And the knob's centre is still something a press reaches, which a
      // clipped one is not.
      expect(
        document.elementFromPoint(
          (g.left + g.right) / 2,
          (g.top + g.bottom) / 2,
        ),
        `the knob's centre is not hit-testable at the ${where}: ${said}`,
      ).toBe(grab);
    });
  }

  it("starts at the ruler, not above the line that sits over it", () => {
    // This asked its question against `[data-fit]` when Fit lived in
    // `.timeline`'s own bar, then against that bar's hover report when Fit
    // moved to `#transport`. Both are gone from `.timeline` now — the
    // report became a status-row card on 2026-09-22 — so it asks the same
    // question of the one thing still drawn above the ruler INSIDE the
    // positioned box the axis is measured against: the provisional-timing
    // line a bundle-less take carries.
    //
    // That line is why the fixture below has no bundle. With one, the line
    // is not drawn at all and the axis starting at the top of the box
    // would clear this comparison trivially, saying nothing about whether
    // it can ride up over something.
    const scene = readonlyScene();
    const model = buildLaneModel({
      scene,
      view: buildTimelineView({ scene, bundle: null, resolved: null }),
      bundle: null,
      resolved: null,
      hoverReport: null,
    });
    // Fixture guard: this really is the provisional case, or there is no
    // line above the ruler to be wrong about.
    expect(
      model.timeSource,
      "the fixture rendered as measured, so no line is drawn above the ruler",
    ).toBe("captured");
    const { rect } = mount("light", null, 0, model);
    const line = rect(".timeline > .muted");
    expect(
      line.height,
      "the provisional-timing line did not render with height",
    ).toBeGreaterThan(0);
    expect(rect("[data-axis]").top).toBeGreaterThanOrEqual(line.bottom);
    // And it starts exactly at the ruler, which is the positive half: an
    // axis positioned against `.timeline` rather than `.lanes` would sit
    // at the top of the block, above both.
    expect(rect("[data-axis]").top).toBeCloseTo(rect("[data-ruler]").top, 0);
  });

  it("stops at the last lane, not across the refusal line", () => {
    // With no refusal the line is `hidden` and contributes no height, so an
    // axis that ran the full block would clear this assertion anyway. The
    // refusal is what gives the test something to be wrong about.
    const { rect } = mount(
      "light",
      "A step cannot be dragged before the take.",
    );
    const rows = document.querySelectorAll("[data-lane]");
    const bottom = rows[rows.length - 1];
    if (!bottom) throw new Error("no lanes rendered");
    const last = bottom.getBoundingClientRect();
    const line = rect("[data-refusal]");
    // Guard the fixture: if the refusal ever stopped taking space, the
    // assertion below would be vacuous again rather than failing.
    expect(line.height).toBeGreaterThan(0);
    expect(rect("[data-axis]").bottom).toBeLessThanOrEqual(last.bottom + 1);
    expect(rect("[data-axis]").bottom).toBeLessThanOrEqual(line.top);
  });
});

describe("the status row", () => {
  it("takes no space when every panel in it is empty", () => {
    const { node } = mount("light");
    expect(node("#status").getBoundingClientRect().height).toBe(0);
    expect(getComputedStyle(node("#status")).display).toBe("none");
  });

  it("still shows once a card in it has something to say", () => {
    const { node } = mount("light", null, 40);
    expect(node("[data-status-standin]").textContent).not.toBe("");
    expect(getComputedStyle(node("#status")).display).not.toBe("none");
    expect(node("#status").getBoundingClientRect().height).toBeGreaterThan(0);
  });

  /**
   * A status entry paints `--card` and `--radius-card` — it IS a card, the
   * same as `#dock`, `#inspector` and `#rail` — so it lines up with the
   * shell's outer edges: the stage's on the left and the last card's on
   * the right — the panel's while it is open, the rail's once it closes
   * (the rail sits between the stage and the panel since 2026-10-07):
   * cards line up with cards. `#status`'s own padding used to inset it
   * 16px from both edges while every other card sat flush, which read as
   * the status row belonging to a different, narrower container. Mounts a
   * status entry (`mount`'s `statusPx` stand-in) rather than
   * asserting on `#status`'s own box, which is the thing that moved, not
   * the thing this is a claim about.
   */
  it("lines a status entry's edges up with the cards beside it", () => {
    const { rect } = mount("light", null, 40);
    document.body.style.transition = "none";
    const card = rect("[data-status-standin]");
    expect(card.left, "status card left vs main left").toBeCloseTo(
      rect("main").left,
      0,
    );
    // The premise: the panel is open and is past the rail, so the rail's
    // edge is not the right one to match.
    expect(rect("#inspector").width, "the panel is open").toBeGreaterThan(0);
    expect(rect("#inspector").right).toBeGreaterThan(rect("#rail").right);
    expect(card.right, "status card right vs panel right").toBeCloseTo(
      rect("#inspector").right,
      0,
    );
    // Closed, the rail is the last card, and the entry follows it.
    document.body.setAttribute("data-panel", "closed");
    expect(rect("#inspector").width, "the panel closed").toBe(0);
    expect(
      rect("[data-status-standin]").right,
      "status card right vs rail right, panel closed",
    ).toBeCloseTo(rect("#rail").right, 0);
  });
});

/* When the header wraps, the actions card — Export with it — stays in the
   right-hand corner. `header` is `justify-content: space-between`, and a
   wrapped line holding one item puts that item at the line's START, so
   until the final review of 2026-10-07 a long name sent Export to the
   bottom-LEFT, under Back, the opposite corner from where a primary
   action lives and from where it sits on every unwrapped header.

   At 800x800, not the review's 951x800: `#name` is capped at 380px, so
   the take card tops out near 600px, and with the actions card's ~233 and
   the 16px seam the row needs about 847px — under 951's 919px header, so
   at 951 no name wraps it (measured 2026-10-07: take 598, actions 233).
   800 leaves a 768px header, nearly 80px short of the row, so the wrap
   does not hinge on this machine's glyph widths. The premise is asserted
   anyway: the header really wrapped (the actions card's top is below the
   take card's bottom), or "at the right" holds for the unwrapped row it
   was always right on. */
describe("the header keeps Export in the right-hand corner", () => {
  it("puts the wrapped actions card at the header's right edge", async () => {
    await page.viewport(800, 800);
    const { node, rect } = mount("light");
    const name = node("#name") as HTMLInputElement;
    name.value =
      "Checkout flow with saved cards, coupon codes and a guest account, take seven";
    // A hand-written name, so its length is checked rather than trusted.
    expect(name.value.length).toBeGreaterThanOrEqual(76);
    node("#take-meta").textContent = "0:09 · 3840 × 2160";
    const take = rect("header .head-take");
    const actions = rect("header .actions");
    const header = rect("header");
    const layout = `take ${take.left}–${take.right} (${take.top}–${take.bottom}), actions ${actions.left}–${actions.right} (${actions.top}–${actions.bottom}), header ${header.left}–${header.right}`;
    expect(
      actions.top,
      `the header did not wrap, so this asserts nothing: ${layout}`,
    ).toBeGreaterThanOrEqual(take.bottom);
    expect(
      actions.right,
      `the wrapped actions card left the right edge: ${layout}`,
    ).toBeCloseTo(header.right, 0);
    expect(
      rect("#export-open").right,
      `Export is not in the right-hand corner: ${layout}`,
    ).toBeLessThanOrEqual(header.right);
    expect(
      rect("#export-open").left,
      `Export sits left of the header's middle: ${layout}`,
    ).toBeGreaterThan(header.left + header.width / 2);
  });
});

/**
 * The take-wide cards — the bundle banner, failures, the re-home report, the
 * take's notes — live in a popover off a header button since 2026-09-22. As
 * a row across the page they pushed the editor down by their own height, so
 * the layout an author was judging moved with every message.
 */
describe("the notes popover", () => {
  function failWith(node: (q: string) => HTMLElement): void {
    renderFailure(node("#failure"), {
      error: null,
      replaySentence: "The re-shoot could not reach your app.",
      captureSentence: null,
    } as never);
    renderNotesButton(node("#notes-open"), node("#notes"));
  }

  it("keeps the button out of the header while there is nothing to say", () => {
    const { node } = mount("light");
    renderNotesButton(node("#notes-open"), node("#notes"));
    expect(getComputedStyle(node("#notes-open")).display).toBe("none");
    expect(getComputedStyle(node("#notes")).display).toBe("none");
  });

  it("moves nothing on the page when a card arrives", () => {
    const { node, rect } = mount("light");
    const rows = ["header", "main", "#preview", "#dock", "#inspector"];
    const before = rows.map((q) => rect(q).toJSON());
    failWith(node);
    // Premise: the card is really there, and the button that leads to it
    // is really up.
    node("#failure [data-replay-failure]");
    expect(getComputedStyle(node("#notes-open")).display).not.toBe("none");
    expect(rows.map((q) => rect(q).toJSON())).toEqual(before);
  });

  for (const scheme of ["light", "dark"] as const) {
    it(`paints the button red for a failure, in ${scheme}`, () => {
      const { node } = mount(scheme);
      failWith(node);
      const button = node("#notes-open");
      expect(button.getAttribute("data-level")).toBe("error");
      const style = getComputedStyle(button);
      expect(parse(style.backgroundColor)).toEqual(token("--error-soft"));
      expect(parse(style.color)).toEqual(token("--error"));
      expect(node("#notes-open [data-count]").textContent).toBe("1");
    });
  }

  /* The level survives the pointer. The header card's quiet hover
     (`.head-card .btn-icon:not(:disabled):hover`, four classes) out-ranked
     the level rules (three and an element), so pointing at a red notes
     button turned it grey — the one sign on the page that a failure is
     waiting went quiet exactly when the author reached for it. Found in
     the final review of 2026-10-07.

     Hovered for real, both levels and both themes. The premise beside
     each: the pointer really is on the button (`:hover` matches), or a
     hover that never landed would read the rest state, which was always
     right. */
  for (const scheme of ["light", "dark"] as const) {
    for (const [level, soft, ink] of [
      ["error", "--error-soft", "--error"],
      ["warn", "--warn-soft", "--warn"],
    ] as const) {
      it(`keeps the ${level} tint on the notes button under the pointer, in ${scheme}`, async () => {
        await page.viewport(1440, 860);
        const { node, surface } = mount(scheme);
        if (level === "error") {
          failWith(node);
        } else {
          renderTakeNotes(node("#take-notes"), {
            notices: ["2 recorded pauses could not be placed."],
            hoverReport: null,
          });
          renderNotesButton(node("#notes-open"), node("#notes"));
        }
        const button = node("#notes-open");
        expect(button.getAttribute("data-level")).toBe(level);
        await userEvent.hover(button);
        expect(
          button.matches(":hover"),
          "the pointer is not on the notes button",
        ).toBe(true);
        const card = surface("body", "header .actions");
        // `.btn`'s background transitions (120ms); wait for the fill to
        // settle on a value rather than for a duration.
        await vi.waitFor(() =>
          expect(
            surface("body", "header .actions", "#notes-open"),
            `the ${level} notes button lost its tint under the pointer in ${scheme}`,
          ).toEqual(over(token(soft), card)),
        );
        expect(
          parse(getComputedStyle(button).color),
          `the ${level} notes button lost its ink under the pointer in ${scheme}`,
        ).toEqual(token(ink));
      });
    }
  }

  it("paints the button amber for a take note", () => {
    const { node } = mount("light");
    renderTakeNotes(node("#take-notes"), {
      notices: ["2 recorded pauses could not be placed."],
      hoverReport: null,
    });
    renderNotesButton(node("#notes-open"), node("#notes"));
    const style = getComputedStyle(node("#notes-open"));
    expect(node("#notes-open").getAttribute("data-level")).toBe("warn");
    expect(parse(style.backgroundColor)).toEqual(token("--warn-soft"));
    expect(parse(style.color)).toEqual(token("--warn"));
  });

  it("opens under its button, inside the window, over the page", () => {
    const { node, rect } = mount("light");
    failWith(node);
    const before = rect("main").toJSON();
    node("#notes-open").click();
    const notes = node("#notes");
    expect(notes.matches(":popover-open")).toBe(true);
    const panel = rect("#notes");
    const button = rect("#notes-open");
    // Premise: it drew a real box holding the card.
    expect(panel.height).toBeGreaterThan(0);
    expect(rect("#failure [data-replay-failure]").height).toBeGreaterThan(0);
    expect(panel.top, "popover top vs button bottom").toBeGreaterThanOrEqual(
      button.bottom,
    );
    expect(panel.top - button.bottom).toBeLessThan(20);
    expect(panel.right).toBeCloseTo(button.right, 0);
    expect(panel.left).toBeGreaterThanOrEqual(0);
    expect(rect("main").toJSON()).toEqual(before);
    notes.hidePopover();
  });

  it("closes the popover when its last card goes", () => {
    const { node } = mount("light");
    failWith(node);
    node("#notes-open").click();
    expect(node("#notes").matches(":popover-open")).toBe(true);
    node("#failure").replaceChildren();
    renderNotesButton(node("#notes-open"), node("#notes"));
    expect(node("#notes").matches(":popover-open")).toBe(false);
    expect(getComputedStyle(node("#notes-open")).display).toBe("none");
  });
});

describe("the lanes are tints in light, not slabs", () => {
  it("tints the light lanes and writes on them in dark ink", () => {
    mount("light");
    for (const lane of LANE_TOKENS) {
      expect(
        luminance(token(lane)),
        `${lane} is still a dark slab`,
      ).toBeGreaterThan(0.4);
      expect(luminance(token(`${lane}-ink`))).toBeLessThan(
        luminance(token(lane)),
      );
    }
  });

  for (const scheme of ["light", "dark"] as const) {
    for (const lane of ["clip", "zoom"] as const) {
      it(`edges the ${lane} segment in its lane's glyph colour in ${scheme}`, () => {
        const scene = zoomedScene();
        const bundle = proceduralBundle();
        const resolved = resolvePlan(planScene(scene), bundle, scene);
        const model = buildLaneModel({
          scene,
          view: buildTimelineView({ scene, bundle, resolved }),
          bundle,
          resolved,
          hoverReport: null,
        });
        const { node } = mount(scheme, null, 0, model);
        const seg = node(`[data-track="${lane}"] .seg`);
        // The premise: a clamped segment draws its own warning ring over
        // this edge, so the colour below would be measuring that instead.
        expect(seg.dataset.clamped, `the ${lane} segment is clamped`).not.toBe(
          "true",
        );
        const shadow = getComputedStyle(seg).boxShadow;
        expect(shadow).toContain("inset");
        expect(parse(shadow), `${lane} edge in ${scheme}: ${shadow}`).toEqual(
          token(`--lane-${lane}-glyph`),
        );
        expect(
          node(`[data-track="${lane}"]`).getBoundingClientRect().height,
        ).toBeCloseTo(30, 0);
      });
    }

    // The overlay is drawn over the PICTURE, which is a page of any
    // brightness, not over the dock. With the light lane fill (a pale pink)
    // as its tint it was a near-invisible wash on a light page; the
    // lane's glyph colour is deep in light and bright in dark, so it
    // shows on both a white and a black picture.
    it(`tints the mask overlay so it shows over white and over black in ${scheme}`, async () => {
      await page.viewport(1440, 860);
      mountMaskOverlay(scheme);
      const overlay = document.querySelector<HTMLElement>(
        '[data-overlay="mask"]',
      );
      if (!overlay) throw new Error("no mask overlay was drawn");
      const bg = parse(getComputedStyle(overlay).backgroundColor);
      expect(bg[3], "the overlay paints nothing").toBeGreaterThan(0);
      for (const [name, base] of [
        ["white", [255, 255, 255, 1]],
        ["black", [0, 0, 0, 1]],
      ] as [string, Rgba][]) {
        expect(
          contrast(over(bg, base), base),
          `the mask overlay over ${name} in ${scheme}: ${JSON.stringify(bg)}`,
        ).toBeGreaterThanOrEqual(1.2);
      }
    });
  }
});

describe("the transport's sizes", () => {
  it("draws play as a 36px ink disc beside 32px controls", () => {
    const { node } = mount("light");
    const play = node(
      "#transport [data-transport-play]",
    ).getBoundingClientRect();
    expect(play.width).toBeCloseTo(36, 0);
    const others = document.querySelectorAll<HTMLElement>(
      "#transport .transport-button:not([data-transport-play])",
    );
    expect(
      others.length,
      "no other transport buttons rendered",
    ).toBeGreaterThan(0);
    for (const button of others) {
      expect(button.getBoundingClientRect().width).toBeCloseTo(32, 0);
    }
    expect(
      parse(
        getComputedStyle(node("#transport [data-transport-play]"))
          .backgroundColor,
      ),
    ).toEqual(token("--secondary"));
  });
});

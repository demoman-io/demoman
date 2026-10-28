import {
  CURSOR_ART,
  CURSOR_UPRIGHT,
  drawCursor,
  type RenderTarget,
  type Vec,
} from "@demoman/compositor";
import { EXPORT_QUALITY_VALUES } from "@demoman/run-core";
import {
  CURSOR_POLISH_DEFAULTS,
  type CursorStyle,
  type SceneAspect,
  type SceneCursor,
  type SceneMotion,
} from "@demoman/scene-schema";
import type { ExportQualityChoice } from "@demoman/studio-protocol";
import {
  type BrandingControlsHandlers,
  type BrandingControlsProps,
  renderBrandingControls,
} from "../../src/branding/controls";
import { el, paintSliderFill } from "../../src/editor/dom";
import {
  type ExportReadiness,
  type ExportRun,
  exportButtonLabel,
  formatBytes,
  type SaveView,
} from "../../src/editor/export-run";
import {
  aspectNote,
  exportSummary,
  FILE_TYPE_TITLES,
  sizeReadout,
} from "../../src/editor/formats";
import {
  type HoverReport,
  hoverReportText,
} from "../../src/editor/hover-report";
import {
  type FileType,
  RECLAIMED_SPAN_REASON,
  violationReport,
} from "../../src/editor/jobs";
import type { StoredOutput } from "../../src/editor/ports";
import { formatClock } from "../../src/editor/preview";
import type { Sections } from "../../src/editor/sections";
import {
  comboSpoken,
  describeShortcut,
  isKeySymbol,
  keyLabel,
  SHORTCUT_LEGEND,
} from "../../src/editor/shortcuts";
import { whenLabel } from "../../src/library/state";
import type { OutputRow, RevealTarget } from "../../src/platform/types";
import { EXPORT_QUALITY_LABELS } from "../../src/settings/view";
import { setCodeText, withoutTicks } from "../../src/shell/code-spans";
import { type GlyphName, icon } from "../../src/shell/icons";
import {
  type RunsRoute,
  rerunAdvice,
  rerunLineOf,
  runsRouteClause,
  runsRouteLabel,
} from "../../src/shell/runs-link";
import { switchControl, switchRow } from "../../src/shell/switch";
import { withoutTip, withTip } from "../../src/shell/tooltip";

/**
 * The take's own warnings, as a card in the status row.
 *
 * Two things live here: the sentences `buildLaneModel` collects about the
 * take (a reclaimed motion span, a pace it could not place) and the hover
 * pass's verdict with its one action.
 *
 * Both were drawn INSIDE the dock until 2026-09-22 — the notices as a list
 * under the lanes, the hover report as a bar above the ruler. The dock is
 * the take's instrument panel and they are not instruments; a standing
 * sentence there competes with the lanes for the row it sits in and reads
 * as chrome that is always broken. The status row is where the editor's
 * other take-wide cards already are, so a reader looking for "what is wrong
 * with this take" now finds all of it in one place.
 *
 * Moved, emphatically not dropped: a hover pass that crashed, or a span the
 * harvest could not keep, is exactly the kind of fact this codebase has
 * repeatedly lost by making it quieter. What left the dock is the
 * placement, not the sentence.
 *
 * The one thing that did NOT move is `.refusal` — the last gesture the
 * resolver turned down. That answers a drag the author has this moment
 * made, on the lane they made it on, and it belongs where their eyes
 * already are.
 */
export function renderTakeNotes(
  root: HTMLElement,
  state: { notices: string[]; hoverReport: HoverReport | null },
): void {
  const said =
    state.hoverReport === null ? null : hoverReportText(state.hoverReport);
  if (state.notices.length === 0 && said === null) {
    root.replaceChildren();
    return;
  }
  // One card per note, not one card of lines. The whole list used to share a
  // single `.notice` box, which is why two notes ran together as one
  // sentence (2026-09-26) and why a reader could not tell where one ended:
  // a notification list separates its items, and a box per item is what does
  // that. `#take-notes` spaces them.
  const box = el("div", undefined);
  box.setAttribute("data-take-notes", "");
  for (const sentence of state.notices) {
    const line = el("div", "notice");
    setCodeText(line, sentence);
    line.setAttribute("data-take-notice", "");
    box.append(line);
  }
  if (said !== null) {
    const line = el("div", "notice", said);
    line.setAttribute("data-hover-report", "");
    box.append(line);
  }
  root.replaceChildren(box);
}

/**
 * Says only whether there is anything to look at yet.
 *
 * Until 2026-09-24 this also carried the "stale"/"failed" states —
 * `bundleStatus`, derived from the scene, the bundle's markers and a flag
 * stored on disk, with its own Regenerate button. `approximations.ts`
 * replaced that whole read: which edits the frames on screen do not show is
 * now a per-edit list derived from the frames' own `madeFrom` record, shown
 * as its own chip rather than folded into this banner. See that file, and
 * `staleness.ts`'s tombstone, for where the behaviour went. What is left
 * here is the one state that was never about staleness at all — a scene
 * with no frames yet.
 *
 * Since 2026-09-28 (plan 2, Task 7) the chip, `approximations.ts` and the
 * rebuild are all gone from the editor, and this banner says where frames
 * come from now: the Runs route, carrying the take's id. It said "No frames
 * yet — this demo has not been rebuilt" until then.
 */
export function renderBundleBanner(
  root: HTMLElement,
  state: { hasFrames: boolean; route: RunsRoute },
): void {
  if (state.hasFrames) {
    root.replaceChildren();
    return;
  }
  const box = el("div", "banner");
  const line = el("span");
  line.append(noFramesRoute(state.route));
  box.append(line);
  root.replaceChildren(box);
}

/**
 * "This take has no frames — re-shoot it in Runs", with the route as a link
 * carrying the take's id. One builder for the banner and the Export panel's
 * under-button line, so the two cannot say it differently (spec §7, "A take
 * has no frames": the editor names the Runs route with the take id). An
 * authored take is told to "run its script again in Runs" instead: Re-shoot
 * refuses it there (final review M1).
 *
 * The editor used to answer this state itself — Export rebuilt a frameless
 * take on the way out. With the rebuild gone, this route is the only way such
 * a take gets frames, so it is said wherever the missing frames are felt.
 */
function noFramesRoute(route: RunsRoute): DocumentFragment {
  const fragment = document.createDocumentFragment();
  fragment.append(
    "This take has no frames — ",
    runsRouteLink(route, runsRouteClause(route.authored)),
  );
  return fragment;
}

/**
 * A link to this take's Runs page, marked `[data-runs-route]` so `main.ts`'s
 * delegated click handler takes a plain click over and leaves only after
 * the writes this page still owes (`leaveAfterOwedWrites`). Every route to
 * Runs the editor draws is built here, so none can miss the mark.
 */
function runsRouteLink(route: RunsRoute, text: string): HTMLElement {
  // The platform's answer (`nav.rerun`): a link where there is a Runs page,
  // a line naming the agent call where there is not. A `line` is text, not
  // a link, so it carries no `data-runs-route` for the click handler and
  // ignores the label this call site wanted.
  if (route.rerun.kind === "line") {
    const line = el("span");
    setCodeText(line, route.rerun.text);
    line.setAttribute("data-rerun-line", "");
    return line;
  }
  const link = el("a", undefined, text);
  link.setAttribute("href", route.rerun.href);
  link.setAttribute("data-runs-route", "");
  return link;
}

/**
 * The ways this editor tells an author something went wrong.
 *
 * They are different in kind and are rendered as such. `replaySentence`
 * describes why the last *re-shoot* stopped (a rebuild, before 2026-09-28,
 * when it ran from this page) — and persists until a later run succeeds,
 * because it stays true until then. `captureSentence` describes what the
 * *take itself* managed to record — a different fact again, since a take's
 * motion recording can degrade whether or not any re-shoot ever ran. `error` describes the *last action* the author
 * took and is transient: the next successful command clears it.
 *
 * `replaySentence` and `captureSentence` render as separate lines, never
 * concatenated: a scene whose replay was refused AND whose screencast
 * failed has two distinct things to say, and either can be true without the
 * other, so each gets its own independent block below rather than one
 * nested inside the other.
 *
 * `renderError` is another one and is about the frames too: an export that
 * never started. It needs saying separately because the Export button has
 * already been put back — without a sentence the author would see a button
 * that simply refused, once, for no stated reason.
 *
 * Rendering none of these was the state this editor shipped in until now,
 * which made an editor whose whole premise is refusing to fail silently do
 * exactly that. All are plain text rather than a toast, for the same reason
 * the detail-violation report is: an author who was not looking at the
 * moment it flashed past has no way to recover it.
 */
export function renderFailure(
  root: HTMLElement,
  failure: {
    error: string | null;
    replaySentence: string | null;
    /** Whether the stop the sentence describes was a non-breakage. Drives the
     *  headline only — the sentence itself is already phrased for it. */
    replayRecoverable?: boolean;
    /** What the take's own motion recording managed to capture, or null when
     *  it has nothing to say. Independent of `replaySentence` — see this
     *  function's docblock — so it is rendered whether or not that sentence
     *  is present. */
    captureSentence: string | null;
    renderError?: string | null;
    /** A composite the preview could not draw. Page-local and transient like
     *  `renderError`, and about the picture on this page rather than about
     *  the take -- so it is its own box, not folded into either. */
    previewError?: string | null;
    /** Why the scene's logo could not be loaded (`loadLogo`). */
    logoLoadError?: string | null;
    /** Why the background's wallpaper or image could not be loaded: the
     *  frame paints the neutral gradient in its place. */
    wallpaperLoadError?: string | null;
    /**
     * The take itself could not be read — the scene deleted under the
     * editor, the extension reloaded with it open, the store refusing. The
     * one failure here that leaves nothing else on the page to render, so
     * it is the one `main.ts` draws on its own when `session.load()`
     * rejects rather than through a snapshot.
     */
    openError?: string | null;
    /**
     * Why the last Delete attempt did not remove this demo — a refusal
     * (`recording`/`rendering`/`sharing`, already turned into a sentence by
     * the caller) or a partial delete naming its failed step. Never set on
     * success, which navigates away instead. Its own box: a delete refusal
     * is not an edit (`error`), a render (`renderError`) or anything else
     * this failure band already has a headline for.
     */
    deleteError?: string | null;
    /** A page this one tried to leave for and did not: the Recordings page
     *  (Back, or after a delete) or the Runs page (any `[data-runs-route]`).
     *  `page` names it in the headline, so a refused Runs link is never
     *  announced as the Recordings page. */
    navigationError?: { page: string; reason: string } | null;
    /**
     * This take's route to Runs, drawn under `replaySentence`: that sentence
     * is about a re-shoot, and a re-shoot happens only on the run page, so
     * its advice ("run it again", "re-shoot it in Runs") needs a place the
     * author can reach from here (final review I3). `main.ts`'s render
     * always passes it; the stand-alone callers draw no replay sentence.
     */
    runsRoute?: RunsRoute | null;
  },
): void {
  const parts: HTMLElement[] = [];

  if (failure.openError != null) {
    const box = el("div", "notice");
    box.setAttribute("data-open-error", "");
    box.append(el("strong", undefined, "This take could not be opened"));
    box.append(el("div", undefined, failure.openError));
    parts.push(box);
  }

  if (failure.replaySentence !== null) {
    const box = el("div", "notice");
    box.setAttribute("data-replay-failure", "");
    // "Did not finish" is an accusation, and a cancel is the author's own
    // choice — the same `RECOVERABLE` signal that softens the sentence
    // underneath has to reach the headline too, or the two disagree in the
    // same box.
    //
    // Named for what ran. A stored status on an authored take came from its
    // script run (Runs refuses to re-shoot one), and the Runs link drawn
    // below already says "run its script again" for it.
    const ran =
      failure.runsRoute?.authored === true ? "script run" : "re-shoot";
    box.append(
      el(
        "strong",
        undefined,
        failure.replayRecoverable === true
          ? `The last ${ran} stopped early`
          : `The last ${ran} did not finish`,
      ),
    );
    box.append(el("div", undefined, failure.replaySentence));
    if (failure.runsRoute != null) {
      const line = el("div");
      line.setAttribute("data-replay-runs-route", "");
      line.append(
        runsRouteLink(
          failure.runsRoute,
          runsRouteLabel(failure.runsRoute.authored),
        ),
      );
      box.append(line);
    }
    parts.push(box);
  }

  if (failure.captureSentence != null) {
    const box = el("div", "notice");
    box.setAttribute("data-capture-note", "");
    box.append(el("strong", undefined, "What this take recorded"));
    box.append(el("div", undefined, failure.captureSentence));
    parts.push(box);
  }

  if (failure.renderError != null) {
    const box = el("div", "notice");
    box.setAttribute("data-render-error", "");
    box.append(el("strong", undefined, "The export did not start"));
    box.append(el("div", undefined, failure.renderError));
    parts.push(box);
  }

  if (failure.previewError != null) {
    const box = el("div", "notice");
    box.setAttribute("data-preview-error", "");
    box.append(el("strong", undefined, "The preview stopped"));
    box.append(el("div", undefined, failure.previewError));
    parts.push(box);
  }

  if (failure.logoLoadError != null) {
    const box = el("div", "notice");
    box.setAttribute("data-logo-load-error", "");
    box.append(el("strong", undefined, "The logo could not be loaded"));
    box.append(el("div", undefined, failure.logoLoadError));
    parts.push(box);
  }

  if (failure.wallpaperLoadError != null) {
    const box = el("div", "notice");
    box.setAttribute("data-wallpaper-load-error", "");
    box.append(
      el("strong", undefined, "The background image could not be loaded"),
    );
    box.append(el("div", undefined, failure.wallpaperLoadError));
    parts.push(box);
  }

  if (failure.error !== null) {
    const box = el("div", "notice");
    box.setAttribute("data-action-error", "");
    box.append(el("strong", undefined, "That edit did not go through"));
    box.append(el("div", undefined, failure.error));
    parts.push(box);
  }

  if (failure.deleteError != null) {
    const box = el("div", "notice");
    box.setAttribute("data-delete-error", "");
    box.append(el("strong", undefined, "This demo was not deleted"));
    box.append(el("div", undefined, failure.deleteError));
    parts.push(box);
  }

  if (failure.navigationError != null) {
    const box = el("div", "notice");
    box.setAttribute("data-navigation-error", "");
    box.append(
      el(
        "strong",
        undefined,
        `The ${failure.navigationError.page} did not open`,
      ),
    );
    box.append(el("div", undefined, failure.navigationError.reason));
    parts.push(box);
  }

  root.replaceChildren(...parts);
}

/**
 * The Background panel. The controls live in `src/branding/controls.ts`,
 * which the Settings page's Brand kit section mounts too — one set of
 * controls, so the kit and a demo cannot be edited two different ways.
 */
export function renderBranding(
  root: HTMLElement,
  props: BrandingControlsProps,
  handlers: BrandingControlsHandlers,
): void {
  renderBrandingControls(root, props, handlers);
}

export interface CursorHandlers {
  /** Commits one field. One undo entry per call. */
  onCursor(patch: Partial<SceneCursor>): void;
  /**
   * The live look while a slider is being dragged.
   *
   * Sliders commit on `change`, as the zoom slider does, because listening
   * on `input` would push an undo entry per animation frame of a drag. This
   * is how the preview still moves under the author's hand: `main.ts` layers
   * the patch over the scene's own block when it composes, and drops it on
   * `onCursor`, when the real command lands. There is deliberately no `null`
   * here — `onCursorPreviewEnd` is how a gesture that commits nothing says
   * so, and a nullable parameter nothing ever passes `null` to is a branch
   * no caller exercises.
   *
   * It must NOT re-render this panel: it fires from a slider's `input`, and
   * replacing that `<input type="range">` mid-drag ends Blink's implicit
   * pointer capture and the drag with it. See `main.ts`'s `previewCursor`.
   */
  onCursorPreview(patch: Partial<SceneCursor>): void;
  /**
   * The gesture is over and no commit is coming, so the override has to go.
   *
   * `onCursor` is not enough on its own: Blink dispatches `change` on a
   * range input only when the released value differs from the one the drag
   * began at, so a drag that returns to its starting value releases with the
   * preview still layered and nothing left to drop it. See
   * `main.ts`'s `endCursorPreview` for what that cost.
   *
   * Same constraint as `onCursorPreview`, for a sharper reason: it must not
   * re-render this panel, because it fires from `pointerup` and `change` has
   * not been dispatched yet. Detaching the input here would swallow the
   * commit on every drag that has one.
   */
  onCursorPreviewEnd(): void;
  /**
   * The panel's Camera rows: the document's `motion` block, one field per
   * call, one undo entry per call. The three below are the cursor's three
   * for that block, under the same constraints — the preview and its end
   * must not re-render this panel, for the same drag-killing reason.
   */
  onMotion(patch: Partial<SceneMotion>): void;
  onMotionPreview(patch: Partial<SceneMotion>): void;
  onMotionPreviewEnd(): void;
}

const STYLE_LABELS: Record<CursorStyle, string> = {
  light: "Light",
  dark: "Dark",
  touch: "Touch",
};

/** How far right of ink-centred a preview sits, as a fraction of its art
 *  box: 1.5px at the default size (1/16 of its 24px box). Chosen by eye
 *  in the real editor on 2026-09-22, stepping down from 3px and then 2px,
 *  both of which read too far right. The touch circle is symmetric and
 *  needs none. */
const OPTICAL_NUDGE: Record<CursorStyle, number> = {
  light: 1 / 16,
  dark: 1 / 16,
  touch: 0,
};

/**
 * Where to put a style preview's draw point so the shape lands centred in
 * its button.
 *
 * `hotspot` says where `drawCursor`'s draw point sits inside the shape's own
 * unit box — the arrow's tip at its top-left, the touch circle's centre —
 * and `ink` says what part of that box is actually painted, so the painted
 * shape's centre is `(inkCentre - hotspot) * size` away from the draw point.
 * Offsetting by the hotspot alone, as this did until 2026-09-20, put the
 * ARROW's tip at the button's centre and pushed the touch circle clean off
 * the top-left edge of its own button. Centring the whole unit box, as it
 * did until 2026-09-22, left the arrow — which fills only the box's left
 * 56% — sitting visibly left of centre.
 *
 * Centring the ink box is still not centring the arrow to the eye: its
 * weight is the straight left edge and the tip, with a thin tail out to the
 * right, so a box-centred arrow reads left. `OPTICAL_NUDGE` moves it right
 * by a fraction of its box, so the correction scales with the Size slider.
 *
 * Pure and exported so the node lane can check the arithmetic: the canvas
 * path itself is only reachable in the browser lane (see the note on
 * `stylePreview` below).
 */
export function stylePreviewOrigin(
  style: CursorStyle,
  drawn: number,
  canvasSize: number,
): Vec {
  const { height, hotspot, ink } = CURSOR_ART[style];
  const boxSize = height * drawn;
  const centre = {
    x: (ink.min.x + ink.max.x) / 2,
    y: (ink.min.y + ink.max.y) / 2,
  };
  return {
    x: canvasSize / 2 - (centre.x - hotspot.x - OPTICAL_NUDGE[style]) * boxSize,
    y: canvasSize / 2 - (centre.y - hotspot.y) * boxSize,
  };
}

/** The preview canvas draws the cursor smaller than the video does — this is
 *  the multiplier from a scaled cursor height to the preview's own "drawn"
 *  units. 0.6 keeps the default scale comfortably inside the button; see
 *  `stylePreviewDrawn` for why it alone is not enough at the top of the
 *  slider. */
const PREVIEW_SCALE = 0.6;

/**
 * How large a style preview draws, in the same units `drawCursor` takes as
 * its `scale` parameter — capped so the shape's own nominal box never
 * exceeds the preview's fixed canvas, whatever the slider says.
 *
 * At `scale = 2` (the slider's maximum), `art.height * scale * PREVIEW_SCALE`
 * is `40 * 2 * 0.6 = 48px` against this panel's 44px canvas — no placement
 * could fit a box that size, regardless of centring: `stylePreviewOrigin`
 * centres correctly, the box itself did not fit, which is what left a
 * ~2px clip on light/dark's preview at the slider's maximum until
 * 2026-09-20. Capping at `canvasSize / height` only binds above roughly
 * scale 1.83, so the default (`scale = 1`) and the whole lower half of the
 * slider are unaffected.
 *
 * The cap binds identically for all three styles, `touch` included: there is
 * no hotspot term here, and `CURSOR_ART` gives every style `height: 40`, so
 * `min(scale * 0.6, canvasSize / 40)` is one number per scale. The hotspot
 * belongs to `stylePreviewOrigin`, which decides where the box is PUT; this
 * decides how big it is, and a box too large for the canvas is too large
 * wherever it is centred. One formula, no per-style branching, same as the
 * centring fix.
 *
 * Pure and exported for the same reason as `stylePreviewOrigin`: the node
 * lane can check the arithmetic even though the canvas itself is not
 * reachable there.
 */
export function stylePreviewDrawn(
  style: CursorStyle,
  scale: number,
  canvasSize: number,
): number {
  const clamped = Math.min(2, Math.max(0.5, scale));
  return Math.min(
    clamped * PREVIEW_SCALE,
    canvasSize / CURSOR_ART[style].height,
  );
}

/** A style button's own cursor, painted by the function that renders the
 *  video. A CSS approximation would be a fourth cursor shape, free to drift
 *  from the three that actually render — and showing the real one is the
 *  whole point of the control.
 *
 *  The `drawCursor` call below is not exercised by this package's node
 *  lane: jsdom has no 2D canvas context without the `canvas` npm package,
 *  which this repo deliberately does not install, so every node-lane run
 *  takes the `!ctx` fallback instead (`editor-view-panels.test.ts`'s "says
 *  so when a style button cannot paint its preview" pins that fallback). The
 *  real paint path only runs in a real browser — the browser lane covers
 *  it. Do not read the node suite as proof the three styles actually paint;
 *  `stylePreviewOrigin`'s and `stylePreviewDrawn`'s own tests are what the
 *  node lane can check. */
function stylePreview(style: CursorStyle, scale: number): HTMLCanvasElement {
  const size = 44;
  const canvas = el("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    // An extension page: `error` and above is what reaches the Errors list
    // on chrome://extensions, and a style button that painted no cursor is
    // a real fault. The button still renders, labelled and selectable.
    console.error(
      `the cursor panel could not paint its "${style}" preview: no 2D context`,
    );
    return canvas;
  }
  const drawn = stylePreviewDrawn(style, scale, size);
  drawCursor(
    ctx as unknown as OffscreenCanvasRenderingContext2D,
    stylePreviewOrigin(style, drawn, size),
    drawn,
    // Unpressed and upright: the button shows the shape, not a moment.
    CURSOR_UPRIGHT,
    style,
  );
  return canvas;
}

/**
 * Where one panel slider's three moments go. The cursor's sliders and the
 * camera's write to different blocks of the document, so the slider itself
 * is told only what to call; `cursorSlider` and `motionSlider` below say
 * which block.
 */
interface SliderWiring {
  /** `input`: the live look. Must not re-render the panel. */
  preview(value: number): void;
  /** `change`: the edit. One undo entry. */
  commit(value: number): void;
  /** A release that commits nothing. Must not re-render the panel. */
  end(): void;
}

function panelSlider(
  attr: string,
  label: string,
  value: number,
  min: number,
  max: number,
  readout: (v: number) => string,
  wiring: SliderWiring,
  disabled: boolean,
): HTMLElement {
  const row = el("div", "slider-row");
  const slider = el("input");
  slider.type = "range";
  slider.min = String(min);
  slider.max = String(max);
  slider.step = "0.05";
  slider.value = String(value);
  slider.disabled = disabled;
  slider.setAttribute(attr, "");
  slider.setAttribute("aria-label", label);
  const shown = el("span", "slider-value", readout(value));
  paintSliderFill(slider);
  slider.addEventListener("input", () => {
    // Before the preview call below, so the track under the thumb is right
    // on the same frame the thumb moved rather than a frame behind it.
    paintSliderFill(slider);
    // The readout maintains itself, in place. `wiring.preview` deliberately
    // does not re-render this panel (it would kill the drag — see
    // `CursorHandlers`), so this line is the only thing that moves the
    // readout while the author is dragging. It was dead until that was
    // fixed: the re-render threw the readout away and built a new one.
    shown.textContent = readout(Number(slider.value));
    wiring.preview(Number(slider.value));
  });
  slider.addEventListener("change", () => wiring.commit(Number(slider.value)));
  // The release that commits NOTHING. Blink fires `change` only when the
  // released value differs from the one the drag started at, so a drag that
  // wanders and comes back to `value` ends here and nowhere else — without
  // this the override in `main.ts` survived the gesture that opened it.
  //
  // `value` is the drag's starting point and stays correct across gestures:
  // the panel is rebuilt on every commit (which is what makes this a fresh
  // `value`), and a release handled here deliberately does not rebuild it,
  // so the value it compares against is still the one on screen.
  //
  // Guarded rather than unconditional because a release that DOES commit is
  // followed by `change` microseconds later; dropping the override first
  // would put the old look back on the canvas for a frame.
  const endIfUncommitted = (): void => {
    if (Number(slider.value) === value) wiring.end();
  };
  slider.addEventListener("pointerup", endIfUncommitted);
  // A cancelled pointer — the gesture taken over by the browser, or the
  // pointer lost — ends the drag without a `pointerup`, so it needs its own
  // door. The same guard applies and nothing is assumed about what Blink
  // leaves in `slider.value`: if it restored the starting value, this ends
  // the preview; if it did not, `render`'s own `dropCursorPreview` does, at
  // the next render. Neither path leaves the override standing.
  slider.addEventListener("pointercancel", endIfUncommitted);
  // Label, readout, track — the grid's auto-placement reads source order,
  // so the first two take row one and the full-width track falls to row two.
  row.append(el("span", "control-label slider-label", label), shown, slider);
  return row;
}

const percent = (v: number): string => `${Math.round(v * 100)}%`;
const times = (v: number): string => `${v.toFixed(2)}x`;

function cursorSlider(
  attr: string,
  label: string,
  value: number,
  min: number,
  max: number,
  readout: (v: number) => string,
  field: "scale" | "motionBlur" | "tilt" | "clickBounce",
  handlers: CursorHandlers,
  disabled: boolean,
): HTMLElement {
  return panelSlider(
    attr,
    label,
    value,
    min,
    max,
    readout,
    {
      preview: (v) => handlers.onCursorPreview({ [field]: v }),
      commit: (v) => handlers.onCursor({ [field]: v }),
      end: () => handlers.onCursorPreviewEnd(),
    },
    disabled,
  );
}

/** A Camera row. Never disabled: the camera moves whether or not the
 *  pointer is drawn. */
function motionSlider(
  attr: string,
  label: string,
  value: number,
  field: "smoothness" | "blur",
  handlers: CursorHandlers,
): HTMLElement {
  return panelSlider(
    attr,
    label,
    value,
    0,
    1,
    percent,
    {
      preview: (v) => handlers.onMotionPreview({ [field]: v }),
      commit: (v) => handlers.onMotion({ [field]: v }),
      end: () => handlers.onMotionPreviewEnd(),
    },
    false,
  );
}

function cursorSwitch(
  attr: string,
  label: string,
  checked: boolean,
  field: "hidden" | "hideWhenIdle",
  handlers: CursorHandlers,
  disabled: boolean,
): HTMLElement {
  return switchRow(
    label,
    null,
    switchControl({
      key: field,
      checked,
      disabled,
      attrs: { [attr]: "" },
      onChange: (on) => handlers.onCursor({ [field]: on }),
    }),
  );
}

/**
 * The Cursor panel's controls: how the pointer is drawn, and how the camera
 * moves, for the whole demo.
 *
 * Hide comes first because it governs the pointer's rows — with it on, the
 * style buttons, the four sliders and the idle switch are genuinely
 * `disabled` rather than painted over. The Camera rows after them are not:
 * a hidden pointer still has a camera.
 *
 * The pointer's sliders sit together, then the switch that closes the
 * pointer's rows, so the Camera heading starts a group of the same shape —
 * sliders, then a switch.
 *
 * `motion` is the document's block resolved against `MOTION_DEFAULTS`
 * (`main.ts`'s `liveMotion`), so the rows always show what the render uses.
 * `tilt` and `clickBounce` are optional on the document and read their
 * defaults here, at the point of use, as the compositor does.
 */
export function renderCursor(
  root: HTMLElement,
  cursor: SceneCursor,
  motion: SceneMotion,
  handlers: CursorHandlers,
  /** A take filmed as a touch device (spec 2026-10-10 §5): drawn as taps,
   *  which read only `hidden` and `scale`, so only those are offered. */
  touch = false,
): void {
  const box = el("div");
  const off = cursor.hidden;

  box.append(
    cursorSwitch(
      "data-cursor-hidden",
      "Hide cursor",
      cursor.hidden,
      "hidden",
      handlers,
      false,
    ),
  );

  // One slider in either layout; only where it sits differs.
  const size = cursorSlider(
    "data-cursor-scale",
    "Size",
    cursor.scale,
    0.5,
    2,
    times,
    "scale",
    handlers,
    off,
  );
  if (touch) box.append(size);
  const styles = el("div", "cursor-styles");
  styles.setAttribute("role", "radiogroup");
  styles.setAttribute("aria-label", "Cursor style");
  if (off) styles.setAttribute("aria-disabled", "true");
  for (const style of ["light", "dark", "touch"] as const) {
    const button = el("button", "cursor-style");
    button.type = "button";
    button.disabled = off;
    button.setAttribute("role", "radio");
    button.setAttribute("data-cursor-style", style);
    button.setAttribute("aria-checked", String(cursor.style === style));
    button.setAttribute("aria-label", STYLE_LABELS[style]);
    button.title = STYLE_LABELS[style];
    button.append(stylePreview(style, cursor.scale));
    button.addEventListener("click", () => handlers.onCursor({ style }));
    styles.append(button);
  }
  if (!touch) box.append(el("div", "cursor-label", "Style"), styles);

  if (!touch)
    box.append(
      size,
      cursorSlider(
        "data-cursor-blur",
        "Motion blur",
        cursor.motionBlur,
        0,
        1,
        percent,
        "motionBlur",
        handlers,
        off,
      ),
      cursorSlider(
        "data-cursor-tilt",
        "Tilt",
        cursor.tilt ?? CURSOR_POLISH_DEFAULTS.tilt,
        0,
        1,
        percent,
        "tilt",
        handlers,
        off,
      ),
      cursorSlider(
        "data-cursor-bounce",
        "Click bounce",
        cursor.clickBounce ?? CURSOR_POLISH_DEFAULTS.clickBounce,
        0,
        2,
        times,
        "clickBounce",
        handlers,
        off,
      ),
      cursorSwitch(
        "data-cursor-idle",
        "Hide when not moving",
        cursor.hideWhenIdle,
        "hideWhenIdle",
        handlers,
        off,
      ),
    );

  box.append(
    el("div", "cursor-label camera-label", "Camera"),
    motionSlider(
      "data-motion-smoothness",
      "Smoothness",
      motion.smoothness,
      "smoothness",
      handlers,
    ),
    motionSlider(
      "data-motion-blur",
      "Camera blur",
      motion.blur,
      "blur",
      handlers,
    ),
    switchRow(
      "Follow cursor",
      null,
      switchControl({
        key: "motion-follow",
        checked: motion.follow,
        attrs: { "data-motion-follow": "" },
        onChange: (on) => handlers.onMotion({ follow: on }),
      }),
    ),
  );

  root.replaceChildren(box);
}

export interface ExportState {
  /** What is stored for the take: the extension's rows hold their bytes
   *  (`stored`), the studio's are files on disk (`file`). */
  outputs: OutputRow[];
  /** The file type this panel exports. Page-local; picked in this panel. */
  fileType: FileType;
  /** An MP4's quality, picked here or the Export quality setting; null or
   *  absent where the platform has none (no Quality row). */
  quality?: ExportQualityChoice | null;
  /** The scene's aspect, picked under the preview. Named here, not set. */
  aspect: SceneAspect;
  /** `targetFor(fileType, aspect, bundle, frame)` — the same target the
   *  preview scales. */
  target: RenderTarget;
  /** The recording's size: the frames' viewport, or the take's recorded one
   *  before any frames exist. For the size readout. */
  recording: { width: number; height: number };
  /** The deliverable's length after trim, for the summary. */
  durationMs: number;
  run: ExportRun;
  /** The last save's outcome, or null before any. */
  save: SaveView | null;
  /** Why the last Show in Finder / Show in folder press showed nothing,
   *  or null. Cleared by the next press and the next export. */
  revealError?: string | null;
  /** `sceneDigest` of the scene as it stands, for "made before your last edit". */
  currentDigest: string;
  /** Which of this panel's sections are open, for the life of the page, so
   *  a Recent exports section the author opened survives a re-render. */
  sections: Sections;
  /** Maps a violation's output instant to a beat label. See `beatLabelAt`. */
  beatAt: (outputTimeMs: number) => string | null;
  /** Whether the active bundle carries any `motionReclaimed` degradation —
   *  a range the storage lifecycle already overwrote to free space, before
   *  this export ever runs. Told here, ahead of the click, rather than only
   *  after in the per-output `unavailableSpans` report: an author about to
   *  render is better served by the warning before they spend the time than
   *  by an explanation afterward for a still they already watched. */
  hasReclaimedMotion: boolean;
  /** Whether there is anything to export. `noFrames` disables the button
   *  and draws the Runs route beneath it, carrying the take's id. */
  readiness: ExportReadiness;
  /** This take's route to Runs: the no-frames line under the button, and
   *  the reclaimed-motion advice. For a take WITH frames it used to be one
   *  quiet line here too ("Re-shoot this take in Runs", final review I3);
   *  since 2026-10-19 that way is held by Take info's Re-film row, so the
   *  panel is for exporting (the author). */
  runsRoute: RunsRoute;
}

/**
 * The export panel, top to bottom (spec 2026-09-23 §4): what the file will
 * be, the file type, one button that encodes and saves, what the save came
 * to, and the Recent exports list.
 *
 * The report is persistent and sits beside the output it belongs to. SP6
 * returns `detailViolations` rather than silently upscaling to hit a
 * resolution number, and putting them in a toast would undo that decision
 * one layer up: the author would learn about a quality cut only if they
 * happened to be looking.
 */
function exportProgressBar(): HTMLProgressElement {
  const bar = el("progress", "export-progress");
  bar.setAttribute("data-export-progress", "");
  bar.setAttribute("aria-label", "Export progress");
  return bar;
}

/** Busy, or nothing to export. One rule for the render and the patch. */
function exportDisabled(run: ExportRun, readiness: ExportReadiness): boolean {
  return run.phase !== "idle" || readiness.kind === "noFrames";
}

/**
 * Moves the Export button's label and the progress bar WITHOUT a render.
 *
 * Progress arrives per frame at whole-percent granularity, so a hundred-odd
 * times per export. Driving `render` from there rebuilt the whole inspector
 * that many times — and a render rebuilds the Cursor panel, taking the
 * `<input type="range">` a drag is riding with it, which is exactly the
 * hazard `render`'s own comment in `main.ts` describes: press Export, move
 * the rail to Cursor, start dragging Size, and the slider was torn out from
 * under the pointer inside the first percent, the gesture dead with no
 * `change` to follow. The two nodes progress actually owns are patched
 * instead.
 *
 * It owns the button's `disabled` between renders too, so it asks the same
 * question `renderExport` does: a frameless take's button stays disabled at
 * rest, or a patch would hand back as pressable a button whose reason is
 * still drawn beside it.
 *
 * Returns false when `root` carries no start button. That is not "the panel
 * is closed" — the caller only reaches here with the panel's own container
 * in hand — it is a panel that rendered without its own control, so the
 * caller says so rather than leaving a bar that never moves.
 */
export function patchExportProgress(
  root: HTMLElement,
  run: ExportRun,
  fileType: FileType,
  readiness: ExportReadiness,
): boolean {
  const start = root.querySelector<HTMLButtonElement>("[data-export-start]");
  if (start === null) return false;
  start.textContent = exportButtonLabel(run, fileType, readiness);
  start.disabled = exportDisabled(run, readiness);

  const bar = root.querySelector<HTMLProgressElement>("[data-export-progress]");
  if (run.phase !== "encoding" || run.total === 0) {
    // `renderExport` draws no bar in these states, so neither does this.
    bar?.remove();
    return true;
  }
  const live = bar ?? exportProgressBar();
  live.max = run.total;
  live.value = run.done;
  // The first tick carrying a total is where the bar appears: the render
  // that started the export drew none, `total` still being 0, and waiting
  // for another render is the thing this function exists to avoid.
  if (bar === null) start.closest(".control-actions")?.after(live);
  return true;
}

export function renderExport(
  root: HTMLElement,
  state: ExportState,
  handlers: {
    /** The button: encode, then save. */
    onExport(): void;
    onFileType(next: FileType): void;
    onQuality(next: ExportQualityChoice): void;
    onSaveAgain(refs: string[]): void;
    onReveal(target: RevealTarget): void;
  },
): void {
  const box = el("div");
  const busy = state.run.phase !== "idle";

  if (state.hasReclaimedMotion) {
    const notice = el(
      "p",
      "notice",
      "This export will use still frames where motion was reclaimed.",
    );
    notice.setAttribute("data-reclaimed-motion-notice", "");
    box.append(notice);
  }

  const summary = el(
    "p",
    "export-summary",
    exportSummary(state.fileType, state.durationMs),
  );
  summary.setAttribute("data-export-summary", "");
  const note = el("p", "muted", aspectNote(state.aspect));
  note.setAttribute("data-aspect-note", "");
  box.append(summary, note);
  const readout = el("p", "muted", sizeReadout(state.recording, state.target));
  readout.setAttribute("data-size-readout", "");
  box.append(readout);

  const typeRow = el("div", "control-row");
  typeRow.append(el("span", "control-label", "File type"));
  const types = el("div", "segmented");
  types.setAttribute("role", "radiogroup");
  types.setAttribute("aria-label", "File type");
  types.setAttribute("data-file-types", "");
  for (const value of ["mp4", "gif", "stills"] as const) {
    const button = el("button", "segment", FILE_TYPE_TITLES[value]);
    button.type = "button";
    button.setAttribute("role", "radio");
    button.setAttribute("data-file-type", value);
    button.setAttribute("aria-checked", String(value === state.fileType));
    // Locked while an export runs: the running job's type is already fixed,
    // and a control that moved would describe a file nobody is making.
    button.disabled = busy;
    button.addEventListener("click", () => handlers.onFileType(value));
    types.append(button);
  }
  typeRow.append(types);
  box.append(typeRow);

  // Only an MP4 has a quality; a GIF and stills have one size each.
  if (state.quality != null && state.fileType === "mp4") {
    const qualityRow = el("div", "control-row");
    qualityRow.append(el("span", "control-label", "Quality"));
    const qualities = el("div", "segmented");
    qualities.setAttribute("role", "radiogroup");
    qualities.setAttribute("aria-label", "Quality");
    qualities.setAttribute("data-export-qualities", "");
    for (const value of EXPORT_QUALITY_VALUES) {
      const button = el("button", "segment", EXPORT_QUALITY_LABELS[value]);
      button.type = "button";
      button.setAttribute("role", "radio");
      button.setAttribute("data-export-quality", value);
      button.setAttribute("aria-checked", String(value === state.quality));
      // Locked while an export runs, as the file type is.
      button.disabled = busy;
      button.addEventListener("click", () => handlers.onQuality(value));
      qualities.append(button);
    }
    qualityRow.append(qualities);
    box.append(qualityRow);
  }

  const start = el(
    "button",
    "btn btn-primary export-start",
    exportButtonLabel(state.run, state.fileType, state.readiness),
  );
  start.type = "button";
  start.setAttribute("data-export-start", "");
  start.setAttribute("data-readiness", state.readiness.kind);
  // Disabled for a frameless take too, and never alone: the line beneath
  // says why and where frames come from now.
  start.disabled = exportDisabled(state.run, state.readiness);
  start.addEventListener("click", handlers.onExport);
  const startRow = el("div", "control-actions");
  startRow.append(start);
  if (state.readiness.kind === "noFrames") {
    const line = el("p", "muted");
    line.setAttribute("data-export-no-frames", "");
    line.append(noFramesRoute(state.runsRoute));
    box.append(startRow, line);
  } else box.append(startRow);
  if (state.run.phase === "encoding" && state.run.total > 0) {
    const bar = exportProgressBar();
    bar.max = state.run.total;
    bar.value = state.run.done;
    box.append(bar);
  }

  if (state.save !== null) box.append(saveOutcomeRow(state.save, handlers));
  // Under the outcome row, not inside a file row: the press can come from
  // either, and Recent exports may be folded by the time it answers.
  if (state.revealError != null) {
    const line = el("p", "notice notice-warn", state.revealError);
    line.setAttribute("data-reveal-error", "");
    box.append(line);
  }

  // The files the outcome row describes, and what they came to: their
  // warnings under it, where the author is looking when the save lands.
  // By the save's own refs, not the newest row: a Download from Take info's
  // history saves an older export, and the newest one's warnings under it
  // would read as that file's. A row the re-list has not brought yet draws
  // nothing until it does. The studio's save says its warnings in its
  // summary sentence and names no rows. The history keeps them too, behind
  // a chip on each row (`renderExportHistory`).
  if (state.save?.kind === "saved") {
    for (const ref of state.save.outputRefs) {
      const row = state.outputs.find(
        (o) => o.kind === "stored" && o.output.ref === ref,
      );
      if (row?.kind === "stored") drawOutputReports(box, row.output, state);
    }
  }

  root.replaceChildren(box);
}

/** How many exports Take info lists before "Show all". */
export const HISTORY_SHOWN = 5;

/**
 * This take's exports, newest first, one row each with the way to reach the
 * file: Take info's Exports group. An export's warnings are said in full
 * when it is made, under the outcome row (`drawOutputReports`); here they
 * are one chip on its row that unfolds them (the author, 2026-10-19: a word
 * on the row, like Outdated, not the notices). Without it a reload, or an
 * export an agent made, left no surface saying the file has no logo or
 * frozen motion.
 * Was the export panel's Recent exports section until 2026-10-19. The
 * newest `HISTORY_SHOWN` are drawn until the author asks for all of them,
 * and the button says how many more there are.
 */
export function renderExportHistory(
  root: HTMLElement,
  state: HistoryState,
  handlers: {
    onDownload(ref: string): void;
    onReveal(target: RevealTarget): void;
    onShowAll(): void;
    onWarnings(key: string): void;
  },
): void {
  // Drawn into a fresh list and swapped in whole, so a re-render replaces
  // the rows rather than stacking a second copy under the first.
  const list = document.createDocumentFragment();
  const shown = state.showAll
    ? state.outputs
    : state.outputs.slice(0, HISTORY_SHOWN);
  for (const entry of shown) {
    // One block per export, the blocks a hairline apart: the rows ran
    // together as one list of facts (the author, 2026-10-19).
    const item = el("div", "output");
    item.setAttribute(
      "data-output",
      entry.kind === "file" ? entry.key : entry.output.ref,
    );
    list.append(item);
    if (entry.kind === "file") {
      drawFileRow(item, entry, state, handlers);
      continue;
    }
    const output = entry.output;
    const row = el("div", "beat");
    // A row from before digests existed makes no claim either way.
    const stale =
      output.sceneDigest !== undefined &&
      output.sceneDigest !== state.currentDigest;
    const open = state.warningsOpen.has(output.ref);
    row.append(
      outputHead(output.name, [
        stale ? staleChip(output.ref) : null,
        warningsChip(output.ref, storedWarningCount(output), open, handlers),
      ]),
    );
    const download = el("button", "btn btn-quiet", "Download");
    download.type = "button";
    download.setAttribute("data-download", output.ref);
    download.addEventListener("click", () => handlers.onDownload(output.ref));
    row.append(download);
    item.append(row);
    item.append(
      outputMeta(
        output.ref,
        [formatBytes(output.byteLength), shortTime(output.renderedAt)],
        null,
      ),
    );
    if (open && storedWarningCount(output) > 0) {
      const reports = el("div", "output-warnings");
      reports.setAttribute("data-output-warnings-body", output.ref);
      drawOutputReports(reports, output, state.reportContext);
      item.append(reports);
    }
  }
  const more = state.outputs.length - shown.length;
  if (more > 0) {
    const all = el(
      "button",
      "btn btn-quiet",
      `Show all ${state.outputs.length}`,
    );
    all.type = "button";
    all.setAttribute("data-history-all", "");
    all.title = `${more} more`;
    all.addEventListener("click", handlers.onShowAll);
    list.append(all);
  }
  root.replaceChildren(list);
}

/** What a history row needs. */
export interface HistoryState {
  outputs: OutputRow[];
  currentDigest: string;
  showAll: boolean;
  /** The rows whose warnings chip the author has unfolded, by ref or key.
   *  `main.ts`'s, so a redraw keeps them open. */
  warningsOpen: ReadonlySet<string>;
  /** What an unfolded stored row's notices read: a step's label at a time,
   *  and the way to Runs for reclaimed motion. */
  reportContext: Pick<ExportState, "beatAt" | "runsRoute">;
}

/** How many notices `drawOutputReports` draws for this export. */
function storedWarningCount(output: StoredOutput): number {
  return [
    output.detailViolations.length > 0,
    output.logoWarning !== undefined,
    (output.unavailableSpans ?? []).length > 0,
    (output.unplacedStills ?? []).length > 0,
  ].filter(Boolean).length;
}

/**
 * "2 warnings" on a history row, folded: the press unfolds what the export
 * came with beneath the row. Nothing at all for an export with none, so a
 * clean row reads as it did.
 */
function warningsChip(
  key: string,
  count: number,
  open: boolean,
  handlers: { onWarnings(key: string): void },
): HTMLElement | null {
  if (count === 0) return null;
  const chip = el(
    "button",
    "chip chip-warn",
    count === 1 ? "1 warning" : `${count} warnings`,
  );
  chip.type = "button";
  chip.setAttribute("data-output-warnings", key);
  chip.setAttribute("aria-expanded", String(open));
  chip.addEventListener("click", () => handlers.onWarnings(key));
  return chip;
}

/**
 * Every warning one stored export came with, as notices into `body`: a
 * reduced camera, a logo left out, motion shown as a still, steps with no
 * still. Drawn under the outcome row of the export just made, where the
 * author is looking when it lands, and under a history row whose warnings
 * chip is unfolded.
 */
function drawOutputReports(
  body: ParentNode,
  output: StoredOutput,
  state: Pick<ExportState, "beatAt" | "runsRoute">,
): void {
  if (output.detailViolations.length > 0) {
    // Heading and lines both come from `violationReport`: the heading used
    // to be the hardcoded reduction claim, which is false over a list where
    // no zoom was reduced, and the lines used to be one per violation,
    // which floods once under-sampling is reported per camera key.
    const { heading, lines } = violationReport(
      output.detailViolations,
      state.beatAt,
    );
    const report = el("div", "notice");
    report.setAttribute("data-violations", output.ref);
    report.append(el("strong", undefined, heading));
    for (const line of lines) {
      report.append(el("div", undefined, line));
    }
    report.append(
      el(
        "div",
        "honesty",
        // Measured 2026-09-21: `Page.startScreencast` ignores
        // `Emulation.setDeviceMetricsOverride` and follows the display's
        // own DPR, so raising REPLAY_DPR moves the keyframes and leaves the
        // motion spans exactly where they were. This line said a higher
        // device pixel ratio was the fix, and for half the footage it is
        // not. The window's CSS width is the lever that moves both.
        "A wider recording window is what gives the camera more to work with: both the stills and the motion scale with it. A smaller export size is the other way to close the gap.",
      ),
    );
    body.append(report);
  }

  if (output.logoWarning !== undefined) {
    // A logo that could not be loaded does not fail the export (it is
    // decoration), so this row is the only place the author learns the
    // file carries no brand mark.
    const report = el("div", "notice");
    report.setAttribute("data-logo-warning", output.ref);
    report.append(el("div", undefined, output.logoWarning));
    body.append(report);
  }

  const unavailable = output.unavailableSpans ?? [];
  if (unavailable.length > 0) {
    // A span the frame source could not serve was drawn as a still of the
    // preceding keyframe, which looks exactly like a page holding still.
    // This row is the only place the author can learn the freeze in the
    // deliverable is a decode failure and not their page.
    const report = el("div", "notice");
    report.setAttribute("data-unavailable", output.ref);
    // FINDING 6 (whole-branch review): a reclaimed range and a genuine
    // decode failure both land in this same list, and the generic
    // headline below is only true of the second. Branched only when
    // EVERY span here is a reclaimed one — a mix keeps the decode-
    // failure wording, which is still accurate for the entry that is
    // one, and the per-span line beneath already names each ref's own
    // reason regardless.
    const allReclaimed = unavailable.every(
      (span) => span.reason === RECLAIMED_SPAN_REASON,
    );
    const headline = el("strong");
    setCodeText(
      headline,
      allReclaimed
        ? `Motion was reclaimed to free space and shown as a still. ${rerunAdvice(state.runsRoute.authored, rerunLineOf(state.runsRoute), "to restore")}`
        : "Some motion could not be decoded and was shown as a still",
    );
    report.append(headline);
    for (const span of unavailable) {
      report.append(el("div", undefined, `${span.ref}: ${span.reason}`));
    }
    body.append(report);
  }

  const unplaced = output.unplacedStills ?? [];
  if (unplaced.length > 0) {
    // A stills export delivers one file per step, so a take with a cut in
    // it delivers FEWER files than it has steps — and the only thing the
    // author could otherwise compare against is their own count. This row
    // is the only place they learn which step is missing and why.
    //
    // The two reasons are kept apart in the headline rather than summed.
    // "You cut it" needs no action and "the video holds no frame of it"
    // might, so a single count over both would be the fallback that fires
    // whether or not anything is wrong.
    const report = el("div", "notice");
    report.setAttribute("data-unplaced-stills", output.ref);
    const allCut = unplaced.every((u) => u.reason.includes("cut"));
    report.append(
      el(
        "strong",
        undefined,
        allCut
          ? `No still for ${unplaced.length === 1 ? "a step you cut" : "the steps you cut"}`
          : "Some steps got no still",
      ),
    );
    for (const step of unplaced) {
      report.append(el("div", undefined, `${step.actionId}: ${step.reason}`));
    }
    body.append(report);
  }
}

/** "Oct 19, 2:14 PM", in the reader's locale, with its year when that is
 *  not this one: nothing above a history row or Take info's Recorded row
 *  says the year, as the library's section headings do. A stamp it cannot
 *  read is shown as stored rather than dropped. */
export function shortTime(iso: string, now: Date = new Date()): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  return whenLabel(at, at.getFullYear() !== now.getFullYear());
}

/**
 * "Outdated": an export made before the last edit, said in a word on its
 * own row, the sentence in its tooltip. It was a line of its own under
 * every such row, and after an edit that is every row (the author,
 * 2026-10-19).
 */
function staleChip(key: string): HTMLElement {
  const chip = el("span", "chip", "Outdated");
  chip.setAttribute("data-stale-export", key);
  chip.title = "Made before your last edit";
  return chip;
}

/** A history row's first line: the name, and the chips that apply. */
function outputHead(
  name: string,
  chips: readonly (HTMLElement | null)[],
): HTMLElement {
  const head = el("span", "output-head");
  const title = el("span", "output-name", name);
  title.title = name;
  head.append(title);
  for (const chip of chips) if (chip !== null) head.append(chip);
  return head;
}

/** A history row's second line: its size and when it was made, one dot
 *  apart. The frame and rate are the least telling fact between one take's
 *  exports, so they are the line's tooltip rather than more of the line. */
function outputMeta(
  key: string,
  parts: string[],
  detail: string | null,
): HTMLElement {
  const meta = el("div", "muted output-meta", parts.join(" · "));
  meta.setAttribute("data-output-meta", key);
  if (detail !== null) meta.title = detail;
  return meta;
}

/**
 * One file the studio listed: its name, whether it was made before the last
 * edit and what it came with (a chip each), the way to reach it, then its
 * size and time (its frame on hover). A file that is no longer where
 * `outputs.json` says is told, not offered. The studio's summary sentence
 * restated the path and the size, so the row says its parts instead
 * (`outputRowOf`), and its caveats behind the chip.
 */
function drawFileRow(
  body: ParentNode,
  file: Extract<OutputRow, { kind: "file" }>,
  state: HistoryState,
  handlers: {
    onReveal(target: RevealTarget): void;
    onWarnings(key: string): void;
  },
): void {
  const row = el("div", "beat");
  const open = state.warningsOpen.has(file.key);
  row.append(
    outputHead(file.name, [
      file.sceneDigest !== state.currentDigest ? staleChip(file.key) : null,
      warningsChip(file.key, file.caveats.length, open, handlers),
    ]),
  );
  if (file.exists) {
    const show = el("button", "btn btn-quiet", "Show in Finder");
    show.type = "button";
    show.setAttribute("data-reveal", file.key);
    show.addEventListener("click", () =>
      handlers.onReveal({ kind: "path", path: file.path }),
    );
    row.append(show);
  } else {
    const gone = el("span", "muted", "moved or deleted");
    gone.setAttribute("data-output-gone", "");
    row.append(gone);
  }
  body.append(row);
  body.append(
    outputMeta(
      file.key,
      [formatBytes(file.byteLength), shortTime(file.renderedAt)],
      file.detail,
    ),
  );
  if (open && file.caveats.length > 0) {
    const report = el("div", "notice output-warnings");
    report.setAttribute("data-output-warnings-body", file.key);
    for (const caveat of file.caveats) {
      report.append(el("div", undefined, sentenceOf(caveat)));
    }
    body.append(report);
  }
}

/** A clause of the summary's "but" list as a line of its own. */
function sentenceOf(clause: string): string {
  const head = clause.charAt(0).toUpperCase() + clause.slice(1);
  return /[.!?]$/.test(head) ? head : `${head}.`;
}

/** What the last save came to, with the one action each outcome offers. */
function saveOutcomeRow(
  save: SaveView,
  handlers: {
    onSaveAgain(refs: string[]): void;
    onReveal(target: RevealTarget): void;
  },
): HTMLElement {
  const row = el(
    "div",
    save.kind === "failed" ? "notice notice-error" : "notice",
  );
  row.setAttribute("data-save-outcome", save.kind);
  const again = (refs: string[], label: string) => {
    const button = el("button", "btn btn-quiet", label);
    button.type = "button";
    button.setAttribute("data-save-again", "");
    button.addEventListener("click", () => handlers.onSaveAgain(refs));
    return button;
  };
  if (save.kind === "saved") {
    const what =
      save.names.length === 1
        ? `Saved ${save.names[0]} · ${formatBytes(save.byteLength)}`
        : `Saved ${save.names.length} files · ${formatBytes(save.byteLength)}`;
    row.append(el("span", undefined, what));
    const target = save.reveal;
    if (target !== null) {
      // A path is a file in the studio's own folder, opened in Finder; a
      // download is wherever the browser put it (ruling R20).
      const show = el(
        "button",
        "btn btn-quiet",
        target.kind === "path" ? "Show in Finder" : "Show in folder",
      );
      show.type = "button";
      show.setAttribute("data-show-in-folder", "");
      show.addEventListener("click", () => handlers.onReveal(target));
      row.append(" ", show);
    }
    if (save.summary !== null) {
      const summary = el("div", "muted", save.summary);
      summary.setAttribute("data-save-summary", "");
      row.append(summary);
    }
  } else if (save.kind === "cancelled") {
    row.append(el("span", undefined, "You cancelled the save."));
    // A set the author cancelled partway through still left files behind,
    // and they are real: say how many rather than implying none.
    if (save.total > 1) {
      row.append(
        el("div", undefined, `Saved ${save.saved} of ${save.total} files.`),
      );
    } else row.append(" ");
    row.append(again(save.refs, "Download again"));
  } else {
    row.append(
      el("strong", undefined, "Exported, but the browser didn't save it."),
    );
    if (save.total > 1)
      row.append(
        el("div", undefined, `Saved ${save.saved} of ${save.total} files.`),
      );
    row.append(
      el("div", undefined, save.error),
      again(save.refs, "Download again"),
    );
  }
  return row;
}

export interface TransportState {
  /** Whether a script made this take, for the no-frames tooltips: an
   *  authored take is run again from its script, never re-shot. */
  authored: boolean;
  /** The platform's re-film line where it names no Runs page (the studio):
   *  the no-frames tooltips say it whole instead of the Runs words
   *  (`rerunAdvice`). Absent where the platform answers with a link, as the
   *  extension does. `main.ts` always passes `platform.nav.rerun`'s. */
  rerunLine?: string | null;
  playing: boolean;
  /** Whether there is anything to play. False before a take has frames. */
  enabled: boolean;
  /**
   * Signed playback speed. 1 is ordinary play; anything else is a shuttle.
   *
   * Shown whenever it is not 1, because "Pause" beside a take crossing the
   * screen four times as fast — or running backwards — is a transport
   * reporting a state it is not in, which is the one thing `preview.ts` says
   * this row must never do.
   */
  rate: number;
  /**
   * Whether reaching an end wraps instead of stopping.
   *
   * The page owns this, not the player — `createPlayer` reads it back
   * through a getter — so this row draws the flag rather than a state it
   * inferred from what playback happened to do.
   */
  looping: boolean;
}

/**
 * The preview's transport: Play/Pause and where the playhead is.
 *
 * The label is derived from `playing` rather than flipped on click, so the
 * button cannot come to disagree with the clock — the state it reports is
 * the state the player is in, on every render, including the one that
 * follows playback stopping at the end on its own.
 *
 * Disabled is never left to speak for itself. A greyed Play over a scene
 * that simply has no frames yet reads as a broken editor, so the reason
 * rides on the control.
 */
/** One of the two shuttle controls. Neutral and unfilled like the rail's:
 *  the transport is read at a glance over the picture, and a filled pill
 *  there competes with the frame it sits under. */
function shuttleButton(direction: -1 | 1, name: string): HTMLButtonElement {
  const button = el("button", "btn btn-icon transport-button");
  button.type = "button";
  button.setAttribute("data-transport-shuttle", String(direction));
  button.setAttribute("aria-label", name);
  button.append(icon(direction === -1 ? "rewind" : "fastForward"));
  return button;
}

export function renderTransport(
  root: HTMLElement,
  state: TransportState,
  handlers: {
    onToggle(): void;
    /** J and L, as buttons. The rate doubles per press in one direction,
     *  which is why the glyphs either side of play are rewind and
     *  fast-forward rather than skip-to-edge — that is `seekEdge`. */
    onShuttle(direction: -1 | 1): void;
    /** The repeat toggle. `main.ts` owns the flag, the way it owns the
     *  viewport and the snapping flag. */
    onLooping(looping: boolean): void;
    /** Jump to the start of the trimmed take — the same action ⌘← and
     *  Home run, routed through the same dispatcher so the button and the
     *  keys cannot come to mean different instants. */
    onSkipToStart(): void;
  },
): void {
  // Built once and then updated in place. This row is redrawn on every
  // animation frame while playing, and replacing the button there would blur
  // it the instant the author pressed it, sending the tab order back to the
  // top of the page sixty times a second.
  let play = root.querySelector<HTMLButtonElement>("[data-transport-play]");
  let rate = root.querySelector<HTMLElement>("[data-transport-rate]");
  let controls = root.querySelector<HTMLElement>("[data-transport-controls]");
  let repeat = root.querySelector<HTMLButtonElement>("[data-transport-repeat]");
  let skip = root.querySelector<HTMLButtonElement>("[data-transport-skip]");
  if (
    play === null ||
    rate === null ||
    controls === null ||
    repeat === null ||
    skip === null
  ) {
    play = el("button", "btn btn-icon transport-button");
    play.type = "button";
    play.setAttribute("data-transport-play", "");
    skip = el("button", "btn btn-icon transport-button");
    skip.type = "button";
    skip.setAttribute("data-transport-skip", "");
    skip.append(icon("skipBack"));
    repeat = el("button", "btn btn-icon transport-button");
    repeat.type = "button";
    repeat.setAttribute("data-transport-repeat", "");
    repeat.append(icon("repeat"));
    // The lit dot under the glyph, as the reference mockup draws it. A
    // second, non-colour channel for the same fact: the on state is carried
    // by `--accent` on the glyph, and accent-on-muted is a hue difference
    // alone, which is the one difference a red-green reader does not get.
    // `aria-pressed` below is the third.
    const pip = el("span", "transport-pip");
    pip.setAttribute("aria-hidden", "true");
    repeat.append(pip);
    rate = el("span", "rate");
    rate.setAttribute("data-transport-rate", "");
    controls = el("div", "transport-controls");
    controls.setAttribute("data-transport-controls", "");
    // The rate rides WITH the controls, beside whichever shuttle button is
    // running, rather than beside the clock: the speed is then read where
    // the direction already is, and the pair says one thing instead of two
    // halves of it at opposite ends of the row. The stylesheet takes it out
    // of flow — in flow, showing it would shove the cluster off the centre
    // it is pinned to, and the row would twitch sideways at every change of
    // speed.
    controls.append(
      // Outside the rewind/play/fast-forward group, at the head of the
      // row: the mockup's order, and the NLE one — the controls that move
      // the take at a rate sit together, and the one that jumps to a fixed
      // instant sits before them.
      skip,
      shuttleButton(-1, "Rewind"),
      play,
      shuttleButton(1, "Fast forward"),
      repeat,
      rate,
    );
    // Inserted, not `replaceChildren`: `#transport` holds static siblings
    // — the clock's slot, `#toolbar-clock`, and `.transport-end` with the
    // picture's tools and `#timeline-tools` (`renderTimelineTools`'s root)
    // in it — and `replaceChildren` would take them out on this element's
    // first render. `replaceChildren` used to make this branch
    // self-healing for free — whatever was in `root` before, exactly the
    // new `controls` would be there after — and narrowing it to an insert
    // gave that up: the guard above rebuilds whenever ANY of `play`/`rate`/
    // `controls` is missing, not only when all three are, so a DOM where
    // `.transport-controls` survived but something inside it (the rate
    // badge, say) did not would insert a SECOND `.transport-controls`
    // beside the first rather than replacing it. The line below restores
    // the clean-overwrite property `replaceChildren` gave the whole root,
    // narrowed to the one thing this function owns.
    root.querySelector("[data-transport-controls]")?.remove();
    // Before the static right-hand group, not after it: DOM order is Tab
    // order, and the row reads clock, cluster, tools. Appended (until the
    // final review of 2026-10-07) the cluster came after the picture's and
    // the timeline's tools, so Tab from the clock's side reached the zoom
    // slider before Play. A root without that group — the node lane's
    // bare `div` — takes the cluster at its end, which is the same place.
    const end = root.querySelector(":scope > .transport-end");
    if (end !== null) {
      end.before(controls);
    } else {
      root.append(controls);
    }
  }

  const magnitude = Math.abs(state.rate);
  for (const button of controls.querySelectorAll<HTMLButtonElement>(
    "[data-transport-shuttle]",
  )) {
    const direction = button.dataset.transportShuttle === "-1" ? -1 : 1;
    // Assigned, not added — see `play.onclick`.
    button.onclick = () => handlers.onShuttle(direction);
    button.disabled = !state.enabled;
    // Lit when the player is actually running this way. Backwards is any
    // negative rate; forwards is only ABOVE 1x, because plain play is the
    // middle button's state and not this one's — so exactly one of the
    // three motion controls is marked running at a time. (Play takes the
    // mark but not the brand colour: its glyph stays on its disc's ink.)
    const running =
      direction === -1
        ? state.playing && state.rate < 0
        : state.playing && state.rate > 1;
    button.toggleAttribute("data-active", running);
    // Direction in words, on the control, because the badge beside it shows
    // the magnitude alone — the lit button is what says which way, and a
    // reader who cannot see which button is lit would otherwise get "4x"
    // with no direction at all.
    const base = direction === -1 ? "Rewind" : "Fast forward";
    const name = running
      ? `${base}, playing ${direction === -1 ? "backwards" : "forwards"} at ${magnitude}x`
      : base;
    button.setAttribute("aria-label", name);
    // The key as a cap (`tooltip.ts`), as Play's; disabled, the name alone.
    if (state.enabled) withTip(button, name, [direction === -1 ? "J" : "L"]);
    else {
      withoutTip(button);
      button.title = name;
    }
  }

  // Assigned, not added, for the reason `play.onclick` below is.
  skip.onclick = () => handlers.onSkipToStart();
  // Disabled with the rest of the row when there are no frames, and saying
  // why rather than greying out in silence — the same sentence Play gives,
  // because it is the same reason.
  //
  // NOT disabled when the playhead already sits at the start, though `Fit`
  // beside it does exactly that when the window is already fitted. The
  // difference is that this row redraws on every animation frame while
  // playing: a button that switched itself off at the head would flicker
  // through the first frames of every pass, and pressing it there costs
  // nothing anyway.
  skip.disabled = !state.enabled;
  const skipName = "Jump to start";
  skip.setAttribute("aria-label", skipName);
  if (state.enabled) withTip(skip, skipName, ["Mod", "Left"]);
  else {
    withoutTip(skip);
    skip.title = withoutTicks(
      `This demo has no frames yet, so there is nothing to play. ${rerunAdvice(state.authored, state.rerunLine ?? null, "first")}`,
    );
  }
  repeat.onclick = () => handlers.onLooping(!state.looping);
  repeat.toggleAttribute("data-active", state.looping);
  repeat.setAttribute("aria-pressed", state.looping ? "true" : "false");
  // Says what it will do next AND what it is doing now — a control whose
  // only label is its verb leaves an author who cannot see the lit dot with
  // no way to read the state they are already in.
  const repeatName = state.looping
    ? "Repeat on — playback loops back to the start"
    : "Repeat off — playback stops at the end";
  repeat.setAttribute("aria-label", repeatName);
  repeat.title = repeatName;
  // Not gated on `enabled`: a demo with no frames yet still has a repeat
  // preference worth setting before pressing Play, and nothing about the
  // toggle needs frames to be true.

  // Assigned, not added: a listener added per redraw would stack, and one
  // click would toggle playback once for every frame already drawn.
  play.onclick = () => handlers.onToggle();
  // The word is gone, so `aria-label` is the ONLY name this control has —
  // and it has to swap with the glyph, or a paused take reads as "Play" to
  // everyone who cannot see which triangle is showing.
  const name = state.playing ? "Pause" : "Play";
  play.setAttribute("aria-label", name);
  const glyph: GlyphName = state.playing ? "pause" : "play";
  // Swapped only when it actually changes. This runs on every animation
  // frame while playing, and rebuilding the SVG sixty times a second is
  // work for a picture that is already correct.
  if (play.firstElementChild?.getAttribute("data-icon") !== glyph) {
    play.replaceChildren(icon(glyph));
  }
  play.toggleAttribute("data-playing", state.playing);
  // Plain playback only. While a shuttle runs, the lit control is the one
  // driving it, not this one. The stylesheet paints nothing from it on this
  // button — Play's glyph keeps `--secondary-ink` on its disc whatever its
  // state, and the play/pause swap above is what says it is running — but
  // it stays the one place that says which motion control is driving.
  play.toggleAttribute("data-active", state.playing && state.rate === 1);
  play.disabled = !state.enabled;
  // Reset as well as set. A title left behind from a bundle-less render
  // would explain, on a working demo, why it cannot be played. Working, its
  // tooltip names it and its key (`tooltip.ts`); disabled, the native title
  // says why, since that is a sentence and not a shortcut.
  if (state.enabled) withTip(play, name, ["Space"]);
  else {
    withoutTip(play);
    play.title = withoutTicks(
      `This demo has no frames yet, so there is nothing to play. ${rerunAdvice(state.authored, state.rerunLine ?? null, "first")}`,
    );
  }

  // Magnitude alone: which way is carried by which button is lit and which
  // side the badge sits on, so the arrow the text used to include would be
  // the third copy of the same fact. Emptied as well as filled — a readout
  // left behind from a shuttle that has since stopped would claim a speed
  // the player is no longer running at — and gated on `playing`, so a
  // paused transport never shows a speed nothing is moving at.
  const shuttling = state.playing && magnitude !== 1;
  rate.textContent = shuttling ? `${magnitude}x` : "";
  rate.hidden = !shuttling;
  rate.dataset.side = state.rate < 0 ? "back" : "forward";
}

export interface StageBarState {
  /** Whether a script made this take — see `TransportState.authored`. */
  authored: boolean;
  /** See `TransportState.rerunLine`. */
  rerunLine?: string | null;
  positionMs: number;
  durationMs: number;
  /** The scene's aspect, which this row's toggle sets. All three shapes are
   *  always pickable. */
  aspect: SceneAspect;
  /** False when there are no frames. The aspect toggle stays pickable
   *  either way, so `renderStageBar` does not read this to gate it — but
   *  the zoom chip does: see
   *  `zoom.disabled = !state.enabled` below, which says why rather than
   *  greying out in silence, the way the rest of this editor does. */
  enabled: boolean;
  /** Whether `#stage` is the document's current full-screen element. Read
   *  from `document.fullscreenElement` by `main.ts`'s `fullscreenchange`
   *  listener, never flipped on the click — the same rule `renderTransport`
   *  follows for `playing`, and for the same reason: Escape and the
   *  browser's own chrome leave full screen without going through the
   *  button, and a request that was refused must not leave the control
   *  claiming an outcome that never happened. */
  fullscreen: boolean;
  /** `"fit"` letterboxes the picture inside the stage; `"actual"` shows it
   *  at one PREVIEW-BITMAP pixel per CSS pixel — the size `--frame-px`
   *  names, which is `previewTarget`'s own downscaled width, not the
   *  deliverable's: landscape's preview bitmap is 1280px wide against a
   *  1920px real output, so "100%" here is 67% of the actual deliverable,
   *  not 1:1 with it. `body[data-zoom]` carries it — see `index.html`'s
   *  `body[data-zoom="actual"] #stage` rule — and `main.ts` is the only
   *  writer, flipped by the chip this field drives. */
  zoom: "fit" | "actual";
  /** A `previewError` to show among the picture's controls, not only in
   *  `#failure`.
   *  `#failure` lives in `#notes`, outside `#stage` — while the document
   *  is actually full screen, `#stage`'s subtree is the only thing the
   *  browser paints, so a message that lands only in `#failure` is
   *  invisible for as long as the refusal that caused it is relevant (an
   *  exit refused leaves the document full screen). Null hides the row
   *  entirely; `main.ts` clears the error itself once `fullscreenchange`
   *  proves the state actually moved, so a stale refusal does not survive
   *  the thing it was refusing. */
  error: string | null;
}

/**
 * The picture's own controls: the clock, the aspect toggle, the zoom chip,
 * the full-screen button, and an error banner that carries a refusal
 * `#failure` cannot show while the picture is full screen.
 *
 * `main.ts` draws them into two roots from one state: `#stage-tools` in the
 * timeline toolbar, which the author uses, and `#stage-bar` on the picture,
 * which the stylesheet shows only in full screen.
 *
 * `clockRoot` is where the clock goes, when that is not `root`. The
 * toolbar's clock has a grid column of its own (`#toolbar-clock`), apart
 * from the rest of the picture's controls on the row's right, so the row
 * reserves its width — out of flow, it had none, and the shuttle cluster
 * slid under it. `#stage-bar` keeps its clock in the row with the chips.
 *
 * Built once and patched, for the reason `renderTransport` is — this runs
 * once per animation frame while playing, and replacing a control here
 * would blur it under the author's cursor sixty times a second.
 */
export function renderStageBar(
  root: HTMLElement,
  state: StageBarState,
  handlers: {
    onAspect(next: SceneAspect): void;
    onFullscreen(): void;
    onZoom(): void;
    /** The banner's close button. Hides the banner only: the reason stays
     *  in `#failure`, and the next failure shows it again. */
    onDismissError(): void;
  },
  clockRoot: HTMLElement = root,
): void {
  let time = clockRoot.querySelector<HTMLElement>("[data-transport-time]");
  let actions = root.querySelector<HTMLElement>("[data-stage-actions]");
  // Both, like `renderTransport` guards every element it builds — a bar
  // that already had `time` but never got `actions` would leave the aspect
  // toggle with nowhere to go, silently.
  if (time === null || actions === null) {
    time = el("span", "stage-clock");
    time.setAttribute("data-transport-time", "");
    actions = el("div", "stage-actions");
    actions.setAttribute("data-stage-actions", "");
    // Two segments, not a select: two choices read at a glance, and this is
    // the same `.segmented` control the Background panel's Solid/Gradient
    // uses. Built once and patched below, like every control on this row.
    const aspect = el("div", "segmented");
    aspect.setAttribute("role", "radiogroup");
    aspect.setAttribute("aria-label", "Aspect ratio");
    aspect.setAttribute("data-aspect-toggle", "");
    for (const value of ["auto", "16:9", "9:16"] as const) {
      const button = el("button", "segment", value === "auto" ? "Auto" : value);
      button.type = "button";
      button.setAttribute("role", "radio");
      button.setAttribute("data-aspect", value);
      button.title =
        value === "auto"
          ? "Auto: the video takes the recording's shape"
          : value === "9:16"
            ? "Vertical: the camera follows each step, cropped for a phone"
            : "Landscape";
      aspect.append(button);
    }
    actions.append(aspect);
    const zoom = el("button", "btn chip");
    zoom.type = "button";
    zoom.setAttribute("data-stage-zoom", "");
    actions.append(zoom);
    const full = el("button", "btn btn-icon chip chip-icon");
    full.type = "button";
    full.setAttribute("data-stage-fullscreen", "");
    actions.append(full);
    // Out of flow on purpose — each root's stylesheet rule positions it
    // absolutely — and it must never join the row: a row that also had to
    // fit this banner would change height depending on whether an error
    // happens to be showing, and the toolbar's row takes its height out of
    // the space the picture and the lanes share.
    const error = el("div", "stage-error");
    error.setAttribute("data-stage-error", "");
    error.setAttribute("role", "alert");
    error.hidden = true;
    // The banner hangs over the lanes outside full screen and over the
    // picture in it, so while drawing keeps failing it would cover the
    // controls the author might use to get past the bad frame — the Clip
    // lane's tail handle among them. Closing it is how they get them back.
    const message = el("span", "stage-error-text");
    message.setAttribute("data-stage-error-text", "");
    const dismiss = el("button", "btn btn-icon stage-error-dismiss");
    dismiss.type = "button";
    dismiss.setAttribute("data-stage-error-dismiss", "");
    dismiss.setAttribute("aria-label", "Dismiss");
    dismiss.title = "Dismiss";
    dismiss.append(icon("close"));
    error.append(message, dismiss);
    if (clockRoot === root) {
      root.replaceChildren(time, actions, error);
    } else {
      clockRoot.replaceChildren(time);
      root.replaceChildren(actions, error);
    }
  }
  time.textContent = `${formatClock(state.positionMs)} / ${formatClock(state.durationMs)}`;

  for (const button of root.querySelectorAll<HTMLButtonElement>(
    "[data-aspect]",
  )) {
    const value = button.dataset.aspect as SceneAspect;
    button.setAttribute("aria-checked", String(value === state.aspect));
    // Assigned, not added: this row redraws every animation frame while
    // playing, and an added listener would stack.
    button.onclick = () => handlers.onAspect(value);
  }

  const zoom = root.querySelector<HTMLButtonElement>("[data-stage-zoom]");
  if (zoom !== null) {
    // The label reads what the control currently shows, not what a click
    // would do — the way every editor's zoom chip reads: "Fit" while
    // fitted, so pressing it is "go to 100%," read from the state that is
    // about to change rather than the one that already has.
    zoom.textContent = state.zoom === "fit" ? "Fit" : "100%";
    zoom.setAttribute("aria-label", `Zoom: ${zoom.textContent}`);
    // Disabled is never left to speak for itself — the same rule the play
    // button follows. With no frames there is no target, so `--frame-px`
    // is the stylesheet's default and 100% would claim a size nothing has.
    zoom.disabled = !state.enabled;
    zoom.title = state.enabled
      ? "Switch between fitting the window and actual pixels"
      : withoutTicks(
          `This demo has no frames yet, so there is nothing to zoom into. ${rerunAdvice(state.authored, state.rerunLine ?? null, "first")}`,
        );
    zoom.onclick = () => handlers.onZoom();
  }

  const full = root.querySelector<HTMLButtonElement>("[data-stage-fullscreen]");
  if (full !== null) {
    // Derived from the document's state on every render, never flipped on
    // the click — the same rule the play button follows, and for the same
    // reason: a request that is refused must not leave the control
    // reporting an outcome that did not happen.
    const name = state.fullscreen ? "Exit full screen" : "Full screen";
    full.setAttribute("aria-label", name);
    full.title = name;
    const glyph: GlyphName = state.fullscreen ? "minimize" : "maximize";
    if (full.firstElementChild?.getAttribute("data-icon") !== glyph) {
      full.replaceChildren(icon(glyph));
    }
    full.onclick = () => handlers.onFullscreen();
  }

  const error = root.querySelector<HTMLElement>("[data-stage-error]");
  if (error !== null) {
    error.hidden = state.error === null;
    const message = error.querySelector<HTMLElement>("[data-stage-error-text]");
    if (message !== null) message.textContent = state.error ?? "";
    const dismiss = error.querySelector<HTMLButtonElement>(
      "[data-stage-error-dismiss]",
    );
    if (dismiss !== null) dismiss.onclick = () => handlers.onDismissError();
  }
}

/**
 * The header's controls, as icons.
 *
 * The same language the Recordings page speaks — `btn-icon`, a Lucide glyph
 * from `shell/icons.ts`, and the name on the button rather than inside it.
 *
 * Applied from here rather than written into `index.html` because `icon()`
 * builds DOM: the markup carries the ids, the classes and the names, and
 * this fills in the picture. Idempotent, because `render` runs on every
 * edit and a control that appended a glyph per render would stack them.
 */
/** The header controls a key also works, and the key: their tooltips. */
const HEADER_KEYS: Record<string, readonly string[]> = {
  undo: ["Mod", "Z"],
  redo: ["Shift", "Mod", "Z"],
  "shortcuts-open": ["?"],
};

export function renderHeaderIcons(root: ParentNode = document): void {
  const controls: Array<[string, GlyphName, string]> = [
    ["back", "chevronLeft", "Back to your demos"],
    ["undo", "undo", "Undo"],
    ["redo", "redo", "Redo"],
    ["delete", "trash", "Delete this demo"],
    ["shortcuts-open", "circleQuestionMark", "Keyboard shortcuts"],
  ];
  for (const [id, glyph, name] of controls) {
    const button = root.querySelector<HTMLElement>(`#${id}`);
    if (button === null) continue;
    button.setAttribute("aria-label", name);
    // The pointer gets the same name the reader does, with the key as caps
    // where it has one (`tooltip.ts`; the author, 2026-10-19).
    const keys = HEADER_KEYS[id];
    if (keys !== undefined) withTip(button, name, keys);
    else if (button.title === "") button.title = name;
    if (button.querySelector("svg") !== null) continue;
    // The word goes when the glyph arrives: a button carrying both would
    // say the same thing twice, and `aria-label` already covers the name.
    button.textContent = "";
    button.append(icon(glyph));
  }
}

/** How bad the worst card in `#notes` is: `error` for anything in `#failure`
 *  but the capture note (a fact about the take, not something that broke),
 *  `warn` for any other card but the re-home report, `info` for the report
 *  alone. */
export type NotesLevel = "error" | "warn";

/** The cards in `#notes` that say something broke. The capture note is in
 *  `#failure` too, but it is a fact about the take, not a fault. */
const ERROR_CARDS = "#failure > .notice:not([data-capture-note])";

/**
 * The header button that opens `#notes`, drawn from what `#notes` holds.
 *
 * Read from the panel's DOM rather than from the snapshot, because four
 * renderers and three call sites write into it and a count assembled from
 * their inputs would be a second copy of each one's "is there anything to
 * say" — the one that drifted would leave a card behind a button that
 * claims there is none. The DOM is what the author would see on opening it.
 *
 * Hidden, not disabled, when there is nothing: a greyed-out alert in the
 * header would read as a fault of its own. And a popover left open over a
 * panel that just emptied is closed, or it would hang as an empty box.
 */
export function renderNotesButton(
  button: HTMLElement,
  panel: HTMLElement,
): void {
  const cards = [...panel.querySelectorAll(".notice, .banner")];
  const count = cards.length;
  button.classList.toggle("hidden", count === 0);
  if (count === 0) {
    button.removeAttribute("data-level");
    // jsdom has no popover API; Chrome's `hidePopover` on a closed popover
    // is a no-op.
    if (
      typeof panel.hidePopover === "function" &&
      panel.matches(":popover-open")
    ) {
      panel.hidePopover();
    }
    return;
  }
  const level: NotesLevel =
    panel.querySelector(ERROR_CARDS) !== null ? "error" : "warn";
  button.setAttribute("data-level", level);
  const name = `${count} ${count === 1 ? "note" : "notes"} on this take${
    level === "error" ? ", with an error" : ""
  }`;
  button.setAttribute("aria-label", name);
  button.title = name;
  if (button.querySelector("svg") === null) button.append(icon("circleAlert"));
  let badge = button.querySelector<HTMLElement>("[data-count]");
  if (badge === null) {
    badge = el("span");
    badge.setAttribute("data-count", "");
    badge.setAttribute("aria-hidden", "true");
    button.append(badge);
  }
  badge.textContent = String(count);
}

/**
 * Opens `#notes` when an error arrives that the author has not been shown.
 *
 * Every failure the editor reports — an open that failed, an export that did
 * not start, an edit or a delete that did not go through — is drawn into
 * `#failure`, and `#failure` lives in this popover. Left closed, the only
 * sign of any of them was the header button turning red: an export refused
 * looked like an export that never started, and a failed open left an empty
 * editor with a small icon to explain it. The reason was recorded, just not
 * where anyone was looking.
 *
 * Once per distinct error, not on every paint: `seen` is what the last call
 * returned, and an author who closes the popover on an error is not shown
 * the same one again until it changes. A warning alone never opens it —
 * those are notes about the take, and the badge is enough for them.
 */
export function revealNewErrors(panel: HTMLElement, seen: string): string {
  const errors = [...panel.querySelectorAll(ERROR_CARDS)]
    .map((card) => card.textContent ?? "")
    .join("\n");
  if (
    errors !== "" &&
    errors !== seen &&
    // jsdom has no popover API.
    typeof panel.showPopover === "function" &&
    !panel.matches(":popover-open")
  ) {
    panel.showPopover();
  }
  return errors;
}

/**
 * The `?` list: every binding, from the one table that defines them, as
 * the inspector's Keyboard shortcuts panel (the author, 2026-10-19: one
 * inspector, one way to close — its X and Escape). A modal over a scrim and
 * then a panel of its own down the right edge before that. Every key works
 * while it is open; the editor is in view beside it.
 *
 * Rendered from `SHORTCUT_LEGEND` rather than written out here, so a key
 * cannot be bound without a line explaining it — the node lane asserts that
 * every reachable action has an entry.
 *
 * A row is what it does, then its keys, right-aligned: the author comes
 * looking for an action. Keys are caps, one per key; a chord — keys held
 * together — is one `[data-combo]` group that never breaks.
 *
 * The search field filters rows by their words and their group's name.
 * `query` is `main.ts`'s, so a redraw keeps what was typed; `focus` is true
 * on the render that opened the panel, and only then, so a redraw never
 * takes the keys away from the editor. Escape in the field clears it, then
 * closes the panel.
 *
 * A panel already drawn for this state is left alone: a field rebuilt under
 * the author's typing loses its caret and any IME composition (review
 * 2026-10-19), and nothing in it would change. The query only changes from
 * the field itself, so its value is the drawn query.
 */
export function renderShortcuts(
  root: HTMLElement,
  state: { mac: boolean; query: string; focus: boolean },
  handlers: { onClose(): void; onQuery(query: string): void },
): void {
  const drawn = root.querySelector<HTMLInputElement>("[data-shortcuts-search]");
  if (
    drawn !== null &&
    drawn.value === state.query &&
    root.dataset.shortcutsMac === String(state.mac)
  ) {
    if (state.focus && document.activeElement !== drawn) drawn.focus();
    return;
  }
  root.setAttribute("data-shortcuts", "");
  root.dataset.shortcutsMac = String(state.mac);
  const search = el("input", "shortcuts-search");
  search.type = "search";
  search.placeholder = "Search shortcuts";
  search.setAttribute("aria-label", "Search shortcuts");
  search.setAttribute("data-shortcuts-search", "");
  search.autocomplete = "off";
  search.spellcheck = false;
  search.value = state.query;

  const body = el("div", "shortcuts-body");
  // Grouped in the table's own order, so the list reads top to bottom the
  // way an author works: play it, find the step, trim it, change it.
  const sections: {
    section: HTMLElement;
    group: string;
    rows: HTMLElement[];
  }[] = [];
  for (const entry of SHORTCUT_LEGEND) {
    let current = sections[sections.length - 1];
    if (current?.group !== entry.group) {
      const section = el("section", "shortcuts-section");
      section.append(el("h3", "shortcuts-group", entry.group));
      body.append(section);
      current = { section, group: entry.group, rows: [] };
      sections.push(current);
    }
    const row = el("div", "shortcuts-row");
    row.setAttribute("data-shortcut-row", "");
    row.append(
      el("span", "shortcuts-what", describeShortcut(entry, state.mac)),
    );
    const keys = el("span", "shortcuts-keys");
    for (const combo of entry.combos) {
      const chord = el("span", "keychord");
      chord.setAttribute("data-combo", "");
      // The chord, said in one piece: the caps carry no separator, which is
      // how the eye reads "together" and what a reader cannot see.
      chord.setAttribute("aria-label", comboSpoken(combo, state.mac));
      for (const token of combo) {
        const label = keyLabel(token, state.mac);
        const cap = el("kbd", "keycap", label);
        cap.setAttribute("aria-hidden", "true");
        // ⌘ ⇧ ⌫ and the arrows are drawn in the system's own face, larger:
        // in the studio's mono, whose Latin subset has none of them, they
        // fell back to specks (the 2026-09-19 "smudges").
        if (isKeySymbol(label)) cap.setAttribute("data-symbol", "");
        chord.append(cap);
      }
      keys.append(chord);
    }
    row.append(keys);
    current.section.append(row);
    current.rows.push(row);
  }
  const empty = el("p", "shortcuts-empty", "No shortcuts match");
  empty.setAttribute("data-shortcuts-empty", "");
  body.append(empty);

  const filter = () => {
    const query = search.value.trim().toLowerCase();
    let shown = 0;
    for (const { section, group, rows } of sections) {
      const groupMatches = group.toLowerCase().includes(query);
      let inSection = 0;
      for (const row of rows) {
        const words =
          row.querySelector(".shortcuts-what")?.textContent?.toLowerCase() ??
          "";
        row.hidden = !(groupMatches || words.includes(query));
        if (!row.hidden) inSection += 1;
      }
      section.hidden = inSection === 0;
      shown += inSection;
    }
    empty.hidden = shown > 0;
  };
  filter();
  search.addEventListener("input", () => {
    handlers.onQuery(search.value);
    filter();
  });
  search.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    if (search.value !== "") {
      search.value = "";
      handlers.onQuery("");
      filter();
    } else handlers.onClose();
  });

  root.replaceChildren(search, body);
  // Ready to type into when it opens, as Linear's is.
  if (state.focus) search.focus();
}

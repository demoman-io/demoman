import type { AttachedEdit } from "@demoman/compositor";
import { CAMERA_DEFAULTS } from "@demoman/compositor";
import type { SceneDocument } from "@demoman/scene-schema";
import { el, paintSliderFill } from "../../src/editor/dom";
import type { HoverReport } from "../../src/editor/hover-report";
import type { LaneModel, MaskSeg, ZoomSeg } from "../../src/editor/lanes";
import { formatClock } from "../../src/editor/preview";
import type { Sections } from "../../src/editor/sections";
// The controller ruling on this task's brief: `Selection` lives in
// `src/editor/selection.ts`, not in `timeline-view.ts` — a `src/` module can
// import it without reaching into `entrypoints/`. Re-exported so this file's
// own imports (the inspector test included) keep working.
import type { Selection } from "../../src/editor/selection";
import {
  anchorLabel,
  type BeatView,
  type TimelineView,
} from "../../src/editor/timeline";
import { icon } from "../../src/shell/icons";
import { withTip } from "../../src/shell/tooltip";
import type { RailEntry } from "./rail";

export type { Selection } from "../../src/editor/selection";

export interface InspectorProps {
  selection: Selection;
  view: TimelineView;
  model: LaneModel;
  scene: SceneDocument;
  hoverReport: HoverReport | null;
  /** The compositor's mask fill and viewport, for the readouts. */
  viewport: { width: number; height: number };
  /** Which panel to draw: the rail's open entry. `main.ts` asks for
   *  "selection" only while the selection resolves to something the take
   *  still has. */
  rail: RailEntry;
  /** Which of the panels' `<details>` the author has opened this session. */
  sections: Sections;
  /** Edits the plan kept and did not draw because their marker is a step
   *  inside a removed piece. Named in that step's own panel. */
  attachedToCuts: readonly AttachedEdit[];
}

export interface InspectorHandlers {
  /** The card's own close button: the same as pressing the pressed rail
   *  entry, without having to find it. */
  onClose(): void;
  /** The authored pace after a beat, in ms. Zero is a real value: it means
   *  "no pause here", which is not the same as `onGapClear`. */
  onGap(actionId: string, durationMs: number): void;
  /** Restore the RECORDED pace. Absence is what says "play back what the
   *  take actually held", and nothing else can say it. */
  onGapClear(actionId: string): void;
  onKeepHover(actionId: string): void;
  /** `addZoom`, element target, offset 0. */
  onZoomOnStep(actionId: string): void;
  onZoomScale(id: string, scale: number): void;
  onRemoveZoom(id: string): void;
  /** Dispatches `setMaskNote`. */
  onMaskNote(id: string, note: string): void;
  onRemoveMask(id: string): void;
}

/**
 * The Export panel's layout. `main.ts` fills `data-panel-export` with
 * `renderExport`. This file owns the layout, not the contents, which is
 * what keeps it from becoming a second `view.ts`.
 *
 * (Until 2026-09-14 one demo panel carried render mode, export AND
 * branding, shown whenever nothing was selected. The rail split it: the
 * logo and colour are the Background entry's now, and this is the Export
 * entry's. Until 2026-09-24 this panel also carried a "Source" disclosure
 * beneath the export box, holding the Recording / Rebuild banner
 * `renderRenderMode` drew — spec §2 retired the render-mode question
 * itself: the approximations chip (Task 6) and the export's own rebuild
 * (Task 9) carry everything that banner said, so there is nothing left for
 * a settings disclosure here to hold. Both of those left the editor in turn,
 * with plan 2 of the agent door, Tasks 6 and 7.)
 */
function renderExportPanel(): HTMLElement {
  const panel = el("div", "demo-panel");
  panel.setAttribute("data-export-panel", "");
  panel.append(el("h2", undefined, "Export"));
  const exportBox = el("div");
  exportBox.setAttribute("data-panel-export", "");
  panel.append(exportBox);
  return panel;
}

/** The background, the frame and the logo. `main.ts` fills
 *  `data-panel-branding`. */
function renderBackgroundPanel(): HTMLElement {
  const panel = el("div", "demo-panel");
  panel.setAttribute("data-background-panel", "");
  panel.append(el("h2", undefined, "Background"));
  const box = el("div");
  box.setAttribute("data-panel-branding", "");
  panel.append(box);
  return panel;
}

/** Every binding, searchable: the ? button's panel. `main.ts` fills
 *  `data-panel-shortcuts` with `renderShortcuts`. A panel of its own down the
 *  right edge until 2026-10-19 (the author: one inspector, one way to close). */
function renderShortcutsPanel(): HTMLElement {
  const panel = el("div", "demo-panel");
  panel.setAttribute("data-shortcuts-panel", "");
  panel.append(el("h2", undefined, "Keyboard shortcuts"));
  const box = el("div");
  box.setAttribute("data-panel-shortcuts", "");
  panel.append(box);
  return panel;
}

/** How the pointer is drawn, for the whole demo. `main.ts` fills
 *  `data-panel-cursor` with `renderCursor`, the same layout-here /
 *  contents-there split the Background panel uses. */
function renderCursorPanel(): HTMLElement {
  const panel = el("div", "demo-panel");
  panel.setAttribute("data-cursor-panel", "");
  panel.append(el("h2", undefined, "Cursor"));
  const box = el("div");
  box.setAttribute("data-panel-cursor", "");
  panel.append(box);
  return panel;
}

/**
 * The detail panel for the one step an author has selected — every control
 * that used to live on a `beatRow` and its `renderCameraLane` cell, moved
 * here rather than reinvented, now scoped to the single selected step
 * instead of drawn once per row. The timeline lanes (Task 10) already draw
 * every step; this is what a click on one opens.
 */
function renderStepPanel(
  beat: BeatView,
  props: InspectorProps,
  handlers: InspectorHandlers,
): HTMLElement {
  const panel = el("div", "beat-panel");
  panel.setAttribute("data-step-panel", beat.actionId);

  // The heading names the step: its verb, small, then its label.
  const heading = el("h2");
  heading.append(el("span", "verb", beat.verb), " ", beat.label);
  if (beat.strategy) {
    const chip = el("span", "chip", beat.strategy);
    chip.setAttribute("data-health", beat.strategy);
    heading.append(" ", chip);
  }
  panel.append(heading);

  const middle = el("div");
  if (beat.verb === "type") {
    if (beat.redacted) {
      middle.append(
        el(
          "div",
          "redacted",
          beat.host
            ? "This was typed into an editor, and an edit the sensor does not follow landed mid-field, so the text is unknown."
            : "This value was never recorded — a credential field, or text that looked like a secret.",
        ),
      );
    } else {
      // Read-only: a step is what the take did (spec 2026-10-22 split-tool).
      const typed = el("div", "control-row");
      const value = el("span", undefined, beat.text ?? "");
      value.setAttribute("data-typed-text", beat.actionId);
      typed.append(el("span", "control-label", "Typed text"), value);
      middle.append(typed);
    }
  }
  // The reason the clip is drawn hatched. The lane says "this position is
  // not measured"; only here is there room to say why it is not, and a
  // hatch pattern with no explanation anywhere is a texture, not a warning.
  if (beat.timing === "estimated") {
    middle.append(
      el(
        "div",
        "muted",
        "Not in the video: the frames have no marker for this step, so the timeline places it from the take's own timestamp.",
      ),
    );
  }
  // Only when it has something to say: an empty block is a hole the first
  // `.beat-panel > div` rule to paint a box would paint.
  if (middle.hasChildNodes()) panel.append(middle);

  // A zoom is added or it is absent. A step with no anchor cannot carry a
  // zoom — there is nothing on screen to aim at — and says so where its
  // button would be. A control that is simply missing reads as a bug in the
  // editor.
  const zoom = el("div", "control-actions");
  if (!beat.canZoom) {
    zoom.append(el("span", "muted", "No zoom — nothing on screen to aim at"));
  } else {
    const button = el("button", "btn btn-quiet", "Zoom on this step");
    button.type = "button";
    button.setAttribute("data-zoom-on-step", beat.actionId);
    button.addEventListener("click", () =>
      handlers.onZoomOnStep(beat.actionId),
    );
    zoom.append(button);
  }
  panel.append(zoom);

  const restoreButton = (): HTMLElement => {
    const restore = el("button", "btn btn-quiet", "Use recorded");
    restore.type = "button";
    restore.setAttribute("data-gap-clear", beat.actionId);
    restore.setAttribute(
      "aria-label",
      `Restore the recorded pause after ${beat.label}`,
    );
    restore.addEventListener("click", () => handlers.onGapClear(beat.actionId));
    return restore;
  };

  // Why an authored pause would not play on this step, or null when it
  // would. `BeatView.canPace` is the same question `authoredPaceCovering`
  // asks in the compositor, so the control and the render agree about what
  // an authored number does.
  const inertReason = beat.isLast
    ? "This is the last step, and a pause is the time between two steps."
    : beat.canPace
      ? null
      : "This step runs straight into the next one, with no dead air between them to stretch.";

  if (inertReason === null) {
    const timing = el("label", "control-row");
    const gap = el("input");
    gap.type = "number";
    gap.min = "0";
    gap.step = "100";
    // Empty, not zero, when nothing is authored. Zero would claim the author
    // asked for no pause at all; empty says the take's own recorded pace is
    // what plays, which is what absence means.
    gap.value = beat.gap === null ? "" : String(beat.gap.durationMs);
    gap.placeholder = "recorded";
    gap.setAttribute("data-gap", beat.actionId);
    gap.setAttribute(
      "aria-label",
      `Pause after ${beat.label}, in milliseconds. Empty plays back the recorded pause.`,
    );
    gap.addEventListener("change", () => {
      const raw = gap.value.trim();
      // Emptying the field is the keyboard route to the same thing the
      // button below does. Typing 0 is NOT that: it authors a zero-length
      // pause, which is how dead air gets cut.
      //
      // Everything else goes out as typed, `min="0"` notwithstanding — the
      // attribute stops the spinner, never a keystroke, so `-500` and `abc`
      // both arrive here. `onGap` resolves them through the same `resolveGap`
      // the pace drag ends in and refuses them by name, exactly as
      // `onZoomOnStep`'s aim resolution refuses one elsewhere. Not clamped
      // here, for the reason written there: a control that silently
      // corrected an author's number would teach a rule the drag does not
      // follow.
      if (raw === "") handlers.onGapClear(beat.actionId);
      else handlers.onGap(beat.actionId, Number(raw));
    });
    // The field and its unit on one line, the Use recorded action beside
    // them, under the row's label — the Cursor panel's label-then-control.
    const field = el("span", "control-inline");
    field.append(gap, el("span", undefined, "ms"));
    if (beat.gap !== null) field.append(restoreButton());
    timing.append(el("span", "control-label", "Pause after this step"), field);
    panel.append(timing);

    // The render was read and it plays nothing for this number.
    //
    // Only reachable on a REBUILD. On a capture bundle `idleOutputFor` sets
    // the pair's idle output to the authored target outright, so a positive
    // gap on a stretch with any idle in it always plays — and a stretch with
    // none is the `canPace` branch below, not this one. On a rebuild
    // `paceInstants` inserts `max(0, idleTarget − replayIdle)`: a floor,
    // never a ceiling, because compressing what the automation took would be
    // a speed-up through in-app motion and v8 §4 forbids it. So a zero here
    // means the rebuild's own dead air already covered the pause.
    //
    // The control stays. Unlike the two inert cases below, this number is
    // not stranded — raising it above what the rebuild left makes it play —
    // and withholding the input would take away the one move that fixes it.
    // What was missing was any statement at all: the band was drawn, the
    // field showed the number, and the video contained no pause.
    //
    // `renderedPaceFreezeMs`, not `renderedPauseMs`: this line is about what
    // the AUTHOR's number added, and the two stopped being the same question
    // on 2026-09-08. `renderedPauseMs` reports the whole pause the render
    // plays, so on a floored rebuild it now carries the dead air the
    // automation itself left — a real pause, and no evidence at all that the
    // typed number produced it.
    //
    // `=== 0`, never `!renderedPaceFreezeMs`: null is "there is no such
    // quantity here" — no render, or a capture bundle, which reconstructs
    // nothing — and that is a different sentence which gets none of this one.
    if (
      beat.gap !== null &&
      beat.gap.durationMs > 0 &&
      beat.renderedPaceFreezeMs === 0
    ) {
      const floored = el("div");
      floored.setAttribute("data-gap-floored", beat.actionId);
      floored.append(
        el(
          "span",
          undefined,
          `A ${beat.gap.durationMs}ms pause is set here, but the re-shot frames already leave at least that long between these two steps, so it adds nothing to this video. Pacing only ever adds time — it never speeds your app up. Raise it, or go back to your recording from its Recordings card, where this number is the pause.`,
        ),
      );
      panel.append(floored);
    }
  } else if (beat.gap !== null) {
    // An authored pause that has stopped playing — one stranded on the last
    // step by a `trimFrom` made after it was set (which
    // `prune` has no reason to drop, because the step it names is still in
    // the take), or one on a stretch a capture bundle turned out to find no
    // idle in. `clipDimensions` draws no band for either and the field above
    // is withheld, so without this line the author's number would have simply
    // vanished. The clear is offered because it is the only way to get rid of
    // it.
    const stranded = el("div");
    stranded.setAttribute("data-gap-inert", beat.actionId);
    stranded.append(
      el(
        "span",
        undefined,
        `A ${beat.gap.durationMs}ms pause is set here but is not playing. ${inertReason}`,
      ),
      restoreButton(),
    );
    panel.append(stranded);
  }
  // Nothing at all when the pause would be inert and none is authored: spec
  // §1 asks for no handle rather than one that silently does nothing.

  if (beat.legacyHold !== null) {
    // A pause from before gaps existed that `migrateHoldsToGaps` deliberately
    // did not convert — after the final step, or at a non-zero offset inside
    // a clip. `planScene` maps `edits.holds` to `plan.holds`, so it is in the
    // render, and there is no command left that authors or removes one — so
    // it is named rather than edited. Silence here would be a pause in the
    // video that the editor draws nothing for and mentions nowhere.
    const where =
      beat.legacyHold.offsetMs === 0
        ? "after this step"
        : `${beat.legacyHold.offsetMs}ms into this step`;
    // `holdInstants` drops a hold whose action the bundle carries no marker
    // for, which is exactly the beats drawn as `estimated`. Claiming it plays
    // there would be a note about a pause the video does not contain — the
    // same gate `clipDimensions` applies to the band.
    const plays =
      beat.timing === "rendered"
        ? `still plays ${where}`
        : `is set ${where}, but nothing has rendered that step, so it is not in the video you have`;
    // Naming the way out, because there is none inside this panel and a line
    // that implies one is worse than a line that admits there is not.
    // Deleting the step really does remove it: `prune` drops any hold whose
    // action left the take.
    const legacy = el("div");
    legacy.setAttribute("data-legacy-hold", beat.actionId);
    legacy.append(
      el(
        "span",
        undefined,
        `A ${beat.legacyHold.durationMs}ms pause from an earlier edit ${plays}. There is no control for it: deleting this step removes it, and nothing else in the editor does.`,
      ),
    );
    panel.append(legacy);
  }

  // A step inside a removed piece: say so, and name the edits on it that
  // the video therefore does not draw.
  if (beat.cut) {
    const cutBox = el("div");
    cutBox.setAttribute("data-cut-panel", beat.actionId);
    cutBox.append(
      el(
        "p",
        "honesty",
        "This step is in a removed piece, so it is not in the video.",
      ),
    );
    const attached = props.attachedToCuts.filter(
      (e) => e.actionId === beat.actionId,
    );
    if (attached.length > 0) {
      const kinds = [...attached].map((e) => e.kind).sort();
      const one = attached.length === 1;
      const line = el(
        "p",
        "muted",
        `${attached.length} edit${one ? "" : "s"} on this step (${kinds.join(", ")}) ${one ? "is" : "are"} kept and not drawn. Restoring the piece brings ${one ? "it" : "them"} back.`,
      );
      line.setAttribute("data-cut-attached", beat.actionId);
      cutBox.append(line);
    }
    panel.append(cutBox);
  }

  const controls = el("div", "control-actions");
  // A step the hover check flagged as changing nothing: `onKeepHover`
  // overrides that one verdict, so one wrong call by the pixel check does
  // not leave the flag standing.
  const flaggedHover =
    props.hoverReport?.removable.includes(beat.actionId) ?? false;
  if (flaggedHover) {
    const keep = el("button", "btn btn-quiet", "Keep this hover");
    keep.type = "button";
    keep.setAttribute("data-keep-hover", beat.actionId);
    keep.addEventListener("click", () => handlers.onKeepHover(beat.actionId));
    controls.append(keep);
  }

  if (controls.hasChildNodes()) panel.append(controls);
  return panel;
}

function renderZoomPanel(
  zoom: ZoomSeg,
  props: InspectorProps,
  handlers: InspectorHandlers,
): HTMLElement {
  const panel = el("div", "zoom-panel");
  panel.setAttribute("data-zoom-panel", zoom.id);
  panel.append(el("h2", undefined, "Zoom"));
  const slider = el("input");
  slider.type = "range";
  slider.min = "1.1";
  slider.max = String(CAMERA_DEFAULTS.maxScale);
  slider.step = "0.05";
  slider.value = String(zoom.scale);
  slider.setAttribute("data-zoom-scale", zoom.id);
  slider.setAttribute("aria-label", "Zoom level");
  paintSliderFill(slider);
  // `input`, not `change`: the fill has to follow the thumb through the
  // drag, and `change` only lands on release. It paints and nothing else —
  // the commit stays on `change` below.
  slider.addEventListener("input", () => paintSliderFill(slider));
  slider.addEventListener("change", () =>
    handlers.onZoomScale(zoom.id, Number(slider.value)),
  );
  // The Cursor panel's row shape, from `view.ts`'s `cursorSlider`: label
  // and readout on one line, track across both columns beneath them.
  const level = el("div", "slider-row");
  level.append(
    el("span", "control-label slider-label", "Level"),
    el("span", "slider-value", `${zoom.scale.toFixed(2)}x`),
    slider,
  );
  panel.append(level);

  const aim = el("div");
  aim.setAttribute("data-zoom-aim", "");
  if (zoom.target.kind === "element") {
    const { anchorId } = zoom.target;
    const anchor = props.scene.anchors.find((a) => a.id === anchorId);
    aim.textContent = `Aims at ${anchor ? anchorLabel(anchor) : anchorId}`;
  } else {
    aim.textContent = `Aims at the cursor at ${formatClock(zoom.startMs)}`;
  }
  panel.append(aim);
  if (zoom.aimFallback !== null) {
    const fallback = el("div", "muted", zoom.aimFallback);
    fallback.setAttribute("data-zoom-fallback", "");
    panel.append(fallback);
  }
  const range = el("div");
  range.setAttribute("data-zoom-range", "");
  range.textContent = `${formatClock(zoom.startMs)} to ${formatClock(zoom.endMs)}${
    zoom.endAuthored ? "" : " (end automatic; drag its cap to set one)"
  }`;
  panel.append(range);
  if (zoom.clamped)
    panel.append(
      el(
        "div",
        "muted",
        "The end you set could not be reached; see the note under the timeline.",
      ),
    );
  if (zoom.timing === "estimated")
    panel.append(
      el(
        "div",
        "muted",
        "Estimated position: the last render carried no marker for this zoom's step, or no on-screen rect for its target.",
      ),
    );
  const remove = el("button", "btn btn-quiet", "Remove zoom");
  remove.type = "button";
  remove.setAttribute("data-remove-zoom", zoom.id);
  withTip(remove, "Remove zoom", ["Delete"]);
  remove.addEventListener("click", () => handlers.onRemoveZoom(zoom.id));
  const zoomActions = el("div", "control-actions");
  zoomActions.append(remove);
  panel.append(zoomActions);
  return panel;
}

function renderMaskPanel(
  mask: MaskSeg,
  props: InspectorProps,
  handlers: InspectorHandlers,
): HTMLElement {
  const panel = el("div", "mask-panel");
  panel.setAttribute("data-mask-panel", mask.id);
  panel.append(el("h2", undefined, "Mask"));
  const rect = el("div");
  rect.setAttribute("data-mask-rect", "");
  rect.textContent = `${Math.round(mask.rect.width)}x${Math.round(mask.rect.height)} at ${Math.round(mask.rect.x)}, ${Math.round(mask.rect.y)}`;
  panel.append(rect);
  const note = el("input");
  note.type = "text";
  note.placeholder = "What this hides";
  note.value =
    props.scene.edits.masks.find((m) => m.id === mask.id)?.note ?? "";
  note.setAttribute("data-mask-note", mask.id);
  note.setAttribute("aria-label", "Mask note");
  note.addEventListener("change", () =>
    handlers.onMaskNote(mask.id, note.value),
  );
  // Labelled like every other control: until 2026-09-22 this field sat in
  // the panel with only a placeholder to say what it was for.
  const noteRow = el("label", "control-row");
  noteRow.append(el("span", "control-label", "Note"), note);
  panel.append(noteRow);
  const range = el("div");
  range.setAttribute("data-mask-range", "");
  if (mask.wholeTake) {
    range.setAttribute("data-mask-whole-take", "");
    range.textContent =
      "Covers the whole take (made before masks had a range).";
  } else {
    range.textContent = `${formatClock(mask.startMs)} to ${formatClock(mask.endMs)}`;
  }
  panel.append(range);
  panel.append(
    el(
      "p",
      "honesty",
      "Masks are opaque fills stored in the page's own coordinates and re-applied on every render — non-destructive as layers, absolute as pixels.",
    ),
  );
  const remove = el("button", "btn btn-quiet", "Remove mask");
  remove.type = "button";
  remove.setAttribute("data-remove-mask", mask.id);
  withTip(remove, "Remove mask", ["Delete"]);
  remove.addEventListener("click", () => handlers.onRemoveMask(mask.id));
  const maskActions = el("div", "control-actions");
  maskActions.append(remove);
  panel.append(maskActions);
  return panel;
}

export function renderInspector(
  root: HTMLElement,
  props: InspectorProps,
  handlers: InspectorHandlers,
): void {
  const { selection, rail } = props;
  // Keyboard shortcuts holds nothing from `props`, and its search field may
  // be where the author is typing: a redraw that replaced it moved the caret
  // to the end and cancelled an IME composition (review 2026-10-19). So it
  // stays as drawn while it is the panel; `renderShortcuts` keeps its field.
  if (
    rail === "shortcuts" &&
    root.querySelector(":scope > .inspector > [data-shortcuts-panel]") !== null
  ) {
    return;
  }
  const box = el("div", "inspector");
  const beat =
    selection?.kind === "tick"
      ? props.view.beats.find((b) => b.actionId === selection.actionId)
      : undefined;
  const zoom =
    selection?.kind === "zoom"
      ? props.model.zooms.find((z) => z.id === selection.id)
      : undefined;
  const mask =
    selection?.kind === "mask"
      ? props.model.masks.find((m) => m.id === selection.id)
      : undefined;
  let panel: HTMLElement;
  if (rail === "selection") {
    // `main.ts` only asks for this entry while something is selected and
    // still in the take; a miss here is its bug, and the Export panel is
    // drawn rather than nothing — an empty panel reads as a page that
    // broke — with the reason on the console rather than swallowed.
    if (beat) panel = renderStepPanel(beat, props, handlers);
    else if (zoom) panel = renderZoomPanel(zoom, props, handlers);
    else if (mask) panel = renderMaskPanel(mask, props, handlers);
    else {
      console.error(
        "[demoman] editor: the rail is on Selection with nothing selected",
      );
      panel = renderExportPanel();
    }
  } else if (rail === "background") {
    panel = renderBackgroundPanel();
  } else if (rail === "cursor") {
    panel = renderCursorPanel();
  } else if (rail === "shortcuts") {
    panel = renderShortcutsPanel();
  } else {
    panel = renderExportPanel();
  }
  // On every panel, in the card's corner beside its title. The rail's
  // pressed entry closes the panel too; this is the door where the eye
  // already is. Escape closes it as well, and the tooltip says so with the
  // key as a cap (`tooltip.ts`) — no native `title`, or both would show.
  const close = el("button", "btn btn-icon inspector-close");
  close.type = "button";
  close.setAttribute("data-inspector-close", "");
  close.setAttribute("aria-label", "Close panel");
  withTip(close, "Close", ["Esc"]);
  close.append(icon("close"));
  close.addEventListener("click", () => handlers.onClose());
  box.append(close, panel);
  root.replaceChildren(box);
}

import {
  CAMERA_DEFAULTS,
  composeForTarget,
  createImageFrameSource,
  createVideoFrameSource,
  detectKeyframeMotion,
  type FrameBundle,
  type FrameImage,
  type FrameSource,
  hoverVerdicts,
  LANDSCAPE_1080P,
  logoRasterHeight,
  type Presentation,
  planScene,
  type RenderTarget,
  type ResolvedPlan,
  renderFrame,
  type TimeSpan,
} from "@demoman/compositor";
import { checkLogoFile, DEFAULT_EXPORT_QUALITY } from "@demoman/run-core";
import {
  LOGO_DEFAULTS,
  MOTION_DEFAULTS,
  type SceneAspect,
  type SceneBranding,
  type SceneCursor,
  type SceneDocument,
  type SceneMotion,
  stepsInsideRemoved,
} from "@demoman/scene-schema";
import type { ExportQualityChoice } from "@demoman/studio-protocol";
import { createPlatform } from "#platform";
import {
  decodeLogo,
  type LogoSource,
  logoThumbnail,
  sharpnessNote,
} from "../../src/adapters/logo";
import type { LogoThumb } from "../../src/branding/controls";
import {
  type BrandKitsRead,
  checkKitName,
  type KitEntry,
  newKitId,
} from "../../src/core/brand-kit";
import { sceneLabel } from "../../src/core/scene-name";
import {
  type BrandingPatch,
  type BrandingPreview,
  resolveBrandingPreview,
  sameBranding,
} from "../../src/editor/branding";
import type { EditCommand } from "../../src/editor/commands";
import {
  applyExportEvent,
  type ExportFlow,
  IDLE_EXPORT,
} from "../../src/editor/export-flow";
import type { ExportReadiness } from "../../src/editor/export-run";
import {
  deliverableTitle,
  takeMeta,
  targetFor,
} from "../../src/editor/formats";
import {
  type Gesture,
  type GestureContext,
  type GestureResult,
  isRefusal,
  resolveGap,
  resolveGesture,
} from "../../src/editor/gestures";
import {
  type HintMark,
  hintsCurrent,
  markHints,
} from "../../src/editor/hint-gate";
import {
  HOVER_CHECK_FAILED,
  summarizeHoverVerdicts,
} from "../../src/editor/hover-report";
import {
  beatLabelAt,
  type FileType,
  frameOf,
  recordingOf,
} from "../../src/editor/jobs";
import { buildLaneModel, type LaneModel } from "../../src/editor/lanes";
import {
  resolvePieceRemoval,
  resolveSplit,
  samePoint,
} from "../../src/editor/pieces";
import type { StoredOutput } from "../../src/editor/ports";
import {
  COST_MIN_SAMPLES,
  COST_WINDOW,
  composeCostEstimate,
  createFrameSourceCache,
  createPlayer,
  createScrubber,
  cursorRedrawNeeded,
  motionRedrawNeeded,
  type PreviewFrameStats,
  presentationRedrawNeeded,
  previewHeightFor,
  previewScene,
  previewTarget,
  summarisePreviewFrames,
} from "../../src/editor/preview";
import { revealFailure } from "../../src/editor/reveal-failure";
import { sceneDigest } from "../../src/editor/scene-digest";
import { createSections } from "../../src/editor/sections";
import { createSession, type SessionSnapshot } from "../../src/editor/session";
import {
  isMacPlatform,
  resolveShortcut,
  type ShortcutAction,
} from "../../src/editor/shortcuts";
import { renderStageOverlay } from "../../src/editor/stage-overlay";
import type { TimelineView } from "../../src/editor/timeline";
import { buildTimelineView } from "../../src/editor/timeline";
import {
  fitAll,
  toFraction,
  type Viewport,
  zoomAt,
} from "../../src/editor/viewport";
import type {
  ExportEvent,
  OutputRow,
  RemoveReply,
  RevealTarget,
} from "../../src/platform/types";
import { withNote } from "../../src/shell/carried-note";
import { askToConfirm, DELETE_DEMO } from "../../src/shell/confirm-dialog";
import {
  isAuthoredScene,
  type RunsRoute,
  rerunAdvice,
  rerunLineOf,
} from "../../src/shell/runs-link";
import { installTooltips } from "../../src/shell/tooltip";
import { renderInspector } from "./inspector";
import {
  type RailEntry,
  renderExportDoor,
  renderRail,
  renderShortcutsDoor,
} from "./rail";
import { renderTakeInfo } from "./take-info";
import {
  playheadFraction,
  renderTimeline,
  renderTimelineTools,
  type Selection,
} from "./timeline-view";
import {
  patchExportProgress,
  renderBranding,
  renderBundleBanner,
  renderCursor,
  renderExport,
  renderFailure,
  renderHeaderIcons,
  renderNotesButton,
  renderShortcuts,
  renderStageBar,
  renderTakeNotes,
  renderTransport,
  revealNewErrors,
} from "./view";

/** Everything outside this page — the background, the stores, downloads,
 *  the other pages — reached through one module (spec 2026-10-15 §5). */
const platform = createPlatform();

// Every `SessionSnapshot`-changing call below returns a promise that CAN
// reject: `dispatch()` catches a failed persist internally and surfaces it
// through `snapshot().error`, but a synchronous throw inside the reducer, or
// a rejection from a dependency it does not itself wrap (a bundle re-read, a
// background round-trip), is not caught there and would otherwise reach the
// page as an unhandled rejection — a console error the author sees for no
// actionable reason. Every fire-and-forget promise in this file is routed
// through this so none of them are silent AND none of them are unhandled.
function reportError(error: unknown): void {
  console.error("demoman editor:", error);
}

const brandKits = platform.kits;
/** The brand kits as last read, for the Background panel's kit row. */
let kitsRead: BrandKitsRead = {
  state: "ready",
  kits: [],
  defaultId: null,
  migrationPending: false,
};
/** The kit the take was last seen on: matched by look, applied, or saved
 *  as new. In memory only — after a reload a take edited off its kit
 *  matches none and reads "Custom look" (the author's call, 2026-10-08:
 *  no kit id on the take). */
let basisKitId: string | null = null;
/** "Save as new kit"'s open name field (`KitRowProps.naming`): held here so
 *  the re-render on every session emit and storage change keeps it. */
let kitNaming: { text: string; error: string | null } | null = null;

/**
 * The kit the take is on, and whether it has moved off it (mockup A): a
 * ready kit whose look the take matches exactly — the one last seen, else
 * the default, else the first — and failing that the kit last seen, as
 * edited. Null is a take on no kit. Remembers the match, so an edit after
 * it reads as that kit, Edited.
 */
function kitStanding(
  branding: SceneBranding,
): { kit: KitEntry; edited: boolean } | null {
  const read = kitsRead;
  if (read.state !== "ready") return null;
  const ready = read.kits.filter((k) => k.read.state === "ready");
  const matches = ready.filter(
    (k) => k.read.state === "ready" && sameBranding(k.read.kit, branding),
  );
  const match =
    matches.find((k) => k.id === basisKitId) ??
    matches.find((k) => k.id === read.defaultId) ??
    matches[0];
  if (match !== undefined) {
    basisKitId = match.id;
    return { kit: match, edited: false };
  }
  const basis = ready.find((k) => k.id === basisKitId);
  return basis === undefined ? null : { kit: basis, edited: true };
}
const bundles = platform.bundles;
const sceneId = new URL(location.href).searchParams.get("scene") ?? "";

const $ = (id: string): HTMLElement => {
  const node = document.getElementById(id);
  if (!node) throw new Error(`editor is missing #${id}`);
  return node;
};

/**
 * The take's revision as this page read it at open, then as each of its own
 * writes left it: the studio's `If-Match` (always null on the extension,
 * which keeps none). `persist()` re-reads the scene before every write to
 * merge the fields the store owns, and that re-read must NOT move this — a
 * save would then carry the revision of another window's write and quietly
 * overwrite it, which is the race the studio's 409 `changedElsewhere` exists
 * to refuse (Review Focus 1).
 */
let sceneRevision: string | null = null;
let sceneRevisionRead = false;

const session = createSession({
  sceneId,
  loadScene: async (id) => {
    // A failed read rejects with its reason, and a take that is not stored
    // reads back null. Both end in `reportLoadFailure`; the reason is what
    // tells them apart there.
    const got = await platform.scenes.get(id);
    if (got === null) throw new Error(`no scene "${id}"`);
    // What reading the take took away, from the first read only: a save
    // writes the migrated document, so a later read has nothing to say.
    takeNotes ??= got.notes;
    if (!sceneRevisionRead) {
      sceneRevision = got.revision;
      sceneRevisionRead = true;
    }
    return got.scene;
  },
  saveScene: async (scene) => {
    // Rejects with the store's sentence on a refused write — which is what
    // keeps `session`'s whole revert-and-surface path reachable for the
    // likeliest failure there is, the store declining to take the scene.
    const saved = await platform.scenes.put(scene, sceneRevision);
    sceneRevision = saved.revision;
  },
  bundles: {
    active: (id) => bundles.active(id),
  },
  newId: () => crypto.randomUUID(),
});

/**
 * Every edit funnels through here so a rejection is logged, never unhandled.
 * Returns the settled promise (never rejects — the `catch` above lands
 * first) so a caller that needs its edits applied one at a time can await
 * it rather than calling `session.dispatch` directly and stepping around
 * this file's one place failures surface.
 *
 * It is also where a standing refusal is retired, because it is the one place
 * every command passes through. See `retireRefusal`.
 */
function dispatch(command: EditCommand): Promise<void> {
  const before = session.snapshot().scene;
  return session
    .dispatch(command)
    .catch(reportError)
    .then(() => retireRefusal(before));
}

/**
 * Take down a standing refusal, once an edit has actually landed.
 *
 * `TimelineState.refusal`'s contract is that it stands "until the next
 * successful command", and only `applyGesture` used to honour it: a refused
 * drag's line survived any number of successful edits from the inspector, the
 * insert popover and undo/redo, describing a gesture the author had long
 * since moved on from.
 *
 * The SCENE is what says whether something succeeded, not the promise and not
 * the error field alone. `session.dispatch` resolves normally for a command
 * the reducer rejects, and for one whose persist failed; an undo with
 * nothing to undo returns without touching anything at all. Every one of
 * those leaves the document exactly as it was, and none of them is a command
 * the author should read as having retired their last refusal.
 */
function retireRefusal(before: SceneDocument): void {
  if (refusal === null) return;
  const snapshot = session.snapshot();
  if (snapshot.scene === before || snapshot.error !== null) return;
  refusal = null;
  render(snapshot);
}

/** This page's own export (`export-flow.ts`). Only this page's job moves it. */
let exportFlow: ExportFlow = IDLE_EXPORT;
/** Why the last Show in Finder press showed nothing (`revealFailure`).
 *  Cleared by the next press and the next export. */
let revealError: string | null = null;
/** The last composite the preview could not draw. Page-local and transient,
 *  exactly like the export's error. */
let previewError: string | null = null;
/** The author closed the stage banner on `previewError`. The banner only:
 *  `#failure` keeps the reason. Reset by `showPreviewError` whenever the
 *  failure is a new one, so a fresh refusal is never born hidden. */
let previewErrorDismissed = false;
/** Sets `previewError`. A different message, or one after a clear, is a
 *  new failure and shows the banner again; the same draw failing again
 *  while the author trims past it is not, and leaves it closed. */
function showPreviewError(message: string): void {
  if (message !== previewError) previewErrorDismissed = false;
  previewError = message;
}
/**
 * A logo the picker handed over that is not an image, or null. Page-local:
 * the scene never saw it — that is the point — so `snapshot.error` cannot
 * carry it. Cleared by the next logo attempt, and by any edit that lands
 * after it (the scene is the ground truth for "landed", as `retireRefusal`
 * reads it), so it does not outlive the mistake it describes.
 */
let logoError: string | null = null;
let logoErrorScene: SceneDocument | null = null;
/** Muted notes under the Background panel's logo row (Task 7 fills it). */
let logoNotes: string[] = [];
/**
 * Why the take could not be read, or null. Set by `reportLoadFailure`,
 * cleared by the next snapshot the session emits — a session that emitted
 * has a scene in hand.
 */
let loadError: string | null = null;
/**
 * Why the last Delete attempt did not remove this demo, or null. Page-local,
 * like the export's error: `demo:delete`'s reply never touches the scene, so
 * `snapshot.error` has nothing to carry it. Set on a refusal or a partial
 * delete — never on success, which navigates away instead of leaving
 * anything here to read. Cleared at the top of every fresh attempt so a
 * stale message from a previous click cannot outlive it.
 */
let deleteError: string | null = null;
/** Which page did not open, and why — the Recordings page (Back, or the
 *  navigation after a clean delete) or the Runs page (any `[data-runs-route]`).
 *  `location.assign` throws rather than rejecting; caught and only logged,
 *  the author clicked and stayed put with nothing on screen saying why.
 *  Cleared at the top of the next attempt. */
let navigationError: { page: string; reason: string } | null = null;
/** What the author has picked: a step's tick, a zoom segment, a mask
 *  segment, or nothing. Null is "nothing selected yet", which returns the
 *  rail to the entry the author had open rather than leaving a Selection
 *  panel over nothing. Assigned only by `setSelection` below. */
let selection: Selection = null;
/** The removed piece whose restore card is open, or null (spec 2026-10-22
 *  split-tool). Here rather than in the timeline, which is redrawn whole. */
let openJoin: string | null = null;
/** The open rail entry, whether the panel is open, and the entry to return
 *  to when the selection clears. Page-local. */
let rail: RailEntry = "export";
let panelOpen = true;
let railBeforeSelection: Exclude<RailEntry, "selection"> = "export";
/** Which of the panels' disclosures the author has opened this session. */
const sections = createSections();
/** The file type the Export panel will produce. Page-local: which file to
 *  make is a question about this export, not about the demo. The frame's
 *  shape IS the demo's — `scene.canvas.aspect`, read through `deliverable`. */
let fileType: FileType = "mp4";

/** The target an export would render right now, and the one the preview
 *  scales. One function, so the preview and the file cannot disagree. */
function deliverable(bundle: FrameBundle | null): RenderTarget {
  const scene = session.snapshot().scene;
  const quality = qualityNow();
  // The live branding, not the stored one: under Auto the frame's shape
  // follows the padding, and a drag draws a padding not yet committed.
  return targetFor(
    fileType,
    scene.canvas.aspect,
    bundle,
    frameOf({ ...scene, branding: liveBranding(scene) }),
    // The studio exports at this panel's quality, so the readout names that
    // size. The extension has no such setting and passes nothing: Full-sized.
    quality === null ? {} : { quality },
  );
}

/** The studio's Export quality as last read, or null where the platform has
 *  none (the extension). Starts at the studio's default until the read
 *  answers, which is what the studio exports at when the read fails too. */
let exportQuality: ExportQualityChoice | null =
  platform.exportQuality === undefined ? null : DEFAULT_EXPORT_QUALITY;

/** The quality picked in the Export panel for this page's exports, or null
 *  to follow the Export quality setting. Page-local, like the file type. */
let pickedQuality: ExportQualityChoice | null = null;

/** The quality the next MP4 is made at, or null where there is none. */
const qualityNow = (): ExportQualityChoice | null =>
  exportQuality === null ? null : (pickedQuality ?? exportQuality);

let digestOf: { scene: SceneDocument; digest: string } | null = null;
/** `sceneDigest` of the scene on screen. Memoised by identity: `render`
 *  runs on every edit, and a scene's JSON is not free to canonicalise. */
function currentDigest(scene: SceneDocument): string {
  if (digestOf?.scene !== scene)
    digestOf = { scene, digest: sceneDigest(scene) };
  return digestOf.digest;
}
/** Fit letterboxes the picture inside the stage card (`#stage-box`);
 *  actual pixels shows it at
 *  `--frame-px` — one PREVIEW-BITMAP pixel per CSS pixel, not one
 *  deliverable pixel: `retarget` publishes `previewTarget(...)`'s own
 *  downscaled width below, so landscape's "100%" is 1280 CSS px against a
 *  1920px real output — 67% of it, not 1:1. Mirrored onto
 *  `body[data-zoom]` by `toggleZoom`, which is the only writer — the same
 *  shape `panelOpen`/`document.body.dataset.panel` already follows. */
let stageZoom: "fit" | "actual" = "fit";

/**
 * Every selection change goes through here so the rail follows it: picking
 * anything opens Selection and remembers the entry that was open; clearing
 * returns there. Eight sites assigned `selection` directly before this, and
 * each of them was a place the rail could have fallen out of step with the
 * panel beside it.
 */
function setSelection(next: Selection): void {
  // A piece has no panel: selecting one leaves the inspector where it is.
  if (next !== null && next.kind !== "piece") {
    if (rail !== "selection") railBeforeSelection = rail;
    rail = "selection";
    panelOpen = true;
  } else if (rail === "selection") {
    rail = railBeforeSelection;
  }
  selection = next;
}
/** The lane model from the last `render()`, read by the scrubber's `draw`
 *  so the stage overlay can follow the camera while scrubbing without
 *  paying for a full render on every animation frame. Null before the
 *  first render — the overlay has nothing to show yet either way. */
let lastModel: LaneModel | null = null;
/**
 * The other two halves of the last `render()`, for the keyboard.
 *
 * I and O resolve through the same `resolveGesture` the trim drag uses, and
 * + / − / ⇧Z need the take's length — neither of which the key handler has a
 * render pass of its own to build. Cached beside `lastModel` and for the
 * same reason; null and 0 before the first render, which every reader
 * checks. (`resolved`, the third thing they need, is already module-level
 * further down — `refreshDerived` keeps it current.)
 */
let lastView: TimelineView | null = null;
let lastDurationMs = 0;
/** The author pressed "+ Mask" this session, so the Mask lane stays even
 *  before a mask exists — the button's result is somewhere to see. */
/** The window of output time the timeline is showing. Null until the first
 *  draw fits one. */
let viewport: Viewport | null = null;
/** S, and the Snap button. On by design: this timeline snaps to markers, and
 *  a beat is its unit — off is the escape hatch, not the default. */
let snapping = true;
/**
 * The repeat button: whether playback wraps at an end instead of stopping.
 *
 * Off by default, and session-only — deliberately NOT written to the scene
 * document. It is how the author is watching the take right now, not
 * something about the take, and a demo that started looping for whoever
 * opened it next would be this preference leaking into the deliverable's
 * own document.
 */
let looping = false;
/** What is typed in Keyboard shortcuts' search, kept across the redraws
 *  `render` gives the inspector, and whether the next draw of that panel is
 *  the one that opened it — the only draw that hands its field the focus. */
let shortcutsQuery = "";
let focusShortcutsSearch = false;
/**
 * The duration `viewport` was fitted to.
 *
 * A viewport kept across a change in the take's length would silently show a
 * window past the end of the video — the clips would still be drawn, at
 * positions that no longer mean anything.
 */
let fittedDurationMs: number | null = null;
/** The last refused gesture, or null. Cleared by the next command that goes
 *  through — a refusal the author was not watching for is unrecoverable. */
let refusal: string | null = null;
let outputs: OutputRow[] = [];

/** The rows whose bytes this page holds. Download acts on these
 *  alone: a `file` row is on the studio's disk, reached by its path. */
function storedRows(): StoredOutput[] {
  return outputs.flatMap((row) => (row.kind === "stored" ? [row.output] : []));
}

/** Whether Take info lists every export or the newest few, for the life of
 *  the page: "Show all" stays pressed across re-renders. */
let historyShowAll = false;
/** Take info's history rows whose warnings chip is unfolded, by ref or key:
 *  kept across redraws, which replace the rows. */
const historyWarningsOpen = new Set<string>();

// The preview's target: the deliverable's shape at a working resolution,
// following the scene's aspect and the Export panel's file type. Mutable since
// 2026-09-14; it was pinned to landscape from SP7 until then, so the
// vertical cut was never previewed. `retarget` swaps all three together.
//
// `presentation` is derived once per (target, branding, viewport, logo) and
// reused for every scrubbed frame — the reason renderFrame takes a
// Presentation rather than deriving one itself.
let target: RenderTarget = previewTarget(LANDSCAPE_1080P);
let presentation: Presentation | null = null;
let resolved: ResolvedPlan | null = null;

const canvas = $("preview") as HTMLCanvasElement;
let offscreen = new OffscreenCanvas(target.width, target.height);
let offscreenCtx = offscreen.getContext(
  "2d",
) as OffscreenCanvasRenderingContext2D;

/**
 * Point the preview at the deliverable's target for this bundle.
 *
 * This guarded the whole swap on width/height/fit until review caught what
 * that drops: `derivePresentation` draws from `cornerRadius` too (and,
 * until 2026-10-05, a per-preset padding), and after `previewTarget` the GIF
 * target is 1280×720/contain exactly as landscape is, differing only there.
 * So landscape → gif kept landscape's inset while vertical → gif took
 * GIF's, and one pill drew two different pictures depending on the click
 * before it.
 */
function retarget(bundle: FrameBundle | null): void {
  const shape = deliverable(bundle);
  const next = solvePreviewTarget(
    bundle,
    $("stage-frame").getBoundingClientRect().width,
  );
  // Always take the new target: padding, corner radius and fit all reach
  // the draw through `derivePresentation`. Only the bitmap needs rebuilding,
  // and only when its size changed — rebuilding it per render is what
  // blanked the frame in flight.
  const resize = next.width !== target.width || next.height !== target.height;
  target = next;
  if (resize) {
    offscreen = new OffscreenCanvas(target.width, target.height);
    offscreenCtx = offscreen.getContext(
      "2d",
    ) as OffscreenCanvasRenderingContext2D;
  }
  // Derived per (target, branding, viewport, logo); the target just moved.
  presentation = null;
  // The frame's shape, for the stylesheet. `#stage-frame` sizes itself from
  // these, so the picture's box follows the format without a resize
  // observer — and `--frame-px` is what the zoom chip's 100% reads. Set
  // HERE because this is the one place `target` moves.
  //
  // Both DELIBERATELY independent of `target`'s current height, since
  // 2026-09-21: the bitmap now changes on every play and pause
  // (`previewHeightFor`), and `--frame-px` drives the zoom chip's "100%".
  // Read off `target` it would flip the chip's meaning twice per playback,
  // and under `data-zoom="actual"` it would resize the picture itself every
  // time the author pressed space.
  //
  // The ratio comes off the deliverable, which is the same number either
  // way. The width is pinned to the PLAYBACK-height preview, which is
  // exactly what this published before the split — so the chip behaves as it
  // always has. Whether "100%" should instead mean the output's own pixels
  // (Premiere/Resolve's reading) remains the open question `index.html`
  // states beside the rule; this change deliberately does not settle it.
  const stage = $("stage");
  stage.style.setProperty("--frame-ratio", `${shape.width} / ${shape.height}`);
  stage.style.setProperty("--frame-px", String(previewTarget(shape).width));
}

/**
 * How long the stage has to hold still before a parked preview re-targets to
 * its new size. The parked height follows the painted box pixel for pixel,
 * so a window drag or the panel's open/close transition moves it on nearly
 * every frame, and each move is a full recompose at full resolution — plus a
 * blanked canvas, since assigning `canvas.width` resets it. Until the resize
 * settles the old bitmap stays up, scaled by the stylesheet.
 */
const RESIZE_SETTLE_MS = 150;
let resizeSettle: ReturnType<typeof setTimeout> | null = null;

/**
 * Whether a pointer is down on the page: a drag in progress. A live panel
 * preview alone does not say so — `brandingPreview` outlives a release
 * that commits nothing (a slider dragged back to where it started fires no
 * `change`) until the next document change, and read as "mid-drag" it sent
 * every later settle down the recompose path, panels never rebuilt
 * (review, 2026-10-06).
 */
let pointerHeld = false;
/** A settle recomposed in place of a render mid-drag; any render pays it. */
let renderOwed = false;
document.addEventListener(
  "pointerdown",
  () => {
    pointerHeld = true;
  },
  true,
);
const pointerReleased = (): void => {
  pointerHeld = false;
  if (!renderOwed) return;
  // A task later, not now: Blink fires the slider's `change` — the commit,
  // and its own render — after the `pointerup` listeners, and a render
  // here would rebuild the slider before it committed.
  setTimeout(() => {
    if (renderOwed && !pointerHeld) render(session.snapshot());
  }, 0);
};
window.addEventListener("pointerup", pointerReleased, true);
window.addEventListener("pointercancel", pointerReleased, true);

/**
 * Where the floating control row sits, measured off the picture.
 *
 * `#stage-bar` lies ON the frame the way a player's controls do — in full
 * screen, the only place it shows — so it needs two numbers the stylesheet
 * cannot work out for itself.
 *
 * `--bar-w` is the picture's width, and it must be MEASURED rather than
 * derived. `--frame-w` is `min(100cqw, calc(100cqh * var(--frame-ratio)))`,
 * whose container query units resolve against `#stage-box`; `#stage-bar` is
 * that box's SIBLING, so the same expression evaluated there has no
 * eligible container and falls back to the small viewport — a width that
 * would be wrong in every layout while looking plausible in all of them.
 *
 * `--bar-lift` is the gap between `#stage`'s bottom edge and the picture's,
 * clamped at zero. A cut that letterboxes vertically lifts the row off the
 * stage's floor and onto the video; one that overflows — which is every
 * frame at 100% — leaves it on the floor, where it stays reachable while
 * the picture pans beneath it.
 *
 * BOTH boxes are observed, and that is not belt and braces: at 100% the
 * frame's size is pinned to `--frame-px`, so resizing the window changes
 * the stage without changing the frame, and an observer on the frame alone
 * would leave the lift describing a stage that has since moved.
 *
 * The stylesheet's fallbacks — `100%` and `0px` — are the full-width row on
 * the stage's floor, so a measurement that never arrives degrades to a
 * readable layout rather than to nothing.
 */
const stageFrameBox = new ResizeObserver(() => {
  const stage = $("stage");
  const frame = $("stage-frame").getBoundingClientRect();
  const box = stage.getBoundingClientRect();
  stage.style.setProperty("--bar-w", `${frame.width}px`);
  stage.style.setProperty(
    "--bar-lift",
    `${Math.max(0, box.bottom - frame.bottom)}px`,
  );
  // A parked preview is composed at the painted box's DEVICE pixels, so a
  // window resize, a panel toggle or a zoom switch changes how tall that
  // bitmap should be. Guarded on the height actually moving: this observer
  // fires on every layout pass, and an unguarded `render()` here would be a
  // full recompose per pass. Nothing below changes the layout — `--frame-px`
  // is pinned and the canvas's box is sized by `#stage-frame`, not by its
  // bitmap — so this cannot feed itself.
  //
  // Not before the take has loaded: the observer's first fire lands before
  // `session.load()` answers, and `render` on the placeholder scene throws —
  // an uncaught error on chrome://extensions, once at boot and again on
  // every resize after a failed load. The load's own render sizes the
  // bitmap, so nothing is owed here until then.
  if (!loaded) return;
  if (resizeSettle !== null) clearTimeout(resizeSettle);
  resizeSettle = setTimeout(() => {
    resizeSettle = null;
    const wanted = solvePreviewTarget(
      session.snapshot().bundle,
      $("stage-frame").getBoundingClientRect().width,
    );
    if (wanted.width !== target.width || wanted.height !== target.height) {
      // Mid-drag, recompose only. Under Auto a Padding drag reshapes the
      // frame and lands here; `render` would rebuild the panel from the
      // STORED branding and detach the slider under the pointer, so the
      // drag died wherever the author paused (final review, 2026-10-06).
      // The preview path re-targets through `refreshDerived` and touches
      // no panel DOM. Mid-drag is a pointer held with a preview live
      // (`pointerHeld`), and the render it skips is owed to the release.
      if (pointerHeld && (brandingPreview !== null || cursorPreview !== null)) {
        recomposeForPreview();
        renderOwed = true;
      } else {
        render(session.snapshot());
      }
    }
  }, RESIZE_SETTLE_MS);
});
stageFrameBox.observe($("stage-frame"));
stageFrameBox.observe($("stage"));

// Keyframe-diff motion hints, computed ONCE per bundle and reused.
//
// `renderScene` derives these itself (`detectKeyframeMotion`) and passes them
// into `resolvePlan`; without them the preview builds a different timeline
// from the deliverable. That is not hypothetical: replay clamps a motion
// span's `endMs` to a ceiling when a page animates continuously, so on a
// spinner or a carousel the bundle's spans understate the motion and only
// the keyframe diff catches the rest. Preview would then compress footage
// the deliverable passes through at rate 1.0 — beats landing at the wrong
// place on the scrubber, and the framing you scrub not being the framing you
// get, which is the one promise this preview exists to keep.
//
// Async and mildly expensive, so it runs on bundle change rather than per
// scrub; until it resolves the preview uses `[]` and then re-derives.
let motionHints: TimeSpan[] = [];
/** What `motionHints` and the hover report were computed against — see
 *  `hint-gate.ts` for why the bundle alone was not enough. */
let hinted: HintMark | null = null;

/** The removed pieces at the last draw: a removal moves the frame at the
 *  playhead without touching anything else the redraw gate compares. */
let drawnRemoved = "";

/** What reading the take took away from it (`scenes.get`'s notes), shown
 *  in the take's notes. Null until the first read. */
let takeNotes: string[] | null = null;

/** Said when a typed step's text in the take differs from what its frames
 *  typed: nothing draws the new text, so only a re-film shows it. */
const RETYPED_NOTE =
  "The video shows the text that was recorded; re-record to type the new text.";

/** Whether any typed step's text differs from what the frames typed. */
function retyped(snapshot: SessionSnapshot): boolean {
  const filmed = new Map(
    (snapshot.madeFrom ?? []).map((m) => [m.actionId, m] as const),
  );
  return snapshot.scene.actions.some((a) => {
    const then = filmed.get(a.id);
    return a.kind === "type" && then?.kind === "type" && then.text !== a.text;
  });
}

/**
 * The last `[demoman] editor: removed pieces` line written, so it is written
 * when the list changes rather than on every render — `render` runs on
 * every edit and, while playing, on every animation frame.
 */
let reportedRemovedLine: string | null = null;

/** The bundle the preview was last drawn from. See the seek in `render`. */
let drawnBundle: FrameBundle | null = null;
/** The preview bitmap's height at the last draw. `previewHeightFor` moves it
 *  on every play, pause and stage resize, and a re-targeted bitmap is a
 *  BLANK bitmap — assigning `canvas.width` resets it — so the render tail
 *  below has to re-arm on this exactly as it does on a new bundle. Without
 *  it, pausing cleared the picture and nothing drew it again. */
let drawnTargetHeight = 0;
/** The backdrop at the last draw. A colour or logo change moves neither the
 *  bundle nor the cursor, so without this the render tail recomposed the new
 *  backdrop and never drew it. See `presentationRedrawNeeded`. */
let drawnPresentation: Presentation | null = null;
/**
 * The decoded frame source for the bundle on screen, built once per bundle.
 *
 * See `createFrameSourceCache`: building this per draw is what made playback
 * unaffordable, since every motion span is loaded and decoded on the way.
 */
const framesFor = createFrameSourceCache((bundle: FrameBundle) =>
  bundle.motionSpans.length > 0
    ? createVideoFrameSource(bundle, bundles.load, {
        // The preview draws the preceding keyframe for such a span, which
        // looks exactly like a page holding still; the export row says so
        // for a render, and this line says so for the preview.
        onSpanUnavailable: (ref, reason) =>
          console.info(
            `[demoman] preview: span ${ref} could not be decoded (${reason})`,
          ),
      })
    : Promise.resolve(createImageFrameSource(bundle, bundles.load)),
);

async function refreshHints(snapshot: SessionSnapshot): Promise<void> {
  const { bundle, scene } = snapshot;
  if (bundle === null) return;
  if (hintsCurrent(hinted, snapshot)) return;
  hinted = markHints({ scene, bundle });
  motionHints = [];
  const threshold = planScene(scene).retiming.motionDiffThreshold;

  // Everything below is async — video decode, then the check itself — and
  // `scene`/`bundle` are a snapshot of what the editor showed when this
  // call started, not a promise about what it still shows when it ends. An
  // edit can land mid-flight (a delete, a reorder — the same commands that
  // null `hoverReport` above), and `runCommand`'s null is the retirement
  // that edit is owed. Writing anything into `hoverReport` afterward, from
  // a computation this stale, would overwrite that retirement with a
  // finding about a scene that no longer exists — `removable` naming ids
  // the author can no longer act on. Checked fresh before EVERY write below,
  // not once up front, because staleness is exactly what an `await` can
  // introduce between here and there.
  const stillCurrent = (): boolean => {
    const current = session.snapshot();
    return current.scene === scene && current.bundle === bundle;
  };

  // Frame-source construction (video decode, in particular) is the
  // throw-prone step, and both the motion hints and the hover check need it.
  // A throw here used to happen outside any try/catch, leaving `hoverReport`
  // at `null` — which renders as no banner at all, so a crashed check looked
  // exactly like a clean take, and nothing retried for this bundle. Catch it
  // here and report HOVER_CHECK_FAILED, same as a failure in the check
  // itself below.
  //
  // Through `framesFor`, the same cache the preview draws from: this built
  // its own source beside it, so every bundle was decoded twice. The cache
  // drops a build that failed, so a throw here leaves nothing poisoned for
  // the preview.
  let frames: FrameSource;
  try {
    frames = await framesFor(bundle);
    motionHints = await detectKeyframeMotion(bundle, frames, threshold);
  } catch (error) {
    reportError(error);
    if (stillCurrent()) session.setHoverReport(HOVER_CHECK_FAILED);
    render(session.snapshot());
    return;
  }

  // Same frames, same once-per-bundle discipline, but guarded on its own:
  // a failure here must not cost the motion hints already computed above.
  try {
    const verdicts = await hoverVerdicts(scene, bundle, frames, threshold);
    if (stillCurrent()) {
      // The removed steps from the CURRENT scene, not the captured one: the
      // check is async and a piece can be removed while it runs.
      const cutSteps = stepsInsideRemoved(session.snapshot().scene);
      session.setHoverReport(summarizeHoverVerdicts(verdicts, cutSteps));
    }
  } catch (error) {
    // NOT null. Null is "has not run yet" and renders as no banner at all —
    // a crashed check would then be indistinguishable from a clean take.
    reportError(error);
    if (stillCurrent()) session.setHoverReport(HOVER_CHECK_FAILED);
  }
  render(session.snapshot());
}

// The branding logo, decoded once per `branding.logo.ref` and rasterised
// once per preview height (an SVG is redrawn at each; see `rasterAt`), then
// reused for every render — the same shape as `motionHints` above. Loaded
// async in `refreshLogo` rather than inline in `refreshDerived` because
// decoding is a browser API call this module cannot make synchronously.
let logo: FrameImage | null = null;
let loadedLogoRef: string | null = null;
/** The decoded logo, rasterised per preview height into `logo`. */
let logoSource: LogoSource | null = null;
/** Why the scene's logo could not be loaded, for the failure band. */
let logoLoadError: string | null = null;
/** `${ref}@${height}` of the raster in `logo`, so a play/pause height
 *  change re-rasterises an SVG and an unchanged one does not. */
let logoRasterKey = "";
/** The thumbnail `refreshLogo` last made, and the logo it is of. A render
 *  for any other ref shows the tile loading until `refreshLogo` catches
 *  up — see the Background panel's props. */
let logoThumbOf: { ref: string; thumb: LogoThumb | null } | null = null;
/** What the last `refreshLogo` render showed, so it renders only on change. */
let drawnLogo: FrameImage | null = null;
let drawnLogoLoadError: string | null = null;
/** What an upload said about itself (the JPEG note), keyed on the ref it
 *  was said about: the upload's own ref change must not clear it, and the
 *  next upload or a Remove does. */
let uploadNote: { ref: string; note: string } | null = null;

/**
 * A slider's value while it is being dragged, layered over the scene's own
 * cursor block when the frame is composed.
 *
 * The sliders commit on `change`, as the zoom slider does, because an
 * `input` listener would push an undo entry per animation frame of a drag.
 * This is what keeps the preview moving under the author's hand in between.
 * Page-local and never persisted: it is the author mid-gesture, not an edit.
 */
let cursorPreview: Partial<SceneCursor> | null = null;

/**
 * The Camera rows' slider mid-drag, layered over the document's `motion`
 * block the same way `cursorPreview` is over its cursor — same lifetime,
 * same three doors (`previewMotion`, `endMotionPreview`,
 * `dropCursorPreview`), same reason for all of them.
 *
 * Previewed in full: the layered block reaches `composeForTarget` in
 * `refreshDerived`, so every coalesced frame of a drag re-solves the camera
 * keys at the dragged smoothness, not just the blur. That costs no more than
 * the cursor's own preview, which already runs `planScene` + `resolvePlan`
 * per frame. The Zoom lane's segments are the one thing that waits for the
 * commit: redrawing the timeline is a `render`, and a render mid-drag would
 * rebuild the slider under the pointer.
 */
let motionPreview: Partial<SceneMotion> | null = null;

/**
 * The Background panel's in-flight control, layered over the scene's own
 * branding when the frame is composed — the colour picker, the angle, size
 * and opacity sliders. Controls commit on `change`, so one adjustment is one
 * undo entry; this is what moves the backdrop in between.
 *
 * Keyed on the scene it was taken against rather than cleared by a handler.
 * A release that commits nothing (Chrome fires `change` only when the value
 * moved) leaves a preview equal to the document, which is harmless, and the
 * next document change — its own commit, an undo, any edit — drops it for
 * good (`resolveBrandingPreview`). So there is no `onPreviewEnd` to forget,
 * unlike the Cursor panel's.
 */
let brandingPreview: BrandingPreview<SceneDocument> | null = null;

function liveBranding(scene: SceneDocument): SceneDocument["branding"] {
  const out = resolveBrandingPreview(brandingPreview, scene, reportError);
  // Written back: a preview the document has moved past is gone for good,
  // so the undo that hands back its original scene object cannot revive it.
  brandingPreview = out.preview;
  return out.branding;
}

function previewBranding(patch: BrandingPatch): void {
  brandingPreview = { patch, scene: session.snapshot().scene };
  recomposeForPreview();
  // Not a render, so the header's size is redrawn here: under Auto the
  // padding being dragged reshapes the frame, and the line would otherwise
  // hold the size from before the drag until it was committed.
  const snapshot = session.snapshot();
  renderTakeMeta(snapshot, deliverable(snapshot.bundle));
}

/**
 * Show in Finder (or in folder), from the outcome row or a Take info row.
 * Said on the page either way: a file moved since its export is the
 * author's own doing, so it goes out at `info`; anything else is a fault
 * (CLAUDE.md, console levels). `revealError` is drawn in both places.
 */
function revealFile(target: RevealTarget): void {
  if (revealError !== null) {
    revealError = null;
    render(session.snapshot());
  }
  platform.files.reveal(target).catch((error: unknown) => {
    const failed = revealFailure(error);
    if (failed.expected) console.info(`demoman editor: ${failed.text}`);
    else reportError(error);
    revealError = failed.text;
    render(session.snapshot());
  });
}

/** The header's line beside the take's name — see `takeMeta`. Reads the
 *  trim `render` last stored, so it is called after `render` stores it. */
function renderTakeMeta(snapshot: SessionSnapshot, target: RenderTarget): void {
  const meta = takeMeta({
    durationMs: trimTail - trimHead,
    fileType,
    target,
    hasFrames: readinessOf(snapshot).kind !== "noFrames",
  });
  const button = $("take-meta");
  button.textContent = meta;
  // What it opens, then what it says: a bare "Take info" hid the length
  // and size the button shows from a screen reader.
  button.setAttribute("aria-label", `Take info: ${meta}`);
}

/** The cursor block the canvas was last drawn with. See the render tail. */
let drawnCursor: SceneCursor | null = null;

/**
 * The cursor block the canvas should be drawn with right now: the scene's
 * own, with the author's in-flight drag layered over it.
 *
 * One place, because the same three-line merge sat in `refreshDerived`, in
 * the Cursor panel's fill and in the render tail's redraw guard — three
 * copies of the rule that the preview overrides the document, each of which
 * had to be found before the rule could be changed.
 */
function liveCursor(scene: SceneDocument): SceneCursor {
  return cursorPreview === null
    ? scene.cursor
    : { ...scene.cursor, ...cursorPreview };
}

/** The camera's motion the canvas should be drawn with right now: the
 *  document's block (or `MOTION_DEFAULTS` where it has none, which is what
 *  `resolvePlan` reads too) with the author's in-flight drag over it. */
function liveMotion(scene: SceneDocument): SceneMotion {
  const stored = scene.motion ?? MOTION_DEFAULTS;
  return motionPreview === null ? stored : { ...stored, ...motionPreview };
}

/** The motion block the canvas was last drawn with. See the render tail. */
let drawnMotion: SceneMotion | null = null;

/**
 * The canvas catching up with a slider mid-drag, WITHOUT rebuilding the
 * panel the author's pointer is resting on.
 *
 * This used to be `render(session.snapshot())`. `render` runs
 * `renderInspector`, which ends in `root.replaceChildren(box)`, and
 * `renderCursor`, which does the same — so the `<input type="range">` under
 * the pointer was detached and rebuilt on the drag's FIRST value change, and
 * Blink's implicit pointer capture went with it. Measured with a real mouse
 * drag from min to max over 20 moves (`editor-cursor-panel.test.ts`): 21
 * `input` events and a final 2.00 with the panel left alone, against 1 event
 * and a final 0.50 when the panel was replaced on `input` — the press landed
 * its own value change and then nothing tracked. Neither slider could be
 * dragged at all; an author crossing
 * the range needed ~20 separate press-drag-release gestures, each of which
 * committed its own undo entry — the exact opposite of what the
 * `input`/`change` split is for.
 *
 * So this path layers the patch, recomposes and re-seeks, and touches no
 * panel DOM. `cursorSlider` keeps its own chip's readout in step, which is
 * the only part of the panel that has to move.
 *
 * Known and accepted: the three style-preview canvases go on drawing the
 * PREVIOUS `scale` until `change` lands and a real render runs. That is a
 * cosmetic lag on three controls the author is not touching, and the cost of
 * it is a drag that works.
 *
 * Coalesced onto an animation frame because `input` fires at pointer-move
 * rate and each pass is a full `planScene` + `resolvePlan` + compose over
 * the take's whole cursor sample list. Before the fix it fired once per
 * gesture only because the gesture died.
 */
let cursorPreviewFrame: number | null = null;
function previewCursor(patch: Partial<SceneCursor>): void {
  cursorPreview = patch;
  recomposeForPreview();
}

/** `previewCursor`, for the Camera rows. Not a render, for its reason. */
function previewMotion(patch: Partial<SceneMotion>): void {
  motionPreview = patch;
  recomposeForPreview();
}

/** `endCursorPreview`, for the Camera rows: a release that commits
 *  nothing drops the override without rebuilding the panel. */
function endMotionPreview(): void {
  if (motionPreview === null) return;
  motionPreview = null;
  recomposeForPreview();
}

/**
 * The gesture ended WITHOUT a commit, so drop the override and put the
 * canvas back on the document.
 *
 * Blink dispatches `change` on a range input only when the released value
 * differs from the value the drag began at, so a drag that wanders and
 * returns to where it started commits nothing — and `onCursor`, the only
 * caller of `dropCursorPreview`, never runs. The override then outlived its
 * gesture: `liveCursor` layered a stale patch over the document on every
 * later render, so undo appeared to do nothing in the panel and on the
 * canvas while `renderScene` — which reads `session.snapshot().scene` —
 * still exported the document's real value. Preview and deliverable
 * disagreed with nothing saying so.
 *
 * It recomposes rather than rendering: a render would replace the
 * `<input type="range">` this fires from, and Blink does not dispatch
 * `change` on a detached element, so rendering here would swallow the
 * commit on every drag that HAS one. `cursorSlider` calls this only when it
 * knows no commit is coming, which is also why there is no flicker — the
 * look it restores is the one the slider is already sitting on.
 */
function endCursorPreview(): void {
  if (cursorPreview === null) return;
  cursorPreview = null;
  recomposeForPreview();
}

/**
 * Recompose and re-seek on the next frame, touching no panel DOM. Coalesced
 * because `input` fires at pointer-move rate and each pass is a full
 * `planScene` + `resolvePlan` + compose over the take's whole cursor sample
 * list. Before the drag was fixed it fired once per gesture only because the
 * gesture died.
 */
function recomposeForPreview(): void {
  if (cursorPreviewFrame !== null) return;
  cursorPreviewFrame = requestAnimationFrame(() => {
    cursorPreviewFrame = null;
    const snapshot = session.snapshot();
    refreshDerived(snapshot);
    // Not a swallowed failure: `resolved` is null exactly when there is no
    // bundle to compose from, which is the render tail's own condition for
    // not drawing either. The canvas is showing its placeholder and the
    // slider's own chip has already moved, so there is no picture here to
    // be wrong about.
    if (!resolved) return;
    // Kept in step with that tail: without it the next real render would
    // compare against a `drawnCursor` from before the drag and seek a second
    // time for a frame that is already on the canvas.
    drawnCursor = liveCursor(snapshot.scene);
    drawnMotion = liveMotion(snapshot.scene);
    drawnPresentation = presentation;
    player.seek(player.positionMs);
  });
}

/** The drag is over: drop the override, and any frame still queued for it,
 *  so the commit's own render is the last word rather than being followed
 *  by a recompose of the value it just committed. Both panels' overrides —
 *  the cursor's and the camera's sliders share one panel, and a render
 *  ends a drag on either. */
function dropCursorPreview(): void {
  if (cursorPreviewFrame !== null) cancelAnimationFrame(cursorPreviewFrame);
  cursorPreviewFrame = null;
  cursorPreview = null;
  motionPreview = null;
}

/** The Background panel's thumbnail for the logo the scene holds. */
function logoThumbFor(ref: string | null): LogoThumb | null {
  if (ref === null) return null;
  if (logoThumbOf?.ref === ref) return logoThumbOf.thumb;
  return { kind: "loading" };
}

async function refreshLogo(snapshot: SessionSnapshot): Promise<void> {
  const branding = liveBranding(snapshot.scene);
  const ref = branding.logo?.ref ?? null;
  if (ref !== loadedLogoRef) {
    loadedLogoRef = ref;
    logoSource = null;
    logoLoadError = null;
    logo = null;
    logoRasterKey = "";
    if (ref !== null) {
      const load = await platform.logos.load(ref);
      if (loadedLogoRef !== ref) return; // superseded while loading
      if (load.ok) logoSource = load.source;
      else logoLoadError = load.error;
    }
  }
  const height = logoRasterHeight(branding, target);
  const key = `${ref}@${height}`;
  if (logoSource !== null && height > 0 && key !== logoRasterKey) {
    logoRasterKey = key;
    try {
      const raster = await logoSource.rasterAt(height);
      // Superseded while rasterising: a later call owns `logo` now.
      if (loadedLogoRef !== ref || logoRasterKey !== key) return;
      logo = raster;
      // The source loaded (it is non-null), so any error standing is an
      // earlier height's raster failure — which this one has replaced.
      logoLoadError = null;
    } catch (error) {
      logo = null;
      logoLoadError = error instanceof Error ? error.message : String(error);
    }
  }
  // The Background panel's thumbnail of the same logo.
  let thumb: LogoThumb | null = null;
  if (ref !== null) {
    if (logoSource !== null) {
      try {
        thumb = { kind: "ready", url: await logoThumbnail(logoSource) };
      } catch (error) {
        thumb = {
          kind: "failed",
          reason: error instanceof Error ? error.message : String(error),
        };
      }
      if (loadedLogoRef !== ref) return; // superseded while drawing it
    } else if (logoLoadError !== null) {
      thumb = { kind: "failed", reason: logoLoadError };
    } else {
      thumb = { kind: "loading" };
    }
  }
  const thumbChanged =
    JSON.stringify(thumb) !== JSON.stringify(logoThumbOf?.thumb ?? null) ||
    (logoThumbOf?.ref ?? null) !== ref;
  logoThumbOf = ref === null ? null : { ref, thumb };
  // Notes that describe the stored logo, for the deliverable's own size.
  const sharp = logoSource
    ? sharpnessNote(
        logoSource,
        logoRasterHeight(branding, deliverable(snapshot.bundle)),
        deliverableTitle(fileType, snapshot.scene.canvas.aspect),
      )
    : null;
  const notes = [
    uploadNote?.ref === ref ? uploadNote.note : null,
    sharp,
  ].filter((n): n is string => n !== null);
  // Render only when something this owns moved. This runs on every session
  // emit, and a render rebuilds every panel and ends any cursor drag, so an
  // unconditional one here was an extra full render per emit.
  const changed =
    thumbChanged ||
    logo !== drawnLogo ||
    logoLoadError !== drawnLogoLoadError ||
    notes.join("\n") !== logoNotes.join("\n");
  logoNotes = notes;
  drawnLogo = logo;
  drawnLogoLoadError = logoLoadError;
  if (changed) render(session.snapshot());
}

function refreshDerived(snapshot: SessionSnapshot): void {
  retarget(snapshot.bundle);
  const { scene: stored, bundle } = snapshot;
  // The author mid-drag, if there is one. Layered here rather than in the
  // session so it never reaches the document or the undo stack. The stored
  // document is passed through unchanged when there is no drag, so a plan
  // keyed on scene identity still sees the same object.
  const cursor = liveCursor(stored);
  const branding = liveBranding(stored);
  // Only a drag puts a motion block on the scene here: with none, the
  // stored document's own `motion` (or its absence) is what `resolvePlan`
  // reads.
  const scene = previewScene(stored, {
    cursor,
    branding,
    motion: motionPreview === null ? stored.motion : liveMotion(stored),
  });
  // The render's own composition, not a re-implementation of its front
  // half: `composeForTarget` is what `renderScene` draws with, detail clamp
  // included, so the camera scrubbed here is the camera the deliverable
  // cuts to. Without a bundle there is nothing to resolve or draw.
  const composed = bundle
    ? composeForTarget({
        plan: planScene(scene),
        bundle,
        scene,
        target,
        // The zoom is cut against the DELIVERABLE's resolution, not this
        // bitmap's: the bitmap follows the window and flips on every play
        // and pause, and clamped against it one 1.8x zoom scrubbed at a
        // different size parked than playing — neither the export's.
        detailTarget: deliverable(bundle),
        hints: motionHints,
        logo,
      })
    : null;
  resolved = composed?.resolved ?? null;
  presentation = composed?.presentation ?? null;
  // Guarded, because assigning either one resets the canvas bitmap even when
  // the value is unchanged. `render()` runs on every edit, every session
  // emit and every render-progress message, so an unguarded assignment
  // blanked the preview each time with nothing queued to redraw it.
  if (canvas.width !== target.width) canvas.width = target.width;
  if (canvas.height !== target.height) canvas.height = target.height;
}

/**
 * What preview playback is actually achieving, and where its time goes.
 *
 * The preview's position comes from elapsed wall time and its draws are
 * dropped whenever one arrives mid-composite (`createScrubber`), so its
 * TIMING is trustworthy and its SMOOTHNESS is not. That is the right trade
 * for a scrub tool and the wrong thing to judge cursor motion on — which is
 * exactly what happened while the cursor's motion was being tuned, because
 * nothing here ever said how many frames were being dropped.
 *
 * Printed once per stretch of playback, at `info`: an expected outcome the
 * code owes a reason for, not a fault, so it stays off the Errors list on
 * chrome://extensions. Read the line it prints when you press pause — the
 * "fps drawn" figure against "asked" is the answer, and the three per-frame
 * costs after it say which stage to attack.
 */
/**
 * Recent per-megapixel composite costs, newest last.
 *
 * What `previewHeightFor` solves the playback height from. Compose cost is
 * proportional to destination area to within a percent, so a cost NORMALISED
 * by area predicts every candidate size — and it has to be measured, because
 * the spread between machines is 6.6x (a headless SwiftShader lane against
 * this author's GPU), far too wide for a constant.
 *
 * A window read at a percentile rather than a running figure: see
 * `composeCostEstimate` for what the decaying maximum this replaced got
 * wrong. Trimmed here so the array cannot grow for the life of the tab.
 */
const composeCosts: number[] = [];

/** Fold one completed draw into the window above. */
function noteComposeCost(composeMs: number, drawn: RenderTarget): void {
  const megapixels = (drawn.width * drawn.height) / 1_000_000;
  if (megapixels <= 0) return;
  composeCosts.push(composeMs / megapixels);
  if (composeCosts.length > COST_WINDOW * 2) {
    composeCosts.splice(0, composeCosts.length - COST_WINDOW);
  }
}

/**
 * The playback height, held for one stretch of playback.
 *
 * `retarget` runs on every render and a render can land mid-playback (a
 * session emit, a render-progress message), so re-solving there would
 * resize the bitmap under a running demo every time the estimate twitched.
 * Latched at the play, cleared at the stop.
 */
let latchedPlaybackHeight: number | null = null;

/**
 * Draws this stretch of playback has made, until the latch is re-solved
 * from them, once, at `COST_MIN_SAMPLES`. The latch is taken from what
 * parked drawing cost, and that misprices playback both ways: a take just
 * opened has drawn once or twice (no price, so the floor), and a parked
 * draw pays the first paint of each full-size still, which playback has
 * already paid. Measured 2026-10-23 on the author's Mac: plays latched at
 * 994x720 against 1646x1192 parked, then drew at 0.6 ms per megapixel,
 * about a tenth of a frame's budget at full size. Null once re-solved.
 */
let playDraws: number | null = null;

let previewPlaying = false;
const previewStats: PreviewFrameStats = {
  requestedFrames: 0,
  drawnFrames: 0,
  elapsedMs: 0,
  sourceLookupMs: 0,
  composeMs: 0,
  blitMs: 0,
};
let previewStartedAtMs = 0;
/** The bitmap playback actually ran at, captured at the play. By the time
 *  the line is printed the pause has already re-targeted back up, so
 *  `target` no longer describes the stretch being reported. */
let playedBitmap: { width: number; height: number } | null = null;
/** The decode, summed over the drawn frames — `compose.ts`'s `fetch` stage
 *  and the only one recorded. See `PreviewFrameStats.decodeMs` for why the
 *  other six were dropped. */
let previewDecodeMs = 0;
/** Draws that contributed to `previewDecodeMs`, so an absent measurement is
 *  reported as absent rather than as a decode of zero. */
let previewPlayedFrames = 0;

function resetPreviewStats(): void {
  previewStats.requestedFrames = 0;
  previewStats.drawnFrames = 0;
  previewStats.elapsedMs = 0;
  previewStats.sourceLookupMs = 0;
  previewStats.composeMs = 0;
  previewStats.blitMs = 0;
  previewDecodeMs = 0;
  previewPlayedFrames = 0;
  previewStartedAtMs = performance.now();
}

/** Called on every player state change; logs one line when playback ends. */
function notePreviewPlayback(): void {
  if (player.playing === previewPlaying) return;
  previewPlaying = player.playing;
  // The bitmap's resolution follows playback, so the flip itself is what
  // re-targets it: down to `PREVIEW_HEIGHT` to keep the composite inside a
  // frame budget, back up to the painted device pixels the moment the demo
  // parks. `render`'s tail redraws, because it now re-arms on the height.
  render(session.snapshot());
  if (previewPlaying) {
    // `render` has just re-targeted to the playback height; this is it.
    playedBitmap = { width: target.width, height: target.height };
    resetPreviewStats();
    return;
  }
  previewStats.elapsedMs = performance.now() - previewStartedAtMs;
  // Read BEFORE the render above re-targets... which it already did, so
  // `target` is the parked bitmap by now and the played one has to come
  // from the latch that was in force. `playedBitmap` is captured at the
  // play for exactly that reason: reading `target` here would report the
  // resolution playback is ABOUT to return to and call it the one it ran
  // at, which is the same shape of lie the whole line exists to remove.
  const keyframes = session.snapshot().bundle?.keyframes ?? [];
  const biggest = keyframes.reduce<{ width: number; height: number } | null>(
    (best, k) =>
      best === null || k.width * k.height > best.width * best.height
        ? { width: k.width, height: k.height }
        : best,
    null,
  );
  console.info(
    summarisePreviewFrames({
      ...previewStats,
      ...(biggest === null ? {} : { sourceFrame: biggest }),
      // The decision, beside what it achieved: which bitmap playback used,
      // which one parking returns to, and the measurement that chose.
      ...(playedBitmap === null ? {} : { bitmap: playedBitmap }),
      parkedHeight: target.height,
      msPerMegapixel: composeCostEstimate(composeCosts),
      ...(previewPlayedFrames > 0 ? { decodeMs: previewDecodeMs } : {}),
    }),
  );
}

const scrubber = createScrubber({
  schedule: (fn) => requestAnimationFrame(fn),
  // A failed draw is forgiven — see `createScrubber` — but never unreported.
  // Under playback especially: a frozen canvas beneath a clock that keeps
  // counting is a failure drawn exactly like a demo that holds still.
  onDrawFailed: (error) => {
    showPreviewError(error instanceof Error ? error.message : String(error));
    player.pause();
    render(session.snapshot());
  },
  // Guarded, because this fires on every frame drawn and a full render per
  // frame is exactly what `renderTransportRow` exists to avoid. Unguarded it
  // would also be a lie in the other direction: nothing to take down.
  onDrawRecovered: () => {
    if (previewError === null) return;
    previewError = null;
    render(session.snapshot());
  },
  draw: async (outputTimeMs) => {
    const snapshot = session.snapshot();
    // Everything this draw composes with, read ONCE. Play, pause and a
    // settled resize all swap `target`, `offscreen` and the plan between
    // this draw's awaits; read afresh after them, a draw composed into the
    // old bitmap blitted the NEW, blank one and priced its compose against
    // the new target's area — a 2160-high draw scored against a 720-high
    // target, ~9x too dear, skewing the playback height it calibrates.
    const drawing = { resolved, presentation, target, offscreen, offscreenCtx };
    if (!drawing.resolved || !drawing.presentation || !snapshot.bundle) return;
    const startedAt = performance.now();
    const frames = await framesFor(snapshot.bundle);
    const fetched = performance.now();
    await renderFrame({
      resolved: drawing.resolved,
      target: drawing.target,
      presentation: drawing.presentation,
      frames,
      ctx: drawing.offscreenCtx,
      outputTimeMs,
      // Only the decode is recorded: the synchronous stages cannot be
      // measured apart (see `PreviewFrameStats.decodeMs`).
      onStage: previewPlaying
        ? (name, ms) => {
            if (name === "fetch") {
              previewDecodeMs += ms;
              previewPlayedFrames += 1;
            }
          }
        : undefined,
    });
    const composed = performance.now();
    // Re-targeted mid-draw: this frame was composed for a bitmap that is no
    // longer on screen, so it is neither shown nor priced. Not a failure —
    // the re-target re-armed a draw (`render`'s tail seeks when the height
    // moves), and the scrubber runs it as soon as this one returns.
    if (drawing.offscreen !== offscreen) return;
    // Calibrates the playback height. Taken on EVERY draw, not only under
    // playback: parked scrubbing is what measures the machine before the
    // author ever presses play, which is why the first playback is not
    // stuck on the uncalibrated floor.
    noteComposeCost(composed - fetched, drawing.target);
    // The blit. renderFrame's parameter is an OffscreenCanvas 2D context and
    // casting a CanvasRenderingContext2D into it would be a lie the type
    // system cannot catch; one drawImage keeps it honest.
    canvas.getContext("2d")?.drawImage(offscreen, 0, 0);
    // After this frame's blit, so it is shown: once this play's own draws
    // can price it, the latch is re-solved from them alone (`playDraws`).
    if (player.playing && playDraws !== null) {
      playDraws += 1;
      if (playDraws >= COST_MIN_SAMPLES) {
        const own = composeCosts.slice(-playDraws);
        const was = latchedPlaybackHeight;
        latchedPlaybackHeight = null;
        latchedPlaybackHeight = solvePreviewTarget(
          session.snapshot().bundle,
          $("stage-frame").getBoundingClientRect().width,
          own,
        ).height;
        // After the solve, which starts a count of its own on a new latch.
        playDraws = null;
        if (latchedPlaybackHeight !== was) {
          render(session.snapshot());
          playedBitmap = { width: target.width, height: target.height };
        }
      }
    }
    // The mask box / zoom focus track the camera while scrubbing. This runs
    // per animation frame, so it is skipped entirely unless a mask or a zoom
    // is actually selected — the one case with nothing on screen for it to
    // move.
    if (
      lastModel &&
      (selection?.kind === "mask" || selection?.kind === "zoom")
    ) {
      renderStageOverlay(
        $("stage-overlay"),
        {
          canvas,
          selection,
          model: lastModel,
          resolved: drawing.resolved,
          presentation: drawing.presentation,
          target: drawing.target,
          outputTimeMs,
        },
        {
          onMaskRect: (id, rect) => dispatch({ kind: "moveMask", id, rect }),
          onZoomPoint: (id, point) =>
            dispatch({ kind: "setZoomTarget", id, point }),
        },
      );
    }
    if (previewPlaying) {
      previewStats.drawnFrames += 1;
      previewStats.sourceLookupMs += fetched - startedAt;
      previewStats.composeMs += composed - fetched;
      previewStats.blitMs += performance.now() - composed;
    }
  },
});

/**
 * The take's own trim, in output ms on the untrimmed axis — where the
 * deliverable's own clock starts and ends, and (with no trim edits at all)
 * the untrimmed length itself, since `trimTail` then equals it. `render` is
 * the only place that knows either number; both are read by
 * `renderTransportRow`, which runs on every tick and must not pay for a
 * full timeline rebuild to get them. `player` plays and seeks within
 * `[trimHead, trimTail]`; the playhead itself stays on the untrimmed axis
 * (`playheadFraction` reads `player.positionMs` directly, and the timeline
 * itself is drawn against `model.durationMs`), so only the transport
 * readout's own numbers are shifted to count the deliverable's clock rather
 * than the recording's.
 */
let trimHead = 0;
let trimTail = 0;

let hasBundle = false;

const player = createPlayer({
  seek: (outputMs) => {
    if (previewPlaying) previewStats.requestedFrames += 1;
    scrubber.seek(outputMs);
  },
  durationMs: () => (hasBundle ? trimTail : 0),
  startMs: () => trimHead,
  // Read per tick rather than pushed, so the button and the player cannot
  // come to disagree about a flag only one of them draws.
  looping: () => looping,
  now: () => performance.now(),
  schedule: (fn) => requestAnimationFrame(fn),
  onChange: () => {
    notePreviewPlayback();
    renderTransportRow();
  },
});

/**
 * The preview target for a painted width: the one answer `retarget` takes
 * and the resize observer compares against. The observer used to solve its
 * own height with neither the playback latch nor the measured compose cost,
 * so while playing it disagreed with the target it was checking and fired
 * a full render — every panel rebuilt, a slider drag cut off — on every
 * resize, for a height the render then left where it was.
 */
function solvePreviewTarget(
  bundle: FrameBundle | null,
  paintedCssWidth: number,
  costs: readonly number[] = composeCosts,
): RenderTarget {
  const shape = deliverable(bundle);
  const solve = (): number =>
    previewHeightFor({
      target: shape,
      paintedCssWidth,
      devicePixelRatio: window.devicePixelRatio,
      playing: player.playing,
      msPerMegapixel: composeCostEstimate(costs),
    });
  // Playing, the answer is latched for the whole stretch — see
  // `latchedPlaybackHeight`. Parked, it is re-solved every time, because the
  // painted box is what it follows and that moves with the window.
  if (!player.playing) {
    latchedPlaybackHeight = null;
    return previewTarget(shape, solve());
  }
  if (latchedPlaybackHeight === null) {
    latchedPlaybackHeight = solve();
    playDraws = 0;
  }
  return previewTarget(shape, latchedPlaybackHeight);
}

/**
 * The stage's aspect toggle. The aspect is the scene's, so this is an edit:
 * one undo entry, saved with the demo. The canvas is reshaped inside the
 * render the dispatch triggers (`refreshDerived` → `retarget`), and the
 * current frame is redrawn after it through the scrub path.
 */
function pickAspect(next: SceneAspect): void {
  if (next === session.snapshot().scene.canvas.aspect) return;
  void dispatch({ kind: "setAspect", aspect: next }).then(() =>
    player.seek(player.positionMs),
  );
}

/** The Export panel's file type. Page-local, so no dispatch: swap the
 *  target inside `render`, then redraw the current frame. */
/** The Export panel's Quality: this page's exports, not the setting. Focus
 *  is put back as `pickFileType` does, for the same rebuild. */
function pickQuality(next: ExportQualityChoice): void {
  if (next === qualityNow()) return;
  const keyboard =
    document.activeElement instanceof HTMLElement &&
    document.activeElement.hasAttribute("data-export-quality");
  pickedQuality = next;
  render(session.snapshot());
  if (keyboard) {
    document
      .querySelector<HTMLButtonElement>(`[data-export-quality="${next}"]`)
      ?.focus();
  }
}

function pickFileType(next: FileType): void {
  if (next === fileType) return;
  // Read BEFORE the render that destroys it. A keyboard author moving
  // through the File type radiogroup had focus fall to `<body>` on every
  // selection — `render` rebuilds the panel wholesale, and the segment they
  // just activated goes with it, so the next arrow key did nothing. The
  // stage bar's aspect toggle avoids this by patching rather than
  // rebuilding; this panel cannot, since the summary and the aspect note
  // above it change with the type, so the place is restored instead.
  const keyboard =
    document.activeElement instanceof HTMLElement &&
    document.activeElement.hasAttribute("data-file-type");
  fileType = next;
  render(session.snapshot());
  if (keyboard) {
    document
      .querySelector<HTMLButtonElement>(`[data-file-type="${next}"]`)
      ?.focus();
  }
  player.seek(player.positionMs);
}

/**
 * Whether the panel's transition is live, said once at boot.
 *
 * A transition that is declared but not running looks identical, from the
 * outside, to a build that was reloaded without being rebuilt — and telling
 * those two apart by inspection cost four rounds on 2026-09-20 before this
 * line existed and answered it immediately. Its PRESENCE means the current
 * build is the one running; `transition-property` is whether the animation
 * is actually in force.
 *
 * `info`, not `warn`: nothing here is wrong, and only `console.error` and
 * above reach an extension page's Errors list.
 */
console.info(
  `demoman editor: panel transition "${getComputedStyle(document.body).transitionProperty}"`,
);

/**
 * The stage's overlay boxes — a selected mask or zoom — are positioned in
 * ELEMENT pixels, computed at draw time by `drawnBox`. Opening or closing
 * the panel changes the stage's width over `--panel-ms` with no draw in
 * between, so those boxes would sit where the old width put them and drift
 * against the picture as it widens.
 *
 * Redrawn once the column settles rather than on every frame of it: forcing
 * a redraw per frame means re-composing the frame per frame, and the box
 * lags for the length of the animation either way — this at least lands it
 * in the right place. Gated on something actually being on screen for it to
 * move, which is the same condition the draw loop uses, so an ordinary
 * toggle with nothing selected costs nothing.
 *
 * `transitionend` fires once per property; the grid track is the one whose
 * end means the width has finished moving.
 */
document.body.addEventListener("transitionend", (event) => {
  if (event.target !== document.body) return;
  if (event.propertyName !== "grid-template-columns") return;
  if (selection?.kind !== "mask" && selection?.kind !== "zoom") return;
  player.seek(player.positionMs);
});

/**
 * The transport and the playhead alone.
 *
 * Separate from `render` because this runs once per animation frame while
 * playing: a full `render` there would rebuild the timeline, the inspector
 * and the export panel sixty times a second, under the author's own cursor.
 * The playhead is therefore moved in place rather than redrawn.
 */
function renderTransportRow(): void {
  renderTransport(
    $("transport"),
    {
      authored: isAuthoredScene(session.snapshot().scene),
      rerunLine: rerunLineOf(runsRouteOf(session.snapshot())),
      playing: player.playing,
      enabled: hasBundle && trimTail > trimHead,
      rate: player.rate,
      looping,
    },
    {
      onToggle: togglePlayback,
      // Straight to the dispatcher the keys use, rather than a second
      // `player.seek(trimHead)` written out here: the button and ⌘← are
      // the same action, and two copies of "where the start is" could
      // disagree the next time the trim's meaning changes.
      onSkipToStart: () =>
        runShortcut({ kind: "seekEdge", edge: "head" }, session.snapshot()),
      onLooping: (next) => {
        looping = next;
        // This row only — the flag changes nothing the timeline, the
        // inspector or the export panel draw, and a full `render` here
        // would rebuild all three to repaint one button.
        renderTransportRow();
      },
      // The same clearing the J/L keys do in `runAction`: pressing a
      // transport control is the author saying "try again", and holding the
      // last draw failure past it would describe something that is no
      // longer the most recent thing that happened.
      onShuttle: (direction) => {
        previewError = null;
        player.shuttle(direction);
      },
    },
  );
  // Two roots, one state: the timeline toolbar's copy is the one the author
  // uses; `#stage-bar` is shown only while `#stage` is full screen, where
  // the dock is not painted at all (spec 2026-10-06, "Full screen"). Both
  // read the same fields on every pass, so they cannot disagree.
  //
  // The toolbar's clock has a root of its own, `#toolbar-clock`: the
  // grid's first column, so the row reserves its width (see
  // `renderStageBar`'s `clockRoot`). The floating bar keeps its clock in
  // the row with its chips.
  for (const [root, clockRoot] of [
    [$("stage-tools"), $("toolbar-clock")],
    [$("stage-bar"), $("stage-bar")],
  ] as const) {
    renderStageBar(
      root,
      {
        // The deliverable's own clock, not the recording's: shifted so 0 is
        // the trim's head, the same clock `trimTail - trimHead` reports as
        // the total.
        authored: isAuthoredScene(session.snapshot().scene),
        rerunLine: rerunLineOf(runsRouteOf(session.snapshot())),
        positionMs: player.positionMs - trimHead,
        durationMs: trimTail - trimHead,
        aspect: session.snapshot().scene.canvas.aspect,
        enabled: hasBundle && trimTail > trimHead,
        // Falsy, not `!== null` — see `toggleFullscreen`'s comment: jsdom
        // reads this property as `undefined`, not `null`, when nothing is
        // full screen.
        fullscreen: Boolean(document.fullscreenElement),
        // Routed here, not only to `#failure`: while the document is
        // actually full screen, `#failure` (in the `#notes` popover, outside
        // `#stage`) is not painted at all, and an exit refusal leaves the
        // document full screen. See `renderStageBar`'s own comment on `error`.
        error: previewErrorDismissed ? null : previewError,
        zoom: stageZoom,
      },
      {
        onAspect: pickAspect,
        onFullscreen: toggleFullscreen,
        onZoom: toggleZoom,
        onDismissError: () => {
          previewErrorDismissed = true;
          renderTransportRow();
        },
      },
      clockRoot,
    );
  }
  const playhead = $("timeline").querySelector<HTMLElement>("[data-playhead]");
  // Absent before the first `render` has drawn a timeline, and `viewport` is
  // null over exactly the same window. Nothing has gone wrong there and
  // there is nothing to say: the playhead this would move does not exist
  // yet, and the render that creates it positions it itself.
  if (playhead && viewport) {
    // Through the same function `renderTimeline` uses, so the playhead moved
    // in place between renders and the playhead a render draws cannot land in
    // two different places for one instant.
    playhead.style.left = `${(
      playheadFraction(viewport, player.positionMs) * 100
    ).toFixed(4)}%`;
  }
}

function togglePlayback(): void {
  // Pressing play is the author saying "try again". Holding the last
  // failure past that would leave a message describing a draw that is no
  // longer the most recent thing that happened.
  previewError = null;
  player.toggle();
  render(session.snapshot());
}

/**
 * Fit ↔ actual pixels. `body[data-zoom]` is what `index.html`'s
 * `body[data-zoom="actual"] #stage` rule reads — no draw, no resize
 * observer, just the attribute and the stage bar re-rendering so the
 * chip's own label follows.
 */
function toggleZoom(): void {
  stageZoom = stageZoom === "fit" ? "actual" : "fit";
  document.body.dataset.zoom = stageZoom;
  renderTransportRow();
}

/**
 * Full screen on `#stage`: the picture and its own floating control row
 * (`#stage-bar`, shown only there) together, so the picture is what grows.
 * Not the whole editor — the rail and the panel are not what anyone asks to
 * see bigger.
 *
 * The promise is the point. Unhandled, a rejection here is an uncaught
 * rejection on an extension page, which lands on the Errors list at
 * chrome://extensions. Caught, the request is forgiven and the REASON is
 * not: `previewError` is the page-local transient channel `#failure`
 * renders — and, because an EXIT refusal leaves the document full screen
 * (where `#failure`, outside `#stage`, does not paint at all),
 * `renderStageBar`'s own `[data-stage-error]` renders it too. The button's
 * own label is untouched because `fullscreenchange` never fired.
 */
function toggleFullscreen(): void {
  // Pressing the button is the author saying "try again" — the same
  // clearing `togglePlayback` and the shuttle keys do, and for the same
  // reason: holding the last refusal past a new attempt would describe a
  // request that is no longer the most recent one.
  previewError = null;
  // `!document.fullscreenElement` rather than `=== null`: jsdom (the node
  // test lane) has no Fullscreen API at all, so the property reads
  // `undefined` there rather than the `null` a real browser gives it —
  // `=== null` took the wrong branch under jsdom and called the
  // nonexistent `document.exitFullscreen`, thrown synchronously and never
  // reaching the `.catch` below. Falsy covers both.
  const entering = !document.fullscreenElement;
  const request = entering
    ? $("stage").requestFullscreen()
    : document.exitFullscreen();
  request.catch((error: unknown) => {
    // The branch decided above, not a single fixed verb: the author pressing
    // Exit full screen and having the exit itself refused must not be told
    // the preview "could not go full screen" — they are already full screen
    // and pressed the control that leaves it.
    showPreviewError(
      `The preview could not ${
        entering ? "go full screen" : "exit full screen"
      }: ${error instanceof Error ? error.message : String(error)}`,
    );
    render(session.snapshot());
  });
}

// The document is the authority on this, not the click: Escape and the
// browser's own chrome leave full screen without going through the button.
document.addEventListener("fullscreenchange", () => {
  // Read first, before anything below can hide the control that has it.
  // See the focus hand-over at the end of this listener.
  const focused = document.activeElement;
  // A change that reaches here succeeded, so any refusal reason still
  // standing (the exit branch's, `#stage-bar`'s own error since the
  // request branch's is already gone by the time this document actually
  // changes) describes something that is no longer true. Cleared before
  // the re-render, not after: `renderTransportRow` reads `previewError`
  // once, synchronously, and a clear that ran second would land after that
  // read.
  previewError = null;
  renderTransportRow();
  // `:fullscreen`, mirrored onto an attribute a test can set: the browser
  // test lane is refused real full screen outright ("Permissions check
  // failed"), so a rule keyed on `:fullscreen` alone would ship with
  // nothing exercising it.
  //
  // `index.html`'s `#stage[data-fullscreen] #stage-bar` reads it, beside
  // `#stage:fullscreen #stage-bar`: the floating control row is
  // `display: none` everywhere else, because outside full screen the same
  // controls are in the timeline toolbar (`#stage-tools`). (It hid the rail
  // too while the rail lived inside `#stage`, 2026-09-21 to 2026-10-07.)
  const entering = Boolean(document.fullscreenElement);
  $("stage").toggleAttribute("data-fullscreen", entering);
  // Focus follows the full-screen button across the swap. The author who
  // pressed the toolbar's copy is left focused on a button the browser no
  // longer paints — the dock is outside `#stage` — and the keydown guard
  // stands down for Space and Enter on a focused button, so Space in full
  // screen would re-press that invisible button and leave, instead of
  // playing. Leaving through the floating row's copy is the mirror case:
  // `display: none` takes the focus with it, to `body`.
  //
  // Only when the button that was just hidden HAD the focus: an author
  // typing in `#name`, or anywhere else, keeps it. `focused` is read at
  // the top of this listener, while `[data-fullscreen]` still showed the
  // floating row on the way out, so the hide above has not yet taken it.
  // Literal ids, not a computed one: `editor-shell-ids.test.ts` can only
  // check a lookup whose id it can read.
  const hidden = entering ? $("stage-tools") : $("stage-bar");
  const shown = entering ? $("stage-bar") : $("stage-tools");
  if (
    focused !== null &&
    focused === hidden.querySelector("[data-stage-fullscreen]")
  ) {
    const target = shown.querySelector<HTMLElement>("[data-stage-fullscreen]");
    if (target) {
      target.focus();
    } else {
      // `renderTransportRow` above builds this button in both roots, so
      // this is a broken render, not an expected outcome: said, not
      // swallowed, and the focus stays where the browser left it.
      console.warn(
        `demoman editor: no full-screen button in #${shown.id} to take the focus; it stays on a control that is no longer shown`,
      );
    }
  }
});

/** ⌘B and the Split button: split the clip at the playhead. */
function splitAtPlayhead(): void {
  const snapshot = session.snapshot();
  applyGesture(
    resolveSplit(
      snapshot.scene,
      snapshot.bundle,
      resolved?.timeline ?? null,
      player.positionMs,
    ),
  );
}

/**
 * What a resolved gesture does, for every caller that can produce one.
 *
 * Three outcomes, kept apart on purpose. `null` is the drag that ended where
 * it began: nothing to do, and nothing to say, because the author can already
 * see the clip where they left it. A `Refusal` is a gesture that cannot be
 * applied and must say why. A command is dispatched, and clears whatever the
 * last refusal said.
 *
 * Shared by the timeline's drags and the inspector's lead-in field, so a
 * value the drag would refuse is refused in the same words when it is typed.
 */
function applyGesture(result: GestureResult): void {
  if (result === null) return;
  if (isRefusal(result)) {
    refusal = result.reason;
    render(session.snapshot());
    return;
  }
  // Not cleared here. `dispatch` retires it when the command actually lands,
  // so a command the reducer rejects leaves the refusal standing rather than
  // replacing one failure's explanation with silence.
  void dispatch(result);
}

/**
 * Remove a zoom or a mask, and drop the selection only once it is really
 * gone. `dispatch` already reports a failure in
 * `snapshot.error`, but the selection is separate state, and clearing it
 * beside the call would make a refused removal look exactly like a
 * successful one — the segment still on the timeline, the inspector already
 * back to the demo panel.
 */
function removeSelected(
  command:
    | { kind: "removeZoom"; id: string }
    | { kind: "removeMask"; id: string },
): void {
  const selectionKind = command.kind === "removeZoom" ? "zoom" : "mask";
  const stillThere = (scene: SceneDocument): boolean =>
    command.kind === "removeZoom"
      ? scene.camera.some((c) => c.id === command.id)
      : scene.edits.masks.some((m) => m.id === command.id);
  void dispatch(command).then(() => {
    const snapshot = session.snapshot();
    if (stillThere(snapshot.scene)) return;
    if (selection?.kind !== selectionKind || selection.id !== command.id)
      return;
    setSelection(null);
    render(snapshot);
  });
}

/**
 * `session.load()` rejected. Before a first snapshot there is no scene to
 * render the page from — the session's placeholder is an empty object, and
 * `render` would throw on its first field — so the failure box is drawn on
 * its own, in the same element `render` uses for it. `console.error` too:
 * that is the line the developer's Errors list carries.
 */
function reportLoadFailure(error: unknown): void {
  reportError(error);
  loadError = error instanceof Error ? error.message : String(error);
  if (loaded) {
    render(session.snapshot());
    return;
  }
  renderFailure($("failure"), {
    error: null,
    replaySentence: null,
    captureSentence: null,
    openError: loadError,
  });
}

/**
 * Whether there is anything to export, for this snapshot. The panel's answer
 * to `noFrames` is the Runs route (`runsRouteOf`), never a disabled Export
 * alone (spec §7, "A take has no frames").
 */
function readinessOf(snapshot: SessionSnapshot): ExportReadiness {
  return snapshot.bundle === null ? { kind: "noFrames" } : { kind: "exact" };
}

/** This take's route to Runs, and whether Runs re-shoots it or runs its
 *  script again — see `RunsRoute`. */
function runsRouteOf(snapshot: SessionSnapshot): RunsRoute {
  const authored = isAuthoredScene(snapshot.scene);
  return {
    takeId: sceneId,
    authored,
    rerun: platform.nav.rerun(sceneId, authored),
  };
}

/**
 * The checked-in answer to "did my removed piece take out the frames I
 * expected" (CLAUDE.md, "Browser verification goes through something
 * checked in"). Read it on the editor tab's console: the line beginning
 * "[demoman] editor: removed pieces" names each piece's source stretch, and
 * the video should shorten by exactly its length. `info`: an unplaced piece
 * is a state, not a fault.
 */
function removedPiecesLine(plan: ResolvedPlan | null): string {
  const head = "[demoman] editor: removed pieces — ";
  const cuts = plan?.timeline.cuts ?? [];
  const unplaced = plan?.timeline.unplacedCuts ?? [];
  if (cuts.length + unplaced.length === 0) return `${head}none`;
  return `${head}${[
    ...cuts.map(
      (c) =>
        `${c.ids.join("+")} removed ${Math.round(c.srcStartMs)}-${Math.round(c.srcEndMs)}ms${c.trailing ? " (trailing)" : ""}`,
    ),
    ...unplaced.map((c) => `${c.ids.join("+")} removed nothing: ${c.reason}`),
  ].join("; ")}`;
}

function render(snapshot: SessionSnapshot): void {
  renderOwed = false;
  // A render rebuilds the Cursor panel, and with it the `<input type="range">`
  // a drag is riding — Blink's implicit pointer capture goes with the old
  // element, so the gesture is over whether or not it meant to be and no
  // `change` will follow to run `dropCursorPreview`. Anything that renders
  // mid-drag therefore ends the drag, and the override must not outlive it:
  // left behind, `liveCursor` layered it over every later snapshot, so undo
  // looked broken while the export path still read the document. `render`
  // reaches here from the `share:progress` broadcast and the render
  // `output`/`finished` handlers, neither of which knows a slider is down.
  //
  // Before `refreshDerived`, so the recompose below draws the document's own
  // cursor block rather than the abandoned patch.
  dropCursorPreview();

  refreshDerived(snapshot);

  const removedLine = removedPiecesLine(resolved);
  if (removedLine !== reportedRemovedLine) {
    reportedRemovedLine = removedLine;
    console.info(removedLine);
  }

  const view = buildTimelineView({
    scene: snapshot.scene,
    bundle: snapshot.bundle,
    resolved,
  });

  // An untitled take shows the label it goes by everywhere else as the
  // field's placeholder, so the header is never blank and the field never
  // pretends that label is a name somebody gave it.
  const nameField = $("name") as HTMLInputElement;
  nameField.value = snapshot.scene.meta.name;
  nameField.placeholder = sceneLabel(snapshot.scene.meta);
  ($("undo") as HTMLButtonElement).disabled = !snapshot.canUndo;
  ($("redo") as HTMLButtonElement).disabled = !snapshot.canRedo;

  renderBundleBanner($("banner"), {
    hasFrames: snapshot.bundle !== null,
    route: runsRouteOf(snapshot),
  });
  if (logoError !== null && snapshot.scene !== logoErrorScene) {
    logoError = null;
  }
  renderFailure($("failure"), {
    // The refused logo shares the edit box: it is an edit that did not
    // go through, and the session's own error has the same headline.
    error: snapshot.error ?? logoError,
    replaySentence: snapshot.replaySentence,
    replayRecoverable: snapshot.replayRecoverable,
    captureSentence: snapshot.captureSentence,
    renderError: exportFlow.error,
    previewError,
    logoLoadError,
    openError: loadError,
    deleteError,
    navigationError,
    runsRoute: runsRouteOf(snapshot),
  });
  const model = buildLaneModel({
    scene: snapshot.scene,
    view,
    bundle: snapshot.bundle,
    resolved,
    hoverReport: snapshot.hoverReport,
    rerunLine: rerunLineOf(runsRouteOf(snapshot)),
  });
  // Read by the scrubber's `draw`, which has no render pass of its own to
  // build one from.
  lastModel = model;
  lastView = view;
  lastDurationMs = model.durationMs;
  // Fitted on first draw and whenever the take's length changes under the
  // author — a viewport kept across a duration change would silently show a
  // window past the end of the video.
  if (viewport === null || fittedDurationMs !== model.durationMs) {
    viewport = fitAll(model.durationMs);
    fittedDurationMs = model.durationMs;
  }
  const gestureCtx: GestureContext = {
    resolved,
    bundle: snapshot.bundle,
    viewport: snapshot.scene.meta.capture.viewport,
  };
  // Named so `renderTimelineTools` can share them: `Snap` and
  // `Fit` moved off the timeline's own bar onto `#transport`, but the
  // gesture they dispatch and the viewport/snapping state they read are
  // still the timeline's — two render calls now draw one behaviour.
  const onGesture = (gesture: Gesture) =>
    applyGesture(resolveGesture(model, view, gesture, gestureCtx));
  const onViewportChange = (next: Viewport) => {
    viewport = next;
    render(session.snapshot());
  };
  const onSnappingChange = (next: boolean) => {
    snapping = next;
    render(session.snapshot());
  };
  renderTimeline(
    $("timeline"),
    model,
    {
      viewport,
      selection,
      // A getter: the Mask lane's + reads the playhead at its click, and
      // this row is drawn only by a full render (see `renderTimelineTools`'
      // call below for the same reason). Read once at render it is the
      // same value it always was.
      get positionMs() {
        return player.positionMs;
      },
      refusal,
      hoverReport: snapshot.hoverReport,
      snapping,
      openJoin,
    },
    {
      onSelect: (next) => {
        setSelection(next);
        render(session.snapshot());
      },
      onSeek: (ms) => player.seek(ms),
      // Pause, and stay paused. Playback and a pointer both driving the
      // playhead would make it jump under the hand holding it, and a drag
      // that silently resumed would leave the author studying a frame that
      // moved on without them.
      onSeekStart: () => player.pause(),
      onSplit: splitAtPlayhead,
      onRestorePiece: (id) => {
        openJoin = null;
        void dispatch({ kind: "restorePiece", id });
      },
      onOpenJoin: (id) => {
        openJoin = id;
        render(session.snapshot());
      },
      onGesture,
      onViewport: onViewportChange,
      onSnapping: onSnappingChange,
    },
  );
  // The take's own warnings, in the status row rather than in the dock —
  // see `renderTakeNotes`. Drawn after the model is built because both
  // halves of it come from the model and the snapshot, not from the
  // timeline's state.
  renderTakeNotes($("take-notes"), {
    notices: [
      ...(takeNotes ?? []),
      ...(retyped(snapshot) ? [RETYPED_NOTE] : []),
      ...model.notices,
    ],
    hoverReport: snapshot.hoverReport,
  });
  // The timeline's `Snap` / `Fit` bar controls, now drawn on the
  // transport row (`#timeline-tools`, a sibling of `.transport-controls`
  // inside `#transport`) rather than inside `#timeline` — see
  // `renderTimelineTools`'s own docs for why they needed to leave
  // `renderTimeline` to survive its `replaceChildren`.
  renderTimelineTools(
    $("timeline-tools"),
    model,
    {
      viewport,
      snapping,
      // A getter, not the value: the magnifiers and the slider read it when
      // clicked, and this row is drawn only by a full render — a nudge or a
      // playing clock repaints the transport alone. As a value, a click
      // zoomed about wherever the playhead was at the last rebuild, while
      // the − and + keys (`zoomTimeline`) zoomed about where it is.
      get positionMs() {
        return player.positionMs;
      },
    },
    {
      onGesture,
      onSplit: splitAtPlayhead,
      onViewport: onViewportChange,
      onSnapping: onSnappingChange,
    },
  );

  // The rail's idea of "something is selected" is whether the selection
  // resolves, not whether it is non-null: an undo can remove the thing a
  // selection names, and a Selection entry lit for a step that is gone is a
  // panel over nothing.
  //
  // Read into a const first: `selection` is a module-level `let`, so the
  // narrowing from each `kind` check does not survive into the callback
  // that uses it.
  const picked = selection;
  // A piece removed or restored away is gone: drop the selection, so the
  // next Delete does not aim at a piece that is not there.
  if (
    picked?.kind === "piece" &&
    !model.clip.pieces.some((p) => samePoint(p.start, picked.start))
  ) {
    selection = null;
  }
  const hasSelection =
    (picked?.kind === "tick" &&
      view.beats.some((b) => b.actionId === picked.actionId)) ||
    (picked?.kind === "zoom" && model.zooms.some((z) => z.id === picked.id)) ||
    (picked?.kind === "mask" && model.masks.some((m) => m.id === picked.id));
  if (rail === "selection" && !hasSelection) {
    if (selection === null) {
      // A deselect path missed the funnel: `setSelection(null)` is what
      // returns the rail, so the rail standing on Selection with nothing
      // selected at all means something assigned around it.
      reportError(new Error("the rail was on Selection with nothing selected"));
    }
    // A stale selection (undone away, deleted under it) is not a fault;
    // either way, fall back to the entry the author came from.
    setSelection(null);
  }
  document.body.dataset.panel = panelOpen ? "open" : "closed";
  renderRail(
    $("rail"),
    { rail, panelOpen, hasSelection },
    { onPick: pickPanel },
  );
  renderExportDoor(
    $("export-open") as HTMLButtonElement,
    { rail, panelOpen },
    { onPick: pickPanel },
  );
  renderShortcutsDoor(
    $("shortcuts-open") as HTMLButtonElement,
    { rail, panelOpen },
    { onPick: pickPanel },
  );
  // A redraw replaces the inspector's contents, field and all: one the
  // author was typing in gets the focus back, or the next key would land
  // on the editor instead.
  const typingInShortcuts =
    document.activeElement?.matches("[data-shortcuts-search]") === true;

  renderInspector(
    $("inspector"),
    {
      selection,
      view,
      model,
      scene: snapshot.scene,
      hoverReport: snapshot.hoverReport,
      viewport: snapshot.scene.meta.capture.viewport,
      rail,
      sections,
      // From the plan the preview was composed from, so the panel names the
      // edits the picture on screen is actually missing.
      attachedToCuts: resolved?.plan.attachedToCuts ?? [],
    },
    {
      onClose: closePanel,
      // Through the same resolver the pace drag uses, so a pause typed as a
      // negative — which `input[type=number] min="0"` does not stop — is
      // refused by name in the line under the timeline, rather than reaching
      // `SceneDocumentSchema.parse` and coming back to the author as a Zod
      // path for their own typo.
      onGap: (actionId, durationMs) =>
        applyGesture(resolveGap(view, actionId, durationMs)),
      // Not `setGap(…, 0)`. Absence restores the RECORDED pace; zero authors
      // a zero-length pause. Collapsing the two would take "play it back the
      // way I recorded it" out of the author's reach entirely.
      onGapClear: (actionId) =>
        dispatch({ kind: "clearGap", afterActionId: actionId }),
      onKeepHover: keepHover,
      // `addZoom`, element target, offset 0 — the step's own instant, no
      // camera intent about where it should aim beyond "here".
      onZoomOnStep: (actionId) => {
        const beat = view.beats.find((b) => b.actionId === actionId);
        if (!beat?.anchorId) return;
        // The scene BEFORE the dispatch, not just "no id yet": a refused
        // dispatch (a reducer or store refusal) leaves the
        // scene — and its camera array — exactly as it was, and `.at(-1)`
        // on that unchanged array is whatever zoom was already last, not
        // the one this click asked for. Selecting it would silently steal
        // the selection onto an unrelated zoom while the failure band says
        // why nothing was added; comparing against the id set from before
        // the call is what tells "nothing new" from "the new one".
        const before = new Set(
          session.snapshot().scene.camera.map((c) => c.id),
        );
        void dispatch({
          kind: "addZoom",
          marker: { actionId, offsetMs: 0 },
          target: { kind: "element", anchorId: beat.anchorId },
          scale: CAMERA_DEFAULTS.defaultZoomScale,
        }).then(() => {
          const added = session
            .snapshot()
            .scene.camera.find((c) => !before.has(c.id));
          if (added) {
            setSelection({ kind: "zoom", id: added.id });
            render(session.snapshot());
          }
          // Nothing new: leave the selection as it was. The failure band
          // already says why (or a rejected reducer left the scene
          // untouched with no error at all — either way there is no new
          // zoom to point the selection at).
        });
      },
      onZoomScale: (id, scale) => dispatch({ kind: "setZoomScale", id, scale }),
      onRemoveZoom: (id) => removeSelected({ kind: "removeZoom", id }),
      onMaskNote: (id, note) => dispatch({ kind: "setMaskNote", id, note }),
      onRemoveMask: (id) => removeSelected({ kind: "removeMask", id }),
    },
  );
  const shortcutsBox = document.querySelector<HTMLElement>(
    "#inspector [data-panel-shortcuts]",
  );
  if (shortcutsBox !== null) {
    renderShortcuts(
      shortcutsBox,
      {
        mac: isMacPlatform(navigator.userAgent),
        query: shortcutsQuery,
        focus: panelOpen && (focusShortcutsSearch || typingInShortcuts),
      },
      {
        onClose: closePanel,
        onQuery: (query) => {
          shortcutsQuery = query;
        },
      },
    );
  }
  focusShortcutsSearch = false;

  renderStageOverlay(
    $("stage-overlay"),
    {
      canvas,
      selection,
      model,
      resolved,
      presentation,
      target,
      outputTimeMs: player.positionMs,
    },
    {
      onMaskRect: (id, rect) => dispatch({ kind: "moveMask", id, rect }),
      onZoomPoint: (id, point) =>
        dispatch({ kind: "setZoomTarget", id, point }),
    },
  );

  // `renderInspector` always appends its own `.inspector` box to the root,
  // empty selection or not, so its absence means that render produced
  // nothing at all. Nothing downstream depends on the box any more — the
  // honesty note that used to be placed inside it was removed on
  // 2026-09-20 — but the check stays: an inspector that rendered nothing
  // and an inspector that is fine look identical from here, and silence
  // was the only difference between them.
  const inspector = $("inspector");
  if (inspector.querySelector(".inspector") === null) {
    reportError(new Error("the inspector has not rendered anything"));
  }

  /**
   * One of the demo panel's containers.
   *
   * `inspector.ts` owns each panel's layout and leaves these empty; the
   * renderers that fill them live in `view.ts` and are called from here.
   * Null while another rail entry is open is not a failure — it is the
   * other panel, and each container exists only on the entry that owns it
   * (`OWNER`). Null while its own entry is open and the panel is on screen
   * means the container itself went missing, and a panel that silently does
   * not render is how a dead control hides.
   */
  const OWNER = {
    export: "export",
    branding: "background",
    cursor: "cursor",
  } as const satisfies Record<string, RailEntry>;
  // Keyed by the map, not by `string`: a name with no owner would compare
  // against `undefined` and quietly never report a missing mount.
  const demoPanel = (name: keyof typeof OWNER): HTMLElement | null => {
    const node = inspector.querySelector<HTMLElement>(`[data-panel-${name}]`);
    if (node === null && rail === OWNER[name] && panelOpen) {
      reportError(new Error(`the inspector's ${name} panel is missing`));
    }
    return node;
  };

  const brandingPanel = demoPanel("branding");
  if (brandingPanel) {
    renderBranding(
      brandingPanel,
      {
        branding: snapshot.scene.branding,
        logoThumb: logoThumbFor(snapshot.scene.branding.logo?.ref ?? null),
        logoPlacement: presentation?.logoPlacement ?? null,
        formatTitle: deliverableTitle(fileType, snapshot.scene.canvas.aspect),
        logoNotes,
        kit: {
          read: kitsRead,
          standing: kitStanding(snapshot.scene.branding),
          naming: kitNaming,
          onApply: (id) => {
            const entry =
              kitsRead.state === "ready"
                ? kitsRead.kits.find((k) => k.id === id)
                : undefined;
            // The picker disables what cannot be applied, but the list it
            // drew from can change under an open menu (another tab's save
            // re-reads it), so a press that finds no usable kit says so.
            if (entry?.read.state !== "ready") {
              logoError =
                entry === undefined
                  ? "That brand kit was not applied: it was deleted in another tab."
                  : `That brand kit was not applied: ${entry.read.reason}.`;
              logoErrorScene = session.snapshot().scene;
              render(session.snapshot());
              return;
            }
            basisKitId = id;
            const { background, logo, padding } = entry.read.kit;
            // One undo entry: the whole kit as one patch.
            dispatch({
              kind: "setBranding",
              patch: { background, logo, padding },
            });
            // `setBranding` with an unchanged branding emits nothing, and
            // Update's label still has to move to this kit.
            render(session.snapshot());
          },
          onUpdate: () => void updateKit(),
          onStartNew: () => {
            kitNaming = { text: "", error: null };
            render(session.snapshot());
          },
          onNameInput: (text) => {
            if (kitNaming !== null) kitNaming = { text, error: null };
          },
          onConfirmNew: (text) => void saveNewKit(text),
          onCancelNew: () => {
            kitNaming = null;
            render(session.snapshot());
          },
        },
      },
      {
        onCommit: (patch) => dispatch({ kind: "setBranding", patch }),
        // Deliberately NOT a render — see `previewBranding`.
        onPreview: previewBranding,
        onLogoFile: (file) => addLogo(file).catch(reportError),
      },
    );
  }
  const cursorBox = demoPanel("cursor");
  if (cursorBox) {
    renderCursor(
      cursorBox,
      liveCursor(snapshot.scene),
      liveMotion(snapshot.scene),
      {
        onCursor: (patch) => {
          dropCursorPreview();
          dispatch({ kind: "setCursor", patch });
        },
        // Deliberately NOT a render — see `previewCursor`.
        onCursorPreview: previewCursor,
        onCursorPreviewEnd: endCursorPreview,
        onMotion: (patch) => {
          dropCursorPreview();
          dispatch({ kind: "setMotion", patch });
        },
        onMotionPreview: previewMotion,
        onMotionPreviewEnd: endMotionPreview,
      },
      // A phone take is drawn as taps (spec 2026-10-10 §5).
      snapshot.scene.meta.capture.device?.touch === true,
    );
  }
  // Once per render, for the header's line and the Export panel alike, so
  // the two cannot show different sizes.
  const exported = deliverable(snapshot.bundle);
  const exportPanel = demoPanel("export");
  if (exportPanel) {
    renderExport(
      exportPanel,
      {
        outputs,
        fileType,
        quality: qualityNow(),
        aspect: snapshot.scene.canvas.aspect,
        target: exported,
        // The size `targetFor` solved the Auto frame from.
        recording: recordingOf(snapshot.bundle, frameOf(snapshot.scene)),
        // Off the model this render built, not `trimHead`/`trimTail`:
        // those are updated further down this function, so they would
        // describe the trim before this edit.
        durationMs: model.clip.trim.tailMs - model.clip.trim.headMs,
        run: exportFlow.run,
        save: exportFlow.save,
        revealError,
        readiness: readinessOf(snapshot),
        runsRoute: runsRouteOf(snapshot),
        currentDigest: currentDigest(snapshot.scene),
        sections,
        beatAt: beatLabelAt(view.beats),
        hasReclaimedMotion:
          snapshot.bundle?.degradations.some(
            (d) => d.kind === "motionReclaimed",
          ) ?? false,
      },
      {
        onExport: () => startExport().catch(reportError),
        onFileType: pickFileType,
        onQuality: pickQuality,
        // The outcome row's Download again: the same save, for the rows
        // this page already lists.
        onSaveAgain: (refs) => saveRefs(refs).catch(reportError),
        onReveal: revealFile,
      },
    );
  }

  hasBundle = view.hasBundle;
  trimHead = model.clip.trim.headMs;
  trimTail = model.clip.trim.tailMs;
  // Every render, not only while the Export panel is open: the line is
  // always on screen, and the trim or the format it reads can change with
  // the panel closed. After the trim above, which it reads.
  renderTakeMeta(snapshot, exported);
  // Take info, behind that line: drawn every render like the line itself,
  // so the popover opens onto the take as it stands.
  renderTakeInfo(
    $("take-info"),
    {
      recordedAt: snapshot.scene.meta.createdAt,
      site: snapshot.scene.meta.capture.originUrl,
      durationMs: model.clip.trim.tailMs - model.clip.trim.headMs,
      steps: view.beats.length,
      recording: recordingOf(snapshot.bundle, frameOf(snapshot.scene)),
      target: exported,
      aspect: snapshot.scene.canvas.aspect,
      takeId: sceneId,
      rerun: runsRouteOf(snapshot).rerun,
      revealError,
      history: {
        outputs,
        currentDigest: currentDigest(snapshot.scene),
        showAll: historyShowAll,
        warningsOpen: historyWarningsOpen,
        reportContext: {
          beatAt: beatLabelAt(view.beats),
          runsRoute: runsRouteOf(snapshot),
        },
      },
    },
    {
      onCopy: (text) => navigator.clipboard.writeText(text),
      // A history row's Download: the same save as Download again.
      onDownload: (ref) => saveRefs([ref]).catch(reportError),
      onReveal: revealFile,
      onShowAll: () => {
        historyShowAll = true;
        render(session.snapshot());
      },
      onWarnings: (key) => {
        if (!historyWarningsOpen.delete(key)) historyWarningsOpen.add(key);
        render(session.snapshot());
        // The redraw replaced the chip that was pressed; the press stays
        // where it was made, so a keyboard author can fold it again.
        document
          .querySelector<HTMLElement>(
            `#take-info [data-output-warnings="${CSS.escape(key)}"]`,
          )
          ?.focus();
      },
    },
  );
  // A trim edit can move the head past where the playhead was resting —
  // `player`'s own clamp only runs on its NEXT `play()` or `seek()`, so
  // without this the transport readout would floor at a negative number
  // (`positionMs - trimHead`) until the author happened to move the
  // playhead themselves.
  if (player.positionMs < trimHead) player.seek(trimHead);
  // Symmetric: a trim edit can just as easily move the tail BEHIND where the
  // playhead was resting, and `player`'s own clamp is just as lazy about it
  // (only on the next `play()`/`seek()`) — without this the transport would
  // sit past the new tail, inside the newly-shaded cut, until the author
  // moved the playhead themselves.
  if (player.positionMs > trimTail) player.seek(trimTail);
  renderTransportRow();

  // Nothing else asks for the first frame. Without this the author opens a
  // scene with perfectly good frames and sees the grey placeholder until
  // they happen to drag the scrubber. Re-armed when a regeneration lands a
  // different bundle, for the same reason: the frames on screen are no
  // longer the frames this scene has.
  //
  // ...and re-armed on a cursor change, which is the same problem from the
  // other side. See `cursorRedrawNeeded`.
  //
  // ...and on a backdrop change, for the same reason: a new primary colour
  // or logo composes a different picture from the same bundle.
  //
  // ...and on a removed piece, for the same reason again: it moves none of
  // the bundle, the cursor or the backdrop, but the frame at the playhead
  // is now a different one.
  //
  // ...and on a motion change: a new smoothness or follow re-solved the
  // camera in `refreshDerived`, and nothing above would have re-seeked.
  // See `motionRedrawNeeded`.
  const cursorNow = liveCursor(snapshot.scene);
  const motionNow = liveMotion(snapshot.scene);
  const removedNow = JSON.stringify(snapshot.scene.edits.removed ?? []);
  if (
    resolved &&
    presentation &&
    (snapshot.bundle !== drawnBundle ||
      target.height !== drawnTargetHeight ||
      cursorRedrawNeeded(drawnCursor, cursorNow) ||
      motionRedrawNeeded(drawnMotion, motionNow) ||
      presentationRedrawNeeded(drawnPresentation, presentation) ||
      removedNow !== drawnRemoved)
  ) {
    drawnBundle = snapshot.bundle;
    drawnCursor = cursorNow;
    drawnMotion = motionNow;
    drawnPresentation = presentation;
    drawnTargetHeight = target.height;
    drawnRemoved = removedNow;
    player.seek(player.positionMs);
  }

  // The logo follows the format and the preview height as well as the
  // document: its sharpness note is for the deliverable's size and an SVG
  // is rasterised at the preview's. Neither a format switch nor a play /
  // pause height change is a session emit, so it is asked here. Bounded:
  // `refreshLogo` renders only when something it owns changed.
  void refreshLogo(snapshot).catch(reportError);
}

/**
 * "Keep this hover": the per-hover override on the develop-time pixel check.
 *
 * Drops one action from the in-memory report's `removable`, which is what
 * clears the clip's dashed flag and takes one off the bulk "Remove N
 * unchanged hovers" count. Deliberately NOT persisted: the verdict is
 * recomputed from pixels on every develop run, and a fresh run re-flagging
 * this hover on new evidence is a correct answer to a new question, not a
 * setting the editor forgot.
 */
function keepHover(actionId: string): void {
  const report = session.snapshot().hoverReport;
  if (report === null) {
    // Unreachable through the UI — the button only renders for an id that
    // is in `report.removable` — but returning quietly here would make the
    // one escape hatch from a wrong verdict a button that does nothing.
    reportError(new Error(`kept hover "${actionId}" with no hover report`));
    return;
  }
  session.setHoverReport({
    ...report,
    removable: report.removable.filter((id) => id !== actionId),
  });
}

/**
 * Checked, then decoded, before it is stored: a file that is not an image
 * must be refused here, where the failure can still be tied to the file
 * that caused it, rather than becoming a logo ref that draws nothing.
 * SVG decodes through `decodeLogo`'s `<img>` path — Chrome's
 * `createImageBitmap`, which this used until 2026-09-22, refuses SVG.
 */
async function addLogo(file: File): Promise<void> {
  logoError = null;
  const check = checkLogoFile(file);
  const refuse = (reason: string) => {
    logoError = reason;
    logoErrorScene = session.snapshot().scene;
    render(session.snapshot());
  };
  if (!check.ok) return refuse(check.reason);
  const bytes = new Uint8Array(await file.arrayBuffer());
  try {
    await decodeLogo(bytes, file.type);
  } catch (error) {
    return refuse(
      `The logo "${file.name}" could not be read as an image: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const { ref } = await platform.logos.put(file);
  uploadNote = check.note === null ? null : { ref, note: check.note };
  const existing = session.snapshot().scene.branding.logo;
  // Replace keeps where the author put the old one.
  const placement = existing
    ? {
        corner: existing.corner,
        size: existing.size,
        opacity: existing.opacity,
      }
    : LOGO_DEFAULTS;
  await session.dispatch({
    kind: "setBranding",
    patch: { logo: { ref, ...placement } },
  });
}

/**
 * Writes this demo's branding over the kit Update names, asking first. A
 * write that fails is said in the failure band, not swallowed: an Update
 * that did not save must not look like one that did.
 */
async function updateKit(): Promise<void> {
  const standing = kitStanding(session.snapshot().scene.branding);
  // Offered only for an edited take (mockup A): with nothing to update,
  // the menu greys it out, so this is a press that raced a change (an
  // undo, another tab's save). Said, so it does not pass for a save.
  if (standing === null || !standing.edited) {
    logoError =
      standing === null
        ? "No brand kit was updated: this demo is no longer on a kit."
        : `No brand kit was updated: this demo already matches "${standing.kit.name}".`;
    logoErrorScene = session.snapshot().scene;
    render(session.snapshot());
    return;
  }
  const target = standing.kit;
  const body = `This demo's background, logo and padding will replace the brand kit "${target.name}".`;
  try {
    // Inside the try: a dialog that could not open says so in the same
    // line a failed write does, rather than reading as a No.
    if (
      !(await askToConfirm({
        glyph: "refresh",
        title: `Replace "${target.name}"`,
        body,
        confirmLabel: "Replace",
        danger: false,
        // Enter goes ahead here, unlike Delete — the author's call on
        // 2026-10-04: a kit is a background and a logo, not a take.
        focus: "confirm",
      }))
    ) {
      return;
    }
    const branding = session.snapshot().scene.branding;
    const refused = await brandKits.update((cur) =>
      cur.kits.some((k) => k.id === target.id)
        ? {
            ...cur,
            kits: cur.kits.map((k) =>
              k.id === target.id ? { ...k, branding } : k,
            ),
          }
        : `it was deleted in another tab`,
    );
    if (refused !== null) throw new Error(refused);
    kitsRead = await brandKits.read();
  } catch (error) {
    logoError = `The brand kit "${target.name}" was not saved: ${
      error instanceof Error ? error.message : String(error)
    }`;
    logoErrorScene = session.snapshot().scene;
  }
  render(session.snapshot());
}

/**
 * Adds this demo's branding as a new kit under `text`. A name refused (a
 * clash, empty) is said beside the field, which stays open with the text;
 * a write storage refused is said in the failure band.
 */
async function saveNewKit(text: string): Promise<void> {
  const kits = kitsRead.state === "ready" ? kitsRead.kits : [];
  const name = checkKitName(text, kits, null);
  if (!name.ok) {
    kitNaming = { text, error: name.reason };
    render(session.snapshot());
    return;
  }
  const branding = session.snapshot().scene.branding;
  const id = newKitId();
  try {
    const refused = await brandKits.update((cur) => {
      // Checked again against the list as stored: another tab may have
      // taken the name since this page last read.
      const again = checkKitName(name.name, cur.kits, null);
      if (!again.ok) return again.reason;
      return {
        kits: [...cur.kits, { id, name: again.name, branding }],
        // The first kit is the default; after that, saving never moves it.
        defaultId: cur.defaultId ?? id,
      };
    });
    if (refused !== null) {
      kitNaming = { text, error: refused };
      render(session.snapshot());
      return;
    }
    kitNaming = null;
    basisKitId = id;
    kitsRead = await brandKits.read();
  } catch (error) {
    logoError = `The brand kit "${name.name}" was not saved: ${
      error instanceof Error ? error.message : String(error)
    }`;
    logoErrorScene = session.snapshot().scene;
  }
  render(session.snapshot());
}

/**
 * One press of Export: encode, then save.
 *
 * Straight to the encoder. Until 2026-09-28 a press first rebuilt whatever
 * the frames on screen could not show, when the policy allowed it; the
 * rebuild left the editor for the run page's Re-shoot (plan 2 of the agent
 * door, Task 7).
 *
 * A frameless take's button is disabled, with the Runs route drawn beside it
 * (`readinessOf`), so no press arrives here from one.
 */
async function startExport(): Promise<void> {
  revealError = null;
  const pressed = session.snapshot();
  const scene = pressed.scene;
  exportFlow = {
    run: { phase: "encoding", done: 0, total: 0 },
    save: null,
    error: null,
  };
  render(session.snapshot());
  try {
    // Every write this page still owes lands first (Review Focus 2). An
    // export pressed while an edit is being written would otherwise name the
    // revision from before it — which the studio refuses, `sceneNotSaved`,
    // for a scene the page has in fact saved — and on the extension it would
    // render the take without the edit. A write that failed leaves the
    // revision where it was, and a scene that really differs is refused
    // with the studio's own sentence below.
    await session.settled();
    await platform.exports.start(sceneId, {
      fileType,
      aspect: scene.canvas.aspect,
      revision: sceneRevision,
      // Unpicked, the studio reads Settings at export time and says when it
      // cannot; only an MP4 has a quality.
      ...(pickedQuality === null || fileType !== "mp4"
        ? {}
        : { quality: pickedQuality }),
    });
  } catch (error) {
    // The run is otherwise only reset by this job's end, and a job that
    // never started sends none: without this the button reads "Exporting…"
    // for the life of the page.
    exportFlow = {
      ...exportFlow,
      run: { phase: "idle" },
      error: error instanceof Error ? error.message : String(error),
    };
    render(session.snapshot());
    throw error;
  }
}

/**
 * A Recent exports row's Download, or the outcome row's Download again:
 * these outputs saved again, and what came of it recorded. A save of its
 * own — it never moves the run: pressed mid-encode, forcing "saving"
 * then "idle" gave the Export button back while the job was still running.
 */
async function saveRefs(refs: string[]): Promise<void> {
  const stored = storedRows();
  const rows = refs.map((ref) => stored.find((o) => o.ref === ref));
  const missing = refs.filter((_, i) => rows[i] === undefined);
  if (missing.length > 0) {
    // Was `if (!meta) throw …` in `download()`: a row this page does not
    // list cannot be saved, and saying so beats a button that does nothing.
    throw new Error(
      `no output row for ${missing.map((r) => `"${r}"`).join(", ")}`,
    );
  }
  if (rows.length === 0) return;
  const downloads = platform.downloads;
  if (downloads === undefined) {
    throw new Error("this page cannot save an export again");
  }
  exportFlow = {
    ...exportFlow,
    save: await downloads.save(rows as StoredOutput[]),
  };
  render(session.snapshot());
}

/** Complained about already: a missing button is one structural fault, and
 *  progress arrives a hundred-odd times per export. */
let progressMountComplained = false;

/**
 * Move the Export button and its bar for a progress tick — in place, not
 * through `render`.
 *
 * `render` is the wrong tool at this rate: read its comment, which spells
 * out that a render kills a Cursor slider drag, and note that the callers
 * it names are the handful of share and job messages. A per-frame tick is
 * not one of them.
 */
function showExportProgress(): void {
  const panel = document.querySelector<HTMLElement>("[data-panel-export]");
  // Null is the rail sitting on another entry — there is no bar on screen
  // to move, and whenever Export is opened again its render draws
  // the run as it then stands. Nothing is lost and nothing is claimed.
  if (panel === null) return;
  if (
    !patchExportProgress(
      panel,
      exportFlow.run,
      fileType,
      readinessOf(session.snapshot()),
    ) &&
    !progressMountComplained
  ) {
    progressMountComplained = true;
    reportError(
      new Error(
        "the Export panel has no start button, so progress cannot show",
      ),
    );
  }
}

/** This page's export, as the platform reports it (`applyExportEvent`). */
function onExportEvent(event: ExportEvent): void {
  const next = applyExportEvent(exportFlow, event);
  exportFlow = next.flow;
  switch (next.effect) {
    case "render":
      render(session.snapshot());
      return;
    case "progress":
      showExportProgress();
      return;
    case "relist":
      platform.outputs
        .list(sceneId)
        .then((rows) => {
          outputs = rows;
          render(session.snapshot());
        })
        .catch(reportError);
      return;
    case "none":
      return;
  }
}
platform.exports.onEvent(onExportEvent);

// The studio: the server asked this window to show another page (a second
// `npx demoman studio <take>` while this one is open). After the writes this
// page still owes, as every other way out of the editor.
platform.nav.onOpen?.((path) =>
  leaveAfterOwedWrites(() => location.assign(path)),
);

($("name") as HTMLInputElement).addEventListener("change", (event) => {
  dispatch({
    kind: "rename",
    name: (event.target as HTMLInputElement).value.trim(),
  });
});
/** Undo and redo do not go through `dispatch`, so they retire a standing
 *  refusal here rather than being the two edits that leave one up. */
const stepHistory = (run: () => Promise<void>): (() => void) => {
  return () => {
    const before = session.snapshot().scene;
    void run()
      .catch(reportError)
      .then(() => retireRefusal(before));
  };
};
$("undo").addEventListener(
  "click",
  stepHistory(() => session.undo()),
);
$("redo").addEventListener(
  "click",
  stepHistory(() => session.redo()),
);

/** A refusal's reason, in the author's terms — the same outcomes
 *  `demo:delete` can produce for the library page's own `REFUSAL_TEXT`
 *  (`entrypoints/library/main.ts`), and the two must be kept in step: a
 *  reason with no line here reaches the author as its raw identifier.
 *  Duplicated rather than imported: the two are separate entrypoints with
 *  no shared runtime module between them, and four string literals are
 *  cheaper than a new one. */
const REFUSAL_TEXT: Record<string, string> = {
  recording: "a take is recording",
  rendering: "a render is running",
  sharing: "a share is in progress",
  // A hold the background takes while a take is being replayed — since
  // 2026-09-28 only by a re-shoot on the run page: `src/run/develop.ts` is
  // the one sender of `replay:gate`, which takes it. An authored script run
  // sends no `replay:gate` and takes no hold, and this editor takes none.
  replaying: "a take is being run in Runs",
};

/**
 * Shows a Delete failure — refusal or partial — in `#failure`.
 *
 * Written the same way `reportLoadFailure` is: through the ordinary
 * `render(session.snapshot())` path once a scene is in hand, but standalone
 * when it is not, because Delete can be clicked before `session.load()`
 * resolves and `render` would otherwise throw on the placeholder scene's
 * first field. `deleteError` is set either way, so a later ordinary render
 * (an undo, an edit) keeps the message on screen rather than losing it the
 * moment something unrelated redraws the page.
 */
function showDeleteFailure(message: string): void {
  deleteError = message;
  showStandaloneFailure();
}

/** The failure band, through `render` once a scene is loaded and on its
 *  own before then — see `showDeleteFailure`. */
function showStandaloneFailure(): void {
  if (loaded) {
    render(session.snapshot());
    return;
  }
  renderFailure($("failure"), {
    error: null,
    replaySentence: null,
    captureSentence: null,
    deleteError,
    navigationError,
  });
}

/**
 * Opens `url` in this tab, or says why it did not. `location.assign` throws
 * rather than rejecting, so the `try` is what catches it; `already` is what
 * has happened regardless (a delete that went through), said first so the
 * refusal cannot read as undoing it. `page` names the destination in the
 * failure's headline.
 */
function leaveFor(page: string, url: () => string, already = ""): void {
  navigationError = null;
  try {
    location.assign(url());
  } catch (error) {
    reportError(error);
    navigationError = {
      page,
      reason: `${already}${
        error instanceof Error ? error.message : String(error)
      }`,
    };
    showStandaloneFailure();
  }
}

/** Opens the Recordings page in this tab, or says why it did not. A
 *  `note` goes with it, for the Recordings page to say (`carried-note`). */
function openLibrary(already = "", note: string | null = null): void {
  leaveFor(
    "Recordings page",
    () => withNote(platform.nav.library(), note),
    already,
  );
}

/**
 * Leaves this page — through `go` — only after the writes it still owes have
 * landed, and stays when one of them did not.
 *
 * The one helper every in-page way out uses (Back, and every route to Runs),
 * so the rule cannot drift between them. The blur that a click on a
 * way out causes is also what commits an edited name or an inspector field,
 * and that write is queued on the session's lane but not yet sent; leaving
 * in the same task lost it with no word. A write that fails in the wait
 * keeps the author here, where `#failure` says why — leaving would put them
 * on a page that shows the old value with nothing to explain it.
 *
 * "Failed in the wait" is read off what the session EMITS while it drains,
 * not off a before/after comparison of `error`: two failures can carry the
 * same sentence, and an older error still on the page is one the author has
 * already been shown. Every write emits, and a landed command clears
 * `error`, so the last snapshot emitted in the wait is the verdict on the
 * writes this click waited for — and none at all means none were owed.
 */
function leaveAfterOwedWrites(go: () => void): void {
  void (async () => {
    let last: SessionSnapshot | null = null;
    const stop = session.subscribe((snapshot) => {
      last = snapshot;
    });
    try {
      await session.settled();
    } finally {
      stop();
    }
    if ((last as SessionSnapshot | null)?.error != null) return;
    go();
  })();
}

/**
 * Delete this demo from this computer, in the header. Not undoable, and a
 * hosted copy — if there is one — stays online: the confirm dialog says
 * both, so the author is never surprised by either half.
 *
 * Three outcomes, three sentences, same rule `library/main.ts`'s own
 * `remove` follows for the identical `demo:delete` command: a refusal
 * says which precondition blocked it, a partial delete names the step that
 * failed and does NOT navigate away as though it worked, and only a clean
 * delete opens the library. Reporting a partial as a success would be the
 * worst thing this page could say — Delete cannot be undone.
 */
/**
 * The way back to the Recordings page.
 *
 * `location.assign`, not `history.back()` and not a new tab. The
 * editor is the first page in its tab whenever the popup or a finished
 * recording opened it, so there is nothing behind it to go back TO — and a
 * control that does nothing on half its doors is the failure this
 * codebase's first rule is about. Creating a tab instead would leave the
 * one the author is looking at sitting on the demo they just left.
 */
$("back").addEventListener("click", () => {
  // After the writes this page still owes — see `leaveAfterOwedWrites`.
  leaveAfterOwedWrites(() => openLibrary());
});

/**
 * Every route to Runs (`[data-runs-route]`: the no-frames banner, the
 * no-frames line under the Export button, Take info's Re-film row, and the
 * re-shoot failure box), through the same
 * wait as Back: a plain `<a href>` navigated in the same task as the blur
 * that committed a rename, and the rename was lost with no word.
 *
 * Delegated from the four containers the links are drawn in, `#banner`,
 * `#inspector`, `#take-info` and `#failure`, because every one of them is redrawn on
 * every render. Only a
 * plain primary click is taken over: a modified or middle click opens a new
 * tab and leaves this page — and its queued write — where it is, so the
 * browser's own handling is right for those.
 */
function onRunsRouteClick(event: MouseEvent): void {
  const link = plainRunsRoutePress(event);
  if (!link) return;
  event.preventDefault();
  leaveAfterOwedWrites(() => leaveFor("Runs page", () => link.href));
}
$("banner").addEventListener("click", onRunsRouteClick);
$("inspector").addEventListener("click", onRunsRouteClick);
$("take-info").addEventListener("click", onRunsRouteClick);
$("failure").addEventListener("click", onRunsRouteClick);
// The header button's open look keys on `aria-expanded`, which
// `popovertarget` reports to assistive tech but never writes into the DOM.
$("take-info").addEventListener("toggle", (event) => {
  $("take-meta").setAttribute(
    "aria-expanded",
    String((event as ToggleEvent).newState === "open"),
  );
});

/** The Runs link `event` hit, when it is a plain primary press of one —
 *  the only kind this page takes over (see `onRunsRouteClick`). */
function plainRunsRoutePress(event: MouseEvent): HTMLAnchorElement | null {
  const target = event.target instanceof Element ? event.target : null;
  const link = target?.closest<HTMLAnchorElement>("a[data-runs-route]");
  if (!link) return null;
  if (
    event.button !== 0 ||
    event.metaKey ||
    event.ctrlKey ||
    event.shiftKey ||
    event.altKey
  )
    return null;
  return link;
}

/**
 * The press that the redraw ate. A real press on a Runs link is mousedown,
 * then mouseup tens of milliseconds later — and the mousedown blurs a field
 * holding an edit, the blur commits it, the session emits, and `render`
 * redraws the container the link sits in. When that lands inside the press,
 * the release hits a NEW link, identical and in the same place, and Blink
 * dispatches no `click` at all (mousedown and mouseup on different elements,
 * one of them detached), so `onRunsRouteClick` never ran: the author
 * pressed the link and nothing happened, with nothing saying why.
 *
 * So the route is also decided from the press/release pair: the link a
 * plain primary press went down on, by its `href`, and the link the release
 * came up on. Same element: the browser's `click` follows, and
 * `onRunsRouteClick` takes it — this path stays out of the way, so a plain
 * click navigates once. A different element with the same `href`: the
 * redraw case, no `click` is coming, so this takes the route — through the
 * same `leaveAfterOwedWrites` wait, which is exactly what the press's own
 * blur queued. Released anywhere else: the author moved off the link, and
 * a browser takes no link on that either.
 *
 * Chosen over keeping the link element stable across renders: every
 * container these links are drawn in is rebuilt wholesale on each render
 * (`renderInspector`, the banner, `#failure`), and reusing one node there
 * would be a special case in three renderers for one listener's benefit.
 *
 * On the document, in the capture phase, so every press resets the record
 * — one that went down elsewhere and released on a link must not match a
 * stale press from earlier — and nothing inside a panel can stop it.
 * Keyboard activation has no press at all and stays with `click`
 * (`detail === 0`).
 */
let runsRoutePress: { link: HTMLAnchorElement; href: string } | null = null;
document.addEventListener(
  "mousedown",
  (event) => {
    const link = plainRunsRoutePress(event);
    runsRoutePress = link ? { link, href: link.href } : null;
  },
  true,
);
document.addEventListener(
  "mouseup",
  (event) => {
    const pressed = runsRoutePress;
    runsRoutePress = null;
    if (!pressed) return;
    const released = plainRunsRoutePress(event);
    if (!released || released === pressed.link) return;
    if (released.href !== pressed.href) return;
    leaveAfterOwedWrites(() => leaveFor("Runs page", () => released.href));
  },
  true,
);

$("delete").addEventListener("click", () => {
  void (async () => {
    // A dialog that could not open is not a No: it is said in the failure
    // band, where a refusal from the delete itself would be.
    try {
      if (!(await askToConfirm(DELETE_DEMO))) return;
    } catch (error) {
      reportError(error);
      showDeleteFailure(
        `Not deleted: the confirmation could not open — ${
          error instanceof Error ? error.message : String(error)
        }.`,
      );
      return;
    }
    deleteError = null;
    let reply: RemoveReply;
    try {
      reply = await platform.scenes.remove(sceneId);
    } catch (error) {
      reportError(error);
      showDeleteFailure(
        `Not deleted: ${error instanceof Error ? error.message : String(error)}.`,
      );
      return;
    }
    if (!reply.ok) {
      const why = REFUSAL_TEXT[reply.error] ?? reply.detail ?? reply.error;
      showDeleteFailure(`Not deleted: ${why}.`);
      return;
    }
    if (reply.result !== undefined && !reply.result.ok) {
      const failedStep = reply.result.steps.find((s) => !s.ok);
      showDeleteFailure(
        `Partly deleted: ${failedStep?.step ?? "a step"} could not be removed — ${failedStep?.error ?? "unknown error"}. Open Your demos to retry.`,
      );
      return;
    }
    // The delete itself already succeeded by this point; only the
    // follow-up navigation can still fail.
    //
    // This used to open a NEW tab and call `window.close()` on this one.
    // That pairing stopped being correct when the Recordings page began
    // navigating in place: `window.close()` is refused for a tab the page
    // did not itself open, so the author would have been left looking at
    // the editor for a demo that no longer exists, with a second
    // Recordings tab behind it. Going there in this tab is the same
    // destination by the route the Back button already takes.
    //
    // Left uncaught on an extension page, a refused navigation lands on
    // the chrome://extensions Errors list, and the author, who just
    // watched the delete succeed, sees what reads as a crash for a demo
    // already gone. `openLibrary` catches it and says so on the page.
    //
    // The studio's reply can carry a note — a folder it could not remove,
    // a stale export lock it cleared. This page is leaving, so the note
    // goes with it and the Recordings page says it; a refused navigation
    // says it here, before the refusal.
    const note = reply.note ?? null;
    openLibrary(
      note === null
        ? "This demo was deleted. "
        : `This demo was deleted. ${note} `,
      note === null ? null : `This demo was deleted. ${note}`,
    );
  })();
});

/**
 * The keyboard, dispatched from `src/editor/shortcuts.ts`'s table.
 *
 * This handler owns only two things: whether a press belongs to the editor
 * at all, and what each resolved action does to the things on this page.
 * Which key means what — and which keys are deliberately left to the
 * browser — lives in the table, where it can be read and tested without a
 * DOM, and where the `?` overlay reads it from so a binding cannot ship
 * undocumented.
 *
 * Skipped whenever the key already means something where it was pressed: a
 * space swallowed from the demo-name field would make the title untypeable
 * and an arrow swallowed from a replacement's input would scrub the take
 * instead of moving the caret.
 */
/**
 * One live key handler per document, however many times this module runs.
 *
 * `document` outlives a module instance. The node lane re-imports this
 * entrypoint once per test and only replaces `document.body`, so without
 * this every previous instance's listener stays attached — each with its own
 * `selection` and `helpOpen`, all firing on the same press, all writing to
 * the one live DOM. That is not only a test artifact: a dev-server hot
 * reload does exactly the same thing, and the symptom either way is a key
 * that does the right thing and something else as well.
 */
const KEY_HANDLER = Symbol.for("demoman.editor.keydown");
const scope = globalThis as unknown as Record<symbol, unknown>;
const previousKeys = scope[KEY_HANDLER];
if (previousKeys instanceof AbortController) previousKeys.abort();
const keyScope = new AbortController();
scope[KEY_HANDLER] = keyScope;

/**
 * The control the mouse put the focus on, if the focus is still there.
 *
 * Chrome focuses a button when it is clicked, and a focused button takes
 * Space for itself — so an author who clicked Repeat and reached for Space
 * to play toggled Repeat instead, every press (the author, 2026-10-19: "it
 * should feel like YouTube"). Space on a button the mouse focused plays
 * instead; one reached by Tab still presses on Space, and Enter presses
 * either. Every control stays operable from the keyboard.
 *
 * Tracked here rather than read from `:focus-visible`, whose answer after a
 * key press on a clicked button is the browser's heuristic to change. A key
 * press clears `pointing` before Tab moves the focus, so a tabbed-to button
 * is never counted; a focus handed on by script after a click is (the
 * full-screen swap's), which is the case Space should play in too.
 */
let pointing = false;
let pointerFocused: EventTarget | null = null;
document.addEventListener(
  "pointerdown",
  () => {
    pointing = true;
  },
  { capture: true, signal: keyScope.signal },
);
// A press anywhere but a join's dot or its card closes the card. The dot
// and the card stop their own presses before they reach here.
document.addEventListener(
  "pointerdown",
  () => {
    if (openJoin === null) return;
    openJoin = null;
    render(session.snapshot());
  },
  { signal: keyScope.signal },
);
document.addEventListener(
  "keydown",
  () => {
    pointing = false;
  },
  { capture: true, signal: keyScope.signal },
);
document.addEventListener(
  "focusin",
  (event) => {
    pointerFocused = pointing ? event.target : null;
  },
  { signal: keyScope.signal },
);

/** What each field held when it took the focus, or last committed: what
 *  Escape puts back (see the keydown handler below). */
const valueOnFocus = new WeakMap<
  HTMLInputElement | HTMLTextAreaElement,
  string
>();
document.addEventListener(
  "focusin",
  (event) => {
    const field = event.target;
    if (
      field instanceof HTMLInputElement ||
      field instanceof HTMLTextAreaElement
    ) {
      valueOnFocus.set(field, field.value);
    }
  },
  { signal: keyScope.signal },
);
// A value the field has already committed — a slider released, a number
// stepped — is what it holds now; Escape takes back only what was typed
// after it.
document.addEventListener(
  "change",
  (event) => {
    const field = event.target;
    if (
      field instanceof HTMLInputElement ||
      field instanceof HTMLTextAreaElement
    ) {
      valueOnFocus.set(field, field.value);
    }
  },
  { capture: true, signal: keyScope.signal },
);

document.addEventListener(
  "keydown",
  (event) => {
    // A modal dialog owns the keyboard while it is open: Escape is its
    // Cancel, and an arrow or `?` must not scrub or open something behind
    // it. Asked of the document rather than the target, since a click on
    // the dialog's text can leave focus on <body>.
    if (document.querySelector("dialog[open]") !== null) return;
    // A join's restore card first: it is a manual popover (timeline-view's
    // `showJoinCard`), which the browser does not close on Escape, so the
    // `:popover-open` check below would otherwise swallow the press.
    if (event.key === "Escape" && openJoin !== null) {
      event.preventDefault();
      openJoin = null;
      render(session.snapshot());
      return;
    }
    // Escape undoes the innermost thing, one press each (the author,
    // 2026-10-19). An open popover first — Take info, Notes — which the
    // browser closes on its own; answering here as well would clear a
    // selection or close a panel with the same press.
    if (
      event.key === "Escape" &&
      document.querySelector(":popover-open") !== null
    ) {
      return;
    }
    const target = event.target as HTMLElement | null;
    const tag = target?.tagName;
    if (
      tag === "INPUT" ||
      tag === "TEXTAREA" ||
      tag === "SELECT" ||
      target?.isContentEditable === true
    ) {
      // Then a field being typed in: Escape leaves it, and the next one is
      // the editor's. Keyboard shortcuts' search answers its own (it clears,
      // then closes the panel).
      //
      // Leaving it cancels the edit, as Escape does in Finder and Premiere:
      // the fields save on `change`, which a blur over a changed value
      // fires, so the value goes back to what it held on focus first and
      // the half-typed value is never dispatched.
      if (
        event.key === "Escape" &&
        target?.matches("[data-shortcuts-search]") !== true
      ) {
        if (
          target instanceof HTMLInputElement ||
          target instanceof HTMLTextAreaElement
        ) {
          const before = valueOnFocus.get(target);
          if (before !== undefined && target.value !== before) {
            target.value = before;
          }
        }
        target?.blur();
      }
      return;
    }
    // A focused button or link keeps only the two keys that activate it, or it
    // fires its own activation as well as this handler — the Play button
    // toggling twice per press.
    //
    // It used to keep ALL of them, which was harmless while the clip's ticks
    // were divs. They are `<button>`s now, and Chrome focuses a button when it
    // is clicked, so standing down for every key left the arrows, Home/End,
    // Escape and Delete dead in precisely the state they exist for: on the
    // step the author had just clicked.
    //
    // A tick is the exception even on Space, because the `preventDefault`
    // below stops Chrome turning that press into a click — so Space plays the
    // take instead of reselecting the step it is already on. A button the
    // mouse focused is the same exception on Space (`pointerFocused`).
    const activating =
      event.key === "Enter" || (event.key === " " && target !== pointerFocused);
    if (
      (tag === "BUTTON" || tag === "A") &&
      activating &&
      target?.hasAttribute("data-tick") !== true
    ) {
      return;
    }
    const snapshot = session.snapshot();
    const action = resolveShortcut(event, {
      hasSelection: selection !== null,
      selectionIsBeat: selection?.kind === "tick",
      canUndo: snapshot.canUndo,
      canRedo: snapshot.canRedo,
      panelOpen,
      hasTimeline: viewport !== null && lastDurationMs > 0,
    });
    // Unclaimed: the table said this key is not ours, or is ours but has
    // nothing to act on. Either way the browser keeps it, rather than a
    // swallowed press that does nothing reading as a shortcut that did.
    if (action === null) return;
    event.preventDefault();
    runShortcut(action, snapshot);
  },
  { signal: keyScope.signal },
);

/** What each resolved shortcut does to the page. */
function runShortcut(
  action: ShortcutAction,
  snapshot: ReturnType<typeof session.snapshot>,
): void {
  switch (action.kind) {
    case "playPause":
      togglePlayback();
      return;
    case "shuttle":
      // Same clearing `togglePlayback` does: pressing a transport key is the
      // author saying "try again", and holding the last draw failure past it
      // would describe something that is no longer the most recent thing
      // that happened.
      previewError = null;
      player.shuttle(action.direction);
      return;
    case "stop":
      player.stop();
      return;
    case "nudge":
      player.seek(player.positionMs + action.deltaMs);
      return;
    case "seekEdge":
      player.seek(action.edge === "head" ? trimHead : trimTail);
      return;
    case "stepBeat": {
      const ticks = snapshot.scene.actions.map((a) => a.id);
      const current =
        selection?.kind === "tick" ? ticks.indexOf(selection.actionId) : -1;
      // From nothing, the first step down is the take's first beat and the
      // first step up is its last — so the pair reaches the list from either
      // end rather than needing a click to prime it.
      const next =
        current === -1
          ? action.delta > 0
            ? 0
            : ticks.length - 1
          : current + action.delta;
      const actionId = ticks[next];
      if (actionId === undefined) return;
      setSelection({ kind: "tick", actionId });
      render(snapshot);
      return;
    }
    case "setTrim": {
      // Through the drag's own resolver, so the head/tail rules and the
      // words they are refused in are the ones the timeline already uses —
      // `TRIM_MIN_MS`, the collapse check, all of it. A snap band of zero:
      // the author placed the playhead deliberately.
      const model = lastModel;
      const view = lastView;
      if (model === null || view === null || resolved === null || !hasBundle) {
        const route = runsRouteOf(snapshot);
        refusal = `This take has not been rendered yet, so there is nothing to trim to. ${rerunAdvice(route.authored, rerunLineOf(route), "first")}`;
        render(snapshot);
        return;
      }
      applyGesture(
        resolveGesture(
          model,
          view,
          {
            kind: "trim",
            edge: action.edge,
            toMs: player.positionMs,
            snapMs: 0,
          },
          {
            resolved,
            bundle: snapshot.bundle,
            viewport: snapshot.scene.meta.capture.viewport,
          },
        ),
      );
      return;
    }
    case "split":
      splitAtPlayhead();
      return;
    case "undo":
      stepHistory(() => session.undo())();
      return;
    case "redo":
      stepHistory(() => session.redo())();
      return;
    case "deleteSelection": {
      if (selection === null) return;
      if (selection.kind === "zoom") {
        removeSelected({ kind: "removeZoom", id: selection.id });
        return;
      }
      if (selection.kind === "mask") {
        removeSelected({ kind: "removeMask", id: selection.id });
        return;
      }
      if (selection.kind === "piece") {
        applyGesture(
          resolvePieceRemoval(
            lastModel?.clip.pieces ?? [],
            selection.start,
            lastModel?.clip.trim,
          ),
        );
        return;
      }
      // A step: nothing to remove (spec 2026-10-22 split-tool), and said,
      // not a press that silently does nothing (review 2026-10-22).
      applyGesture({
        kind: "refusal",
        reason:
          "A step can't be deleted. To take it out of the video, split the clip around it and remove that piece.",
      });
      return;
    }
    case "zoomTimeline": {
      if (viewport === null) return;
      // Anchored on the playhead rather than the window's centre: the
      // playhead is the instant the author is working at, and it is the one
      // thing on the timeline they can see move. Clamped to [0,1] so a
      // playhead scrolled out of the window still zooms about an edge
      // instead of throwing the viewport off the take.
      const fraction = Math.min(
        1,
        Math.max(0, toFraction(viewport, player.positionMs)),
      );
      viewport = zoomAt(viewport, lastDurationMs, action.factor, fraction);
      render(snapshot);
      return;
    }
    case "zoomFit":
      viewport = fitAll(lastDurationMs);
      render(snapshot);
      return;
    case "toggleSnapping":
      snapping = !snapping;
      render(snapshot);
      return;
    case "clearSelection":
      // Clearing the selection is also how the rail gets back off Selection
      // and onto the entry the author had open — Export or Background — so a
      // session with no way back to "nothing" is a session with no way back
      // to either. This and the click past the lanes in `timeline-view.ts`
      // are the two.
      setSelection(null);
      render(snapshot);
      return;
    case "toggleHelp":
      pickPanel("shortcuts");
      return;
    case "closePanel":
      closePanel();
      return;
  }
}

/**
 * Open a panel, or close it if it is the open one: the rail's entries, the
 * header's Export and ? buttons, and the ? key all come through here.
 *
 * Picking a panel by hand is also choosing where "back" goes. Without that
 * only `setSelection` ever moved `railBeforeSelection`, so an author who
 * opened Background, went back to Selection from the rail and then
 * deselected landed on whatever had been open before the Background they
 * were actually looking at.
 */
function pickPanel(entry: RailEntry): void {
  // The pressed entry is a toggle: picking it again closes the panel and
  // gives the width to the stage. Any other entry opens.
  if (rail === entry && panelOpen) panelOpen = false;
  else {
    rail = entry;
    panelOpen = true;
    // Opening Keyboard shortcuts hands its search the focus, as Linear's
    // does; that draw only.
    if (entry === "shortcuts") focusShortcutsSearch = true;
  }
  if (entry !== "selection") railBeforeSelection = entry;
  render(session.snapshot());
}

/** Every panel's X, and Escape with nothing selected. */
function closePanel(): void {
  panelOpen = false;
  render(session.snapshot());
}

// Once, at boot: the markup carries the ids and the classes, this fills in
// the glyphs. Before the first `render`, so the header is never briefly a
// row of empty buttons.
renderHeaderIcons();
// The page's one tooltip: names and keys on the controls that have them.
installTooltips();
// So the attribute is never absent: `body[data-zoom="actual"] #stage` only
// matches once something has set it, and every render before the first
// click on the chip must still read as fitted.
document.body.dataset.zoom = "fit";

// The notes button follows whatever is in `#notes`, whoever wrote it:
// `render` fills four of its panels, but `#failure` is also written from
// outside `render` (a load failure, a storage refusal), and a button
// refreshed only by `render` would sit hidden over a card it never counted.
// The same observer opens the panel on a new error — see `revealNewErrors`.
{
  const notes = $("notes");
  let revealed = "";
  const paint = () => {
    renderNotesButton($("notes-open"), notes);
    revealed = revealNewErrors(notes, revealed);
  };
  new MutationObserver(paint).observe(notes, {
    childList: true,
    subtree: true,
    characterData: true,
  });
  paint();
}

let loaded = false;
session.subscribe((snapshot) => {
  loaded = true;
  loadError = null;
  render(snapshot);
});
session.subscribe((snapshot) => refreshHints(snapshot).catch(reportError));

/** Reads the kit and redraws the panel. On boot, and whenever another page
 *  (Settings, another editor tab) writes it. */
async function refreshBrandKit(): Promise<void> {
  kitsRead = await brandKits.read();
  // Only once a scene is in hand, as the outputs list below does: before
  // `load()` resolves the snapshot is `createSession`'s empty placeholder,
  // and rendering it throws. Whichever finishes last does the render.
  if (loaded) render(session.snapshot());
}
void refreshBrandKit().catch(reportError);
if (brandKits.onChange === undefined) {
  // Not an extension page (a fixture's faked chrome). Said once, at info:
  // the panel still reads the kit on boot, it just will not follow edits.
  console.info(
    "demoman: no storage change feed here, so the brand kit is read once",
  );
} else {
  brandKits.onChange(() => {
    void refreshBrandKit().catch(reportError);
  });
}
/** Reads the studio's Export quality and redraws what names the size. On
 *  boot, and when the window is looked at again (the setting is changed on
 *  the Settings page). A failed read is reported and leaves the last value. */
async function refreshExportQuality(): Promise<void> {
  const member = platform.exportQuality;
  if (member === undefined) return;
  const got = await member.read();
  if (got.unreadable !== undefined) {
    console.info(
      `demoman editor: the Studio exports at High quality: ${got.unreadable}`,
    );
  }
  if (got.quality === exportQuality) return;
  exportQuality = got.quality;
  if (loaded) render(session.snapshot());
}
if (platform.exportQuality !== undefined) {
  void refreshExportQuality().catch(reportError);
  window.addEventListener("focus", () => {
    void refreshExportQuality().catch(reportError);
  });
}
platform.outputs
  .list(sceneId)
  .then((rows) => {
    outputs = rows;
    // Only once a scene is in hand: `render` reads `snapshot.scene`, and
    // before `load()` resolves that is the empty placeholder `createSession`
    // starts from. Whichever of the two finishes last does the render, so
    // persisted outputs are on screen either way — "reopening the editor
    // shows what was already made" is a spec requirement, and relying on
    // the session's three round-trips to lose a race with this one is
    // usually true rather than guaranteed.
    if (loaded) render(session.snapshot());
  })
  .catch(reportError);
session.load().catch(reportLoadFailure);

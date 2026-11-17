/**
 * The walk: one pass over a source of steps, and everything around it.
 *
 * This is `runReplay`'s body, lifted so that a second door can use it. The
 * seam is `WalkSource`, which is pulled one step at a time — a recorded
 * document knows every rect and cursor segment before it starts, because
 * `planScene` plans the whole path, and an authored script cannot know a
 * step's rect until the steps before it have run.
 *
 * Nothing here decides *what* to perform. Its sources are `authored.ts`
 * (`runAuthored`, what the CLI records through) and `engine.ts` (a recorded
 * document, for `runReplay`).
 */
import {
  CAMERA_DEFAULTS,
  type CursorSegment,
  coversViewport,
  type Degradation,
  easings,
  type FrameBundle,
  heldThroughEndMs,
  type KeyframeEntry,
  type MadeFromStep,
  type PageScreen,
  VERBS,
  type ViewportTransform,
  validateBundle,
} from "@demoman/compositor";
import type { AnchorIntent } from "@demoman/resolver";
import {
  type DragSpot,
  dragEndPoint,
  type SceneAction,
  spotIn,
} from "@demoman/scene-schema";
import { actEndOf } from "./act-end.js";
import { withAnswerDeadline } from "./answer-deadline.js";
import {
  CLICK_DRIFT_PX,
  type ClickSightings,
  type ClickVerdict,
  createClickSightings,
  discardClickProbe,
  isClickRead,
  placeClickProbe,
  readClickProbe,
  TYPE_FIELD_UNFOCUSED,
} from "./click-probe.js";
import {
  ACT_CEILING_MS,
  HELD_SCROLL_MS,
  HELD_STEP_QUIET_MS,
  KEYFRAME_QUALITY,
  NAVIGATE_TIMEOUT_MS,
  NEXT_FRAME_WAIT_MS,
  REPLAY_DPR,
  REPLAY_TARGETS,
  SCROLL_SETTLE_TIMEOUT_MS,
  SETTLE_MS,
  SETTLE_PAINT_TIMEOUT_MS,
  SETTLE_QUIET_MS,
  SETTLE_QUIET_TIMEOUT_MS,
  SPAN_MAX_MS,
  SPAN_MIN_FRAMES,
  SPAN_QUIET_MS,
  STEP_QUIET_MS,
  STEP_REQUEST_CAP_MS,
  STEP_SETTLE_CAP_MS,
  STILL_DRAIN_MS,
  TAKE_TAIL_MS,
  TYPE_LEAD_MS,
  typeGapMs,
  typeKeysOf,
  WAIT_POLL_MS,
  WAIT_TIMEOUT_MS,
} from "./constants.js";
import {
  applyDevice,
  DeviceEmulationError,
  type DeviceLike,
  desktopMetrics,
  deviceMetrics,
} from "./device.js";
import {
  DRAG_PICTURE_INSTALL,
  DRAG_PICTURE_MOVE,
  DRAG_PICTURE_REMOVE,
  DRAG_PICTURE_SHOW,
  DRAG_WATCH_INSTALL,
  DRAG_WATCH_READ,
  heldPath,
  inViewport,
  rangeThumb,
} from "./drag.js";
import { type SeenFrame, standInFrame } from "./frame-change.js";
import {
  type CdpFrameNode,
  hopsFromTreePath,
  rectFromQuad,
  resolveCdpFrameId,
} from "./geometry.js";
import { HELD_EPS_MS, HELD_FRAME_MS, type HeldClock } from "./held-clock.js";
import { createHeldFrames } from "./held-frames.js";
import { decodeBase64, jpegSize, pngSize } from "./image.js";
import { createInputGate, type InputGate } from "./input-gate.js";
import { pressKey } from "./keys.js";
import { createMotionRecorder } from "./motion-recorder.js";
import type { OcclusionGuard } from "./occlusion.js";
import { pathPointAt, retargetSegment } from "./path.js";
import { type RequestTracker, trackRequests } from "./requests.js";
import {
  HELD_SCROLL_STEP,
  heldScrollPlanFunction,
  type ScrollAim,
  type ScrollReport,
  scrollIntoViewFunction,
  scrollWillMove,
} from "./scroll.js";
import { type SettleReport, settlePaintExpression } from "./settle.js";
import { degradation } from "./span.js";
import {
  type CaptureWindow,
  capturedAway,
  PAGE_CAPTURE_HOLD,
  PAGE_CAPTURE_RELEASE,
  type StepSettleReport,
  stepSettleExpression,
} from "./step-settle.js";
import type {
  CdpSession,
  Clock,
  EngineStore,
  FrameEncoder,
  PageAgent,
  Rect,
  ReplayCounters,
  ReplayProgress,
  ReplayResult,
  ReplayStopReason,
  ResolveFailure,
  ResolveReport,
  SendOptions,
  TargetHandle,
  ZoomDecision,
} from "./types.js";
import { seenNow } from "./visibility.js";

/**
 * One step of the walk, with everything that differs between replaying a
 * recorded document and running an authored script already decided.
 *
 * The difference is small and worth naming, because it is the reason this
 * seam exists at all: replaying a document knows every rect and every cursor
 * segment before it starts (`planScene` plans the whole path), while an
 * authored run cannot know a step's rect until the steps before it have run.
 * So the source is pulled lazily, one step at a time, and an authored source
 * measures as it goes.
 */
export interface WalkStep {
  /** The action to perform. Authored runs synthesize this per step, stamping
   *  `timestamp` from the run's own clock at the moment it is pulled. */
  action: SceneAction;
  /** What to resolve, or null for a navigation wait (which names no
   *  element). An intent, not an anchor: see `AnchorIntent`. */
  target: AnchorIntent | null;
  /** The cursor move that arrives at this step. A document source reads it
   *  from the plan; an authored source builds it once the rect is measured. */
  segment: CursorSegment | undefined;
  /**
   * What a `type` performs. The redaction sentinel stops the run, and null is
   * every other verb — `textFor` returns it for anything that is not a
   * `type`, and `performVerb` reads text only in the one case that has any.
   */
  text: string | null | typeof REDACTED_WITHOUT_REPLACEMENT;
  /**
   * Where a `scrollTo` leaves its anchor — the viewport y of its top edge —
   * when an authored script says so (`ScriptStep`'s `landing`, which
   * `scriptFromTake` writes from the recorded rect). An authored action is
   * synthesized rect-less, so without this every authored scroll centres.
   * A document source leaves it unset and aims at `action.rect` as before.
   */
  landing?: { top: number };
  /**
   * What resolution measured, handed back before the verb runs. An authored
   * source records the rect here; a document source ignores it.
   *
   * A measurement, not a verdict: everything after it — the cursor path, the
   * settle, the keyframe, the verb — can still throw, and the step is not
   * performed until the loop comes back for the next one. So a source must
   * not treat this call as "the step happened"; see `createAuthoredRun`.
   */
  onResolved?(rect: Rect, report: ResolveReport): void | Promise<void>;
  /**
   * A wait's veto, asked once its condition was met and BEFORE the walk marks,
   * photographs or counts it. Null accepts the wait; a reason refuses it, and
   * the walk stops with that reason and nothing of the wait recorded.
   *
   * Exists because a source may learn only after the wait that it cannot keep
   * the step — an authored wait whose element is captured after it, and is
   * not there — and by the time the generator resumes past its `yield` the
   * walk has already counted the step, marked it and shot a keyframe for it.
   * A document source has no such hook and pays nothing.
   */
  onConditionMet?(): Promise<ReplayStopReason | null>;
  /**
   * A wait that timed out says what its LAST look at the page found: no such
   * element, or one the page has but nobody could see. Asked once, before the
   * walk stops with `waitTimeout`, so the source need not guess from a capture
   * taken before the wait.
   */
  onWaitTimedOut?(saw: WaitSaw): void;
  /**
   * A navigation wait (`waitForLoad`) that was met says whether the top frame
   * started a load since the previous step began: false means the page never
   * navigated and the wait passed on a document that was already complete.
   */
  onLoadSeen?(seen: boolean): void;
  /**
   * Given only for a `type` into a field whose value may be kept. Called after
   * the keys went in with what the field now holds and whether that holds the
   * typed text (letters and digits, case-folded, contained). A field the page
   * reformats ("4,800") holds; one it empties does not.
   */
  onFieldRead?(
    read: { value: string; holds: boolean } | { unavailable: string },
  ): void;
  /**
   * Called for a `type` whose last key the page was not seen to paint
   * (`lastKeyPainted`), with why. The step's end is then the bound, not the
   * paint, and the camera may leave before the value shows (DEM-173).
   */
  onLastKeyUnpainted?(why: string): void;
  /**
   * A re-shoot's recorded interval from the previous step's marker to this
   * one's, in ms — `to.timestamp - from.timestamp`, the number `planScene`
   * uses for a recorded pace. In continuous recording the walk waits it out
   * live before this step's marker, so the author's rhythm is in the frames
   * rather than reconstructed by the compositor (spec 2026-10-03 §5).
   * Undefined for an authored run, whose pauses are their own steps.
   * An edited gap's duration when the author set one; see `pacedGap`.
   */
  recordedIntervalMs?: number;
  /**
   * The script's `pause` slept just before this step, as written: a planned
   * number the beat plan adds to the step's rest (`BeatRules.restBefore`).
   * Undefined: none.
   */
  pauseMs?: number;
  /**
   * Set when `recordedIntervalMs` is an edited gap rather than the take's
   * own spacing. The walk lists each one it paces in the bundle's
   * `pacedGaps`, because the compositor would otherwise rescale the idle
   * inside that pause to the same gap again.
   */
  pacedGap?: { afterActionId: string; durationMs: number };
  /**
   * A drag's two ends, in the take's own shape so a script and a document
   * both say it: where it presses, in `target` (`fromAt` a spot in it), and
   * where it lets go — a spot in `end`, or `to.by` added to the start.
   * `onEnd` hands the measured end back, as `onResolved` does the start,
   * with the spot the walk pressed when it chose one itself (a range's
   * thumb): the take keeps it as `pressedAt`, or its film check and zoom
   * would frame a different drag from the one performed.
   */
  drag?: {
    fromAt?: DragSpot;
    to: { at?: DragSpot } | { by: { x: number; y: number } };
    end: AnchorIntent | null;
    onEnd?(rect: Rect, pressedAt?: DragSpot): void;
  };
}

/** A drag, measured and ready: both points in CSS px, and the end's box (a
 *  point's own, zero-sized, for an offset). */
interface DragPlan {
  start: { x: number; y: number };
  end: { x: number; y: number };
  endRect: Rect;
}

/** What a timed-out wait's last look found: nothing matched, an element
 *  nobody could see, several that tied, or a page that never answered or
 *  threw. */
export type WaitSaw =
  | "absent"
  | "notVisible"
  | "ambiguous"
  | "pageSilent"
  | "pageFaulted";

/** The resolver's last word as a `WaitSaw`; undefined where it is about
 *  reaching a frame or a shadow root, which the generic stop says better. */
const waitSawOf = (found: ResolveReport): WaitSaw | undefined => {
  if (found.resolved) return "notVisible";
  switch (found.failureReason) {
    case null:
    case "notInTree":
    case "patchUnavailable":
      return "absent";
    case "ambiguousTie":
      return "ambiguous";
    case "pageSilent":
    case "pageFaulted":
      return found.failureReason;
    default:
      return undefined;
  }
};

/** What a typed-into field shows now: an input or textarea's `value`, a
 *  contenteditable host's `textContent`. Null when focus is no longer in the
 *  target: a code box that hands focus to the next one, a field that moves
 *  on when full. The keys went elsewhere, so the target says nothing. */
const FIELD_READ = `function () {
  // The focused element, through shadow roots: a type aimed at a label or a
  // wrapper lands in the field inside it (or the label's control).
  let active = document.activeElement;
  while (active && active.shadowRoot && active.shadowRoot.activeElement) {
    active = active.shadowRoot.activeElement;
  }
  let inside = false;
  for (let n = active; n && !inside; n = n.parentNode || n.host) {
    inside = n === this;
  }
  if (!inside && !(this.control && active === this.control)) return null;
  return "value" in active && typeof active.value === "string"
    ? active.value
    : active.textContent ?? "";
}`;

/** The longest value a report keeps of a field, so a contenteditable's whole
 *  document does not reach the report or the verdict line. */
const FIELD_VALUE_MAX = 120;

/** Letters and digits only, case-folded: what "the field holds the text"
 *  compares, so a page's commas, spaces and capitals are not a failure. */
const fieldKey = (s: string): string =>
  s.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");

/** A field's text as a number, once currency symbols, thousands commas and
 *  spaces are gone; null when what is left is not one. So "4800.00" typed
 *  holds in a field showing "$4,800" (final review 2026-10-30). */
const fieldNumber = (s: string): number | null => {
  const bare = s.replace(/[\p{Sc}\s,]/gu, "");
  return /^[+-]?(\d+\.?\d*|\.\d+)$/.test(bare) ? Number(bare) : null;
};

/** Whether a field showing `value` holds the `typed` text. Text with no
 *  letters or digits has no key to compare, so it is compared raw: nothing
 *  typed holds only in an empty field, punctuation where the field shows it. */
const fieldHolds = (value: string, typed: string): boolean => {
  if (fieldKey(typed) === "") {
    const raw = typed.trim();
    return raw === "" ? value.trim() === "" : value.includes(raw);
  }
  if (fieldKey(value).includes(fieldKey(typed))) return true;
  const shown = fieldNumber(value);
  return shown !== null && shown === fieldNumber(typed);
};

/** What a native `<input type="range">` says about its thumb; null for
 *  anything else. */
const RANGE_READ = `function () {
  if (!(this instanceof HTMLInputElement) || this.type !== "range") return null;
  const style = getComputedStyle(this);
  return {
    value: Number(this.value),
    min: this.min === "" ? 0 : Number(this.min),
    max: this.max === "" ? 100 : Number(this.max),
    vertical: style.writingMode.startsWith("vertical"),
    reversed: style.direction === "rtl",
  };
}`;

/**
 * How one performed step played, measured once by the walk where it counts
 * the step. `markerMs` is the step's marker on the bundle's axis (source ms
 * from the take's first frame); the rest are relative to it. `startMs` is
 * when the walk began the step (≤ 0), `finishMs` when its verb had returned
 * and its span closed, `zoomOutMs` when the camera is back at full frame
 * after the latest zoom at or before the step (`RoomPolicy.settledAfterMs`,
 * the number the tail itself asks), null before any zoom or with no room.
 * `heldEndMs`, only under a tail trimmed `after: "action"`: where that zoom
 * lands when it is held through the cut the trim would make at this step
 * (`heldThroughEndMs`), absent when its own pull-out starts at or after the
 * cut. The take films through it, and the run writes it as the zoom's `end`.
 */
export interface StepTiming {
  markerMs: number;
  startMs: number;
  finishMs: number;
  zoomOutMs: number | null;
  heldEndMs?: number;
}

export interface WalkSource {
  /** Pulled lazily and once each. An authored source resolves inside it. */
  steps(): AsyncIterable<WalkStep> | Iterable<WalkStep>;
  /** Told each step's timing once the walk has counted it, before it pulls
   *  the next. Never told for a step the walk did not perform. */
  onFinished?(actionId: string, timing: StepTiming): void;
  /** The script's pauses slept since the last step it yielded, asked once
   *  the steps are done: the beat plan's tail adds them. Undefined: none. */
  closingPauseMs?(): number;
}

/**
 * What the walk needs to know about the run that is not a step and not a
 * port: the five facts `runReplay` reads off its document and an authored run
 * decides for itself.
 */
export interface WalkConfig {
  /** The take being built. Keyframes are stored under it, and the bundle
   *  records it as the scene it belongs to. */
  sceneId: string;
  /** The viewport this run emulates, and the shape every harvested frame has
   *  to be a scale of. See `applyMetrics` and `coversViewport`. */
  viewport: { width: number; height: number };
  /** How many steps the source will yield. `outcome`, `replayThrough` and
   *  every progress report are measured against it, so a source that yields
   *  a different number of steps than it declared would misreport how far
   *  the run got. */
  total: number;
  /** What capture believed about this take's hover sensitivity. The walk can
   *  only ever set it true — see the `moveTo` branch. */
  hoverSensitive: boolean;
  /** Where the cursor enters. See `cursor` below for what it is for and why
   *  it is not (0, 0). */
  firstCursor: { x: number; y: number };
  /** A phone or tablet to film as (spec 2026-10-10); `viewport` is then its
   *  size. Null: the desktop. */
  device: DeviceLike | null;
  /**
   * The script's `trim.end`: film at least `ms` after the last performed
   * step's finish — or after the camera's return to full frame, for
   * `"zoomOut"` — so the take holds the tail the trim asks for. Absent:
   * today's tail alone. Continuous recording only, as the tail is.
   */
  tail?: { ms: number; after: "zoomOut" | "action" };
}

/**
 * What a caller that wants unhurried beats hands the walk (spec 2026-10-19):
 * the room the camera needs before a zoomed click, and which clicks will be
 * zoomed. Given, the walk records each step's act end on its marker and
 * waits before a zoomed click until there is room. Absent, it does neither,
 * as for `runReplay`.
 */
export interface RoomPolicy {
  /**
   * Designed ms the camera needs from the latest act's end to a zoomed
   * click's marker: the settle, the push-in and the lead-in — or none for a
   * click the camera pans to from the zoom before it (spec 2026-10-22):
   * 0 exactly when `arrives` says "pan".
   * `heldUntilMs` is what that zoom holds until as the camera counts it:
   * a zoomed click's marker plus `leadInMs`, a zoomed drag's release; null
   * before the first zoom. `clickMs` is this click's marker as it will land
   * with nothing added.
   */
  neededMs(gap: { heldUntilMs: number | null; clickMs: number }): number;
  /**
   * Designed ms a click paced as a return still lacks for the camera to
   * make one with a margin to spare: from `heldUntilMs` to this click's
   * arrival, a full return (`returnsBetween`'s terms) plus the policy's
   * margin. 0 when it already fits, or before the first zoom. `gap` as for
   * `neededMs`, with `clickMs` where the click lands with its room.
   */
  returnShortMs(gap: { heldUntilMs: number | null; clickMs: number }): number;
  /** How the camera arrives at a click: "pan" from the zoom before it, or
   *  "return" through full frame ("return" when `heldUntilMs` is null).
   *  `gap` as for `neededMs`, in designed ms. */
  arrives(gap: {
    heldUntilMs: number | null;
    clickMs: number;
  }): "pan" | "return";
  /** Whether the camera will zoom to this click. Asked once per click and
   *  per drag (its `rect` the box round both ends), in order, with its
   *  marker time as it will be with all added room taken out — under a beat
   *  plan, its designed marker before any room for it. Keeps its own
   *  record of the last zoom. */
  zooms(click: {
    actionId: string;
    anchorId: string;
    rect: Rect;
    unwaitedMs: number;
    scale: number;
  }): boolean;
  /**
   * Designed ms by which the camera has pulled out of the take's last zoom and
   * held still (spec 2026-10-30 F): its hold, its pull-out at the take's
   * smoothness, and a settle. `heldUntilMs` as for `neededMs`. The take runs
   * on until then, so the decision is recorded in its frames.
   */
  settledAfterMs(heldUntilMs: number): number;
}

/**
 * The pacing rule (spec 2026-11-13 Part 3), handed in so this package does
 * not import the one that owns it (`@demoman/run-core`'s `beats.ts`).
 * Every number it answers is planned, never measured.
 */
export interface BeatRules {
  /** Dead air before a step's journey; `roomMs` is what the camera needs
   *  from the last act's designed end to this click, 0 when none;
   *  `returnShortMs` what a return still lacks (`RoomPolicy.returnShortMs`),
   *  absent when none. On a held clock a step its approach scrolls to is
   *  asked before the scroll, with `roomMs` and `journeyMs` 0: its rest
   *  keeps its base, and the room goes into `afterScroll`. */
  restBefore(i: {
    first: boolean;
    pauseMs: number;
    roomMs: number;
    journeyMs: number;
    returnShortMs?: number;
  }): number;
  /** Dead air between a step's approach scroll and its journey; `zooms`
   *  for a click the camera zooms to, `roomMs` and `returnShortMs` as for
   *  `restBefore`. */
  afterScroll(i: {
    zooms: boolean;
    roomMs: number;
    journeyMs: number;
    returnShortMs?: number;
  }): number;
  /** A step's own designed length. */
  actMs(action: SceneAction): number;
  /** How long the take runs on after its last act; `pauseMs` is the
   *  script's closing pause. */
  tailMs(i: {
    zoomSettleMs: number | null;
    trimEndMs: number | null;
    trimAfterAction: boolean;
    pauseMs: number;
  }): number;
  /** Dead air after the cursor arrives, before the act. */
  arriveMs: number;
}

export interface EngineDeps {
  cdp: CdpSession;
  page: PageAgent;
  encoder: FrameEncoder;
  store: EngineStore;
  clock: Clock;
  /**
   * What keeps input and stills apart (`input-gate.ts`). Defaults to a fresh
   * `createInputGate()` per run, which is what every host wants; supplied
   * only by a test that has to see which calls went through it.
   */
  inputGate?: InputGate;
  /**
   * Whether this scene may be replayed, decided by the caller.
   *
   * Required, not optional. This was `if (scene.flags.mutating)` read here
   * in the core, under a comment saying a UI that forgets to check must not
   * be able to double-submit somebody's checkout. That instinct is kept and
   * strengthened: the type system now forces every caller to have decided.
   * See ./policy.ts for who decides.
   */
  mayReplay: boolean;
  onProgress?: (progress: ReplayProgress) => void;
  occlusion?: OcclusionGuard;
  /**
   * Asked once, after the opening navigation has settled and before the
   * opening keyframe (launch C). A string stops the run as `signedOut`, with
   * that string as its note, before anything is filmed; null goes on.
   * Absent: no check.
   */
  landing?: () => Promise<string | null>;
  /**
   * The FULL action log these frames should record themselves as made from,
   * including the steps this run was told to skip.
   *
   * Required, not defaulted to `scene.actions`. A default would be right
   * today and silently wrong the moment a caller filters the scene it passes
   * (which Task 2's rebuild does), and the failure is invisible: the bundle
   * would record a log the take does not have, and every cut step would read
   * as an edit the author just made.
   */
  madeFrom: MadeFromStep[];
  /**
   * `"continuous"` (spec 2026-10-03): keep every frame the page paints, as
   * paint-run spans the recorder opens and closes itself; take a sharp
   * still whenever the page goes quiet; mark the bundle `timing: "real"`.
   * `"sampled"`, the default: spans only around a verb or an approach
   * scroll, as before. The runner's authored run (`apps/runner`'s `play.ts`)
   * asks for `"continuous"`; its `replay` command takes the default.
   */
  recording?: "continuous" | "sampled";
  /** Unhurried beats; see `RoomPolicy`. Continuous recording only. */
  room?: RoomPolicy;
  /**
   * The beat plan (spec 2026-11-13 Part 3). Continuous recording only.
   * Given, the walk keeps a designed clock that only these rules and the
   * script feed, asks `room` its questions on it, waits out no room and no
   * planned tail live, and returns `ReplayResult.pacing`. Absent: none of
   * that, as for `runReplay`.
   */
  beats?: BeatRules;
  /**
   * The page's held clock (held-clock spec §1-§3). Continuous recording
   * only; given, the walk's clock, held already by the caller. The walk
   * starts no screencast and no motion recorder, files the clock's frames
   * (`createHeldFrames`), plays its beat plan as page time instead of
   * returning `ReplayResult.pacing`, and marks the bundle `clock: "held"`.
   */
  held?: HeldClock;
}
/** The shortest gap between two mouse moves of a dispatched path. Chrome's
 *  own answer, about a frame, is the real pace; this only bounds the rate
 *  when an answer comes back sooner. */
const PATH_STEP_MS = 8;
/** How far past its plan a path's last move may reach the page before the
 *  run says so (`pointerLate`): the drawn cursor follows the plan, and on a
 *  Mac the last move lands within about one answer, 10-25 ms, of it. */
const POINTER_LATE_MS = 100;

/** What a run that stopped before its first frame walks: nothing. */
const NO_STEPS: AsyncIterable<WalkStep> = {
  async *[Symbol.asyncIterator]() {},
};

/** The text a `type` action should produce, or this symbol when a redacted
 *  field has no replacement to supply it (v8 §5: correct behaviour). */
export const REDACTED_WITHOUT_REPLACEMENT = Symbol("redacted");

/** What `locate` found, or why it did not. `failureReason` carries the
 *  resolver's verdict where there is one, and `"notReachable"` or
 *  `"frameMismatch"` where the resolver succeeded and this side of the port
 *  could not follow. */
interface Located {
  handle: TargetHandle | null;
  failureReason: ResolveFailure | null;
  /**
   * The resolver's own report, non-null on exactly the path that produced a
   * handle. Carried for `WalkStep.onResolved`, which is how an authored
   * source learns what its intent resolved to; a document source never looks
   * at it.
   */
  report: ResolveReport | null;
}

const LOST: Located = { handle: null, failureReason: null, report: null };

/**
 * The resolver found it; we could not get to it. Every use sits *after* a
 * successful `page.resolve`, which is what makes the distinction true rather
 * than merely stated: the anchor is healthy, so telling the author to
 * re-record the step would send them to fix something that is not broken.
 */
const UNREACHABLE: Located = {
  handle: null,
  failureReason: "notReachable",
  report: null,
};

/**
 * The resolver found it; the frame its hop names is not the frame that is
 * there. Separate from `UNREACHABLE` because the author's move is the
 * opposite one — corroboration will refuse the same frame on every future
 * run, so this asks for a re-record where unreachable asks for a re-run.
 */
const FRAME_MISMATCH: Located = {
  handle: null,
  failureReason: "frameMismatch",
  report: null,
};

/**
 * Which stop reason an unresolved anchor earns.
 *
 * Three different author actions, which is why they are three reasons rather
 * than one: a tie needs the anchor disambiguating, a row that has not
 * rendered needs the app scrolled to it (and may simply need re-running), and
 * anything else needs the step re-recorded. The resolver already distinguishes
 * them one layer down; folding them back into a single reason threw away the
 * only signal an author has about which of the three they are looking at.
 *
 * Everything else the resolver can say — a closed shadow root, a frame that is
 * gone or unreachable, a pixel patch that could not run — means the element
 * could not be found, which is what `unresolvedAnchor` says. A null reason
 * lands there too, and by now that is one case only: a node with no box, the
 * last failure on our own side of the port the resolver had no verdict about.
 * The other two used to arrive here as null and now name themselves.
 *
 * FOUR values are the exceptions, and none is a verdict about the element.
 * `pageSilent` is the page never answering; `pageFaulted` is the page
 * answering that its own agent threw, which is emphatically not the same thing
 * (the app is up, and telling the author to check that it loads sends them
 * after nothing). `notReachable` and `frameMismatch` are a resolution this
 * side of the port could not cash in — once because the realm to cash it in
 * was not there, once because the frame the hop names is not the frame the
 * tree holds. All four keep their own names rather than reading as "gone", and
 * the last two are apart because one is worth re-running and the other never
 * will be.
 *
 * Each has a `case` below, and the `default` is why: it answers
 * `unresolvedAnchor`, so a value added to `ResolveFailure` and forgotten here
 * does not fail to compile — it reports "the element is no longer on the page"
 * and sends the author to re-record a step that may be fine. `pageFaulted`
 * joined on 2026-09-27 and this enumeration is what says how many there are.
 *
 * Exported for `authored.ts`, which fails to resolve one step earlier than
 * this file does — its capture round trip resolves the agent's intent in the
 * page — and must map the same verdicts to the same reasons. A second copy of
 * this table would be a second table to drift, and the drift is invisible: an
 * authored tie reported as "gone" sends the author to re-record a step that
 * is not broken.
 */
export function stopForResolveFailure(
  failureReason: ResolveFailure | null,
): ReplayStopReason {
  switch (failureReason) {
    case "ambiguousTie":
      return "ambiguousAnchor";
    case "notInTree":
      return "anchorNotRendered";
    case "pageSilent":
      return "pageSilent";
    case "pageFaulted":
      return "pageFaulted";
    case "notReachable":
      return "anchorUnreachable";
    case "frameMismatch":
      return "anchorFrameMismatch";
    default:
      return "unresolvedAnchor";
  }
}

/** What to put in a degradation note for a failed settle probe. */
/** Held: page time past an in-page probe's own backstop before the walk
 *  stops waiting for its answer. The backstops answer within 250 ms of
 *  their cap, polling every 50 ms; past this, the probe is not answering. */
const PROBE_GRACE_MS = 1000;

function describeSettleError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/** A by-value `Runtime.evaluate` reply's value; throws what the page threw,
 *  which CDP answers with rather than rejecting. */
function evaluatedValue(reply: Record<string, unknown>): unknown {
  const thrown = reply.exceptionDetails as
    | { text?: string; exception?: { description?: string } }
    | undefined;
  if (thrown !== undefined) {
    throw new Error(
      thrown.exception?.description ?? thrown.text ?? "the page threw",
    );
  }
  return (reply.result as { value?: unknown } | undefined)?.value;
}

/**
 * A condition a step's settle or page screen never met, in words. `machine`
 * when it is not the page's own doing (a paint that never came, a probe or
 * capture that failed, requests that could not be watched): recording again
 * may change it, so it is said as `stepSettleFailed`, which refresh records
 * once more. Otherwise a cap the page ran out (requests, animations, the DOM
 * changing, a load) or a caret it would not hide: `stepUnsettled`.
 */
interface Unmet {
  words: string;
  machine: boolean;
}
const pageMade = (words: string): Unmet => ({ words, machine: false });
const machineMade = (words: string): Unmet => ({ words, machine: true });

/** The conditions a step-settle reply says never held. Never empty for a
 *  reply that is not quiet. Read from why the probe says it stopped, never
 *  inferred from when (`StepSettleReport.stopped`). */
function unsettledWords(report: Partial<StepSettleReport>): Unmet[] {
  if (report.quiet === true) return [];
  if (report.stopped === "unwatched")
    return [machineMade("the page's changes could not be watched")];
  if (report.stopped === "animationReadFailed")
    return [machineMade("the page's animations could not be read")];
  // At the cap.
  const words: Unmet[] = [];
  const animations = report.animations ?? 0;
  if (report.painted !== true)
    words.push(machineMade("its first paint never came"));
  if (animations > 0)
    words.push(pageMade(`${animations} animation(s) still running`));
  if (report.painted === true && animations === 0)
    words.push(pageMade("the DOM never went quiet"));
  return words;
}

/** Said in place of a page condition the cap left no time to ask about. */
const PAGE_NOT_ASKED = pageMade(
  "the page was not asked (the cap ran out first)",
);
/** A load that outlasted the cap is the page's, as a request is. */
const STILL_LOADING = pageMade("the page was still loading");

/**
 * How far a run got through the action log, and nothing about failure.
 *
 * Exported because three call sites need it and two of them used to hardcode
 * `"partial"` — the engine's own refusal path and the runner's `refusedRun`.
 * Harmless while both hardcoded the same string, which is exactly the shape a
 * drift takes before it is one. A refusal has completed nothing, so it is
 * `partial` for every scene that has an action to replay, and vacuously
 * complete for one that has none.
 */
export function replayOutcome(
  completed: number,
  total: number,
): "complete" | "partial" {
  return completed === total ? "complete" : "partial";
}

/**
 * The per-step walk: setup, one pass over the source's steps, teardown, and
 * the bundle.
 *
 * Everything here is common to both doors. `runReplay` is a document source
 * over it (see `engine.ts`), and an authored run is a source that resolves
 * and measures as it goes. What differs between them is a `WalkStep` and a
 * `WalkConfig`, and nothing else.
 */
export async function runWalk(
  source: WalkSource,
  deps: EngineDeps,
  config: WalkConfig,
): Promise<ReplayResult> {
  const { page, encoder, store, held } = deps;
  /** The scale the page is rendered at: the stills' 3x, or a held
   *  recording's own (`HeldClock.scale`), whose every frame is a still. */
  const stillScale = held?.scale ?? REPLAY_DPR;
  if (held !== undefined && deps.recording !== "continuous") {
    throw new Error(
      `runWalk: a held clock records only on continuous recording, not ${deps.recording ?? "sampled"}`,
    );
  }
  const clock = held ?? deps.clock;
  /** Held: a probe's send, bounded by `answered` in page time rather than
   *  by the real-time answer deadline. Off a held clock, none. */
  const heldProbe: SendOptions | undefined =
    held === undefined ? undefined : { unbounded: true };
  // Every call the walk makes has a deadline: a call the browser never
  // answers becomes a reported stop rather than a run that never returns
  // (`answer-deadline.ts`). Cleared at the very end of teardown.
  const answering = withAnswerDeadline(deps.cdp);
  const { cdp } = answering;
  // A page screen's capture, on the still line's own bound: a covered
  // window stops painting, and its screenshot then never answers.
  const screening = withAnswerDeadline(cdp, STILL_DRAIN_MS);
  const { sceneId, viewport, total, device } = config;

  const empty = (reason: ReplayStopReason): ReplayResult => ({
    bundle: null,
    outcome: replayOutcome(0, total),
    completed: 0,
    total,
    lastCompletedActionId: null,
    reason,
    degradations: [],
    unconfirmedClicks: [],
    // Nothing was built, so nothing was lost to the store. See the field.
    storageRefused: false,
    hoverSensitive: config.hoverSensitive,
    counters: blankCounters(viewport, total),
  });

  // The mutation rule, at the entry point. Resolved by the caller (see
  // policy.ts) rather than re-derived here.
  if (!deps.mayReplay) return empty("mutating");

  const started = clock.now();
  const at = (): number => clock.now() - started;
  const continuous = deps.recording === "continuous";
  /** Continuous only: whether the opening still has been taken, and so
   *  whether the recorder may keep what the page paints. */
  let filming = false;
  /** Continuous only: a verb has happened since the last settled still, so
   *  the next quiet earns one even if all it painted was a blip. */
  let stillOwed = false;
  /** Verbs performed so far, so a settled still can tell it went stale in
   *  the still line (`settledStill`). */
  let verbs = 0;
  /**
   * Continuous only: when each moveTo could have made the page react — its
   * path with the hover settle after it, and its marker to the end of its
   * verb — for the hover check made once every span has closed. Not the
   * marker alone: with recorded pacing the marker comes SETTLE_MS plus the
   * recorded interval after the path, and a hover's paint closed its span
   * long before (review of 2026-10-03; spec §4, "the moveTo's dispatch
   * window"). Not the whole stretch either: the paced wait between the two
   * is the page doing whatever it does on its own.
   */
  const moveToWindows: { startMs: number; endMs: number }[] = [];
  /** Continuous only: the edited gaps this run waited out live. */
  const pacedGaps: NonNullable<WalkStep["pacedGap"]>[] = [];
  /**
   * Unhurried beats (spec 2026-10-19), continuous with a room policy only.
   * `pendingAct` is the last step that acted, kept until the next step
   * begins or the take ends, when its act end is settled onto its marker.
   * `latestActEnd` is the latest act end so far; `roomAdded` the room
   * waited so far, which a click's zoom decision takes out.
   */
  const room = continuous ? deps.room : undefined;
  let pendingAct: {
    marker: FrameBundle["markers"][number];
    verbEndMs: number;
  } | null = null;
  let latestActEnd: number | null = null;
  let roomAdded = 0;
  /** What the last zoom holds until, as the camera counts it (`RoomPolicy`). */
  let lastHeldUntil: number | null = null;
  /** The last zoom's action and arrival, for the drags it holds through. */
  let lastZoom: { actionMs: number; arrivalMs: number } | null = null;
  /** The last counted step's finish, for `config.tail`. Cast so the
   *  checker does not narrow it to `null`: `stepFinished` sets it. */
  let lastFinishAt = null as number | null;
  /** The last counted step's `heldEndMs`, on the walk's clock, for the
   *  tail: what the trim's held zoom needs filmed. */
  let lastHeldEndAt = null as number | null;
  /**
   * The beat plan (spec 2026-11-13 Part 3), continuous with `beats` only.
   * `designed` is the designed clock: 0 at the opening still, moved only by
   * planned numbers (rests, journeys as dispatched, the arrive, each act's
   * designed length), never by the page or the machine. After a counted step
   * it is that step's designed act end. `designedZoom` and
   * `designedHeldUntil` are `lastZoom` and `lastHeldUntil` on it, which the
   * room policy is asked with; the source-time pair stays for `StepTiming`.
   * `stepPlan` is the step in hand, from its marker until it is counted
   * (`commitPlan`), so a step that never counts plans nothing.
   */
  const beats = continuous ? deps.beats : undefined;
  /** On a held clock the plan is played as page time, not returned. */
  const heldPlan = held !== undefined && beats !== undefined;
  /** The last act's end on the walk's clock; the walk's start before any. */
  let heldActEnd = 0;
  /** A held plan's rest or tail, slept as what is left of it since the last
   *  act ended: page time the step's settle played counts toward it, as the
   *  renderer folds that idle into the rest. Network time does not: it is
   *  the server's, played on top of the designed clock (spec §2), or a
   *  slower server would leave a different rest on another machine. */
  const sinceActEnd = (plannedMs: number, since = heldActEnd): number => {
    const now = at();
    let networkMs = 0;
    for (const s of held?.networkSpans() ?? []) {
      const from = Math.max(s.startMs - started, since);
      networkMs += Math.max(0, Math.min(s.endMs - started, now) - from);
    }
    return Math.max(0, plannedMs - (now - since - networkMs));
  };
  /** Plays a held rest or tail to its planned page time, counted from
   *  `since` (the last act's end): network time a wait before it spent
   *  since then is not counted against it, so the rest's held part is the
   *  plan's on any machine (review of Task 9, finding 3). The rest itself
   *  is designed time and never follows the server. */
  const playRest = async (
    plannedMs: number,
    since = heldActEnd,
  ): Promise<void> => {
    // A rest is designed time, which never follows the server
    // (`HeldClock.waiting`), so what is left is slept once.
    const left = sinceActEnd(plannedMs, since);
    if (left > HELD_EPS_MS) await clock.sleep(left);
  };
  /** Runs `run` as a wait on the page (`HeldClock.waiting`): the opening's
   *  load, a step's settle and screen, a wait step, a page's answer to a
   *  question. Everything else the walk sleeps is designed time. */
  const waitingOn = <T>(run: () => Promise<T>): Promise<T> =>
    held === undefined ? run() : held.waiting(run);
  let designed = 0;
  let designedZoom: { actionMs: number; arrivalMs: number } | null = null;
  let designedHeldUntil: number | null = null;
  /** Rest the plan added for the camera (room, a return's shortfall) to the
   *  steps counted so far: on `designed`, and taken out of the time a zoom
   *  is asked on, as the live walk takes out every room it waited. */
  let designedRoom = 0;
  const plannedBeats: NonNullable<ReplayResult["pacing"]>["beats"] = [];
  let stepPlan: {
    beat: (typeof plannedBeats)[number];
    markerMs: number;
    /** How much of `markerMs` is the camera's room for this step. */
    roomMs: number;
    zoomed: boolean;
  } | null = null;
  /** What each zoom was decided on (`ReplayResult.decided`). */
  const decided = new Map<string, ZoomDecision>();
  /** The script's pauses since the last counted step: a run that ends,
   *  or stops, after them closes on them (`BeatRules.tailMs`). */
  let pausedSinceCounted = 0;
  /** The beat for a step with no journey and no arrive (a wait, a key
   *  press), marked now. Approved: `arriveMs` 0 and the approach at the
   *  marker, since the walk sleeps no arrive before either. Answers the
   *  rest, which a held plan plays before the step. */
  const planUnplaced = (step: WalkStep): number => {
    if (beats === undefined) return 0;
    const restMs = beats.restBefore({
      first: plannedBeats.length === 0,
      pauseMs: step.pauseMs ?? 0,
      roomMs: 0,
      journeyMs: 0,
    });
    stepPlan = {
      beat: { beforeActionId: step.action.id, restMs, arriveMs: 0 },
      markerMs: designed + restMs,
      roomMs: 0,
      zoomed: false,
    };
    return restMs;
  };
  /** Where the last zoom held through an `after: "action"` cut lands, and
   *  a settle, on the designed clock; -Infinity with none held. */
  const plannedHeldEnd = (): number => {
    const landsAt =
      designedHeldUntil === null || config.tail?.after !== "action"
        ? null
        : heldThroughEndMs(designedHeldUntil, designed + config.tail.ms);
    return landsAt === null ? Number.NEGATIVE_INFINITY : landsAt + SETTLE_MS;
  };
  /** The plan's tail past its last counted step's designed act end
   *  (`pacing.tailMs`), asked once the steps are done. */
  const plannedTailMs = (rules: BeatRules): number =>
    Math.max(
      rules.tailMs({
        zoomSettleMs:
          room === undefined || designedHeldUntil === null
            ? null
            : Math.max(0, room.settledAfterMs(designedHeldUntil) - designed),
        trimEndMs: config.tail?.ms ?? null,
        trimAfterAction: config.tail?.after === "action",
        pauseMs: pausedSinceCounted + (source.closingPauseMs?.() ?? 0),
      }),
      // A zoom held through an `after: "action"` cut (DEM-178)
      // lands after it: the tail plays through that landing and a
      // settle, as the unplanned walk films through it.
      plannedHeldEnd() - designed,
    );
  /** A counted step's plan, onto the designed clock. */
  const commitPlan = (action: SceneAction): void => {
    const plan = stepPlan;
    stepPlan = null;
    if (beats === undefined || plan === null) return;
    pausedSinceCounted = 0;
    plannedBeats.push(plan.beat);
    designed = plan.markerMs + beats.actMs(action);
    designedRoom += plan.roomMs;
    if (plan.zoomed) {
      designedZoom = {
        actionMs: plan.markerMs,
        arrivalMs: plan.markerMs + CAMERA_DEFAULTS.leadInMs,
      };
      if (action.kind === "click") designedHeldUntil = designedZoom.arrivalMs;
    }
    // A drag holds the zoom it is pressed in until it lets go, as below.
    if (
      action.kind === "drag" &&
      designedZoom !== null &&
      plan.markerMs >= designedZoom.actionMs &&
      plan.markerMs <
        designedZoom.arrivalMs + CAMERA_DEFAULTS.neutral.zoomHoldMs
    ) {
      designedHeldUntil = Math.max(designedHeldUntil ?? designed, designed);
    }
  };
  /**
   * The one place a step's finish is measured: where the walk counts it,
   * after its verb returned and (sampled) its span closed. It moves with the
   * page and the machine, and that is fine: a trim offset built from it is a
   * duration added to the step's own marker, not a threshold anything
   * decides on, so a jitter moves the cut by as much and changes nothing else.
   */
  const stepFinished = (
    actionId: string,
    markerMs: number,
    startedAt: number,
  ): void => {
    const atMs = at();
    const zoomOutAtMs =
      room !== undefined && lastHeldUntil !== null
        ? room.settledAfterMs(lastHeldUntil)
        : null;
    lastFinishAt = atMs;
    lastHeldEndAt =
      room !== undefined &&
      lastHeldUntil !== null &&
      config.tail?.after === "action"
        ? heldThroughEndMs(lastHeldUntil, atMs + config.tail.ms)
        : null;
    source.onFinished?.(actionId, {
      markerMs,
      startMs: startedAt - markerMs,
      finishMs: atMs - markerMs,
      zoomOutMs: zoomOutAtMs === null ? null : zoomOutAtMs - markerMs,
      ...(lastHeldEndAt === null
        ? {}
        : { heldEndMs: lastHeldEndAt - markerMs }),
    });
  };

  const keyframes: KeyframeEntry[] = [];
  const motionSpans: FrameBundle["motionSpans"] = [];
  const cursorSamples: FrameBundle["cursorSamples"] = [];
  const anchorRects: FrameBundle["anchorRects"] = [];
  const markers: FrameBundle["markers"] = [];
  const degradations: Degradation[] = [];
  const counters = blankCounters(viewport, total);
  counters.dpr = stillScale;

  // Where the cursor enters, taken from the plan rather than from the origin
  // — see `WalkConfig.firstCursor`, and `runReplay` for where it comes from.
  // The compositor seeds the first segment at a deliberate point just outside
  // the first target — low and to the left, so the opening move reads as an
  // approach — and `retargetSegment` pins `from` to whatever is passed here.
  // Seeded at (0, 0) the first segment's bow was dragged to the viewport
  // corner, which is not a correctness break (the drawn cursor and the hover
  // pixels both come from the samples actually dispatched, so they still
  // agree) but it opens every replay with a corner teleport that really does
  // hover whatever sits top-left on the way past.
  let cursor = config.firstCursor;
  let completed = 0;
  // Set beside every `completed++`, never derived from `completed` after the
  // fact: indexing the action log by `completed` would name a different step
  // whenever a caller has filtered the scene it handed in, which since
  // 2026-09-24 a rebuild does. See `ReplayResult.lastCompletedActionId`.
  let lastCompletedActionId: string | null = null;
  // Clicks the page could not vouch for; see `ReplayResult.unconfirmedClicks`.
  const unconfirmedClicks: { actionId: string; note: string }[] = [];
  // Each drag's held button, and each drag the page ignored.
  const heldPresses: NonNullable<FrameBundle["heldPresses"]> = [];
  const ignoredDrags: { actionId: string; note: string }[] = [];
  // The step the walk has marked but not yet counted. A step is marked (its
  // marker, its anchor rect, a keyframe tagged with its id) before its verb
  // runs, so a throw between the two would leave the bundle claiming a step
  // the take never completed; the catch below takes those back.
  let inFlight: string | null = null;
  let reason: ReplayStopReason | null = null;
  let hoverSensitive = config.hoverSensitive;

  // Subscribed before Runtime.enable, which replays the contexts that
  // already exist.
  const contexts = new Map<string, number>();
  const offContext = cdp.on("Runtime.executionContextCreated", (params) => {
    const context = params.context as {
      id: number;
      auxData?: { frameId?: string; isDefault?: boolean };
    };
    const { frameId, isDefault } = context.auxData ?? {};
    if (isDefault === true && frameId !== undefined) {
      contexts.set(frameId, context.id);
    }
  });

  // Whether the top document is on its way out, for `awaitCondition`'s
  // `waitForLoad`. Between a navigating click and the new document's commit
  // the old one is still the document, and its `readyState` still says
  // `complete`: measured 2026-10-13 on Wikipedia's "Go", the read straight
  // after the release answered `complete` from the Main Page, the wait was
  // counted as met, and its still went out as the commit landed — "Not
  // attached to an active page", a `portFailure` in 4 of 6 CLI runs. A new
  // page slower than the settle fails nothing and is worse: the still is of
  // the page being left, and the run says `complete`.
  //
  // `navigationsSeen` counts every load the top frame started, so a read
  // taken before one began is known to be stale; `topLoading` holds until
  // the top frame stops loading. The top frame is
  // the one a `frameNavigated` with no parent named — before any has, every
  // frame counts, which errs towards waiting.
  const sightings = createClickSightings(cdp);
  let topFrameId: string | null = null;
  let topLoading = false;
  let navigationsSeen = 0;
  /** Top-frame documents committed (`Page.frameNavigated`, which a
   *  navigation within the document never sends). */
  let documentsCommitted = 0;
  // `navigationsSeen` as it stood when the previous step began (for step 0,
  // before the start navigation): a `waitForLoad` saw a load when the count
  // has moved since.
  let navsAtPreviousStep = 0;
  let navsAtThisStep = 0;
  const isTop = (params: Record<string, unknown>): boolean =>
    topFrameId === null || params.frameId === topFrameId;
  const offNavigated = cdp.on("Page.frameNavigated", (params) => {
    const frame = params.frame as { id?: string; parentId?: string };
    if (frame?.parentId === undefined && frame?.id !== undefined) {
      topFrameId = frame.id;
      documentsCommitted++;
    }
  });
  const offStarted = cdp.on("Page.frameStartedLoading", (params) => {
    if (!isTop(params)) return;
    navigationsSeen++;
    topLoading = true;
  });
  /** Whether the top document is loading. Held: whether a document's
   *  request is open, which the clock's frames account for as the server's
   *  time; `topLoading` ends on whichever frame the browser's event happens
   *  to arrive in. What the page does after its last byte is asked of it
   *  between frames (`documentLoading`). */
  const loading = (): boolean =>
    held === undefined ? topLoading : held.loading();
  const offStopped = cdp.on("Page.frameStoppedLoading", (params) => {
    if (isTop(params)) topLoading = false;
  });

  /**
   * The emulated viewport, asserted onto the page.
   *
   * Sent at setup and again whenever a screencast frame shows it has stopped
   * being true. Those are different failures with one correction:
   * `Page.captureScreenshot` follows this override, but `Page.screencastFrame`
   * follows the *window's* compositor surface, and the two part company the
   * moment that surface changes under a live override — the debugger infobar
   * appearing, the window being resized, an occlusion cycle. From then on the
   * screencast returns the window's own content area, which for a 1710x840
   * viewport in this 900x640 window was 1800x1104: a crop of the page's
   * top-left corner that the compositor would draw across the whole frame.
   *
   * Measured against real Chrome on 2026-08-30: after a resize, 16 of 18
   * frames came back cropped; re-sending this override put all 24 of the
   * next frames back at the emulated size. So the correction works, and it
   * is sent on detection rather than on a schedule — an override re-asserted
   * every span would fire a `resize` at the page on every beat, and a page
   * that lays itself out differently on resize is a page this would be
   * changing rather than replaying.
   */
  //
  // A device's metrics are re-sent whole, `mobile: true` included: a literal
  // here turned a phone into a desktop on exactly the path that only runs
  // when something has already gone wrong (spec 2026-10-10 §1).
  const applyMetrics = async (): Promise<void> => {
    await cdp.send(
      "Emulation.setDeviceMetricsOverride",
      device === null
        ? { ...desktopMetrics(viewport), deviceScaleFactor: stillScale }
        : deviceMetrics(device),
    );
  };

  // The recorder owns the span state and every count; the engine keeps the
  // subscription and the ack. See motion-recorder.ts.
  //
  // Spans are logical windows over the run-long screencast; the recorder
  // opens and closes them. See motion-recorder.ts and
  // 2026-08-31-continuous-capture-design.md for why the stream is not
  // started per span.
  //
  // The stills come first: in continuous mode the recorder asks for one
  // whenever the page goes quiet.

  // --- CDP helpers -------------------------------------------------------
  // Input and stills never overlap: see `input-gate.ts` for why.
  const sharedGate = deps.inputGate ?? createInputGate();
  // Every input section ends the last page capture's echo
  // (`ECHO_WINDOW_MS`): what paints after the walk acts is the page's.
  const gate: InputGate = {
    section: (input) =>
      sharedGate.section(() => {
        pageFrames.inputBegan();
        return input();
      }),
    capture: (take) => sharedGate.capture(take),
  };
  const takeShot = async (actionId: string | null): Promise<void> => {
    if (heldFrames !== null) {
      // Held: the page has not moved since its newest frame.
      const frame = heldFrames.latest();
      if (frame === null) {
        throw new Error(
          `no held frame had been captured at ${at()} ms to file as a still`,
        );
      }
      if (sealed) return;
      await fileStill(frame.bytes, actionId, at());
      return;
    }
    const reply = await gate.capture(() =>
      cdp.send("Page.captureScreenshot", {
        format: "jpeg",
        quality: KEYFRAME_QUALITY,
      }),
    );
    captureEndedMs = at();
    if (sealed) return;
    await fileStill(decodeBase64(String(reply.data ?? "")), actionId, at());
  };
  const fileStill = async (
    bytes: Uint8Array,
    actionId: string | null,
    atMs: number,
  ): Promise<void> => {
    const size = jpegSize(bytes);
    const ref = await store.putKeyframe(sceneId, keyframes.length, bytes);
    keyframes.push({
      sourceTimeMs: atMs,
      ref,
      width: size.width,
      height: size.height,
      actionId,
      byteLength: bytes.byteLength,
    });
    counters.keyframes++;
    deps.onProgress?.({
      step: completed,
      total,
      keyframes: keyframes.length,
      state: "running",
      note: null,
    });
  };
  const heldFrames =
    held === undefined
      ? null
      : createHeldFrames({
          encoder,
          fileStill: (bytes, atMs) => fileStill(bytes, null, atMs),
          onSpan: (entry) => motionSpans.push(entry),
          degradations,
        });
  // Before the walk's first sleep, which captures the first frame.
  /** Held: frames are filed from the opening on. The load and settle
   *  before it play page time too, unfilmed, as a real-time recording
   *  keeps no frame before its opening still. */
  let filing = false;
  if (held !== undefined && heldFrames !== null) {
    held.onFrame(async (frame) => {
      if (!filing) return;
      const atMs = frame.sourceTimeMs - started;
      try {
        await heldFrames.add({ ...frame, sourceTimeMs: atMs });
      } catch (error) {
        throw new Error(
          `the held frame at ${atMs} ms could not be filed (${describeSettleError(error)})`,
        );
      }
    });
  }

  /**
   * Every still goes through one line. A settled still is requested from
   * the recorder while the walk may be taking a marker still, and
   * `takeShot` files each under `keyframes.length` — two at once would
   * share an index and overwrite each other in the store.
   */
  let shooting: Promise<void> = Promise.resolve();
  /** Set once the run has stopped waiting for stills: a screenshot that
   *  answers after that files nothing, because the bundle has been built
   *  without it. */
  let sealed = false;
  /** Stills asked for and not yet answered: a page screen waits behind them
   *  only within a bound (`capturePage`). */
  let stillsWaiting = 0;
  const counted = (run: Promise<unknown>): void => {
    stillsWaiting++;
    const done = (): void => {
      stillsWaiting--;
    };
    void run.then(done, done);
  };
  const shot = (
    actionId: string | null,
    /** Asked again when the still's turn comes: false skips it. */
    stillWanted: () => boolean = () => true,
  ): Promise<void> => {
    const run = shooting.then(() =>
      stillWanted() ? takeShot(actionId) : undefined,
    );
    counted(run);
    shooting = run.catch(() => undefined);
    return run;
  };

  /** The two newest screencast frames, for `pageMoving`, and whoever is
   *  waiting on the next one (`nextFrame`). */
  let newestFrame: SeenFrame | null = null;
  let priorFrame: SeenFrame | null = null;
  let frameWaiters: Array<(frame: SeenFrame) => void> = [];
  const nextFrame = (ms: number): Promise<SeenFrame | null> =>
    new Promise((resolve) => {
      let settled = false;
      const waiter = (frame: SeenFrame): void => {
        if (settled) return;
        settled = true;
        resolve(frame);
      };
      frameWaiters.push(waiter);
      void clock.sleep(ms).then(() => {
        if (settled) return;
        settled = true;
        frameWaiters = frameWaiters.filter((w) => w !== waiter);
        resolve(null);
      });
    });

  /** When the last full still came back: the screencast is blind while
   *  one is taken (`standInFrame`). */
  let captureEndedMs = Number.NEGATIVE_INFINITY;

  /**
   * A step's own still. A full one stalls the screencast while it is taken,
   * so on a page that is moving it is a screencast frame instead: at the
   * screencast's resolution rather than `REPLAY_DPR`, and nothing lost.
   * Decided when its turn in the still line comes, not when it is asked
   * for: a still queued behind another runs later, and on 2026-10-24's
   * re-film one decided at the step ran 160 ms later into a sheet sliding
   * open. A frame that is not the whole viewport cannot stand in. What is
   * left open on purpose is in `standInFrame`.
   */
  const stepStill = (actionId: string): Promise<void> => {
    // Held: no screencast to stand in, and the held frame is the page now.
    if (heldFrames !== null) return shot(actionId);
    const run = shooting.then(async () => {
      const frame = await standInFrame(
        {
          newest: newestFrame,
          prior: priorFrame,
          captureEndedMs,
          nowMs: at(),
        },
        nextFrame,
        NEXT_FRAME_WAIT_MS,
      );
      if (sealed) return;
      const bytes = frame === null ? null : frameBytes(frame.data);
      if (frame === null || bytes === null) return takeShot(actionId);
      await fileStill(bytes, actionId, frame.atMs);
    });
    counted(run);
    shooting = run.catch(() => undefined);
    return run;
  };
  /** A screencast frame's bytes if it can stand in for a still: it decodes
   *  and it is the whole viewport at some scale. */
  const frameBytes = (data: string): Uint8Array | null => {
    try {
      const bytes = decodeBase64(data);
      return coversViewport(jpegSize(bytes), viewport) ? bytes : null;
    } catch {
      // Not a frame anyone can draw; the caller takes the full still.
      return null;
    }
  };

  /**
   * Continuous only: the sharp still for a page that just went quiet.
   * Forgiven, because a still that could not be taken must not fail the
   * take; reported, because the stretch then shows the last motion frame —
   * softer — and that must not read as a sharp one.
   */
  const settledStill = async (settledAt: number): Promise<void> => {
    // A still for a quiet page, skipped if a verb ran while it waited its
    // turn: the page is no longer the quiet one, and taking it anyway lands
    // a full still on the page's reaction (2026-10-24's re-film: one queued
    // behind a click's still ran just as the sheet began to open). Nothing
    // is lost: the verb set `stillOwed`, so the next quiet takes another.
    const asked = verbs;
    try {
      await shot(null, () => verbs === asked);
    } catch (error) {
      degradations.push(
        degradation(
          "stillFailed",
          settledAt,
          at(),
          `the still after the page settled could not be taken (${describeSettleError(error)}); this stretch shows the last motion frame`,
        ),
      );
    }
  };

  /**
   * Wait for the still line to empty, but not forever. A settled still can
   * be asked for just as the window is covered — the last span closes for
   * lack of frames, because painting stopped — and a screenshot of a page
   * that is not painting has no deadline of its own: the run then never
   * returned, and Stop never heard `occlusionTimeout` (review of
   * 2026-10-03). Forgiven, because the run's own reason is what matters;
   * said, because a still the film expected is missing.
   */
  /** Run time a real-time film removes from `fromMs` on: every recovered
   *  occlusion pause recorded so far, as much of it as lies after
   *  `fromMs`. The timeout's own zero-length entry removes nothing. */
  const pausedSince = (fromMs: number): number => {
    let ms = 0;
    for (const d of degradations) {
      if (d.kind !== "occlusionPause" || d.endMs <= d.startMs) continue;
      ms += Math.max(0, d.endMs - Math.max(d.startMs, fromMs));
    }
    return ms;
  };

  const drainShots = async (): Promise<boolean> => {
    // Held: a still is a frame already in hand, and a sleep raced here
    // would move page time beside the walk's own.
    if (held !== undefined) {
      await shooting;
      return true;
    }
    let drained = false;
    await Promise.race([
      shooting.then(() => {
        drained = true;
      }),
      clock.sleep(STILL_DRAIN_MS),
    ]);
    if (!drained) {
      sealed = true;
      degradations.push(
        degradation(
          "stillFailed",
          at(),
          at(),
          `a still was still being taken ${STILL_DRAIN_MS / 1000} s after the run stopped asking, and was abandoned — the page had most likely stopped painting`,
        ),
      );
    }
    return drained;
  };

  /**
   * Screencast frames a page screen must keep out of the video. While one is
   * taken the page shows its caret hidden and its spinners held; and a
   * clipped capture makes Chrome emit a frame at the clip's scale. Measured
   * 2026-11-10 at display scale 2: one 1280x800 frame among 2560x1600 ones,
   * arriving within two frames after the capture returned, and a span that
   * opened on it recorded its whole stretch at 1x (the runner's "records the
   * display scale" case). So a frame is judged by its stamp
   * (`capturedAway`): dropped if stamped from HOLD to RELEASE, however late
   * it arrives, and if stamped just after at another size than before the
   * capture, whatever arrived between.
   *
   * The stamp is the frame's own `metadata.timestamp`: wall-clock seconds,
   * measured 2026-11-11 on Chrome 151 at 2-4 ms before the frame arrives, on
   * the same clock as the runner's (`Date.now()`, launch.ts). Chrome stamps
   * it when the browser has the frame, not when it was composited, so one
   * frame composited just before RELEASE can still be stamped after it and
   * kept: at most one frame of a hidden caret or held spinner. A frame
   * without a stamp is placed at its arrival.
   */
  const pageFrames = (() => {
    let capture: CaptureWindow | null = null;
    const sizeOf = (data: string): string | null => {
      try {
        const { width, height } = jpegSize(decodeBase64(data));
        return `${width}x${height}`;
      } catch {
        // Not a frame anyone can measure; it is judged as a stray.
        return null;
      }
    };
    /** The newest frame kept or seen before filming began, so a page
     *  screen right after the opening still has a size to come back to. */
    let latest: string | null = null;
    return {
      seen(data: string): void {
        latest = data;
      },
      hold(): void {
        capture = {
          fromMs: clock.now(),
          toMs: null,
          inputMs: null,
          size: latest === null ? null : sizeOf(latest),
        };
      },
      release(): void {
        if (capture !== null) capture.toMs = clock.now();
      },
      inputBegan(): void {
        if (
          capture !== null &&
          capture.toMs !== null &&
          capture.inputMs === null
        )
          capture.inputMs = clock.now();
      },
      dropping(data: string, paintedMs: number): boolean {
        return capturedAway(paintedMs, () => sizeOf(data), capture);
      },
    };
  })();

  /** Continuous only: what counts the page's requests in flight, or why
   *  nothing does (`Network.enable` refused), which every screen then says. */
  let tracker = null as RequestTracker | null;
  let untracked = "they were never asked about";
  const pageScreens: PageScreen[] = [];

  /**
   * Held: an in-page wait on the page's own timers answers only as page time
   * moves, so page time is played a frame at a time until it answers, within
   * `boundMs` of page time; past that it throws, in words. The answer is
   * looked for only after a frame, whose page call is a round trip behind
   * it, so it lands on the same frame on any machine. Off a held clock, the
   * call as it was.
   */
  const answered = async (
    asked: Promise<Record<string, unknown>>,
    boundMs: number,
  ): Promise<Record<string, unknown>> => {
    // `asked` goes out `heldProbe`: bounded here in page time, which a slow
    // machine takes longer to play, never by the real-time answer deadline;
    // each frame's grant and page call keep theirs.
    if (held === undefined) return asked;
    let done = false;
    const reply = asked.finally(() => {
      done = true;
    });
    // Handled here; awaited below once it has answered.
    reply.catch(() => undefined);
    const from = clock.now();
    await held.waiting(async () => {
      while (!done) {
        if (clock.now() - from >= boundMs) {
          throw new Error(
            `the page had not answered after ${Math.round(boundMs)} ms of page time`,
          );
        }
        await clock.sleep(HELD_FRAME_MS);
      }
    });
    return reply;
  };

  /**
   * Held: the walk reads a click from the page clicked, and when the click
   * navigated to another site Chrome answers that read only once the new
   * page commits (measured 2026-11-15: 214 ms against the server's 200).
   * Played as page time, network time while the request is open, so the
   * server's wait is in the video as any other is; a click that stays on its
   * page answers after one frame. Off a held clock, the session as it is.
   */
  const verbCdp: CdpSession =
    held === undefined
      ? cdp
      : {
          ...cdp,
          send: (method, params, options) =>
            isClickRead(method, params)
              ? answered(
                  cdp.send(method, params, heldProbe),
                  NAVIGATE_TIMEOUT_MS,
                )
              : cdp.send(method, params, options),
        };

  /** Whether the top document says it is still loading. A page that
   *  cannot answer (one leaving, or not yet there) counts as loading: the
   *  caller keeps playing frames within its cap rather than racing a move
   *  into Chrome's hold on the next document. */
  const documentLoading = async (): Promise<boolean> => {
    try {
      const state = evaluatedValue(
        await cdp.send("Runtime.evaluate", {
          expression: "document.readyState",
          returnByValue: true,
        }),
      );
      return state === "loading" || state === "interactive";
    } catch {
      return true;
    }
  };

  /**
   * The page-side half of a step's settle (`step-settle.ts`), within
   * `deadline`. Answers the conditions that never held, in words.
   *
   * A step that navigated is asked about the new document: a load still
   * running is waited out first, and an answer from a document that began
   * to leave while it was asked (or that was destroyed under the question)
   * is asked again. Without that, a navigating click's screen was the old
   * page mid-unload (Review Focus 2).
   */
  const settlePage = async (deadline: number): Promise<Unmet[]> => {
    // Held: the budget is page time outside server stretches, as the probe
    // counts its cap (`stepSettleExpression`), so the server never spends
    // it (DEM-204); with the server's time in it, the settle stops a
    // request cap later.
    // Read only when held: a clock read is a moment of a real clock's.
    const began = held === undefined ? 0 : at();
    const outer = deadline + STEP_REQUEST_CAP_MS;
    const left = () =>
      held === undefined
        ? deadline - at()
        : at() < outer
          ? sinceActEnd(deadline - began, began)
          : 0;
    for (;;) {
      // Held: also while the clock owes the server frames, which the
      // probe's quiet window would otherwise run inside (`HeldClock.owing`).
      if (held === undefined)
        while (topLoading && at() < deadline) await clock.sleep(50);
      else
        while (
          (held.owing() || (await documentLoading())) &&
          left() > HELD_EPS_MS
        )
          await clock.sleep(HELD_FRAME_MS);
      const capMs = left();
      if (capMs <= HELD_EPS_MS) {
        return [...(loading() ? [STILL_LOADING] : []), PAGE_NOT_ASKED];
      }
      const navs = navigationsSeen;
      const commits = documentsCommitted;
      let report: Partial<StepSettleReport> | undefined;
      let failure: unknown = null;
      try {
        report = evaluatedValue(
          await answered(
            cdp.send(
              "Runtime.evaluate",
              {
                expression:
                  held === undefined
                    ? stepSettleExpression(STEP_QUIET_MS, capMs)
                    : stepSettleExpression(
                        HELD_STEP_QUIET_MS,
                        outer - at(),
                        Math.round(HELD_STEP_QUIET_MS / HELD_FRAME_MS),
                        Math.round(capMs / HELD_FRAME_MS),
                      ),
                awaitPromise: true,
                returnByValue: true,
              },
              heldProbe,
            ),
            (held === undefined ? capMs : outer - at()) + PROBE_GRACE_MS,
          ),
        ) as Partial<StepSettleReport> | undefined;
      } catch (error) {
        failure = error;
      }
      // Asked again when the answer may be the page being left. Held: only
      // when a new document committed or one's request is open. A navigation
      // within the document (a Next.js link's pushState) leaves none, and the
      // probe's quiet window already restarts on what it changes; counted, it
      // asked the window again only when it landed inside it, which the
      // server's timing decided: 12 frames apart (DEM-205, 2026-11-17).
      const replaced =
        held === undefined
          ? navigationsSeen !== navs
          : documentsCommitted !== commits;
      if ((replaced || loading()) && left() > HELD_EPS_MS) {
        continue;
      }
      const words = loading() ? [STILL_LOADING] : [];
      if (failure !== null) {
        return [
          ...words,
          machineMade(
            `the settle probe failed (${describeSettleError(failure)})`,
          ),
        ];
      }
      if (report === undefined || typeof report.quiet !== "boolean") {
        return [
          ...words,
          machineMade("the settle probe answered with nothing readable"),
        ];
      }
      return [...words, ...unsettledWords(report)];
    }
  };

  /**
   * Both halves of a step's settle: requests, then the page, and round again
   * while a request is in flight once the page has answered. All four
   * conditions must hold at once (spec 2026-11-10 decision 1), and a page can
   * start a request inside its own quiet window: a debounced search firing,
   * a new document's first fetches. Requests may take until `requestBy` (a
   * streamed answer is one long request); the page is then asked within its
   * own `STEP_SETTLE_CAP_MS`. A request still in flight when the cap runs
   * out leaves the page not asked.
   *
   * Only requests that opened after `openedAfter` are waited for. One open
   * longer than a whole request cap before the step began (a long poll, a
   * channel that never closes) had its step's wait already: waiting again
   * would cost every later step the cap and its screen.
   */
  const settleWords = async (
    requestBy: number,
    openedAfter: number,
  ): Promise<Unmet[]> => {
    for (;;) {
      if (tracker === null) {
        return [
          machineMade(`requests could not be watched (${untracked})`),
          ...(await settlePage(at() + STEP_SETTLE_CAP_MS)),
        ];
      }
      if (!(await tracker.idle(requestBy, clock.sleep, openedAfter))) {
        return [
          pageMade(`${tracker.inFlight(openedAfter)} request(s) in flight`),
          PAGE_NOT_ASKED,
        ];
      }
      const page = await settlePage(at() + STEP_SETTLE_CAP_MS);
      if (tracker.inFlight(openedAfter) === 0) return page;
      if (at() >= requestBy) {
        return [
          pageMade(`${tracker.inFlight(openedAfter)} request(s) in flight`),
          ...page,
        ];
      }
    }
  };

  /**
   * The page itself as a PNG at CSS 1x, on the still line and through the
   * gate like every still: caret hidden and endless animations held for the
   * capture only, and put back whatever happened. A put-back that failed is
   * answered, not thrown: the screen may be fine, but the video after it
   * may not be, and that must be said.
   *
   * The line is waited for within `STILL_DRAIN_MS`, as `drainShots` does: a
   * still ahead of it that never answers (a covered window stops painting)
   * would otherwise hold the walk here, short of the step's visibility
   * check that turns it into `occlusionTimeout`. The capture itself has the
   * same bound (`screening`): one that never answers is a screen not taken,
   * said in the deadline's words, and the hold is still put back.
   */
  /** Whether the still line empties within `STILL_DRAIN_MS`: what waits
   *  on it (a page screen, the pointer's move before a settle) would
   *  otherwise wait forever behind a still of a page that stopped painting. */
  const stillLineFree = async (): Promise<boolean> => {
    let free = stillsWaiting === 0;
    // Held: as `drainShots`; a page screen in the line has its own bound.
    if (!free && held !== undefined) {
      await shooting;
      free = true;
    }
    if (!free) {
      await Promise.race([
        shooting.then(() => {
          free = true;
        }),
        clock.sleep(STILL_DRAIN_MS),
      ]);
    }
    return free;
  };
  const STILL_LINE_STUCK = `a still ahead of it was still being taken after ${STILL_DRAIN_MS / 1000} s; the page had most likely stopped painting`;

  const capturePage = async (): Promise<{
    taken: {
      bytes: Uint8Array;
      held: number;
      atMs: number;
      caretShown: boolean;
    } | null;
    failure: unknown;
    releaseFailed: string | null;
  }> => {
    if (!(await stillLineFree())) throw new Error(STILL_LINE_STUCK);
    const run = shooting.then(() =>
      gate.capture(async () => {
        let taken: {
          bytes: Uint8Array;
          held: number;
          atMs: number;
          caretShown: boolean;
        } | null = null;
        let failure: unknown = null;
        pageFrames.hold();
        try {
          const g = evaluatedValue(
            await cdp.send("Runtime.evaluate", {
              expression: PAGE_CAPTURE_HOLD,
              returnByValue: true,
            }),
          ) as
            | (Partial<
                Record<"held" | "x" | "y" | "width" | "height" | "dpr", number>
              > & { caretShown?: boolean })
            | undefined;
          const { held, x, y, width, height, dpr } = g ?? {};
          if (
            held === undefined ||
            x === undefined ||
            y === undefined ||
            width === undefined ||
            height === undefined ||
            dpr === undefined
          ) {
            throw new Error("the capture hold answered with nothing readable");
          }
          const shot = await screening.cdp.send("Page.captureScreenshot", {
            format: "png",
            clip: { x, y, width, height, scale: 1 / dpr },
          });
          captureEndedMs = at();
          taken = {
            bytes: decodeBase64(String(shot.data ?? "")),
            held,
            atMs: captureEndedMs,
            // Unreadable counts as shown: a hidden caret is never assumed.
            caretShown: g?.caretShown !== false,
          };
        } catch (error) {
          failure = error;
        }
        let releaseFailed: string | null = null;
        try {
          evaluatedValue(
            await cdp.send("Runtime.evaluate", {
              expression: PAGE_CAPTURE_RELEASE,
              returnByValue: true,
            }),
          );
        } catch (error) {
          releaseFailed = describeSettleError(error);
        }
        pageFrames.release();
        return { taken, failure, releaseFailed };
      }),
    );
    shooting = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };

  /**
   * Continuous only: wait for a step's result to settle, then capture the
   * page (spec 2026-11-10, decisions 1 and 2), and record both in the take.
   * `after` is how many steps had finished; `actionId` the step, null for
   * the opening. Requests first (up to `STEP_REQUEST_CAP_MS`), then the page
   * (its own `STEP_SETTLE_CAP_MS`). Every condition that never held is written on the screen and
   * said as a `stepUnsettled` (the page's own) or a `stepSettleFailed` (any
   * of it this machine's, see `Unmet`), never taken as settled. A screen
   * that could not be taken does not fail the take, and says so the same
   * way. `pointerStep`: the step just finished moved the pointer (a
   * targeted verb), so its hover is renewed before the settle.
   */
  const settleAndCaptureNow = async (
    after: number,
    actionId: string | null,
    pointerStep = false,
  ): Promise<void> => {
    const from = at();
    const openedAfter = from - STEP_REQUEST_CAP_MS;
    // The pointer's move again, where it already rests, so the hover the
    // screen shows is the pointer's and is settled in the quiet window
    // below. Chrome recomputes hover after a layout change, and one that
    // lands while a still is in flight hit-tests at the display's scale,
    // not the emulated one (see `input-gate.ts`): measured 2026-11-11, a
    // click that added an element and a 3x still taken straight after left
    // the button unhovered 10 of 10 times, and this move put it back 10 of
    // 10. No cursor sample: the drawn cursor has not moved. Only after a
    // step that moved the pointer: a keyboard step (press, waitFor) leaves
    // it alone, since a menu the keys are walking follows the pointer on any
    // move and would lose the keys' selection (review of 301982b4).
    const moved: Unmet[] = [];
    if (pointerStep && cursorSamples.length > 0) {
      // Held: Chrome holds input for a document still loading until it
      // loads, which on a held clock is only as page time moves (measured
      // 2026-11-15: this move after a navigating click waited out Chrome's
      // own 30 s), so the load is played first, within the settle's cap:
      // while the clock is in the server's time (a document's request open,
      // `HeldClock.owing`), or the document says it is not yet complete
      // (a load no request announced, review of Task 9 round 1, finding C).
      // Both are asked between frames, never heard from a browser event, so
      // the frame the loop ends on is the same on any machine.
      if (held !== undefined) {
        const loadBy = at() + STEP_SETTLE_CAP_MS;
        while ((held.owing() || (await documentLoading())) && at() < loadBy)
          await clock.sleep(HELD_FRAME_MS);
      }
      try {
        // A section waits for any still in flight, and one of a page that
        // stopped painting never ends.
        if (!(await stillLineFree())) throw new Error(STILL_LINE_STUCK);
        const move = { type: "mouseMoved", x: cursor.x, y: cursor.y };
        await gate.section(() => cdp.send("Input.dispatchMouseEvent", move));
      } catch (error) {
        moved.push(
          machineMade(
            `the pointer's hover could not be renewed (${describeSettleError(error)})`,
          ),
        );
      }
    }
    const unsettled = [
      ...moved,
      ...(await settleWords(from + STEP_REQUEST_CAP_MS, openedAfter)),
    ];
    const waitedMs = Math.max(0, at() - from);
    const leftOut =
      tracker === null ? 0 : tracker.inFlight() - tracker.inFlight(openedAfter);
    const place =
      actionId === null
        ? "the opening page"
        : `the page after step ${actionId}`;
    if (leftOut > 0) {
      // Forgiven, not hidden: the screen counts as settled, and this says
      // what it did not wait for.
      degradations.push(
        degradation(
          "requestNotWaited",
          from,
          at(),
          `${place}: ${leftOut} request${leftOut === 1 ? "" : "s"} opened more than ${STEP_REQUEST_CAP_MS / 1000} s before this step's wait began ${leftOut === 1 ? "was" : "were"} not waited for`,
        ),
      );
    }
    let screen: PageScreen | null = null;
    try {
      const { taken, failure, releaseFailed } = await capturePage();
      // The screen was taken under the hold and is fine; the video after it
      // is what may be wrong, so this is said apart from the screen.
      if (releaseFailed !== null) {
        degradations.push(
          degradation(
            "pageHoldNotReleased",
            from,
            at(),
            `${place}: the caret and held animations may not have been put back (${releaseFailed})`,
          ),
        );
      }
      if (taken === null) throw failure;
      if (taken.caretShown) {
        unsettled.push(pageMade("a focused field's caret could not be hidden"));
      }
      const size = pngSize(taken.bytes);
      screen = {
        after,
        sourceTimeMs: taken.atMs,
        ref: await store.putPageScreen(sceneId, after, taken.bytes),
        width: size.width,
        height: size.height,
        heldAnimations: taken.held,
        waitedMs,
      };
    } catch (error) {
      unsettled.push(
        machineMade(
          `the page screen could not be taken (${describeSettleError(error)})`,
        ),
      );
    }
    screen ??= {
      after,
      sourceTimeMs: at(),
      ref: "",
      width: viewport.width,
      height: viewport.height,
      heldAnimations: 0,
      waitedMs,
    };
    if (unsettled.length > 0) {
      screen.unsettled = unsettled.map((u) => u.words).join("; ");
      degradations.push(
        degradation(
          unsettled.some((u) => u.machine)
            ? "stepSettleFailed"
            : "stepUnsettled",
          from,
          at(),
          `${place}: ${screen.unsettled}`,
        ),
      );
    }
    pageScreens.push(screen);
    // Time the walk added, like room: a zoom is decided with it taken out,
    // so a settle that ran long cannot make a zoom (MIN_ZOOM_GAP_MS) the
    // take would not have had, nor jitter one across that line.
    roomAdded += at() - from;
  };
  /** Held: the requests the settle leaves out (`settleAndCaptureNow`'s
   *  `openedAfter`) are not followed either, or a stream opened before it
   *  kept every settle in a stretch that never ended (DEM-204). */
  const settleAndCapture = (
    ...asked: Parameters<typeof settleAndCaptureNow>
  ): Promise<void> =>
    held === undefined
      ? settleAndCaptureNow(...asked)
      : held.waiting(
          () => settleAndCaptureNow(...asked),
          tracker?.openedBy(at() - STEP_REQUEST_CAP_MS),
        );

  // None on a held clock: its frames are filed by `heldFrames`.
  const recorder =
    held === undefined
      ? createMotionRecorder({
          encoder,
          clock,
          at,
          viewport,
          counters,
          degradations,
          applyMetrics,
          onSpan: (entry) => motionSpans.push(entry),
          mode: continuous ? "continuous" : "sampled",
          // A quiet page earns a sharp still when what just ended was motion, or
          // when a verb has happened since the last still and so the page may
          // look different. Not for every blip: a focused field's caret repaints
          // one frame about every 500 ms, and a 3x still each time was ~1.2 MB/s
          // and a queue the marker stills waited in (final review I2).
          onSettled: (settledAt, frames) => {
            if (frames < SPAN_MIN_FRAMES && !stillOwed) return;
            stillOwed = false;
            void settledStill(settledAt);
          },
        })
      : null;

  const offFrame = cdp.on("Page.screencastFrame", (params) => {
    // Ack first and unconditionally: Chrome stops sending frames until the
    // previous one is acknowledged, so an ack skipped because no span was
    // open would stall the *next* span too. A session torn down mid-flight
    // rejects the ack, and an unhandled rejection during teardown is noise
    // over a run that already ended.
    void cdp
      .send("Page.screencastFrameAck", { sessionId: params.sessionId })
      .catch(() => undefined);
    // Continuous: the film starts at the opening still. What paints before
    // it is the page loading — the navigation, a bar sweeping, a black
    // first paint — which is exactly what the settle waited out.
    const data = String(params.data ?? "");
    if (continuous && !filming) {
      pageFrames.seen(data);
      return;
    }
    const arrived = clock.now();
    const stamp = (params.metadata as { timestamp?: unknown } | undefined)
      ?.timestamp;
    const painted = typeof stamp === "number" ? stamp * 1000 : arrived;
    if (pageFrames.dropping(data, painted)) return;
    pageFrames.seen(data);
    const seen = { data: String(params.data ?? ""), atMs: arrived - started };
    priorFrame = newestFrame;
    newestFrame = seen;
    for (const waiter of frameWaiters.splice(0)) waiter(seen);
    recorder?.onFrame(params);
  });

  /**
   * Where CDP says the element is *right now*, in main-frame CSS pixels.
   *
   * The **border** quad, not the content one. `DOM.getBoxModel` returns
   * several, and `content` is inset by the element's padding: measured on a
   * button with `padding: 12px 20px`, `content` came back 41.7x18 where
   * `border` came back 81.7x42 — and 81.7x42 is exactly what
   * `getBoundingClientRect` reports, which is what capture records into
   * `fingerprint.boundingRect`.
   *
   * Symmetric padding leaves the two centres identical, so clicks land either
   * way and nothing here would ever have complained. What would have suffered
   * is `anchorRects`, which is what the compositor frames its camera from: an
   * auto-zoom on a padded control would frame the label instead of the
   * control, and the only symptom is a video that looks slightly wrong.
   * Border box means capture and replay describe the same element the same
   * way.
   */
  // The page's zoom when an element is measured (`ViewportTransform`). A
  // phone shows a page with no meta viewport zoomed out, and the walk's
  // rects (`DOM.getBoxModel`) and input points are the page's own px,
  // measured from the visual viewport's origin — so only the scale applies,
  // and the offsets are recorded as 0. Nobody pinches an agent run.
  //
  // A device's only: without `mobile: true` the page is laid out at the
  // viewport's own width and never zoomed out, so a desktop run's answer is
  // always scale 1 — and asking cost a CDP round trip on every measure,
  // each `waitFor` poll's included (review 2026-10-11).
  const viewportTransforms: ViewportTransform[] = [];
  const noteZoom = async (): Promise<void> => {
    if (device === null) return;
    const metrics = (await cdp
      .send("Page.getLayoutMetrics", {})
      .catch((error: unknown) => {
        console.info(
          `[demoman] the page's zoom could not be read; drawn at scale 1 (${String(error)})`,
        );
        return null;
      })) as { cssVisualViewport?: { scale?: unknown } } | null;
    const scale = metrics?.cssVisualViewport?.scale;
    if (typeof scale !== "number" || !(scale > 0)) return;
    if (viewportTransforms.at(-1)?.scale === scale) return;
    viewportTransforms.push({
      sourceTimeMs: at(),
      scale,
      offsetX: 0,
      offsetY: 0,
    });
  };

  //
  // `ask: "seen"` is what a `waitFor` asks instead: whether the element can be
  // SEEN, so `opacity: 0` and `visibility: hidden` are not shown either.
  // Found 2026-10-13: a sample app's toast sits in the DOM at opacity 0 until
  // a submit fades it in, and a `waitFor visible` on it passed on a submit
  // that never happened. Only the waits ask it — a click target can be
  // transparent on purpose (a file input laid over a styled button), and the
  // snapshot lists targets by the plain question, so clicks keep it.
  const measure = async (
    objectId: string,
    ask: "rendered" | "seen" = "rendered",
  ): Promise<Rect | null> => {
    await noteZoom();
    // `DOM.getBoxModel` *rejects* for a node with no layout box — a
    // `display:none` panel, a detached node — rather than returning an empty
    // model, and the sensor resolves on tree presence, not visibility. So a
    // hidden element resolves, gets parked, and is measured here. Two paths
    // depend on that being an answer rather than a throw: `waitFor
    // { condition: "hidden" }` *succeeds* by measuring nothing, and a
    // `waitFor { condition: "visible" }` on a panel that is already in the
    // tree has to keep polling until it renders. A throw escaping here would
    // report both as `portFailure` — the second before it had polled once.
    // Every caller already reads null as "not on screen".
    //
    // A box is not the same as being shown, so the element is also asked
    // `checkVisibility()` — the question the agent door's snapshot asks, and
    // the two must agree. Measured on Chrome 151: a closed `<details>`'s
    // content (its `::details-content` is `content-visibility: hidden`)
    // still gets a border quad, so a `waitFor visible` on an FAQ answer
    // passed with the answer folded away and a `waitFor hidden` on it never
    // could. Only an explicit `false` hides the box: a reply that carries no
    // boolean is not evidence the element is hidden. A rejection reads as
    // `getBoxModel`'s does, for the same reason — the object went away
    // between the two calls (a navigation), and "not on screen" is what
    // every caller already does with that.
    // The question goes to the element in the page's own world, so a page
    // that overrides `Element.prototype.checkVisibility` answers it: one
    // returning false would make every target lost, "not on screen".
    // Accepted, not guarded (cli-launch.md project A, 2026-10-14): Chrome
    // has the method natively, so only a hostile page or a broken polyfill
    // does this, and asking again from an isolated world would cost a CDP
    // round trip on every measure and `waitFor` poll.
    let model: { border?: number[] } | undefined;
    let shown: unknown;
    try {
      model = (await cdp.send("DOM.getBoxModel", { objectId })).model as
        | { border?: number[] }
        | undefined;
      if (model?.border === undefined) return null;
      shown = (
        (
          await cdp.send("Runtime.callFunctionOn", {
            objectId,
            functionDeclaration:
              ask === "seen"
                ? `function(){return (${seenNow.toString()})(this)}`
                : "function(){return this.checkVisibility()}",
            returnByValue: true,
          })
        ).result as { value?: unknown } | undefined
      )?.value;
    } catch {
      return null;
    }
    return shown === false ? null : rectFromQuad(model.border);
  };

  /**
   * Where the iframe that owns `frameId` sits in its parent document's
   * `querySelectorAll("iframe")` order — the same enumeration capture's
   * ordinals come from, asked of the live page.
   *
   * Three calls rather than one because CDP has no single command for it:
   * `DOM.getFrameOwner` names the owner node, `DOM.resolveNode` turns that
   * into a handle in the parent's own realm, and the function then counts.
   * Only hops that claim neither an origin nor a name pay for it — see
   * `resolveCdpFrameId`.
   *
   * Null on any failure, which `resolveCdpFrameId` reads as a refusal: an
   * unanswerable corroboration is not a passed one.
   */
  const documentOrdinalOf = async (frameId: string): Promise<number | null> => {
    try {
      const owner = await cdp.send("DOM.getFrameOwner", { frameId });
      if (typeof owner.backendNodeId !== "number") return null;
      const node = (
        await cdp.send("DOM.resolveNode", {
          backendNodeId: owner.backendNodeId,
        })
      ).object as { objectId?: string } | undefined;
      if (node?.objectId === undefined) return null;
      const result = (
        await cdp.send("Runtime.callFunctionOn", {
          objectId: node.objectId,
          functionDeclaration:
            "function(){return Array.prototype.indexOf.call(this.ownerDocument.querySelectorAll('iframe'), this) + 1}",
          returnByValue: true,
        })
      ).result as { value?: unknown } | undefined;
      const ordinal = result?.value;
      return typeof ordinal === "number" && ordinal > 0 ? ordinal : null;
    } catch {
      return null;
    }
  };

  /**
   * Where an anchor sits on screen, as CDP sees it. The sensor resolves and
   * parks the element in whichever frame holds it; `DOM.getBoxModel` then
   * returns quads in *main-frame* coordinates, which is the only space
   * `Input.dispatchMouseEvent` accepts — so geometry and input can never
   * disagree about which pixel a click landed on.
   *
   * A null target is a step that names no element — a navigation wait — and
   * is lost by definition. It is checked here and nowhere else, so that the
   * one condition has the one test.
   */
  const locate = async (
    target: AnchorIntent | null,
    ask: "rendered" | "seen" = "rendered",
  ): Promise<Located> => {
    if (target === null) return LOST;

    const [report] = await page.resolve([target]);
    if (report === undefined || !report.resolved) {
      // The resolver's own verdict, carried rather than flattened: "gone",
      // "tied" and "not rendered yet" are three different things to tell an
      // author, and only this call knows which one it was.
      return {
        handle: null,
        failureReason: report?.failureReason ?? null,
        report: null,
      };
    }

    const hops = hopsFromTreePath(target.fingerprint.treePath);
    const evaluate: Record<string, unknown> = {
      expression: `window[${JSON.stringify(REPLAY_TARGETS)}]?.[${JSON.stringify(target.id)}]`,
    };
    if (hops.length > 0) {
      const tree = (await cdp.send("Page.getFrameTree"))
        .frameTree as CdpFrameNode;
      const frameId = await resolveCdpFrameId(tree, hops, {
        documentOrdinalOf,
      });
      // Not in the tree, or in it and contradicting the hop's origin, name
      // or ordinal. Either way the frames are not the frames the take
      // recorded, and no number of re-runs changes that.
      if (frameId === null) return FRAME_MISMATCH;
      // The frame's *default* context, which is its MAIN world. An isolated
      // world would evaluate cleanly and see nothing, since the element was
      // parked on the MAIN world's global — a silent wrong answer dressed up
      // as a missing element.
      const contextId = contexts.get(frameId);
      if (contextId === undefined) return UNREACHABLE;
      evaluate.contextId = contextId;
    }

    const result = (await cdp.send("Runtime.evaluate", evaluate)).result as
      | { objectId?: string }
      | undefined;
    if (result?.objectId === undefined) return UNREACHABLE;

    const rect = await measure(result.objectId, ask);
    return rect === null
      ? LOST
      : {
          handle: { objectId: result.objectId, rect },
          failureReason: null,
          report,
        };
  };

  /**
   * Where a `scrollTo` beat puts its anchor: back at its recorded top, or
   * centred when there is no recorded landing to go back to. See `ScrollAim`.
   *
   * A recorded rect that misses the viewport is not a landing the author
   * had. The anchor was chosen from the centre of the screen, so it spanned
   * the screen when it was chosen, and a rect elsewhere was measured after
   * the page had moved on (the hover on the take of 2026-09-29 came back at
   * y=2460 in an 840px viewport for exactly that reason). Aiming at it would
   * scroll the anchor off screen, so the beat centres instead — and says so,
   * because a landing that is not the author's must not read like one.
   *
   * An authored step's `landing` wins over `action.rect` (which an authored
   * action does not have until the run measures it). It states only a top, so
   * the element's height is the one the walk just measured (`measured`) and
   * the same rule applies: a top that would leave the element off screen
   * centres and says so. `measured` is null only when the element was not
   * located, where the walk stops before aiming at anything.
   */
  const scrollAimOf = (step: WalkStep, measured: Rect | null): ScrollAim => {
    const { action } = step;
    let aimed: { y: number; height: number; whose: string } | undefined;
    if (step.landing !== undefined) {
      if (measured === null) return "center";
      aimed = {
        y: step.landing.top,
        height: measured.height,
        whose: "the script's",
      };
    } else if (action.rect !== undefined) {
      aimed = { ...action.rect, whose: "the recorded" };
    }
    if (aimed === undefined) return "center";
    if (aimed.y < viewport.height && aimed.y + aimed.height > 0) {
      return { top: aimed.y };
    }
    degradations.push(
      degradation(
        "scrollLandingOffscreen",
        at(),
        at(),
        `${aimed.whose} landing for ${action.id} was y=${aimed.y} (height ${aimed.height}) in a ${viewport.height}px viewport; centred instead`,
      ),
    );
    return "center";
  };

  /**
   * `bringIntoView` on a held clock. Chrome's smooth scroll runs on its real
   * clock (and held recordings launch with it off), so the walk plays the
   * scroll itself: one step a captured frame, over `HELD_SCROLL_MS` on the
   * cursor's minimum-jerk ease, each step asked of the target itself, so in
   * its own frame. Ends with the last step landed, so the re-measure and
   * `scrollEndAt` are taken where the scroll stopped.
   */
  const playScroll = async (
    handle: TargetHandle,
    aim: ScrollAim,
  ): Promise<TargetHandle | null> => {
    const planned = evaluatedValue(
      await cdp.send("Runtime.callFunctionOn", {
        objectId: handle.objectId,
        functionDeclaration: heldScrollPlanFunction(aim),
        returnByValue: true,
      }),
    ) as Partial<ScrollReport> | undefined;
    if (typeof planned?.movedPx !== "number") {
      degradations.push(
        degradation(
          "scrollUnsettled",
          at(),
          at(),
          "the scroll plan answered with nothing this could read",
        ),
      );
    } else if (planned.movedPx > 0) {
      const frames = Math.ceil(HELD_SCROLL_MS / HELD_FRAME_MS - HELD_EPS_MS);
      for (let k = 1; k <= frames; k++) {
        const p = easings.minimumJerk(Math.min(1, k / frames));
        evaluatedValue(
          await cdp.send("Runtime.callFunctionOn", {
            objectId: handle.objectId,
            functionDeclaration: HELD_SCROLL_STEP,
            arguments: [{ value: p }],
          }),
        );
        await clock.sleep(HELD_FRAME_MS);
      }
    }
    const rect = await measure(handle.objectId);
    return rect === null ? null : { objectId: handle.objectId, rect };
  };

  /**
   * Put the target on screen before anything is dispatched at it.
   *
   * `DOM.getBoxModel` quads are **viewport-relative** — measured against real
   * Chromium, where an element 2400 px down a page reports y ≈ 2681 on an
   * 800 px viewport. `Input.dispatchMouseEvent` takes the same space, so an
   * off-screen target is otherwise clicked at coordinates that land on
   * whatever happens to be there instead, and the run reports `complete`. A
   * demo that silently did nothing is worse than one that reported a failure.
   *
   * This is a correction, not a beat, which is why it does not reuse the
   * `scrollTo` verb's scroll. That one is `smooth` and aimed at the anchor's
   * recorded landing, or `center` without one (`scrollAimOf`): it is
   * something the viewer is meant to watch, and it fires inside the motion
   * span so the screencast records it. This one is `instant` — no animation
   * to wait out, and the quad reflects it on the very next call, with no
   * settle needed — and `nearest`, so it is a no-op for an element already in
   * view rather than nudging the page under every single action. It also runs
   * before the marker keyframe and before the span opens, so nothing records
   * it as motion.
   *
   * It applies to every verb, `scrollTo` included. The alternative — letting
   * that one verb handle its own scrolling — would dispatch the cursor path
   * to off-screen coordinates and take the marker keyframe with the target
   * nowhere in frame. `nearest` leaves the beat's own smooth scroll plenty
   * left to show.
   */
  const bringIntoView = async (
    handle: TargetHandle,
    aim: ScrollAim,
  ): Promise<TargetHandle | null> => {
    if (held !== undefined) return playScroll(handle, aim);
    const reply = await cdp.send("Runtime.callFunctionOn", {
      objectId: handle.objectId,
      functionDeclaration: scrollIntoViewFunction(
        aim,
        SCROLL_SETTLE_TIMEOUT_MS,
      ),
      awaitPromise: true,
      returnByValue: true,
    });
    const report = (reply.result as { value?: unknown } | undefined)?.value as
      | Partial<ScrollReport>
      | undefined;
    // A scroll still moving when the wait expired, or a reply this cannot
    // read, means the rect measured next may not be where the target ends up
    // — and everything downstream is aimed at that rect. Forgiven, because a
    // take must not fail on a page that animates forever, and reported,
    // because the alternative is a click dispatched at wherever the target
    // used to be on a run that goes on to say `complete`.
    if (report === undefined || report.settled !== true) {
      degradations.push(
        degradation(
          "scrollUnsettled",
          at(),
          at(),
          report === undefined
            ? "the scroll probe answered with nothing this could read"
            : `the target was still moving after ${SCROLL_SETTLE_TIMEOUT_MS}ms`,
        ),
      );
    }
    // Measured *after*, always. A rect from before the scroll describes where
    // the element used to be, and every consumer of it — the cursor path, the
    // anchor rect the compositor frames its camera on — would be pointed at
    // a place nothing is any more.
    const rect = await measure(handle.objectId);
    return rect === null ? null : { objectId: handle.objectId, rect };
  };

  /** Paths whose last move reached the page late, said once for the run
   *  (as the recorder's budget breaches are): on a slow runner every path
   *  is late, and a note per path says nothing the count does not. */
  let pointerLate: {
    entry: Degradation;
    paths: number;
    worstMs: number;
  } | null = null;

  /**
   * Sends a path's moves paced against the clock, not step by step. Chrome
   * answers a move once the renderer has taken it, about a frame, and a
   * fixed sleep after each answer made every path take about twice its
   * plan: 1.4s for a 700ms move, twice in a row on the author's take of
   * 2026-09-29. Each move is the point the curve has reached by the time it
   * is sent (`pathPointAt` says why not a list planned ahead), so the first
   * starts where the cursor is and the one sent once the time is up lands.
   * A move answered sooner than `PATH_STEP_MS` waits out the rest: Chrome
   * never does that, but nothing else bounds the rate.
   *
   * The drawn cursor is the planned curve on its own grid, not one sample
   * per move sent: a runner answered a move in up to ~480 ms (2026-11-15),
   * and a sample per answer drew a 700 ms move as four jumps. Drawn as far
   * as the last move the page took, so a send that fails mid-path keeps
   * the trail it made. A path whose last move landed more than
   * `POINTER_LATE_MS` after its plan is said (`pointerLate`): the drawn
   * cursor arrives that much before the page's hover shows.
   */
  const walkPath = async (
    segment: CursorSegment,
    send: (point: { x: number; y: number }) => Promise<unknown>,
  ): Promise<void> => {
    const start = at();
    let sentAt = start;
    let answered = -1;
    try {
      for (;;) {
        const elapsed = sentAt - start;
        await send(pathPointAt(segment, elapsed));
        answered = elapsed;
        const now = at();
        // Held: within the clock's own tolerance, or a remainder it will not
        // move would spin here.
        if (
          elapsed >=
          segment.durationMs - (held === undefined ? 0 : HELD_EPS_MS)
        )
          break;
        // Held: one move per frame of page time, the last at the path's end.
        const wait =
          held === undefined
            ? PATH_STEP_MS - (now - sentAt)
            : Math.min(
                HELD_FRAME_MS - (now - sentAt),
                segment.durationMs - elapsed,
              );
        if (wait > 0) await clock.sleep(wait);
        sentAt = at();
      }
    } finally {
      if (answered >= 0) {
        const until = Math.min(answered, segment.durationMs);
        for (let ms = 0; ms < until; ms += PATH_STEP_MS) {
          const p = pathPointAt(segment, ms);
          cursorSamples.push({ sourceTimeMs: start + ms, x: p.x, y: p.y });
        }
        const last = pathPointAt(segment, until);
        cursorSamples.push({
          sourceTimeMs: start + until,
          x: last.x,
          y: last.y,
        });
      }
    }
    const lateMs = Math.round(answered - segment.durationMs);
    if (lateMs > POINTER_LATE_MS) {
      if (pointerLate === null) {
        pointerLate = {
          entry: degradation("pointerLate", start, at(), ""),
          paths: 0,
          worstMs: 0,
        };
        degradations.push(pointerLate.entry);
      }
      pointerLate.paths++;
      pointerLate.worstMs = Math.max(pointerLate.worstMs, lateMs);
      pointerLate.entry.endMs = at();
      pointerLate.entry.note = `${pointerLate.paths} pointer ${pointerLate.paths === 1 ? "move" : "moves"} reached the page up to ${pointerLate.worstMs} ms after the drawn cursor`;
    }
  };

  const dispatchPath = async (
    segment: CursorSegment,
    to: { x: number; y: number },
  ): Promise<void> => {
    await walkPath(retargetSegment(segment, cursor, to), (point) =>
      cdp.send("Input.dispatchMouseEvent", {
        type: "mouseMoved",
        x: point.x,
        y: point.y,
      }),
    );
    cursor = to;
  };

  /**
   * A press at `plan.start`, a move with the button held along the walk's
   * eased path (after a few small lead moves past library drag thresholds),
   * a dwell at the end so a drop target's hover shows, and a release there.
   * Judged by the click probe against both ends. A drag that arrived and
   * changed nothing between its ends on screen is said (`notDragged`), not
   * read as done.
   */
  const performDrag = async (
    actionId: string,
    plan: DragPlan,
    objectId: string,
    touch: boolean,
  ): Promise<ClickVerdict> => {
    // What the drag changed, watched in the page; null when the watch could
    // not be placed or read (a drop that navigated), which claims nothing.
    const watchChanges = async (
      probeObjectId: string,
    ): Promise<
      () => Promise<{ changed: boolean; unknown: boolean } | null>
    > => {
      const box = {
        x: Math.min(plan.start.x, plan.endRect.x),
        y: Math.min(plan.start.y, plan.endRect.y),
        width: 0,
        height: 0,
      };
      box.width =
        Math.max(plan.start.x, plan.endRect.x + plan.endRect.width) - box.x;
      box.height =
        Math.max(plan.start.y, plan.endRect.y + plan.endRect.height) - box.y;
      let watchId: string | null = null;
      try {
        const reply = await cdp.send("Runtime.callFunctionOn", {
          objectId: probeObjectId,
          functionDeclaration: DRAG_WATCH_INSTALL,
          arguments: [{ value: box }],
          returnByValue: false,
        });
        watchId =
          ((reply.result as { objectId?: unknown } | undefined)?.objectId as
            | string
            | undefined) ?? null;
      } catch {
        watchId = null;
      }
      return async () => {
        if (watchId === null) return null;
        try {
          const reply = await cdp.send("Runtime.callFunctionOn", {
            objectId: watchId,
            functionDeclaration: DRAG_WATCH_READ,
            returnByValue: true,
          });
          return (
            ((reply.result as { value?: unknown } | undefined)?.value as
              | { changed: boolean; unknown: boolean }
              | undefined) ?? null
          );
        } catch {
          return null;
        }
      };
    };
    const point = (p: { x: number; y: number }) => ({
      x: p.x,
      y: p.y,
      radiusX: 4,
      radiusY: 4,
      force: 1,
      id: 0,
    });
    // A native drag: Chrome reports the page's `dragstart` here instead of
    // starting an OS drag (`Input.setInterceptDrags`), and the rest of the
    // move goes as drag events. Mouse only: touch has no such channel.
    let dragData: Record<string, unknown> | null = null;
    let native = false;
    const offIntercept = touch
      ? () => undefined
      : cdp.on("Input.dragIntercepted", (params) => {
          dragData = (params.data as Record<string, unknown>) ?? {};
        });
    const onPage = (fn: string, args: unknown[] = []) =>
      cdp.send("Runtime.callFunctionOn", {
        objectId,
        functionDeclaration: fn,
        arguments: args.map((value) => ({ value })),
        returnByValue: true,
      });
    const pictureSays = (reply: Record<string, unknown>): unknown =>
      (reply.result as { value?: unknown } | undefined)?.value;
    let pictureShown = false;
    const move = async (p: { x: number; y: number }): Promise<void> => {
      if (native) {
        await cdp.send("Input.dispatchDragEvent", {
          type: "dragOver",
          x: p.x,
          y: p.y,
          data: dragData,
        });
        if (pictureShown) await onPage(DRAG_PICTURE_MOVE, [p.x, p.y]);
      } else if (touch) {
        await cdp.send("Input.dispatchTouchEvent", {
          type: "touchMove",
          touchPoints: [point(p)],
        });
      } else {
        await cdp.send("Input.dispatchMouseEvent", {
          type: "mouseMoved",
          x: p.x,
          y: p.y,
          button: "left",
          buttons: 1,
        });
        if (dragData !== null) {
          native = true;
          await cdp.send("Input.dispatchDragEvent", {
            type: "dragEnter",
            x: p.x,
            y: p.y,
            data: dragData,
          });
          let why: unknown;
          try {
            why = pictureSays(await onPage(DRAG_PICTURE_SHOW, [p.x, p.y]));
          } catch (error) {
            why = error instanceof Error ? error.message : String(error);
          }
          pictureShown = why === null;
          if (!pictureShown) {
            degradations.push(
              degradation(
                "dragPictureMissing",
                at(),
                at(),
                `a native drag's picture could not be drawn: ${String(why)}`,
              ),
            );
          }
        }
      }
    };
    const probe = await placeClickProbe(cdp, objectId, actionId);
    // After the probe, so placing it is not a change the drag made.
    const changes = await watchChanges(objectId);
    let pressMs: number;
    try {
      if (!touch) {
        await onPage(DRAG_PICTURE_INSTALL);
        await cdp.send("Input.setInterceptDrags", { enabled: true });
      }
      await (touch
        ? cdp.send("Input.dispatchTouchEvent", {
            type: "touchStart",
            touchPoints: [point(plan.start)],
          })
        : cdp.send("Input.dispatchMouseEvent", {
            type: "mousePressed",
            x: plan.start.x,
            y: plan.start.y,
            button: "left",
            buttons: 1,
            clickCount: 1,
          }));
      pressMs = at();
      cursorSamples.push({ sourceTimeMs: pressMs, ...plan.start });
      const { lead, segment } = heldPath(plan.start, plan.end, actionId);
      for (const p of lead) {
        await move(p);
        cursorSamples.push({ sourceTimeMs: at(), x: p.x, y: p.y });
        await clock.sleep(PATH_STEP_MS);
      }
      // The held path is drawn and paced as `dispatchPath`'s, for its reasons.
      await walkPath(segment, move);
      await clock.sleep(SETTLE_MS);
      await (native
        ? cdp.send("Input.dispatchDragEvent", {
            type: "drop",
            x: plan.end.x,
            y: plan.end.y,
            data: dragData,
          })
        : touch
          ? cdp.send("Input.dispatchTouchEvent", {
              type: "touchEnd",
              touchPoints: [],
            })
          : cdp.send("Input.dispatchMouseEvent", {
              type: "mouseReleased",
              x: plan.end.x,
              y: plan.end.y,
              button: "left",
              buttons: 0,
              clickCount: 1,
            }));
    } catch (error) {
      // Not left on the author's page: the throw is what the run reports.
      await discardClickProbe(cdp, probe);
      throw error;
    } finally {
      offIntercept();
      if (!touch) {
        await cdp
          .send("Input.setInterceptDrags", { enabled: false })
          .catch(() => undefined);
      }
      // A copy left on the page would film over everything after, so its
      // removal is read back and a failure said. A drop that navigated took
      // the copy with its page, and has nothing left to remove.
      if (pictureShown) {
        let left: unknown;
        try {
          left = pictureSays(await onPage(DRAG_PICTURE_REMOVE));
        } catch {
          left = 0;
        }
        if (left !== 0) {
          degradations.push(
            degradation(
              "dragPictureMissing",
              at(),
              at(),
              `a native drag's picture could not be removed after its drop (${String(left)} left on the page)`,
            ),
          );
        }
      }
    }
    const releaseMs = at();
    heldPresses.push({ actionId, pressMs, releaseMs });
    cursor = plan.end;
    const verdict = await readClickProbe(
      verbCdp,
      probe,
      plan.start,
      sightings,
      {
        releasedAt: plan.end,
        touch,
      },
    );
    const seen = await changes();
    // A native drop nothing accepted (final review, finding 3): the page
    // ignored the drag at its end, which is the same fact as `notDragged`.
    if (
      native &&
      verdict.kind === "unconfirmed" &&
      verdict.seen?.cancelled === true &&
      verdict.seen.up === null
    ) {
      const note = `a native drag to (${Math.round(plan.end.x)}, ${Math.round(plan.end.y)}) found nothing there that accepted the drop`;
      degradations.push(degradation("notDragged", pressMs, releaseMs, note));
      ignoredDrags.push({ actionId, note });
    }
    if (verdict.kind === "delivered") {
      if (seen !== null && !seen.changed && !seen.unknown) {
        const note = `the drag from (${Math.round(plan.start.x)}, ${Math.round(plan.start.y)}) to (${Math.round(plan.end.x)}, ${Math.round(plan.end.y)}) reached the page, and nothing on screen between its ends changed`;
        degradations.push(degradation("notDragged", pressMs, releaseMs, note));
        ignoredDrags.push({ actionId, note });
      }
    }
    return verdict;
  };

  /** Both ends of a drag, measured once the start is in view, or why the
   *  drag cannot be begun. */
  const planDrag = async (
    handle: { objectId: string; rect: Rect },
    drag: NonNullable<WalkStep["drag"]>,
  ): Promise<DragPlan | { stop: ReplayStopReason }> => {
    let start = spotIn(handle.rect, drag.fromAt);
    let pressedAt: DragSpot | undefined;
    if (drag.fromAt === undefined) {
      const reply = await cdp.send("Runtime.callFunctionOn", {
        objectId: handle.objectId,
        functionDeclaration: RANGE_READ,
        returnByValue: true,
      });
      const range = (reply.result as { value?: unknown } | undefined)?.value as
        | Parameters<typeof rangeThumb>[1]
        | null
        | undefined;
      if (range !== null && range !== undefined) {
        start = rangeThumb(handle.rect, range);
        const { x, y, width, height } = handle.rect;
        const part = (v: number, size: number) =>
          size > 0 ? Math.min(1, Math.max(0, v / size)) : 0.5;
        pressedAt = {
          x: part(start.x - x, width),
          y: part(start.y - y, height),
        };
      }
    }
    let endRect: Rect | null = null;
    if (!("by" in drag.to)) {
      // A take whose drag names an end anchor it does not hold.
      if (drag.end === null) return { stop: "unresolvedAnchor" };
      const located = await locate(drag.end);
      if (located.handle === null) {
        return { stop: stopForResolveFailure(located.failureReason) };
      }
      endRect = located.handle.rect;
    }
    const end = dragEndPoint(start, drag.to, endRect);
    if (end === null) return { stop: "unresolvedAnchor" };
    endRect ??= { x: end.x, y: end.y, width: 0, height: 0 };
    if (!inViewport(start, viewport) || !inViewport(end, viewport)) {
      return { stop: "dragEndOutOfView" };
    }
    // Under `CLICK_DRIFT_PX` twice over, the release lands where the press
    // did: a click (final review, finding 2).
    if (Math.hypot(end.x - start.x, end.y - start.y) < 2 * CLICK_DRIFT_PX) {
      return { stop: "dragNoDistance" };
    }
    drag.onEnd?.(endRect, pressedAt);
    return { start, end, endRect };
  };

  /**
   * Wait for the page to finish painting what it already has, then say
   * whether it did.
   *
   * The control flow is forgiven and the reason is not: a page that never
   * settles is still harvested, because a slow image must not cost the author
   * their take, but the bundle carries a note saying the frames may be
   * half-drawn — the note this answers, which the caller records (or, in a
   * `waitForLoad` whose page was replaced mid-settle, drops with that page). Silence here would hand back exactly the opening frame this
   * exists to prevent, with nothing to say it had happened.
   *
   * A reply this cannot read counts as unsettled. The probe's own answer is
   * the only evidence there is, and reading an unreadable one as success is
   * the shape that lets a broken probe report a settled page forever.
   */
  const settlePaint = async (): Promise<Degradation | null> => {
    let reply: Record<string, unknown>;
    try {
      reply = await answered(
        cdp.send(
          "Runtime.evaluate",
          {
            expression: settlePaintExpression(SETTLE_PAINT_TIMEOUT_MS),
            awaitPromise: true,
            returnByValue: true,
          },
          heldProbe,
        ),
        SETTLE_PAINT_TIMEOUT_MS + SETTLE_QUIET_TIMEOUT_MS + PROBE_GRACE_MS,
      );
    } catch (error) {
      // A page that navigates out from under an in-flight evaluate destroys
      // the context it was running in, and CDP reports that as a rejection.
      // Every other failed call in this region stops the run, and that is the
      // wrong trade here: the take carries on against whatever document
      // replaced this one, and the only thing genuinely lost is the wait.
      return degradation(
        "pageNeverSettled",
        at(),
        at(),
        `the page-settle probe failed (${describeSettleError(error)})`,
      );
    }
    const report = (reply.result as { value?: unknown } | undefined)?.value as
      | Partial<SettleReport>
      | undefined;

    if (report === undefined || typeof report.settled !== "boolean") {
      return degradation(
        "pageNeverSettled",
        at(),
        at(),
        "the page-settle probe answered with nothing this could read",
      );
    }
    if (!report.settled) {
      const pending = typeof report.pending === "number" ? report.pending : -1;
      // `readyState` and the count are two different faults: a page whose
      // markup never finished arriving has no images to be outstanding, and
      // `0 image(s) outstanding` on its own reads as though nothing was
      // wrong. Both go in the note so it says which one it was.
      const ready = typeof report.ready === "string" ? report.ready : "unknown";
      // And the third: parsed, every picture in, and the document still
      // changing — an app drawing its own loading state. The two numbers
      // above read "nothing wrong" for exactly that page, so it gets its own
      // words. Only `false` says it: a reply without the field is a probe
      // this cannot read, and that is the message below, not this one.
      if (ready === "complete" && pending === 0 && report.quiet === false) {
        return degradation(
          "pageNeverSettled",
          at(),
          at(),
          `page still changing after ${SETTLE_QUIET_TIMEOUT_MS}ms — its images were in, but the document had not gone ${SETTLE_QUIET_MS}ms without a DOM mutation (a loading bar, an app still connecting, or a page that animates by script)`,
        );
      }
      return degradation(
        "pageNeverSettled",
        at(),
        at(),
        `page still loading after ${SETTLE_PAINT_TIMEOUT_MS}ms (readyState ${ready}, ${pending} image(s) outstanding)`,
      );
    }
    // Settled, but the fonts did not arrive: the text in the frames is drawn
    // in a fallback face. Not a reason to stop, and not a reason to be quiet.
    const fonts = report.fonts;
    if (typeof fonts === "string" && fonts !== "ok") {
      return degradation(
        "pageNeverSettled",
        at(),
        at(),
        `page settled but its fonts did not (${fonts})`,
      );
    }
    return null;
  };

  const awaitConditionNow = async (
    action: SceneAction,
    target: AnchorIntent | null,
  ): Promise<boolean> => {
    const deadline = at() + WAIT_TIMEOUT_MS;
    while (at() < deadline) {
      if (action.kind === "waitFor" && action.anchorId === null) {
        // Not on a read that a navigation overtook: `complete` was then said
        // by the page this wait exists to leave (`topLoading`, above). A load
        // that began during the read or the settle after it has bumped the
        // count — Wikipedia's shape, where the read went out a millisecond
        // after the click. Nor while the top document is loading, which no
        // test pins: measured on Chromium (2026-10-13), a read sent once a
        // load is under way does not answer until the new document commits,
        // and then answers for it, so the window this closes is the first
        // few milliseconds of a load. Skipping a read costs one poll.
        const seenBefore = navigationsSeen;
        const state = loading()
          ? undefined
          : ((
              await cdp.send("Runtime.evaluate", {
                expression: "document.readyState",
              })
            ).result as { value?: string } | undefined);
        if (state?.value === "complete") {
          // A click that navigates lands the take on a second document, and
          // it arrives exactly as unfinished as the first one did.
          const unsettled = await settlePaint();
          if (navigationsSeen === seenBefore) {
            if (unsettled !== null) degradations.push(unsettled);
            return true;
          }
          // Otherwise what the settle had to say was about the page being
          // left — most often that it went away mid-probe — and the wait
          // goes on to settle the one that replaced it, whose word is the
          // one recorded. Kept, it read as the take's page never settling
          // in runs where it did (Wikipedia, 2026-10-13).
        }
      } else if (action.anchorId !== null) {
        const { handle } = await locate(target, "seen");
        const wantVisible =
          action.kind !== "waitFor" || action.condition !== "hidden";
        if (wantVisible === (handle !== null)) return true;
      }
      await clock.sleep(WAIT_POLL_MS);
    }
    return false;
  };
  const awaitCondition = (
    ...asked: Parameters<typeof awaitConditionNow>
  ): Promise<boolean> => waitingOn(() => awaitConditionNow(...asked));

  // Everything from here to the loop's end talks to the world through a
  // port, and any of those calls can reject — a detached debugger, a closed
  // window, a store write that failed. Invariant 5 says a run that stops
  // early still returns a valid bundle with an outcome and a reason, and an
  // exception escaping `runReplay` returns nothing at all: no counters, no
  // reason, listeners still attached and a screencast still running. So the
  // throw becomes a *reported* stop, and teardown happens either way.
  let failureNote: string | null = null;
  let pressMarked = false;
  // The step that was marked and then did not happen loses its marker and
  // anchor rect, and its keyframe stays as a picture of the page but no
  // longer claims the step (a tagged frame is what a marker's still is found
  // by). The take's own log never received it.
  const unmarkInFlight = (): void => {
    if (inFlight === null) return;
    const id = inFlight;
    for (let i = markers.length - 1; i >= 0; i--) {
      if (markers[i]?.actionId === id) markers.splice(i, 1);
    }
    for (let i = anchorRects.length - 1; i >= 0; i--) {
      if (anchorRects[i]?.actionId === id) anchorRects.splice(i, 1);
    }
    // A drag taken back held no press the film should draw or hold for.
    for (let i = heldPresses.length - 1; i >= 0; i--) {
      if (heldPresses[i]?.actionId === id) heldPresses.splice(i, 1);
    }
    for (const k of keyframes) if (k.actionId === id) k.actionId = null;
    inFlight = null;
  };
  /**
   * Before a click that waits: let the pending act finish painting, within
   * `ACT_CEILING_MS` of its verb, then settle it. Answers the time spent,
   * which is room the replay added — 0 when it never slept, not the clock's
   * movement across this bookkeeping: on `Date.now()` a millisecond tick
   * there read as 1 ms of room before a click that had plenty (task 13,
   * 2026-10-31). Whether it waited is whether it slept, and any wait is at
   * least one 50 ms sleep, so the answer cannot jitter across 0.
   */
  const quietThenFinalize = async (): Promise<number> => {
    const from = at();
    const act = pendingAct;
    let slept = false;
    if (act !== null) {
      const ceiling = act.verbEndMs + ACT_CEILING_MS;
      while (recorder?.isOpen() && at() < ceiling) {
        slept = true;
        await clock.sleep(50);
      }
    }
    finalizeAct();
    return slept ? at() - from : 0;
  };
  /**
   * Settle the pending act onto its marker: the verb's end, or the last
   * frame of real motion after it, within `ACT_CEILING_MS` (`actEndOf`).
   * A marker the walk has since taken back (`unmarkInFlight`) gets nothing:
   * that step did not happen, and the stop reason already says why.
   */
  const finalizeAct = (): void => {
    const act = pendingAct;
    pendingAct = null;
    if (act === null || !markers.includes(act.marker)) return;
    const end = actEndOf(act.verbEndMs, recorder?.lastMotionMs() ?? null);
    act.marker.actEndSourceTimeMs = end;
    latestActEnd = Math.max(latestActEnd ?? end, end);
  };
  /**
   * What the page said about the click a verb just made (`click-probe.ts`),
   * acted on. True when the run stops here.
   *
   * A `click` whose release went elsewhere did nothing to its target, so the
   * run stops as `clickNotDelivered` rather than go on to report the step,
   * and every step after it, as done. A `type` is judged by what it needs
   * from its click — the field focused — because the press alone focuses it:
   * a release that went astray there costs nothing on screen, so it is said
   * and the typing goes on, and only a field left unfocused stops the run.
   * A click the page could not vouch for either way is said, never counted
   * as a miss and never as a hit.
   */
  const clickStopped = (
    kind: SceneAction["kind"],
    verdict: ClickVerdict | null,
  ): boolean => {
    if (verdict === null || verdict.kind === "delivered") return false;
    // Named by the verb, not numbered: the walk's count of steps is not the
    // script's (a `pause` makes no step here), and the report names the step
    // from its own records — `stopped.at` for a stop, `unconfirmedClicks`'
    // action id for the rest.
    // `inFlight` is this step's action: marked, not yet counted.
    const actionId = inFlight ?? "";
    const subject =
      kind === "click"
        ? "the click"
        : kind === "drag"
          ? "the drag"
          : `the ${kind}'s click`;
    const said = (note: string): void => {
      degradations.push(degradation("clickUnconfirmed", at(), at(), note));
      unconfirmedClicks.push({ actionId, note });
    };
    // A `type` is judged by its field's focus whatever the events said: the
    // keys go wherever focus is, and `performVerb` typed nothing into a field
    // that did not hold it. Only a page that never answered leaves focus
    // unknown, and then the typing went on and the click is said.
    if (kind === "type" && verdict.seen !== undefined) {
      if (verdict.seen.focused) {
        said(
          `${subject}: ${verdict.why}; the field holds focus, so the text still went in`,
        );
        return false;
      }
      reason = "clickNotDelivered";
      failureNote =
        verdict.kind === "misdelivered"
          ? `${subject} was ${verdict.why}, so the page never saw a click on its target and nothing was typed`
          : `${subject} could not be confirmed (${verdict.why}) and ${TYPE_FIELD_UNFOCUSED}, so nothing was typed`;
      unmarkInFlight();
      return true;
    }
    if (verdict.kind === "unconfirmed") {
      said(`${subject}: ${verdict.why}`);
      return false;
    }
    reason = "clickNotDelivered";
    failureNote = `${subject} was ${verdict.why}, so the page never saw a click on its target`;
    unmarkInFlight();
    return true;
  };
  try {
    // --- setup -----------------------------------------------------------
    await cdp.send("Page.enable");
    await cdp.send("DOM.enable");
    // Disable first, and this is not defensive tidying. `Runtime.enable`
    // replays the execution contexts that already exist only on the FIRST
    // enable — measured against Chromium: six contexts, then zero. On a
    // session a previous run already enabled, the handler above would
    // therefore hear nothing, `contexts` would stay empty, and every
    // cross-frame anchor would fail for want of a context id. Re-replay after
    // an edit is a product feature, and a runner reusing one session would
    // have got a replay that worked exactly once, degrading into the same
    // "element not found" that a genuinely missing element reports.
    await cdp.send("Runtime.disable");
    await cdp.send("Runtime.enable");
    // What each click's listeners report as the events arrive, for a click
    // whose page goes away before it can be read (`click-probe.ts`).
    await sightings.install();
    // Touch and the user agent too, for a device: before the navigation that
    // `install()` below performs, so the page loads as the phone it is filmed
    // as. A refusal stops the run as `deviceFailed` — never the desktop.
    if (device === null) await applyMetrics();
    else await applyDevice(cdp, device);
    await cdp.send("Page.setWebLifecycleState", { state: "active" });
    await cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true });
    // The screencast, for the life of the run — not per span. Chrome exempts
    // a page under active capture from occlusion throttling, so a covered or
    // backgrounded stage keeps painting and keeps reporting visible for the
    // whole run; started per span, the exemption lapsed between spans and
    // occlusionTimeout took four of ten real runs
    // (2026-08-31-continuous-capture-design.md). Before `install()` below,
    // so the exemption already covers the navigation it triggers. Frames
    // that arrive with no span open are acked and discarded by the intake.
    // Held: the held clock captures every frame itself.
    if (held === undefined) {
      await cdp.send("Page.startScreencast", {
        format: "jpeg",
        quality: 80,
        everyNthFrame: 1,
      });
    }
    // Before `install()`'s navigation, so a request the first page makes is
    // counted. A refusal does not stop the run: every screen says it.
    if (continuous) {
      try {
        tracker = await trackRequests(cdp, at);
      } catch (error) {
        untracked = describeSettleError(error);
      }
    }
    // `install()` is where the navigation happens (see `createNavigatingGuard`),
    // so this is the first moment there is a page to wait for — and the
    // opening keyframe is the very next thing, which is what made a
    // half-drawn page the frame the video opens on.
    // The start navigation is the load a step-0 `waitForLoad` waits for, so
    // the count that step compares against is taken before it.
    const navsBeforeStart = navigationsSeen;
    await waitingOn(async () => deps.occlusion?.install());
    const unsettled = await waitingOn(settlePaint);
    if (unsettled !== null) degradations.push(unsettled);

    // Before the opening keyframe, so a sign-in page the app redirected to
    // is never filmed (launch C). Frames that arrived so far had no span
    // open and were discarded by the intake.
    const { landing } = deps;
    const signedOut = landing === undefined ? null : await waitingOn(landing);
    if (signedOut !== null) {
      reason = "signedOut";
      failureNote = signedOut;
    } else {
      // Held: the opening still is the take's first frame, one frame in,
      // and the opening rest is played from it.
      filing = true;
      if (held !== undefined) await clock.sleep(HELD_FRAME_MS);
      await shot(null);
      if (heldPlan) heldActEnd = at();
      filming = true;
      if (continuous) await settleAndCapture(0, null);
    }

    navsAtThisStep = navsBeforeStart;
    // --- the loop ----------------------------------------------------------
    for await (const step of signedOut === null ? source.steps() : NO_STEPS) {
      navsAtPreviousStep = navsAtThisStep;
      navsAtThisStep = navigationsSeen;
      pausedSinceCounted += step.pauseMs ?? 0;
      const stepStartedAt = at();
      // Unhurried beats: any step but a click begins at once, and the act
      // it follows ends where the page has got to. A click settles it once
      // it knows whether it will wait (below).
      if (room !== undefined && step.action.kind !== "click") finalizeAct();
      const pausesBefore = deps.occlusion?.pauses() ?? 0;
      const checkedAt = at();
      if (
        deps.occlusion !== undefined &&
        !(await deps.occlusion.ensureVisible())
      ) {
        reason = "occlusionTimeout";
        degradations.push(
          degradation(
            "occlusionPause",
            at(),
            at(),
            "replay window never became visible again",
          ),
        );
        break;
      }
      // A pause the run recovered from was counted and nothing else, so a
      // real-time film would play the frozen stretch as if it were the take.
      // Recorded with its range so the timeline can remove exactly it.
      if (
        deps.occlusion !== undefined &&
        deps.occlusion.pauses() > pausesBefore
      ) {
        const resumedAt = at();
        // From the last beat, not the check: the page stopped painting up
        // to HEARTBEAT_STALL_MS before anything asked, possibly mid-way
        // through the previous step, and those frozen seconds are the pause
        // too (review of 2026-10-03). A guard that cannot say leaves the
        // check as the start.
        const stalledAt = deps.occlusion.stalledSince();
        const pausedFrom =
          stalledAt === null
            ? checkedAt
            : Math.min(checkedAt, Math.max(0, stalledAt - started));
        degradations.push(
          degradation(
            "occlusionPause",
            pausedFrom,
            resumedAt,
            `the replay window was covered for ${((resumedAt - pausedFrom) / 1000).toFixed(1)} s and the run waited for it`,
          ),
        );
      }

      if (step.action.kind === "waitFor") {
        // A held plan plans the wait here and plays its rest before it.
        if (heldPlan) await playRest(planUnplaced(step));
        if (!(await awaitCondition(step.action, step.target))) {
          // Only a wait for something to show can have found it unseen. The
          // resolver's word decides (`waitSawOf`): an element it found with no box
          // (display:none, a closed <details>) is there but not visible. The
          // look is a courtesy to the report, so a page that fails it leaves
          // `waitSaw` unset and the stop stays `waitTimeout`.
          if (
            step.action.anchorId !== null &&
            step.action.condition !== "hidden" &&
            step.target !== null
          ) {
            try {
              const [found] = await page.resolve([step.target]);
              const saw = found === undefined ? undefined : waitSawOf(found);
              if (saw !== undefined) step.onWaitTimedOut?.(saw);
            } catch {
              // Said by absence: no `waitSaw`, so the stop keeps its generic
              // `waitTimeout` sentence rather than claim what was not seen.
            }
          }
          reason = "waitTimeout";
          break;
        }
        if (step.action.anchorId === null) {
          step.onLoadSeen?.(navigationsSeen > navsAtPreviousStep);
        }
        // The instant the condition was met, which is what the marker names —
        // taken before the source's veto, whose own round trip is not part of
        // the wait.
        const metAt = at();
        // The source's last word, before anything below records the wait as
        // done. A refusal here breaks exactly as a timeout does: no marker, no
        // keyframe, not counted — and `for await` closes the source at its
        // `yield`, so the source commits nothing either.
        const refused = (await step.onConditionMet?.()) ?? null;
        if (refused !== null) {
          reason = refused;
          break;
        }
        inFlight = step.action.id;
        const waitMarker: FrameBundle["markers"][number] = {
          actionId: step.action.id,
          sourceTimeMs: metAt,
          // No journey: all of the wait is the rest before it.
          ...(continuous ? { approachSourceTimeMs: metAt } : {}),
        };
        markers.push(waitMarker);
        if (!heldPlan) planUnplaced(step);
        // The picture of what the wait was waiting for.
        //
        // This branch used to mark the beat and take no frame at all, and a
        // `waitFor` is precisely the verb that exists because the page just
        // became something else. So the one instant in the take that is
        // guaranteed to be worth photographing — a navigation finished and
        // settled — was the one instant nothing photographed. The next
        // picture came from the next positioned action, which on a real take
        // is a second or more later, and until then every frame the video
        // could draw was of the page before the click.
        //
        // Measured on the take of 2026-08-30: keyframes at 2883ms (the click,
        // taken before it fires, so the old page) and 3319ms (just after it,
        // so the old page or a blank one), then nothing until 4947ms. The
        // navigation's `waitFor` sat at 3337ms inside that 1.6s hole, and the
        // video held the pre-click frame across the whole of it — "it stays
        // on the same page even though I'm navigating between pages".
        //
        // Tagged with the action's own id, not null: `stillSourceMs` finds a
        // marker's frame by `actionId`, and a marker with no frame of its own
        // falls back to the nearest keyframe at or *before* it, which is the
        // page the wait was waiting to leave.
        await stepStill(step.action.id);
        if (continuous) await settleAndCapture(completed + 1, step.action.id);
        completed++;
        lastCompletedActionId = step.action.id;
        inFlight = null;
        stepFinished(step.action.id, metAt, stepStartedAt);
        commitPlan(step.action);
        // A page that came in goes on painting after the condition holds,
        // and that is the act a later zoom waits for, not the click that
        // set it off (code review 2026-10-20, R1).
        if (room !== undefined) {
          pendingAct = { marker: waitMarker, verbEndMs: metAt };
        }
        heldActEnd = metAt;
        continue;
      }

      /** When the author's rhythm puts this step's marker (see below), or
       *  null where the rhythm does not pace it. */
      const rhythmDue = (): number | null => {
        const lastMarkerAt = markers.at(-1)?.sourceTimeMs;
        return continuous &&
          step.recordedIntervalMs !== undefined &&
          lastMarkerAt !== undefined
          ? lastMarkerAt + step.recordedIntervalMs + pausedSince(lastMarkerAt)
          : null;
      };
      /** The author's rhythm, live, just before a filmed step's marker: a
       *  backwards or repeated timestamp gives a due time already past, and
       *  nothing waits. Measured in the film's time, not the walk's: a
       *  recovered pause since the last marker is removed from a real-time
       *  film, so it is added back here — or the author's 3 s between two
       *  steps plays as 1 s after a 2 s pause (review of 2026-10-03). */
      const keepRhythm = async (): Promise<void> => {
        const due = rhythmDue();
        if (due === null) return;
        const wait = due - at();
        if (wait > 0) await clock.sleep(wait);
        // Listed whether or not anything was left to wait: either way this
        // pair's spacing is the engine's doing, already in source time.
        if (step.pacedGap !== undefined) pacedGaps.push(step.pacedGap);
      };

      if (step.action.kind === "press") {
        // No element: the key goes to whatever holds focus, where the cursor
        // rests. Marked, pictured and counted like any verb.
        const keyAction = step.action;
        await keepRhythm();
        // A held plan plans the key here and plays its rest before it.
        if (heldPlan) await playRest(planUnplaced(step));
        pressMarked = true;
        inFlight = keyAction.id;
        const pressedAt = at();
        const marker: FrameBundle["markers"][number] = {
          actionId: keyAction.id,
          sourceTimeMs: pressedAt,
          // No journey: the key goes where the cursor already rests.
          ...(continuous ? { approachSourceTimeMs: pressedAt } : {}),
        };
        markers.push(marker);
        if (!heldPlan) planUnplaced(step);
        await stepStill(keyAction.id);
        if (!continuous) recorder?.open();
        await gate.section(() => pressKey(cdp, keyAction.key));
        if (!continuous) {
          await recorder?.close();
          await shot(null);
        }
        stillOwed = true;
        verbs++;
        if (room !== undefined) pendingAct = { marker, verbEndMs: at() };
        if (heldPlan) heldActEnd = at();
        if (continuous) await settleAndCapture(completed + 1, keyAction.id);
        completed++;
        lastCompletedActionId = keyAction.id;
        inFlight = null;
        stepFinished(keyAction.id, marker.sourceTimeMs, stepStartedAt);
        commitPlan(keyAction);
        deps.onProgress?.({
          step: completed,
          total,
          keyframes: keyframes.length,
          state: "running",
          note: null,
        });
        continue;
      }

      const located = await locate(step.target);
      // The approach is part of the take, so it is recorded. The span opens
      // BEFORE the scroll and closes after it, and it is a span of its own
      // rather than the one the verb runs in: that keeps the beat's marker
      // keyframe between the two, at full resolution, exactly where it was.
      //
      // An approach that scrolls nothing — the ordinary case for a target
      // already on screen — paints nothing, collects no frames, and is
      // discarded by `SPAN_MIN_FRAMES`. Nothing to show costs nothing.
      // `scrollTo` is the verb whose whole point is the travel, so the
      // approach performs it in full and `performVerb` has nothing left to
      // do. Any other verb gets the shortest scroll that puts the target on
      // screen.
      const aim: ScrollAim =
        VERBS[step.action.kind].approach === "landing"
          ? scrollAimOf(step, located.handle?.rect ?? null)
          : "nearest";
      // Only where there is travel to show. See `scrollWillMove`.
      // Continuous recording keeps the scroll anyway; only sampled mode
      // opens a span for it.
      const scrolls =
        located.handle !== null &&
        scrollWillMove(located.handle.rect, viewport, aim);
      const record = !continuous && scrolls;
      // Unhurried beats. `roomHere` is every ms the walk adds before this
      // step; `heldHere` the longest single hold among them, the part the
      // film check may take for Demoman's own pacing.
      let roomHere = 0;
      let heldHere = 0;
      const unhurriedScroll =
        room !== undefined && step.action.kind === "click" && scrolls;
      // The first wait: a click whose approach scrolls lets the last act's
      // result settle before the page moves under it.
      if (unhurriedScroll) {
        // The scroll paints, so the act it follows is settled first.
        roomHere += await quietThenFinalize();
        if (latestActEnd !== null) {
          const settleFor = latestActEnd + CAMERA_DEFAULTS.actSettleMs - at();
          // A held plan plays its rest instead, which the renderer gives this idle.
          if (settleFor > 0 && !heldPlan) {
            await clock.sleep(settleFor);
            roomHere += settleFor;
            heldHere = Math.max(heldHere, settleFor);
          }
        }
      }
      // A held plan decides a scrolled step's rest once, here, and plays it
      // before the scroll, where the renderer's rest ends. It is the base,
      // whatever the journey: the camera's room goes after the scroll.
      const restBeforeScroll =
        heldPlan && scrolls && beats !== undefined
          ? beats.restBefore({
              first: plannedBeats.length === 0,
              pauseMs: step.pauseMs ?? 0,
              roomMs: 0,
              journeyMs: 0,
            })
          : null;
      if (restBeforeScroll !== null) {
        await playRest(restBeforeScroll);
      }
      if (record) recorder?.open();
      // Scroll the target on screen, then re-measure: the quad is
      // viewport-relative, so the rect from before the scroll is stale by
      // definition. An element that vanished between the two reports the same
      // thing a missing one does, which is the honest answer either way.
      const handle =
        located.handle === null
          ? null
          : await bringIntoView(located.handle, aim);
      if (record) await recorder?.close();
      if (handle === null) {
        reason = stopForResolveFailure(located.failureReason);
        break;
      }
      // Where the approach scroll ended, for the marker: the renderer plays
      // the beat's `afterScrollMs` from here (spec 2026-11-13 Part 3).
      const scrollEndAt = continuous && scrolls ? at() : undefined;
      // The scroll moved the page under the camera too: the camera's room
      // is measured from its last paint (code review 2026-10-20, R7).
      if (unhurriedScroll) {
        const end = at();
        latestActEnd = Math.max(latestActEnd ?? end, end);
      }

      // What resolution measured, back to the source, at the one moment the
      // rect is final: the approach has re-measured it and nothing has been
      // dispatched at it yet. `report` is non-null on exactly the path that
      // produced a handle — the cast is that invariant, which the checker
      // cannot follow through the re-measure, the same way `anchorId` is
      // cast below. A document source has no `onResolved` and pays nothing.
      if (step.onResolved !== undefined)
        await step.onResolved(handle.rect, located.report as ResolveReport);

      const text = step.text;
      if (text === REDACTED_WITHOUT_REPLACEMENT) {
        reason = "redactedWithoutReplacement";
        break;
      }
      let dragPlan: DragPlan | null = null;
      if (step.action.kind === "drag") {
        if (step.drag === undefined) {
          throw new Error("the walk was handed a drag with no ends");
        }
        const planned = await planDrag(handle, step.drag);
        if ("stop" in planned) {
          reason = planned.stop;
          break;
        }
        dragPlan = planned;
      }

      const segment = step.segment;
      /** Where this step's verb lands in the box: a click's spot, else the centre. */
      const clickPoint = (rect: Rect): { x: number; y: number } =>
        spotIn(rect, step.action.kind === "click" ? step.action.at : undefined);
      // Unhurried beats, the second wait: before a click the camera will
      // zoom to, rest until the camera has room to set off after the last
      // act has settled. The cursor's journey and SETTLE_MS still to come
      // count toward it. Whether it zooms is asked on time with every room
      // added taken out, so a wait never makes a zoom the take would not
      // have had. A drag is asked too, for the policy's record of the last
      // zoom (`zoomsForClicks` zooms drags), framed by its two points as the
      // take's zoom is; it waits for no room, because the camera holds
      // through the drag instead (`solveCamera`'s holds).
      let zoomedClick = false;
      let zoomedDrag = false;
      // The journey the walk will make, not the source's plan: from where
      // the cursor is to the target as measured after the approach scroll
      // (`dispatchPath` retargets the same way). The plan is longer for a
      // target scrolled to, and nothing at all for one the cursor is on.
      const journeyMs =
        segment === undefined
          ? 0
          : retargetSegment(
              segment,
              cursor,
              dragPlan?.start ?? clickPoint(handle.rect),
            ).durationMs;
      // The beat plan: this step's rest and marker on the designed clock,
      // first with no room for it (what the camera's questions are asked
      // of, as the live path asks them with the room taken out).
      const restWith = (roomMs: number, returnShortMs = 0): number =>
        beats === undefined
          ? 0
          : beats.restBefore({
              first: plannedBeats.length === 0,
              pauseMs: step.pauseMs ?? 0,
              roomMs,
              journeyMs,
              returnShortMs,
            });
      const arriveMs = beats?.arriveMs ?? 0;
      // A step the approach scrolled to rests again after the scroll, where
      // the designed clock adds it beside the rest: an arrive's worth, or
      // the camera's room for a zoomed click (below). The scroll itself is
      // motion and is not on the designed clock.
      const scrolledTo = beats !== undefined && scrollEndAt !== undefined;
      let afterScrollMs =
        beats !== undefined && scrolledTo
          ? beats.afterScroll({ zooms: false, roomMs: 0, journeyMs })
          : 0;
      const designedAt = (restMs: number): number =>
        designed + restMs + afterScrollMs + journeyMs + arriveMs;
      let restMs = restBeforeScroll ?? restWith(0);
      const unroomedMs = designedAt(restMs);
      // Whether it zooms is asked with every room taken out, earlier steps'
      // too: `designed` holds theirs, and left in, a click 900 ms after a
      // zoom that was given a return's room read as 2 s after it and zoomed
      // where the gap rule skips it (code review, 2026-11-14).
      const askedMs = unroomedMs - designedRoom;
      let roomMs = 0;
      // Reached by a scroll, the camera needs its room after the page
      // moved: the rest keeps its base and the room goes after it.
      const planRoom = (returnShortMs: number): void => {
        if (beats === undefined) return;
        if (scrolledTo) {
          afterScrollMs = beats.afterScroll({
            zooms: true,
            roomMs,
            journeyMs,
            returnShortMs,
          });
        } else {
          restMs = restWith(roomMs, returnShortMs);
        }
      };
      if (
        room !== undefined &&
        (step.action.kind === "click" || dragPlan !== null)
      ) {
        const ahead = journeyMs + SETTLE_MS;
        const scale = viewportTransforms.at(-1)?.scale ?? 1;
        const unwaitedMs = at() + ahead - roomAdded - roomHere;
        decided.set(
          step.action.id,
          beats === undefined
            ? { unwaitedMs, scale }
            : { designedMs: askedMs, scale },
        );
        const zooms = room.zooms({
          actionId: step.action.id,
          anchorId: step.action.anchorId as string,
          rect:
            dragPlan === null
              ? handle.rect
              : {
                  x: Math.min(dragPlan.start.x, dragPlan.end.x),
                  y: Math.min(dragPlan.start.y, dragPlan.end.y),
                  width: Math.abs(dragPlan.end.x - dragPlan.start.x),
                  height: Math.abs(dragPlan.end.y - dragPlan.start.y),
                },
          unwaitedMs: beats === undefined ? unwaitedMs : askedMs,
          scale,
        });
        if (zooms && dragPlan === null && beats !== undefined) {
          // The act before still finishes painting (a settle, which stays).
          // The room is planned, not waited: it goes into the designed rest
          // and the renderer plays it, the idle frames being the same. Asked
          // of the designed act end before it, which `designed` is.
          roomHere += await quietThenFinalize();
          if (plannedBeats.length > 0) {
            roomMs = room.neededMs({
              heldUntilMs: designedHeldUntil,
              clickMs: unroomedMs,
            });
            planRoom(0);
          }
          const arrives = room.arrives({
            heldUntilMs: designedHeldUntil,
            clickMs: designedAt(restMs),
          });
          // A return is the camera's record under a plan, so it is planned a
          // whole one with the policy's margin. Added rest only widens the
          // gap, so the answer stays "return".
          const returnShortMs =
            arrives === "return"
              ? room.returnShortMs({
                  heldUntilMs: designedHeldUntil,
                  clickMs: designedAt(restMs),
                })
              : 0;
          if (returnShortMs > 0) planRoom(returnShortMs);
          decided.set(step.action.id, {
            designedMs: askedMs,
            scale,
            arrives,
          });
          zoomedClick = true;
        } else if (zooms && dragPlan === null) {
          roomHere += await quietThenFinalize();
          if (latestActEnd !== null) {
            // Asked of the click where it will land: after the journey and
            // `SETTLE_MS`, or where the author's rhythm holds it, whichever
            // is later (that wait comes after this one). None is added for a
            // pan, and room added for a return only widens the gap, which
            // never makes a pan.
            const needed = room.neededMs({
              heldUntilMs: lastHeldUntil,
              clickMs: Math.max(at() + ahead, rhythmDue() ?? 0),
            });
            const short = latestActEnd + needed - (at() + ahead);
            if (short > 0) {
              await clock.sleep(short);
              roomHere += short;
              heldHere = Math.max(heldHere, short);
            }
          }
          zoomedClick = true;
        } else {
          finalizeAct();
          if (zooms && beats !== undefined) {
            // A zoomed drag: the camera's arrival is decided here too, or
            // the renderer would decide it from the rendered gap, which a
            // machine's own motion moves. No push-in room is planned (the
            // camera holds through the drag); a return gets its margin, so
            // it is a whole one on any machine.
            const arrives = room.arrives({
              heldUntilMs: designedHeldUntil,
              clickMs: designedAt(restMs),
            });
            const returnShortMs =
              arrives === "return"
                ? room.returnShortMs({
                    heldUntilMs: designedHeldUntil,
                    clickMs: designedAt(restMs),
                  })
                : 0;
            if (returnShortMs > 0) planRoom(returnShortMs);
            decided.set(step.action.id, {
              designedMs: askedMs,
              scale,
              arrives,
            });
          }
        }
        zoomedDrag = zooms && dragPlan !== null;
      }
      roomAdded += roomHere;
      // A held plan plays the rest here (or, for a scrolled step, the
      // after-scroll: its rest was played before the scroll), decided above;
      // the arrive below replaces the settle.
      if (heldPlan) {
        if (restBeforeScroll === null) await playRest(restMs);
        else await playRest(afterScrollMs, scrollEndAt ?? at());
      }
      const pathFrom = at();
      if (segment !== undefined) {
        await gate.section(() =>
          dispatchPath(segment, dragPlan?.start ?? clickPoint(handle.rect)),
        );
      }

      // SP1 §5: a tooltip lands ~275 ms after the path does. Harvesting before
      // that gives a keyframe with the hover UI missing from it.
      await clock.sleep(heldPlan ? arriveMs : SETTLE_MS);
      if (
        continuous &&
        step.action.kind === "moveTo" &&
        segment !== undefined
      ) {
        moveToWindows.push({ startMs: pathFrom, endMs: at() });
      }

      await keepRhythm();

      inFlight = step.action.id;
      anchorRects.push({
        actionId: step.action.id,
        anchorId: step.action.anchorId as string,
        rect: handle.rect,
        ...(dragPlan === null ? {} : { end: dragPlan.endRect }),
      });
      const markedAt = at();
      const marker: FrameBundle["markers"][number] = {
        actionId: step.action.id,
        sourceTimeMs: markedAt,
        ...(continuous ? { approachSourceTimeMs: pathFrom } : {}),
        ...(scrollEndAt === undefined
          ? {}
          : { scrollEndSourceTimeMs: scrollEndAt }),
        // Under a plan nothing was waited for the camera: its room is in the
        // planned rest, and the waits counted here are settles.
        ...(beats === undefined && roomHere > 0
          ? { roomMs: Math.round(roomHere) }
          : {}),
        ...(beats === undefined && heldHere > 0
          ? { roomHeldMs: Math.round(heldHere) }
          : {}),
      };
      markers.push(marker);
      if (beats !== undefined) {
        stepPlan = {
          beat: {
            beforeActionId: step.action.id,
            restMs,
            arriveMs,
            ...(scrolledTo ? { afterScrollMs } : {}),
          },
          markerMs: designedAt(restMs),
          roomMs: designedAt(restMs) - unroomedMs,
          zoomed: zoomedClick || zoomedDrag,
        };
      }
      if (zoomedClick || zoomedDrag) {
        lastZoom = {
          actionMs: markedAt,
          arrivalMs: markedAt + CAMERA_DEFAULTS.leadInMs,
        };
      }
      if (zoomedClick) lastHeldUntil = lastZoom?.arrivalMs ?? null;
      await stepStill(step.action.id);

      if (continuous) {
        // No span to open and no still to take after the verb: the recorder
        // keeps whatever the page paints, and a settled still follows once
        // it stops. The hover question is answered after teardown, below.
        const clicked = await gate.section(() =>
          dragPlan !== null
            ? performDrag(
                step.action.id,
                dragPlan,
                handle.objectId,
                device?.touch === true,
              )
            : performVerb(
                step.action,
                text,
                verbCdp,
                cursor,
                device?.touch === true,
                handle.objectId,
                sightings,
                clock.sleep,
                step.onFieldRead,
                step.onLastKeyUnpainted,
              ),
        );
        // The page may now look different however little it painted: the
        // next quiet earns a still, blip or not.
        stillOwed = true;
        verbs++;
        if (clickStopped(step.action.kind, clicked)) break;
        if (room !== undefined) pendingAct = { marker, verbEndMs: at() };
        if (heldPlan) heldActEnd = at();
        // A drag holds the zoom it is pressed in until it lets go, zoomed or
        // not: the camera's `heldUntilOf` — pressed after the zoom's action
        // and before it would start back out.
        if (
          dragPlan !== null &&
          lastZoom !== null &&
          markedAt >= lastZoom.actionMs &&
          markedAt < lastZoom.arrivalMs + CAMERA_DEFAULTS.neutral.zoomHoldMs
        ) {
          lastHeldUntil = Math.max(lastHeldUntil ?? at(), at());
        }
        // From the marker, where the sampled check's span opened, to the
        // verb's end.
        if (step.action.kind === "moveTo") {
          moveToWindows.push({ startMs: markedAt, endMs: at() });
        }
      } else {
        recorder?.open();
        const clicked = await gate.section(() =>
          dragPlan !== null
            ? performDrag(
                step.action.id,
                dragPlan,
                handle.objectId,
                device?.touch === true,
              )
            : performVerb(
                step.action,
                text,
                verbCdp,
                cursor,
                device?.touch === true,
                handle.objectId,
                sightings,
                clock.sleep,
                step.onFieldRead,
                step.onLastKeyUnpainted,
              ),
        );
        const spansBefore = motionSpans.length;
        await recorder?.close();
        if (clickStopped(step.action.kind, clicked)) break;
        // v9: "did any DOM mutation follow a pure moveTo span?" A hover that
        // changed the page repaints, and a repaint is exactly what the
        // screencast reports — so the span that already exists answers the
        // question, and no second mechanism is needed. Set true, never false:
        // capture may have seen sensitivity this particular run did not
        // reproduce.
        if (step.action.kind === "moveTo" && motionSpans.length > spansBefore) {
          hoverSensitive = true;
        }
        await shot(null);
      }

      // After the verb's result and before the next step's glide, whose
      // `mouseMoved` events would change the page's hover state.
      if (continuous)
        await settleAndCapture(completed + 1, step.action.id, true);
      completed++;
      lastCompletedActionId = step.action.id;
      inFlight = null;
      stepFinished(step.action.id, markedAt, stepStartedAt);
      commitPlan(step.action);
      deps.onProgress?.({
        step: completed,
        total,
        keyframes: keyframes.length,
        state: "running",
        note: null,
      });
    }

    // Continuous only: the closing still. The last step's own paint lands
    // after its verb returns, and the `finally` below stops listening for
    // frames, so no settled still would ever follow it — a run ending on a
    // `type` filed nothing showing the text (2026-10-03). Give the paint one
    // quiet window to arrive, let any span it opened close, and photograph
    // the result. Taken however the loop ended: a stopped run's last good
    // state is worth a frame too.
    // Not after an occlusion timeout: the heartbeat says nothing is driving
    // the page any more, and a screenshot of it has no deadline.
    if (continuous && reason !== "occlusionTimeout" && reason !== "signedOut") {
      // A finished take runs on for `TAKE_TAIL_MS` after its last action,
      // and past its last zoom's pull-out, or the camera's own end clamp
      // cuts that move off mid-way (spec 2026-10-30 F). Whatever the script
      // slept after it is already on the clock.
      const lastMarkerAt = markers.at(-1)?.sourceTimeMs;
      if (reason === null && lastMarkerAt !== undefined) {
        const settledAt =
          room !== undefined && lastHeldUntil !== null
            ? room.settledAfterMs(lastHeldUntil)
            : Number.NEGATIVE_INFINITY;
        // The script's end trim, which needs at least its own `ms` filmed
        // after the last step's finish (or its zoom-out) to have it to keep.
        const asked =
          config.tail === undefined || lastFinishAt === null
            ? Number.NEGATIVE_INFINITY
            : (config.tail.after === "zoomOut"
                ? Math.max(lastFinishAt, settledAt)
                : lastFinishAt) + config.tail.ms;
        // A zoom held through the cut (`heldEndMs`) is filmed to its end
        // and a settle, or the camera's end clamp would cut its return.
        const held =
          lastHeldEndAt === null
            ? Number.NEGATIVE_INFINITY
            : lastHeldEndAt + SETTLE_MS;
        // Under a plan the pull-out and the trim are in `pacing.tailMs`,
        // played by the renderer: only the floor is recorded. A held plan
        // plays its tail here instead.
        if (beats !== undefined && heldPlan)
          await playRest(plannedTailMs(beats));
        else {
          const tail =
            (beats === undefined
              ? Math.max(lastMarkerAt + TAKE_TAIL_MS, settledAt, asked, held)
              : lastMarkerAt + TAKE_TAIL_MS) - at();
          if (tail > 0) await clock.sleep(tail);
        }
      }
      // Held: no span to let close.
      if (recorder !== null) await clock.sleep(SPAN_QUIET_MS);
      // Bounded: a page that never stops painting (a hero video) reopens a
      // span the moment the last one closes, and an unbounded wait here hung
      // the run (2026-10-03). Past the ceiling the still is of the moving
      // page, which the stream already holds in motion either side of it.
      const giveUpAt = at() + SPAN_MAX_MS;
      while (recorder?.isOpen() && at() < giveUpAt) await clock.sleep(50);
      if (room !== undefined) finalizeAct();
      // Through `settledStill`: a closing still that cannot be taken is a
      // `stillFailed`, said and forgiven — never a port failure that would
      // overwrite the reason the run actually ended with. Not after a still
      // that never answered: the next would only queue behind it.
      //
      // Taken even when a settled still came after the last action. A film
      // ends at its last frame, so skipping this one cut off everything after
      // that still: the author's video of 2026-10-07 stopped 0.42s after its
      // last click, and an 800ms pause the script asked for was not in it. A
      // second picture of an unchanged page costs one frame.
      if (await drainShots()) {
        await settledStill(at());
      }
    }
  } catch (error) {
    // The message can carry page content — a URL, a form value echoed back in
    // an error — so it goes to the live progress channel and not into the
    // bundle or the counters, which outlive the run. What
    // travels is the structured reason.
    reason =
      error instanceof DeviceEmulationError ? "deviceFailed" : "portFailure";
    failureNote = error instanceof Error ? error.message : String(error);
    // The step that threw after it was marked did not happen.
    unmarkInFlight();
  } finally {
    offFrame();
    offContext();
    offNavigated();
    offStarted();
    offStopped();
    // Best-effort, and this swallow (unusually) has nothing it needs to
    // say: the detach that follows in the runner tears the stream down
    // regardless, the frames are already encoded, and a stop the page
    // refuses must not turn a finished run into a failed one.
    if (held === undefined) {
      await cdp.send("Page.stopScreencast").catch(() => undefined);
    }
    tracker?.dispose();
    await recorder?.teardown();
    // Held: what was captured since the last hold, closed once however the
    // run ended. Not forgiven: what it shows would be missing from the video.
    if (heldFrames !== null) {
      try {
        await heldFrames.finish(at());
      } catch (error) {
        reason ??= "portFailure";
        const note = `the held frames could not be closed at ${at()} ms (${describeSettleError(error)})`;
        failureNote = failureNote === null ? note : `${failureNote}; ${note}`;
      }
    }
    // A settled still the last span asked for may still be in the line.
    // Already said if the closing still's drain gave up on it.
    if (!sealed) await drainShots();
    sealed = true;
    await sightings.stop();
    screening.stop();
    answering.stop();
  }

  // Every span has closed now (teardown waited), so the hover check the
  // sampled walk made inline can be made here: a kept span overlapping one
  // of a moveTo's windows (`moveToWindows`), or starting within the quiet
  // window after one, is the page reacting to the pointer — the same
  // evidence the sampled check read.
  // Spans are sorted first because their closes finish in any order.
  if (continuous) {
    motionSpans.sort((a, b) => a.startMs - b.startMs);
    // Held: a hold's still is filed at its first frame, after any step's
    // still taken since.
    if (held !== undefined) {
      keyframes.sort((a, b) => a.sourceTimeMs - b.sourceTimeMs);
    }
    for (const w of moveToWindows) {
      if (
        motionSpans.some(
          (s) => s.endMs >= w.startMs && s.startMs <= w.endMs + SPAN_QUIET_MS,
        )
      ) {
        hoverSensitive = true;
      }
    }
  }

  // Held: what the clock could not hold, each said once.
  if (held !== undefined) {
    // Once each: a playing video is answered by every document that has one.
    const said = new Set<string>();
    for (const u of held.unpinned()) {
      if (said.has(u.what)) continue;
      said.add(u.what);
      const atMs = u.atMs - started;
      degradations.push(degradation("animationUnpinned", atMs, atMs, u.what));
    }
    for (const label of held.ignoredConnections()) {
      degradations.push(degradation("connectionIgnored", 0, at(), label));
    }
    const unpacedAt = held.unpaced();
    if (unpacedAt !== null) {
      const atMs = unpacedAt - started;
      degradations.push(
        degradation(
          "answerUnpaced",
          atMs,
          atMs,
          "an answer was still arriving during a pause, a rest or a step's settle that did not wait for it, which is not paced by the server",
        ),
      );
    }
  }

  counters.completed = completed;
  counters.replayThrough = total === 0 ? 1 : completed / total;
  counters.durationMs = at();
  counters.keyframes = keyframes.length;
  counters.occlusionPauses = deps.occlusion?.pauses() ?? 0;
  counters.occlusionMs = deps.occlusion?.pausedMs() ?? 0;

  // SP6's schema refuses a replay bundle with no cursor samples: inversion
  // only closes when replay hands back what it dispatched, so a sample-less
  // one is a broken seam rather than an empty one. A run with nothing to hand
  // back — a redacted type at the very first action, a port that gave way
  // before the opening shot — reports no bundle rather than fabricating a
  // sample to satisfy the parse. The counters and reason still say how far it
  // got.
  //
  // A scene of nothing but `waitFor` actions lands here having *completed*:
  // it plans no cursor segments, so there is no bundle, and yet the run
  // stopped for no reason at all. It keeps `reason: null`, because a stop
  // reason on a run that reached its last action would simply be a false
  // statement about what happened. (That is now the whole of the argument:
  // `outcome` is derived from `completed === total`, not from `reason`, so
  // inventing one would no longer mislabel the outcome — it would just be
  // untrue.) `bundle === null` is the signal, and `ReplayResult.bundle`
  // documents it.
  //
  // A take of nothing but scrolls is the other case with no samples, and it
  // is not one with nothing to hand back: since the film check (spec
  // 2026-09-30 §1) a scroll leaves the pointer where it is, so the run
  // dispatched no path — and yet it placed every step on film and recorded
  // every pixel of the travel. Gating on samples alone threw all of that
  // away and reported the run complete with `bundle: null`
  // (`replay-scroll.test.ts`: 4723px travelled, no span survived). So a run
  // that put an element's step on film (an `anchorRects` entry: a wait has
  // none, so a wait-only scene is unchanged) keeps its frames, and the
  // schema decides whether the missing samples are honest: it accepts them
  // only when every marked step is of a kind whose cursor does not travel.
  const harvested =
    keyframes.length > 0 &&
    // A key press names no element and moves no cursor, yet it is filmed: its
    // marker is the evidence (a press-only take is a carousel or an Escape).
    (cursorSamples.length > 0 || anchorRects.length > 0 || pressMarked);

  // Assembly and persistence are ports too, and `putBundle` writes to disk —
  // a refused write is the most plausible store failure, since frames are
  // by far the largest thing a run stores. A throw here has to become a reported
  // run like any other rather than an exception where the caller expected a
  // result. The bundle is assigned before it is stored, so a write that fails
  // still hands the caller a valid, renderable bundle.
  let bundle: FrameBundle | null = null;
  let storageRefused = false;
  try {
    if (harvested) {
      bundle = validateBundle({
        bundleVersion: 1,
        sceneId,
        source: "replay",
        ...(continuous ? { timing: "real" as const } : {}),
        ...(held === undefined
          ? {}
          : {
              clock: "held" as const,
              networkSpans: held.networkSpans().map((s) => ({
                ...s,
                startMs: s.startMs - started,
                endMs: s.endMs - started,
              })),
            }),
        ...(pacedGaps.length > 0 ? { pacedGaps } : {}),
        dpr: stillScale,
        viewport,
        keyframes,
        motionSpans,
        cursorSamples,
        cursorGaps: [],
        anchorRects,
        ...(heldPresses.length === 0 ? {} : { heldPresses }),
        ...(pageScreens.length === 0 ? {} : { pageScreens }),
        ...(viewportTransforms.length === 0 ? {} : { viewportTransforms }),
        markers,
        degradations,
        // The log this run was asked to reproduce. What the source yielded is
        // what the run PERFORMED — Task 2 makes that the filtered one — so
        // the record has to come from the full log instead, which the caller
        // supplies. See `EngineDeps.madeFrom`.
        madeFrom: deps.madeFrom,
      } satisfies FrameBundle);
      await store.putBundle(sceneId, bundle);
    }
  } catch (error) {
    // The first stop reason is the one that explains the run. A failure to
    // persist afterwards is a *second* fact about it, not a replacement: a
    // run that timed out waiting and then hit quota stopped because of the
    // wait, and overwriting that with `portFailure` would put back exactly
    // the conflation this round set out to remove. So the reason is only
    // claimed when nothing has claimed it, and the free text — which is the
    // only place the two can both be said — carries the write either way,
    // labelled, and appended rather than substituted.
    // `bundle` is assigned before the write is attempted, so a non-null one
    // here means assembly succeeded and the *store* is what refused — which
    // is the only thing `storageRefused` claims. A throw from `validateBundle`
    // leaves it null: the store was never asked, and counting that as a
    // storage failure would put a false positive into the one signal this
    // flag exists to give.
    if (bundle !== null) storageRefused = true;
    const message = error instanceof Error ? error.message : String(error);
    const note = `bundle not persisted: ${message}`;
    reason ??= "portFailure";
    failureNote = failureNote === null ? note : `${failureNote}; ${note}`;
  }

  if (failureNote !== null) {
    deps.onProgress?.({
      step: completed,
      total,
      keyframes: keyframes.length,
      state: "failed",
      note: failureNote,
    });
  }

  return {
    bundle,
    // How far replay got through the actions, and not whether anything
    // failed — the two came apart when persistence joined the guarded region.
    // `ReplayResult.outcome` carries the contract.
    outcome: replayOutcome(completed, total),
    completed,
    total,
    lastCompletedActionId,
    reason,
    degradations,
    unconfirmedClicks,
    ignoredDrags,
    storageRefused,
    hoverSensitive,
    counters,
    ...(room === undefined ? {} : { decided }),
    // Planned through the last counted step, however the run ended: the
    // tail is that step's, from its designed act end (`designed`).
    // A held plan was played, not handed on.
    ...(beats === undefined || heldPlan
      ? {}
      : {
          pacing: { beats: plannedBeats, tailMs: plannedTailMs(beats) },
        }),
  };
}

/**
 * The verb itself, dispatched at wherever the cursor path ended.
 *
 * No `TargetHandle` any more: every verb here acts through the cursor, and
 * the one that did not — `scrollTo`, which called `scrollIntoView` on the
 * element — has moved into the approach. Keeping the parameter for a caller
 * that no longer needs it would be an invitation to reach for the element
 * again and reintroduce a second scroll.
 */
async function performVerb(
  action: SceneAction,
  text: string | null | typeof REDACTED_WITHOUT_REPLACEMENT,
  cdp: CdpSession,
  cursor: { x: number; y: number },
  touch: boolean,
  objectId: string,
  sightings: ClickSightings,
  sleep: (ms: number) => Promise<void>,
  onFieldRead?: WalkStep["onFieldRead"],
  onLastKeyUnpainted?: WalkStep["onLastKeyUnpainted"],
): Promise<ClickVerdict | null> {
  // Every click is checked: the page is asked where the press and the
  // release arrived, against the point both were sent to (`click-probe.ts`).
  // Placed before the press, read after the release, and nothing in
  // between, so the two still go out back to back as they always have.
  const click = async (): Promise<ClickVerdict> => {
    // The action's id names the probe's own reports (`ClickSightings`): one
    // probe per action, so one per id.
    const probe = await placeClickProbe(cdp, objectId, action.id);
    try {
      await dispatchClick();
    } catch (error) {
      // Not left on the author's page: the throw is what the run reports.
      await discardClickProbe(cdp, probe);
      throw error;
    }
    return readClickProbe(cdp, probe, cursor, sightings);
  };
  const dispatchClick = async (): Promise<void> => {
    if (touch) {
      // A phone has no mouse: a tap is what fires its touch handlers, and
      // Chrome synthesises the click from it as a real phone does (spec
      // 2026-10-10 §3). The same point the mouse path aims at.
      const point = {
        x: cursor.x,
        y: cursor.y,
        radiusX: 4,
        radiusY: 4,
        force: 1,
        id: 0,
      };
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchStart",
        touchPoints: [point],
      });
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchEnd",
        touchPoints: [],
      });
      return;
    }
    for (const type of ["mousePressed", "mouseReleased"]) {
      await cdp.send("Input.dispatchMouseEvent", {
        type,
        x: cursor.x,
        y: cursor.y,
        button: "left",
        clickCount: 1,
      });
    }
  };

  switch (action.kind) {
    case "click":
      return click();
    case "type": {
      const verdict = await click(); // focus the field the path just arrived at
      // Nothing typed into a field a click that did not arrive cleanly left
      // unfocused: the keys would land wherever focus was. `clickStopped`
      // stops the run on this verdict.
      if (
        verdict.kind !== "delivered" &&
        verdict.seen !== undefined &&
        !verdict.seen.focused
      )
        return verdict;
      // The caret shows before the first key, as it would for a person, and
      // the drawn press gets a moment of its own (`TYPE_LEAD_MS`).
      await sleep(TYPE_LEAD_MS);
      // "Make this field say X" is what the schema records for an input or
      // a textarea, so replace the contents rather than appending to them.
      // Not for a contenteditable host: its contents are the document, and
      // its text is what the author typed at the caret — see the schema.
      if (!action.host) {
        await cdp.send("Input.dispatchKeyEvent", {
          type: "rawKeyDown",
          windowsVirtualKeyCode: 65,
          modifiers: 2,
          commands: ["selectAll"],
        });
      }
      const typed = typeof text === "string" ? text : "";
      await typeKeys(typed, cdp, sleep);
      const unpainted = await lastKeyPainted(cdp, objectId);
      if (unpainted !== null) onLastKeyUnpainted?.(unpainted);
      if (onFieldRead !== undefined) {
        // The read is a courtesy to the verdict: a refused one does not end
        // the take, but the step says it could not be read and why.
        try {
          const reply = await cdp.send("Runtime.callFunctionOn", {
            objectId,
            functionDeclaration: FIELD_READ,
            returnByValue: true,
          });
          const value = (reply.result as { value?: unknown } | undefined)
            ?.value;
          if (value === null) {
            onFieldRead({
              unavailable: "focus moved to another element after typing",
            });
          } else if (typeof value !== "string") {
            onFieldRead({ unavailable: "the page answered with no text" });
          } else {
            onFieldRead({
              value:
                value.length > FIELD_VALUE_MAX
                  ? `${value.slice(0, FIELD_VALUE_MAX)}…`
                  : value,
              holds: fieldHolds(value, typed),
            });
          }
        } catch (error) {
          onFieldRead({
            unavailable: error instanceof Error ? error.message : String(error),
          });
        }
      }
      return verdict;
    }
    case "scrollTo":
      // Nothing left to do: the approach already scrolled this target to
      // `center`, smoothly and inside a span. This used to scroll a second
      // time, after an instant correction had already put the target at the
      // edge of the screen — so the big move was a cut nothing recorded and
      // this one travelled the short remainder. Measured on a page with
      // targets 1800px apart, that split a single beat into an 843px jump
      // and a 389px scroll. See `bringIntoView`.
      return null;
    case "moveTo":
      // The path and the dwell, both already dispatched.
      return null;
    case "waitFor":
      // Never reaches here: the loop handles a wait before any verb.
      return null;
    case "drag":
      // Never reaches here: the loop performs a drag with `performDrag`.
      throw new Error("performVerb: a drag is performed by performDrag");
    case "press":
      // Never reaches here: the loop presses a key before it locates anything.
      throw new Error("performVerb: a press is performed by pressKey");
    default: {
      const unknown: never = action;
      throw new Error(`performVerb: no verb for ${JSON.stringify(unknown)}`);
    }
  }
}

/**
 * Put `text` in a key at a time, `TYPE_KEY_MS` apart, or closer when that
 * would run past `TYPE_MAX_MS`. The film records while this runs, so the
 * spacing is what the viewer sees: one `insertText` of the whole string
 * landed it in a single frame. A key is a grapheme, not a code unit — an
 * emoji split in two goes in as two lone surrogates.
 */
async function typeKeys(
  text: string,
  cdp: CdpSession,
  sleep: (ms: number) => Promise<void>,
): Promise<void> {
  const keys = typeKeysOf(text);
  const gap = typeGapMs(keys.length);
  // An empty value still goes in, as it always has: over an input's
  // selection it is what empties the field.
  if (keys.length === 0) {
    await cdp.send("Input.insertText", { text: "" });
    return;
  }
  for (const [i, key] of keys.entries()) {
    if (i > 0) await sleep(gap);
    await cdp.send("Input.insertText", { text: key });
  }
}

/**
 * Waits for the page to draw the last key: two animation frames, so the
 * frame the key went into has been produced. `Input.insertText` resolves
 * once the renderer handled the key, not once it painted it, and the act's
 * end is stamped when the verb returns: on CI's macOS runner the last glyph
 * reached the film 367 ms after that, and the camera left before the value
 * showed (DEM-173). Bounded by `ACT_CEILING_MS`, since a page that draws no
 * frames would otherwise hold the walk. Asked of the field itself, so the
 * frame timed is the field's own (an iframe's, for a field in one). Null
 * once drawn, or when the key took the document away (an OTP box that
 * submits on its last digit): there is no paint of it left to wait for, and
 * the load is what the film shows next. Otherwise why not.
 */
async function lastKeyPainted(
  cdp: CdpSession,
  objectId: string,
): Promise<string | null> {
  try {
    const drawn = evaluatedValue(
      await cdp.send("Runtime.callFunctionOn", {
        objectId,
        functionDeclaration: `function () { const w = this.ownerDocument.defaultView; const raf = w.__demomanRaf || w.requestAnimationFrame.bind(w); return new Promise((r) => { const t = w.setTimeout(() => r(false), ${ACT_CEILING_MS}); raf(() => raf(() => { w.clearTimeout(t); r(true); })); }); }`,
        awaitPromise: true,
        returnByValue: true,
      }),
    );
    if (drawn === true) return null;
    if (drawn === false) {
      return `the page drew no frame within ${ACT_CEILING_MS} ms of the last key`;
    }
    return "the paint check answered with nothing readable";
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (DOCUMENT_GONE.test(message)) return null;
    return `the paint check failed (${message})`;
  }
}

/** What CDP says when the field's document went away under a call: a
 *  navigation, which `lastKeyPainted` does not count as a missed paint. */
const DOCUMENT_GONE =
  /Execution context was destroyed|Cannot find context with specified id|Could not find object with given id|Inspected target navigated or closed/;

function blankCounters(
  viewport: { width: number; height: number },
  total: number,
): ReplayCounters {
  return {
    actions: total,
    completed: 0,
    replayThrough: 0,
    keyframes: 0,
    motionSpans: 0,
    motionFrames: 0,
    droppedMotionFrames: 0,
    surfaceMismatchFrames: 0,
    encodeRefusedFrames: 0,
    encodeShrunkSpans: 0,
    budgetBreaches: 0,
    keyframeOnlySpans: 0,
    occlusionPauses: 0,
    occlusionMs: 0,
    heapHighWater: 0,
    motionWidth: 0,
    motionHeight: 0,
    durationMs: 0,
    dpr: REPLAY_DPR,
    viewportWidth: viewport.width,
    viewportHeight: viewport.height,
  };
}

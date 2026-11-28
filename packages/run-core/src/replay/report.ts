import {
  CAMERA_DEFAULTS,
  type Degradation,
  type FrameBundle,
  isHeld,
  isRealTime,
  type MadeFromStep,
} from "@demoman/compositor";
import {
  type AuthoredStep,
  type CaptureFailure,
  failedPerformedStep,
  IDLE_CONNECTION_MS,
  type Rect,
  type ReplayCounters,
  type ReplayPolicy,
  type ReplayStatus,
  type ReplayStopReason,
  reasonSentence,
  replayOutcome,
  STEP_REQUEST_CAP_MS,
  TYPE_FIELD_UNFOCUSED,
  type WaitSaw,
} from "@demoman/replay-engine";
import {
  type DemoScript,
  type DialogKind,
  type SceneDocument,
  SHOWN_STEP,
  type StrategyName,
  trimStepIndex,
} from "@demoman/scene-schema";
import { zoomSkippedNote } from "../auto-zoom.js";
import type { RunLook } from "../brand-kit.js";
import type { RecordingFrameRate } from "../recording-frame-rate.js";
import type { RefilmInfo } from "../refilm/merge.js";
import type { EndPage } from "../snapshot-walk.js";
import type { RecordingReport } from "./fidelity.js";
import type { FilmReport } from "./film.js";
import { frozenRoutes, type NoticeRoute } from "./routes.js";
import type { RunSize } from "./run-size.js";
import {
  compareToScript,
  NO_RECORD,
  NO_TAKE,
  type Verdict,
} from "./verdict.js";

/**
 * The refusal reasons `packages/replay-engine/src/policy.ts`'s `ReplayPolicy`
 * can hand back — restated here because the package exports no name for the
 * union by itself, only the discriminated `ReplayPolicy` it is one field of.
 * Not a new vocabulary: this is exactly that field's type, read off with
 * `Extract` rather than invented.
 */
export type ReplayRefusal = Extract<
  ReplayPolicy,
  { mayReplay: false }
>["refusal"];

/** Which script, or which take, a run performed — the `run.script` field of
 *  `RunReport["run"]`. A re-shoot names the take it came from; a fresh run
 *  names the script and how many steps it declared. */
export type ScriptRef =
  | {
      name: string;
      scriptVersion: DemoScript["scriptVersion"];
      /** Set when the script stated a lower version than it needs and Demoman raised it. */
      versionRaisedFrom?: number;
      steps: number;
    }
  | { takeId: string };

/**
 * One step of the script, and everything the run measured about it — the
 * report's own shape of `@demoman/replay-engine`'s `AuthoredStep`, carried
 * with nothing added and nothing dropped.
 *
 * `AuthoredStep.anchorId` is null in two different cases — a step that
 * resolved nothing, and a step that resolved and then stopped the run (the
 * navigation case, `pageWentElsewhere`) — so neither this type nor anything
 * that reads it may use `anchorId` to decide whether anything was found.
 * `strategy`, `rect` and `pageUrl` are the fields that answer that.
 *
 * `marker` is non-null for a step the walk COMMITTED as an action, and this
 * used to add "and harvested frames … the reliable 'is this step in the film'
 * check". It is not that check. The source commits a step only once the walk
 * has performed and counted it, so a committed step does have a bundle marker
 * of its name — but a throw after the walk's `markers.push` (the keyframe, the
 * verb), reported as `portFailure`, leaves a bundle marker for a step that
 * never committed. `provenance`/`verdict` is where "is this step in the film"
 * is actually answered, from the frames' own `madeFrom`.
 */
export interface StepReport {
  index: number;
  intent: AuthoredStep["step"];
  actionId: string | null;
  anchorId: string | null;
  strategy: StrategyName | null;
  candidates: number | null;
  failureReason: CaptureFailure | null;
  rect: Rect | null;
  marker: string | null;
  pageUrl: string | null;
  /** Present when the typed text is not kept (launch C): the field is a
   *  credential, or the page could not say. `intent.text` then reads
   *  HIDDEN_TEXT. */
  textHidden?: "credentialField" | "credentialUnchecked";
  /** A `waitFor` that timed out: what its last look found. */
  waitSaw?: WaitSaw;
  /** A `type` whose text is kept: what the field held afterwards, and
   *  whether it holds the typed text. Never present with `textHidden`. */
  fieldHolds?: { value: string; holds: boolean };
  /** A `type` whose field could not be read back: why. Not a divergence. */
  fieldRead?: { unavailable: string };
  /** A `type` whose last key the page was not seen to paint: why. The step
   *  ended at the bound, so the camera may leave before the value shows. */
  lastKeyPaint?: { unconfirmed: string };
  /** A `type` whose field had text it could not select first, so the typed
   *  text went in beside it: that text (`before`), absent for a credential;
   *  or `why` the select could not say, when it threw. */
  fieldNotCleared?: { before?: string; why?: string };
  /** A `waitForLoad` that was met: false when no load started since the
   *  previous step began — a note, not a divergence. */
  loadSeen?: boolean;
}

/** Which executor ran the script: the CLI's own Chromium (spec 2026-10-12).
 *  Every report says so. */
export type Executor = "cli";

/** The code a run filmed: the tree on disk when it started (every file git
 *  would commit, tracked or untracked but not ignored), the commit it sat on
 *  (null before the first commit), and whether the two differ. `none` says
 *  why it could not be read. */
export type FilmedCode =
  | {
      commit: string | null;
      tree: string;
      dirty: boolean;
      /** Filters the folder's own git config names, which the tree was
       *  read without; absent when there were none. */
      unfiltered?: string[];
    }
  | { none: string };

/** A `filmedCode` read from a stored report or receipt, or null when it is
 *  not one: the one check every reader uses, so a malformed value is
 *  "unknown" everywhere and never copied on. Absent (`undefined`) is null
 *  too; a caller that tells "absent" from "malformed" looks for the key. */
export function parseFilmedCode(raw: unknown): FilmedCode | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw))
    return null;
  const c = raw as Record<string, unknown>;
  if (typeof c.none === "string" && c.none !== "") return { none: c.none };
  if (
    (c.commit === null || typeof c.commit === "string") &&
    typeof c.tree === "string" &&
    typeof c.dirty === "boolean"
  )
    return {
      commit: c.commit,
      tree: c.tree,
      dirty: c.dirty,
      ...(Array.isArray(c.unfiltered) &&
      c.unfiltered.every((n) => typeof n === "string")
        ? { unfiltered: c.unfiltered as string[] }
        : {}),
    };
  return null;
}

/** Where a run's recording frame rate came from (`resolveRecordingFrameRate`). */
export type RecordingFrameRateFrom = "repo" | "default";

/** How a run recorded the page's clock (`RunReport.run.recording`).
 *  `frameRateUnread`: the repo's `.demoman/config.json` could not be read
 *  or parsed, so the run took the default; the sentence names the file and
 *  why. */
export type RunRecording =
  | {
      clock: "held";
      frameRate: RecordingFrameRate;
      from: RecordingFrameRateFrom;
      frameRateUnread?: string;
    }
  | {
      clock: "real";
      why: string;
      frameRateNotApplied?: { asked: 60; from: "repo" };
      frameRateUnread?: string;
    };

/**
 * The time zone and locale a run's page had (`RunReport.run.region`), and
 * whose they were: `flow`, the ones its flow's take or kept file recorded;
 * `thisMachine`, this machine's, pinned because the flow had none recorded
 * yet (its first run), with `why` when a record could not be read; and
 * `notPinned`, this machine's, left unpinned because the flow's video was
 * recorded before Demoman pinned them, so it records as it always did.
 */
export interface RunRegion {
  timeZone: string;
  locale: string;
  from: "flow" | "thisMachine" | "notPinned";
  why?: string;
}

/** A run's or probe's last picture on disk, or why there is none. */
export type FinalStill = { path: string } | { unavailable: string };

export interface RunReport {
  run: {
    id: string;
    startedAt: number;
    target: string;
    executor: Executor;
    script: ScriptRef;
    /** Whether the page's clock was held, at which frame rate and whose
     *  setting that was, or why not when it was not; `frameRateNotApplied`
     *  when 60 was set but the run recorded in real time. Absent when the
     *  run stopped before its stage was prepared. */
    recording?: RunRecording;
    /** The version of the browser that recorded the take, as it names
     *  itself (`meta.capture.browser` holds the same). Absent when the run
     *  stopped before its stage was prepared, or when no browser was
     *  connected to ask (the run's log says so). */
    browser?: string;
    /** The time zone and locale the page had, and whose they were. Absent
     *  when the run stopped before its stage was prepared. */
    region?: RunRegion;
  };
  /** Never derived from `steps` — see `buildRunReport`'s docblock, rule 1. */
  outcome: "complete" | "stopped" | "refused";
  /**
   * Populated whenever the run (or a rebuild sharing its shape) carries a
   * stop reason — independent of `outcome`: `ReplayResult`'s own docblock is
   * explicit that a run can finish every step and still fail to persist its
   * bundle (`portFailure`), which is `outcome: "complete"` with a reason
   * here. `at.index`/`at.of` are `walk.completed`/`walk.total` directly, not
   * a step number recomputed from them, so this always agrees with the run
   * that produced it rather than with a second guess about which step that
   * was.
   */
  stopped?: {
    reason: ReplayStopReason;
    at: {
      index: number;
      of: number;
      label: string;
      /** The script step the run stopped on (1-based, pauses counted), from
       *  the same record `label` names; null when no script step can be
       *  named (a re-shoot, or no step attempted). Absent in a
       *  report.json written before the script step was recorded. */
      scriptStep?: number | null;
      /** The script's step count; null when the run had no script. */
      scriptSteps?: number | null;
    };
    sentence: string;
    /**
     * What the host actually saw, in its own vocabulary and carrying the
     * browser's own words — present only for a failure the reason alone does
     * not explain, and **what `verdictLine` prints in place of `sentence`**
     * when it is there.
     *
     * `sentence` is `reasonSentence(reason)`: one of a fixed set, shared with
     * the editor, and a CATEGORY. Every stage that would not open and every
     * debugger client already holding the tab reads the same, and for one
     * reason it says too little at this door — `noActions`' sentence does
     * not know a script of pauses is the cause. So the detail wins the line
     * and `sentence` stays in the report for whoever wants the category.
     *
     * The report is ALL an agent keeps, which is why this cannot live on a
     * progress note the way the editor's equivalent could. `d2b95dd9` exists
     * because an attach refusal used to guess "the Cancel on its infobar, most
     * likely" whatever had happened; this is what keeps that fix at this door.
     */
    detail?: string;
  };
  refused?: { reason: ReplayRefusal; routes: NoticeRoute[] };
  /**
   * What the run owed the library and did not put there, in the order it tries:
   * the take itself, the run status the editor reads a rebuild's outcome from,
   * the video the take joins, its script, and the site's session written back.
   * Each carries what went wrong — a store that refused the write, or (for
   * the take) a document the schema refused, which is the only other way a
   * run that measured its steps ends with nothing in the library.
   *
   * Absent when every one landed. Present, and `verdictLine` leads with it —
   * whatever else the run has to say, the library does not hold what the
   * report describes, and that is the fact the reader has to act on first.
   *
   * `provenance.takeId` is null whenever `"take"` is in here: an id nothing
   * can open reads exactly like one that can, and a caller handed one would
   * try to open it. It is non-null when only a later write failed, because the
   * take IS in the library and can be opened — what is missing is part of
   * its record.
   */
  notStored?: {
    what: "take" | "status" | "script" | "renderMode" | "session" | "video";
    error: string;
  }[];
  /** The video the take joined, and its version number there (local video
   *  library §4); `created` when this run started the video. Not `video`,
   *  which is the film check's. Absent when the run made no take, or the
   *  take could not join (then `notStored` has `"video"`). `version` is
   *  absent when the take joined but its number could not be read back
   *  (the executor's log says why). */
  videoVersion?: {
    id: string;
    name: string;
    version?: number;
    created: boolean;
    /** Present when the run's checkout is not the flow's repo:
     *  "this flow belongs to X; this video was recorded from Y". */
    otherRepo?: string;
  };
  /** Present only when a kept file (.demoman/videos) in the run's repo
   *  keeps the video this run joined: the file rewritten to follow the new
   *  version, or why it was not (it still describes the earlier one). */
  kept?: { rewritten: string } | { refused: string };
  /** Present on a re-film (`run({ video: { id } })` with no script): the take it came from, what
   *  the merge could not place (`notes`), and the editor edits the new take
   *  does not have (`notCarried`). Absent on a run of a script. */
  rerecord?: RefilmInfo;
  /** Launch C: where the run's start URL actually landed, when that was
   *  not the page asked for and not a sign-in page; or why a page could not
   *  be checked for one — the start page, or else the page a stopped run
   *  stopped on. Absent: it landed where it was asked, and any page checked
   *  after a stop was read. */
  landing?: { startedElsewhere: string } | { unchecked: string };
  /** Up to 3 date-looking strings on the run's last screen; absent when it
   *  showed none or could not be read. Refresh's evidence for saying a
   *  replaced video's dates may be why; never served to agents. */
  datesOnScreen?: string[];
  /** One sentence per target the run found by a weaker tier than its
   *  capture had (the page changed mid-step), naming its `anchorId`: the
   *  step still passed, so this is the only place the drift is said.
   *  Absent when there was none. */
  foundWeaker?: string[];
  /** The instant the run's page clock was pinned to. Set when the
   *  run was given one: prepareStage stops a run whose pin cannot be
   *  installed, so a report that has it was pinned. Refresh confirms the pin
   *  reached its run from this, and writes the receipt's pinnedNow from it. */
  pinnedNow?: string;
  /** What the run filmed (docs/superpowers/specs/2026-10-25-pr-reminder-
   *  and-verdict-design.md). Absent on a report written before it existed. */
  filmedCode?: FilmedCode;
  /** The account the run filmed as (launch C2); absent for a manual session. */
  account?: string;
  /** Present when Demoman signed in as the account for this run. */
  signedIn?: { account: string; steps: number; ms: number };
  /** The film's last frame as export frames it, a PNG beside the take, or
   *  why there is none (spec 2026-10-30 A1). A path, never the bytes: the
   *  MCP tool attaches the image. Absent on a report written before it. */
  still?: FinalStill;
  /** The page the run ended on, as text, or why it could not be read
   *  (spec 2026-10-30 A2). Absent on a report written before it. */
  endPage?: EndPage | { unavailable: string };
  steps: StepReport[];
  provenance: {
    takeId: string | null;
    bundleId: string | null;
    madeFrom: MadeFromStep[];
  };
  /**
   * What the run HARVESTED, which is not the same as what is on disk now.
   *
   * A run whose take never reached the library has its bundle deleted, and that
   * takes the keyframe blobs with it — so these counts can describe frames
   * nothing can load any more. They are still the honest answer to "what did
   * this run get", which is what an agent reading a failed run needs; whether
   * any of it survived is `provenance.bundleId` (null when it did not) and
   * `notStored`. `storageRefused` is narrower still: it says the store refused
   * the bundle DURING the run, not that the bundle was cleaned up after one.
   */
  frames: {
    spans: number;
    keyframes: number;
    degradations: Degradation["kind"][];
    storageRefused: boolean;
    /** Spans the encoder refused at their opening size and kept smaller.
     *  Nothing was lost, so the verdict line does not say it; this is where
     *  the refusal is counted rather than forgiven without a trace. */
    shrunkSpans: number;
    /**
     * Each click the page could not vouch for (a `clickUnconfirmed` in
     * `degradations`): the step it belonged to, named as `stopped.at` names
     * one, and what the check said. Absent when there were none. The kind
     * alone said a click somewhere was unconfirmed and not which, so an
     * agent told to check that step in the film could not find it.
     */
    unconfirmedClicks?: { step: string; note: string }[];
    /**
     * Each beat of the take's plan that could not be placed (`pacingUnplaced`
     * in `degradations`): the step it sits before, and a sentence saying
     * what the video does instead. Absent when there were none.
     */
    unplacedBeats?: { step: string; note: string }[];
    /**
     * Screencast frames of the window's unscaled surface that were refused
     * rather than filmed (a `surfaceMismatch` in `degradations`):
     * how many, and when each was painted, in ms from the run's start.
     * Absent when there were none.
     */
    surfaceCrops?: { refused: number; atMs: number[] };
  };
  /**
   * Every JavaScript dialog the run answered, in order. `step` is
   * the script step it opened during (1-based), null for one that opened with
   * no click, type or press armed (a load, a drag), which the video does not
   * draw (`drawn` false). Absent when no dialog opened.
   */
  dialogs?: {
    step: number | null;
    kind: DialogKind;
    message: string;
    answer: "accept" | "dismiss";
    text?: string;
    by: "script" | "default";
    drawn: boolean;
  }[];
  /** What the video looks like (film-check spec §2). Always present: a run
   *  with nothing to check says why, never omits the field. */
  video: FilmReport;
  /** How far the run drifted from the author's recording (spec §3). Always
   *  present, `{ unavailable }` when there is no recording to compare. */
  recording: RecordingReport;
  /** Where the take's branding came from (spec 2026-10-01 §1.4). Null on a
   *  re-shoot, which makes no new take and so has no look to report. */
  look: RunLook | null;
  /**
   * The size the page was laid out and filmed at, and why (`run-size.ts`).
   * `from: "window"` with an `error` is the fallback when the screen could
   * not be read: a size nobody chose, said so it is never mistaken for the
   * author's. Null for a run that never reached the page (refused, or a
   * stage that would not open) and on a re-shoot, which films the size its
   * take was recorded at.
   */
  size: RunSize | null;
  verdict: Verdict;
  /** What the video's opening was spent on. Absent for a run with no script
   *  or no shown step performed. */
  opening?: OpeningReport;
  /** One sentence per click whose asked-for `zoom` the take refused. */
  zoomNotes?: { step: number; sentence: string }[];
  /** Why the take's zooms start under the camera's default
   *  (`SceneDocument.zoomDefault`). Absent when they start at it. */
  zoomDefault?: string;
  /** One sentence per side of the script's `trim` that did not apply as asked. */
  trimNotes?: string[];
}

/**
 * From the take's first frame to the first shown step's marker, in parts.
 * `spentOn` is `load` (first frame to the first step's start), then each
 * step before the first shown one (a `pause` at its scripted length).
 * `unaccountedMs` is what the parts do not cover, present only when it is
 * more than rounding: never padded into one of the kinds. `shown` is the
 * opening the video keeps when `trim.start` applies.
 */
export interface OpeningReport {
  ms: number;
  shown?: number;
  spentOn: {
    kind: "load" | "waitForLoad" | "waitFor" | "pause";
    ms: number;
  }[];
  unaccountedMs?: number;
}

/**
 * An opening longer than this puts a clause in the summary line: about the
 * point a viewer waits for something to happen. Not jitter-sensitive; it
 * only decides whether a sentence is added, never how the film is made.
 */
export const LONG_OPENING_MS = 3000;

/**
 * What one run's own walk measured, narrowed to what a report needs — the
 * caller-owned facts `AuthoredResult`/`ReplayResult` carry beside `steps`,
 * kept apart from them on purpose: `outcome` is computed from this, never
 * from `steps` (rule 1 below), so this type does not carry a `steps` field
 * at all — there is nothing for a future edit to reach for by mistake.
 */
export interface WalkResultLike {
  reason: ReplayStopReason | null;
  completed: number;
  total: number;
  bundle: FrameBundle | null;
  degradations: Degradation[];
  storageRefused: boolean;
  counters: Pick<ReplayCounters, "encodeShrunkSpans">;
  unconfirmedClicks?: { actionId: string; note: string }[];
  /** `ReplayResult.surfaceCrops`. */
  surfaceCrops?: number[];
  /** `ReplayResult.dialogs`: optional there, so read as `?? []`. */
  dialogs?: (Omit<
    NonNullable<RunReport["dialogs"]>[number],
    "step" | "drawn"
  > & {
    actionId: string | null;
  })[];
  ignoredDrags?: { actionId: string; note: string }[];
  /** `AuthoredResult`'s own, carried for `trimNotes`. */
  trimClamped?: { side: "start"; askedMs: number; keptMs: number };
  trimUnplaced?: ("start" | "end")[];
  trimHeldUnplaced?: true;
  trimPlanFailed?: string;
}

interface BuildArgsCommon {
  run: RunReport["run"];
  // Required so the compiler finds every caller; a default here would be a
  // fallback that fires whether or not anything was checked.
  film: FilmReport;
  recording: RecordingReport;
  // Required so the compiler finds every caller (null for a re-shoot).
  look: RunLook | null;
  // Required for the same reason; see `RunReport.size`.
  size: RunSize | null;
  /**
   * The take the run performed, or produced — and `null` when there is no
   * take: a run the policy refused before it started, and a run that
   * performed no step at all (`AuthoredResult.document`, whose own docblock
   * says a document with no performed step is not a take). Null is not a
   * missing argument, it is the fact that there is nothing to compare the
   * frames against, and `buildVerdict` below says so rather than passing.
   */
  scene: SceneDocument | null;
  madeFrom: readonly MadeFromStep[] | null;
  takeId?: string | null;
  bundleId?: string | null;
  notStored?: RunReport["notStored"];
  /** `stopped.detail` — see its docblock. Carried through rather than
   *  recomposed here: only the caller knows what the browser said. */
  detail?: string;
}

/**
 * What `buildRunReport` needs, as a discriminated union rather than a bag of
 * optionals: a refused run never walked anything, so it carries no `walk`
 * and no `steps` to mistake for having done so.
 */
export type BuildArgs =
  | (BuildArgsCommon & { refused: { reason: ReplayRefusal } })
  | (BuildArgsCommon & {
      walk: WalkResultLike;
      steps: AuthoredStep[];
      /** The script that was walked, for the opening and the trim notes.
       *  Absent on the older sampled re-shoot, which has none:
       *  no opening is claimed. A re-record has one. */
      script?: DemoScript;
    });

/** What a hidden step's `intent.text` reads instead of the value. */
export const HIDDEN_TEXT = "(hidden: typed into a credential field)";

function toStepReport(step: AuthoredStep): StepReport {
  const hidden = step.textHidden ?? null;
  return {
    index: step.index,
    // The script step is what the agent wrote — but report.json is on disk,
    // and a credential's value is kept nowhere there (launch C).
    intent:
      hidden !== null && step.step.do === "type"
        ? { ...step.step, text: HIDDEN_TEXT }
        : step.step,
    actionId: step.actionId,
    anchorId: step.anchorId,
    strategy: step.strategy,
    candidates: step.candidates,
    failureReason: step.failureReason,
    rect: step.rect,
    marker: step.marker,
    pageUrl: step.pageUrl,
    ...(hidden === null ? {} : { textHidden: hidden }),
    ...(step.waitSaw === undefined ? {} : { waitSaw: step.waitSaw }),
    ...(step.fieldHolds === undefined ? {} : { fieldHolds: step.fieldHolds }),
    ...(step.fieldRead === undefined ? {} : { fieldRead: step.fieldRead }),
    ...(step.lastKeyPaint === undefined
      ? {}
      : { lastKeyPaint: step.lastKeyPaint }),
    ...(step.fieldNotCleared === undefined
      ? {}
      : { fieldNotCleared: step.fieldNotCleared }),
    ...(step.loadSeen === undefined ? {} : { loadSeen: step.loadSeen }),
  };
}

/**
 * The step's own words, for a `label` the document cannot supply.
 *
 * The verb, and whichever of the three strategies the script used to name its
 * element — `waitForLoad` names none and says so by printing just the verb.
 * Read off `ScriptStep` itself rather than off the document, because this is
 * reached precisely when the document holds no action for the step.
 */
function scriptStepLabel(step: AuthoredStep["step"]): string {
  const target = "into" in step ? step.into : "on" in step ? step.on : null;
  if (step.do === "press") return `press ${step.key}`;
  if (target === null) return step.do;
  // Every member, then `never`: this chain used to end in a bare return that
  // printed a `treePath` target as `text "undefined"`.
  if ("stableId" in target) return `${step.do} stableId "${target.stableId}"`;
  if ("role" in target) return `${step.do} ${target.role} "${target.name}"`;
  if ("text" in target) return `${step.do} text "${target.text}"`;
  if ("treePath" in target) return `${step.do} treePath "${target.treePath}"`;
  const unknown: never = target;
  return `${step.do} ${JSON.stringify(unknown)}`;
}

/** Where the opening went; see `OpeningReport`. */
function openingOf(
  script: DemoScript,
  steps: readonly AuthoredStep[],
  walk: WalkResultLike,
): OpeningReport | undefined {
  const timed = (i: number) => steps.find((s) => s.index === i)?.timing;
  const firstShown = script.steps.findIndex((s) => SHOWN_STEP[s.do]);
  const shownTiming = firstShown < 0 ? undefined : timed(firstShown);
  const firstRecord = steps.find((s) => s.timing !== undefined);
  const first = firstRecord?.timing;
  if (
    shownTiming === undefined ||
    firstRecord === undefined ||
    first === undefined
  )
    return undefined;
  // A pause writes no record, so its sleep sits inside the first timed
  // step's start; it is its own entry below, and comes out of `load` here.
  const pausedBefore = script.steps
    .slice(0, firstRecord.index)
    .reduce((t, s) => (s.do === "pause" ? t + s.ms : t), 0);
  const ms = Math.round(shownTiming.markerMs);
  const spentOn: OpeningReport["spentOn"] = [
    {
      kind: "load",
      ms: Math.round(first.markerMs + first.startMs - pausedBefore),
    },
  ];
  for (const [i, step] of script.steps.slice(0, firstShown).entries()) {
    if (step.do === "pause") spentOn.push({ kind: "pause", ms: step.ms });
    else if (step.do === "waitForLoad" || step.do === "waitFor") {
      const t = timed(i);
      if (t !== undefined)
        spentOn.push({ kind: step.do, ms: Math.round(t.finishMs - t.startMs) });
    }
  }
  const left = ms - spentOn.reduce((total, p) => total + p.ms, 0);
  const start = script.trim?.start;
  const unplaced = walk.trimUnplaced?.includes("start") ?? false;
  return {
    ms,
    ...(start === undefined || unplaced
      ? {}
      : { shown: walk.trimClamped?.keptMs ?? start.ms }),
    spentOn,
    ...(Math.abs(left) > 1 ? { unaccountedMs: left } : {}),
  };
}

/** The sides of `trim` that did not apply as asked, in words. */
function trimNotesOf(
  script: DemoScript,
  steps: readonly AuthoredStep[],
  walk: WalkResultLike,
): string[] {
  const notes: string[] = [];
  const clamp = walk.trimClamped;
  if (clamp !== undefined) {
    // A clamp is only written against a step the run performed.
    const step = (trimStepIndex(script, "start") ?? 0) + 1;
    notes.push(
      `trim.start asked for ${clamp.askedMs} ms before step ${step} and the video holds ${clamp.keptMs} ms; it starts at the beginning`,
    );
  }
  if (walk.trimPlanFailed !== undefined) {
    notes.push(
      `Demoman could not place the steps on the planned video (${walk.trimPlanFailed}), so any trim or held zoom the script asked for is not applied; the script is not at fault`,
    );
  }
  if (walk.trimHeldUnplaced === true) {
    notes.push(
      "trim.end's zoom lands after the video's last frame, so it is not held through the cut and pulls out before it",
    );
  }
  for (const side of walk.trimUnplaced ?? []) {
    const index = trimStepIndex(script, side);
    const ran = steps.some((s) => s.index === index && s.timing !== undefined);
    notes.push(
      ran
        ? `trim.${side} lies past what the run filmed, so the ${side} is not trimmed`
        : index === null
          ? `trim.${side} has no shown step to be measured from, so the ${side} is not trimmed`
          : `trim.${side} names step ${index + 1}, which never ran, so the ${side} is not trimmed`,
    );
  }
  return notes;
}

/** Why the take's zooms start lower than the camera's default, or null. */
export function zoomDefaultSentence(
  scene: Pick<SceneDocument, "zoomDefault"> | null,
): string | null {
  const d = scene?.zoomDefault;
  if (d === undefined) return null;
  const x = (n: number) => `${Number(n.toFixed(2))}x`;
  return `Zooms start at ${x(d.scale)}, not ${x(CAMERA_DEFAULTS.defaultZoomScale)}: the video's frames are ${x(d.stillScale)}, and the default export cannot zoom further without upscaling them.`;
}

/** A click's asked-for zoom that the take refused, per script step. */
function zoomNotesOf(
  scene: SceneDocument | null,
  steps: readonly AuthoredStep[],
): { step: number; sentence: string }[] {
  return (scene?.zoomsSkipped ?? []).flatMap((skip) => {
    if (!("askedScale" in skip) || skip.askedScale === undefined) return [];
    const record = steps.find((s) => s.actionId === skip.actionId);
    if (record === undefined) return [];
    const note = zoomSkippedNote(skip);
    return [
      {
        step: record.index + 1,
        sentence: `asked for ${skip.askedScale}x, but ${note.charAt(0).toLowerCase()}${note.slice(1)}`,
      },
    ];
  });
}

/**
 * The walk's unconfirmed clicks, each with the script step its action came
 * from. A click whose action this run has no record of is named by its action
 * id rather than dropped: the note is the evidence, and losing it to a failed
 * lookup is the defect this field exists to end.
 */
function unconfirmedClicksOf(
  walk: WalkResultLike,
  steps: readonly AuthoredStep[],
): { unconfirmedClicks?: { step: string; note: string }[] } {
  const clicks = walk.unconfirmedClicks ?? [];
  if (clicks.length === 0) return {};
  return {
    unconfirmedClicks: clicks.map(({ actionId, note }) => {
      const record = steps.find((s) => s.actionId === actionId);
      return {
        step:
          record === undefined
            ? `action ${actionId}`
            : `script step ${record.index + 1}: ${scriptStepLabel(record.step)}`,
        note,
      };
    }),
  };
}

/** The walk's dialogs with the script step each opened during. An action this
 *  run has no step for is undrawn like an unowned one, never dropped, and so
 *  is one the take does not hold: a step the run stopped on is not in it, and
 *  the video draws no card for it. */
function dialogsOf(
  walk: WalkResultLike,
  steps: readonly AuthoredStep[],
  scene: SceneDocument | null,
): Pick<RunReport, "dialogs"> {
  const all = walk.dialogs ?? [];
  if (all.length === 0) return {};
  return {
    dialogs: all.map(({ actionId, kind, message, answer, text, by }) => {
      const record =
        actionId === null
          ? undefined
          : steps.find((s) => s.actionId === actionId);
      return {
        step: record === undefined ? null : record.index + 1,
        kind,
        message,
        answer,
        ...(text === undefined ? {} : { text }),
        by,
        drawn:
          record !== undefined &&
          (scene?.actions.some((a) => a.id === actionId) ?? false),
      };
    }),
  };
}

/** What the run answered, in a line; nothing when no dialog opened. */
function dialogsClause(report: RunReport): string {
  const all = report.dialogs ?? [];
  if (all.length === 0) return "";
  const answers = all.map((d) => (d.answer === "accept" ? "OK" : "Cancel"));
  return ` The run answered ${all.length} dialog${all.length === 1 ? "" : "s"} (${answers.join(", ")}).`;
}

/** A planned beat that could not be placed is a degradation of the video
 *  like any other, though the bundle never carries it (it is a fact about the
 *  plan read against the frames, `bundle.ts`): the film check found it, so it
 *  joins the walk's list here, once. */
function degradationsOf(
  walk: WalkResultLike,
  film: FilmReport,
): Degradation["kind"][] {
  const kinds = walk.degradations.map((d) => d.kind);
  return "unplacedBeats" in film && !kinds.includes("pacingUnplaced")
    ? [...kinds, "pacingUnplaced"]
    : kinds;
}

/** What `pacingUnplaced` costs a take with a beat plan: its own sentence,
 *  not the recorded-pause one (`DEGRADATION_WORDS`), which would speak of
 *  pauses nobody recorded. */
export function plannedUnplacedNote(step: string): string {
  return `the planned pause before ${step} could not be placed, so that stretch plays as it was recorded and the video is not the planned length`;
}

/** A visible window cannot be given a scale (spec 2026-11-13 part 2): its
 *  motion is recorded at its screen's, said on `size.error` when that is
 *  not the scale the flow was recorded at. */
export function screenScaleNote(screen: number, flow: number): string {
  return `This window's screen is at ${screen}x, so its motion was recorded at ${screen}x where the flow was recorded at ${flow}x — run it headless to record it at ${flow}x again.`;
}

function unplacedBeatsOf(
  film: FilmReport,
  steps: readonly AuthoredStep[],
): { unplacedBeats?: { step: string; note: string }[] } {
  if (!("unplacedBeatSteps" in film) || film.unplacedBeatSteps === undefined)
    return {};
  return {
    unplacedBeats: film.unplacedBeatSteps.map((actionId) => {
      const record =
        actionId === null
          ? undefined
          : steps.find((s) => s.actionId === actionId);
      const step =
        actionId === null
          ? "the end of the video"
          : record === undefined
            ? `action ${actionId}`
            : `script step ${record.index + 1}: ${scriptStepLabel(record.step)}`;
      return { step, note: plannedUnplacedNote(step) };
    }),
  };
}

/**
 * Why a run stopped as `clickNotDelivered`, in place of the reason's sentence:
 * where the click was sent and where its press and release arrived — the walk's
 * note — and the move. Both doors print it, so it is one sentence here.
 */
export function clickNotDeliveredDetail(note: string): string {
  // A store that also refused the bundle is said after the walk's own note
  // (walk.ts); it is a second fact, so it goes after the move, not inside it.
  const [click, ...later] = note.split("; bundle not persisted: ");
  // A type whose click the page could not vouch for, and whose field then
  // did not take focus, is not known to be the browser's doing: a target
  // that is not the field itself (a button that opens one) fails this way
  // every time, and "run it again" would send the agent round in a loop.
  const move = click?.includes(TYPE_FIELD_UNFOCUSED)
    ? `${click} — if the step's target is not itself the text field (a button or a link that opens one), snapshot the page with the field showing and type into the field's own target; if it is the field, run it again, and say so if it repeats`
    : `${click} — the browser put the click somewhere other than where it was sent, so that step did not happen; nothing in the script is wrong: run it again, and say so if it repeats`;
  return later.length === 0
    ? move
    : `${move}. Also, the take could not be stored: ${later.join("; ")}`;
}

function buildStopped(
  walk: WalkResultLike,
  scene: SceneDocument | null,
  steps: readonly AuthoredStep[],
  detail: string | undefined,
  script: ScriptRef,
): RunReport["stopped"] {
  if (walk.reason === null) return undefined;
  // A `ReplayStatus`-shaped view of the walk, built only to hand to
  // `failedPerformedStep` — the same function `staleness.ts`'s
  // `replaySentence` calls, so a stopped run's failing step is never named
  // two different ways by the editor and by this report.
  const asReplayStatus: ReplayStatus = {
    outcome: replayOutcome(walk.completed, walk.total),
    reason: walk.reason,
    completed: walk.completed,
    total: walk.total,
  };
  // No take, no step to name — and said in the label rather than left to read
  // as "no single step", which is the different fact that a take DOES exist
  // and the stop cannot be pinned to one of its steps.
  const step =
    scene === null ? null : failedPerformedStep(scene, asReplayStatus);
  /**
   * The step the run stopped on, named from the SCRIPT when the document
   * cannot name it.
   *
   * `failedPerformedStep` reads `scene.actions[completed]`, so it answers null
   * on this door's commonest failure by construction: a capture that resolved
   * nothing committed no action, `actions.length === completed`, and there is
   * nothing at that index. The label then read "(no single step to name)",
   * whose own comment defines it as "the stop cannot be pinned to one of its
   * steps" — and it can. `steps` is one record per step the run ATTEMPTED, in
   * order (`AuthoredStep`'s docblock), so its last entry IS the step that
   * failed, carrying its script index and its verbatim intent.
   *
   * Not fabricated from the count: this is the record the run itself wrote for
   * the step it was on, and `index + 1` is that record's own 0-based
   * `script.steps` index counted the way an author counts.
   */
  const lastAttempted = steps.at(-1) ?? null;
  // The script step, from the record the label names: the document's
  // failing action's own record where the label is the document's, else the
  // last attempted. One numbering with the label.
  const failing =
    step === null || scene === null
      ? lastAttempted
      : (steps.find(
          (s) =>
            s.actionId !== null &&
            s.actionId === scene.actions[walk.completed]?.id,
        ) ?? null);
  return {
    reason: walk.reason,
    at: {
      // From the walk directly, not from `step.number` — `failedStep`'s own
      // numbering is one-based off `completed` for a DIFFERENT reason (which
      // action index failed) and returns null on the portFailure/noActions
      // paths this field must still answer for. Reading `walk.completed`
      // and `walk.total` themselves means `at` is always the run's own
      // count, never a fabricated one.
      //
      // It is a count of SUCCESSFUL steps, so where it is printed (only
      // when no script step can be named) it reads "after step N of M" —
      // see `stoppedWhere`.
      index: walk.completed,
      of: walk.total,
      scriptStep: failing === null ? null : failing.index + 1,
      scriptSteps: "steps" in script ? script.steps : null,
      // The record `scriptStep` reads: so the label and the number name one
      // step even when no video was assembled.
      label: step
        ? `${step.kind} ${step.label}`
        : lastAttempted !== null
          ? `script step ${lastAttempted.index + 1}: ${scriptStepLabel(lastAttempted.step)}`
          : scene === null
            ? "(no video was assembled, so no step can be named)"
            : // Reached only with a document AND no attempted step, which the
              // engine does not produce (a document exists only because a step
              // was performed). Kept rather than thrown: this is a report, and
              // an honest "nothing named" beats an exception on the one path
              // that would carry the evidence.
              "(no single step to name)",
    },
    sentence: reasonSentence(walk.reason),
    ...(detail === undefined ? {} : { detail }),
  };
}

function buildVerdict(
  outcome: RunReport["outcome"],
  scene: SceneDocument | null,
  madeFrom: readonly MadeFromStep[] | null,
  steps: readonly StepReport[],
  ignoredDrags: readonly { actionId: string; note: string }[] = [],
): Verdict {
  // Rule 2 again, from the other side: no take means nothing to compare the
  // frames TO. `compareToScript` walks `scene.actions` — the intended log —
  // and an absent one is "I cannot tell", never "nothing diverged". Checked
  // before `madeFrom` only because it is the stronger absence: a run with no
  // take has no log whether or not its frames recorded one.
  if (scene === null) {
    return {
      kind: "diverged",
      diverged: [{ kind: "unverifiable", reason: NO_TAKE }],
    };
  }
  // Rule 2: `"matches"` is unreachable without a `madeFrom` record. No
  // record means `diverged` with the reason, never an empty list — "I
  // cannot tell" and "they match" are different answers.
  if (madeFrom === null) {
    return {
      kind: "diverged",
      diverged: [{ kind: "unverifiable", reason: NO_RECORD }],
    };
  }
  const diverged = [
    ...compareToScript(scene, madeFrom, steps),
    ...ignoredDrags.map(({ actionId, note }) => ({
      kind: "ignored" as const,
      actionId,
      reason: note,
    })),
  ];
  if (outcome === "complete") {
    return diverged.length === 0
      ? { kind: "matches", diverged: [] }
      : { kind: "diverged", diverged };
  }
  // Rule 3, made concrete on the verdict itself rather than only on the
  // printed line: a run that did not complete is never a match, whatever
  // the comparator found. Frames that happen to correspond to the steps
  // that DID run say nothing about the steps that did not — a `madeFrom`
  // built to look complete for a run that stopped partway is exactly the
  // trap `run-report.test.ts`'s first case is built to catch.
  if (diverged.length > 0) return { kind: "diverged", diverged };
  const reason =
    outcome === "refused"
      ? "the run was refused before it could produce anything to compare"
      : "the run stopped before the script finished, so the video cannot be said to match it";
  return { kind: "diverged", diverged: [{ kind: "unverifiable", reason }] };
}

/**
 * Three rules, each from CLAUDE.md's opening section ("report before you
 * forgive"), each asserted in `test/node/run-report.test.ts`:
 *
 * 1. `outcome` is not optional and is NOT derived from `steps`. A refused
 *    run, a run stopped at step 4 and a finished run have three different
 *    values, never a shared empty one. Computed here from `args.walk`'s own
 *    `completed`/`total` (via `replayOutcome`, the same function
 *    `AuthoredResult`/`ReplayResult` are measured against elsewhere) or from
 *    the presence of `args.refused` — never from `args.steps.length` or
 *    from any step's `marker`.
 * 2. `verdict.kind: "matches"` is unreachable without a `madeFrom` record.
 *    No record means `"diverged"` with the reason — "I cannot tell" is not
 *    "they match". See `buildVerdict`.
 * 3. The verdict LINE (`verdictLine`, below) is written from `outcome`
 *    first. A stopped run whose frames happen to match its script must not
 *    read like a complete one — and `buildVerdict` above holds the same
 *    line for the `verdict` field itself, not only for the sentence built
 *    from it.
 * 4. **Two facts outrank `outcome` on that line, and both are absences.**
 *    `notStored` comes first of all: whatever the run has to say about
 *    itself, the library does not hold what the report describes. Then a
 *    stop reason, which is read *independently* of `outcome` — rule 3 is
 *    about `verdict` never surviving a stop, not about `outcome` being the
 *    only thing consulted, and a complete run with a reason (every step
 *    performed, the bundle unstorable; or a script that asked for nothing)
 *    has to say so. Added 2026-09-27: the line printed only the verdict for
 *    that case, so the reason was dropped.
 */
export function buildRunReport(args: BuildArgs): RunReport {
  const provenance = (madeFrom: readonly MadeFromStep[] | null) => ({
    takeId: args.takeId ?? null,
    bundleId: args.bundleId ?? null,
    madeFrom: madeFrom !== null ? Array.from(madeFrom) : [],
  });

  // Narrowed directly on `args` — the union's own discriminant — rather
  // than on locals split out of it beforehand, which would have thrown away
  // the narrowing and needed a cast to get back (the class of hole this
  // repo does not paper over with `!`, `movedIds`' own docblock, applies
  // just as much to `as`).
  if ("refused" in args) {
    const outcome: RunReport["outcome"] = "refused";
    const steps: StepReport[] = [];
    return {
      run: args.run,
      outcome,
      stopped: undefined,
      refused: {
        reason: args.refused.reason,
        routes: frozenRoutes(args.scene, { mayReplay: false }),
      },
      notStored: args.notStored,
      steps,
      provenance: provenance(args.madeFrom),
      frames: {
        spans: 0,
        keyframes: 0,
        degradations: [],
        storageRefused: false,
        shrunkSpans: 0,
      },
      video: args.film,
      recording: args.recording,
      look: args.look,
      size: args.size,
      verdict: buildVerdict(outcome, args.scene, args.madeFrom, steps),
    };
  }

  // Rule 1: from `args.walk`'s own count, never from `steps` — see this
  // function's own docblock above.
  const outcome: RunReport["outcome"] =
    replayOutcome(args.walk.completed, args.walk.total) === "complete"
      ? "complete"
      : "stopped";
  const steps = args.steps.map(toStepReport);
  const opening =
    args.script === undefined
      ? undefined
      : openingOf(args.script, args.steps, args.walk);
  const trimNotes =
    args.script === undefined
      ? []
      : trimNotesOf(args.script, args.steps, args.walk);
  const zoomNotes = zoomNotesOf(args.scene, args.steps);
  const zoomDefault = zoomDefaultSentence(args.scene);

  return {
    run: args.run,
    outcome,
    stopped: buildStopped(
      args.walk,
      args.scene,
      args.steps,
      args.detail,
      args.run.script,
    ),
    refused: undefined,
    notStored: args.notStored,
    steps,
    provenance: provenance(args.madeFrom),
    frames: {
      spans: args.walk.bundle?.motionSpans.length ?? 0,
      keyframes: args.walk.bundle?.keyframes.length ?? 0,
      degradations: degradationsOf(args.walk, args.film),
      storageRefused: args.walk.storageRefused,
      shrunkSpans: args.walk.counters.encodeShrunkSpans,
      ...unconfirmedClicksOf(args.walk, args.steps),
      ...unplacedBeatsOf(args.film, args.steps),
      ...((args.walk.surfaceCrops ?? []).length === 0
        ? {}
        : {
            surfaceCrops: {
              refused: args.walk.surfaceCrops?.length ?? 0,
              atMs: args.walk.surfaceCrops ?? [],
            },
          }),
    },
    ...dialogsOf(args.walk, args.steps, args.scene),
    video: args.film,
    recording: args.recording,
    look: args.look,
    size: args.size,
    verdict: buildVerdict(
      outcome,
      args.scene,
      args.madeFrom,
      steps,
      args.walk.ignoredDrags,
    ),
    ...(opening === undefined ? {} : { opening }),
    ...(zoomNotes.length === 0 ? {} : { zoomNotes }),
    ...(zoomDefault === null ? {} : { zoomDefault }),
    ...(trimNotes.length === 0 ? {} : { trimNotes }),
  };
}

/**
 * The one line a person reads (`#run-report`'s human summary, per spec §1) —
 * and rule 3's other half.
 *
 * FOUR things decide this line, and this docblock used to name only two of
 * them ("`outcome` decides which clause fires; `verdict` is consulted only
 * inside the 'complete' clause") while the function's own first executable
 * lines read a third. The real precedence, in the order the code takes it:
 *
 * 1. `notStored`, ahead of everything the run has to say about itself — what
 *    the reader can find in the library disagrees with the report. It is the
 *    only one that PREFIXES rather than replaces: the run's own clause still
 *    follows it.
 * 2. `outcome`, for its two non-complete values. `"refused"` and `"stopped"`
 *    each have a clause, and a stopped run's clause prints the stop.
 * 3. `stopped.reason` — which wins over the verdict **even when `outcome` is
 *    `"complete"`**, because a run can perform every step and then fail to
 *    persist its bundle (`ReplayResult`'s docblock; `statusOf`'s case). That
 *    is the clause a reading of "outcome decides" would miss.
 * 4. `verdict`, reached only by a complete run carrying no stop reason — so a
 *    stopped or refused run can never print as though its frames were the
 *    whole story.
 */
export function verdictLine(report: RunReport): string {
  // Ahead of everything, including a refusal: whatever the run has to say
  // about itself, what the reader can find in the library disagrees with it.
  // Same precedence, and for the same reason, as `replayNotice`'s unrecorded
  // clause — which was added the day a run reported "Done" over a scene the
  // editor read as never rebuilt.
  const unstored = report.notStored ?? [];
  if (unstored.length > 0) {
    const said = unstored.map((w) => `${w.what} (${w.error})`).join("; ");
    const take = unstored.some((w) => w.what === "take")
      ? "The run's video did not reach the library"
      : unstored.some((w) => w.what === "renderMode")
        ? "The re-shoot's frames are stored, but the video still plays its original footage"
        : // Launch C: a session file is not part of the take's record, so a
          // write-back alone does not call the take incomplete.
          unstored.every((w) => w.what === "session")
          ? "The run's video is in the library, but the site's session could not be saved back"
          : "The run's video is in the library, but part of its record is not";
    // A session alone leaves the video whole, as `take` above says.
    const intact =
      unstored.every((w) => w.what === "session") &&
      framesClause(report) === "" &&
      ownClockClause(report) === "";
    return `${take}: ${said}. ${runVerdictLine(report)}${framesClause(report)}${ownClockClause(report)}${screensClause(report, intact)}${dialogsClause(report)}${recordingClause(report)}${lookClause(report)}${otherRepoClause(report)}`;
  }
  return `${runVerdictLine(report)}${framesClause(report)}${ownClockClause(report)}${screensClause(report, framesClause(report) === "" && ownClockClause(report) === "")}${dialogsClause(report)}${recordingClause(report)}${lookClause(report)}${otherRepoClause(report)}`;
}

/**
 * `verdictLine`'s short form, for the line above a video on a pull request:
 * the same fields in the same precedence, so it is not a second decision.
 * `details` is the whole line whenever the run has more to say than a clean
 * match, and null when it does not.
 */
export function prVerdict(report: RunReport): {
  clause: string;
  details: string | null;
} {
  const n = report.steps.length;
  const clean = `matches all ${n} step${n === 1 ? "" : "s"}`;
  const clause = prClause(report, clean);
  // A screen refresh cannot compare leaves the video's clause clean, and is
  // still said in the details.
  // A dialog the run answered is said too, a default OK above all: the
  // page went on as if someone had pressed it.
  const quiet =
    clause === clean &&
    screensClause(report, true) === "" &&
    dialogsClause(report) === "";
  return { clause, details: quiet ? null : verdictLine(report) };
}

/**
 * Where a run stopped, in one numbering with its label: the
 * script's own step, pauses counted, when one can be named. Otherwise the
 * count the run measured, "after" it, as before: a re-shoot has no script,
 * a run that attempted nothing has no step to name, and a report written
 * before the script step was recorded has none.
 */
export function stoppedWhere(at: {
  index?: number;
  of?: number;
  scriptStep?: number | null;
  scriptSteps?: number | null;
}): string {
  // Loose: a report.json written before the script step was recorded has none,
  // and the compare harness reads an answer whose fields are all optional.
  return at.scriptStep != null && at.scriptSteps != null
    ? `at script step ${at.scriptStep} of ${at.scriptSteps}`
    : `after step ${at.index ?? "?"} of ${at.of ?? "?"}`;
}

function prClause(report: RunReport, clean: string): string {
  const unstored = report.notStored ?? [];
  // A session that was not saved back is not part of the take's record, as
  // verdictLine says; it is a note, not an incomplete record.
  const sessionOnly =
    unstored.length > 0 && unstored.every((w) => w.what === "session");
  if (unstored.length > 0 && !sessionOnly)
    return "the run's record is incomplete";
  if (report.outcome === "refused")
    return `refused: ${report.refused?.reason ?? "unknown"}`;
  if (report.outcome === "stopped") {
    const at = report.stopped?.at;
    return at ? `stopped ${stoppedWhere(at)}` : "stopped";
  }
  if (report.stopped !== undefined) return "finished, but did not end cleanly";
  if (report.verdict.kind !== "matches") {
    const k = report.verdict.diverged.length;
    return `${k} step${k === 1 ? "" : "s"} not shown as scripted`;
  }
  const noted =
    sessionOnly ||
    report.frames.degradations.some((k) => !SCREENS_ONLY.has(k)) ||
    report.frames.storageRefused ||
    (report.look?.brandKitError ?? null) !== null ||
    (report.look?.wallpaperError ?? null) !== null ||
    // A field typed into without being cleared may hold more than its text.
    report.steps.some((s) => s.fieldNotCleared !== undefined);
  return noted ? `${clean}, with notes` : clean;
}

/**
 * What each kind of degradation cost the film, in the words the verdict line
 * uses. A `Record` over the compositor's own enum, so a kind added there and
 * not here fails to compile instead of reaching the line as nothing.
 */
/** Each degradation kind in a sentence: the verdict line's words, which
 *  refresh repeats when it delivers or fails a degraded run. */
export const DEGRADATION_WORDS: Record<Degradation["kind"], string> = {
  // Three causes write it, and its note names which: a real-time take's
  // motion budget ("motion budget spent"), a held change too short to play
  // as motion, and a heap high-water (an encoder that reports one).
  keyframeOnly:
    "a stretch of motion was kept as stills: the video reached its motion limit, a change was too short to play as motion, or memory ran high",
  budgetBreach: "motion frames were skipped to stay inside the frame budget",
  occlusionPause: "capture paused while the replay window was covered",
  pageNeverSettled:
    "the page never settled before a step, so a frame may show it mid-change",
  surfaceMismatch:
    "a stretch of motion is missing — Chrome returned frames of the window, or at a full still's size, rather than the page's, and they were refused",
  encodeRefused: "a stretch of motion is missing — the encoder refused it",
  screencastStopped:
    "motion may be missing from partway through — a screencast frame could not be acknowledged, and the browser sends no more until one is",
  stillFailed:
    "a sharp still could not be taken after the page settled, so a stretch shows the last motion frame instead",
  scrollUnsettled:
    "a scroll was still moving when a step was aimed, so the cursor may miss its target",
  // Since 2026-09-30 a landing comes from the take's recorded rect OR a
  // script step's hand-written `landing: { top }`, so the words name neither.
  scrollLandingOffscreen:
    "a scroll's landing would have left its target off screen, so the page was centred on it instead",
  clickUnconfirmed:
    "a click could not be confirmed to have reached its target, so the video may show a step that did nothing — frames.unconfirmedClicks names the step and says why",
  // No run writes it since 2026-10-10 (see the compositor's enum); kept
  // because the Record must cover every kind a bundle can carry.
  textLinesUnmeasured:
    "the text around a click could not all be measured, so its zoom may cut a line beside the target",
  cursorSynthesized:
    "the cursor is reconstructed from the steps rather than recorded",
  motionReclaimed: "motion was reclaimed to free storage",
  pacingUnplaced: "a pause could not be placed on its step",
  notDragged:
    "a drag reached the page and changed nothing on screen, so the page may not take drags this way",
  dragPictureMissing:
    "a native drag's picture could not be drawn, so the dragged item jumps to its drop in the video instead of travelling",
  pointerLate:
    "the page took the pointer's moves late on this machine, so the cursor can arrive a moment before a hover shows",
  stepUnsettled:
    "a step's page had not settled when the next began, so refresh cannot compare that screen",
  stepSettleFailed:
    "a step's settle or page screen failed on this machine (a paint that never came, a probe or capture that failed), so refresh cannot compare that screen",
  pageHoldNotReleased:
    "a page screen's hold could not be undone, so the video after that step may show no caret and frozen animations",
  requestNotWaited: `a request opened more than ${STEP_REQUEST_CAP_MS / 1000} seconds before a step's wait began (a long poll, say) was not waited for, so that step's page screen may have been taken before it answered`,
  connectionIgnored: `a connection with no data for ${IDLE_CONNECTION_MS / 1000} seconds was not counted as waiting on the server, so the video may show the page before that connection answered`,
  answerUnpaced:
    "an answer from the server was still arriving during a pause or a rest, which the video does not pace by the server, so it landed where this machine put it; wait for it with a waitFor step to have it paced",
  frameRetaken:
    "a screenshot went unanswered or was refused on this machine and was taken again a frame of page time later, or the first one, answered late, stood in for it, so one frame of the page may be missing from the video (or from the opening before it), and the page's time after it may stand a frame apart from another video of the same script",
  animationUnpinned:
    "part of the page could not be held on the video's clock (an animation that could not be paused, a playing video, or a frame from another site, whose timers, animations and requests run on their own), so it ran in real time and may not match the video's pacing; or the page asked for a smooth scroll, which shows as a jump",
};

/** A repo set 60 fps and the run recorded in real time, so it did not
 *  apply; or the repo's file could not be read, so the default was used. */
function recordingClause(report: RunReport): string {
  const r = report.run.recording;
  if (r === undefined) return "";
  if (r.frameRateUnread !== undefined) {
    return r.clock === "held"
      ? ` Recorded at ${r.frameRate} fps: ${r.frameRateUnread}.`
      : ` Frame rate not read: ${r.frameRateUnread}.`;
  }
  if (r.clock !== "real" || r.frameRateNotApplied === undefined) return "";
  return " Recorded in real time: the repo's 60 fps applies only on a held clock.";
}

/** The run joined a flow from a checkout of another repo. */
function otherRepoClause(report: RunReport): string {
  const said = report.videoVersion?.otherRepo;
  return said === undefined ? "" : ` Note: ${said}.`;
}

/** An unreadable brand kit, or a default kit's image the take could not
 *  own (`look.wallpaperError`), said after everything else on the line: the take
 *  is made and correct by its own lights, but it is not in the colours the
 *  author saved, and a grey video with no reason reads as "no kit". Empty
 *  when there is nothing to say, so every other line is unchanged. */
function lookClause(report: RunReport): string {
  return [report.look?.brandKitError, report.look?.wallpaperError]
    .map((error) => (error == null ? "" : ` ${error}.`))
    .join("");
}

/** What a stills-only video is called, wherever it is said. */
export const STILLS_ONLY =
  "no motion was recorded: the video is its stills only";

/**
 * Whether a run's video is its stills only: it recorded no motion span though a
 * step acted, in real time. There it cannot tell a page that did not move from
 * a screencast that got no frames (a locked screen, a sleeping display, a
 * hidden window or a busy machine), so the sentence names both; watching the
 * screencast go silent would tell them apart. A held run takes every frame on
 * its clock, and a frame it cannot take or encode stops the run or is said, so
 * no spans there is a page that did not move. A run that names no clock stopped
 * before its stage was prepared (`run.recording`): it recorded nothing, and its
 * outcome says why. The one rule the run's summary and refresh's verdict read;
 * `stillsOnlyTake` is the same rule on a take, for export.
 */
export function stillsOnly(r: {
  run?: { recording?: { clock: "held" | "real" } };
  steps?: readonly { intent?: { do?: string } }[];
  frames?: { spans?: number };
}): boolean {
  return (
    r.frames?.spans === 0 &&
    (r.steps ?? []).some((st) => st.intent?.do !== "pause") &&
    r.run?.recording?.clock === "real"
  );
}

/**
 * `stillsOnly` asked of a take (its bundle and scene), for a door that has
 * no run report: export. Real time, no motion span, a step that acted (a
 * scene's actions are its steps less the pauses). Bundles before held and
 * a sampled replay are not real time (`isRealTime`), and are not judged.
 */
export function stillsOnlyTake(
  bundle: Pick<FrameBundle, "source" | "timing" | "clock" | "motionSpans">,
  scene: { actions: readonly unknown[] },
): boolean {
  return (
    isRealTime(bundle) &&
    !isHeld(bundle) &&
    bundle.motionSpans.length === 0 &&
    scene.actions.length > 0
  );
}

/**
 * The frames' half of the verdict: what the film did not keep. Empty when
 * everything was kept, so a clean run's line is unchanged.
 *
 * The line was written from the steps alone until 2026-09-28, when the
 * author's first real run came back "Complete: the video matches every step
 * the script asked for." with `surfaceMismatch` in `frames.degradations` — a
 * run that lost motion read word for word like one that did not. Once per
 * kind, naming the kind, so an agent can find it in `frames.degradations`.
 */
function framesClause(report: RunReport): string {
  const kinds = [...new Set(report.frames.degradations)].filter(
    (k) => !SCREENS_ONLY.has(k) && !OWN_CLOCK.has(k),
  );
  const said = kinds.map((kind) =>
    kind === "pacingUnplaced" && report.frames.unplacedBeats !== undefined
      ? `${report.frames.unplacedBeats.map((b) => b.note).join("; ")} (${kind})`
      : `${DEGRADATION_WORDS[kind]} (${kind})`,
  );
  if (report.frames.storageRefused) {
    said.push("the frame store refused frames during the run (storageRefused)");
  }
  // A visible window with its screen locked recorded no motion and
  // read "Complete: the video matches every step".
  if (stillsOnly(report)) {
    said.push(
      `${STILLS_ONLY} (recorded in real time: either the page did not move, or the screen sent no frames, as a locked screen, a sleeping display or a hidden window)`,
    );
  }
  return said.length === 0
    ? ""
    : ` But not everything was kept: ${said.join("; ")}.`;
}

/**
 * The kinds that are about refresh's page screens and not the video (close
 * review of 2026-11-10): the film is whole, so they never say a frame was
 * lost nor turn a match into one "with notes". `screensClause` says them.
 */
const SCREENS_ONLY = new Set<Degradation["kind"]>([
  "stepUnsettled",
  "stepSettleFailed",
  "requestNotWaited",
]);

/**
 * The kinds a held recording says of what it could not hold on the video's
 * clock (a frame from another site, a playing video, a connection gone
 * quiet). Every frame was kept, so they never say one was lost
 * (`ownClockClause`), and they are the page's own: refresh does not record
 * again for them (review of 2026-11-16).
 */
const OWN_CLOCK = new Set<Degradation["kind"]>([
  "connectionIgnored",
  "animationUnpinned",
  "answerUnpaced",
]);

function ownClockClause(report: RunReport): string {
  const kinds = [...new Set(report.frames.degradations)].filter((k) =>
    OWN_CLOCK.has(k),
  );
  const said = kinds.map((kind) => `${DEGRADATION_WORDS[kind]} (${kind})`);
  return said.length === 0
    ? ""
    : ` Every frame was kept, but not all of the page was on the video's clock: ${said.join("; ")}.`;
}

/** The page screens' sentence: what refresh will not compare, or compared
 *  early. It calls the video intact only when nothing else on the line says
 *  otherwise (`intact`). Empty when there is nothing. */
function screensClause(report: RunReport, intact: boolean): string {
  const kinds = [...new Set(report.frames.degradations)].filter((k) =>
    SCREENS_ONLY.has(k),
  );
  const said = kinds.map((kind) => `${DEGRADATION_WORDS[kind]} (${kind})`);
  return said.length === 0
    ? ""
    : intact
      ? ` The video is intact, but for refresh: ${said.join("; ")}.`
      : ` For refresh: ${said.join("; ")}.`;
}

/** `verdictLine` without the storage clause: what the run itself has to say.
 *  Split the way `replayNotice`/`runNotice` are split, so the two clauses
 *  cannot be reordered by accident. */
function runVerdictLine(report: RunReport): string {
  // Last, after any outcome: a field typed into before a stop is in the
  // video too, holding more than its text.
  const uncleared = report.steps
    .filter((s) => s.fieldNotCleared !== undefined)
    .map(
      (s) =>
        `Step ${s.index + 1} typed into a field it could not clear first (fieldNotCleared).`,
    );
  const line = runLineBeforeNotes(report);
  return uncleared.length === 0
    ? line
    : `${line.replace(/\.?$/, ".")} ${uncleared.join(" ")}`;
}

function runLineBeforeNotes(report: RunReport): string {
  const line = runOutcomeLine(report);
  // After the sentence, never instead of one: a stop or a refusal leads.
  const opening = report.opening;
  const spent = opening?.shown ?? opening?.ms ?? 0;
  if (report.outcome !== "complete" || opening === undefined) return line;
  if (spent <= LONG_OPENING_MS) return line;
  const largest = opening.spentOn.reduce((a, b) => (b.ms > a.ms ? b : a));
  // Only when that kind outweighs the time no part accounts for.
  const mostly = largest.ms >= (opening.unaccountedMs ?? 0);
  const what = {
    load: "loading",
    waitForLoad: "waiting for a load",
    waitFor: "waiting for an element",
    pause: "a pause",
  }[largest.kind];
  const shorten = opening.shown === undefined ? "; trim.start shortens it" : "";
  return `${line.replace(/\.$/, "")}; the video spends ${(spent / 1000).toFixed(1)} s before the first step${mostly ? ` (mostly ${what})` : ""}${shorten}.`;
}

function runOutcomeLine(report: RunReport): string {
  if (report.outcome === "refused") {
    const reason = report.refused?.reason ?? "unknown";
    return `Refused: ${reason}.`;
  }
  if (report.outcome === "stopped") {
    const at = report.stopped?.at;
    // "at script step N of M" where the record `at.label` names has a
    // script step, so the number and the label name one step.
    // Otherwise "after step N of M": `at.index` is `walk.completed`, a count
    // of steps that SUCCEEDED, and printing `at.index + 1` as "at" would
    // claim step 1 was attempted on a run that never opened a stage.
    const where = at ? ` ${stoppedWhere(at)}` : "";
    return `Stopped${where}: ${whyStopped(report)}`;
  }
  // Complete AND a reason, which is reachable and load-bearing — `statusOf`'s
  // docblock names the case: a run that performed every step and then could not
  // store its bundle. Every run of zero steps is here too, because
  // `replayOutcome(0, 0)` is vacuously complete and `noActions` is the reason
  // that says the run performed nothing. This clause used to print only the
  // verdict, so the reason was dropped and a script of nothing but pauses read
  // as `"Complete: 1 step the film does not show…"` — where that "1 step" was
  // the `unverifiable` divergence and not a step at all. The rebuild's
  // `runNotice` has always said `"Finished, but: ${why}."` for exactly this;
  // this is the same sentence in the same position.
  if (report.stopped !== undefined) {
    return `Complete, but: ${whyStopped(report)}`;
  }
  // A re-shoot names a take, not a script: `run.script` is `{ takeId }`.
  const asked =
    "takeId" in report.run.script
      ? "the original footage showed"
      : "the script asked for";
  if (report.verdict.kind === "matches") {
    return `Complete: the video matches every step ${asked}.`;
  }
  const n = report.verdict.diverged.length;
  const unheld = report.verdict.diverged
    .filter((d) => d.kind === "fieldDoesNotHold")
    .map((d) => {
      const index = report.steps.find((s) => s.actionId === d.actionId)?.index;
      const which = index === undefined ? "a step" : `step ${index + 1}`;
      return `${which} typed ${JSON.stringify(d.wanted)} and the field holds ${JSON.stringify(d.value)} (fieldDoesNotHold)`;
    });
  const fields = unheld.length === 0 ? "" : ` ${unheld.join("; ")}.`;
  return `Complete: ${n} step${n === 1 ? "" : "s"} the video does not show the way ${asked} it.${fields}`;
}

/** Why a run carrying a stop reason stopped: what the host saw where it said,
 *  and the reason's shared sentence otherwise. One function, so the `stopped`
 *  and the complete-with-a-reason clauses cannot come to describe the same stop
 *  two different ways. See `stopped.detail` for why the detail wins. */
function whyStopped(report: RunReport): string {
  return (
    report.stopped?.detail ??
    report.stopped?.sentence ??
    report.stopped?.reason ??
    "it did not finish"
  );
}

export type { Divergence, Verdict } from "./verdict.js";

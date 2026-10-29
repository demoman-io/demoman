import type {
  Degradation,
  FrameBundle,
  MadeFromStep,
} from "@demoman/compositor";
import {
  type AuthoredStep,
  type CaptureFailure,
  failedPerformedStep,
  type Rect,
  type ReplayCounters,
  type ReplayPolicy,
  type ReplayStatus,
  type ReplayStopReason,
  reasonSentence,
  replayOutcome,
  TYPE_FIELD_UNFOCUSED,
} from "@demoman/replay-engine";
import type {
  DemoScript,
  SceneDocument,
  StrategyName,
} from "@demoman/scene-schema";
import type { RunLook } from "../brand-kit.js";
import type { RefilmInfo } from "../refilm/merge.js";
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
}

/** Which executor ran the script: the browser extension, or the CLI's own
 *  Chromium (spec 2026-10-12). Every report says so. */
export type Executor = "extension" | "cli";

/** The code a run filmed: the tree on disk when it started (every file git
 *  would commit, tracked or untracked but not ignored), the commit it sat on
 *  (null before the first commit), and whether the two differ. `none` says
 *  why it could not be read. */
export type FilmedCode =
  | { commit: string | null; tree: string; dirty: boolean }
  | { none: string };

export interface RunReport {
  run: {
    id: string;
    startedAt: number;
    target: string;
    executor: Executor;
    script: ScriptRef;
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
    at: { index: number; of: number; label: string };
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
   * What the run owed the library and did not put there, in the order it tried:
   * the take itself, the run status the editor reads a rebuild's outcome from,
   * and the telemetry event. Each carries what went wrong — a store that
   * refused the write, or (for the take) a document the schema refused, which
   * is the only other way a run that measured its steps ends with nothing in
   * the library.
   *
   * Absent when every one landed. Present, and `verdictLine` leads with it —
   * whatever else the run has to say, the library does not hold what the
   * report describes, and that is the fact the reader has to act on first.
   *
   * `provenance.takeId` is null whenever `"take"` is in here: an id nothing
   * can open reads exactly like one that can, and a caller handed one would
   * try to open it. It is non-null when only a later write failed, because the
   * take IS in the library and can be opened — what is missing is the status
   * or the event.
   */
  notStored?: {
    what:
      | "take"
      | "status"
      | "script"
      | "telemetry"
      | "renderMode"
      | "session"
      | "video";
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
  /** What the run filmed (docs/superpowers/specs/2026-10-25-pr-reminder-
   *  and-verdict-design.md). Absent on a report written before it existed. */
  filmedCode?: FilmedCode;
  /** The account the run filmed as (launch C2); absent for a manual session. */
  account?: string;
  /** Present when Demoman signed in as the account for this run. */
  signedIn?: { account: string; steps: number; ms: number };
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
  };
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
}

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
  ignoredDrags?: { actionId: string; note: string }[];
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
  | (BuildArgsCommon & { walk: WalkResultLike; steps: AuthoredStep[] });

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
      // It is a count of SUCCESSFUL steps, which is why `verdictLine` prints
      // it as "Stopped after step N of M" — see that function.
      index: walk.completed,
      of: walk.total,
      label: step
        ? `${step.kind} ${step.label}`
        : scene === null
          ? "(no take was assembled, so no step can be named)"
          : lastAttempted !== null
            ? `script step ${lastAttempted.index + 1}: ${scriptStepLabel(lastAttempted.step)}`
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

  return {
    run: args.run,
    outcome,
    stopped: buildStopped(args.walk, args.scene, args.steps, args.detail),
    refused: undefined,
    notStored: args.notStored,
    steps,
    provenance: provenance(args.madeFrom),
    frames: {
      spans: args.walk.bundle?.motionSpans.length ?? 0,
      keyframes: args.walk.bundle?.keyframes.length ?? 0,
      degradations: args.walk.degradations.map((d) => d.kind),
      storageRefused: args.walk.storageRefused,
      shrunkSpans: args.walk.counters.encodeShrunkSpans,
      ...unconfirmedClicksOf(args.walk, args.steps),
    },
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
      ? "The run's take did not reach the library"
      : unstored.some((w) => w.what === "renderMode")
        ? "The re-shoot's frames are stored, but the take still plays its recording"
        : // Launch C: a session file is not part of the take's record, so a
          // write-back alone does not call the take incomplete.
          unstored.every((w) => w.what === "session")
          ? "The run's take is in the library, but the site's session could not be saved back"
          : "The run's take is in the library, but part of its record is not";
    return `${take}: ${said}. ${runVerdictLine(report)}${framesClause(report)}${lookClause(report)}`;
  }
  return `${runVerdictLine(report)}${framesClause(report)}${lookClause(report)}`;
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
  return { clause, details: clause === clean ? null : verdictLine(report) };
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
    return at ? `stopped after step ${at.index} of ${at.of}` : "stopped";
  }
  if (report.stopped !== undefined) return "finished, but did not end cleanly";
  if (report.verdict.kind !== "matches") {
    const k = report.verdict.diverged.length;
    return `${k} step${k === 1 ? "" : "s"} not shown as scripted`;
  }
  const noted =
    sessionOnly ||
    report.frames.degradations.length > 0 ||
    report.frames.storageRefused ||
    (report.look?.brandKitError ?? null) !== null ||
    (report.look?.wallpaperError ?? null) !== null;
  return noted ? `${clean}, with notes` : clean;
}

/**
 * What each kind of degradation cost the film, in the words the verdict line
 * uses. A `Record` over the compositor's own enum, so a kind added there and
 * not here fails to compile instead of reaching the line as nothing.
 */
const NOT_KEPT: Record<Degradation["kind"], string> = {
  keyframeOnly:
    "a stretch of motion was kept as stills because memory ran high",
  budgetBreach: "motion frames were skipped to stay inside the frame budget",
  occlusionPause: "capture paused while the replay window was covered",
  pageNeverSettled:
    "the page never settled before a step, so a frame may show it mid-change",
  surfaceMismatch:
    "a stretch of motion is missing — Chrome returned frames of the window rather than the page, and they were refused",
  encodeRefused: "a stretch of motion is missing — the encoder refused it",
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
};

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
  const kinds = [...new Set(report.frames.degradations)];
  const said = kinds.map((kind) => `${NOT_KEPT[kind]} (${kind})`);
  if (report.frames.storageRefused) {
    said.push("the frame store refused frames during the run (storageRefused)");
  }
  return said.length === 0
    ? ""
    : ` But not everything was kept: ${said.join("; ")}.`;
}

/** `verdictLine` without the storage clause: what the run itself has to say.
 *  Split the way `replayNotice`/`runNotice` are split, so the two clauses
 *  cannot be reordered by accident. */
function runVerdictLine(report: RunReport): string {
  if (report.outcome === "refused") {
    const reason = report.refused?.reason ?? "unknown";
    return `Refused: ${reason}.`;
  }
  if (report.outcome === "stopped") {
    const at = report.stopped?.at;
    // "after", not "at". `at.index` is `walk.completed` — a count of steps
    // that SUCCEEDED — so "Stopped at step 4 of 9" named step 4 while
    // `at.label` named step 5, the one that failed, and the two disagreed in
    // every stopped report. Printing `at.index + 1` instead would make the
    // number agree with the label but would claim step 1 was attempted on
    // every run that never opened a stage at all (`blankWalk`: completed 0),
    // which is the fabrication this branch's whole design rule forbids. So the
    // word is changed to match the number that is actually measured, and
    // `at.label` says which step it stopped ON.
    const where = at ? ` after step ${at.index} of ${at.of}` : "";
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
      ? "the take recorded"
      : "the script asked for";
  if (report.verdict.kind === "matches") {
    return `Complete: the video matches every step ${asked}.`;
  }
  const n = report.verdict.diverged.length;
  return `Complete: ${n} step${n === 1 ? "" : "s"} the video does not show the way ${asked} it.`;
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

/**
 * An authored run: an agent's script in, an ordinary take out.
 *
 * The document is assembled FROM the run, never handed to it. That ordering is
 * the whole design: a script declares intent, the run measures, and every
 * field that records a measurement — `resolution.strategy`, `candidates`,
 * `rect`, `timestamp`, `marker`, the page each step ran on — is written from
 * what happened. Nothing here may fabricate one; a run that could not measure
 * a field stops and says why instead of guessing.
 *
 * Two shapes of that rule are worth naming up front, because they are the ones
 * a reader will look for:
 *
 * - **A `click` records no `button`.** The script may ask for `middle` or
 *   `right`; `performVerb` dispatches a left button and nothing else. Copying
 *   the script's value into the document would claim a dispatch that did not
 *   happen, so the run refuses the step instead — `unperformableStep`.
 * - **A `hover` records no `signal`.** `MoveTo.signal` says how capture
 *   witnessed a hover changing the page. Nothing here witnessed that; the walk
 *   reports it separately, as `hoverSensitive`, from a repaint it measured.
 *
 * `pause` is the only step that resolves nothing: it sleeps and yields no walk
 * step, so it moves the clock without entering the log.
 */
import {
  type CursorSegment,
  cursorEntryPoint,
  type MadeFromStep,
  planCursorSegment,
  transformAt,
  VERBS,
  type Vec,
  type ViewportTransform,
} from "@demoman/compositor";
import { type AnchorIntent, RESOLVER_VERSION } from "@demoman/resolver";
import {
  CANVAS_DEFAULTS,
  type CaptureDevice,
  CURRENT_SCHEMA_VERSION,
  CURSOR_DEFAULTS,
  captureDeviceOf,
  type DemoScript,
  type DragSpot,
  deviceFor,
  type FailureReasonName,
  type SceneAction,
  type SceneAnchor,
  type SceneBranding,
  type SceneDocument,
  SceneDocumentSchema,
  type SceneZoomSkipped,
  type ScriptStep,
  type ScriptTarget,
  type StrategyName,
} from "@demoman/scene-schema";
import { rectCentre } from "./geometry.js";
import { classifyOrigin } from "./origin.js";
import { fingerprintFromTarget } from "./target.js";
import type { Rect, ReplayResult, ReplayStopReason } from "./types.js";
import {
  type EngineDeps,
  type RoomPolicy,
  runWalk,
  stopForResolveFailure,
  type WalkSource,
  type WalkStep,
} from "./walk.js";

/**
 * Why a capture round trip came back with no anchor.
 *
 * Structurally the extension's own `CaptureFailure`
 * (`apps/extension/src/adapters/resolve-bridge.ts`), declared again here
 * because this package cannot import from an app. The two are checked against
 * each other by the compiler where they meet: the adapter that wires
 * `askPageToCapture` into `captureResolved` below will not typecheck if they
 * drift.
 *
 * `"unresolved"` is the resolution ladder's own terminal "broken, with no more
 * specific verdict"; `"pageSilent"` is the page never answering at all; and
 * `"pageFaulted"` is the page answering that its own agent threw, which is
 * neither of those two and must not be collapsed into either.
 */
export type CaptureFailure =
  | FailureReasonName
  | "unresolved"
  | "pageSilent"
  | "pageFaulted";

/** How the agent's own intent resolved, beside the anchor rather than inside
 *  it — see `captureForIntent`'s docblock for why the two can legitimately
 *  disagree. Structurally the extension's `IntentResolution`. */
export interface IntentResolution {
  strategy: StrategyName;
  candidates: number;
  failureReason: FailureReasonName | null;
}

/**
 * What one capture round trip said. Structurally the extension's
 * `CaptureAnswer`.
 *
 * The two null cases are different facts and every consumer here keeps them
 * apart: `intentResolution: null` with `failureReason: "pageSilent"` means the
 * page never answered, and a populated `intentResolution` with `anchor: null`
 * means the page answered and resolved nothing.
 */
export interface IntentCapture {
  anchor: SceneAnchor | null;
  failureReason: CaptureFailure | null;
  intentResolution: IntentResolution | null;
  /**
   * The page the attempt was made on, non-null on exactly one path: the page
   * answered and resolved nothing. Null on success — `anchor.resolution.url`
   * is the same observation, read off the element that was actually found —
   * and null on silence, where there was no reply to carry it.
   *
   * This is what makes `pageWentElsewhere` reach the case it exists for. A
   * session that expires redirects the app to a login page, where the script's
   * next target does not exist at all: the capture FAILS, so there is no
   * anchor to read a URL from, and without this the run would report the
   * element gone and send the author to re-record a step that is fine.
   */
  pageUrl: string | null;
  /** From the CLI's capture (launch C): whether the field is a credential.
   *  Absent: this port does not check (the extension). Null: it could not
   *  tell. A `type` into anything but `false` or absent is stored redacted. */
  credentialField?: boolean | null;
}

/**
 * One step of the script, and everything the run measured about it.
 *
 * Only the source ever sees these facts together: by the time the walk is over
 * the intent, its resolution report and the rect it produced are gone, and the
 * document keeps only what a take is made of. The run report an agent reads
 * (`StepReport`) is built from this, so a step that failed has to be here too
 * — with the evidence of HOW it failed, which is the number and the strategy
 * the author acts on.
 *
 * There is one record per non-`pause` step the run ATTEMPTED, in order. A run
 * that stopped at step 2 of 5 has two records and not five: three steps it
 * never reached are not three failures.
 */
export interface AuthoredStep {
  /** Index in `script.steps`, so a reader can name the step that failed even
   *  though `pause` steps have no record of their own. */
  index: number;
  /** The script's own step, verbatim. */
  step: ScriptStep;
  /** The anchor this step's element was captured as — non-null only when the
   *  step's action reached the document, so it always names an anchor the
   *  document has. Null when nothing was captured, and also when something was
   *  captured and the step then stopped the run: the measurement is below,
   *  where it is evidence rather than a dangling reference. */
  anchorId: string | null;
  /** The action this step became, or null when it never reached the document. */
  actionId: string | null;
  /** Why this step's typed text is not in the take, or null/absent when it
   *  is (launch C). */
  textHidden?: "credentialField" | "credentialUnchecked" | null;
  /** What strategy actually won for the agent's intent, and against how many
   *  candidates. Null when the page never answered — which is a different fact
   *  from "answered, resolved nothing", where both are populated. */
  strategy: StrategyName | null;
  candidates: number | null;
  /** Why the capture produced no anchor. Null when it produced one. */
  failureReason: CaptureFailure | null;
  /**
   * Where the element was — and WHICH measurement, which depends on how the
   * step ended. The field carries no discriminator of its own, so this says
   * what each path leaves here:
   *
   * - a positioned step the walk performed: the walk's own post-scroll rect,
   *   handed to `onResolved` and committed once the walk has performed the
   *   step. This is the rect the frames show and the one a camera aims at.
   * - a `waitFor`: the page's own measurement at capture, which is the only
   *   rect a wait ever has (the walk neither scrolls to nor re-measures a
   *   wait's element).
   * - a positioned step that CAPTURED and then stopped the run — the
   *   `pageWentElsewhere` check between the capture and the yield, or a walk
   *   that stopped before it performed the step (a break before `onResolved`,
   *   or a throw after it): the page's capture rect too, because nothing the
   *   walk measured was committed. Kept rather than nulled: it is a real
   *   measurement the page made, and dropping it would lose the only evidence
   *   of where that step's element was.
   * - null when nothing was measured.
   *
   * `actionId` is as close to a discriminator as this record has: null means
   * the walk never committed the step, so any rect here is the page's. Non-null
   * does NOT imply the walk's, because a `waitFor` is committed with the page's.
   */
  rect: Rect | null;
  /** The action's marker name, or null when the step never became an action. */
  marker: string | null;
  /** The page the element was captured on, as the page itself reported it.
   *  The evidence behind `pageWentElsewhere`: without it that reason says a
   *  move happened and not where to. */
  pageUrl: string | null;
}

export interface AuthoredDeps extends Omit<EngineDeps, "madeFrom" | "room"> {
  /**
   * Unhurried beats (spec 2026-10-19): the room policy for this run's
   * viewport, which only the caller can build (the zoom rule and the
   * take's motion live above this package). Absent: no act ends, no waits.
   */
  roomFor?(viewport: { width: number; height: number }): RoomPolicy;
  /**
   * Resolves an intent against the live page and captures a real anchor from
   * whatever it found. Task 5's round trip in the extension
   * (`askPageToCapture`); a page-agent entry in the headless runner.
   *
   * **The anchor it hands back must carry the intent's own `id`.** The run
   * mints that id, the action it synthesizes names it as its `anchorId`, and
   * the page parks the element under it for the walk to find — so an
   * implementation that minted an id of its own would produce a document whose
   * action points at an anchor it does not have, which the schema refuses (and
   * `AuthoredResult.documentError` then reports). The extension satisfies this
   * at `captureForIntent`, which passes `anchorId: intent.id` into
   * `captureAnchor`; a runner-side implementation owes the same.
   */
  captureResolved(intent: AnchorIntent): Promise<IntentCapture>;
  /** Unique per call, for the life of the run: anchor ids and action ids are
   *  both required to be unique within a document, and the schema refuses a
   *  duplicate. */
  newId(prefix: string): string;
  /**
   * The take's id, minted by the caller rather than here.
   *
   * The caller needs it whatever happens: keyframes are written under it
   * DURING the run, so a run that assembles no document has still left frames
   * in the store, and an id the caller never learned is an orphan nothing can
   * find or sweep.
   */
  sceneId: string;
  /** ISO 8601, from the caller. Same split `finalize` makes and for the same
   *  reason: this package has no wall clock, and `Clock.now()` is contracted
   *  only to make deltas (the walk reads it for nothing else). */
  createdAt: string;
  /** The run's own window size, recorded into the document and asserted onto
   *  the page. Only the caller knows it, which is exactly what
   *  `DemoScript.viewport`'s docblock means by "absent means the run's own
   *  window size" — so `script.viewport` overrides this and nothing invents a
   *  default in between. Absent when the script names a device, which is
   *  its own size (spec 2026-10-10 §3); a run with neither is refused. */
  viewport?: { width: number; height: number };
  /** The display scale the caller's browser films motion at, which only it
   *  decided (`meta.capture.displayScale`). Absent when it does not know. */
  displayScale?: number;
  /**
   * The take's branding when the script names none (`look.branding` wins).
   * The caller's, because only the caller can read the author's brand kit:
   * the extension passes the kit's snapshot (`brandingForTake`), which is
   * what a recorded take gets at finalize, and `BRANDING_DEFAULTS` when there
   * is no kit. Never defaulted here — a default in this package is how an
   * agent-made take came to skip the kit in the first place.
   */
  startingBranding: SceneBranding;
  /**
   * The take's camera track, from the actions the run performed: the
   * extension's `zoomsForClicks`, a zoom on every click, which is what a
   * recorded take opens with. A dependency rather than an import because it
   * lives in the extension, not in any package this one can reach.
   * `viewport` is the run's: the zooms are fitted to what it showed.
   *
   * With the camera come the clicks it left out and why, which the take
   * carries as `zoomsSkipped` for the editor's take notes — one return, so
   * the reasons cannot be dropped between the planner and the document.
   */
  cameraFor(
    actions: SceneAction[],
    viewport: { width: number; height: number },
    /** The page's zoom at an action (`ViewportTransform`): a click's rect
     *  is in the page's own px, which a zoomed-out page shows smaller. */
    scaleAt: (action: SceneAction) => number,
  ): CameraPlan;
}

/** What `AuthoredDeps.cameraFor` answers: the zooms, and every click they
 *  left without one. */
export interface CameraPlan {
  camera: SceneDocument["camera"];
  zoomsSkipped: SceneZoomSkipped[];
}

export interface AuthoredResult extends ReplayResult {
  /**
   * The take the run produced, or null when there is no take to produce.
   *
   * Null in two cases, which `documentError` tells apart: no step reached the
   * document at all — **a document with no performed step is not a take**, and
   * an empty one would make a failed run indistinguishable from a script that
   * asked for nothing — or the assembler built something the schema refused.
   */
  document: SceneDocument | null;
  /** Non-null only on the second of those: what the schema said. A caller that
   *  saw `document: null` and no reason could not tell an engine bug from an
   *  empty run. */
  documentError: string | null;
  /** What the run measured per attempted step. See `AuthoredStep`. */
  steps: AuthoredStep[];
}

/**
 * How many walk steps an authored source will yield, which is what
 * `WalkConfig.total` is measured against.
 *
 * `pause` is excluded because it yields nothing — it is a duration, not a beat
 * — so `steps.length` would report a run as partial for finishing.
 *
 * The other direction is the one `WalkConfig.total`'s docblock warns about: a
 * source that yields a different number than it declared misreports how far
 * the run got. Under-yielding is fine and is the mechanism, not a defect —
 * stopping early is how the source reports a failure, and `completed < total`
 * is precisely the run being partial. Over-yielding is what would lie, and
 * cannot happen: the source yields at most one step per non-`pause` script
 * step, from a single pass over `script.steps`.
 */
export function authoredTotal(script: DemoScript): number {
  return script.steps.filter((step) => step.do !== "pause").length;
}

/** A step that names an element, which is every step but `waitForLoad` and
 *  `pause`. */
type PositionedStep = Extract<ScriptStep, { on: ScriptTarget }>;

/** The step's target, whichever key it lives under: a drag's is where it
 *  presses. */
function targetOf(step: ElementStep): ScriptTarget {
  if ("into" in step) return step.into;
  if ("from" in step) return step.from.on;
  return step.on;
}

type TypeStep = Extract<ScriptStep, { do: "type" }>;
type DragStep = Extract<ScriptStep, { do: "drag" }>;
/** Every step that acts on an element. */
type ElementStep = PositionedStep | TypeStep | DragStep;

/**
 * A page's identity for "did the run leave it": the URL without its hash,
 * because an in-page anchor jump is not a new page.
 *
 * The same rule the compositor applies to a recorded take's `urlTrace`
 * (`plan/scene-walk.ts`'s `pageKey`), which is module-private there. Restated
 * rather than exported across a package boundary for one caller: it is three
 * lines of string handling over a stable convention, and a divergence between
 * the two would change nothing either one concludes.
 */
function pageKeyOf(url: string): string {
  const hash = url.indexOf("#");
  return hash === -1 ? url : url.slice(0, hash);
}

/** The stop reason a capture failure earns. Everything the resolver can say
 *  goes through the walk's own table, so an authored tie and a replayed tie
 *  report the same reason; `"unresolved"` is the ladder's terminal verdict,
 *  which is what `unresolvedAnchor` already means. */
function reasonForCaptureFailure(
  failureReason: CaptureFailure | null,
): ReplayStopReason {
  return failureReason === "unresolved"
    ? "unresolvedAnchor"
    : stopForResolveFailure(failureReason);
}

/** The document kind each script verb performs. */
function kindOf(step: ElementStep): SceneAction["kind"] {
  switch (step.do) {
    case "click":
      return "click";
    case "type":
      return "type";
    case "hover":
      return "moveTo";
    case "scrollTo":
      return "scrollTo";
    case "waitFor":
      return "waitFor";
    case "drag":
      return "drag";
    default: {
      // Exhaustive: a verb added to the script and not here must not film
      // as a wait.
      const unknown: never = step;
      throw new Error(`kindOf: no kind for ${JSON.stringify(unknown)}`);
    }
  }
}

/** A `SceneAction` of the step's own kind. No `rect`: it is assigned when the
 *  run measures one, and absent means the sighting had no rect. */
function synthesize(
  step: ElementStep,
  ids: { id: string; anchorId: string; timestamp: number; marker: string },
  hidden = false,
): SceneAction {
  const base = { ...ids };
  switch (step.do) {
    case "click":
      // `button` deliberately omitted — see this module's own docblock.
      return { ...base, kind: "click" };
    case "type":
      // `redacted: false` and a real `text`: an agent's value is a demo value
      // by construction, and there is no sensor here to have declined to read
      // one — except into a credential field (launch C): the run still types
      // it, and the take keeps no copy, as a recorded take's sensor would not.
      // `host` is likewise absent — a contenteditable is something capture
      // observes about a field, not something a script can say.
      return hidden
        ? { ...base, kind: "type", text: null, redacted: true }
        : { ...base, kind: "type", text: step.text, redacted: false };
    case "hover":
      // `signal` omitted — see this module's own docblock.
      return { ...base, kind: "moveTo" };
    case "scrollTo":
      return { ...base, kind: "scrollTo" };
    case "waitFor":
      return { ...base, kind: "waitFor", condition: step.until };
    case "drag":
      // The end's anchor and rect are the walk's to measure.
      return {
        ...base,
        kind: "drag",
        toAnchorId: null,
        ...(step.from.at === undefined ? {} : { fromAt: step.from.at }),
        to: "by" in step.to ? { by: step.to.by } : { at: step.to.at },
      };
    default: {
      const unknown: never = step;
      throw new Error(`synthesize: no action for ${JSON.stringify(unknown)}`);
    }
  }
}

/** A navigation wait: it names no element, so `anchorId` is null and the
 *  condition is the one only a document can satisfy. */
function navigationWait(ids: {
  id: string;
  timestamp: number;
  marker: string;
}): SceneAction {
  return { ...ids, anchorId: null, kind: "waitFor", condition: "loaded" };
}

/** Everything the source accumulates, and the reason it stopped. */
interface AuthoredRun {
  source: WalkSource;
  /** Live: appended as the run goes, complete once the walk has finished. */
  steps: AuthoredStep[];
  actions: SceneAction[];
  anchors: SceneAnchor[];
  madeFrom: MadeFromStep[];
  /** Why the SOURCE stopped, or null. Not the walk's own reason. */
  stop(): ReplayStopReason | null;
  firstCursor: Vec;
}

/**
 * The authored source: per script step it builds an intent, captures what the
 * page found, and only then synthesizes the action and its cursor move.
 *
 * Exported // test-only, see header: the tests drive this generator directly
 * with a fake `captureResolved` and a fake clock. There is no CDP, encoder or
 * store harness in this package, and everything below is orchestration around
 * injected dependencies — `runAuthored` end to end is the extension's
 * integration lane and the author's manual pass.
 *
 * **When an action reaches the document**, because it is the one contract
 * between this file and the walk:
 *
 * Every step commits AFTER its `yield`, which is reached only if the walk came
 * back for another step — and the walk comes back only once it has performed
 * and counted the one it was handed. Any way the walk can end a step without
 * counting it (a timeout, a lost element, a throw from a port) breaks its
 * loop, which finalizes this generator at the `yield` without resuming past
 * it, so nothing is committed for that step. That is the whole mechanism; it
 * is deliberate and not incidental. So `actions` and `madeFrom` hold exactly
 * the steps `completed` counts, and `lastCompletedActionId` is the last of
 * them.
 *
 * - A positioned step's `onResolved` only records the rect the walk measured
 *   after scrolling. The cursor path, the keyframe and the verb all come after
 *   it, and any of them can throw — committing there put a click into the take
 *   that never ran, and that a rebuild would then perform.
 * - A wait whose element must be captured after it does that capture in
 *   `onConditionMet`, which the walk asks before it marks or counts the wait.
 *   A capture that fails refuses the wait there, with its reason, so the walk
 *   stops without having counted a step the take will not contain.
 */
export function createAuthoredRun(
  script: DemoScript,
  deps: AuthoredDeps,
  viewport: { width: number; height: number },
): AuthoredRun {
  const steps: AuthoredStep[] = [];
  const actions: SceneAction[] = [];
  const anchors: SceneAnchor[] = [];
  const madeFrom: MadeFromStep[] = [];
  let stop: ReplayStopReason | null = null;

  // The take's own time base: every stamp is a delta on the injected clock, so
  // the log ascends by construction and the first action lands near zero the
  // way a recorded take's does. `Clock.now()` is contracted for deltas only,
  // which is also why `createdAt` is the caller's to supply.
  //
  // Not clamped to zero. A clock that has gone backwards past the run's own
  // start is a gross anomaly, and clamping would hand back a take with a step
  // stamped 0 and nothing to say it had happened; left alone, the schema
  // refuses the document on `timestamp` and `documentError` names the field.
  const origin = deps.clock.now();
  const stamp = (): number => deps.clock.now() - origin;

  // The same naming `reduce` gives a recorded take's markers
  // (`apps/extension/src/core/reduce.ts`): the verb and what it acted on, with
  // an ordinal for a repeat. A random id would satisfy the schema and fork the
  // meaning of a persisted field for authored takes alone. The ordinal is live
  // for repeated `waitForLoad` steps, which all name the document.
  const markerCounts = new Map<string, number>();
  const markerFor = (kind: string, anchorId: string | null): string => {
    const base = `${kind}:${anchorId ?? "document"}`;
    const count = (markerCounts.get(base) ?? 0) + 1;
    markerCounts.set(base, count);
    return count === 1 ? base : `${base}#${count}`;
  };

  // Where the cursor enters. A decision, not a measurement — no port here can
  // say where the pointer is, and the samples the bundle records are the ones
  // actually dispatched either way. The compositor's own approach rule, applied
  // to the middle of the viewport because an authored run cannot know its first
  // target's rect before it has run (see `cursorEntryPoint`).
  const firstCursor = cursorEntryPoint(
    { x: viewport.width / 2, y: viewport.height / 2 },
    viewport,
  );
  let cursor: Vec = firstCursor;
  let segments = 0;
  let previousActionId: string | null = null;

  /** The page the run is performing against, as the page reported it. Adopted
   *  from the first capture and re-adopted at every wait — the two verbs with
   *  which a script says "this page is about to become something else". */
  let herePage: string | null = null;

  const commit = (
    action: SceneAction,
    anchor: SceneAnchor | null,
    record: AuthoredStep,
    rect: Rect | null,
  ): void => {
    if (rect !== null) action.rect = rect;
    if (anchor !== null) {
      // `actionIndex` is the one field of a captured anchor's `resolution` the
      // run fills in, and it is not part of the capture's own self-check: the
      // page had no step index to record (`captureForIntent` writes 0 and says
      // so), and the run is the only thing that knows it. Everything else —
      // strategy, candidates, failureReason, entryState, url — is carried
      // exactly as the page measured it.
      //
      // Copied rather than assigned into: the answer belongs to whoever handed
      // it over, and a run that edits its caller's object in place is a
      // surprise waiting for the first caller that keeps one.
      anchors.push({
        ...anchor,
        resolution: { ...anchor.resolution, actionIndex: actions.length },
      });
      record.anchorId = anchor.id;
    }
    actions.push(action);
    // The four facts `madeFromOf` reads off a finished document, written per
    // step because an authored run has no document until the walk is over.
    // `authored.test.ts` asserts this equals `madeFromOf(document)` so the two
    // cannot drift apart in silence.
    madeFrom.push({
      actionId: action.id,
      kind: action.kind,
      anchorId: action.anchorId,
      text: action.kind === "type" ? action.text : null,
    });
    record.actionId = action.id;
    // Beside `actionId`, and for one reason: a marker is the name of something
    // the take HAS. Set at synthesis it would name an action the document does
    // not hold and frames nobody harvested — a step the walk pulled and never
    // performed never reaches `commit` at all, so it carries no marker and
    // Task 7 cannot hand an agent an identifier it has nothing to join to.
    //
    // This is reached only after the walk has pushed its own marker for the
    // step, shot it and counted it (see this generator's docblock), so a
    // committed action always has a bundle marker of the same name. It used to
    // be reached from `onResolved`, before `dispatchPath`, and a throw there
    // committed an action — and this marker — the walk never performed. The
    // converse does not hold: a throw AFTER the walk's `markers.push` (the
    // shot, the verb) leaves a bundle marker for a step this never commits.
    // `provenance`/`verdict` remains where "is this step in the film" is
    // answered, from the frames' own `madeFrom`.
    record.marker = action.marker;
    record.rect = rect;
  };

  const source: WalkSource = {
    async *steps(): AsyncGenerator<WalkStep> {
      for (const [index, step] of script.steps.entries()) {
        if (step.do === "pause") {
          // The clock moves and nothing enters the log. A duration, not a beat.
          await deps.clock.sleep(step.ms);
          continue;
        }

        const record: AuthoredStep = {
          index,
          step,
          anchorId: null,
          actionId: null,
          textHidden: null,
          strategy: null,
          candidates: null,
          failureReason: null,
          rect: null,
          marker: null,
          pageUrl: null,
        };
        steps.push(record);

        if (step.do === "waitForLoad") {
          const action = navigationWait({
            id: deps.newId("ac"),
            timestamp: stamp(),
            marker: markerFor("waitFor", null),
          });
          // The document this lands on is a page nothing has measured yet, so
          // the next capture adopts whatever it reports.
          herePage = null;
          yield { action, target: null, segment: undefined, text: null };
          commit(action, null, record, null);
          continue;
        }

        if (step.do === "click") {
          // The backstop, because scripts arrive from an agent and this is the
          // last line. `ScriptStepSchema` has no `button` and REFUSES one, so
          // the only way a step reaches here carrying it is a caller that
          // skipped the parse — and `performVerb` dispatches a left button and
          // nothing else, so performing it as a left click and then recording
          // whatever it asked for is the fabrication this door exists to
          // avoid. Read off the runtime shape, since the type no longer has it.
          const button = (step as { button?: unknown }).button;
          if (button !== undefined && button !== "left") {
            stop = "unperformableStep";
            return;
          }
        }

        const intent: AnchorIntent = {
          id: deps.newId("an"),
          fingerprint: fingerprintFromTarget(targetOf(step)),
        };

        let credential: boolean | null | undefined;
        const capture = async (): Promise<SceneAnchor | null> => {
          const answer = await deps.captureResolved(intent);
          credential = answer.credentialField;
          // Here, not at the action: a capture that fails, or a step that
          // stops after it (another page), still leaves the record knowing
          // its text is not to be written down.
          if (step.do === "type") {
            record.textHidden =
              credential === undefined || credential === false
                ? null
                : credential === true
                  ? "credentialField"
                  : "credentialUnchecked";
          }
          record.strategy = answer.intentResolution?.strategy ?? null;
          record.candidates = answer.intentResolution?.candidates ?? null;
          record.failureReason = answer.failureReason;
          if (answer.anchor === null) {
            // The page the attempt was made on, where the reply carries it: a
            // page that never answered carries nothing, and there is no anchor
            // to read it from. `stopForFailedCapture` is what reads it.
            record.pageUrl = answer.pageUrl;
            return null;
          }
          record.failureReason = null;
          record.pageUrl = answer.anchor.resolution.url;
          record.rect = answer.anchor.fingerprint.boundingRect;
          return answer.anchor;
        };

        /**
         * What a failed capture stops the run with.
         *
         * The page it failed on, where that is a different page from the one
         * the run was performing against — which is the whole expired-session
         * case: the app redirected, the script's target does not exist on the
         * page it landed on, so there is no anchor to compare and the only
         * witness is the URL the failure itself carries. The resolver's own
         * verdict otherwise.
         */
        const stopForFailedCapture = (): ReplayStopReason =>
          record.pageUrl !== null &&
          herePage !== null &&
          pageKeyOf(record.pageUrl) !== herePage
            ? "pageWentElsewhere"
            : reasonForCaptureFailure(record.failureReason);

        if (step.do === "waitFor") {
          // Captured wherever the element is actually present, which is a
          // different instant for the two conditions: before the wait for one
          // that is going away, after it for one that has not arrived. So the
          // attempt is made on both sides rather than branching on `until`,
          // and a step whose element is already there costs one round trip.
          let anchor = await capture();
          const foundBeforeTheWait = anchor !== null;
          const action = synthesize(step, {
            id: deps.newId("ac"),
            anchorId: intent.id,
            timestamp: stamp(),
            marker: markerFor("waitFor", intent.id),
          });
          // The captured anchor where there is one, for the reason below, and
          // the bare intent otherwise — for `until: "visible"` there may be
          // nothing to have captured yet, and an intent naming no frame hop
          // cannot be polled for inside an iframe. That is the one shape this
          // door cannot wait for, and it reports `waitTimeout` like any other
          // condition the page never reached.
          yield {
            action,
            target: anchor ?? intent,
            segment: undefined,
            text: null,
            // Asked by the walk once the condition was met and before it
            // counts the wait — which is why the post-wait capture lives here
            // and not after the `yield`: by the time the walk resumes this
            // generator it has already marked, photographed and counted the
            // step, and a refusal made then would leave the run reporting a
            // wait the take does not contain.
            onConditionMet: async () => {
              if (anchor === null) anchor = await capture();
              if (anchor !== null) return null;
              // The wait itself succeeded; what failed is recording WHAT it
              // waited for, and an action referring to an anchor the document
              // does not have is not a take. So the step is refused, and the
              // reason says which of the two happened.
              stop = stopForFailedCapture();
              return stop;
            },
          };
          // Reached only because the walk came back, which it only does when
          // the condition was met AND `onConditionMet` accepted it — so the
          // anchor is there. A walk that resumed without asking broke the
          // contract above, and that is said rather than papered over.
          if (anchor === null) {
            throw new Error(
              "the walk resumed past a wait without asking onConditionMet",
            );
          }
          // Where the wait LEFT the run, and only the post-wait capture can
          // say: an element that was already there BEFORE the wait says
          // nothing about where the page ended up — "Dashboard" may well be a
          // nav link the old page has too — and adopting its page would trip
          // the comparison on the next step and tell the author to add the
          // `waitForLoad` they already wrote. So that case defers to the next
          // capture exactly as `waitForLoad` does.
          herePage = foundBeforeTheWait
            ? null
            : pageKeyOf(anchor.resolution.url);
          commit(action, anchor, record, anchor.fingerprint.boundingRect);
          continue;
        }

        const anchor = await capture();
        if (anchor === null) {
          // Report, do not forgive: the walk needs a step to stop on, and the
          // REASON is what the author acts on. Yielding a step with a null
          // target would stop the run under "the element is gone" whatever
          // actually happened — a silent page, a tie, a row not rendered yet,
          // or a page that is no longer the one the script was written for.
          stop = stopForFailedCapture();
          return;
        }

        const page = pageKeyOf(anchor.resolution.url);
        if (herePage === null) herePage = page;
        else if (page !== herePage) {
          // Measured, not inferred: two captures, two pages, and nothing in
          // the script between them asked for the move. Performing the rest of
          // a script against a document it was not written for is how a run
          // reports four missing elements for one expired session.
          stop = "pageWentElsewhere";
          return;
        }

        // A drag's end, captured as its start was, so the take names what it
        // dropped on. An offset names nothing and has no anchor.
        let endAnchor: SceneAnchor | null = null;
        if (step.do === "drag" && "on" in step.to) {
          const answer = await deps.captureResolved({
            id: deps.newId("an"),
            fingerprint: fingerprintFromTarget(step.to.on),
          });
          if (answer.anchor === null) {
            record.failureReason = answer.failureReason;
            record.pageUrl = answer.pageUrl;
            stop = stopForFailedCapture();
            return;
          }
          endAnchor = answer.anchor;
        }
        let measuredEnd = null as Rect | null;
        let pressedAt: DragSpot | undefined;

        const action = synthesize(
          step,
          {
            id: deps.newId("ac"),
            anchorId: anchor.id,
            timestamp: stamp(),
            marker: markerFor(kindOf(step), anchor.id),
          },
          record.textHidden !== null && record.textHidden !== undefined,
        );

        // Set by `onResolved`. Cast so the checker does not narrow it to the
        // `null` it starts as: it is written inside a callback it cannot see.
        let measured = null as Rect | null;
        yield {
          action,
          // The captured ANCHOR, not the intent that found it. The walk reads
          // `fingerprint.treePath` for the frame hops that tell it which
          // execution context to look in, and an intent has none — so an
          // element the page found inside an iframe would be looked for in the
          // top document and reported `anchorUnreachable`. The anchor is also
          // the richer fingerprint, and `captureAnchor`'s own self-check has
          // already confirmed it resolves back to the element it came from.
          target: anchor,
          // Planned now, from the rect the page just measured. A document
          // source reads this from `planScene`; an authored run cannot — the
          // rect did not exist until the steps before it had run. Both ends
          // are re-pinned by `retargetSegment` to where the cursor is and
          // where the walk's own measurement says the target is.
          segment: VERBS[action.kind].cursorTravels
            ? segmentTo(
                cursor,
                anchor.fingerprint.boundingRect,
                segments,
                previousActionId,
                action.id,
              )
            : undefined,
          text: step.do === "type" ? step.text : null,
          ...(step.do === "drag"
            ? {
                drag: {
                  fromAt: step.from.at,
                  to: "by" in step.to ? { by: step.to.by } : { at: step.to.at },
                  end: endAnchor,
                  onEnd: (rect: Rect, spot?: DragSpot) => {
                    measuredEnd = rect;
                    pressedAt = spot;
                  },
                },
              }
            : {}),
          // Intent, handed to the walk's aim — not written into `action.rect`,
          // which stays the rect the run measured (`commit`), so the produced
          // take claims no evidence it did not witness.
          ...(step.do === "scrollTo" && step.landing !== undefined
            ? { landing: step.landing }
            : {}),
          // A measurement only. The walk calls this before it dispatches the
          // cursor path, settles, shoots and performs the verb, and any of
          // those can still throw — so committing here put steps into the
          // take that never ran (and that a rebuild would then perform).
          onResolved: (rect) => {
            measured = rect;
          },
        };
        // Reached only because the walk came back for another step, which it
        // does only after the verb was performed and the step counted. A throw
        // anywhere in between finalizes this generator at the `yield`, and the
        // step is never committed — the same mechanism a wait relies on.
        if (measured === null) {
          throw new Error(
            "the walk resumed past a positioned step without calling onResolved",
          );
        }
        // The rect the FRAMES show, which is the one a camera aims at, and the
        // one the walk re-measured after scrolling. Only a step the cursor
        // travels to moves the tracked cursor: a scroll leaves it where it was
        // (VERBS), so the next move must be planned from there, not from the
        // scroll's anchor.
        if (VERBS[action.kind].cursorTravels) {
          cursor = rectCentre(measured);
          segments++;
          previousActionId = action.id;
        }
        if (action.kind === "drag") {
          // The cursor ends where the drag let go, and the end is part of
          // the take: its anchor, and the box the walk measured it at.
          if (measuredEnd !== null) {
            action.toRect = measuredEnd;
            cursor = rectCentre(measuredEnd);
          }
          if (pressedAt !== undefined) action.pressedAt = pressedAt;
          if (endAnchor !== null) {
            action.toAnchorId = endAnchor.id;
            anchors.push({
              ...endAnchor,
              resolution: {
                ...endAnchor.resolution,
                actionIndex: actions.length,
              },
            });
          }
        }
        commit(action, anchor, record, measured);
      }
    },
  };

  return {
    source,
    steps,
    actions,
    anchors,
    madeFrom,
    stop: () => stop,
    firstCursor,
  };
}

/** The cursor move from here to the measured rect, or undefined when there is
 *  no rect to aim at — the walk then dispatches no path, exactly as it does
 *  for a planned segment that is missing. */
function segmentTo(
  from: Vec,
  rect: Rect | null,
  index: number,
  fromActionId: string | null,
  toActionId: string,
): CursorSegment | undefined {
  if (rect === null) return undefined;
  return planCursorSegment({
    from,
    to: rectCentre(rect),
    index,
    fromActionId,
    toActionId,
  });
}

/**
 * The take, assembled from what the run measured.
 *
 * Null when no step reached the document: **a document with no performed step
 * is not a take**, and handing back an empty one would make a failed run
 * indistinguishable from a script that asked for nothing.
 *
 * What is empty here is empty because nothing observed it, and that is stated
 * per field below rather than left to be read as a default. The one field that
 * is a judgement rather than an observation is `flags.mutating`, and it fails
 * closed for `finalize`'s reason: with no network log we cannot know the run
 * was read-only, and guessing is the failure that double-submits a checkout.
 * An authored run collects no network log at all, so it lands in exactly the
 * state a recorded take whose author declined the network permission does —
 * `mutating: true` with an empty `writes`, which `ReplayPolicy.mutating`
 * documents as a real and expected pair.
 *
 * Exported // test-only, see header.
 */
export function assembleAuthored(
  script: DemoScript,
  args: {
    sceneId: string;
    createdAt: string;
    viewport: { width: number; height: number };
    actions: SceneAction[];
    anchors: SceneAnchor[];
    walked: ReplayResult;
    startingBranding: SceneBranding;
    camera: CameraPlan;
    /** The device the run filmed as; absent for the desktop. */
    device?: CaptureDevice;
    /** The caller's display scale; absent when it does not know. */
    displayScale?: number;
  },
): { document: SceneDocument | null; error: string | null } {
  if (args.actions.length === 0) return { document: null, error: null };

  const document: SceneDocument = {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    meta: {
      id: args.sceneId,
      name: script.name,
      createdAt: args.createdAt,
      toolchain: {
        // The version that resolved every one of this run's intents. The other
        // two are null because nothing here has them: no frames were composed,
        // and the capture harness that captured these anchors is the caller's,
        // whose version this package cannot see.
        resolverVersion: RESOLVER_VERSION,
        compositorVersion: null,
        captureVersion: null,
      },
      capture: {
        originUrl: script.target,
        originClass: classifyOrigin(script.target),
        // Nothing read a build identity: the capture round trip carries none.
        // Null is what "none was read" already means here.
        buildSha: null,
        buildShaSource: null,
        viewport: args.viewport,
        // Both from the run: the DPR the walk emulated and the viewport it
        // asserted onto the page.
        dpr: args.walked.counters.dpr,
        mode: "authored",
        ...(args.device === undefined ? {} : { device: args.device }),
        ...(args.displayScale === undefined
          ? {}
          : { displayScale: args.displayScale }),
      },
      // The frames this take has are its own, which is what `screen` means —
      // the same value `finalize` writes for every new take. A Rebuild of it
      // later sets `demo` itself if it completes.
      renderMode: "screen",
    },
    anchors: args.anchors,
    actions: args.actions,
    // The caller's (`AuthoredDeps.cameraFor`): a zoom on every click, as a
    // recorded take opens with. Spec 2026-10-01 §1.2. The clicks it left out
    // ride beside it, as `finalize` writes them: only when there is one.
    camera: args.camera.camera,
    ...(args.camera.zoomsSkipped.length > 0
      ? { zoomsSkipped: args.camera.zoomsSkipped }
      : {}),
    // Nothing has edited this take: it is one second old.
    edits: { masks: [], holds: [], gaps: [], splits: [], removed: [] },
    // Nothing observed any of these. The walk has no network, console or
    // navigation collector, and an entry in `urlTrace` would have to claim an
    // instant the run never measured — it only knows which page each step's
    // element was found on, which is the witness `pageChangeAfter` already
    // reads off the anchors themselves. `uncoveredOrigins` stays empty because
    // it says which origins a log MISSED, and there is no log to have missed
    // them; the tag that fact feeds is `mutating` below, which is already true.
    sideChannels: {
      network: [],
      consoleExcerpt: [],
      urlTrace: [],
      uncoveredOrigins: [],
    },
    flags: {
      // Fails closed. See this function's own docblock.
      mutating: true,
      // The walk's own measurement: a hover that repainted the page.
      hoverSensitive: args.walked.hoverSensitive,
    },
    branding: script.look?.branding ?? args.startingBranding,
    cursor: script.look?.cursor ?? CURSOR_DEFAULTS,
    canvas: script.look?.canvas ?? { ...CANVAS_DEFAULTS },
    // The script's camera, when it names one; absent reads as
    // `MOTION_DEFAULTS` on the document, as it does on the script, so a
    // missing key stays missing rather than being written out as defaults.
    ...(script.look?.motion === undefined
      ? {}
      : { motion: script.look.motion }),
  };

  // Self-validating, as `finalize` is: nothing leaves this door that the
  // schema would reject. Reported rather than thrown, because a throw here
  // would lose the whole `ReplayResult` — the counters, the bundle and the
  // stop reason — for a caller that has frames on disk and needs to hear
  // about them.
  const parsed = SceneDocumentSchema.safeParse(document);
  if (parsed.success) return { document: parsed.data, error: null };
  return {
    document: null,
    error: `the take assembled from ${args.actions.length} performed step(s) was refused by the schema: ${parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ")}`,
  };
}

/**
 * One authored run: drive the page from the script, and hand back the take it
 * produced.
 */
/**
 * `actions` with each timestamp less every `roomMs` the walk added up to and
 * including its own marker (spec 2026-10-19): the take's time as if the
 * replay had not waited for the camera. Copies; the take keeps real time.
 */
export function unwaitedActions(
  actions: SceneAction[],
  markers: readonly {
    actionId: string;
    sourceTimeMs: number;
    roomMs?: number;
  }[],
): SceneAction[] {
  const roomThrough = new Map<string, number>();
  let added = 0;
  for (const m of markers) {
    added += m.roomMs ?? 0;
    roomThrough.set(m.actionId, added);
  }
  return actions.map((action) => ({
    ...action,
    timestamp: action.timestamp - (roomThrough.get(action.id) ?? 0),
  }));
}

/**
 * What `cameraFor` is handed after a run with room in it: the actions on
 * un-waited time (`unwaitedActions`), and the page's zoom at each, read at
 * the action's REAL time, because that is the clock the viewport transforms
 * were recorded on (final review I1, 2026-10-19).
 */
export function cameraInputs(
  actions: SceneAction[],
  markers: readonly {
    actionId: string;
    sourceTimeMs: number;
    roomMs?: number;
  }[],
  transforms: readonly ViewportTransform[],
  /**
   * What the walk decided each click's zoom on (`RoomPolicy.zooms`): its
   * predicted un-waited time and the page zoom it read. Where one exists,
   * the take decides on exactly that, so it cannot disagree with the walk
   * near `MIN_ZOOM_GAP_MS` (code review 2026-10-20, R6).
   */
  decided: ReadonlyMap<
    string,
    { unwaitedMs: number; scale: number }
  > = new Map(),
): { actions: SceneAction[]; scaleAt: (action: SceneAction) => number } {
  const realAt = new Map(actions.map((a) => [a.id, a.timestamp]));
  return {
    actions: unwaitedActions(actions, markers).map((action) => {
      const d = decided.get(action.id);
      return d === undefined ? action : { ...action, timestamp: d.unwaitedMs };
    }),
    scaleAt: (action) =>
      decided.get(action.id)?.scale ??
      transformAt(transforms, realAt.get(action.id) ?? action.timestamp)
        ?.scale ??
      1,
  };
}

/**
 * Each committed action's `timestamp`, moved to its marker: the instant the
 * frames show it, on the frames' own clock.
 *
 * The source stamps an action when its step is pulled, before the walk has
 * located the element, moved the cursor or settled, and from an origin of its
 * own; the walk marks it after all of that. A capture take's markers ARE its
 * timestamps (`bundleFromCapture`), and `planScene` reads a recorded pace as
 * `to.timestamp - from.timestamp` against an idle measured between markers —
 * so in a sampled film every step froze for about the previous step's move,
 * 652ms after a 640ms hover on the film lane's long page (2026-10-07).
 *
 * A committed action always has a marker (see `commit`), so one without is
 * the walk breaking that contract, and it is said rather than left stamped
 * on the other clock.
 */
function stampAtMarkers(
  actions: SceneAction[],
  markers: readonly { actionId: string; sourceTimeMs: number }[],
): void {
  const markedAt = new Map(markers.map((m) => [m.actionId, m.sourceTimeMs]));
  for (const action of actions) {
    const at = markedAt.get(action.id);
    if (at === undefined) {
      throw new Error(
        `the walk committed ${action.id} without marking it, so its timestamp has nothing to agree with`,
      );
    }
    action.timestamp = at;
  }
}

export async function runAuthored(
  script: DemoScript,
  deps: AuthoredDeps,
): Promise<AuthoredResult> {
  // A device is a viewport (spec 2026-10-10 §3), and the schema refuses a
  // script naming both, so a device's size is the run's.
  const device = script.device === undefined ? null : deviceFor(script.device);
  const viewport =
    device !== null
      ? { width: device.width, height: device.height }
      : (script.viewport ?? deps.viewport);
  // Thrown, never defaulted: a guessed size is written into the take and
  // contradicted by every frame of it.
  if (viewport === undefined) {
    throw new Error(
      "runAuthored: the script names no device and no viewport, and the caller measured none",
    );
  }
  const run = createAuthoredRun(script, deps, viewport);

  // Each click's zoom is decided once, by the walk; the take is handed what
  // it was decided on (`cameraInputs`).
  const decided = new Map<string, { unwaitedMs: number; scale: number }>();
  const policy = deps.roomFor?.(viewport);
  const room: RoomPolicy | undefined =
    policy === undefined
      ? undefined
      : {
          neededMs: policy.neededMs,
          zooms: (click) => {
            decided.set(click.actionId, {
              unwaitedMs: click.unwaitedMs,
              scale: click.scale,
            });
            return policy.zooms(click);
          },
        };
  const walked = await runWalk(
    run.source,
    // The log these frames were made from, which for an authored run is what
    // the run performed — and is not known until it has. `runWalk` reads this
    // array once, at bundle assembly, after the last step; the source appends
    // to this same array as it commits each one.
    {
      ...deps,
      madeFrom: run.madeFrom,
      ...(room === undefined ? {} : { room }),
    },
    {
      sceneId: deps.sceneId,
      viewport,
      total: authoredTotal(script),
      device,
      // The walk can only ever set this true, from a repaint it measured. A
      // script asking for a hover is not evidence that hovering changes
      // anything.
      hoverSensitive: false,
      firstCursor: run.firstCursor,
    },
  );
  // No bundle, no frames to agree with: the walk's own `reason` already says
  // why there is none, and the actions keep the stamps they were pulled with.
  if (walked.bundle !== null)
    stampAtMarkers(run.actions, walked.bundle.markers);

  const inputs = cameraInputs(
    run.actions,
    walked.bundle?.markers ?? [],
    walked.bundle?.viewportTransforms ?? [],
    decided,
  );
  const assembled = assembleAuthored(script, {
    sceneId: deps.sceneId,
    createdAt: deps.createdAt,
    viewport,
    actions: run.actions,
    anchors: run.anchors,
    walked,
    startingBranding: deps.startingBranding,
    // Each action stands at its marker now (`stampAtMarkers` above). The
    // zooms are decided on time with the replay's added room taken out, as
    // the walk decided them; the page's zoom is read on the real clock it
    // was recorded on (`cameraInputs`).
    camera: deps.cameraFor(inputs.actions, viewport, inputs.scaleAt),
    ...(device === null ? {} : { device: captureDeviceOf(device) }),
    ...(deps.displayScale === undefined
      ? {}
      : { displayScale: deps.displayScale }),
  });

  return {
    ...walked,
    // The source's own stop wins where there is one, and the two cannot both
    // be mid-run: a source that stopped left the walk's loop by ending, so the
    // only reason the walk can add afterwards is a failure to assemble or
    // persist the bundle — which is the LATER fact, and the first stop reason
    // is the one that explains the run.
    reason: run.stop() ?? walked.reason,
    document: assembled.document,
    documentError: assembled.error,
    steps: run.steps,
  };
}

import type { Degradation, FrameBundle } from "@demoman/compositor";
import type { AnchorIntent } from "@demoman/resolver";
import type { FailureReasonName, StrategyName } from "@demoman/scene-schema";

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * CDP, narrowed to what replay uses. The browser's debugger extension API
 * satisfies it in production and a Playwright CDPSession satisfies it in the
 * integration lane — the same engine drives both, which is the only way the
 * CDP call sequence gets tested against a real browser rather than against
 * our assumptions about one (SP1's lesson).
 */
export interface CdpSession {
  send(
    method: string,
    params?: Record<string, unknown>,
  ): Promise<Record<string, unknown>>;
  on(
    event: string,
    handler: (params: Record<string, unknown>) => void,
  ): () => void;
  detach(): Promise<void>;
}

/**
 * What the sensor can say about an anchor. Note what is *not* here: a rect.
 * Only CDP can give a rect in the main frame's coordinate space, and that is
 * the only space `Input.dispatchMouseEvent` accepts — so geometry and input
 * come from one source and can never disagree about which pixel was clicked.
 */
/**
 * Why an anchor did not resolve: the resolver's own verdict, or the one
 * verdict the resolver cannot give — that it was never reached. `pageSilent`
 * is the page agent's: the tab did not answer, because there was no sensor
 * in it to answer (a chrome-error page, an app that never loaded) or the
 * answer never came. It is not a claim about the element; a null reason
 * used to stand in for it, and the engine read null as "gone".
 */
/**
 * `"pageSilent"`, `"pageFaulted"`, `"notReachable"` and `"frameMismatch"` are
 * not resolver verdicts — four of them, and the list is closed only until the
 * next one is added here (each member below carries its own docblock, which is
 * the enumeration that cannot go stale).
 *
 * The first two are the absence of a verdict, and they are not interchangeable:
 * the page never answered, versus the page answering that its own agent threw.
 * The other two are this side of the port failing after a perfectly good
 * verdict: the resolver found the element, and the engine could not reach it to
 * measure it. Keeping all four distinct is what stops a healthy anchor being
 * reported as a broken one.
 *
 * The last two are one failure to reach and two different author actions,
 * which is why they are two values. A realm or context that is not there yet
 * is transient, and running again is a real fix. A frame hop the live tree
 * does not corroborate is not: the iframe has navigated, been reordered, or
 * gone, and every re-run fails the same way until the step is re-recorded.
 */
export type ResolveFailure =
  | FailureReasonName
  | "pageSilent"
  /**
   * The page's own agent THREW while answering — `resolveAnchor` or
   * `captureAnchor` faulted, which the canvas patch tier can do because it
   * touches a live canvas. A fourth thing that is not a resolver verdict, and
   * emphatically not `pageSilent`: the page WAS heard from, so telling the
   * author "the app may be down, offline, or showing a browser error page"
   * sends them to check something that is fine. Added 2026-09-27, when the
   * rejection was landing in the page console with no reply posted at all and
   * the caller's timeout reported the silence it did not observe.
   */
  | "pageFaulted"
  | "notReachable"
  | "frameMismatch";

export interface ResolveReport {
  anchorId: string;
  strategy: StrategyName;
  resolved: boolean;
  /**
   * Why resolution ended where it did, carried through from the resolver
   * rather than recomputed. Null when it resolved.
   *
   * The engine turns this into a stop reason. Three of these are three
   * different author actions: `ambiguousTie` says several candidates matched
   * and the anchor needs disambiguating, `notInTree` says the element is not
   * rendered *yet* — a virtualized row the app can be asked to scroll to —
   * and the rest say it is gone. `pageSilent` is none of those: the page was
   * never heard from, and the author's move is to check the app is up.
   */
  failureReason: ResolveFailure | null;
}

export interface PageAgent {
  /** `AnchorIntent`, not `SceneAnchor`: an authored run resolves a step it
   *  has not yet captured an anchor for. See the resolver's own docblock. */
  resolve(anchors: AnchorIntent[]): Promise<ResolveReport[]>;
}

/** A located element: the handle CDP measures and scrolls, and its rect. */
export interface TargetHandle {
  objectId: string;
  rect: Rect;
}

export interface EncodedSpan {
  ref: string;
  width: number;
  height: number;
  fps: number;
  frames: number;
  /** Bytes written to the store under `ref`. */
  byteLength: number;
  /**
   * The size the span opened on, present only when the encoder refused it
   * and the span was encoded smaller (`width`/`height`). Absent means the
   * span was encoded at its first frame's own size.
   */
  shrunkFrom?: { width: number; height: number };
}

export interface FrameEncoder {
  openSpan(startMs: number): void;
  /** Resolves once the frame is queued, not once it is encoded. */
  push(frame: {
    bytes: Uint8Array;
    ms: number;
    width: number;
    height: number;
  }): Promise<void>;
  /** Null when the span held too few frames to be motion. */
  closeSpan(endMs: number): Promise<EncodedSpan | null>;
  queueDepth(): number;
  heapFraction(): number;
}

/**
 * What the last replay of a scene did, in the four numbers a surface needs
 * to say something true about it.
 *
 * Stored beside that scene's frames rather than derived from telemetry.
 * Telemetry's event carries the same four values, but that store is a
 * byte-capped ring buffer that evicts oldest-first on its way to an upload
 * envelope: a scene whose replay failed would silently start reading as
 * "never ran" once enough later scenes pushed its event out. Same numbers,
 * different lifetimes, and the duplication is deliberate.
 *
 * The absence of a status is itself the fact a caller needs: **no status
 * means no replay has been run for this scene**, which is a different thing
 * from a replay that ran and stopped, and the two must not present alike.
 *
 * `reason` is widened to `string` because it comes back off disk unvalidated
 * — the values written are always `ReplayStopReason`. Read it and `outcome`
 * as two independent facts: `outcome` says how far the run got, `reason` says
 * what failed, and `complete` with a non-null reason is both reachable and
 * important (a run that replayed everything and then could not store it).
 */
export interface ReplayStatus {
  outcome: "complete" | "partial";
  reason: string | null;
  completed: number;
  total: number;
}

/**
 * What the engine asks of a store: two methods.
 *
 * The extension's `FrameStore` declares 21, and the engine calls
 * `putKeyframe` and `putBundle` and nothing else. The other 19 are the
 * extension's storage lifecycle — sweeps, budgets, parked frames, both
 * status pairs — which reached this package because the extraction moved
 * `types.ts` wholesale.
 *
 * Declared separately rather than by narrowing that store, which has eight
 * production importers in the extension; it satisfies this interface
 * structurally, so pointing `EngineDeps` here costs no call site anything.
 *
 * The narrowing is not tidiness. A caller outside the extension — the
 * headless runner — would otherwise implement 19 methods it has no storage
 * lifecycle for, and a `sweepOrphanBlobs` that returns 0 because there is
 * nothing to sweep is indistinguishable from one that could not run.
 *
 * Same move `core/storage/types.ts` already made with `StoragePorts`, which
 * narrows that store by `Pick` for the same reason.
 */
export interface EngineStore {
  putKeyframe(
    sceneId: string,
    index: number,
    bytes: Uint8Array,
  ): Promise<string>;
  putBundle(sceneId: string, bundle: FrameBundle): Promise<void>;
}

export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export interface ReplayProgress {
  step: number;
  total: number;
  keyframes: number;
  state: "running" | "paused" | "done" | "failed";
  note: string | null;
}

export type ReplayStopReason =
  | "mutating"
  | "redactedWithoutReplacement"
  /**
   * The anchor did not resolve and the resolver had nothing more specific to
   * say: the element is gone, or behind a closed shadow root, or its frame is
   * unreachable. The author's move is to re-record the step or repair the
   * anchor.
   *
   * The two below used to be folded in here, and they are not the same
   * failure — a run that stopped because a row had not rendered and a run
   * that stopped because the button no longer exists ask the author for
   * different things.
   */
  | "unresolvedAnchor"
  /** Several candidates matched and corroboration could not break the tie.
   *  Clicking one of them is how a replay clicks the wrong row of a table, so
   *  it stops instead. The author's move is to disambiguate the anchor. */
  | "ambiguousAnchor"
  /** The element is not in the tree *yet* — a virtualized list row, which the
   *  app can still be asked to scroll into view. Distinct from gone, and the
   *  distinction is the whole reason the resolver reports `notInTree`. */
  | "anchorNotRendered"
  /**
   * The page never answered when asked to find an element: no sensor in the
   * tab to answer (the app is down, offline, or the stage is on a
   * chrome-error page), or the answer never arrived. Not a verdict about
   * the element — before this reason existed the silence fell into
   * `unresolvedAnchor`, and an author whose app was simply down was told to
   * re-record the step. The author's move is to check the app loads.
   */
  | "pageSilent"
  /**
   * The resolver found the element and replay could not reach it: no
   * MAIN-world execution context for the frame the anchor's hop names, or
   * nothing parked under the anchor's id where the hop pointed. Distinct from
   * `unresolvedAnchor` on purpose — that one tells an author to re-record the
   * step or repair the anchor, and here the anchor is healthy and doing so
   * would fix nothing. Found on 2026-09-07, when an element inside a
   * same-origin iframe was parked in the top document's realm while the
   * engine looked for it in the frame's.
   *
   * Both causes are transient, which is what lets the copy say "run it
   * again". That is the whole reason the frame-mismatch case below is not
   * this reason: it said the same thing about a failure that repeats forever.
   */
  | "anchorUnreachable"
  /**
   * The frame the anchor's hop names is not in the live tree, or is in it and
   * contradicts the hop's recorded origin, name or ordinal. The anchor itself
   * is healthy — this is `anchorUnreachable`'s sibling, split out of it on
   * 2026-09-07 because the two ask the author for opposite things.
   *
   * Permanent by construction, and that is the point of keeping it separate.
   * The corroboration must not be relaxed into a guess — dispatching into
   * whichever frame happens to sit at the recorded ordinal is how a replay
   * clicks inside the wrong iframe — so nothing about the next run differs,
   * and an author told to run it again would run it forever. Their move is to
   * re-record the step against the frames the app has now.
   */
  | "anchorFrameMismatch"
  /**
   * The page's own agent threw while being asked to find or capture an
   * element — see `ResolveFailure`'s `pageFaulted`.
   *
   * Distinct from `pageSilent`, which is what this used to be reported as (by
   * the caller's timeout, since no reply was posted at all): "the page never
   * answered" tells the author to check the app is up, and the app is up. It
   * faulted. Distinct from `unresolvedAnchor` too, which would send them to
   * re-record a step whose element may well still be there.
   */
  | "pageFaulted"
  /**
   * The run is no longer on the page it was performing against, and nothing in
   * the script asked it to move.
   *
   * Authored runs only. The case it exists for is an expired session: a click
   * lands on a login page, and every remaining step of the script then names
   * an element that page does not have. Without this the author is told the
   * element is gone and sent to re-record a step that is fine.
   *
   * Measured, never inferred, from either of two witnesses:
   *
   * - the step's element was FOUND, and found on a different page from the one
   *   the step before it ran on — every authored anchor carries the URL the
   *   page captured it on (`resolution.url`);
   * - or the capture FAILED and the page said which document it failed on
   *   (`IntentCapture.pageUrl`), and that is a different page. This is the
   *   expired-session shape itself, where the target does not exist on the new
   *   page so there is no anchor to compare.
   *
   * A script that MEANS to change page says so with `waitForLoad` or a
   * `waitFor`, and after either the run takes the page it FINDS rather than the
   * one it left: the wait's own element names the landed page when it was found
   * only after the wait, and when it was already present beforehand it says
   * nothing about where the page ended up, so that case defers to the next
   * capture. Either way this fires only where nothing asked for the move.
   */
  | "pageWentElsewhere"
  /**
   * The app sent the browser to a sign-in page before anything was filmed
   * (launch C): the host's `landing` port said so. Distinct from
   * `pageWentElsewhere`, which a script's own navigation can cause; here the
   * author's move is to sign in again, and the detail names the command.
   */
  | "signedOut"
  /**
   * The script asked for something this door cannot perform, so it stopped
   * rather than perform something else and report success.
   *
   * One case today: a `click` naming `middle` or `right`. `performVerb`
   * dispatches a left button and nothing else, so the honest outcomes are to
   * refuse or to record a left click the script did not ask for — and the
   * third option, performing left while the document says `right`, is the
   * fabrication this whole door is built to avoid. The author's move is a
   * left click.
   *
   * Like `noActions`, no engine path produces this: it is decided by the
   * authored source over the script it was handed.
   */
  | "unperformableStep"
  /**
   * A click the browser did not deliver where it was sent: its press, its
   * release, or both arrived somewhere else (`click-probe.ts`). The page saw
   * no click on its target, so the step did not happen — and until
   * 2026-10-13 the run went on and reported `complete`. Seen in both
   * executors, at 2/3 of the sent point (display DPR over `REPLAY_DPR`),
   * caused by input sent while a still was being captured, which
   * `input-gate.ts` now prevents; the author's move is to run it again. Also
   * a `type` whose click missed and left its field unfocused: nothing is
   * typed, since the keys would go wherever focus was.
   */
  | "clickNotDelivered"
  /**
   * A drag whose start or end is off the page once the start is in view.
   * A drag cannot scroll mid-move, so it was not begun: a drag cut short at
   * the viewport's edge would drop wherever that happened to be.
   */
  | "dragEndOutOfView"
  /**
   * A drag whose two ends, once measured, are within a few pixels of each
   * other: two spellings of one point the script door cannot tell apart. A
   * press and a release on the same spot is a click, and the page would
   * report it as done, so it was not begun.
   */
  | "dragNoDistance"
  | "waitTimeout"
  | "occlusionTimeout"
  | "debuggerUnavailable"
  | "windowClosed"
  /** The author cancelled during the orchestrator's pre-roll, before the
   *  first action fired. Distinct from a status that was never written,
   *  which means replay never ran at all. */
  | "cancelledByAuthor"
  /**
   * A port threw where the engine had no verdict of its own: a box-model call
   * against a node that went away mid-run, a screenshot on a session that
   * detached, a store write that failed. Distinct from `debuggerUnavailable`,
   * which is the adapter reporting it could not attach in the first place —
   * this one means the run had started and something under it gave way. The
   * message is not carried here: it can hold page content, so it goes to the
   * progress channel as a `failed` note and never into telemetry.
   */
  | "portFailure"
  /**
   * The browser refused to emulate the device the run was asked to film as
   * (spec 2026-10-10 §1). Nothing was filmed: a phone take that fell back to
   * the desktop would be a failure reporting success. The progress note
   * names the device, the command and the browser's message.
   */
  | "deviceFailed"
  /**
   * Nothing to perform: a script of pauses alone. Reported by the caller
   * before the engine is ever reached — `runReplay` has no way to produce
   * this on its own. Distinct from every reason above: nothing failed, and
   * re-running would not help.
   */
  | "noActions";

/** Everything one run learned, in numbers. Turning these into a telemetry
 *  event is Task 15's job: the engine has no clock for `at` and no source of
 *  ids, and both belong to the adapter that owns them. */
export interface ReplayCounters {
  actions: number;
  completed: number;
  replayThrough: number;
  keyframes: number;
  motionSpans: number;
  motionFrames: number;
  droppedMotionFrames: number;
  /** Motion frames refused because they were not a scale of the emulated
   *  viewport — the screencast following the window's surface rather than
   *  the override. A subset of `droppedMotionFrames`, counted apart because
   *  it is a platform fault and the others are the memory budget doing its
   *  job. */
  surfaceMismatchFrames: number;
  /** Motion frames the encoder would not take. Also a subset of
   *  `droppedMotionFrames`, and counted apart for the same reason: it is a
   *  fault in this codebase's own encoding, not in the budget. */
  encodeRefusedFrames: number;
  /** Spans the encoder refused at their opening size and kept smaller
   *  (`EncodedSpan.shrunkFrom`). Not a subset of anything dropped: every
   *  frame was kept, at less detail than it arrived with. */
  encodeShrunkSpans: number;
  budgetBreaches: number;
  keyframeOnlySpans: number;
  occlusionPauses: number;
  occlusionMs: number;
  heapHighWater: number;
  motionWidth: number;
  motionHeight: number;
  durationMs: number;
  dpr: number;
  viewportWidth: number;
  viewportHeight: number;
}

export interface ReplayResult {
  /**
   * Null when the run produced nothing SP6's schema will accept as a replay:
   * no keyframes (it refused, or a port gave way before the opening shot), or
   * no cursor samples — `FrameBundleSchema` rejects a `source: "replay"`
   * bundle with an empty `cursorSamples`, because inversion only closes when
   * replay hands back what it dispatched. The one exemption: every step the
   * run placed on film is of a kind whose cursor does not travel (a take of
   * nothing but scrolls), which dispatched nothing and still has frames.
   *
   * Note this does **not** imply `outcome: "partial"`. A scene of nothing but
   * `waitFor` actions plans no cursor segments, so it can run to completion
   * and still have no samples to hand back: `outcome: "complete"`, `reason:
   * null`, `bundle: null`. Callers choosing a bundle to render must test this
   * field, not the outcome — `chooseActiveBundle` already does.
   */
  bundle: FrameBundle | null;
  /**
   * How far replay got through the action log — `complete` iff it reached the
   * last one — and nothing else.
   *
   * Read this and `reason` as two independent facts: "did the replay finish"
   * and "did anything fail". They are not restatements of each other, and
   * `complete` **can** carry a reason. The reachable case is a run that
   * replayed every action and then could not *store* its bundle: quota is the
   * most plausible failure this extension has, since frames are the largest
   * thing it writes. That is a complete replay with `reason: "portFailure"`,
   * and the bundle in this result is valid and renderable — it just will not
   * be there on a later `getBundle`, so a caller that means to render later
   * should re-persist it.
   *
   * A run that stopped early is always `partial`: every mid-run stop breaks
   * before its `completed++`, so `completed < total` holds by construction.
   */
  outcome: "complete" | "partial";
  completed: number;
  total: number;
  /**
   * The id of the last action this run completed, or null when it completed
   * none.
   *
   * `completed` is a COUNT of the log the run was handed. Anything that
   * wants to say "the take, up to where this run reached" (retro
   * truncation) needs the id, which says the same thing less ambiguously.
   */
  lastCompletedActionId: string | null;
  /** Why the run stopped, or — when it did not stop — what failed after it
   *  finished. The **first** failure wins: a run that timed out waiting and
   *  then failed to persist reports the wait, since that is what explains the
   *  run. A later failure is reported through the progress channel's note. */
  reason: ReplayStopReason | null;
  degradations: Degradation[];
  /**
   * Every click the page could not vouch for, by the action it belonged to,
   * with what the check said (`click-probe.ts`). Each also put a
   * `clickUnconfirmed` degradation on the bundle; this is the same fact with
   * the step attached, which a degradation does not carry, so a report can
   * name the step to look at. Optional only for results built outside the
   * walk (a host's refusal, a test stub), which made no clicks; the walk
   * always sets it.
   */
  unconfirmedClicks?: { actionId: string; note: string }[];
  /**
   * Every drag that reached the page and changed nothing on screen, by its
   * action, with why (`notDragged`). The step did not happen the way the
   * script asked, so a report lists it as diverged. Optional as
   * `unconfirmedClicks` is.
   */
  ignoredDrags?: { actionId: string; note: string }[];
  /**
   * True **iff** a bundle was built and the store refused to hold it.
   *
   * A storage-failure flag and nothing wider — in particular not the negation
   * of "there is a bundle on disk". `false` says only "nothing this run
   * produced was lost to the store", which is vacuously the case on every
   * path that never built a bundle: the mutating refusal, and a run whose
   * assembly threw before any write was attempted. **Pair it with `bundle`
   * rather than reading it alone**: the run whose frames exist in memory and
   * nowhere else is `bundle !== null && storageRefused`, and a caller that
   * means to render later should re-persist exactly then.
   *
   * Narrow on purpose. It exists because telemetry could not otherwise see
   * storage exhaustion — quota is the most plausible failure this extension
   * has, frames being the largest thing it writes, up to 200 keyframes at
   * 1-3 MB — and a run that had already stopped for another reason kept its
   * original `reason` (correctly) while the write survived only in the
   * progress note, which never enters telemetry because it can quote page
   * content. So `storageRefused` is exactly the set of runs whose bundle the
   * store rejected, with no false positives to dilute it. Widening it to
   * "there is no stored bundle" would fire on every refusal and every
   * wait-only scene, and nothing else in a counters-only payload separates
   * those from a real quota failure.
   *
   * A throw from bundle *assembly* is deliberately not counted here. The
   * store was never asked, so it is not a storage event — it is an engine
   * bug, and `bundle: null` with `reason: "portFailure"` already reports it.
   *
   * Named for what it means. It was `persisted` until the field had four
   * paths and the name stated the opposite of the fact on three of them, and
   * both consumers had to hand-write `bundle !== null && !persisted` to say
   * something the flag was supposed to say for them.
   */
  storageRefused: boolean;
  /** v9: a scene whose hover changed the DOM during replay cannot be
   *  re-eased compositor-only. Set true, never false — capture may have
   *  seen sensitivity this run did not. */
  hoverSensitive: boolean;
  counters: ReplayCounters;
}

/**
 * The replay engine's public surface — one door, curated, following
 * `packages/resolver/src/index.ts`.
 *
 * This list was derived from the imports that existed at extraction, not
 * from what happened to be exported. A symbol nobody imports does not
 * become public because it was convenient to add it.
 *
 * Some of it is public only because the engine's own tests import it through
 * this door (`test/` here imports `../../src/index.js`, `apps/runner/test`
 * imports `@demoman/replay-engine`). The symbols marked "test-only" below
 * have no importer in any other package's or app's source; they are engine internals, not
 * intended API, exported here only so those tests reach them the way
 * production code does.
 *
 * A second group, marked "runner API" below, was held open for the headless
 * runner before `apps/runner` existed: the mutation gate
 * (`classifyOriginStrict`, `mayWriteUnattended`, and the `ReplayRequest`
 * union that shapes their caller's input) and the navigating guard's types,
 * which a runner needs to build the guard's dependencies outside this
 * package. The runner exists now and its source imports none of them; only
 * tests do. They are kept, not withdrawn, until someone decides.
 */
export { actEndOf } from "./act-end.js";
export type { RoomPolicy, StepTiming, WaitSaw } from "./walk.js";
/**
 * The authored door. `runAuthored` is the entry point; the types beside it are
 * what a host has to satisfy and read (`apps/runner`'s executor, and the run
 * report built from `AuthoredStep`).
 *
 * `authoredTotal` is here because a HOST needs it: the step count an authored
 * run is measured against is also the count its progress notes and its
 * refusals are reported against, and a host that derived its own would be free
 * to disagree with the walk about how many steps there were — which is the
 * defect `runReplayInWindow` had to fix for the rebuild (`refusedRun` fed the
 * wrong document). `apps/runner/src/executor/run.ts` is that importer.
 *
 * `createAuthoredRun` and `assembleAuthored` are deliberately NOT here. They
 * are exported from `authored.ts` for this package's own test lane, which
 * imports the module directly — so re-exporting them would add two public
 * symbols with no importer, which the note above forbids.
 */

// The runner uses both: `ANSWER_DEADLINE_MS` in its page deadline
// (`apps/runner/src/page-deadline.ts`), `withAnswerDeadline` on its stage
// session (`apps/runner/src/executor/browser.ts`). This package's engine
// lane asserts the walk's stop on a call that never answers against them.
export { ANSWER_DEADLINE_MS, withAnswerDeadline } from "./answer-deadline.js";
export {
  type AuthoredDeps,
  type AuthoredResult,
  type AuthoredStep,
  authoredTotal,
  type CaptureFailure,
  type IntentCapture,
  type IntentResolution,
  runAuthored,
} from "./authored.js";
export {
  buildCaptureBundle,
  chooseActiveBundle,
  type Shot,
  tagKeyframes, // test-only, see header
} from "./bundle.js";
// Whole block is test-only, see header, except `TYPE_FIELD_UNFOCUSED`, which
// `@demoman/run-core`'s replay report reads.
export {
  CLICK_DRIFT_PX,
  CLICK_MEASURE_SLACK_PX,
  CLICK_MEASURE_TRIES,
  CLICK_PROBE_INSTALL,
  CLICK_PROBE_MARKER,
  type ClickProbe,
  type ClickSeen,
  type ClickVerdict,
  clickVerdict,
  discardClickProbe,
  pagePointOf,
  placeClickProbe,
  readClickProbe,
  TYPE_FIELD_UNFOCUSED,
} from "./click-probe.js";
export {
  ACT_CEILING_MS,
  CAPTURE_MAX_KEYFRAMES,
  CAPTURE_MIN_INTERVAL_MS,
  CAPTURE_MOTION_BUDGET_BYTES,
  CAPTURE_SPAN_MIN_FRAMES,
  HEAP_HIGH_WATER, // test-only, see header
  HEARTBEAT_STALL_MS, // test-only, see header
  KEYFRAME_QUALITY,
  MAX_ENCODE_QUEUE, // test-only, see header
  MAX_FRAMES_IN_FLIGHT, // test-only, see header
  MUTATING_REPLAY_HOLD_MS,
  NAVIGATE_TIMEOUT_MS,
  OCCLUSION_TIMEOUT_MS, // test-only, see header
  QUOTA_GUARD_FRACTION,
  RENDER_ESTIMATE_FALLBACK_BYTES,
  REPLAY_DPR,
  REPLAY_HOLD_TTL_MS,
  REPLAY_TARGETS,
  SETTLE_MS,
  SETTLE_PAINT_TIMEOUT_MS, // test-only, see header
  SETTLE_QUIET_TIMEOUT_MS, // test-only, see header
  SPAN_MAX_MS,
  SPAN_MIN_FRAMES,
  SPAN_QUIET_MS,
  STILL_DRAIN_MS,
  STORAGE_BUDGET_DEFAULT_BYTES,
  SWEEP_GATE_TIMEOUT_MS,
  TYPE_KEY_MS,
  TYPE_LEAD_MS,
  TYPE_MAX_MS,
  WAIT_TIMEOUT_MS, // test-only, see header
} from "./constants.js";
export {
  applyDevice,
  DeviceEmulationError,
  type DeviceLike,
  desktopMetrics,
  deviceMetrics,
} from "./device.js";
export {
  type EngineDeps, // test-only, see header
  replayOutcome,
  runReplay,
} from "./engine.js";
export {
  anchorLabel,
  failedPerformedStep,
  failedStep,
  reasonSentence,
} from "./explain.js";
// Whole block is test-only, see header.
export {
  type CdpFrameNode,
  findCdpFrameId,
  hopsFromTreePath,
  rectCentre,
  rectFromQuad,
  resolveCdpFrameId,
} from "./geometry.js";
export { decodeBase64, jpegSize } from "./image.js";
// Test-only, see header: the runner lane drives it against real Chromium.
export { createInputGate, type InputGate } from "./input-gate.js";
/** The snapshot's wait (plan 2): a page loaded and painted, for a host that
 *  is not running a walk. `@demoman/run-core`'s snapshot and the runner's
 *  probe. */
export { type PageReady, waitForPageReady } from "./loaded.js";
export { type RenderMode, renderModeOf } from "./mode.js";
// Whole block is test-only, see header.
export {
  createMotionRecorder,
  type MotionRecorderDeps,
  type MotionSpanEntry,
} from "./motion-recorder.js";
export {
  assertSceneWasLoaded,
  createNavigatingGuard,
  type NavigatingGuard, // runner API, see header
  type NavigatingGuardDeps, // runner API, see header
  replayUrl,
} from "./navigate.js";
export { createOcclusionGuard, type OcclusionGuard } from "./occlusion.js";
export {
  classifyOrigin,
  classifyOriginStrict, // runner API, see header
  isLocalTarget, // runner API, see header
  mayWriteUnattended, // runner API, see header
  type OriginClass,
} from "./origin.js";
// Whole block is test-only, see header.
export { pathPointAt, retargetSegment } from "./path.js";
export {
  type ReplayPolicy,
  type ReplayRequest, // runner API, see header
  type ReplaySubject,
  replayPolicy,
} from "./policy.js";
// Whole block is test-only, see header.
export {
  SCROLL_MARKER,
  type ScrollAim,
  scrollIntoViewFunction,
  scrollWillMove,
} from "./scroll.js";
// Whole block is test-only, see header.
export {
  SETTLE_MARKER,
  type SettleReport,
  settlePaintExpression,
} from "./settle.js";
export {
  admitFrame, // test-only, see header
  degradation,
  motionBudgetSpent,
  spanEnded,
  spanEndMs,
  spanFps,
  spanIsMotion,
  spanWentQuiet,
} from "./span.js";
export type {
  CdpSession,
  Clock,
  EncodedSpan,
  EngineStore,
  FrameEncoder,
  PageAgent,
  Rect,
  ReplayCounters,
  ReplayProgress,
  ReplayResult,
  ReplayStatus,
  ReplayStopReason,
  ResolveFailure,
  ResolveReport,
} from "./types.js";

// v9's launch budget table and SP1's measured timings, in one place because
// v9 says they are tunable but must exist from day one.

/** SP1 §5: a tooltip lands ~275 ms after the injected path arrives. */
export const SETTLE_MS = 300;
/**
 * The gap between two keys of a `type`. The film records while the verb
 * runs, so this is the pace the text appears at on screen: about fourteen
 * characters a second, a quick typist, unhurried on camera.
 */
export const TYPE_KEY_MS = 70;
/**
 * The beat between a `type`'s click into its field and the first key: the
 * caret shows, then the typing starts, as a person's would. Without it the
 * click and the first letter land in the same frame.
 */
export const TYPE_LEAD_MS = 250;
/**
 * The longest a `type` spends typing. A value long enough to run past it
 * at `TYPE_KEY_MS` goes in faster, its keys spread evenly across this, so
 * a pasted paragraph is still seen being typed without holding the take.
 * Under `SPAN_MAX_MS`, so a sampled take's verb span holds all of it.
 */
export const TYPE_MAX_MS = 2500;
/** No screencast frame for this long ends a motion span. */
export const SPAN_QUIET_MS = 250;
/**
 * A step's full still stalls the screencast for as long as it takes, and
 * motion in that window is lost: measured 2026-10-24 on three takes, every
 * one of ten stills taken during a span left a 87–272 ms hole, one of them
 * through a sheet sliding shut. So a step whose page is moving takes its
 * still from the screencast instead (`pageMoving`): both newest frames
 * within this of each other and of the step. At 60 fps motion they are
 * 16 ms apart; 100 leaves room for a throttled frame without calling a
 * caret's once-a-blink repaint motion.
 */
export const MOVING_RECENT_MS = 100;
/** The share of the page that has to change between the two newest frames
 *  for it to be moving. A sheet sliding is a quarter of it; a 48 px spinner
 *  is a tenth of a percent. */
export const MOVING_SHARE = 0.01;
/** How long a moving step waits for the screencast frame after it, before
 *  it takes the full still after all: motion that stopped in the meantime
 *  loses nothing to the stall. */
export const NEXT_FRAME_WAIT_MS = 100;
/** A span never runs longer than this, however busy the page is. */
export const SPAN_MAX_MS = 3000;
/**
 * How long a continuous take runs on after its last action, at least. The
 * author's ruling of 2026-10-07: a video "should run for a second after the
 * last action", for a re-shoot as much as an agent run. A floor, not a
 * length: an agent script's own trailing `pause` is slept before the walk
 * gets here, and one longer than this is kept whole.
 */
export const TAKE_TAIL_MS = 1000;
/**
 * A span this short is not motion; it is a repaint. Discarded.
 *
 * **Three, because three is where the gap is.** Measured against real
 * Chromium through the integration lane, driving the engine's own sequence —
 * keyframe, open span, click, wait out `SPAN_QUIET_MS`, close:
 *
 * | span                                   | screencast frames       |
 * | -------------------------------------- | ----------------------- |
 * | click that changes nothing (n=150)     | 1 x114, 2 x36 — never 3 |
 * | click that opens an 800ms ease (n=12)  | 49 x6, 50 x6            |
 *
 * A smaller earlier run agreed (n=60: 1 x46, 2 x14); across both, 210 static
 * clicks never once painted three times.
 *
 * The populations are 47 apart — 2 at the top of the repaint one, 49 at the
 * bottom of the motion one — and 3 is the smallest value above the repaints.
 * Smallest is what is wanted: higher would start discarding genuinely brief
 * motion. At 2, what this was, a *static* click was kept as motion whenever
 * it happened to produce two frames rather than one, which was 36 times in
 * 150.
 *
 * That misclassification is not cosmetic. A kept span is served in
 * preference to the keyframe of the same instant, so a click that changed
 * nothing on screen put a surface-resolution still (1280x800, the screencast
 * ignores emulated DPR) in front of a 3840x2400 one — the exact degradation
 * the keyframe/motion split exists to prevent, on roughly one click in four.
 */
export const SPAN_MIN_FRAMES = 3;
/**
 * The capture path keeps every span, including one-frame ones.
 *
 * `SPAN_MIN_FRAMES`'s measured justification is a *replay* harm: a kept span
 * is served in preference to a coincident keyframe, and on the replay path
 * that swaps a 3840x2400 still for a 1280x800 one. Capture sends no
 * `Emulation.setDeviceMetricsOverride`, so its keyframes are CSS pixels and
 * the span may out-resolve them rather than the reverse. Discarding short
 * spans here would drop the only record of a brief change, to prevent a
 * downgrade that cannot happen on this path.
 */
export const CAPTURE_SPAN_MIN_FRAMES = 1;
/** v9: raw frames in flight. Breach skips motion frames, never keyframes. */
export const MAX_FRAMES_IN_FLIGHT = 3;
/** WebCodecs backlog above which the encoder is not keeping pace. */
export const MAX_ENCODE_QUEUE = 8;
/** v9: alert at 80% of the platform heap limit, then degrade to keyframes. */
export const HEAP_HIGH_WATER = 0.8;
export const WAIT_TIMEOUT_MS = 10_000;
/**
 * How long the settle probe waits for the images near the viewport.
 *
 * Long enough for a first-screen image on an ordinary connection, short
 * enough that a page which will never settle costs the take three seconds
 * rather than a stall — and it is charged once per navigation, not per
 * keyframe. On expiry the run continues and the bundle carries a
 * `pageNeverSettled` degradation naming what was still outstanding.
 */
export const SETTLE_PAINT_TIMEOUT_MS = 3000;
/**
 * How long the document must go without a DOM mutation before the settle
 * probe calls it still. Longer than Phoenix `topbar`'s 300 ms show delay —
 * the commonest "app still connecting" indicator — so the gap between a
 * LiveView join starting and its bar appearing does not read as quiet.
 */
export const SETTLE_QUIET_MS = 500;
/**
 * How long the settle probe waits for the document to stop changing, after
 * its images are in. The take that motivated it (2026-10-03, a LiveView
 * landing page on a dev server) was still joining about three seconds after
 * `load`; five covers that with room. A page that never stops costs this
 * once per navigation and carries a `pageNeverSettled` degradation saying
 * so.
 */
export const SETTLE_QUIET_TIMEOUT_MS = 5000;
/**
 * How long the corrective scroll waits for the target to stop moving.
 *
 * Measured against real Chromium: a `scrollIntoView({behavior:"smooth"})`
 * across 1800px of page settled in about 600ms. This is headroom over that,
 * and it is a ceiling rather than a budget — an element already in view
 * settles in three frames and costs nothing. On expiry the run continues
 * against a rect that may be stale and the bundle carries a
 * `scrollUnsettled` degradation saying so.
 */
export const SCROLL_SETTLE_TIMEOUT_MS = 1500;
export const WAIT_POLL_MS = 150;
/** How long a paused replay waits for its window to become visible again. */
export const OCCLUSION_TIMEOUT_MS = 60_000;
/**
 * How long the occlusion guard's rAF heartbeat may go silent before the
 * page is presumed to have stopped painting.
 *
 * The heartbeat posts every ~250ms while rAF is being driven, so 2s is
 * eight missed beats — far past jitter. It is also sized for the one
 * legitimate gap: a mid-run navigation tears down the beating document and
 * the next one only starts beating at its own first rAF, so a threshold
 * tighter than a slow document teardown would fire a spurious pause (and
 * its one focus-steal) on every sluggish navigation. A genuinely throttled
 * hidden page misses this by an order of magnitude — Chrome runs rAF at
 * roughly one frame a minute there, when at all.
 */
export const HEARTBEAT_STALL_MS = 2_000;
/**
 * How long a finished run waits for a still already asked for before it
 * gives up on it and says so. A 3x still takes 60–120 ms (spec 2026-10-03,
 * measured on the landing page), so 5 s is forty of them; a screenshot of a
 * page that has stopped painting has no deadline of its own and would
 * otherwise hold the run forever.
 */
export const STILL_DRAIN_MS = 5_000;
/** SP1: keyframes honour emulated DPR; 3 is the launch target and the
 *  §9 contingency (1080p cap) is dormant. */
export const REPLAY_DPR = 3;
/** SP1 §1: JPEG is 50–82 ms against PNG's 100–151 ms at DPR 3, and the
 *  deliverable is H.264 anyway. */
export const KEYFRAME_QUALITY = 95;
/** Capture-time harvest: never two shots closer than this. */
export const CAPTURE_MIN_INTERVAL_MS = 250;
export const CAPTURE_MAX_KEYFRAMES = 200;

/**
 * Parked motion bytes per take, after which motion recording stops.
 *
 * Measured 2026-08-29 against real Chromium
 * (`packages/replay-engine/test/integration/capture-viewport.test.ts`, "records
 * screencast and keyframe dimensions and bytes across real page motion"),
 * `format: "jpeg", quality: 80, everyNthFrame: 1` — the harvester's exact
 * `Page.startScreencast` call — with no `Emulation.setDeviceMetricsOverride`,
 * against real 800ms-eased page motion at a 2x device pixel ratio:
 *
 * - Screencast frames arrived at 1280x800, the same CSS-pixel resolution as
 *   the coincident `Page.captureScreenshot` keyframes (also 1280x800), not
 *   the 2560x1600 physical surface resolution a Retina display's DPR would
 *   imply. See `servingMotionSpan` in `packages/compositor/src/bundle.ts`
 *   for what this means for the resolution rule it drives.
 * - Mean ~15.15 KB/frame at ~49 fps of observed paint rate, i.e. roughly
 *   740 KB/s of parked motion.
 *
 * At that rate 256 MB is ~6.0 minutes of continuous motion — comfortably
 * past the three-minute target this constant is sized against, so no
 * retune was needed. Re-measure if the screencast's own regime changes
 * (format, quality, or a device-metrics override added to the harvester);
 * a screencast arriving at physical surface resolution instead of CSS
 * pixels would be roughly 4x the bytes and would cut this to well under
 * two minutes.
 *
 * On breach, motion stops for the remainder and the take says so. It is a
 * bound on the largest transient thing this extension writes, in the same
 * spirit as CAPTURE_MAX_KEYFRAMES.
 */
export const CAPTURE_MOTION_BUDGET_BYTES = 256 * 1024 * 1024;

/**
 * How long a take or replay waits for the startup orphan-blob sweep before
 * starting anyway.
 *
 * The gate exists so the sweep cannot delete a live take's frames (see the
 * extension's `sweepOrphanBlobs`), and a gate with no ceiling is a Record
 * button that does nothing, silently, forever. The sweep's one hang path is
 * a blocked `indexedDB.open` — which this codebase has already been bitten
 * by, connections held open being exactly what blocks a version change.
 *
 * Whichever way the gate opens, it opens: on a timeout the sweep is
 * abandoned and said so in the worker console, and the uncollected orphans
 * simply wait for the next worker start. Losing a sweep costs disk; losing
 * the take costs the author their demo.
 */
export const SWEEP_GATE_TIMEOUT_MS = 5000;

/**
 * Where a frame parks a resolved element for CDP to measure.
 *
 * A resolution report crossing a message boundary carries `element: null` —
 * a DOM node cannot be serialized. The name lives here, in core, because it
 * is a contract between the sensor that writes it and the engine that reads
 * it back through `Runtime.evaluate`.
 */
export const REPLAY_TARGETS = "__demomanReplayTargets";
/** How long the orchestrator names a mutating scene's writes before it
 *  starts replaying them. Long enough to read three request lines and
 *  reach the button; short enough not to tax every later take. */
export const MUTATING_REPLAY_HOLD_MS = 5000;

/** The local storage ceiling the lifecycle reclaims toward. Editable from
 *  the library page; this is the default an install starts with. */
export const STORAGE_BUDGET_DEFAULT_BYTES = 2 * 1024 * 1024 * 1024;
/** Fraction of `navigator.storage.estimate().quota` at which Chrome's own
 *  limit counts as pressure regardless of the budget. Secondary guard for
 *  small drives. */
export const QUOTA_GUARD_FRACTION = 0.8;

/**
 * How long a replay's delete hold stands without being released.
 *
 * The hold is taken by `replay:gate` and dropped by `replay:end`, and the
 * editor page sends the second in a `finally` — but a page that is reloaded
 * or crashes mid-run never reaches it, and its tab may well still be open.
 * The backstop is generous on purpose: a replay renders every action of a
 * take and a long one runs for minutes, so an expiry that could fire under
 * a live run would reintroduce exactly the race the hold exists to close.
 * The tab-liveness check is what handles the common case; this only stops a
 * demo becoming permanently undeletable.
 */
export const REPLAY_HOLD_TTL_MS = 30 * 60 * 1000;
/** Expected size of a render for a scene with no prior output. */
export const RENDER_ESTIMATE_FALLBACK_BYTES = 50 * 1024 * 1024;
/** How long the first navigation is waited on before the run starts anyway.
 *  A page that never fires `load` still gets its shot at resolving: the
 *  engine's own wait and resolve timeouts report what happened after that,
 *  and they say more than "navigation timed out" would. */
export const NAVIGATE_TIMEOUT_MS = 15_000;

/**
 * The longest a step's act runs on after its verb returns while the page
 * keeps painting (spec 2026-10-19, unhurried beats). A spinner or an
 * autoplaying video never goes quiet; past this the act is over anyway.
 */
export const ACT_CEILING_MS = 1000;

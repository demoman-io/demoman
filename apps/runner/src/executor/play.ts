// apps/runner/src/executor/play.ts
import {
  type AuthoredResult,
  assertSceneWasLoaded,
  type CdpSession,
  createHeldClock,
  createNavigatingGuard,
  createNetworkWatch,
  createOcclusionGuard,
  decodeBase64,
  type EngineStore,
  type FrameEncoder,
  type HeldClock,
  heldFramesScript,
  jpegSize,
  KEYFRAME_QUALITY,
  type NetworkWatch,
  type ReplayProgress,
  type ReplayStopReason,
  reasonSentence,
  runAuthored,
} from "@demoman/replay-engine";
import {
  ARRIVE_MS,
  actMs,
  afterScroll,
  attributeClosedWindow,
  chooseRunSize,
  clickNotDeliveredDetail,
  createRoomPolicy,
  DEFAULT_RUN_SIZE,
  frameMsOf,
  messageOf,
  newId,
  type RunRecording,
  type RunReport,
  type RunSize,
  restBefore,
  screenScaleNote,
  scrubUrl,
  tailMs,
  zoomsForClicks,
} from "@demoman/run-core";
import {
  type DemoScript,
  deviceFor,
  MOTION_DEFAULTS,
  type SceneBranding,
} from "@demoman/scene-schema";
import { createHeadlessPageAgent } from "../page-agent.js";
import { watchNavigation } from "../replay.js";
import type { Stage } from "./browser.js";
import { closedShadowHolds, targetWords } from "./closed-shadow.js";
import { readDatesOnScreen } from "./dates-on-screen.js";
import { HELD_CARET_SCRIPT, heldClockAsked, shouldHold } from "./held.js";
import {
  fileForLanding,
  fileIsForLanding,
  type LandingFacts,
  type LandingVerdict,
  landingVerdict,
  originAndPath,
  readLandingFacts,
} from "./landing.js";
import { measureViewport, pageCapture } from "./page-ops.js";
import { pinnedClockSource, pinnedOffsetMs } from "./pinned-clock.js";
import type { RunDeps } from "./run.js";
import { type SessionFile, samePage } from "./sessions.js";

/**
 * A run's stage and its walk, apart from the take: the code path `runScript`
 * films through, so anything else that plays a script's steps plays them the
 * way a run does.
 */

export type PlayDeps = Pick<
  RunDeps,
  | "session"
  | "log"
  | "sessions"
  | "sessionsContext"
  | "loadSessions"
  | "signinCommand"
  | "account"
  | "pinnedNow"
  | "readDates"
  | "flowSize"
  | "flowSizeUnread"
  | "flowScale"
  | "flowScaleUnread"
  | "recordingFrameRate"
>;

export type Prepared =
  | {
      ok: true;
      stage: Stage;
      sessions: SessionFile[];
      size: RunSize;
      viewport: { width: number; height: number } | null;
      /** The scale this run records at: headless's own, else the screen's
       *  as read; absent when a visible window's screen could not be read. */
      recordedAt?: number;
      /** Whether the page's clock is held and at which frame rate, or why
       *  not, and a 60 it could not apply (`RunReport.run.recording`). */
      recording: RunRecording;
      /** The held clock, already holding the page, and what feeds it. */
      held?: { clock: HeldClock; network: NetworkWatch };
    }
  | { ok: false; reason: ReplayStopReason; detail: string };

/** The stage, its sessions and the size it films at. A refusal carries the
 *  sentence `runScript` reports as `stopped.detail`. */
export async function prepareStage(
  script: DemoScript,
  deps: PlayDeps,
): Promise<Prepared> {
  const { log } = deps;
  const verdict = heldClockAsked()
    ? shouldHold({
        headed: !deps.session.headless,
        device: script.device !== undefined,
      })
    : null;
  // The browser is launched for this recording's clock, and launched again
  // when the live one was for the other, so one that records in real time
  // launches exactly as before held capture. Said with held capture off too:
  // a session made while it was on launches held (DEM-210).
  if (deps.session.headless) {
    const ensured = await deps.session.ensure({
      held: verdict?.hold === true,
    });
    if (!ensured.ok) {
      return { ok: false, reason: "portFailure", detail: ensured.detail };
    }
  }
  // Ensured at the door already; a failure here is a race with the author
  // closing the browser in between, said in the session's own words. A page
  // of its own, so nothing an earlier call emulated or installed is on it
  // (`BrowserSession.stage`).
  const staged = await deps.session.stage();
  if (!staged.ok) {
    return { ok: false, reason: "portFailure", detail: staged.detail };
  }
  const launched = staged.stage;
  const { page } = launched;

  // One frame length for the page's frames and the held clock: the rate
  // decided at the door (DEM-265), so the two can never disagree.
  const rate = deps.recordingFrameRate;
  const frameMs = frameMsOf(rate.value);
  const realWhy =
    verdict === null
      ? "held-clock capture is turned off (DEMOMAN_HELD_CLOCK=0)"
      : verdict.hold
        ? null
        : verdict.why;
  // A real-clock run records at the screen's own pace: a 60 asked for is
  // said as not applied, never dropped.
  const recording: RunRecording =
    realWhy === null
      ? { clock: "held", frameRate: rate.value, from: rate.from }
      : {
          clock: "real",
          why: realWhy,
          ...(rate.value === 60 && rate.from !== "default"
            ? { frameRateNotApplied: { asked: 60, from: rate.from } }
            : {}),
        };
  // Held: every document gets the held animation frames and a hidden caret
  // before its first script, and the held clock starts at the pinned instant
  // in place of the Date offset below. A script Chrome refuses stops the run.
  if (recording.clock === "held") {
    try {
      for (const source of [heldFramesScript(frameMs), HELD_CARET_SCRIPT]) {
        await launched.cdp.send("Page.addScriptToEvaluateOnNewDocument", {
          source,
        });
      }
    } catch (error) {
      return {
        ok: false,
        reason: "portFailure",
        detail: `the page's clock could not be held: its frame and caret scripts were refused (${messageOf(error)})`,
      };
    }
  }

  // Before the first navigation, on this flow's own target: every document
  // of the flow reads the repo's pinned instant (DEM-79). A pin that cannot
  // be installed stops the run: a video at the real date would be compared
  // with pinned ones and read as changed.
  if (deps.pinnedNow !== undefined && recording.clock !== "held") {
    try {
      await launched.cdp.send("Page.addScriptToEvaluateOnNewDocument", {
        source: pinnedClockSource(pinnedOffsetMs(deps.pinnedNow)),
      });
    } catch (error) {
      return {
        ok: false,
        reason: "portFailure",
        detail: `the page's clock could not be pinned to ${deps.pinnedNow} (${messageOf(error)})`,
      };
    }
  }

  // The executor loaded the saved sessions into the context `ensure()` gave
  // it; the stage can be a later one if the browser relaunched in between
  // (the author closed it). Loaded again here, or this run would go out
  // signed out and be told its session expired.
  let sessions = deps.sessions;
  if (launched.context !== deps.sessionsContext) {
    const reloaded = await deps.loadSessions(launched.context, null);
    if (!reloaded.ok) {
      return {
        ok: false,
        reason: "portFailure",
        detail: `the browser restarted after its saved sessions were loaded, and they could not be loaded again: ${reloaded.detail}`,
      };
    }
    sessions = reloaded.files;
  }

  // The size this run films at — the script's, its device's, or the screen
  // the window is on (`run-size.ts`). The CLI has no size setting, so it is
  // the default. A headless screen that is Chrome's stand-in is not read as
  // the author's (`BrowserSession.screen`): the run films at its window and
  // says why.
  const screen = await deps.session.screen(page);
  const sizePlan = chooseRunSize({
    scriptViewport: script.viewport,
    device: script.device === undefined ? undefined : deviceFor(script.device),
    flow: deps.flowSize,
    setting: DEFAULT_RUN_SIZE,
    screen,
  });
  // Only a screen that could not be read leaves the window's own size, and
  // then it is measured, never defaulted: this lands in
  // `meta.capture.viewport`, which is what the compositor composes every
  // frame against. The reason rides on `size.error`.
  // The flow's recorded size could not be read, so this run asked the screen:
  // said first on `size.error`, ahead of any reason the screen's own read
  // carries, or the run would look like a flow's first.
  const flowUnread =
    deps.flowSizeUnread === undefined
      ? null
      : `The flow's recorded size could not be read (${deps.flowSizeUnread}), so this run used this screen's.`;
  // The scale, likewise: headless asked for it at the door (`captureScale`),
  // so what it records at is `filmScale`; a visible window records at its
  // screen's, which it cannot be told otherwise.
  const filmScale = deps.session.filmScale();
  const screenScale =
    screen !== undefined && "scale" in screen ? screen.scale : undefined;
  const recordedAt = filmScale ?? screenScale;
  const scaleUnread =
    deps.flowScaleUnread === undefined
      ? null
      : `The flow's recorded scale could not be read (${deps.flowScaleUnread}), so this run recorded at ${recordedAt === undefined ? "its screen's scale" : `${recordedAt}x`}.`;
  const headedScale =
    filmScale === null &&
    screenScale !== undefined &&
    deps.flowScale !== undefined &&
    screenScale !== deps.flowScale
      ? screenScaleNote(screenScale, deps.flowScale)
      : null;
  const said = (reason: string | null) =>
    [flowUnread, scaleUnread, headedScale, reason]
      .filter((r) => r !== null)
      .join(" ") || null;
  let size: RunSize;
  if (sizePlan.kind === "fixed") {
    const error = said(sizePlan.size.error);
    size = error === null ? sizePlan.size : { ...sizePlan.size, error };
  } else {
    log(`${sizePlan.error}; recording at the window's own size`);
    try {
      size = {
        ...(await measureViewport(page)),
        from: "window",
        error: said(sizePlan.error),
      };
    } catch (error) {
      return {
        ok: false,
        reason: "portFailure",
        detail: `the script named no viewport, ${sizePlan.error}, and the run could not measure its own window either: ${messageOf(error)} — name a viewport in the script and run it again`,
      };
    }
  }
  // A device is its own size, which runAuthored takes from the device
  // (spec 2026-10-10), so it is handed no viewport.
  const viewport =
    size.from === "device" ? null : { width: size.width, height: size.height };
  let held: { clock: HeldClock; network: NetworkWatch } | undefined;
  if (recording.clock === "held") {
    // Last, after every read above, and before the walk's first navigation.
    // A clock Chrome will not hold stops the run, as a pin that cannot be
    // installed does: recorded in real time it would read as another video.
    try {
      // Headless with no display to stand in for records at 1x (launch.ts).
      held = await holdClock(
        launched.cdp,
        deps.pinnedNow,
        recordedAt ?? 1,
        frameMs,
        () => launched.page.close({ runBeforeUnload: false }),
      );
    } catch (error) {
      return {
        ok: false,
        reason: "portFailure",
        detail: `the page's clock could not be held (${messageOf(error)})`,
      };
    }
  }
  return {
    ok: true,
    stage: launched,
    sessions,
    size,
    viewport,
    ...(recordedAt === undefined ? {} : { recordedAt }),
    recording,
    ...(held === undefined ? {} : { held }),
  };
}

/**
 * The page's clock, held at the pinned instant (or now) with the network
 * watch that turns it to real time while the page waits on the server. A
 * frame from another site is its own target, whose timers, animations and
 * requests this clock cannot reach: each such origin is said once, with
 * what the clock could not pin.
 */
/** The origin a frame's sentence names ("a frame from <origin> ..."), or
 *  null for any other sentence. */
const originOf = (what: string): string | null =>
  /^a frame from (\S+) /.exec(what)?.[1] ?? null;

async function holdClock(
  cdp: CdpSession,
  pinnedNow: string | undefined,
  scale: number,
  frameMs: number,
  abandon: () => Promise<void>,
): Promise<{ clock: HeldClock; network: NetworkWatch }> {
  // The watch stamps requests on the page's clock (DEM-202): before the
  // hold, a request opens at its start, 0.
  let holding: HeldClock | undefined;
  const network = await createNetworkWatch(cdp, Date.now, {
    pageNow: () => holding?.now() ?? 0,
    pageOfWall: (wallMs) => holding?.pageOf(wallMs) ?? 0,
    scrubUrl,
  });
  const clock = createHeldClock({
    cdp,
    network,
    scale,
    frameMs,
    abandon,
    scrubUrl,
    realNow: Date.now,
    capture: async () => {
      const reply = await cdp.send("Page.captureScreenshot", {
        format: "jpeg",
        quality: KEYFRAME_QUALITY,
      });
      const bytes = decodeBase64(String(reply.data ?? ""));
      return { bytes, ...jpegSize(bytes) };
    },
    evaluate: async (source, arg, server) => {
      const reply = await cdp.send("Runtime.evaluate", {
        expression: `(${source})(${JSON.stringify(arg)}, ${server})`,
        returnByValue: true,
      });
      const thrown = reply.exceptionDetails as
        | { text?: string; exception?: { description?: string } }
        | undefined;
      if (thrown !== undefined) {
        throw new Error(
          thrown.exception?.description ?? thrown.text ?? "the page threw",
        );
      }
      return (reply.result as { value?: unknown } | undefined)?.value;
    },
  });
  // A frame target is attached before it navigates, with no URL yet: its
  // address is read as it changes, and the origins said at the end.
  const frames = new Map<string, { atMs: number; url: string }>();
  const seen = (params: Record<string, unknown>, attached: boolean) => {
    const info = params.targetInfo as
      | { targetId?: string; type?: string; url?: string }
      | undefined;
    if (info?.type !== "iframe" || info.targetId === undefined) return;
    const known = frames.get(info.targetId);
    if (known === undefined && !attached) return;
    frames.set(info.targetId, {
      atMs: known?.atMs ?? clock.now(),
      url: info.url || (known?.url ?? ""),
    });
  };
  cdp.on("Target.attachedToTarget", (p) => seen(p, true));
  cdp.on("Target.targetInfoChanged", (p) => seen(p, false));
  const framesSaid = () => {
    const said = new Map<string, number>();
    for (const { atMs, url } of frames.values()) {
      let origin = "an address it never named";
      try {
        origin = new URL(url).origin;
      } catch {
        // Said as such: the origin is the address it never named.
      }
      if (!said.has(origin)) said.set(origin, atMs);
    }
    return [...said].map(([origin, atMs]) => ({
      atMs,
      what: `a frame from ${origin} runs on its own clock: its timers, animations and requests were not held`,
    }));
  };
  await cdp.send("Target.setAutoAttach", {
    autoAttach: true,
    waitForDebuggerOnStart: false,
    flatten: true,
  });
  await cdp.send("Target.setDiscoverTargets", { discover: true });
  await clock.hold(
    pinnedNow === undefined ? Date.now() : Date.parse(pinnedNow),
  );
  holding = clock;
  return {
    clock: {
      ...clock,
      // A frame from another site the page also names (it could not reach
      // it) is said once, in the target's words, which say more.
      unpinned: () => {
        const targets = framesSaid();
        const named = new Set(targets.map((t) => originOf(t.what)));
        return [
          ...clock.unpinned().filter((u) => !named.has(originOf(u.what) ?? "")),
          ...targets,
        ];
      },
    },
    network,
  };
}

export interface PlayFilm {
  encoder: FrameEncoder;
  store: EngineStore;
  sceneId: string;
}

/** What the walk found at the start page, read by the walk's own `landing`
 *  callback before its first frame. Null: the walk never asked. */
export type Arrival =
  | { facts: LandingFacts; verdict: LandingVerdict }
  | { unchecked: string }
  | null;

export interface Played {
  /** After `attributeClosedWindow`. */
  result: AuthoredResult;
  navigationError: string | null;
  failedNote: string | undefined;
  signedOutAfter: string | null;
  lostHeadlessPage: boolean;
  /** `HeldClock.failed`'s sentence: the stop's whole detail. */
  heldFailed: string | undefined;
  landingNote: RunReport["landing"];
  arrival: Arrival;
  /** Date-looking text on the last screen, [] when none or unreadable
   *  (DEM-79): refresh's evidence for its note on dates. */
  datesOnScreen: string[];
  /** The target a run did not find is named inside a closed shadow root
   *  on the page it stopped on (DEM-102); false when unasked or
   *  unanswered (the log says why). */
  closedShadowRoot: boolean;
}

/** The walk on a prepared stage, and the checks straight after it. Throws
 *  what `runAuthored` and `assertSceneWasLoaded` throw: its caller removes
 *  whatever the walk wrote into `film.store`. */
export async function playOnStage(
  script: DemoScript,
  prepared: Extract<Prepared, { ok: true }>,
  deps: PlayDeps,
  film: PlayFilm,
  options: {
    startingBranding: SceneBranding;
    onProgress: (p: ReplayProgress) => void;
    mark?: (stage: "walk" | "checks") => void;
  },
): Promise<Played> {
  const { log } = deps;
  const { stage: launched, sessions, viewport } = prepared;
  const { page, clock } = launched;
  const recordedScale = deps.session.filmScale() ?? prepared.recordedAt;
  const { encoder, store, sceneId } = film;
  const { startingBranding, onProgress } = options;

  // What the landing check found at the start URL, when it was not simply
  // the page asked for: set by `landing` below, carried into the report.
  let landingNote: RunReport["landing"];
  let arrival: Arrival = null;

  const navigation = watchNavigation(launched.cdp);
  const cdp = navigation.cdp;
  // `createNavigatingGuard`, NEVER a bare `createOcclusionGuard`: the
  // navigation rides `install()` (see `replay.ts`'s `replayPhase`).
  const held = prepared.held?.clock;
  const occlusion = createNavigatingGuard({
    guard: createOcclusionGuard({ cdp, clock }),
    cdp,
    url: script.target,
    sleep: clock.sleep,
    ...(held === undefined ? {} : { held }),
  });

  // The walk's own `failed` note: a port that threw mid-run says what it
  // threw only here (walk.ts), and the result carries the reason alone.
  let failedNote: string | undefined;

  // Asked by the walk before its first frame (launch C): a string stops
  // the run as `signedOut` with those words. A page that cannot be read
  // films on, and the report says the check never happened
  // (`landing.unchecked`) rather than reading as a clean pass.
  const landing = async (): Promise<string | null> => {
    let facts: Awaited<ReturnType<typeof readLandingFacts>>;
    try {
      facts = await readLandingFacts(page, script.target);
    } catch (error) {
      landingNote = { unchecked: messageOf(error) };
      arrival = { unchecked: messageOf(error) };
      log(
        `the page could not be checked for a sign-in page (${messageOf(error)}); recording on`,
      );
      return null;
    }
    const verdict = landingVerdict(facts, sessions, deps.signinCommand);
    arrival = { facts, verdict };
    if (verdict.kind === "signedOut") return verdict.detail;
    if (verdict.startedElsewhere) {
      // Origin and path only, like `signin`'s sign-in page: a redirect's
      // query can carry a token, a nonce or an invite code, and its path a
      // reset or invite token (DEM-130).
      landingNote = {
        startedElsewhere: originAndPath(scrubUrl(facts.landedUrl)),
      };
    }
    return null;
  };
  let authored: AuthoredResult;
  // A Playwright `dialog` listener stops its own auto-dismiss, so the engine
  // alone answers each dialog, over CDP (DEM-161). Only on the walk's page,
  // only while it walks.
  const leaveToEngine = () => {};
  page.on("dialog", leaveToEngine);
  try {
    authored = await runAuthored(script, {
      cdp,
      page: createHeadlessPageAgent(page, log),
      captureResolved: pageCapture(page, log),
      encoder,
      store,
      clock,
      // Every CLI run may replay: see "No gate" in `runScript`.
      mayReplay: true,
      occlusion,
      landing,
      // Spec 2026-10-03: keep every frame the page paints, real time.
      recording: "continuous",
      onProgress: (progress) => {
        if (progress.state === "failed" && progress.note !== null) {
          failedNote = progress.note;
        }
        onProgress(progress);
      },
      newId,
      sceneId,
      // This package has no wall clock — `Clock.now()` is contracted for
      // deltas only — so the take's `createdAt` is the caller's to supply.
      createdAt: new Date().toISOString(),
      // Null only for a device script, whose size runAuthored takes from
      // the device.
      ...(viewport === null ? {} : { viewport }),
      // Decided once, at launch; the take records it for keep and the
      // flow's next run to read. A visible window's is its screen's, as read:
      // left out, the next run inferred it from the widest motion span to the
      // nearest quarter and told a 1.3125x screen it had changed scale.
      ...(recordedScale === undefined ? {} : { displayScale: recordedScale }),
      // Spec 2026-10-01 §1: the take starts as a recorded one does — the
      // author's kit and a zoom on every click.
      startingBranding,
      cameraFor: zoomsForClicks,
      // Spec 2026-10-19: the camera never sets off toward a zoom while an
      // earlier step is still acting; the replay waits for room instead.
      roomFor: (vp, intentOf) =>
        createRoomPolicy(vp, script.look?.motion ?? MOTION_DEFAULTS, intentOf),
      // Spec 2026-11-13: a scripted run plans its pauses on a designed clock
      // instead of waiting the camera's room out live.
      beats: { restBefore, afterScroll, actMs, tailMs, arriveMs: ARRIVE_MS },
      ...(prepared.held === undefined
        ? {}
        : { held: prepared.held.clock, network: prepared.held.network }),
    });
  } finally {
    // Whatever the walk did, the watch's listeners leave with it.
    page.off("dialog", leaveToEngine);
    prepared.held?.network.stop();
  }
  options.mark?.("walk");
  // Spread both ways round: `attributeClosedWindow` refines the run's stop
  // reason and returns a `ReplayResult`, which would drop `document`,
  // `documentError` and `steps` if it were assigned instead of merged.
  // Only a visible window can have been closed by a person. Headless has
  // none: its page going away is the browser crashing or the page closing
  // itself, which stays `portFailure` and says so (`lostHeadlessPage`).
  const pageLost = deps.session.closedSinceEnsure();
  const heldFailed = prepared.held?.clock.failed()?.message;
  // A page the held clock closed is not lost: `heldFailed` says why.
  const lostHeadlessPage =
    pageLost && deps.session.headless && heldFailed === undefined;
  const result: AuthoredResult = {
    ...authored,
    ...attributeClosedWindow(authored, pageLost && !deps.session.headless),
  };
  const navigationError = navigation.error();
  if (navigationError !== null) {
    log(`${script.target} did not load (${navigationError})`);
  }

  // A blank-frame bundle (`!occlusion.navigated()`) is already on disk by
  // now, and must not be left where a later read would serve it: the
  // assertion below throws for exactly that state, and the catch around
  // `runScript`'s `filmAndEncode` removes the whole take folder (bundle,
  // keyframes and parked frames) before rethrowing — the extension's
  // `deleteBundle` here, widened to everything the runner parks.
  assertSceneWasLoaded(result, occlusion.navigated());

  // A run that stopped short on a sign-in page (a session that lapsed
  // mid-run) is `signedOut` too. Continuous recording has already kept the
  // frames of that page, so the take is not kept (launch C, plan deviation
  // 1). A run that COMPLETED there — a sign-out demo — is kept. Asked here,
  // straight after the walk, so the page has not moved on, and before the
  // encode, so frames that will be discarded are not encoded. A closed
  // window is not asked: its own stop reason says what happened.
  let signedOutAfter: string | null = null;
  if (
    result.reason !== null &&
    result.reason !== "signedOut" &&
    result.completed < result.total &&
    !page.isClosed()
  ) {
    let facts: LandingFacts | null = null;
    try {
      facts = await readLandingFacts(page, script.target);
    } catch (error) {
      // The run's own stop reason still stands; what is lost is whether a
      // sign-in page caused it, and the report says so rather than
      // reading as "checked, not a sign-in page".
      log(
        `the run stopped and its page could not be checked for a sign-in page (${messageOf(error)})`,
      );
      landingNote ??= {
        unchecked: `the page the run stopped on could not be checked for a sign-in page: ${messageOf(error)}`,
      };
    }
    if (facts !== null) {
      const stoppedOn = signedOutMidRun(facts, sessions, deps.signinCommand);
      if (stoppedOn.kind === "signedOut") {
        if (deps.account === undefined) {
          signedOutAfter = stoppedOn.detail;
        } else {
          // Launch C2: the repo's steps sign in again now, so the agent's
          // next run films — said, with what happened if they could not.
          const again = await deps.account.signInAgain();
          signedOutAfter = again.ok
            ? `The session for ${deps.account.name} lapsed during the run; Demoman signed in again as ${deps.account.name}. Run it again.`
            : `The session for ${deps.account.name} lapsed during the run, and Demoman could not sign in again: ${again.detail}`;
        }
      } else if (stoppedOn.kind === "passwordPage") {
        log(
          `the run stopped on ${scrubUrl(facts.landedUrl)}, which shows a password field but is not ${stoppedOn.site}'s sign-in page (${scrubUrl(stoppedOn.signInUrl)}); its own stop reason stands`,
        );
      }
    }
  }
  // Read once, straight after the walk, while the last screen is up; only
  // for refresh, the one reader, and only after a walk that finished: a
  // stopped run must not wait on the page again (code review #2).
  const datesOnScreen =
    deps.readDates === true && result.reason === null
      ? await readDatesOnScreen(page, log)
      : [];
  // A target not found may be inside a closed shadow root, which no run can
  // reach (DEM-102). Not asked after a mid-run sign-out: the stop is that,
  // and signing in again has moved the page on.
  const failedStep = result.steps.at(-1)?.step;
  const closedShadowRoot =
    notFound(result) &&
    signedOutAfter === null &&
    failedStep !== undefined &&
    !page.isClosed()
      ? (await closedShadowHolds(page, targetWords(failedStep), log)) === true
      : false;
  options.mark?.("checks");
  return {
    closedShadowRoot,
    datesOnScreen,
    result,
    navigationError,
    failedNote,
    signedOutAfter,
    lostHeadlessPage,
    heldFailed,
    landingNote,
    arrival,
  };
}

/**
 * A walk that threw mid-run, in the door's voice: the category, what the
 * browser said, and the move — a complete sentence, because it is printed in
 * place of `reasonSentence("portFailure")`. Verbatim from the extension.
 */
const portFailureDetail = (note: string): string =>
  `something underneath the run gave way: ${note} — not a fault in the script, so rewriting steps will not fix it; run it once more, and if it stops the same way, report these words`;

/** The walk's stop reason as everything downstream reads it: `signedOut`
 *  when the page it stopped on is a sign-in page (`signedOutAfter`). */
export function walkedReason(played: Played): ReplayStopReason | null {
  return played.signedOutAfter === null ? played.result.reason : "signedOut";
}

/** DEM-102's known limitation, said only on a page that has one. */
const CLOSED_SHADOW_ROOT =
  "Also, this page has a closed shadow root, and a target inside one can't be reached during a run (a known limitation): target an element outside it";

/** A step stopped because its target was not on the page: not found, or
 *  waited for and never there. */
const notFound = (result: AuthoredResult): boolean =>
  result.reason === "unresolvedAnchor" ||
  (result.reason === "waitTimeout" &&
    result.steps.at(-1)?.waitSaw === "absent");

/**
 * `stopped.detail` is printed in place of the reason's sentence, so it is
 * set only where it IS that reason's explanation (as the extension's):
 * under `portFailure` the walk's note, under `deviceFailed` the device's
 * words, under `clickNotDelivered` where the click went, and — the
 * runner's own — a target that did not load, which the reason alone would
 * call a step that could not be found; and, when the target's words are
 * inside a closed shadow root, that no run can reach it (DEM-102).
 */
export function stopDetail(target: string, played: Played): string | undefined {
  const {
    result,
    navigationError,
    failedNote,
    signedOutAfter,
    lostHeadlessPage,
    heldFailed,
    closedShadowRoot,
  } = played;
  const waitSaw =
    result.reason === "waitTimeout" ? result.steps.at(-1)?.waitSaw : undefined;
  // `ownDetail` is the run's own, read off the walk before any re-label: a
  // run re-labelled `signedOut` after it stopped still says why it stopped.
  const ownDetail =
    heldFailed !== undefined
      ? heldFailed
      : result.reason === "portFailure" && lostHeadlessPage
        ? `Demoman's headless browser lost the run's page before the run finished: the browser crashed, or the page closed itself. There is no window anyone could have closed, and nothing in the script is at fault — run it once more${failedNote === undefined ? "" : ` (${failedNote})`}`
        : result.reason === "portFailure" && failedNote !== undefined
          ? portFailureDetail(failedNote)
          : result.reason === "deviceFailed" && failedNote !== undefined
            ? failedNote
            : result.reason === "clickNotDelivered" && failedNote !== undefined
              ? clickNotDeliveredDetail(failedNote)
              : waitSaw === "notVisible"
                ? "the step waited for an element that was found but not visible (transparent, hidden or a sliver), so it could never show — wait for something that does show, or act on the element that reveals it"
                : waitSaw === "ambiguous"
                  ? "the step waited for an element whose target matched more than one element on the page, so the wait could not tell which to watch — name a more precise target (a stableId, or a role with a fuller name, from a snapshot of the page)"
                  : waitSaw === "pageSilent" || waitSaw === "pageFaulted"
                    ? reasonSentence(waitSaw)
                    : navigationError !== null && result.outcome !== "complete"
                      ? `${target} did not load (${navigationError}) — check that the app is running at that address`
                      : closedShadowRoot && notFound(result) && result.reason
                        ? `${reasonSentence(result.reason)}. ${CLOSED_SHADOW_ROOT}`
                        : undefined;
  return signedOutAfter !== null && result.reason !== null
    ? `${signedOutAfter} The video was not kept: it would end on the sign-in page. ${ownStop(result, ownDetail ?? reasonSentence(result.reason))}`
    : walkedReason(played) === "signedOut" && failedNote !== undefined
      ? `${failedNote} Nothing was recorded.`
      : ownDetail;
}

/** Where a re-labelled run stopped, and why, in its own words: the step it
 *  was attempting (the last one it reached, by script position). The same
 *  record the report's `stopped.at.scriptStep` reads: a re-labelled run
 *  keeps no document (run.ts), so `buildStopped` falls back to it too. */
function ownStop(result: AuthoredResult, why: string): string {
  const at = result.steps.at(-1);
  const where =
    at === undefined
      ? "before its first step"
      : `at script step ${at.index + 1}`;
  return `The run itself stopped ${where}: ${why.replace(/\.$/, "")}.`;
}

/**
 * Whether a run that stopped short stopped because it was signed out. Only a
 * site with a saved session can lapse mid-run, so a site with no file is
 * never re-labelled (a public sign-up page has a password field too) — nor
 * through another site's file that shares its sign-in page. With a
 * file: its RECORDED sign-in page, or — when it recorded none (`signInUrl`
 * null) — `landingVerdict`'s password-field rule. A password field anywhere
 * else is an in-app page (change password, sudo mode): the run's own stop
 * stands and its take is kept.
 */
function signedOutMidRun(
  facts: LandingFacts,
  files: readonly SessionFile[],
  signinCommand: string,
):
  | { kind: "signedOut"; detail: string }
  | { kind: "passwordPage"; site: string; signInUrl: string }
  | { kind: "no" } {
  const file = fileForLanding(facts, files);
  if (file === undefined || !fileIsForLanding(facts, file)) {
    return { kind: "no" };
  }
  const verdict = landingVerdict(facts, files, signinCommand);
  if (verdict.kind !== "signedOut") return { kind: "no" };
  if (file.signInUrl === null || samePage(facts.landedUrl, file.signInUrl)) {
    return { kind: "signedOut", detail: verdict.detail };
  }
  return { kind: "passwordPage", site: file.site, signInUrl: file.signInUrl };
}

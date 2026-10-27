// apps/runner/src/executor/play.ts
import {
  type AuthoredResult,
  assertSceneWasLoaded,
  createNavigatingGuard,
  createOcclusionGuard,
  type EngineStore,
  type FrameEncoder,
  type ReplayProgress,
  type ReplayStopReason,
  reasonSentence,
  runAuthored,
} from "@demoman/replay-engine";
import {
  attributeClosedWindow,
  chooseRunSize,
  clickNotDeliveredDetail,
  createRoomPolicy,
  DEFAULT_RUN_SIZE,
  messageOf,
  newId,
  type RunReport,
  type RunSize,
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
import {
  fileForLanding,
  fileIsForLanding,
  type LandingFacts,
  type LandingVerdict,
  landingVerdict,
  readLandingFacts,
} from "./landing.js";
import { measureViewport, pageCapture } from "./page-ops.js";
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
>;

export type Prepared =
  | {
      ok: true;
      stage: Stage;
      sessions: SessionFile[];
      size: RunSize;
      viewport: { width: number; height: number } | null;
    }
  | { ok: false; reason: ReplayStopReason; detail: string };

/** The stage, its sessions and the size it films at. A refusal carries the
 *  sentence `runScript` reports as `stopped.detail`. */
export async function prepareStage(
  script: DemoScript,
  deps: PlayDeps,
): Promise<Prepared> {
  const { log } = deps;
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
  const sizePlan = chooseRunSize({
    scriptViewport: script.viewport,
    device: script.device === undefined ? undefined : deviceFor(script.device),
    setting: DEFAULT_RUN_SIZE,
    screen: await deps.session.screen(page),
  });
  // A size the script or its device chose is still filmed at 1x when
  // headless could not read the display, so the reason rides on it too: the
  // size is right and the scale is not.
  const scaleLost = deps.session.screenUnknown();
  // Only a screen that could not be read leaves the window's own size, and
  // then it is measured, never defaulted: this lands in
  // `meta.capture.viewport`, which is what the compositor composes every
  // frame against. The reason rides on `size.error`.
  let size: RunSize;
  if (sizePlan.kind === "fixed") {
    size =
      scaleLost !== null && sizePlan.size.error === null
        ? { ...sizePlan.size, error: scaleLost }
        : sizePlan.size;
  } else {
    log(`${sizePlan.error}; recording at the window's own size`);
    try {
      size = {
        ...(await measureViewport(page)),
        from: "window",
        error: sizePlan.error,
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
  return { ok: true, stage: launched, sessions, size, viewport };
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
  landingNote: RunReport["landing"];
  arrival: Arrival;
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
  const filmScale = deps.session.filmScale();
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
  const occlusion = createNavigatingGuard({
    guard: createOcclusionGuard({ cdp, clock }),
    cdp,
    url: script.target,
    sleep: clock.sleep,
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
      // query can carry a token, a nonce or an invite code.
      landingNote = { startedElsewhere: originAndPath(facts.landedUrl) };
    }
    return null;
  };
  const authored = await runAuthored(script, {
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
    // Decided once, at launch; the take records it for keep to read.
    ...(filmScale === null ? {} : { displayScale: filmScale }),
    // Spec 2026-10-01 §1: the take starts as a recorded one does — the
    // author's kit and a zoom on every click.
    startingBranding,
    cameraFor: zoomsForClicks,
    // Spec 2026-10-19: the camera never sets off toward a zoom while an
    // earlier step is still acting; the replay waits for room instead.
    roomFor: (vp) =>
      createRoomPolicy(vp, script.look?.motion ?? MOTION_DEFAULTS),
  });
  options.mark?.("walk");
  // Spread both ways round: `attributeClosedWindow` refines the run's stop
  // reason and returns a `ReplayResult`, which would drop `document`,
  // `documentError` and `steps` if it were assigned instead of merged.
  // Only a visible window can have been closed by a person. Headless has
  // none: its page going away is the browser crashing or the page closing
  // itself, which stays `portFailure` and says so (`lostHeadlessPage`).
  const pageLost = deps.session.closedSinceEnsure();
  const lostHeadlessPage = pageLost && deps.session.headless;
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
          `the run stopped on ${facts.landedUrl}, which shows a password field but is not ${stoppedOn.site}'s sign-in page (${stoppedOn.signInUrl}); its own stop reason stands`,
        );
      }
    }
  }
  options.mark?.("checks");
  return {
    result,
    navigationError,
    failedNote,
    signedOutAfter,
    lostHeadlessPage,
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

/**
 * `stopped.detail` is printed in place of the reason's sentence, so it is
 * set only where it IS that reason's explanation (as the extension's):
 * under `portFailure` the walk's note, under `deviceFailed` the device's
 * words, under `clickNotDelivered` where the click went, and — the
 * runner's own — a target that did not load, which the reason alone would
 * call a step that could not be found.
 */
export function stopDetail(target: string, played: Played): string | undefined {
  const {
    result,
    navigationError,
    failedNote,
    signedOutAfter,
    lostHeadlessPage,
  } = played;
  // `ownDetail` is the run's own, read off the walk before any re-label: a
  // run re-labelled `signedOut` after it stopped still says why it stopped.
  const ownDetail =
    result.reason === "portFailure" && lostHeadlessPage
      ? `Demoman's headless browser lost the run's page before the run finished: the browser crashed, or the page closed itself. There is no window anyone could have closed, and nothing in the script is at fault — run it once more${failedNote === undefined ? "" : ` (${failedNote})`}`
      : result.reason === "portFailure" && failedNote !== undefined
        ? portFailureDetail(failedNote)
        : result.reason === "deviceFailed" && failedNote !== undefined
          ? failedNote
          : result.reason === "clickNotDelivered" && failedNote !== undefined
            ? clickNotDeliveredDetail(failedNote)
            : navigationError !== null && result.outcome !== "complete"
              ? `${target} did not load (${navigationError}) — check that the app is running at that address`
              : undefined;
  return signedOutAfter !== null && result.reason !== null
    ? `${signedOutAfter} The take was not kept: it would end on the sign-in page. ${ownStop(result, ownDetail ?? reasonSentence(result.reason))}`
    : walkedReason(played) === "signedOut" && failedNote !== undefined
      ? `${failedNote} Nothing was recorded.`
      : ownDetail;
}

/** A URL's origin and path; the raw text when it does not parse. */
function originAndPath(raw: string): string {
  try {
    const u = new URL(raw);
    return `${u.origin}${u.pathname}`;
  } catch {
    return raw;
  }
}

/** Where a re-labelled run stopped, and why, in its own words: the step it
 *  was attempting (the last one it reached, by script position). */
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

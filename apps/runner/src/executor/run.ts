// apps/runner/src/executor/run.ts
import type { Degradation, FrameBundle } from "@demoman/compositor";
import {
  type AuthoredResult,
  assertSceneWasLoaded,
  authoredTotal,
  createNavigatingGuard,
  createOcclusionGuard,
  type ReplayProgress,
  type ReplayStopReason,
  reasonSentence,
  runAuthored,
} from "@demoman/replay-engine";
import {
  attributeClosedWindow,
  type BrandKitsRead,
  buildRunReport,
  chooseRunSize,
  clickNotDeliveredDetail,
  createRoomPolicy,
  DEFAULT_RUN_SIZE,
  filmForRun,
  linksOf,
  loadRecording,
  lookForRun,
  messageOf,
  newId,
  pausedBeforeActions,
  type RefilmInfo,
  type RunReport,
  type RunSize,
  recordingForRun,
  type ScriptSkeleton,
  skeletonOf,
  statusOf,
  type WalkResultLike,
  zoomsForClicks,
} from "@demoman/run-core";
import {
  type DemoScript,
  deviceFor,
  MOTION_DEFAULTS,
} from "@demoman/scene-schema";
import type { BrowserContext, Page } from "playwright";
import { createParkingEncoder, type ParkedSpan } from "../encoder.js";
import type { RunnerStore } from "../frame-store.js";
import { type MuxOutcome, muxSpans } from "../mux.js";
import { createHeadlessPageAgent } from "../page-agent.js";
import { watchNavigation } from "../replay.js";
import { stageTimes } from "../stage-times.js";
import type { BrowserSession } from "./browser.js";
import {
  fileForLanding,
  fileIsForLanding,
  type LandingFacts,
  landingVerdict,
  readLandingFacts,
} from "./landing.js";
import { type Library, LibraryError } from "./library.js";
import { measureViewport, pageCapture } from "./page-ops.js";
import type { SessionsLoaded } from "./session-loader.js";
import {
  type SessionChoice,
  type SessionFile,
  type SessionStore,
  samePage,
  siteOf,
  writeBackOf,
} from "./sessions.js";

/**
 * The CLI executor's `run`: a script in, a take in the library on disk and a
 * `RunReport` out.
 *
 * A port of the extension's `runAuthoredInWindow`
 * (`apps/extension/src/adapters/authored-runner.ts`) with its ports swapped:
 * the CLI's own Chromium (`BrowserSession`) for the stage window and
 * `chrome.debugger`, the folder library (`createLibrary`) for IndexedDB, and
 * a parking encoder plus a mux pass for the in-page WebCodecs encoder. Where
 * the logic is the same its comments are kept; the ones about what differs
 * say so.
 *
 * **It resolves, with exceptions, and they are deliberate** (as the
 * extension's): a kit that went away (`lookForRun`), a `runAuthored` that
 * rejects, `assertSceneWasLoaded` (frames harvested from a page the run never
 * loaded), and any throw out of `muxSpans` — its misalignment invariant, or
 * its own setup (`page.goto`, `addScriptTag`, bundling the mux entry) — all
 * propagate. The executor's `run` op answers `{outcome: "threw", error}` for
 * each, as the run page does. Every one after the take's folder was first
 * written removes that folder before it rethrows (`filmAndEncode`'s caller),
 * so a throw never leaves raw frames where `list()` skips them and nothing
 * sweeps them.
 */

/** A run that never reached the engine, in the shape a report is built from.
 *  Zero of `total` performed, no frames, and nothing lost to a store that was
 *  never asked — the same reading `refusedRun` takes for the rebuild. */
function blankWalk(total: number, reason: ReplayStopReason): WalkResultLike {
  return {
    reason,
    completed: 0,
    total,
    bundle: null,
    degradations: [],
    storageRefused: false,
    counters: { encodeShrunkSpans: 0 },
  };
}

/**
 * A walk that threw mid-run, in the door's voice: the category, what the
 * browser said, and the move — a complete sentence, because it is printed in
 * place of `reasonSentence("portFailure")`. Verbatim from the extension.
 */
const portFailureDetail = (note: string): string =>
  `something underneath the run gave way: ${note} — not a fault in the script, so rewriting steps will not fix it; run it once more, and if it stops the same way, report these words`;

export interface RunDeps {
  session: BrowserSession;
  library: Library;
  kits: BrandKitsRead;
  log: (line: string) => void;
  /** The saved sessions the context was just loaded with (launch C). */
  sessions: SessionFile[];
  /** The context `sessions` were loaded into. A run staged in another one
   *  (the browser relaunched in between) loads them again first. */
  sessionsContext: BrowserContext;
  /** The executor's loader, for that second load. */
  loadSessions: (
    context: BrowserContext,
    choice: SessionChoice | null,
  ) => Promise<SessionsLoaded>;
  sessionStore: SessionStore;
  /** What `signedOut` tells the user to run. */
  signinCommand: string;
  /** Launch C2: the account the run films as. When the session lapses
   *  mid-run, the repo's steps sign in again and the report says so. */
  account?: {
    name: string;
    signInAgain(): Promise<{ ok: true } | { ok: false; detail: string }>;
  };
  /** Every string in the report passes this before `report.json` is
   *  written: the executor's secret sweep. */
  scrub?: <T>(value: T) => T;
  /** Set by a re-record (`run({ video: { id } })` with no script): what the
   *  merge said, carried into the report. */
  refilm?: RefilmInfo;
  /** Joins the run's take to its video once the take is in the library;
   *  throws a sentence saying what failed, which `notStored` carries. */
  joinVideo?: (
    takeId: string,
  ) => Promise<NonNullable<RunReport["videoVersion"]>>;
  /** The checkout's commit (`git rev-parse HEAD`), stored as the take's
   *  `meta.capture.buildSha`. Absent: not a checkout, or no commit yet. */
  buildSha?: string;
  /** Tests only: the mux, so a test can make it throw. Defaults to
   *  `muxSpans`. */
  muxSpans?: typeof muxSpans;
}

/** One span's encode loss: `refused` of its `span.frames`, and whether
 *  the whole span left the bundle (the mux removed it) or stays with holes. */
export interface EncodeLoss {
  span: ParkedSpan;
  refused: number;
  why: string;
  removed: boolean;
}

/**
 * What a mux lost, span by span: a span it could not encode at all
 * (`kept: false`, which `muxSpans` removed from the bundle) and a span it
 * kept with frames missing (`lost > 0`). `kept` is the encoder's kept spans
 * in order — `MuxedSpan.index` indexes it (mux.ts's docblock).
 */
export function encodeLossesOf(
  outcome: MuxOutcome,
  kept: readonly ParkedSpan[],
): EncodeLoss[] {
  return outcome.muxed
    .filter((m) => !m.kept || m.lost > 0)
    .map((m) => ({
      span: kept[m.index] as ParkedSpan,
      refused: m.lost,
      why: m.kept
        ? "frames missing or unreadable when the span was encoded"
        : (m.reason ?? "no reason given"),
      removed: !m.kept,
    }));
}

/**
 * Motion the run kept and the encode lost, said where the report reads it.
 *
 * The extension encodes during the walk, so frames its encoder refuses are
 * an `encodeRefused` degradation the engine writes over the span, with a
 * k-of-n note (`motion-recorder.ts`'s `refusalNote`). Here the encode happens
 * after the walk, in `muxSpans`, which says what it lost only on its return
 * value — a whole span (removed from `bundle.motionSpans`) or frames inside a
 * span it kept. Without this, either loss reported `complete` with clean
 * `frames.degradations`, the same report as a lossless run. The degradation
 * goes on the bundle (so the take on disk says it) and on the walk the report
 * is built from, which are one array when the engine handed back one. A span
 * that was removed is filtered out here too, so a bundle never names video
 * that was never written.
 */
export async function recordEncodeLosses(
  bundle: FrameBundle,
  walkDegradations: Degradation[],
  losses: EncodeLoss[],
  store: RunnerStore,
  sceneId: string,
  log: (line: string) => void,
): Promise<void> {
  if (losses.length === 0) return;
  const removed = new Set(
    losses.filter((l) => l.removed).map((l) => l.span.ref),
  );
  if (removed.size > 0) {
    bundle.motionSpans = bundle.motionSpans.filter((s) => !removed.has(s.ref));
  }
  for (const { span, refused, why } of losses) {
    // `motion-recorder.ts`'s `refusalNote`, word for word, with the parked
    // span's own size for the one it opened on.
    const entry: Degradation = {
      startMs: span.startMs,
      endMs: span.endMs,
      kind: "encodeRefused",
      note:
        `the encoder refused ${refused} of ${span.frames} frames of a span that ` +
        `opened on ${span.width}x${span.height} (${why})`,
    };
    bundle.degradations.push(entry);
    if (walkDegradations !== bundle.degradations) walkDegradations.push(entry);
  }
  await store.putBundle(sceneId, bundle).catch((error: unknown) => {
    log(
      `the take's bundle could not be rewritten after its motion was encoded — the bundle on disk does not say that ${losses.length} span(s) lost frames${removed.size > 0 ? `, and may still name ${removed.size} span(s) with no video behind them` : ""} (${messageOf(error)})`,
    );
  });
}

export async function runScript(
  script: DemoScript,
  deps: RunDeps,
  onProgress: (progress: ReplayProgress) => void,
): Promise<RunReport> {
  const { library, log } = deps;
  const times = stageTimes();
  const run: RunReport["run"] = {
    id: newId("run"),
    startedAt: Date.now(),
    target: script.target,
    executor: "cli",
    script: {
      name: script.name,
      scriptVersion: script.scriptVersion,
      steps: script.steps.length,
    },
  };

  // The executor's door refused an unknown `look.kit` before this was called,
  // so a refusal here is a kit that changed in between. Thrown, so the op
  // reports `threw` with the kit's sentence: never a take on another brand
  // that reports success.
  const resolved = lookForRun(script, deps.kits);
  if (!resolved.ok) {
    throw new Error(
      `the run's brand kit could not be used: ${resolved.detail}`,
    );
  }
  const { startingBranding, look } = resolved;

  // What the walk is measured against: every step but `pause`, which is a
  // duration and yields no beat. See `authoredTotal`.
  const total = authoredTotal(script);

  // Minted here, not by the engine: keyframes are written under it DURING the
  // run, so a run that assembles no document has still left frames in the
  // store, and an id the caller never learned is an orphan nothing can find or
  // sweep. See `AuthoredDeps.sceneId`. It is also the take's folder name.
  const sceneId = newId("scene");

  // Nothing was filmed at these sites: the film says why, and the recording
  // says whether the script named one it could not be held against.
  const noFilm = () => ({
    film: filmForRun({ refused: false, scene: null, bundle: null }),
    recording:
      script.recordedFrom === undefined
        ? ({ unavailable: "noRecording" } as const)
        : ({ unavailable: "noRunVideo" } as const),
  });

  /** A run that produced nothing, reported with the reason AND the sentence
   *  this door would have shown a person — the note reaches the report as
   *  `stopped.detail`, not only `onProgress`. */
  const noTake = (reason: ReplayStopReason, note: string): RunReport => {
    onProgress({ step: 0, total, keyframes: 0, state: "failed", note });
    return buildRunReport({
      ...noFilm(),
      look,
      run,
      // No take, and that is the fact rather than a missing argument: the
      // verdict says it cannot be checked instead of reading as a match.
      scene: null,
      madeFrom: null,
      walk: blankWalk(total, reason),
      steps: [],
      detail: note,
      size: null,
    });
  };

  // What the landing check found at the start URL, when it was not simply
  // the page asked for: set by `landing` below, carried into the report.
  let landingNote: RunReport["landing"];
  /** Set by the walk: headless lost the run's page before it finished. */
  let lostHeadlessPage = false;

  // A script of nothing but pauses. `DemoScriptSchema` refuses one outright, so
  // this is the backstop for a caller that skipped the parse. The note is
  // load-bearing: `reasonSentence("noActions")` is the re-shoot's sentence and
  // is false here.
  if (total === 0) {
    return noTake(
      "noActions",
      "every step in this script is a pause, which performs nothing — add a step that acts on the page and run it again",
    );
  }

  // No gate. The CLI admits every target, headless or not (author's ruling
  // 2026-10-20): a developer's own agent is filming their own app, mostly
  // local and cloud development environments, and a team filming its
  // production behind a bot wall allows its own bot there. So a run is
  // attended, someone asked for it, and there is no "replay mutating
  // scenes" setting to consult. The rule that refuses a published target
  // unattended (v8 §491) stays with the runner's `replay` command, a CI
  // robot nobody asked in the moment.

  // Ensured at the door already; a failure here is a race with the author
  // closing the browser in between, said in the session's own words. A page
  // of its own, so nothing an earlier call emulated or installed is on it
  // (`BrowserSession.stage`).
  const staged = await deps.session.stage();
  if (!staged.ok) return noTake("portFailure", staged.detail);
  const launched = staged.stage;
  const { page, clock } = launched;

  // The executor loaded the saved sessions into the context `ensure()` gave
  // it; the stage can be a later one if the browser relaunched in between
  // (the author closed it). Loaded again here, or this run would go out
  // signed out and be told its session expired.
  let sessions = deps.sessions;
  if (launched.context !== deps.sessionsContext) {
    const reloaded = await deps.loadSessions(launched.context, null);
    if (!reloaded.ok) {
      return noTake(
        "portFailure",
        `the browser restarted after its saved sessions were loaded, and they could not be loaded again: ${reloaded.detail}`,
      );
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
      return noTake(
        "portFailure",
        `the script named no viewport, ${sizePlan.error}, and the run could not measure its own window either: ${messageOf(error)} — name a viewport in the script and run it again`,
      );
    }
  }
  // A device is its own size, which runAuthored takes from the device
  // (spec 2026-10-10), so it is handed no viewport.
  const viewport =
    size.from === "device" ? null : { width: size.width, height: size.height };

  // Differs from the extension: frames are parked to the take's own folder
  // and encoded after the walk (`muxSpans`), and `Page.navigate`'s
  // `errorText` is read at the runner's edge (`watchNavigation`).
  const store = library.frameStore(sceneId);
  const mux = deps.muxSpans ?? muxSpans;
  times.mark("setup");

  /** The walk and the encode: everything that writes into the take's folder
   *  before the take exists. Its caller removes that folder on any throw. */
  const filmAndEncode = async () => {
    const encoder = createParkingEncoder(store, sceneId);
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
        log(
          `the page could not be checked for a sign-in page (${messageOf(error)}); recording on`,
        );
        return null;
      }
      const verdict = landingVerdict(facts, sessions, deps.signinCommand);
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
      // Every CLI run may replay: see "No gate" above.
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
      // Spec 2026-10-01 §1: the take starts as a recorded one does — the
      // author's kit and a zoom on every click.
      startingBranding,
      cameraFor: zoomsForClicks,
      // Spec 2026-10-19: the camera never sets off toward a zoom while an
      // earlier step is still acting; the replay waits for room instead.
      roomFor: (vp) =>
        createRoomPolicy(vp, script.look?.motion ?? MOTION_DEFAULTS),
    });
    times.mark("walk");
    // Spread both ways round: `attributeClosedWindow` refines the run's stop
    // reason and returns a `ReplayResult`, which would drop `document`,
    // `documentError` and `steps` if it were assigned instead of merged.
    // Only a visible window can have been closed by a person. Headless has
    // none: its page going away is the browser crashing or the page closing
    // itself, which stays `portFailure` and says so (`lostHeadlessPage`).
    const pageLost = deps.session.closedSinceEnsure();
    lostHeadlessPage = pageLost && deps.session.headless;
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
    // assertion below throws for exactly that state, and the catch around this
    // function removes the whole take folder (bundle, keyframes and parked
    // frames) before rethrowing — the extension's `deleteBundle` here, widened
    // to everything the runner parks.
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
    times.mark("checks");
    // No take is kept for a signed-out run, so its frames are not encoded.
    const discarded = result.reason === "signedOut" || signedOutAfter !== null;

    // The runner parks raw frames during the run; they become video spans
    // here, on a second page (mux needs a loopback page for WebCodecs, and the
    // author's window must not be navigated away). Attempted whenever there is
    // a bundle, the author's window closed or not: a closed window leaves the
    // context, and a span that cannot be encoded must leave the bundle rather
    // than stay in it naming bytes that were never written.
    if (result.bundle !== null && !discarded) {
      const bundle = result.bundle;
      const kept = encoder.spans().filter((s) => s.kept);
      let muxPage: Page | null = null;
      let noPage: string | null = null;
      if (kept.length > 0) {
        const work = await deps.session.openWorkPage({ relaunch: false });
        // `work.detail` already says what the browser would not do ("the
        // browser would not open a page to encode or render in: …", or that
        // it was gone): said once, not wrapped in a second copy of itself.
        if (work.ok) muxPage = work.page;
        else noPage = work.detail;
      }
      if (noPage !== null) {
        log(`${kept.length} motion span(s) were not encoded: ${noPage}`);
        await recordEncodeLosses(
          bundle,
          result.degradations,
          kept.map((span) => ({
            span,
            refused: span.frames,
            why: noPage,
            removed: true,
          })),
          store,
          sceneId,
          log,
        );
      } else if (muxPage !== null) {
        try {
          // A throw here — spans and bundle misaligned (an engine invariant),
          // or the mux's own setup — propagates, and the caller of this
          // function removes the take folder first.
          const outcome = await mux({
            sceneId,
            page: muxPage,
            store,
            spans: encoder.spans(),
            bundle,
            report: log,
          });
          // A span lost whole (`kept: false`, already removed from the bundle
          // by `muxSpans`) and frames lost inside a span it kept (`lost > 0`)
          // are both said on the bundle and the walk (`recordEncodeLosses`).
          const losses = encodeLossesOf(outcome, kept);
          if (losses.length > 0) {
            log(
              `the encode lost motion — ${losses.map((l) => `${l.refused} of ${l.span.frames} frames of span ${l.span.index}${l.removed ? " (span removed)" : ""}: ${l.why}`).join("; ")}`,
            );
            await recordEncodeLosses(
              bundle,
              result.degradations,
              losses,
              store,
              sceneId,
              log,
            );
          }
        } finally {
          await muxPage.close().catch((error: unknown) => {
            log(`the encoding page would not close (${messageOf(error)})`);
          });
        }
      }
    }
    const muxed = encoder.spans().filter((s) => s.kept);
    times.mark("mux");
    times.note(
      `${muxed.length} span(s), ${muxed.reduce((n, s) => n + s.frames, 0)} frames muxed`,
    );
    return { result, navigationError, failedNote, signedOutAfter };
  };

  let filmed: Awaited<ReturnType<typeof filmAndEncode>>;
  try {
    filmed = await filmAndEncode();
  } catch (error) {
    // Rethrown, so the op answers `threw` — but not before the take folder
    // goes: its raw parked frames would otherwise sit in the library with no
    // scene beside them, skipped by `list()` and swept by nothing.
    await library.removeTake(sceneId).catch((removal: unknown) => {
      log(
        `the run threw (${messageOf(error)}) and its frames could not be removed from ${library.takeDir(sceneId)} (${messageOf(removal)})`,
      );
    });
    throw error;
  }
  const { result, navigationError, failedNote, signedOutAfter } = filmed;

  const signedOut = result.reason === "signedOut" || signedOutAfter !== null;
  // The walk as the report and the take's bookkeeping read it: re-labelled
  // when the page it stopped on is a sign-in page. Every read below is of
  // this, never of `result`, so a discarded take leaves no scene, status,
  // script.json, report.json or frames behind.
  const walked: AuthoredResult =
    signedOutAfter === null ? result : { ...result, reason: "signedOut" };

  // --- the take, and everything that says it happened -----------------
  //
  // In this order, and every failure named: the document first, because
  // nothing — not the status, not the frames — can be found without it.
  // Differs from the extension: no telemetry event (the CLI has no uploader;
  // global constraints, "No telemetry store in the CLI").
  const notStored: NonNullable<RunReport["notStored"]> = [];
  let takeId: string | null = null;
  // No take for a signed-out run: before filming there is nothing to keep,
  // and after a mid-run lapse its frames end on the sign-in page.
  const walkedDoc = signedOut ? null : walked.document;
  const document =
    walkedDoc === null || deps.buildSha === undefined
      ? walkedDoc
      : {
          ...walkedDoc,
          meta: {
            ...walkedDoc.meta,
            capture: {
              ...walkedDoc.meta.capture,
              buildSha: deps.buildSha,
              buildShaSource: "git rev-parse HEAD",
            },
          },
        };
  if (document !== null) {
    try {
      // Swept like report.json: an anchor's text can carry a displayed value
      // (final review M4). Frames are pixels and cannot be swept.
      await library.putScene(
        deps.scrub === undefined ? document : deps.scrub(document),
      );
      takeId = document.meta.id;
    } catch (error) {
      notStored.push({
        what: "take",
        error: error instanceof LibraryError ? error.message : messageOf(error),
      });
    }
  } else if (!signedOut && walked.documentError !== null) {
    // The run measured its steps and the assembler produced something the
    // schema refused. Not a store failure, but the same consequence — the
    // take is not in the library — and `documentError` is the only thing
    // that says which field was wrong.
    notStored.push({ what: "take", error: walked.documentError });
  }
  if (document !== null && takeId !== null) {
    try {
      await library.putJson(
        takeId,
        "status.json",
        deps.scrub === undefined
          ? statusOf(walked)
          : deps.scrub(statusOf(walked)),
      );
    } catch (error) {
      notStored.push({ what: "status", error: messageOf(error) });
    }
    await writeSkeleton(
      library,
      takeId,
      deps.scrub === undefined
        ? skeletonOf(script, walked.steps, document)
        : deps.scrub(skeletonOf(script, walked.steps, document)),
      notStored,
    );
  }
  let videoVersion: RunReport["videoVersion"];
  if (takeId !== null && deps.joinVideo !== undefined) {
    try {
      videoVersion = await deps.joinVideo(takeId);
    } catch (error) {
      notStored.push({ what: "video", error: messageOf(error) });
    }
  }
  if (takeId === null) {
    // Frames with no take to belong to: removed, and said if they cannot be.
    await library.removeTake(sceneId).catch((error: unknown) => {
      log(
        `the run's frames have no take and could not be removed from ${library.takeDir(sceneId)} (${messageOf(error)})`,
      );
    });
  } else {
    // The raw frames the mux read are now in the spans' video; left, they
    // would hold the whole run uncompressed in the library for the life of
    // the take.
    await store.dropParked(`${sceneId}:replay`).catch((error: unknown) => {
      log(
        `the run's raw frames could not be removed from ${library.takeDir(sceneId)} after encoding; the take is whole, they only hold space (${messageOf(error)})`,
      );
    });
  }

  const film = filmForRun({
    refused: false,
    scene: document,
    bundle: walked.bundle,
    paused: pausedBeforeActions(script.steps, walked.steps),
  });
  const { links, unlinked } = linksOf(walked.steps);
  const loaded =
    script.recordedFrom === undefined
      ? null
      : await loadRecording(script.recordedFrom, {
          getScene: (id) => library.getScene(id),
          // The CLI library holds agent takes only: there is no recorded
          // take with a capture bundle to compare against, and
          // `recordingForRun` says so.
          getCaptureBundle: async () => null,
        });
  const recording = recordingForRun({
    loaded,
    run: { scene: document, bundle: walked.bundle, links, unlinked },
  });

  // `stopped.detail` is printed in place of the reason's sentence, so it is
  // set only where it IS that reason's explanation (as the extension's):
  // under `portFailure` the walk's note, under `deviceFailed` the device's
  // words, under `clickNotDelivered` where the click went, and — the
  // runner's own — a target that did not load, which the reason alone would
  // call a step that could not be found.
  //
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
              ? `${script.target} did not load (${navigationError}) — check that the app is running at that address`
              : undefined;
  const detail =
    signedOutAfter !== null && result.reason !== null
      ? `${signedOutAfter} The take was not kept: it would end on the sign-in page. ${ownStop(result, ownDetail ?? reasonSentence(result.reason))}`
      : walked.reason === "signedOut" && failedNote !== undefined
        ? `${failedNote} Nothing was recorded.`
        : ownDetail;

  // A signed-in run's session goes back to its file; a signed-out one has
  // nothing worth keeping.
  if (!signedOut) {
    await writeSessionBack(
      page,
      launched.context,
      script.target,
      { ...deps, sessions },
      notStored,
      log,
    );
  }

  const built = buildRunReport({
    film,
    recording,
    look,
    run,
    // The take the run produced, or null when there is none — which is
    // what makes the verdict say "cannot be checked" rather than "matches".
    scene: document,
    // What the FRAMES record they were made from, read off the bundle
    // rather than off the document: the whole point of the verdict is that
    // those two can disagree.
    madeFrom: walked.bundle?.madeFrom ?? null,
    // Null, never "": an empty string reads like an id and a caller would
    // try to open it.
    takeId,
    bundleId:
      takeId !== null && walked.bundle !== null && !walked.storageRefused
        ? `${takeId}:${walked.bundle.source}`
        : null,
    ...(notStored.length > 0 ? { notStored } : {}),
    walk: walked,
    steps: walked.steps,
    ...(detail === undefined ? {} : { detail }),
    size,
  });
  const report: RunReport = {
    ...built,
    ...(landingNote === undefined ? {} : { landing: landingNote }),
    ...(deps.refilm === undefined ? {} : { rerecord: deps.refilm }),
    ...(videoVersion === undefined ? {} : { videoVersion }),
  };
  times.mark("store");
  log(times.line(`run ${takeId ?? sceneId}`));
  if (takeId !== null) {
    await library
      .putJson(
        takeId,
        "report.json",
        deps.scrub === undefined ? report : deps.scrub(report),
      )
      .catch((error: unknown) => {
        log(
          `the run's report could not be written beside the take (${messageOf(error)})`,
        );
      });
  }
  return report;
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

/** What a re-film starts from (spec 2026-10-14 re-film §1). Its loss costs
 *  only a later re-film's pauses, so the take stands — and the report says
 *  which file is missing and why. */
export async function writeSkeleton(
  library: Pick<Library, "putJson">,
  takeId: string,
  skeleton: ScriptSkeleton,
  notStored: NonNullable<RunReport["notStored"]>,
): Promise<void> {
  try {
    await library.putJson(takeId, "script.json", skeleton);
  } catch (error) {
    notStored.push({
      what: "script",
      error: error instanceof LibraryError ? error.message : messageOf(error),
    });
  }
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

/**
 * After a signed-in run, the site's file takes the context's current state,
 * so a token the app rotated stays current (launch C). Skipped, and said:
 * - when the run ended on the site's sign-in page (a sign-out demo), whose
 *   state would overwrite a session that may still be good;
 * - when the file changed since the run loaded it: a `signin` made while
 *   the run was going is newer than anything this run holds;
 * - when a cookie the file held is gone from the context: a sign-out that
 *   ended somewhere other than the sign-in page must not overwrite a saved
 *   session that may still be good (a rotated cookie keeps its name).
 * The file is the start URL's site's, else the final page's: a run that
 * ends on another site still refreshes the site it was filming.
 * A final page that cannot be read is written back as any other. A write
 * that fails keeps the take and lands in `notStored` as `"session"`.
 */
async function writeSessionBack(
  page: Page,
  context: BrowserContext,
  target: string,
  deps: Pick<RunDeps, "sessions" | "sessionStore" | "signinCommand">,
  notStored: NonNullable<RunReport["notStored"]>,
  log: (line: string) => void,
): Promise<void> {
  const fileFor = (url: string): SessionFile | undefined => {
    const s = siteOf(url);
    return s === null ? undefined : deps.sessions.find((f) => f.site === s);
  };
  const loaded =
    fileFor(target) ?? (page.isClosed() ? undefined : fileFor(page.url()));
  if (loaded === undefined) return;
  const site = loaded.site;
  if (!page.isClosed()) {
    let facts: LandingFacts | null = null;
    try {
      facts = await readLandingFacts(page, target);
    } catch (error) {
      log(
        `the run's last page could not be checked for a sign-in page (${messageOf(error)}); its session is written back as usual`,
      );
    }
    if (
      facts !== null &&
      (landingVerdict(facts, deps.sessions, deps.signinCommand).kind ===
        "signedOut" ||
        (loaded.signInUrl !== null &&
          samePage(facts.landedUrl, loaded.signInUrl)))
    ) {
      log(
        `the run ended on ${site}'s sign-in page (${facts.landedUrl}), so its saved session was kept as it was`,
      );
      return;
    }
  }
  try {
    // The state first: it is the slow read. The store is read after it, so
    // a `signin` that lands meanwhile is seen and not overwritten.
    const state = await context.storageState({ indexedDB: true });
    const slice = writeBackOf(state, loaded);
    // A cookie past its own expiry is gone by the browser's clock, not by a
    // sign-out: counting it would stop every later write-back for good once
    // one short-lived cookie (OAuth state, CSRF) lapsed in the file.
    const expiredBy = Date.now() / 1000;
    const gone = loaded.state.cookies.filter(
      (c) =>
        !(c.expires > 0 && c.expires <= expiredBy) &&
        !slice.cookies.some(
          (n) =>
            n.name === c.name && n.domain === c.domain && n.path === c.path,
        ),
    );
    if (gone.length > 0) {
      log(
        `the run ended without ${gone.map((c) => c.name).join(", ")}, a cookie the saved session for ${site} holds (signed out?), so that session was kept as it was`,
      );
      return;
    }
    // The same file, not just the same site: an account's session and the
    // site's manual one share a site and are different files.
    const now = (await deps.sessionStore.read()).files.find(
      (f) =>
        f.site === site &&
        f.account?.origin === loaded.account?.origin &&
        f.account?.name === loaded.account?.name,
    );
    if (now === undefined || now.savedAt !== loaded.savedAt) {
      log(
        `the session for ${site} changed during the run; it was not written back`,
      );
      return;
    }
    await deps.sessionStore.save({
      ...loaded,
      refreshedAt: new Date().toISOString(),
      state: slice,
    });
  } catch (error) {
    notStored.push({ what: "session", error: messageOf(error) });
  }
}

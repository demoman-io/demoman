import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import type { Degradation, RenderTarget } from "@demoman/compositor";
import type { ReplayStopReason } from "@demoman/replay-engine";
import type { SceneDocument } from "@demoman/scene-schema";
import { createFileFrameStore } from "./frame-store.js";
import { chromiumInstallCommand } from "./install-advice.js";
import { type Launched, launch } from "./launch.js";
import { type MuxedSpan, muxSpans } from "./mux.js";
import { renderPhase } from "./render.js";
import { replayPhase } from "./replay.js";
import { messageOf, type Report } from "./report.js";

/**
 * Lines the pipeline needs printed **after** whatever sentence its own
 * result produces.
 *
 * Whole-branch review finding 9: `runPipeline`'s teardown lives in a
 * `finally`, and a `finally` unwinds before its caller's `switch` runs — so
 * a scratch-directory line written straight to `console.error` there landed
 * ABOVE the failure it belongs under, and stderr read bottom-up on every
 * failing run. Carrying those lines on the result instead lets the one place
 * that knows the ordering — the caller — print them last.
 */
interface PipelineNotes {
  notes?: string[];
}

export interface RenderedResult extends PipelineNotes {
  kind: "rendered";
  outPath: string;
  completed: number;
  total: number;
  degradations: string[];
  storageRefused: boolean;
}

export interface ReplayStoppedResult extends PipelineNotes {
  kind: "replayStopped";
  reason: ReplayStopReason;
  completed: number;
  total: number;
}

/**
 * The browser said the target URL could not be loaded.
 *
 * Whole-branch review finding 3: `Page.navigate`'s `errorText` was dropped
 * unread, so `http://127.0.0.1:1/` — a refused connection — replayed against
 * `about:blank`, failed to resolve its first anchor, and told the author to
 * re-record a step that is not broken. The `--url` is the input at fault, so
 * this exits with the input code rather than replay's.
 */
export interface TargetUnreachableResult extends PipelineNotes {
  kind: "targetUnreachable";
  targetUrl: string;
  /** Chromium's own net error, verbatim — `net::ERR_CONNECTION_REFUSED`. */
  errorText: string;
}

export interface MuxFailedResult extends PipelineNotes {
  kind: "muxFailed";
  spanIndex: number;
  message: string;
}

export interface RenderFailedResult extends PipelineNotes {
  kind: "renderFailed";
  message: string;
}

/**
 * The run never got as far as having a scene problem or a runner bug: no
 * browser to drive, or nowhere to put the frames.
 *
 * Whole-branch review finding 2: a machine with no Chromium installed was
 * told "internal error — this is a bug in the runner", which is exactly the
 * inversion design §5 exists to prevent. This names the real cause and exits
 * `EX_UNAVAILABLE`, leaving 70 for invariant violations alone.
 */
export interface StartupFailedResult extends PipelineNotes {
  kind: "startupFailed";
  message: string;
}

/**
 * An invariant violation — design §5's exit-70 row, returned rather than
 * thrown so the pipeline's own teardown notes can ride along and print in
 * the right order.
 */
export interface InternalErrorResult extends PipelineNotes {
  kind: "internalError";
  message: string;
  stack?: string;
}

export type PipelineResult =
  | RenderedResult
  | ReplayStoppedResult
  | TargetUnreachableResult
  | MuxFailedResult
  | RenderFailedResult
  | StartupFailedResult
  | InternalErrorResult;

/** A recorded scene replayed against `targetUrl` and rendered to `outPath`. */
export type RunPipeline = (input: {
  scene: SceneDocument;
  targetUrl: string;
  outPath: string;
  /** The built-in wallpapers' folder, as `ExportDeps.wallpapersDir`. */
  wallpapersDir: string;
  /** Tests only: the widest MP4 tier the render may use, so a lane can
   *  render landscape in software at 1080p where the keyframes back 4K.
   *  Production never sets it; the keyframes decide. */
  maxTier?: RenderTarget;
}) => Promise<PipelineResult>;

/** F1: `PipelineResult.degradations` is `string[]`, `ReplayResult`'s own
 *  `Degradation[]` carries structure a terminal has no use for. Each one's
 *  `note` — falling back to `kind` on the rare row still carrying only
 *  that, per `bundle.ts`'s `DegradationSchema` — is the line a human reads. */
function describeDegradations(degradations: Degradation[]): string[] {
  return degradations.map((d) => (d.note ? d.note : d.kind));
}

/**
 * Closes the browser and turns what `close()` says into notes — both the
 * close that would not complete and the browser that had already died.
 *
 * Runner audit 2026-09-14, finding 2 moved the crash off `launch.ts`'s own
 * `console.warn` and onto `close()`'s return value; the review of that fix
 * (finding 4) found the scratch-directory failure path below closing the
 * browser itself and discarding the value. One function, both callers.
 */
async function closeBrowser(
  launched: Launched,
  notes: string[],
): Promise<void> {
  const outcome = await launched.close().catch((error: unknown) => {
    // `close()`'s one unguarded await is `server.close()`, and its
    // idempotence flag is set BEFORE that call — so a rejection here is
    // final, there is no second attempt, and a Chromium process is left
    // running that nothing else in this run would ever mention.
    notes.push(
      "demoman: the browser could not be closed — a Chromium process may " +
        `still be running. ${messageOf(error)}`,
    );
    return null;
  });
  if (outcome?.crashed) {
    // A note, not a result kind: whatever the run reported (most often
    // the exit-70 internal error the crash's own rejection became) stands,
    // and this says what was under it. It prints AFTER that sentence.
    notes.push(
      "demoman: the browser did not shut down cleanly — it was already " +
        "disconnected when the run tried to close it, so it crashed or " +
        "was killed mid-run. If this run ended in an internal error, " +
        "that is the likely cause.",
    );
  }
}

/**
 * Whether `child` names the same path as `dir`, or a path underneath it.
 *
 * Task 12 fix round 2: a reviewer pinned `mkdtempSync` to a known directory
 * and pointed `--out` inside it, and `rm(runRoot, { recursive: true })`
 * deleted the mp4 `renderPhase` had just written — a successful run
 * reporting a path that no longer exists, the exact defect shape CLAUDE.md
 * opens with, arrived at from the direction the rule does not name: a
 * SUCCESS undoing what it just reported. Not reachable today (`runRoot` is
 * `mkdtemp`-random inside `TMPDIR`, and nothing lets a caller name a path
 * inside it in advance) but one `--work-dir` flag away from being so, and
 * the failure it produces — exit 0, a path in the success line, nothing at
 * that path — is worse than the thing this whole fix round exists to fix.
 *
 * Both sides are resolved to absolute, normalized paths first — `--out` is
 * whatever the CLI's caller typed, not necessarily already absolute or
 * without a `..` in it. Compared with a trailing separator appended to
 * `dir` (never to `child`) so a SIBLING whose name merely starts with
 * `dir`'s own name — `/tmp/run` vs `/tmp/run-2` — is not mistaken for
 * being inside it: `"/tmp/run-2/x".startsWith("/tmp/run")` is true and
 * wrong; `"/tmp/run-2/x".startsWith("/tmp/run" + sep)` is false and right.
 * The exact-equality case (`child === dir`) is checked first and treated
 * as "inside" too — `--out` naming the scratch directory itself is a
 * degenerate case this guard still must not remove out from under.
 */
function isWithin(child: string, dir: string): boolean {
  const resolvedDir = resolve(dir);
  const resolvedChild = resolve(child);
  if (resolvedChild === resolvedDir) return true;
  const dirWithSep = resolvedDir.endsWith(sep)
    ? resolvedDir
    : resolvedDir + sep;
  return resolvedChild.startsWith(dirWithSep);
}

/**
 * Wires the scene, the browser, replay, the mux and the render into one
 * call: a recorded scene replayed and rendered to an mp4, which the
 * acceptance lane films through.
 *
 * Order, from design §3's "Pipeline" section: launch -> replay -> (stopped?
 * report and stop, no render) -> navigate the SAME page to `about:blank` ->
 * mux the parked spans into real mp4s -> (a span failed? report and stop,
 * no render) -> render -> report success.
 *
 * One browser for the whole run (design §3: "Two browser phases, one
 * browser: replay drives the target app; mux and render run in a blank
 * page"). `replayPhase` drives `launched.page` against the real target;
 * this function then re-navigates that same page to `about:blank` itself
 * before handing it to `muxSpans` and `renderPhase`, both of which need
 * WebCodecs/OffscreenCanvas and neither of which cares which blank page it
 * runs in — they navigate to their own http server's root either way.
 */
export const runPipeline: RunPipeline = async (input) => {
  const { scene, targetUrl, outPath } = input;
  const sceneId = scene.meta.id;

  // Lines a caller must say AFTER whatever sentence this run's result
  // produces — see `PipelineNotes` above. Collected here rather than
  // written straight to `console.error`, because the teardown that produces
  // most of them runs in a `finally`, which unwinds before the caller's
  // switch (whole-branch review finding 9: stderr read bottom-up on every
  // failing run).
  const notes: string[] = [];
  /** The port every phase's forgiven failure speaks through (report.ts).
   *  A line here rides on the result, after the run's own sentence. */
  const report: Report = (line) => notes.push(line);

  // Launch FIRST, and inside its own try (whole-branch review finding 2): a
  // machine with no Chromium installed must not be told the runner is
  // broken. Also finding 6 — the scratch directory below is created only
  // once there is a browser to use it, so a failed launch cannot leave one
  // behind. That ordering is load-bearing; `mkdtempSync` above `launch()`
  // is exactly the leak that shipped.
  let launched: Launched;
  try {
    launched = await launch();
  } catch (error) {
    const install = chromiumInstallCommand();
    const failure: PipelineResult = {
      kind: "startupFailed",
      message:
        `could not start a browser — ${messageOf(error)}. ` +
        (install.ok
          ? `Chromium comes from Playwright: \`${install.command}\` installs it.`
          : `${install.detail}.`),
    };
    return failure;
  }

  // The runner's own scratch directory: parked frames, harvested keyframes,
  // the bundle row and the muxed spans all live here for the run's
  // lifetime. Nothing above this call threads a store in — `RunPipeline`'s
  // own signature (Task 4) has no room for one, and a caller-supplied root
  // would be a second thing a test would have to fake for no benefit this
  // pipeline needs.
  //
  // Whether this directory OUTLIVES the run is decided in the `finally`
  // block below by `rendered` — see there for why (Task 12 fix round 1: a
  // reviewer measured 3.8MB left behind by one real fixture run with no
  // cleanup and no message, which scales to hundreds of MB at the brief's
  // own cited ceiling of ~200 keyframes).
  let runRoot: string;
  try {
    runRoot = mkdtempSync(join(tmpdir(), "demoman-run-"));
  } catch (error) {
    // The browser is up and nothing else has started. Close it rather than
    // leak it — the mirror image of finding 6, one door further along —
    // and let what the close says (a browser that would not close, or one
    // that had already died) ride on the notes exactly as the `finally`
    // below would have.
    await closeBrowser(launched, notes);
    const failure: PipelineResult = {
      kind: "startupFailed",
      message: `could not create a scratch directory in ${tmpdir()} — ${messageOf(error)}`,
      notes: notes.length > 0 ? notes : undefined,
    };
    return failure;
  }
  const store = createFileFrameStore(runRoot);

  let rendered = false;

  /** The run itself. A function rather than the body of the `try` below so
   *  each branch can still `return` its own `PipelineResult` while the
   *  caller keeps hold of that value long enough to attach `notes` to it. */
  const phases = async (): Promise<PipelineResult> => {
    const replay = await replayPhase({
      scene,
      targetUrl,
      store,
      launched,
      report,
    });
    const { result } = replay;

    // Before anything else is read off the run: if the browser told us the
    // target could not be loaded, every later signal describes
    // `about:blank` and none of it is about the author's scene
    // (whole-branch review finding 3).
    if (replay.navigationError !== null) {
      const unreachable: PipelineResult = {
        kind: "targetUnreachable",
        targetUrl,
        errorText: replay.navigationError,
      };
      return unreachable;
    }

    if (result.outcome === "partial") {
      // "Every mid-run stop breaks before its completed++" (ReplayResult's
      // own docblock) — a partial outcome always carries the reason that
      // broke it. A null reason here is not a scene problem to report as
      // one of the sentence-shaped failures; it is this engine invariant
      // not holding, and the catch below — design §5's exit-70 row — is
      // where that belongs.
      const reason = result.reason;
      if (reason === null) {
        throw new Error(
          "replay outcome is partial but carries no stop reason — this is " +
            "an engine invariant violation, not a scene problem",
        );
      }
      const stopped: PipelineResult = {
        kind: "replayStopped",
        reason,
        completed: result.completed,
        total: result.total,
      };
      return stopped;
    }

    // `outcome === "complete"` and `bundle === null` is the degenerate case
    // ReplayResult's own docblock names: a scene that plans no cursor
    // segments at all (nothing but `waitFor` actions) replays to
    // completion with nothing SP6's schema will accept as a replay. There
    // is genuinely nothing to mux or render — reported honestly rather than
    // reaching `muxSpans`/`renderPhase` with a bundle typed as required and
    // actually absent.
    if (result.bundle === null) {
      const failure: PipelineResult = {
        kind: "renderFailed",
        message:
          "replay completed but produced no frames to render (no cursor " +
          "samples were captured — a scene of nothing but wait actions " +
          "plans no motion)",
      };
      return failure;
    }
    const bundle = result.bundle;

    // The engine's own navigation is done; mux and render need a blank
    // page for WebCodecs, and the target app's page is the wrong thing to
    // leave loaded under a headless run that no longer needs it.
    await launched.page.goto("about:blank");

    const outcome = await muxSpans({
      sceneId,
      page: launched.page,
      store,
      spans: replay.spans,
      bundle,
      report,
    });
    const failedSpans = outcome.muxed.filter(
      (m): m is Extract<MuxedSpan, { kept: false }> => !m.kept,
    );
    const [failedSpan, ...otherFailedSpans] = failedSpans;
    if (failedSpan) {
      // The reason rides on the outcome (`MuxedSpan.reason`, narrowed to a
      // string by the type on an unkept span), so it goes in the sentence
      // — where an in-process caller can read it and where a terminal
      // finds it next to the failure rather than somewhere above it.
      //
      // Only ONE span fits in the sentence; the others are not lost for it
      // (review of the runner audit, finding 2 — the deleted per-span
      // `console.warn` used to name every one). They ride on the notes.
      for (const other of otherFailedSpans) {
        report(
          `demoman: motion span ${other.spanIndex} also could not be encoded ` +
            `(${other.lost} frame(s)) — ${other.reason}`,
        );
      }
      const failure: PipelineResult = {
        kind: "muxFailed",
        spanIndex: failedSpan.spanIndex,
        message:
          `${failedSpan.lost} frame(s) of this span could not be encoded — ` +
          failedSpan.reason,
      };
      return failure;
    }

    try {
      const renderedFile = await renderPhase({
        scene,
        bundle,
        store,
        page: launched.page,
        outPath,
        wallpapersDir: input.wallpapersDir,
        ...(input.maxTier === undefined ? {} : { maxTier: input.maxTier }),
      });
      // The file is whole; the logo is why it may not be what the scene
      // asked for, and `demoman render` says so.
      if (renderedFile.logoWarning !== null) {
        report(`demoman: ${renderedFile.logoWarning}`);
      }
      if (renderedFile.wallpaperWarning !== null) {
        report(`demoman: ${renderedFile.wallpaperWarning.sentence}`);
      }
    } catch (error) {
      // Whole-branch review finding 2: design §5's exit-5 render row was
      // unreachable, because every genuine render failure — a sink error, a
      // WebCodecs failure, ENOSPC, an unwritable `--out` — throws out of
      // `renderPhase`, and with no catch here it reached cli.ts's top-level
      // handler and printed "this is a bug in the runner, not a problem
      // with your scene" over an unwritable output path. The render failing
      // is the one thing that row is for.
      const failure: PipelineResult = {
        kind: "renderFailed",
        message: messageOf(error),
      };
      return failure;
    }
    // The mp4 is written — the deliverable exists. Everything under
    // `runRoot` from here is scratch the `finally` block below may now
    // remove. Set before constructing the result, not after returning it:
    // `finally` runs on the way out either way, and this flag is what it
    // reads to decide.
    rendered = true;

    // Whole-branch review finding 5: a span can mux successfully while
    // silently dropping frames — `lost` on a KEPT span, a frame whose
    // measured JPEG size was not positive and was skipped rather than
    // encoded. Only `!kept` was consulted, so a run that dropped 40 of 150
    // frames exited 0 with output indistinguishable from a lossless one.
    // `shortfall` and the per-span numbers exist precisely to prevent that,
    // so they join the degradations the CLI already prints.
    // (A frame the store refused at PARK time is not counted here: the
    // encoder lets that `push` reject, and the engine's own recorder
    // reports it as an `encodeRefused` degradation on the bundle, which
    // `describeDegradations` above already prints.)
    const lossy: string[] = [];
    if (outcome.shortfall > 0) {
      lossy.push(
        `${outcome.shortfall} frame(s) of motion could not be encoded and ` +
          "are missing from the video",
      );
      for (const span of outcome.muxed) {
        if (span.lost > 0) {
          // By the parked index — the number in the span's own ref — see
          // `MuxedSpan`.
          lossy.push(
            `motion span ${span.spanIndex}: ${span.lost} frame(s) dropped while encoding`,
          );
        }
      }
    }

    const success: PipelineResult = {
      kind: "rendered",
      outPath,
      completed: result.completed,
      total: result.total,
      degradations: [...describeDegradations(bundle.degradations), ...lossy],
      storageRefused: result.storageRefused,
    };
    return success;
  };

  let result: PipelineResult;
  try {
    result = await phases();
  } catch (error) {
    // Design §5's invariant-violation row, as a value rather than a throw:
    // the teardown below still has to run, and its notes still have to
    // print after this sentence rather than before it.
    const internal: PipelineResult = {
      kind: "internalError",
      message: messageOf(error),
      stack: error instanceof Error ? error.stack : undefined,
    };
    result = internal;
  } finally {
    // NEITHER teardown await may throw, and both are wrapped rather than
    // trusted (whole-branch review, round 2's finding 4). This is a
    // `finally`: an exception here completes it ABRUPTLY, which costs two
    // things at once. The scratch-directory block below never runs — so a
    // failed run's frames sit on disk with nothing said about where, and a
    // successful run's are leaked with nothing said at all — and `result`,
    // already decided and possibly `rendered`, is thrown away: the run
    // rejects as an internal error over a mp4 that was written
    // successfully. A failure path reporting something no caller can tell
    // from a different failure, over a success.
    //
    // Best-effort and first, same as `launch.ts`'s own `toCdpSession.detach`
    // (which this calls into) — that one already swallows `session.detach()`
    // internally, so this catch is the guard on the port itself rather than
    // on the session, and it says so rather than adding a second silent one.
    await launched.cdp.detach().catch((error: unknown) => {
      notes.push(
        "demoman: the browser's debugger session could not be detached " +
          `during teardown. ${messageOf(error)}`,
      );
    });
    // `close()`, never a bare `browser.close()`: `launch.ts`'s own docblock
    // measured that only `close()` (which kills what `browser.close()`
    // leaves) ends the underlying Chromium OS process on a crashed
    // browser — a bare `browser.close()` can resolve while the process and
    // its transport stay registered with the event loop, which is strictly
    // worse than a crash: a run that never exits and reports nothing.
    // What the close says — could not close, or had already crashed —
    // becomes notes inside `closeBrowser`.
    await closeBrowser(launched, notes);

    // Task 12 fix round 1. The output is the deliverable; everything under
    // `runRoot` — parked JPEGs, harvested keyframes, the bundle row, muxed
    // spans — is not, and a run that leaves it behind is its own defect at
    // the scale the brief cites (up to ~200 keyframes at ~1MB each).
    //
    // On success, remove the whole directory: `rendered` is only ever set
    // once the mp4 has actually been written, so there is nothing left in
    // it a caller could still want.
    //
    // On failure — a stop, a mux failure, a render failure, or an
    // exception that unwound past `phases` entirely — KEEP it, and say
    // where: those are exactly the frames someone debugging a bad render
    // needs, and an artefact nobody is told about is the same defect in a
    // different coat (CLAUDE.md: "report before you forgive").
    //
    // Every line below goes into `notes`, never straight to `console.error`
    // (whole-branch review finding 9): this block runs before the caller
    // has printed the failure these lines belong under, so printing here
    // put them above it. They ride on the result's `notes` instead.
    if (rendered && isWithin(outPath, runRoot)) {
      // Fix round 2's guard: `--out` resolves inside the scratch directory
      // this `rm` would otherwise remove. Keeping the scratch costs a few
      // MB of frames; removing it costs the render — not a trade this
      // function gets to make silently, so it says why rather than just
      // skipping the removal with nothing to show for it.
      notes.push(
        `demoman: kept this run's scratch directory ${runRoot} because ` +
          `--out (${outPath}) is inside it — removing the scratch would ` +
          "have deleted the file this run just wrote.",
      );
    } else if (rendered) {
      // A failed removal must not turn a successful run into a failed one
      // — the result is already decided by the time this runs — but it must
      // say so rather than leave the scratch directory unexplained on disk.
      await rm(runRoot, { recursive: true, force: true }).catch(
        (error: unknown) => {
          notes.push(
            `demoman: could not remove this run's scratch directory ` +
              `${runRoot} after a successful render — it was left on disk. ` +
              messageOf(error),
          );
        },
      );
    } else {
      notes.push(
        `demoman: this run did not finish — its frames were kept for ` +
          `debugging at ${runRoot}`,
      );
    }
  }

  if (notes.length > 0) result.notes = notes;
  return result;
};

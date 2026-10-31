// apps/runner/src/executor/probe.ts
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { failure, type Outcome } from "@demoman/agent-bridge";
import {
  authoredTotal,
  type CdpSession,
  type EngineStore,
  type FrameEncoder,
  type PageReady,
  type ReplayStopReason,
  reasonSentence,
  waitForPageReady,
} from "@demoman/replay-engine";
import {
  type BrandKitsRead,
  checkScript,
  containsNoteFor,
  type EndPage,
  type FinalStill,
  kitsForSnapshot,
  landedElsewhere,
  lookForRun,
  messageOf,
  newId,
  type RefusedBeforeRun,
  type Snapshot,
  type SnapshotKits,
  type SnapshotWalk,
} from "@demoman/run-core";
import {
  SNAPSHOT_BUDGET_MS,
  SNAPSHOT_MAX_TARGETS,
} from "@demoman/run-core/page";
import type { DemoScript, SceneBranding } from "@demoman/scene-schema";
import { withinDeadline } from "../page-deadline.js";
import type { Stage } from "./browser.js";
import { STILL_MAX_WIDTH } from "./final-still.js";
import { pageEndPage, pageSnapshotTargets } from "./page-ops.js";
import {
  type PlayDeps,
  playOnStage,
  prepareStage,
  stopDetail,
  walkedReason,
} from "./play.js";

/**
 * The `probe` op: a draft script's steps played by the run's own walk
 * (`playOnStage`), unfilmed, then the page they ended on listed as `snapshot`
 * lists one. No take, no mux, no session write-back, no report: the frames go
 * to `discardingFilm()`.
 */

/** An encoder and a store that keep nothing. */
export function discardingFilm(): {
  encoder: FrameEncoder;
  store: EngineStore;
} {
  return {
    encoder: {
      openSpan: () => undefined,
      push: async () => undefined,
      closeSpan: async () => null,
      queueDepth: () => 0,
      heapFraction: () => 0,
    },
    store: {
      putKeyframe: async (_sceneId, index) => `discarded:${index}`,
      putBundle: async () => undefined,
    },
  };
}

export interface ProbeDeps extends PlayDeps {
  home: string;
  kits: BrandKitsRead;
  /** Tests only: replaces discardingFilm(). */
  film?: () => { encoder: FrameEncoder; store: EngineStore };
}

/** The ok value: Snapshot's fields plus these. */
export interface ProbeReply extends Snapshot {
  session: "saved" | "none" | "signedOut" | "unchecked";
  sessionDetail: string | null;
  kits: SnapshotKits;
  steps: { played: number; of: number };
  stopped: null | {
    at: number;
    reason: ReplayStopReason | "pageDidNotLoad";
    detail: string;
  };
  endedUrl: string | null;
  /** The viewport where the steps ended, a PNG at `<home>/probe-still.png`
   *  (one file, overwritten), or why there is none (spec 2026-10-30 A1). */
  still: FinalStill;
  /** The page where the steps ended, as text (spec 2026-10-30 A2). */
  endPage: EndPage | { unavailable: string };
}

/** A script the probe may play, or the refusal the run door gives it. */
export type ProbeEntry =
  | { ok: true; script: DemoScript; startingBranding: SceneBranding }
  | { ok: false; refusal: RefusedBeforeRun };

/**
 * The run door's checks, the brand kit's included, so the caller can refuse
 * before any sign-in or launch (executor.ts `probeAs`).
 */
export function probeEntry(
  rawScript: unknown,
  holePaths: readonly string[],
  kits: BrandKitsRead,
): ProbeEntry {
  const checked = checkScript(rawScript, holePaths);
  if (!checked.ok) return checked;
  const look = lookForRun(checked.script, kits);
  if (!look.ok) {
    // The run door's two reasons, on the same field (executor.ts `run`).
    return {
      ok: false,
      refusal: {
        outcome: "refusedBeforeRun",
        reason: look.reason,
        detail: look.detail,
        field: "look.kit",
      },
    };
  }
  return {
    ok: true,
    script: checked.script,
    startingBranding: look.startingBranding,
  };
}

export async function probeOp(
  entry: Extract<ProbeEntry, { ok: true }>,
  contains: string | null,
  deps: ProbeDeps,
): Promise<Outcome> {
  const { log } = deps;
  const { script } = entry;

  const prepared = await prepareStage(script, deps);
  if (!prepared.ok) return failure(prepared.reason, prepared.detail);
  const { stage, size } = prepared;
  const film = deps.film?.() ?? discardingFilm();
  const played = await playOnStage(
    script,
    prepared,
    deps,
    { ...film, sceneId: newId("probe") },
    { startingBranding: entry.startingBranding, onProgress: () => undefined },
  );
  const { result, arrival } = played;
  const { completed, total } = result;
  // Counted as the run report counts: pauses are not steps.
  const of = authoredTotal(script);

  // A reason with every step completed belongs to filming (the bundle not
  // built or saved), and frames are discarded here: logged, not a stop.
  const reason = walkedReason(played);
  let stopped: ProbeReply["stopped"] = null;
  if (reason !== null) {
    if (completed === total && played.signedOutAfter === null) {
      log(
        `the probe's steps all played; filming said ${reason} (frames are discarded, so nothing was lost)`,
      );
    } else {
      stopped = {
        at: completed,
        reason,
        detail: stopDetail(script.target, played) ?? reasonSentence(reason),
      };
    }
  }

  // A stopped step outranks what the end page then does: it is what the
  // agent has to fix, so a page that cannot be read or listed after it
  // empties the listing and says why, and the stop is still answered.
  let listed: Awaited<ReturnType<typeof listEndPage>>;
  try {
    listed = await listEndPage(
      stage,
      contains,
      `${completed} of ${total}`,
      log,
    );
  } catch (error) {
    if (stopped === null) throw error;
    listed = { ok: false, reason: "probeThrew", detail: messageOf(error) };
  }
  if (!listed.ok && stopped === null) {
    return failure(listed.reason, listed.detail);
  }
  // A page that did not load is the stop an agent must act on, whatever
  // step the walk blamed: the step was fine, the app is not answering.
  if (!listed.ok && listed.reason === "pageDidNotLoad" && stopped !== null) {
    // The walk's own account stays in the detail: it may name the net error,
    // and it is what the step itself reported.
    stopped = {
      at: stopped.at,
      reason: "pageDidNotLoad",
      detail: `${listed.detail}. The walk had stopped at step ${stopped.at}: ${stopped.reason}: ${stopped.detail}`,
    };
  }
  const { ready, endedUrl, walk } = listed.ok
    ? listed
    : {
        ready: {
          settled: false,
          note:
            listed.reason === "pageDidNotLoad"
              ? "the page it stopped on did not load; see stopped"
              : `the page it stopped on could not be listed (${listed.reason}): ${listed.detail}`,
        },
        endedUrl: stage.page.isClosed() ? null : stage.page.url(),
        walk: {
          title: "",
          targets: [],
          unresolvable: 0,
          notExamined: 0,
          walkMs: 0,
        },
      };

  // The arrival at the target, measured by the walk before its first step,
  // as `snapshotOp` reads its own. The end page is not checked for sign-in:
  // a step that opens "change password" is not a sign-in wall.
  let session: ProbeReply["session"];
  let sessionDetail: string | null = null;
  let landedUrl: string | null = null;
  if (arrival === null) {
    session = "unchecked";
    sessionDetail = "the probe never reached its first step";
  } else if ("unchecked" in arrival) {
    session = "unchecked";
    sessionDetail = `the page could not be checked for a sign-in page (${arrival.unchecked})`;
  } else {
    landedUrl = arrival.facts.landedUrl;
    if (arrival.verdict.kind === "signedOut") {
      session = "signedOut";
      sessionDetail = arrival.verdict.detail;
    } else {
      session = arrival.verdict.saved ? "saved" : "none";
    }
  }

  // A page that did not load has nothing of the app's to show or read.
  const unloaded =
    (!listed.ok && listed.reason === "pageDidNotLoad") ||
    stopped?.reason === "pageDidNotLoad";
  const endPage: ProbeReply["endPage"] = unloaded
    ? { unavailable: "the page did not load" }
    : await pageEndPage(stage.page);
  const still: FinalStill = unloaded
    ? { unavailable: "the page did not load" }
    : await viewportStill(stage, join(deps.home, "probe-still.png"));

  const value: ProbeReply = {
    url: script.target,
    landedUrl,
    landedElsewhere:
      landedUrl === null ? null : landedElsewhere(script.target, landedUrl),
    title: walk.title,
    settled: ready.settled,
    settleNote: ready.note,
    targets: walk.targets,
    unresolvable: walk.unresolvable,
    notExamined: walk.notExamined,
    containsNote: containsNoteFor(
      contains,
      walk.targets.length,
      walk.notExamined,
      walk.unresolvable,
    ),
    walkMs: walk.walkMs,
    device: script.device ?? null,
    size,
    session,
    sessionDetail,
    kits: kitsForSnapshot(deps.kits),
    steps: { played: completed, of },
    stopped,
    endedUrl,
    still,
    endPage,
  };
  return { ok: true, value };
}

/**
 * The stage's viewport as a PNG at `path`, no wider than STILL_MAX_WIDTH in
 * pixels whatever the device scale the walk set. Through CDP, as Playwright's
 * own `scale: "css"` does it (clip in document coordinates, scaled by
 * 1/devicePixelRatio), with the extra factor that caps the width.
 */
async function viewportStill(stage: Stage, path: string): Promise<FinalStill> {
  try {
    const view = await withinDeadline(
      stage.page.evaluate(() => ({
        x: scrollX,
        y: scrollY,
        width: innerWidth,
        height: innerHeight,
        dpr: devicePixelRatio,
      })),
      "measuring the window for its still",
    );
    const fit = Math.min(1, STILL_MAX_WIDTH / view.width);
    const shot = (await stage.cdp.send("Page.captureScreenshot", {
      format: "png",
      clip: {
        x: view.x,
        y: view.y,
        width: view.width,
        height: view.height,
        scale: fit / view.dpr,
      },
    })) as { data: string };
    await writeFile(path, Buffer.from(shot.data, "base64"));
    return { path };
  } catch (error) {
    return {
      unavailable: `the page's viewport could not be captured (${messageOf(error)})`,
    };
  }
}

/** The page the steps ended on, once it is ready, listed as snapshot lists. */
async function listEndPage(
  stage: Stage,
  contains: string | null,
  played: string,
  log: (line: string) => void,
): Promise<
  | { ok: true; ready: PageReady; endedUrl: string; walk: SnapshotWalk }
  | { ok: false; reason: string; detail: string }
> {
  const { page } = stage;
  const ready = await waitForPageReady(stage.cdp, stage.clock.sleep);
  // Read once the page is ready, so a navigation the last step began and
  // that committed meanwhile is named by the page it lists.
  const endedUrl = page.url();
  if (endedUrl.startsWith("chrome-error:")) {
    return {
      ok: false,
      reason: "pageDidNotLoad",
      detail: `the probe's steps ended on a page that did not load (${await failedAddress(stage.cdp, endedUrl, log)}) after ${played} steps; check that the app is running there`,
    };
  }
  const reply = await pageSnapshotTargets(page)({
    contains,
    maxTargets: SNAPSHOT_MAX_TARGETS,
    budgetMs: SNAPSHOT_BUDGET_MS,
  });
  if ("failed" in reply) {
    return {
      ok: false,
      reason: reply.failed,
      detail: `${reply.detail} (after ${played} steps played)`,
    };
  }
  return { ok: true, ready, endedUrl, walk: reply.walk };
}

/**
 * The address the browser could not load: its error page's own URL is
 * `chrome-error://chromewebdata/` for every failure, while the navigation
 * entry keeps the address asked for. The error page's URL when the history
 * cannot be read, said in the log.
 */
async function failedAddress(
  cdp: CdpSession,
  errorUrl: string,
  log: (line: string) => void,
): Promise<string> {
  try {
    const history = (await cdp.send("Page.getNavigationHistory")) as {
      currentIndex: number;
      entries: { url: string }[];
    };
    const url = history.entries[history.currentIndex]?.url;
    if (url !== undefined) return url;
    log("the navigation history named no current entry");
  } catch (error) {
    log(`the navigation history could not be read (${messageOf(error)})`);
  }
  return errorUrl;
}

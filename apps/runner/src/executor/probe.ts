// apps/runner/src/executor/probe.ts
import { failure, type Outcome } from "@demoman/agent-bridge";
import {
  authoredTotal,
  type CdpSession,
  type EngineStore,
  type FrameEncoder,
  type ReplayStopReason,
  reasonSentence,
  waitForPageReady,
} from "@demoman/replay-engine";
import {
  type BrandKitsRead,
  checkScript,
  kitsForSnapshot,
  landedElsewhere,
  lookForRun,
  messageOf,
  newId,
  type Snapshot,
  type SnapshotKits,
} from "@demoman/run-core";
import {
  SNAPSHOT_BUDGET_MS,
  SNAPSHOT_MAX_TARGETS,
} from "@demoman/run-core/page";
import { pageSnapshotTargets } from "./page-ops.js";
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
  holePaths: readonly string[];
  /** Tests only: replaces discardingFilm(). */
  film?: () => { encoder: FrameEncoder; store: EngineStore };
}

/** The ok value: Snapshot's fields plus these. */
export interface ProbeReply extends Snapshot {
  session: "saved" | "none" | "signedOut" | "unchecked";
  sessionDetail: string | null;
  kits: SnapshotKits;
  steps: { played: number; of: number };
  stopped: null | { at: number; reason: ReplayStopReason; detail: string };
  endedUrl: string | null;
}

export async function probeOp(
  rawScript: unknown,
  contains: string | null,
  deps: ProbeDeps,
): Promise<Outcome> {
  const { log } = deps;
  // Refused exactly as the run door refuses it, before anything opens.
  const checked = checkScript(rawScript, deps.holePaths);
  if (!checked.ok) return { ok: true, value: checked.refusal };
  const { script } = checked;
  const look = lookForRun(script, deps.kits);
  if (!look.ok) {
    // The run door's two reasons, on the same field (executor.ts `run`).
    return {
      ok: true,
      value: {
        outcome: "refusedBeforeRun",
        reason: look.reason,
        detail: look.detail,
        field: "look.kit",
      },
    };
  }

  const prepared = await prepareStage(script, deps);
  if (!prepared.ok) return failure(prepared.reason, prepared.detail);
  const { stage, size } = prepared;
  const film = deps.film?.() ?? discardingFilm();
  const played = await playOnStage(
    script,
    prepared,
    deps,
    { ...film, sceneId: newId("probe") },
    { startingBranding: look.startingBranding, onProgress: () => undefined },
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

  const { page } = stage;
  const endedUrl = page.url();
  if (endedUrl.startsWith("chrome-error:")) {
    return failure(
      "pageDidNotLoad",
      `the probe's steps ended on a page that did not load (${await failedAddress(stage.cdp, endedUrl, log)}) after ${completed} of ${total} steps; check that the app is running there`,
    );
  }

  const ready = await waitForPageReady(stage.cdp, stage.clock.sleep);
  const reply = await pageSnapshotTargets(page)({
    contains,
    maxTargets: SNAPSHOT_MAX_TARGETS,
    budgetMs: SNAPSHOT_BUDGET_MS,
  });
  if ("failed" in reply) {
    return failure(
      reply.failed,
      `${reply.detail} (after ${completed} of ${total} steps played)`,
    );
  }
  const { walk } = reply;

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
    walkMs: walk.walkMs,
    device: script.device ?? null,
    size,
    session,
    sessionDetail,
    kits: kitsForSnapshot(deps.kits),
    steps: { played: completed, of },
    stopped,
    endedUrl,
  };
  return { ok: true, value };
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

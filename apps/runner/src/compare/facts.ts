/**
 * What film:compare reads off the MCP tools' answers, as pure functions: the
 * answer parse and the report → `RunFacts` mapping, out of `film-compare.ts`
 * so the counts the gate prints can be tested without a browser.
 */
import type {
  BundleFactsRead,
  RunFacts,
  SceneFactsRead,
  Side,
} from "./numbers.js";

/** What the tools answer, as far as film:compare reads it. A tool refusal
 *  answers `{reason, detail}` with no outcome at all. */
export interface Answer {
  outcome?: string;
  id?: string;
  reason?: string;
  detail?: string;
}
export interface RunAnswer extends Answer {
  stopped?: {
    reason?: string;
    at?: { index?: number; of?: number; label?: string };
    sentence?: string;
    detail?: string;
  };
  steps?: unknown[];
  provenance?: { takeId?: string | null };
  frames?: { degradations?: string[] };
  video?: {
    steps?: { outputMs: number | null }[];
    summary?: Record<string, number>;
  };
}
export interface ExportAnswer extends Answer {
  fileType?: "mp4" | "gif" | "stills";
  file?: { path: string };
  summary?: string;
  warnings?: { detailViolations?: unknown[] };
}
export interface SnapshotAnswer extends Answer {
  landedElsewhere?: boolean;
  landedUrl?: string;
}

/**
 * A tool result as an answer. A refusal the server structured (`isError`
 * with `{reason, detail}` JSON) is kept as it is; anything else that is an
 * error, or is not JSON, becomes a `toolError` refusal carrying the tool's
 * text verbatim — never a SyntaxError about the text.
 */
export function parseAnswer<T extends Answer>(r: {
  content?: { text: string }[];
  isError?: boolean;
}): T {
  const text = r.content?.[0]?.text;
  if (text === undefined)
    return {
      reason: "toolError",
      detail: `the tool answered no text${r.isError ? " (isError)" : ""}`,
    } as T;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { reason: "toolError", detail: text } as T;
  }
  if (typeof parsed !== "object" || parsed === null)
    return { reason: "toolError", detail: text } as T;
  if (r.isError === true && (parsed as Answer).reason === undefined)
    return { reason: "toolError", detail: text } as T;
  return parsed as T;
}

/** The outcome, or — for a refusal, which has none — its reason and detail,
 *  so a refused call is never printed as a blank. */
export const outcomeOf = (a: Answer): string =>
  a.outcome ??
  (a.reason === undefined
    ? `no outcome (${JSON.stringify(a).slice(0, 200)})`
    : `${a.reason}${a.detail === undefined ? "" : `: ${a.detail}`}`);

type Failed = { failed: string };

/** One run's facts from what the tools answered and what the take's stores
 *  held. `film` stays null: the measurer fills it once every browser is shut.
 *  A read that failed is carried as the failure, never as an empty value. */
export function factsFromRun(args: {
  executor: Side;
  run: number;
  report: RunAnswer;
  runMs: number;
  exportMs: number | null;
  exportOutcome: string | null;
  exportAnswer: ExportAnswer | null;
  /** null when there was no take to read. */
  bundle: BundleFactsRead | Failed | null;
  scene: SceneFactsRead | Failed | null;
  actingSteps: number;
}): RunFacts {
  const { report, bundle, scene } = args;
  const readBundle = bundle !== null && !("failed" in bundle) ? bundle : null;
  const kinds: Record<string, number> = {};
  if (readBundle !== null)
    for (const d of readBundle.degradations)
      kinds[d.kind] = (kinds[d.kind] ?? 0) + 1;
  const film = report.video?.steps ? report.video : null;
  const span = readBundle?.spans[0];
  return {
    executor: args.executor,
    run: args.run,
    outcome: outcomeOf(report),
    stopped: report.stopped?.reason ?? null,
    // A stopped report lists a step report for the step it stopped on, so
    // its length reads as "9 of 9" for a run that did not finish; the walk's
    // own count is `stopped.at.index` (run-core report.ts).
    completed: report.stopped?.at?.index ?? report.steps?.length ?? 0,
    total: report.stopped?.at?.of ?? report.steps?.length ?? 0,
    runMs: args.runMs,
    exportMs: args.exportMs,
    exportOutcome: args.exportOutcome,
    film: null,
    keyframe: readBundle?.keyframe ?? null,
    span: span ? [span[0], span[1]] : null,
    // With the bundle unread, the report's kinds stand in, each counted
    // once; `bundleFailed` makes the table say they are uncounted.
    degradations:
      readBundle !== null
        ? kinds
        : Object.fromEntries(
            (report.frames?.degradations ?? []).map((k) => [k, 1]),
          ),
    framing: film?.summary ?? {},
    lastStepMs:
      film === null
        ? null
        : Math.max(0, ...(film.steps ?? []).map((s) => s.outputMs ?? 0)),
    actingSteps: args.actingSteps,
    zoomsSkipped:
      scene !== null && !("failed" in scene) ? scene.skipped.length : 0,
    detailViolations:
      args.exportAnswer?.warnings?.detailViolations?.length ?? 0,
    summary: args.exportAnswer?.summary ?? null,
    bundleFailed: bundle !== null && "failed" in bundle ? bundle.failed : null,
    sceneFailed: scene !== null && "failed" in scene ? scene.failed : null,
  };
}

/**
 * Why a side's home has to be kept as evidence, or null when it may go: every
 * one of `expected` runs completed, made an MP4, had its bundle and scene
 * read, and filmed motion if it acted. Each of those is a cause `judge`
 * refuses for, and the home holds the take that explains it. (A film that
 * fails to decode is found after the homes are settled; its MP4 is kept in
 * the script's folder either way.)
 */
export function keepHomeBecause(
  runs: { facts: RunFacts; mp4: string | null }[],
  expected: number,
): string | null {
  if (runs.length !== expected)
    return `${runs.length} of ${expected} runs finished`;
  for (const { facts: f, mp4 } of runs) {
    const who = `run ${f.run}`;
    if (f.outcome !== "complete") return `${who} did not complete`;
    if (mp4 === null) return `${who} made no video`;
    if (f.bundleFailed !== null) return `${who}'s bundle could not be read`;
    if (f.sceneFailed !== null) return `${who}'s scene could not be read`;
    if (f.actingSteps > 0 && f.span === null)
      return `${who} recorded no motion spans`;
  }
  return null;
}

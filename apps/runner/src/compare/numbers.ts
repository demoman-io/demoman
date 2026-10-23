/**
 * The gate's numbers (spec 2026-10-12 §4): what each run and its film
 * measured, and whether the films may be compared at all. A comparison of two
 * broken films looks clean, so `judge` asserts the premise before `table`
 * prints anything — the fixture check CLAUDE.md asks of every test.
 */
import type { FilmMeasure } from "./measure.js";

export interface Cadence {
  fps: number;
  largestGapMs: number;
  p95GapMs: number;
  hitches: number;
}

/**
 * From decoded frame timestamps. Nominal is the median gap: the film's own
 * rate, so a 30 fps export is not a field of hitches against a 60 fps rule.
 *
 * These are the ENCODER's timestamps, not the capture's: the compositor
 * writes every exported frame on a fixed grid (`render.ts`, `addFrame(canvas,
 * i * step, step)`), so a film of stills and a smooth one measure the same
 * here. What tells them apart is the picture — `stills`.
 */
export function cadence(timesMs: number[]): Cadence {
  const t = [...timesMs].sort((a, b) => a - b);
  const gaps = t.slice(1).map((x, i) => x - (t[i] as number));
  if (gaps.length === 0)
    return { fps: 0, largestGapMs: 0, p95GapMs: 0, hitches: 0 };
  const sorted = [...gaps].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)] as number;
  const p95 = sorted[
    Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))
  ] as number;
  return {
    fps: median > 0 ? 1000 / median : 0,
    largestGapMs: sorted.at(-1) as number,
    p95GapMs: p95,
    hitches: gaps.filter((g) => g > 2 * median).length,
  };
}

/**
 * A frame whose picture differs from the one before by less than this — mean
 * absolute difference per channel, 0–255 levels, at the decode probe's
 * `CHANGE_WORK_WIDTH` (160 px wide) — shows the same picture.
 *
 * Measured 2026-10-13 on `render-small.ts`'s films (one picture throughout,
 * a cursor gliding over it): between frames of the same picture the encoder
 * leaves 0.002–0.06, its periodic keyframes 0.12–0.6 at 1920x1080 (one 1.25
 * at 320x180); the alternating fixture's white-to-black frames read ~161. A
 * scroll, a navigation, a zoom or a pan moves the whole picture and reads in
 * whole levels. What this does NOT see: a typed character or the cursor
 * alone (0.02–0.25 here) is too few pixels at this size, so a stretch of
 * typing over a page that is otherwise still counts as still on both sides.
 */
export const STILL_CHANGE_MAX = 0.5;
/** A stretch held still at least this long is counted as a long still. */
export const LONG_STILL_MS = 250;

export interface Stills {
  longestStillMs: number;
  longStills: number;
}

/**
 * The stretches where the picture did not move, from each frame's change
 * against the one before (`changes[i]`, aligned with `timesMs[i]`). A
 * stretch runs from the frame that first showed the picture to the frame
 * that next changes it — or to `durationMs`, when nothing does.
 */
export function stills(
  timesMs: number[],
  changes: number[],
  durationMs: number,
): Stills {
  if (changes.length !== timesMs.length) {
    throw new Error(
      `the probe answered ${changes.length} picture changes for ${timesMs.length} frames`,
    );
  }
  let longestStillMs = 0;
  let longStills = 0;
  let from: number | null = null;
  const close = (untilMs: number) => {
    if (from === null) return;
    const held = untilMs - (timesMs[from] as number);
    longestStillMs = Math.max(longestStillMs, held);
    if (held >= LONG_STILL_MS) longStills++;
    from = null;
  };
  for (let i = 1; i < timesMs.length; i++) {
    if ((changes[i] as number) < STILL_CHANGE_MAX) from ??= i - 1;
    else close(timesMs[i] as number);
  }
  close(durationMs);
  return { longestStillMs, longStills };
}

/** Which way a run was filmed: the CLI's visible window, or the CLI
 *  headless (`--sides`, 2026-10-20). The extension was the third side until
 *  it was archived the same day. */
export type Side = "cli" | "headless";
/** The one order sides are filmed, shown and tabled in. */
export const SIDE_ORDER: readonly Side[] = ["cli", "headless"];
const SIDE_LABEL: Record<Side, string> = {
  cli: "cli",
  headless: "headless",
};

/** `--sides`, in filming order: the two sides it names, or why not. */
export function parseSides(
  value: string | undefined,
): { ok: true; sides: [Side, Side] } | { ok: false; reason: string } {
  const named = (value ?? "cli,headless").split(",");
  if (named.includes("extension")) {
    return {
      ok: false,
      reason:
        '--sides: "extension" was retired with the extension; use cli and headless',
    };
  }
  if (
    named.length !== 2 ||
    named[0] === named[1] ||
    !named.every((s): s is Side => (SIDE_ORDER as string[]).includes(s))
  ) {
    return {
      ok: false,
      reason: `--sides names two different sides of ${SIDE_ORDER.join(", ")}, not "${value}"`,
    };
  }
  const [a, b] = [...(named as Side[])].sort(
    (x, y) => SIDE_ORDER.indexOf(x) - SIDE_ORDER.indexOf(y),
  ) as [Side, Side];
  return { ok: true, sides: [a, b] };
}

export interface RunFacts {
  executor: Side;
  run: number; // 1 or 2
  outcome: string; // the report's outcome
  stopped: string | null; // stopped.reason, verbatim
  completed: number;
  total: number;
  runMs: number;
  exportMs: number | null;
  exportOutcome: string | null;
  film: FilmMeasure | null; // null when no MP4 was made
  keyframe: [number, number] | null;
  span: [number, number] | null; // first motion span's size
  degradations: Record<string, number>; // counted by kind, stillFailed among them
  framing: Record<string, number>; // film.summary
  lastStepMs: number | null; // the film report's last step outputMs
  actingSteps: number; // script steps that are not pauses
  zoomsSkipped: number;
  detailViolations: number;
  summary: string | null; // the export's sentence
  /** Why the take's bundle could not be read, or null when it was (or there
   *  was no take). With it set, keyframe/span are unknown, not "none". */
  bundleFailed: string | null;
  /** Why the take's scene could not be read; zoomsSkipped is then unknown. */
  sceneFailed: string | null;
}

/** What film:compare reads from a take's frame bundle. */
export interface BundleFactsRead {
  degradations: { kind: string }[];
  keyframe: [number, number] | null;
  spans: [number, number, number][];
}
/** What film:compare reads from a take's scene. */
export interface SceneFactsRead {
  skipped: unknown[];
}

export type Verdict =
  | { kind: "compared" }
  | { kind: "refused"; executor: Side | "both"; cause: string };

const size = (s: [number, number] | null) =>
  s === null ? "none" : `${s[0]}x${s[1]}`;
/** A cell whose fact could not be read; the why is in `bundleFailed` /
 *  `sceneFailed` and the verdict. */
const UNREAD = "unread";
const secs = (ms: number) => `${(ms / 1000).toFixed(1)} s`;

/** The first broken premise, or "compared". Order: the run, its film, then
 *  the two executors against each other. */
export function judge(facts: RunFacts[]): Verdict {
  for (const f of facts) {
    const who = `${f.executor} run ${f.run}`;
    if (f.outcome !== "complete") {
      return {
        kind: "refused",
        executor: f.executor,
        cause: `${who} did not complete: ${f.outcome}${f.stopped === null ? "" : ` (${f.stopped})`}, ${f.completed} of ${f.total} steps`,
      };
    }
    if (f.film === null) {
      return {
        kind: "refused",
        executor: f.executor,
        cause: `${who} made no video: the export answered ${f.exportOutcome ?? "nothing"}`,
      };
    }
    const gaps = f.film.timesMs.length - 1;
    const repeated = f.film.timesMs.filter(
      (t, i) => i > 0 && t === f.film?.timesMs[i - 1],
    ).length;
    if (gaps > 0 && repeated * 2 >= gaps) {
      return {
        kind: "refused",
        executor: f.executor,
        cause: `${who}'s video repeats a timestamp for ${repeated} of ${gaps} frame gaps — its cadence cannot be measured`,
      };
    }
    if (f.film.frames < f.actingSteps) {
      return {
        kind: "refused",
        executor: f.executor,
        cause: `${who}'s video has ${f.film.frames} decoded frames for ${f.actingSteps} steps`,
      };
    }
    if (f.lastStepMs !== null && f.film.durationMs < f.lastStepMs) {
      return {
        kind: "refused",
        executor: f.executor,
        cause: `${who}'s video ends at ${secs(f.film.durationMs)}, but its last step happens at ${secs(f.lastStepMs)}`,
      };
    }
    // Before the resolution premise: an unread bundle has no keyframe or
    // span size, and comparing that "none" would blame the wrong thing — or,
    // unread on both sides, match vacuously.
    for (const [what, why] of [
      ["bundle", f.bundleFailed],
      ["scene", f.sceneFailed],
    ] as const) {
      if (why !== null) {
        return {
          kind: "refused",
          executor: f.executor,
          cause: `${who}'s ${what} could not be read: ${why}`,
        };
      }
    }
    // After the bundle read, which is what `span` comes from. A run that
    // acted and filmed no motion is a slideshow of keyframes, and two of
    // those would match on span resolution as "none" = "none".
    if (f.actingSteps > 0 && f.span === null) {
      return {
        kind: "refused",
        executor: f.executor,
        cause: `${who} recorded no motion spans for ${f.actingSteps} acting steps — its video is stills`,
      };
    }
  }
  const sides = SIDE_ORDER.filter((s) => facts.some((f) => f.executor === s));
  const first = (e: Side) => facts.find((f) => f.executor === e && f.run === 1);
  const [sideA, sideB] = sides;
  const one = sideA === undefined ? undefined : first(sideA);
  const two = sideB === undefined ? undefined : first(sideB);
  if (one !== undefined && two !== undefined) {
    for (const [what, a, b] of [
      ["keyframes", one.keyframe, two.keyframe],
      ["motion spans", one.span, two.span],
    ] as const) {
      if (size(a) !== size(b)) {
        return {
          kind: "refused",
          executor: "both",
          cause: `the executors recorded ${what} at different resolutions: ${one.executor} ${size(a)}, ${two.executor} ${size(b)}`,
        };
      }
    }
  }
  return { kind: "compared" };
}

export interface TableRows {
  /** One per run, visible first, headless last: "cli 1", "cli 2",
   *  "headless 1", "headless 2". */
  columns: string[];
  rows: { name: string; cells: string[] }[];
}

/** The table's numbers as cells: one column per run, visible first. The
 *  terminal (`table`) and compare.html both print this, so they cannot
 *  disagree. */
export function tableRows(facts: RunFacts[]): TableRows {
  const cols = [...facts].sort((a, b) =>
    a.executor === b.executor
      ? a.run - b.run
      : SIDE_ORDER.indexOf(a.executor) - SIDE_ORDER.indexOf(b.executor),
  );
  const columns = cols.map((f) => `${SIDE_LABEL[f.executor]} ${f.run}`);
  const kinds = [
    ...new Set([
      "stillFailed",
      ...cols.flatMap((f) => Object.keys(f.degradations)),
    ]),
  ];
  const framings = [...new Set(cols.flatMap((f) => Object.keys(f.framing)))];
  const rows: [string, (f: RunFacts) => string][] = [
    ["outcome", (f) => f.outcome],
    ["steps", (f) => `${f.completed}/${f.total}`],
    ["run", (f) => secs(f.runMs)],
    ["export", (f) => (f.exportMs === null ? "-" : secs(f.exportMs))],
    ["video length", (f) => (f.film === null ? "-" : secs(f.film.durationMs))],
    [
      "video size",
      (f) => (f.film === null ? "-" : `${f.film.width}x${f.film.height}`),
    ],
    ["keyframes", (f) => (f.bundleFailed === null ? size(f.keyframe) : UNREAD)],
    ["spans", (f) => (f.bundleFailed === null ? size(f.span) : UNREAD)],
    // The encoder's timestamps: a fixed grid whatever was filmed (`cadence`),
    // so named for what they are, not read as smoothness.
    [
      "export fps (encoder)",
      (f) => (f.film === null ? "-" : cadence(f.film.timesMs).fps.toFixed(1)),
    ],
    [
      "export gap max (encoder)",
      (f) =>
        f.film === null
          ? "-"
          : `${cadence(f.film.timesMs).largestGapMs.toFixed(0)} ms`,
    ],
    // What can differ: how long the picture itself held still (`stills`).
    [
      "longest still",
      (f) => (f.film === null ? "-" : secs(f.film.longestStillMs)),
    ],
    [
      `stills >= ${LONG_STILL_MS} ms`,
      (f) => (f.film === null ? "-" : String(f.film.longStills)),
    ],
    // An unread bundle leaves only the report's kinds: present, uncounted.
    ...kinds.map((k): [string, (f: RunFacts) => string] => [
      k,
      (f) =>
        f.bundleFailed === null
          ? String(f.degradations[k] ?? 0)
          : k in f.degradations
            ? ">=1"
            : "0",
    ]),
    ...framings.map((k): [string, (f: RunFacts) => string] => [
      `framing ${k}`,
      (f) => String(f.framing[k] ?? 0),
    ]),
    [
      "zooms skipped",
      (f) => (f.sceneFailed === null ? String(f.zoomsSkipped) : UNREAD),
    ],
    ["detail notes", (f) => String(f.detailViolations)],
    [
      "unread",
      (f) =>
        [
          f.bundleFailed === null ? "" : "bundle",
          f.sceneFailed === null ? "" : "scene",
        ]
          .filter(Boolean)
          .join("+") || "-",
    ],
  ];
  return {
    columns,
    rows: rows
      .map(([name, g]) => ({ name, cells: cols.map(g) }))
      // The "unread" row speaks only when a read failed.
      .filter((r) => r.name !== "unread" || r.cells.some((c) => c !== "-")),
  };
}

/** The terminal table: `tableRows`, padded into columns. */
export function table(script: string, facts: RunFacts[]): string {
  const { columns, rows } = tableRows(facts);
  const w0 = Math.max(...rows.map((r) => r.name.length), script.length);
  const w = Math.max(9, ...rows.flatMap((r) => r.cells.map((c) => c.length)));
  const line = (a: string, cells: string[]) =>
    `${a.padEnd(w0)}  ${cells.map((c) => c.padStart(w)).join("  ")}`;
  return [
    line(script, columns),
    ...rows.map((r) => line(r.name, r.cells)),
  ].join("\n");
}

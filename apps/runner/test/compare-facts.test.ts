// apps/runner/test/compare-facts.test.ts
import { describe, expect, it } from "vitest";
import {
  factsFromRun,
  keepHomeBecause,
  parseAnswer,
  type RunAnswer,
} from "../src/compare/facts.js";
import { judge, type RunFacts } from "../src/compare/numbers.js";

const FILM = {
  frames: 600,
  width: 3696,
  height: 2536,
  durationMs: 10_000,
  timesMs: Array.from({ length: 600 }, (_, i) => (i * 1000) / 60),
  changes: Array.from({ length: 600 }, (_, i) => (i === 0 ? 0 : 4)),
  longestStillMs: 0,
  longStills: 0,
};
const BUNDLE = {
  degradations: [{ kind: "surfaceMismatch" }, { kind: "surfaceMismatch" }],
  keyframe: [5130, 3321] as [number, number],
  spans: [[3420, 2214, 900]] as [number, number, number][],
};
const base = {
  executor: "cli" as const,
  run: 1,
  runMs: 14_000,
  exportMs: 14_000,
  exportOutcome: "saved",
  exportAnswer: { outcome: "saved", summary: "Saved …" },
  bundle: BUNDLE,
  scene: { skipped: [] },
  actingSteps: 9,
};

describe("factsFromRun — the report as the gate counts it", () => {
  // The attended pass of 2026-10-12 printed "9 of 9 steps" for a stopped
  // run: a stopped report carries a step record for the step it stopped on.
  it("counts a stopped run by stopped.at, not by its step records", () => {
    const report: RunAnswer = {
      outcome: "stopped",
      stopped: {
        reason: "unresolvedAnchor",
        at: { index: 8, of: 9, label: "scrollTo Atlas Robotics" },
      },
      steps: Array.from({ length: 9 }, (_, i) => ({ index: i })),
      provenance: { takeId: "t1" },
    };
    // Premise: the records alone would say nine.
    expect(report.steps).toHaveLength(9);
    const f = factsFromRun({ ...base, report });
    expect(f.completed).toBe(8);
    expect(f.total).toBe(9);
    expect(f.outcome).toBe("stopped");
    expect(f.stopped).toBe("unresolvedAnchor");
    const v = judge([{ ...f, film: FILM }]);
    expect(v).toMatchObject({ kind: "refused", executor: "cli" });
    if (v.kind === "refused") expect(v.cause).toContain("8 of 9");
  });

  it("counts a complete run by its step records", () => {
    const f = factsFromRun({
      ...base,
      report: {
        outcome: "complete",
        steps: Array.from({ length: 9 }, () => ({})),
      },
    });
    expect([f.completed, f.total]).toEqual([9, 9]);
  });

  it("counts degradations from the bundle and takes its sizes", () => {
    const f = factsFromRun({
      ...base,
      report: { outcome: "complete", steps: [] },
    });
    expect(f.degradations).toEqual({ surfaceMismatch: 2 });
    expect(f.keyframe).toEqual([5130, 3321]);
    expect(f.span).toEqual([3420, 2214]);
    expect([f.bundleFailed, f.sceneFailed]).toEqual([null, null]);
  });

  it("carries a failed bundle or scene read as the failure, not as empty values", () => {
    const f = factsFromRun({
      ...base,
      report: {
        outcome: "complete",
        steps: [],
        frames: { degradations: ["stillFailed"] },
      },
      bundle: { failed: "no bundle under /h/takes/t1" },
      scene: { failed: "/h/takes/t1/scene.json is not a take" },
    });
    expect(f.bundleFailed).toBe("no bundle under /h/takes/t1");
    expect(f.sceneFailed).toBe("/h/takes/t1/scene.json is not a take");
    expect(f.degradations).toEqual({ stillFailed: 1 });
  });

  it("has no read failure when there was no take to read", () => {
    const f = factsFromRun({
      ...base,
      report: { reason: "alreadyRunning", detail: "a run is in progress" },
      bundle: null,
      scene: null,
      exportOutcome: null,
      exportAnswer: null,
    });
    expect([f.bundleFailed, f.sceneFailed]).toEqual([null, null]);
    expect(f.outcome).toBe("alreadyRunning: a run is in progress");
  });
});

describe("parseAnswer — a tool's text is never lost to a SyntaxError", () => {
  it("keeps a structured refusal", () => {
    expect(
      parseAnswer({
        isError: true,
        content: [
          { text: JSON.stringify({ reason: "busy", detail: "poll report" }) },
        ],
      }),
    ).toEqual({ reason: "busy", detail: "poll report" });
  });

  it("carries a plain-text tool error verbatim", () => {
    const text = "MCP error -32602: Invalid arguments for tool run";
    expect(parseAnswer({ isError: true, content: [{ text }] })).toEqual({
      reason: "toolError",
      detail: text,
    });
  });

  it("carries non-JSON text verbatim even without isError", () => {
    expect(parseAnswer({ content: [{ text: "Unexpected <html>" }] })).toEqual({
      reason: "toolError",
      detail: "Unexpected <html>",
    });
  });

  it("parses an ordinary answer", () => {
    expect(
      parseAnswer({
        content: [{ text: JSON.stringify({ outcome: "saved" }) }],
      }),
    ).toEqual({ outcome: "saved" });
  });
});

describe("keepHomeBecause — a side's home is evidence whenever the judge would refuse it", () => {
  const complete = (run: number) =>
    factsFromRun({
      ...base,
      run,
      report: { outcome: "complete", steps: [] },
    });
  type Filmed = { facts: RunFacts; mp4: string | null };
  const both = (): [Filmed, Filmed] => [
    { facts: complete(1), mp4: "/out/cli.mp4" },
    { facts: complete(2), mp4: "/out/cli-2.mp4" },
  ];

  it("lets a home go when both runs completed, filmed, and were read", () => {
    // Premise: these runs are what the judge compares.
    expect(both().every((r) => r.facts.span !== null)).toBe(true);
    expect(keepHomeBecause(both(), 2)).toBeNull();
  });

  it("keeps it when a run's bundle or scene could not be read", () => {
    const runs = both();
    runs[1] = {
      ...runs[1],
      facts: { ...complete(2), bundleFailed: "no bundle under /h/takes/t2" },
    };
    expect(keepHomeBecause(runs, 2)).toBe("run 2's bundle could not be read");
    const scene = both();
    scene[0] = {
      ...scene[0],
      facts: { ...complete(1), sceneFailed: "gone" },
    };
    expect(keepHomeBecause(scene, 2)).toBe("run 1's scene could not be read");
  });

  it("keeps it when a completed run made no video", () => {
    const runs = both();
    runs[0] = { facts: complete(1), mp4: null };
    // Premise: the run itself completed.
    expect(runs[0].facts.outcome).toBe("complete");
    expect(keepHomeBecause(runs, 2)).toBe("run 1 made no video");
  });

  it("keeps it when a run filmed no motion, and when runs are missing or incomplete", () => {
    const runs = both();
    runs[1] = {
      ...runs[1],
      facts: { ...complete(2), span: null },
    };
    expect(keepHomeBecause(runs, 2)).toBe("run 2 recorded no motion spans");
    expect(keepHomeBecause(both().slice(0, 1), 2)).toBe("1 of 2 runs finished");
    const stopped = both();
    stopped[0] = {
      ...stopped[0],
      facts: { ...complete(1), outcome: "stopped" },
    };
    expect(keepHomeBecause(stopped, 2)).toBe("run 1 did not complete");
  });
});

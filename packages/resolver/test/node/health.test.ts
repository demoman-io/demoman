import { describe, expect, it } from "vitest";
import { anchorHealth } from "../../src/health";
import type { ResolutionReport } from "../../src/types";

const report = (strategy: ResolutionReport["strategy"]): ResolutionReport => ({
  anchorId: "a",
  strategy,
  element: null,
  candidates: 1,
  failureReason: null,
  corroboration: [],
  durationMs: 0,
});

describe("anchorHealth", () => {
  it("says the demo is in good shape when every anchor matched by stable ID", () => {
    const s = anchorHealth([report("stableId"), report("stableId")]);
    expect(s.sentence).toBe(
      "2 of 2 anchors matched by stable ID — this demo is in good shape",
    );
  });

  it("states the mix plainly when some anchors fell back", () => {
    const s = anchorHealth([
      report("stableId"),
      report("roleName"),
      report("treePath"),
    ]);
    expect(s.sentence).toBe(
      "1 of 3 anchors matched by stable ID — 2 fell back to weaker fingerprints",
    );
    expect(s.byStrategy.roleName).toBe(1);
  });

  // v8 §4: state the expectation before the first alert, not after.
  it("warns up front when nothing matched by stable ID", () => {
    const s = anchorHealth([report("roleName"), report("roleName")]);
    expect(s.sentence).toBe(
      "0 of 2 anchors matched by stable ID — all resolved by weaker fingerprints; drift alerts on this app will be noisier",
    );
  });

  it("counts an empty take without dividing by zero", () => {
    expect(anchorHealth([]).sentence).toBe("no anchors captured");
  });

  it("still says the demo is in good shape, unchanged, when every anchor matched by stable ID", () => {
    const s = anchorHealth([
      report("stableId"),
      report("stableId"),
      report("stableId"),
    ]);
    expect(s.sentence).toBe(
      "3 of 3 anchors matched by stable ID — this demo is in good shape",
    );
  });

  // The reviewer's own example: nothing "fell back" here -- two anchors don't
  // resolve at all, which is a stronger statement than "weaker fingerprint".
  it("does not describe broken/ambiguous anchors as having fallen back to weaker fingerprints", () => {
    const s = anchorHealth([
      report("stableId"),
      report("broken"),
      report("broken"),
    ]);
    expect(s.sentence).not.toContain("fell back");
    expect(s.sentence).toBe(
      "1 of 3 anchors matched by stable ID — 2 did not resolve at all",
    );
  });

  it("states plainly when nothing resolved at all", () => {
    const s = anchorHealth([report("broken"), report("ambiguous")]);
    expect(s.sentence).toBe(
      "0 of 2 anchors matched by stable ID — none of them resolved; check this take before you rely on it",
    );
  });

  it("states the mix plainly when some fell back and some did not resolve", () => {
    const s = anchorHealth([
      report("stableId"),
      report("roleName"),
      report("broken"),
    ]);
    expect(s.sentence).toBe(
      "1 of 3 anchors matched by stable ID — 1 fell back to weaker fingerprints, 1 did not resolve at all",
    );
  });
});

describe("anchorHealth short form", () => {
  it("says all strong when every anchor matched by stable ID", () => {
    expect(anchorHealth([report("stableId"), report("stableId")]).short).toBe(
      "all 2 strong",
    );
  });

  it("counts the strong ones when some fell back", () => {
    expect(
      anchorHealth([report("stableId"), report("text"), report("roleName")])
        .short,
    ).toBe("1 of 3 strong");
  });

  it("says none resolved when every anchor is broken or ambiguous", () => {
    expect(anchorHealth([report("broken"), report("ambiguous")]).short).toBe(
      "none resolved",
    );
  });

  it("says so when there were no anchors at all", () => {
    expect(anchorHealth([]).short).toBe("no anchors captured");
  });

  it("leaves the full sentence untouched", () => {
    expect(anchorHealth([report("stableId"), report("text")]).sentence).toBe(
      "1 of 2 anchors matched by stable ID — 1 fell back to weaker fingerprints",
    );
  });
});

import { REPLAY_DPR } from "@demoman/replay-engine";
import { describe, expect, it } from "vitest";
import { stillsDprFor } from "../src/launch.js";

// DEM-75: a headless browser launched with no GPU arguments draws on the
// CPU, where a 3x still of a page with a backdrop blur cost ~3 s on a runner
// and the video held every wait. These pin the rule's corners.
describe("stillsDprFor", () => {
  it("films stills at 2x headless with no GPU arguments", () => {
    expect(stillsDprFor([], true)).toBe(2);
  });

  it("keeps REPLAY_DPR with GPU arguments, or with a visible window", () => {
    // Premise: REPLAY_DPR is not 2, so a rule that answered 2 for every
    // case would fail here rather than pass by coincidence.
    expect(REPLAY_DPR).not.toBe(2);
    expect(stillsDprFor(["--enable-gpu"], true)).toBe(REPLAY_DPR);
    expect(stillsDprFor([], false)).toBe(REPLAY_DPR);
    expect(stillsDprFor(["--enable-gpu"], false)).toBe(REPLAY_DPR);
  });
});

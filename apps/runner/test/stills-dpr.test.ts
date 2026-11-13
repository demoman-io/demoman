import { REPLAY_DPR } from "@demoman/replay-engine";
import { describe, expect, it } from "vitest";
import { stillsDprFor } from "../src/launch.js";

// DEM-75: headless Linux draws on the CPU, where a 3x still of a page with a
// backdrop blur cost ~3 s on a runner and the video held every wait. The
// rule lives in one place; these pin its four corners.
describe("stillsDprFor", () => {
  it("films stills at 2x headless on Linux", () => {
    expect(stillsDprFor("linux", true)).toBe(2);
  });

  it("keeps REPLAY_DPR everywhere else", () => {
    // Premise: REPLAY_DPR is not 2, so a rule that answered 2 for every
    // case would fail here rather than pass by coincidence.
    expect(REPLAY_DPR).not.toBe(2);
    expect(stillsDprFor("linux", false)).toBe(REPLAY_DPR);
    expect(stillsDprFor("darwin", true)).toBe(REPLAY_DPR);
    expect(stillsDprFor("win32", true)).toBe(REPLAY_DPR);
  });
});

import { describe, expect, it } from "vitest";
import { pairSeams } from "./seams.js";

const FRAME_MS = 1000 / 60;
const seg = (outStartMs: number, outEndMs: number, kind: string) => ({
  outStartMs,
  outEndMs,
  kind,
});

// same-take.slow.test.ts's seam check, on timelines CI's runners recorded.
describe("pairSeams", () => {
  // ubuntu, PR #80 (job 132675434140): step 0's pair, 1115 to 2070. The
  // journey opened with a 5 ms pointer sample and 12.5 ms of idle before the
  // rest of it, and only the motion-to-idle seam qualified. Red:
  // drop the fold of sub-frame idle in seams.ts, and the idle-to-motion seam
  // is lost again.
  it("counts an idle shorter than a frame between motion runs as motion", () => {
    const timeline = [
      seg(0, 250, "idle"),
      seg(250, 286.2204724409449, "idle"),
      seg(286.2204724409449, 851.2204724409448, "motion"),
      seg(851.2204724409448, 1115, "idle"),
      seg(1115, 1115, "idle"),
      seg(1115, 1315, "idle"),
      seg(1315, 1345.2211302211301, "idle"),
      seg(1345.2211302211301, 1350.2211302211301, "motion"),
      seg(1350.2211302211301, 1362.7518427518426, "idle"),
      seg(1362.7518427518426, 1812.7518427518426, "motion"),
      seg(1812.7518427518426, 2070, "idle"),
      seg(2070, 2070, "idle"),
      seg(2070, 2608, "motion"),
    ];
    const { runs, seams } = pairSeams(timeline, 1115, 2070, FRAME_MS);
    // Premise: the fixture carries the fragments, each shorter than a frame.
    const fragments = timeline.filter(
      (g) =>
        g.outStartMs >= 1345 &&
        g.outEndMs <= 1363 &&
        g.outEndMs - g.outStartMs < FRAME_MS,
    );
    expect(fragments.map((g) => g.kind)).toEqual(["motion", "idle"]);
    expect(
      runs.map((r) => r.kind),
      JSON.stringify(runs),
    ).toEqual(["still", "motion", "still"]);
    expect(seams).toEqual([
      { atMs: 1345.2211302211301, idleBefore: true },
      { atMs: 1812.7518427518426, idleBefore: false },
    ]);
  });

  // Red: fold by length alone (`< frameMs`). 1349.9 to 1362.4 is under a
  // frame long but holds the frame at 1350, which the film shows still.
  it("keeps a short idle that a frame of the film falls inside", () => {
    const { runs } = pairSeams(
      [
        seg(1000, 1300, "idle"),
        seg(1300, 1349.9, "motion"),
        seg(1349.9, 1362.4, "idle"),
        seg(1362.4, 1800, "motion"),
        seg(1800, 2000, "idle"),
      ],
      1000,
      2000,
      FRAME_MS,
    );
    // Premise: the frame at 1350 ms (the 81st) falls inside the idle.
    expect(81 * FRAME_MS).toBeGreaterThan(1349.9);
    expect(81 * FRAME_MS).toBeLessThan(1362.4);
    expect(runs.map((r) => r.kind)).toEqual([
      "still",
      "motion",
      "still",
      "motion",
      "still",
    ]);
  });

  // Red: drop the clip to the pair. An idle from 1000 to 1300 has only 185
  // ms inside a pair that starts at 1115; counted whole, its room and its
  // 100 ms reference would reach into the step before.
  it("measures a run only inside the pair", () => {
    const { runs } = pairSeams(
      [seg(1000, 1300, "idle"), seg(1300, 1800, "motion")],
      1115,
      2000,
      FRAME_MS,
    );
    expect(runs[0]).toEqual({
      outStartMs: 1115,
      outEndMs: 1300,
      kind: "still",
    });
  });

  // macOS, PR #87 (job 135131814001): step 1's pair, 1062 to 1994. The
  // arrive the plan made 300 ms was filmed 114 ms, too short for the 100 ms
  // reference, so its seam does not count. That is the product's,
  // not the check's: no fold here may make it count.
  it("leaves out a seam whose idle has no room for the reference", () => {
    const { seams } = pairSeams(
      [
        seg(1062, 1062, "idle"),
        seg(1062, 1262, "idle"),
        seg(1262, 1448.023622047244, "idle"),
        seg(1448.023622047244, 1880.023622047244, "motion"),
        seg(1880.023622047244, 1994, "idle"),
        seg(1994, 1994, "idle"),
        seg(1994, 2319, "motion"),
      ],
      1062,
      1994,
      FRAME_MS,
    );
    expect(seams).toEqual([{ atMs: 1448.023622047244, idleBefore: true }]);
  });
});

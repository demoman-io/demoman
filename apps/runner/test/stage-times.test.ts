import { describe, expect, it } from "vitest";
import { stageTimes } from "../src/stage-times.js";

describe("stageTimes", () => {
  it("times each stage from the mark before it, and totals them", () => {
    const clock = [1000, 1500, 4000, 4250];
    const times = stageTimes(() => clock.shift() ?? Number.NaN);
    times.mark("setup");
    times.mark("walk");
    times.note("in page: frames 0.10s");
    times.mark("store");
    expect(times.line("run t1")).toBe(
      "timing run t1: setup 0.50s, walk 2.50s, store 0.25s; total 3.25s; in page: frames 0.10s",
    );
  });
});

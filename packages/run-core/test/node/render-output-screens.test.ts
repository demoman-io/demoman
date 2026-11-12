import { describe, expect, it } from "vitest";
import { screenImageName } from "../../src/render/output";

describe("screenImageName", () => {
  it("names a step and the final screen", () => {
    expect(screenImageName(null)).toBe("final.png");
    expect(screenImageName(3)).toBe("step-3.png");
  });
});

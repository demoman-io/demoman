// apps/studio/test/pages/node/settings-section-nav.test.ts
import { describe, expect, it } from "vitest";
import { currentSection } from "../../../pages/src/settings/section-nav";

const at = (...tops: number[]) => tops.map((top, i) => ({ id: `s${i}`, top }));

describe("currentSection", () => {
  it("is the first section before any has crossed the line", () => {
    expect(
      currentSection(at(100, 900, 1600), { height: 800, atFoot: false }),
    ).toBe("s0");
  });

  it("is the last section whose top has crossed 30% of the window", () => {
    // 240 is the line in an 800px window.
    expect(
      currentSection(at(-900, 200, 700), { height: 800, atFoot: false }),
    ).toBe("s1");
    expect(
      currentSection(at(-900, 241, 700), { height: 800, atFoot: false }),
    ).toBe("s0");
  });

  // Red if the foot rule goes: Diagnostics is short and last, and at the
  // bottom of the page its top sits below the line (634px of 900 in the
  // mockup), so "crossed the line" alone never reaches it.
  it("is the last section at the foot of the page, wherever its top is", () => {
    const sections = at(-2000, -1200, -400, 634);
    // Premise: by the line alone, the last section is not current.
    expect(currentSection(sections, { height: 900, atFoot: false })).toBe("s2");
    expect(currentSection(sections, { height: 900, atFoot: true })).toBe("s3");
  });

  it("is nothing with no sections", () => {
    expect(currentSection([], { height: 800, atFoot: true })).toBeNull();
  });
});

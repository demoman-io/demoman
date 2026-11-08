import { describe, expect, it } from "vitest";
import { linkProgress } from "../src/link-progress";

describe("demoman link's progress lines", () => {
  it("prints a 1,800-frame render in a handful of lines, and each phase once it starts", () => {
    const lines: string[] = [];
    const on = linkProgress((l) => lines.push(l));
    on({
      outcome: "linking",
      phase: "checking",
      done: 0,
      total: 0,
      summary: "Linking — checking your Demoman sign-in.",
    });
    for (let i = 0; i <= 1800; i++)
      on({
        outcome: "linking",
        phase: "rendering",
        done: i,
        total: 1800,
        summary: `Linking — rendering: frame ${i} of 1800.`,
      });
    on({
      outcome: "linking",
      phase: "saving",
      done: 0,
      total: 0,
      summary: "Linking — saving the file.",
    });
    for (let n = 1; n <= 3; n++)
      on({
        outcome: "linking",
        phase: "uploading",
        done: n - 1,
        total: 3,
        summary: `Linking — uploading part ${n} of 3.`,
      });
    expect(lines.length, lines.join("\n")).toBeLessThanOrEqual(12);
    expect(lines).toContain("Linking — checking your Demoman sign-in.");
    expect(lines).toContain("Linking — saving the file.");
    expect(lines).toContain("Linking — uploading part 3 of 3.");
    expect(lines.some((l) => l.includes("rendering"))).toBe(true);
  });
});

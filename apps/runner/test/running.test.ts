import type { DemoScript } from "@demoman/scene-schema";
import { describe, expect, it } from "vitest";
import { runningWords, stepWords } from "../src/executor/running.js";

const script = {
  scriptVersion: 1,
  target: "https://example.test/",
  steps: [
    { do: "waitForLoad" },
    { do: "click", on: { role: "textbox", name: "Filter invoices…" } },
    { do: "pause", ms: 500 },
    { do: "type", into: { text: "Filter" }, text: "hunter2-secret" },
    { do: "waitFor", on: { text: "Harbor & Pine" }, until: "hidden" },
  ],
} as unknown as DemoScript;

describe("the running line", () => {
  it("names the step in flight, the one after those done, skipping pauses", () => {
    // Premise: four steps count, the pause does not.
    expect(runningWords(script, 0, 4)).toBe(
      "step 1 of 4 · wait for the page to load",
    );
    expect(runningWords(script, 1, 4)).toBe(
      'step 2 of 4 · click "Filter invoices…"',
    );
    // Red if pauses are counted: index 2 would be the pause.
    expect(runningWords(script, 2, 4)).toBe('step 3 of 4 · type into "Filter"');
    expect(runningWords(script, 3, 4)).toBe(
      'step 4 of 4 · wait for "Harbor & Pine" to go',
    );
    expect(runningWords(script, 4, 4)).toBe("finishing the video");
  });

  it("never shows what a type step types: it may be a secret", () => {
    const words = stepWords({
      do: "type",
      into: { text: "Password" },
      text: "hunter2-secret",
    });
    expect(words).toBe('type into "Password"');
    expect(words).not.toContain("hunter2");
  });

  it("says only the number when the engine's count disagrees with the script's", () => {
    expect(runningWords(script, 1, 6)).toBe("step 2 of 6");
  });

  it("cuts a long name and folds its whitespace onto one line", () => {
    const long = `Export\n   ${"all invoices ".repeat(6)}`;
    const words = stepWords({ do: "click", on: { text: long } });
    expect(words).toMatch(/^click "Export all invoices all invoices .*…"$/);
    expect(words.length).toBeLessThanOrEqual('click ""'.length + 40);
    expect(words).not.toContain("\n");
  });

  it("does not invent a name for a tree path", () => {
    expect(stepWords({ do: "scrollTo", on: { treePath: "0/2/1" } })).toBe(
      "scroll to an element",
    );
  });
});

// Audit run 1: a target's name is the page's accessible name, and the
// running line reaches the agent's terminal. Red without the strip.
describe("the running line carries no control characters", () => {
  it("flattens them out of a step's name", () => {
    const words = stepWords({
      do: "click",
      on: { role: "button", name: "Pay\u001b[2K\u202enow\u0007" },
    } as never);
    expect(words).toBe('click "Pay [2K now"');
  });
});

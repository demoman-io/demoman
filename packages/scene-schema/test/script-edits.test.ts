import { describe, expect, it } from "vitest";
import {
  DemoScriptSchema,
  SCRIPT_VERSION_EDITS,
  SHOWN_STEP,
  trimStepIndex,
} from "../src/index.js";

const base = {
  name: "n",
  target: "https://example.com",
  steps: [
    { do: "click", on: { text: "Go" } },
    { do: "pause", ms: 100 },
    { do: "click", on: { text: "Next" } },
  ],
};
const paths = (r: ReturnType<typeof DemoScriptSchema.safeParse>) =>
  r.success ? [] : r.error.issues.map((i) => i.path.join("."));
const messages = (r: ReturnType<typeof DemoScriptSchema.safeParse>) =>
  r.success ? [] : r.error.issues.map((i) => i.message);

describe("trim and zoom", () => {
  it("accepts trim and zoom and raises the version to 8", () => {
    const input = {
      name: "n",
      target: "https://example.com",
      trim: { start: { ms: 300 }, end: { ms: 0, after: "action" } },
      steps: [
        { do: "click", on: { text: "Go" }, zoom: false },
        { do: "click", on: { text: "Next" }, zoom: { scale: 1.6 } },
      ],
    };
    const r = DemoScriptSchema.safeParse(input);
    expect(r.success).toBe(true);
    expect(SCRIPT_VERSION_EDITS).toBe(8);
    expect(r.data?.scriptVersion).toBe(8);
    expect(r.data?.trim).toEqual(input.trim);
    expect(r.data?.steps.map((s) => ("zoom" in s ? s.zoom : "none"))).toEqual([
      false,
      { scale: 1.6 },
    ]);
  });

  it("writes no default for end.after, and a script with neither field keeps version 1", () => {
    const r = DemoScriptSchema.safeParse({
      ...base,
      trim: { end: { ms: 5 } },
    });
    expect(r.data?.scriptVersion).toBe(8);
    expect(r.data?.trim?.end).toEqual({ ms: 5 });
    expect(DemoScriptSchema.parse(base).scriptVersion).toBe(1);
  });

  it("refuses zoom on a type step, by name", () => {
    const r = DemoScriptSchema.safeParse({
      ...base,
      steps: [{ do: "type", into: { text: "a" }, text: "x", zoom: false }],
    });
    expect(r.success).toBe(false);
    expect(messages(r).join(" ")).toContain("zoom");
  });

  it.each([1, 2.6])("refuses a zoom scale of %s", (scale) => {
    const r = DemoScriptSchema.safeParse({
      ...base,
      steps: [{ do: "click", on: { text: "Go" }, zoom: { scale } }],
    });
    expect(r.success).toBe(false);
    expect(paths(r)).toContain("steps.0.zoom.scale");
  });

  it("refuses a trim step on a pause, in words", () => {
    const r = DemoScriptSchema.safeParse({
      ...base,
      trim: { start: { ms: 0, step: 2 } },
    });
    expect(paths(r)).toEqual(["trim.start.step"]);
    expect(messages(r)[0]).toMatch(/pause/);
  });

  it("refuses a trim step out of range", () => {
    const r = DemoScriptSchema.safeParse({
      ...base,
      trim: { end: { ms: 0, step: 4 } },
    });
    expect(paths(r)).toEqual(["trim.end.step"]);
    expect(messages(r)[0]).toMatch(/3 steps/);
  });

  it("refuses a start step after the end step, comparing resolved steps", () => {
    const both = DemoScriptSchema.safeParse({
      ...base,
      trim: { start: { ms: 0, step: 3 }, end: { ms: 0, step: 1 } },
    });
    expect(paths(both)).toEqual(["trim.start.step"]);
    expect(messages(both)[0]).toMatch(/after/);
    // end defaults to the last shown step (3); a start at 3 is fine, so name
    // an end default that a start cannot pass: only one shown step after it.
    const dflt = DemoScriptSchema.safeParse({
      ...base,
      steps: [
        { do: "click", on: { text: "a" } },
        { do: "click", on: { text: "b" } },
        { do: "waitForLoad" },
      ],
      trim: { start: { ms: 0, step: 3 } },
    });
    // step 3 is waitForLoad: not a pause, and start resolves to 3 > end 2.
    expect(paths(dflt)).toEqual(["trim.start.step"]);
  });

  it("refuses a negative ms", () => {
    const r = DemoScriptSchema.safeParse({
      ...base,
      trim: { end: { ms: -1 } },
    });
    expect(paths(r)).toContain("trim.end.ms");
  });

  it("SHOWN_STEP marks exactly the six shown verbs", () => {
    expect(
      Object.entries(SHOWN_STEP)
        .filter(([, v]) => v)
        .map(([k]) => k)
        .sort(),
    ).toEqual(["click", "drag", "hover", "press", "scrollTo", "type"]);
  });

  it("trimStepIndex reads a named step 0-based, and absent as the first or last shown", () => {
    const steps = [
      { do: "waitForLoad" },
      { do: "click" },
      { do: "pause" },
      { do: "type" },
      { do: "waitFor" },
    ] as const;
    expect(trimStepIndex({ steps }, "start")).toBe(1);
    expect(trimStepIndex({ steps }, "end")).toBe(3);
    const trim = { start: { ms: 0, step: 4 }, end: { ms: 0, step: 5 } };
    expect(trimStepIndex({ steps, trim }, "start")).toBe(3);
    expect(trimStepIndex({ steps, trim }, "end")).toBe(4);
    expect(trimStepIndex({ steps: [{ do: "pause" }] }, "end")).toBeNull();
  });
});

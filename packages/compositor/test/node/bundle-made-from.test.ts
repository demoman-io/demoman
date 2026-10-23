import { describe, expect, it } from "vitest";
import { madeFromOf, validateBundle } from "../../src/index.js";
import { proceduralBundle } from "../fixtures/bundle.js";
import { readonlyScene } from "../fixtures/scene.js";

describe("madeFromOf", () => {
  it("records every step's id, verb, target and typed text, in take order", () => {
    const doc = readonlyScene();
    // Premise: the fixture has a typed step with real text and a step with
    // none, or this asserts nothing about `text`.
    expect(doc.actions.some((a) => a.kind === "type")).toBe(true);
    expect(doc.actions.some((a) => a.kind !== "type")).toBe(true);

    const record = madeFromOf(doc);
    expect(record.map((s) => s.actionId)).toEqual(doc.actions.map((a) => a.id));
    const typed = doc.actions.find((a) => a.kind === "type");
    const recorded = record.find((s) => s.actionId === typed?.id);
    expect(recorded?.text).toBe((typed as { text: string | null }).text);
    expect(record.find((s) => s.kind === "scrollTo")?.text).toBeNull();
  });

  it("writes no cut flag: nothing makes frames without a step now", () => {
    const record = madeFromOf(readonlyScene());
    // Premise: there are steps to carry the flag.
    expect(record.length).toBeGreaterThan(0);
    expect(record.every((s) => !("cut" in s))).toBe(true);
  });
});

describe("FrameBundle.madeFrom", () => {
  it("accepts a bundle that carries it and one that does not", () => {
    const bundle = proceduralBundle();
    // A row written before this field existed. ABSENT, not empty: a bundle
    // with an empty record would be claiming the take had no steps.
    expect(validateBundle(bundle).madeFrom).toBeUndefined();
    const withRecord = { ...bundle, madeFrom: madeFromOf(readonlyScene()) };
    expect(validateBundle(withRecord).madeFrom).toHaveLength(
      readonlyScene().actions.length,
    );
  });

  it("refuses a record whose entries are not steps", () => {
    const bundle = { ...proceduralBundle(), madeFrom: [{ actionId: "" }] };
    expect(() => validateBundle(bundle)).toThrow();
  });
});

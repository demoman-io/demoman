import { describe, expect, it } from "vitest";
import { validateBundle } from "../../src/index.js";
import { proceduralBundle } from "../fixtures/bundle.js";

const withApproach = (value?: number) => {
  const bundle = proceduralBundle();
  return {
    ...bundle,
    markers: bundle.markers.map((m, i) =>
      i === 0 && value !== undefined
        ? { ...m, approachSourceTimeMs: value }
        : m,
    ),
  };
};

describe("marker approachSourceTimeMs", () => {
  it("round-trips when set and leaves no key when absent", () => {
    // Red if the field is dropped from MarkerSchema (zod strips it).
    expect(
      validateBundle(withApproach(120)).markers[0]?.approachSourceTimeMs,
    ).toBe(120);
    // Premise: the unset fixture really has no key, or this proves nothing.
    const unset = withApproach().markers[0] ?? {};
    expect("approachSourceTimeMs" in unset).toBe(false);
    const plain = validateBundle(withApproach()).markers[0] ?? {};
    // Red if the field gains a default.
    expect("approachSourceTimeMs" in plain).toBe(false);
  });

  it("refuses a negative value", () => {
    // Red if `.min(0)` is removed from approachSourceTimeMs.
    expect(() => validateBundle(withApproach(-1))).toThrow();
  });
});

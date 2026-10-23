import { describe, expect, it } from "vitest";
import { ACT_CEILING_MS, actEndOf } from "../../src/index.js";

// Spec 2026-10-19 (unhurried beats): an act ends when the verb has returned
// and the page has stopped reacting, up to a ceiling after the verb.
describe("actEndOf", () => {
  it("is the verb's end when nothing painted", () => {
    expect(actEndOf(5000, null)).toBe(5000);
  });

  it("is the verb's end when the last motion was before it", () => {
    expect(actEndOf(5000, 4800)).toBe(5000);
  });

  it("is the last motion when the page went on reacting", () => {
    expect(actEndOf(5000, 5300)).toBe(5300);
  });

  it("stops at the ceiling for a page that never goes quiet", () => {
    expect(ACT_CEILING_MS).toBe(1000);
    expect(actEndOf(5000, 9000)).toBe(6000);
  });
});

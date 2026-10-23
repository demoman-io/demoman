import { describe, expect, it } from "vitest";
import { loadPair, mount } from "../helpers/fixtures";

describe("node lane harness", () => {
  it("mounts a drift pair into two documents", () => {
    const { before, after } = loadPair("baseline");
    expect(
      mount(before).querySelector("[data-testid=checkout-btn]"),
    ).not.toBeNull();
    expect(
      mount(after).querySelector("[data-testid=checkout-btn]"),
    ).not.toBeNull();
  });
});

import { describe, expect, it } from "vitest";
import { loadPair } from "../helpers/fixtures";

describe("browser lane harness", () => {
  it("lays out a real element with a non-zero rect", () => {
    document.body.innerHTML = loadPair("baseline").before;
    const el = document.querySelector("[data-testid=checkout-btn]");
    expect(el).not.toBeNull();
    expect(el?.getBoundingClientRect().width).toBeGreaterThan(0);
  });
});

// apps/studio/test/pages/node/toast.test.ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { showToast, TOAST_MS } from "../../../pages/src/shell/toast";

const toasts = () => [...document.querySelectorAll("[data-toast]")];
const words = () =>
  toasts().map((t) => t.querySelector("[data-toast-text]")?.textContent);

describe("showToast", () => {
  afterEach(() => {
    vi.useRealTimers();
    document.body.replaceChildren();
  });

  it("says a sentence in a status region, then takes the toast down", () => {
    vi.useFakeTimers();
    showToast("Deleted 2 flows.");
    // The region is on the page before its words, or it is not announced.
    const region = document.querySelector("[data-toast-said]");
    expect(region?.getAttribute("role")).toBe("status");
    expect(region?.textContent).toBe("");
    vi.advanceTimersByTime(50);
    expect(region?.textContent).toBe("Deleted 2 flows");
    // The second sentence goes into the same region, emptied first.
    showToast("Deleted 2 flows.");
    expect(document.querySelectorAll("[data-toast-said]")).toHaveLength(1);
    expect(region?.textContent).toBe("");
    vi.advanceTimersByTime(TOAST_MS - 1);
    expect(toasts()).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(toasts()).toHaveLength(0);
  });

  it("says a success without its closing period, beside the check glyph", () => {
    showToast("Deleted 2 flows.");
    expect(words()).toEqual(["Deleted 2 flows"]);
    expect(toasts()[0]?.querySelector("svg")?.getAttribute("data-icon")).toBe(
      "check",
    );
    // Only the closing one: a sentence inside keeps its own.
    showToast(
      "Started a fresh kit list. The old list is kept at /x/kits.json.",
    );
    expect(words()).toEqual([
      "Started a fresh kit list. The old list is kept at /x/kits.json",
    ]);
  });

  it("one at a time: a second sentence replaces the first and gets its own time", () => {
    vi.useFakeTimers();
    showToast("Deleted 1 flow.");
    vi.advanceTimersByTime(TOAST_MS - 100);
    showToast("Deleted 3 flows.");
    expect(words()).toEqual(["Deleted 3 flows"]);
    vi.advanceTimersByTime(TOAST_MS - 1);
    expect(toasts()).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(toasts()).toHaveLength(0);
  });
});

import { ANSWER_DEADLINE_MS } from "@demoman/replay-engine";
import type { Page } from "playwright";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pageSnapshotTargets } from "../src/executor/page-ops.js";
import { withinDeadline } from "../src/page-deadline.js";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
});
afterEach(() => {
  vi.useRealTimers();
});

const never = () => new Promise<never>(() => undefined);

describe("a deadline over a call on the author's page", () => {
  it("refuses work that never settles, naming it", async () => {
    const work = withinDeadline(never(), "the snapshot's walk");
    let settled = false;
    work
      .catch(() => undefined)
      .finally(() => {
        settled = true;
      });
    await vi.advanceTimersByTimeAsync(ANSWER_DEADLINE_MS - 1);
    // The premise: one millisecond short, it is still waiting.
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(work).rejects.toThrow(
      "the snapshot's walk got no answer from the page in 30 s",
    );
  });

  it("passes an answer through and leaves no timer behind", async () => {
    expect(await withinDeadline(Promise.resolve(7), "x")).toBe(7);
    expect(vi.getTimerCount()).toBe(0);
  });

  // Review 2026-10-13, #3: a page stuck in its own script never answers
  // `page.evaluate`, and the snapshot held the executor's one slot for good.
  // Red if the snapshot's evaluate goes out without the deadline.
  it("answers a snapshot whose page never answers as pageFaulted, saying so", async () => {
    const page = { evaluate: never } as unknown as Page;
    const reply = pageSnapshotTargets(page)({
      contains: null,
      maxTargets: 10,
      budgetMs: 100,
    });
    await vi.advanceTimersByTimeAsync(ANSWER_DEADLINE_MS);
    expect(await reply).toEqual({
      failed: "pageFaulted",
      detail: "the snapshot's walk got no answer from the page in 30 s",
    });
  });
});

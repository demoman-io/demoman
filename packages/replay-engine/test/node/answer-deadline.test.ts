import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ANSWER_DEADLINE_MS,
  withAnswerDeadline,
} from "../../src/answer-deadline";
import { createNavigatingGuard } from "../../src/navigate";
import { createOcclusionGuard } from "../../src/occlusion";
import type { CdpSession } from "../../src/types";

/** A session whose `hang` method never answers and whose others answer at
 *  once with their own name. */
function session(hang: string): CdpSession {
  return {
    send: (method) =>
      method === hang
        ? new Promise(() => undefined)
        : Promise.resolve({ method }),
    on: () => () => undefined,
    detach: async () => undefined,
  };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
});
afterEach(() => {
  vi.useRealTimers();
});

describe("a deadline over every CDP call", () => {
  it("refuses a call the browser never answers, naming it", async () => {
    const { cdp } = withAnswerDeadline(session("Page.captureScreenshot"));
    const shot = cdp.send("Page.captureScreenshot", {});
    let settled = false;
    shot
      .catch(() => undefined)
      .finally(() => {
        settled = true;
      });
    await vi.advanceTimersByTimeAsync(ANSWER_DEADLINE_MS - 1);
    // The premise: one millisecond short, it is still waiting.
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(shot).rejects.toThrow(
      "Page.captureScreenshot got no answer from the browser in 30 s",
    );
  });

  it("passes an answer through and leaves no timer behind", async () => {
    const { cdp } = withAnswerDeadline(session("never"));
    expect(await cdp.send("DOM.getBoxModel", {})).toEqual({
      method: "DOM.getBoxModel",
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("passes a refusal through as it was", async () => {
    const { cdp } = withAnswerDeadline({
      ...session("never"),
      send: () => Promise.reject(new Error("Not attached to an active page")),
    });
    await expect(cdp.send("Page.captureScreenshot", {})).rejects.toThrow(
      "Not attached to an active page",
    );
    expect(vi.getTimerCount()).toBe(0);
  });

  // Review 2026-10-13, #4: the guards are built by each host on its own
  // session, which the walk's deadline never wrapped — and the navigating
  // guard's `Page.navigate` is the first call of every run and snapshot. A
  // server that takes the connection and never answers held it forever.
  // Red if either guard sends on the session it was handed.
  for (const [guard, hang] of [
    ["navigating", "Page.navigate"],
    ["occlusion", "Runtime.addBinding"],
  ] as const) {
    it(`gives the ${guard} guard's ${hang} a deadline of its own`, async () => {
      const cdp = session(hang);
      const clock = { now: () => 0, sleep: () => new Promise<void>(() => {}) };
      const occlusion = createOcclusionGuard({ cdp, clock });
      const installed = (
        guard === "navigating"
          ? createNavigatingGuard({
              guard: occlusion,
              cdp,
              url: "http://localhost:1/",
              sleep: clock.sleep,
            })
          : occlusion
      ).install();
      installed.catch(() => undefined);
      await vi.advanceTimersByTimeAsync(ANSWER_DEADLINE_MS);
      await expect(installed).rejects.toThrow(
        `${hang} got no answer from the browser in 30 s`,
      );
    });
  }

  // Red if `stop` leaves a deadline running: it would fire after the walk
  // returned, into a call nobody awaits any more.
  it("stop clears the deadlines still running, and they never fire", async () => {
    const answering = withAnswerDeadline(session("Page.captureScreenshot"));
    let refused = false;
    answering.cdp.send("Page.captureScreenshot", {}).catch(() => {
      refused = true;
    });
    // The premise: a deadline is running.
    expect(vi.getTimerCount()).toBe(1);
    answering.stop();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(ANSWER_DEADLINE_MS * 2);
    expect(refused).toBe(false);
  });
});

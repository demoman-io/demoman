import { describe, expect, it } from "vitest";
import { waitForPageReady } from "../../src/loaded";
import type { CdpSession } from "../../src/types";

/** A CDP session that answers `document.readyState` from a list (last value
 *  repeats) and the settle probe with `settle`, or throws it. */
function fakeCdp(
  states: string[],
  settle: unknown | Error,
): CdpSession & {
  evaluated: string[];
} {
  const evaluated: string[] = [];
  let i = 0;
  return {
    evaluated,
    on: () => () => undefined,
    detach: async () => undefined,
    send: async (_method, params) => {
      const expression = String(params?.expression ?? "");
      evaluated.push(expression);
      if (expression === "document.readyState") {
        const value = states[Math.min(i, states.length - 1)];
        i += 1;
        return { result: { value } };
      }
      if (settle instanceof Error) throw settle;
      return { result: { value: settle } };
    },
  };
}
const noSleep = async () => undefined;

describe("waitForPageReady", () => {
  // Red if the probe runs before the document completes, or never runs.
  it("polls until complete, then asks the settle probe, and answers settled", async () => {
    const cdp = fakeCdp(["loading", "interactive", "complete"], {
      settled: true,
      pending: 0,
      fonts: "ok",
      ready: "complete",
      quiet: true,
    });
    await expect(waitForPageReady(cdp, noSleep)).resolves.toEqual({
      settled: true,
      note: null,
    });
    expect(
      cdp.evaluated.filter((e) => e === "document.readyState"),
    ).toHaveLength(3);
    // Premise: the last thing asked was the probe, not another readyState.
    expect(cdp.evaluated.at(-1)).toMatch(/__demomanSettlePaint/);
  });

  // Red if a document that never completes is reported settled (a snapshot
  // of a half-parsed page would read as the page).
  it("says the document never completed, naming its state, and does not run the probe", async () => {
    const cdp = fakeCdp(["loading"], { settled: true });
    const ready = await waitForPageReady(cdp, noSleep);
    expect(ready.settled).toBe(false);
    expect(ready.note).toMatch(/still "loading"/);
    expect(cdp.evaluated.some((e) => /__demomanSettlePaint/.test(e))).toBe(
      false,
    );
  });

  // Red if a probe failure or an unreadable reply reads as settled.
  it("answers unsettled with the reason when the probe throws, answers nothing readable, reports pending images, or a page still changing", async () => {
    const thrown = await waitForPageReady(
      fakeCdp(["complete"], new Error("target closed")),
      noSleep,
    );
    expect(thrown).toEqual({
      settled: false,
      note: "the page-settle probe failed (target closed)",
    });
    const blank = await waitForPageReady(
      fakeCdp(["complete"], undefined),
      noSleep,
    );
    expect(blank.settled).toBe(false);
    expect(blank.note).toMatch(/nothing this could read/);
    const pending = await waitForPageReady(
      fakeCdp(["complete"], {
        settled: false,
        pending: 3,
        fonts: "ok",
        ready: "complete",
        quiet: true,
      }),
      noSleep,
    );
    expect(pending).toEqual({
      settled: false,
      note: "3 image(s) near the top were still loading after 3 s",
    });
    // Images in and the document still changing: not "0 image(s) still
    // loading", which reads as though nothing was.
    const changing = await waitForPageReady(
      fakeCdp(["complete"], {
        settled: false,
        pending: 0,
        fonts: "ok",
        ready: "complete",
        quiet: false,
      }),
      noSleep,
    );
    expect(changing).toEqual({
      settled: false,
      note: "the page was still changing after 5 s (its images were in; a loading bar, or an app still connecting)",
    });
  });
});

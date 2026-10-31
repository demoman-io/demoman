// apps/runner/test/play.test.ts
import { type AuthoredResult, reasonSentence } from "@demoman/replay-engine";
import { clickNotDeliveredDetail } from "@demoman/run-core";
import { describe, expect, it } from "vitest";
import { type Played, stopDetail } from "../src/executor/play.js";

const target = "http://localhost:4000/";

/** A `Played` with only what `stopDetail` reads; the rest is cast. */
function played(
  result: Pick<AuthoredResult, "reason" | "outcome" | "completed" | "total">,
  over: Partial<Played> = {},
): Played {
  return {
    result: { steps: [], ...result } as unknown as AuthoredResult,
    navigationError: null,
    failedNote: undefined,
    signedOutAfter: null,
    lostHeadlessPage: false,
    landingNote: undefined,
    arrival: null,
    ...over,
  };
}

const stoppedAt = (reason: AuthoredResult["reason"]) =>
  ({ reason, outcome: "partial", completed: 1, total: 3 }) as const;

describe("stopDetail", () => {
  it("names a headless page that went away, with the walk's note", () => {
    const detail = stopDetail(
      target,
      played(stoppedAt("portFailure"), {
        lostHeadlessPage: true,
        failedNote: "x",
      }),
    );
    expect(detail).toMatch(/^Demoman's headless browser lost the run's page/);
    expect(detail).toMatch(/\(x\)$/);
  });

  it("says a port that gave way in the walk's words", () => {
    const detail = stopDetail(
      target,
      played(stoppedAt("portFailure"), { failedNote: "boom" }),
    );
    expect(detail).toContain("something underneath the run gave way: boom");
  });

  it("says where an undelivered click went", () => {
    expect(
      stopDetail(
        target,
        played(stoppedAt("clickNotDelivered"), { failedNote: "at 3,4" }),
      ),
    ).toBe(clickNotDeliveredDetail("at 3,4"));
  });

  it("names a target that did not load", () => {
    expect(
      stopDetail(
        target,
        played(stoppedAt("unresolvedAnchor"), {
          navigationError: "net::ERR_CONNECTION_REFUSED",
        }),
      ),
    ).toBe(
      `${target} did not load (net::ERR_CONNECTION_REFUSED) — check that the app is running at that address`,
    );
  });

  it("leads with a mid-run sign-out and says the take was not kept", () => {
    expect(
      stopDetail(
        target,
        played(stoppedAt("unresolvedAnchor"), { signedOutAfter: "S." }),
      ),
    ).toMatch(/^S\. The video was not kept/);
  });

  it("says nothing for a complete run", () => {
    expect(
      stopDetail(
        target,
        played({ reason: null, outcome: "complete", completed: 3, total: 3 }),
      ),
    ).toBeUndefined();
  });

  // Review 2026-10-31, finding 2: a timed-out wait says what its last look
  // found, not "never found" for a tie or a silent page.
  const waitedAndSaw = (waitSaw: string) =>
    played({
      ...stoppedAt("waitTimeout"),
      steps: [{ waitSaw }],
    } as unknown as Parameters<typeof played>[0]);

  it("says a wait whose target tied matched more than one element", () => {
    expect(stopDetail(target, waitedAndSaw("ambiguous"))).toMatch(
      /matched more than one element.*name a more precise target/,
    );
  });

  it("says a wait whose page never answered, or threw, in the page's words", () => {
    expect(stopDetail(target, waitedAndSaw("pageSilent"))).toBe(
      reasonSentence("pageSilent"),
    );
    expect(stopDetail(target, waitedAndSaw("pageFaulted"))).toBe(
      reasonSentence("pageFaulted"),
    );
  });

  it("leaves a wait that found nothing to the generic sentence", () => {
    expect(stopDetail(target, waitedAndSaw("absent"))).toBeUndefined();
  });
});

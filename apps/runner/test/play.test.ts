// apps/runner/test/play.test.ts
import { type AuthoredResult, reasonSentence } from "@demoman/replay-engine";
import { clickNotDeliveredDetail, screenScaleNote } from "@demoman/run-core";
import type { BrowserContext } from "playwright";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BrowserSession } from "../src/executor/browser.js";
import {
  type PlayDeps,
  type Played,
  prepareStage,
  stopDetail,
} from "../src/executor/play.js";

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
    heldFailed: undefined,
    landingNote: undefined,
    arrival: null,
    datesOnScreen: [],
    closedShadowRoot: false,
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

  // DEM-102: said only on a page that has a closed shadow root.
  it("names a closed shadow root when the page has one and the target was not found", () => {
    const said =
      "this page has a closed shadow root, and a target inside one can't be reached during a run";
    const found = stopDetail(
      target,
      played(stoppedAt("unresolvedAnchor"), { closedShadowRoot: true }),
    );
    expect(found).toContain(reasonSentence("unresolvedAnchor"));
    expect(found).toContain(said);
    const waited = stopDetail(
      target,
      played(
        {
          ...stoppedAt("waitTimeout"),
          steps: [{ waitSaw: "absent" }],
        } as never,
        { closedShadowRoot: true },
      ),
    );
    expect(waited).toContain(reasonSentence("waitTimeout"));
    expect(waited).toContain(said);
    expect(
      stopDetail(target, played(stoppedAt("unresolvedAnchor"))),
    ).toBeUndefined();
    expect(
      stopDetail(
        target,
        played(stoppedAt("ambiguousAnchor"), { closedShadowRoot: true }),
      ),
    ).toBeUndefined();
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

/** `prepareStage`'s deps for a stage on a screen at `screenScale`: only what
 *  it reads before the walk. `filmScale` null is a visible window. */
function stagedOn(
  screenScale: number,
  filmScale: number | null,
  more: Partial<PlayDeps> = {},
): PlayDeps {
  const context = {} as BrowserContext;
  return {
    session: {
      stage: async () => ({
        ok: true,
        stage: { context, page: {}, cdp: {}, clock: {} },
      }),
      screen: async () => ({ width: 1440, height: 900, scale: screenScale }),
      screenUnknown: () => null,
      filmScale: () => filmScale,
    } as unknown as BrowserSession,
    log: () => undefined,
    sessions: [],
    sessionsContext: context,
    loadSessions: async () => ({ ok: true as const, files: [] }),
    signinCommand: "npx demoman signin",
    recordingFrameRate: { value: 30, from: "default" } as const,
    ...more,
  } as PlayDeps;
}

const sized = { scriptVersion: 1, name: "n", target, steps: [] } as never;

describe("prepareStage's word on the scale", () => {
  // Spec 2026-11-13 part 2: a visible window cannot be given a scale, so a
  // run on a 1x screen of a flow recorded at 2x says so, with both numbers.
  // Turns red when play.ts's `headedScale` is dropped from `said`.
  it("says a visible window recorded at its screen's scale, not the flow's", async () => {
    const out = await prepareStage(sized, stagedOn(1, null, { flowScale: 2 }));
    if (!out.ok) throw new Error(JSON.stringify(out));
    // Premise: the size is the screen's, which carries no error of its own.
    expect(out.size).toMatchObject({ width: 1440, from: "screen" });
    expect(out.size.error).toBe(screenScaleNote(1, 2));
    expect(out.size.error).toContain("1x");
    expect(out.size.error).toContain("2x");
    // The same screen for a flow at 1x has nothing to say.
    const same = await prepareStage(sized, stagedOn(1, null, { flowScale: 1 }));
    expect(same.ok && same.size.error).toBeNull();
  });

  // Headless asked for the flow's scale at the door, so it is not said.
  it("says nothing of the screen's scale for headless", async () => {
    const out = await prepareStage(sized, stagedOn(1, 2, { flowScale: 2 }));
    expect(out.ok && out.size.error).toBeNull();
  });

  // Report before you forgive: a flow whose scale could not be read records
  // at the constant, and says so. Turns red when `scaleUnread` is dropped.
  it("says when the flow's recorded scale could not be read", async () => {
    const out = await prepareStage(
      sized,
      stagedOn(1, 2, { flowScaleUnread: "video t1 is missing" }),
    );
    expect(out.ok && out.size.error).toBe(
      "The flow's recorded scale could not be read (video t1 is missing), so this run recorded at 2x.",
    );
  });
});

describe("prepareStage's word on the clock", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });
  // DEM-210: with held capture off it said nothing, so a session made while
  // it was on launched Chrome held (no smooth scroll) for a real-time run.
  it("asks a headless session for a real-clock browser when held capture is off", async () => {
    vi.stubEnv("DEMOMAN_HELD_CLOCK", "0");
    const asked: unknown[] = [];
    const deps = stagedOn(1, 1);
    Object.assign(deps.session, {
      headless: true,
      ensure: async (a: unknown) => {
        asked.push(a);
        return { ok: true };
      },
    });
    const out = await prepareStage(sized, deps);
    expect(out.ok, JSON.stringify(out)).toBe(true);
    expect(asked).toEqual([{ held: false }]);
  });
});

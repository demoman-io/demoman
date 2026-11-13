import type { AnchorIntent } from "@demoman/resolver";
import {
  BRANDING_DEFAULTS,
  type DemoScript,
  type SceneAction,
  type SceneAnchor,
} from "@demoman/scene-schema";
import { describe, expect, it, vi } from "vitest";
import type {
  AuthoredDeps,
  AuthoredResult,
  ClickSeen,
  EngineDeps,
  PageAgent,
  RoomPolicy,
} from "../../src/index.js";
import { runAuthored, STILL_DRAIN_MS } from "../../src/index.js";
import type { BeatRules } from "../../src/walk.js";
import { createCdpFake, fakeScreenshotBase64 } from "../helpers/cdp-fake";
import { createMemoryFrameStore } from "../helpers/frame-store";

/**
 * The beat plan (spec 2026-11-13 Part 3), through the real walk and the
 * authored door against the fake CDP session: the walk keeps a designed
 * clock, asks the room policy on it, writes `pacing`, and waits no room
 * out live.
 */

const PAGE = "https://app.example.com/";
/** The fake room's push-in: large, so a rest it raises is plainly raised
 *  and a gap that waited it is plainly longer than one that did not. */
const NEEDED_MS = 6000;
/** The fake room's pull-out after a zoom's hold. */
const PULL_OUT_MS = 5000;
const ARRIVE = 300;
const BASE = 700;
const OPENING = 800;

/** The pacing rule's shape (run-core's `beats.ts`), with numbers of its
 *  own: this package cannot import run-core. */
const restBefore = vi.fn<BeatRules["restBefore"]>(
  ({ first, pauseMs, roomMs, journeyMs }) =>
    Math.max((first ? OPENING : BASE) + pauseMs, roomMs - journeyMs - ARRIVE),
);
const RULES: BeatRules = {
  restBefore,
  actMs: (a: SceneAction) =>
    a.kind === "type" ? 250 + 100 * ((a.text ?? "").length - 1) : 0,
  tailMs: ({ zoomSettleMs, trimEndMs }) =>
    Math.max(1000, zoomSettleMs ?? 0, (zoomSettleMs ?? 0) + (trimEndMs ?? 0)),
  arriveMs: ARRIVE,
};

/**
 * A room policy that answers from the times it is handed, as the real one
 * does: a click zooms when its time is 2500 ms past the last zoom's (unless
 * `zoomsWhen` says, by the click's 0-based turn), pans when within 3000 ms
 * of the last zoom's hold, and a return needs `NEEDED_MS`.
 */
function roomPolicy(zoomsWhen: (turn: number) => boolean | null): {
  room: RoomPolicy;
  asked: { heldUntilMs: number | null }[];
} {
  const asked: { heldUntilMs: number | null }[] = [];
  let last: number | null = null;
  let turn = 0;
  const arrives: RoomPolicy["arrives"] = ({ heldUntilMs, clickMs }) =>
    heldUntilMs !== null && clickMs - heldUntilMs < 3000 ? "pan" : "return";
  return {
    asked,
    room: {
      arrives,
      neededMs: (gap) => {
        asked.push(gap);
        return arrives(gap) === "pan" ? 0 : NEEDED_MS;
      },
      settledAfterMs: (heldUntil) => heldUntil + PULL_OUT_MS,
      zooms: ({ unwaitedMs }) => {
        const z =
          zoomsWhen(turn++) ?? (last === null || unwaitedMs - last >= 2500);
        if (z) last = unwaitedMs;
        return z;
      },
    },
  };
}

const anchorFor = (intent: AnchorIntent): SceneAnchor => ({
  id: intent.id,
  fingerprint: {
    ...intent.fingerprint,
    boundingRect: { x: 10, y: 20, width: 100, height: 40 },
  },
  resolution: {
    url: PAGE,
    actionIndex: 0,
    entryState: false,
    strategy: "stableId",
    failureReason: null,
    candidates: 1,
  },
});

async function run(
  steps: DemoScript["steps"],
  opts: {
    /** Given: the walk plans. */
    beats?: BeatRules;
    /** Every page call (the capture round trip, the walk's resolve) takes
     *  this much longer on the clock: a slower machine. */
    lagMs?: number;
    /** By the click's turn: whether it zooms; null leaves it to the rule. */
    zooms?: (turn: number) => boolean | null;
    /** The third step's click is released elsewhere. */
    missThird?: boolean;
  } = {},
) {
  const cdp = createCdpFake();
  let clock = 0;
  const lag = async () => {
    clock += opts.lagMs ?? 0;
  };
  const slept: number[] = [];
  const send = cdp.send.bind(cdp);
  cdp.send = async (method, params) => {
    if (method === "Page.captureScreenshot") {
      for (let i = 0; i < 3; i++) {
        cdp.emit("Page.screencastFrame", {
          sessionId: 100 + i,
          data: fakeScreenshotBase64(),
          metadata: { deviceWidth: 1280, deviceHeight: 800 },
        });
      }
    }
    return send(method, params);
  };
  let n = 0;
  const page: PageAgent = {
    resolve: async (anchors) => {
      await lag();
      return anchors.map((a) => ({
        anchorId: a.id,
        strategy: "stableId" as const,
        resolved: true,
        failureReason: null,
      }));
    },
  };
  const { room, asked } = roomPolicy(opts.zooms ?? (() => null));
  const deps: AuthoredDeps = {
    cdp,
    page,
    encoder: {
      openSpan: vi.fn(),
      push: vi.fn(async () => undefined),
      closeSpan: vi.fn(async () => null),
      queueDepth: () => 0,
      heapFraction: () => 0.1,
    } as EngineDeps["encoder"],
    store: createMemoryFrameStore(),
    clock: {
      now: () => (clock += 10),
      sleep: async (ms: number) => {
        if (ms === STILL_DRAIN_MS) return new Promise<void>(() => undefined);
        slept.push(ms);
        clock += ms;
      },
    },
    mayReplay: true,
    recording: "continuous",
    ...(opts.beats === undefined ? {} : { beats: opts.beats }),
    onProgress: (p) => {
      if (opts.missThird === true && p.state === "running" && p.step === 2)
        cdp.click = MISSED;
    },
    // `stableId: "gone"` is an element the page does not have.
    captureResolved: async (intent) => {
      await lag();
      return intent.fingerprint.stableId === "gone"
        ? {
            anchor: null,
            failureReason: "unresolved",
            intentResolution: null,
            pageUrl: null,
          }
        : {
            anchor: anchorFor(intent),
            failureReason: null,
            intentResolution: {
              strategy: "stableId",
              candidates: 1,
              failureReason: null,
            },
            pageUrl: null,
          };
    },
    newId: (prefix) => `${prefix}-${++n}`,
    sceneId: "plan",
    createdAt: "2026-11-13T09:00:00.000Z",
    viewport: { width: 1280, height: 800 },
    startingBranding: BRANDING_DEFAULTS,
    roomFor: () => room,
    cameraFor: () => ({ camera: [], zoomsSkipped: [] }),
  };
  restBefore.mockClear();
  const result = await runAuthored(
    { scriptVersion: 8, name: "plan", target: PAGE, steps },
    deps,
  );
  // Each step's journey, as the walk handed it to the rule (the last ask
  // per step is the one its rest came from).
  const journeys = restBefore.mock.calls.map(([i]) => i.journeyMs);
  return { result, slept, asked, journeys };
}

/** Pressed where sent, released elsewhere: `clickNotDelivered`. */
const MISSED: ClickSeen = {
  own: { x: 10, y: 20, width: 100, height: 40 },
  viewport: { width: 1280, height: 800 },
  down: { x: 60, y: 40 },
  up: { x: 40, y: 26.67 },
  cancelled: false,
  focused: false,
};

const evidenceOf = (result: AuthoredResult): string =>
  JSON.stringify({
    outcome: result.outcome,
    reason: result.reason,
    pacing: result.pacing,
    decided: [...(result.decided ?? new Map())],
    markers: result.bundle?.markers,
  });

const markerOf = (result: AuthoredResult, index: number) => {
  const id = result.steps[index]?.actionId;
  const marker = result.bundle?.markers.find((m) => m.actionId === id);
  if (marker === undefined) throw new Error(evidenceOf(result));
  return marker;
};

const TYPE_A = { do: "type", into: { stableId: "a" }, text: "4800" } as const;
const click = (stableId: string) =>
  ({ do: "click", on: { stableId } }) as const;

describe("the walk plans its pauses", () => {
  // Red if `commitPlan` sets `designed` from the walk's clock (`at()`)
  // rather than `plan.markerMs + beats.actMs(action)`: the slowed walk's
  // designed times, and so its decisions, move with it.
  it("plans one script the same on a slower machine", async () => {
    const steps: DemoScript["steps"] = [
      TYPE_A,
      click("b"),
      click("c"),
      { do: "pause", ms: 1500 },
      click("d"),
      click("e"),
    ];
    const fast = await run(steps, { beats: RULES });
    const slow = await run(steps, { beats: RULES, lagMs: 300 });
    const evidence = `${evidenceOf(fast.result)} ${evidenceOf(slow.result)}`;
    expect(fast.result.outcome, evidence).toBe("complete");
    expect(slow.result.outcome, evidence).toBe("complete");
    // Premise: the slowed walk really ran slower, by more than 300 ms a step.
    const last = steps.length - 2; // the pause is not a step
    expect(
      markerOf(slow.result, last).sourceTimeMs -
        markerOf(fast.result, last).sourceTimeMs,
      evidence,
    ).toBeGreaterThan(300 * (last + 1));

    expect([...(slow.result.decided ?? [])], evidence).toEqual([
      ...(fast.result.decided ?? []),
    ]);
    expect(slow.result.pacing, evidence).toEqual(fast.result.pacing);

    // Premise, read once the two agree: the decisions had something to
    // decide — a click the camera zooms to and one it does not, a pan and a
    // return among the zooms — and a room raised a rest above the base.
    const decisions = [...(fast.result.decided ?? new Map()).values()];
    const arrives = decisions.map((d) => ("arrives" in d ? d.arrives : null));
    expect(arrives, evidence).toContain(null);
    expect(arrives, evidence).toContain("pan");
    expect(arrives, evidence).toContain("return");
    expect(
      fast.result.pacing?.beats.some((b) => b.restMs > BASE + 1500),
      evidence,
    ).toBe(true);
  });

  // Red if the zoomed click's planned branch (`zooms && dragPlan === null &&
  // beats !== undefined`) is removed: the walk then sleeps the room live
  // and writes `roomMs` again.
  it("plans a zoomed click's room into its rest and sleeps none of it", async () => {
    const steps = [TYPE_A, click("b")];
    const planned = await run(steps, { beats: RULES, zooms: () => true });
    const live = await run(steps, { zooms: () => true });
    const evidence = `${evidenceOf(planned.result)} ${evidenceOf(live.result)}`;
    expect(planned.result.outcome, evidence).toBe("complete");
    const typed = markerOf(planned.result, 0);
    const clicked = markerOf(planned.result, 1);
    const journey = planned.journeys.at(-1) ?? Number.NaN;
    // Premise: the room is more than the base rest would leave.
    expect(NEEDED_MS - journey - ARRIVE, evidence).toBeGreaterThan(BASE);
    const beat = planned.result.pacing?.beats[1];
    expect(beat?.beforeActionId, evidence).toBe(clicked.actionId);
    expect(beat?.restMs, evidence).toBeGreaterThanOrEqual(
      NEEDED_MS - journey - ARRIVE,
    );
    // Slept none of it: the click came sooner after the typing's end than
    // the room, which the same script without a plan did wait.
    expect(
      clicked.sourceTimeMs - (typed.actEndSourceTimeMs as number),
      evidence,
    ).toBeLessThan(NEEDED_MS);
    expect(clicked.roomMs, evidence).toBeUndefined();
    expect(clicked.roomHeldMs, evidence).toBeUndefined();
    const liveHeld = markerOf(live.result, 1).roomHeldMs;
    expect(liveHeld, evidence).toBeGreaterThan(0);
    expect(planned.slept, evidence).not.toContain(liveHeld);
  });

  // The control for the case above: without `beats` nothing changes.
  // Red if the live room sleep is skipped without a plan.
  it("without a plan writes no pacing and still waits the room out", async () => {
    const { result } = await run([TYPE_A, click("b")], {
      zooms: () => true,
    });
    const evidence = evidenceOf(result);
    expect(result.outcome, evidence).toBe("complete");
    expect(result.pacing, evidence).toBeUndefined();
    const typed = markerOf(result, 0);
    const clicked = markerOf(result, 1);
    expect(clicked.roomHeldMs, evidence).toBeGreaterThan(0);
    expect(
      clicked.sourceTimeMs - (typed.actEndSourceTimeMs as number),
      evidence,
    ).toBeGreaterThanOrEqual(NEEDED_MS);
    expect(
      [...(result.decided?.values() ?? [])].every((d) => "unwaitedMs" in d),
      evidence,
    ).toBe(true);
  });

  // Red if `paused += step.ms` is dropped from the authored source: the
  // pause is still slept, and the rest no longer counts it.
  it("adds a script's pause to the rest after it, and adds no room to a click that does not zoom", async () => {
    const { result } = await run(
      [click("a"), { do: "pause", ms: 2000 }, click("b"), click("c")],
      { beats: RULES, zooms: () => false },
    );
    const evidence = evidenceOf(result);
    expect(result.outcome, evidence).toBe("complete");
    expect(
      result.pacing?.beats.map((b) => [b.restMs, b.arriveMs]),
      evidence,
    ).toEqual([
      [OPENING, ARRIVE],
      [BASE + 2000, ARRIVE],
      [BASE, ARRIVE],
    ]);
  });

  // Red if `arrives` is asked of the live clock, or if a pan is given
  // room: the second click is within the first's hold on the designed clock.
  it("records a pan with no room, and a return with it", async () => {
    const { result } = await run([click("a"), click("b")], {
      beats: RULES,
      zooms: () => true,
    });
    const evidence = evidenceOf(result);
    const [first, second] = [0, 1].map((i) => markerOf(result, i).actionId);
    expect(result.decided?.get(first as string), evidence).toMatchObject({
      arrives: "return",
    });
    expect(result.decided?.get(second as string), evidence).toMatchObject({
      arrives: "pan",
    });
    expect(result.pacing?.beats[1]?.restMs, evidence).toBe(BASE);
  });

  // Ruling 3: every marker says where its cursor set off, at or after the
  // marker before it and at or before its own.
  // Red if `approachSourceTimeMs: pathFrom` is dropped from the marker.
  it("marks where each step's approach began", async () => {
    const { result } = await run(
      [TYPE_A, click("b"), { do: "press", key: "Enter" }],
      {
        beats: RULES,
      },
    );
    const evidence = evidenceOf(result);
    const markers = result.bundle?.markers ?? [];
    expect(markers, evidence).toHaveLength(3);
    let before = 0;
    for (const m of markers) {
      expect(m.approachSourceTimeMs, evidence).toBeGreaterThanOrEqual(before);
      expect(m.approachSourceTimeMs, evidence).toBeLessThanOrEqual(
        m.sourceTimeMs,
      );
      before = m.sourceTimeMs;
    }
  });
});

describe("a planned run that stops early", () => {
  // The third step's element is not on the page: the source stops before
  // the walk marks it. Red if the tail is not the last counted step's —
  // `commitPlan` setting `designed` from the walk's clock made it 7220.
  it("plans the steps it counted, when a step is never reached", async () => {
    const { result } = await run(
      [click("a"), click("b"), click("gone"), click("d")],
      { beats: RULES, zooms: () => true },
    );
    const evidence = evidenceOf(result);
    // Premise: it stopped at the third step, with two counted.
    expect(result.outcome, evidence).toBe("partial");
    expect(result.completed, evidence).toBe(2);
    expect(
      result.pacing?.beats.map((b) => b.beforeActionId),
      evidence,
    ).toEqual([markerOf(result, 0).actionId, markerOf(result, 1).actionId]);
    // The tail is the second step's: its zoom's hold (the lead-in, 350 ms
    // before its marker) plus the pull-out, from its designed act end.
    expect(result.pacing?.tailMs, evidence).toBe(PULL_OUT_MS - 350);
  });

  // The third click is marked, then its release lands elsewhere and the
  // walk takes the marker back. It does not zoom, so a plan that counted it
  // would move the designed act end on and shorten the tail.
  // Red if `plannedBeats.push` / `designed` moved to where the marker is
  // pushed (the taken-back step's beat stays, the tail shrinks).
  it("plans no beat for a step the walk marked and took back", async () => {
    const { result } = await run(
      [click("a"), click("b"), click("c"), click("d")],
      {
        beats: RULES,
        missThird: true,
        zooms: (turn) => turn < 2,
      },
    );
    const evidence = evidenceOf(result);
    // Premise: the third click was performed and taken back.
    expect(result.reason, evidence).toBe("clickNotDelivered");
    expect(result.bundle?.markers, evidence).toHaveLength(2);
    expect(result.pacing?.beats, evidence).toHaveLength(2);
    expect(result.pacing?.tailMs, evidence).toBe(PULL_OUT_MS - 350);
  });
});

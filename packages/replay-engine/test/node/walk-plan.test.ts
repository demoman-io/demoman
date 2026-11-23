import { readFileSync } from "node:fs";
import {
  CAMERA_DEFAULTS,
  cursorMotionSpans,
  motionTimings,
  planScene,
  resolvePlan,
  toOutputMs,
} from "@demoman/compositor";
import type { AnchorIntent } from "@demoman/resolver";
import {
  BRANDING_DEFAULTS,
  type DemoScript,
  MOTION_DEFAULTS,
  type SceneAction,
  type SceneAnchor,
  type SceneDocument,
} from "@demoman/scene-schema";
import { describe, expect, it, vi } from "vitest";
import { assembleAuthored } from "../../src/authored.js";
import type {
  AuthoredDeps,
  AuthoredResult,
  AuthoredStep,
  ClickSeen,
  EngineDeps,
  PageAgent,
  RoomPolicy,
} from "../../src/index.js";
import {
  runAuthored,
  SCROLL_MARKER,
  SETTLE_MS,
  STILL_DRAIN_MS,
  TAKE_TAIL_MS,
} from "../../src/index.js";
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
const JOURNEY_TAIL = 100;

/** The room left once the journey (less its eased-out end) and the arrive
 *  have given theirs, as run-core's `beats.ts` counts it. */
const roomLeft = (roomMs: number, journeyMs: number) =>
  roomMs - journeyMs - ARRIVE + (journeyMs > 0 ? JOURNEY_TAIL : 0);

/** The pacing rule's shape (run-core's `beats.ts`), with numbers of its
 *  own: this package cannot import run-core. */
const restBefore = vi.fn<BeatRules["restBefore"]>(
  ({ first, pauseMs, roomMs, journeyMs, returnShortMs }) =>
    Math.max(
      (first ? OPENING : BASE) + pauseMs,
      roomMs > 0 ? roomLeft(roomMs, journeyMs) : roomMs - journeyMs - ARRIVE,
    ) + (returnShortMs ?? 0),
);
const RULES: BeatRules = {
  restBefore,
  afterScroll: ({ zooms, roomMs, journeyMs, returnShortMs }) =>
    Math.max(ARRIVE, zooms ? roomLeft(roomMs, journeyMs) : 0) +
    (returnShortMs ?? 0),
  actMs: (a: SceneAction) =>
    a.kind === "type" ? 250 + 100 * ((a.text ?? "").length - 1) : 0,
  tailMs: ({ zoomSettleMs, trimEndMs, trimAfterAction, pauseMs }) =>
    Math.max(
      TAKE_TAIL_MS + pauseMs,
      zoomSettleMs ?? 0,
      (trimAfterAction ? 0 : (zoomSettleMs ?? 0)) + (trimEndMs ?? 0),
    ),
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
      // A return here is given `NEEDED_MS`, far past what one lacks; the
      // shortfall is asked of the real policy in run-core's walk-return test.
      returnShortMs: () => 0,
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
    /** The second step is a drag 300 px to the right, and lands. */
    dragSecond?: boolean;
    /** The script's trim. */
    trim?: DemoScript["trim"];
    /** The take's camera: `gapCamera`, or none. */
    camera?: AuthoredDeps["cameraFor"];
  } = {},
) {
  const cdp = createCdpFake();
  let clock = 0;
  const lag = async () => {
    clock += opts.lagMs ?? 0;
  };
  const slept: number[] = [];
  const scrolledAt: number[] = [];
  let belowFold = false;
  const send = cdp.send.bind(cdp);
  cdp.send = async (method, params) => {
    if (
      method === "Runtime.callFunctionOn" &&
      String(params?.functionDeclaration ?? "").includes(SCROLL_MARKER)
    ) {
      scrolledAt.push(clock);
      belowFold = false;
      return {
        result: { type: "object", value: { settled: true, movedPx: 2000 } },
      };
    }
    if (method === "DOM.getBoxModel" && belowFold) {
      const { model } = (await send(method, params)) as {
        model: { border: number[]; content: number[] };
      };
      const down = (q: number[]) =>
        q.map((v, i) => (i % 2 === 1 ? v + 2000 : v));
      return {
        model: { border: down(model.border), content: down(model.content) },
      };
    }
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
      // A drag is let go where it was sent: 300 px right of its press.
      if (opts.dragSecond === true && p.state === "running" && p.step === 1)
        cdp.click = { ...(cdp.click as ClickSeen), up: { x: 360, y: 40 } };
    },
    // `stableId: "gone"` is an element the page does not have.
    // `stableId: "far"` starts 2000 px below the fold, so its approach
    // scrolls, which `scrolledAt` times on the clock.
    captureResolved: async (intent) => {
      await lag();
      if (intent.fingerprint.stableId === "far") belowFold = true;
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
    cameraFor: opts.camera ?? (() => ({ camera: [], zoomsSkipped: [] })),
  };
  restBefore.mockClear();
  const result = await runAuthored(
    {
      scriptVersion: 8,
      name: "plan",
      target: PAGE,
      steps,
      ...(opts.trim === undefined ? {} : { trim: opts.trim }),
    },
    deps,
  );
  // Each step's journey, as the walk handed it to the rule (the last ask
  // per step is the one its rest came from).
  const journeys = restBefore.mock.calls.map(([i]) => i.journeyMs);
  return { result, slept, asked, journeys, scrolledAt };
}

/**
 * The take's camera, as `zoomsForClicks` decides it with the fake room's
 * numbers: a zoom on every click or drag 2500 ms or more past the last
 * zoomed one, judged on the stamps it is handed.
 */
const gapCamera: AuthoredDeps["cameraFor"] = (actions) => {
  const camera: SceneDocument["camera"] = [];
  let last: number | null = null;
  for (const a of actions) {
    if (a.kind !== "click" && a.kind !== "drag") continue;
    if (last !== null && a.timestamp - last < 2500) continue;
    last = a.timestamp;
    camera.push({
      id: `zoom-${camera.length + 1}`,
      kind: "zoom",
      anchorId: a.anchorId,
      marker: { actionId: a.id, offsetMs: -350 },
      scale: 1.8,
      source: "click",
    });
  }
  return { camera, zoomsSkipped: [] };
};

/** A script with a type, zoomed clicks, a pan, a return and a pause. */
const PLANNED_STEPS: DemoScript["steps"] = [
  { do: "type", into: { stableId: "a" }, text: "4800" },
  { do: "click", on: { stableId: "b" } },
  { do: "click", on: { stableId: "c" } },
  // 600: the click after it is 2600 ms past the zoomed one on the stamps
  // and inside its hold, a pan; the clicks 1000 ms after a zoom are skipped.
  { do: "pause", ms: 600 },
  { do: "click", on: { stableId: "d" } },
  { do: "click", on: { stableId: "e" } },
];

/** The script the golden take without a plan was written from: the pause
 *  its numbers were recorded with. */
const UNPLANNED_STEPS: DemoScript["steps"] = PLANNED_STEPS.map((s) =>
  s.do === "pause" ? { ...s, ms: 1500 } : s,
);

/** What a take's assembly writes that is a position or a decision. */
const positionsOf = (result: AuthoredResult) => ({
  trim: result.document?.edits.trim ?? null,
  camera: result.document?.camera ?? null,
  pacing: result.document?.pacing ?? null,
  stamps: result.document?.actions.map((a) => [a.id, a.timestamp]) ?? null,
  steps: result.steps.map((s) => ({
    index: s.index,
    actionId: s.actionId,
    timing: s.timing ?? null,
  })),
  trimClamped: result.trimClamped ?? null,
  trimUnplaced: result.trimUnplaced ?? null,
});

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
/** A drag of `b` 300 px right; run it with `dragSecond` as the second step. */
const DRAG_B = {
  do: "drag",
  from: { on: { stableId: "b" } },
  to: { by: { x: 300, y: 0 } },
} as never;

describe("the walk plans its pauses", () => {
  // Red if `commitPlan` sets `designed` from the walk's clock (`at()`)
  // rather than `plan.markerMs + beats.actMs(action)`: the slowed walk's
  // designed times, and so its decisions, move with it.
  it("plans one script the same on a slower machine", async () => {
    const steps: DemoScript["steps"] = [
      TYPE_A,
      click("b"),
      click("c"),
      // 600: the fourth click is 2600 ms past the zoomed second on the
      // stamps (the fake's rule zooms at 2500) and inside its hold's 3000,
      // so the camera pans to it.
      { do: "pause", ms: 600 },
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
    expect(liveHeld, evidence).toBeGreaterThan(SETTLE_MS);
    expect(live.slept, evidence).toContain(liveHeld);
    // What the plan slept is settles only: 50 ms quiet polls, the keys' gaps
    // and lead, and `SETTLE_MS` after each journey — no room.
    expect(Math.max(...planned.slept), evidence).toBeLessThanOrEqual(SETTLE_MS);
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

  // Code review, 2026-11-14. Red if the time a zoom is asked on keeps an
  // earlier step's room (`designedRoom`): the third click would read as
  // `NEEDED_MS` further from the second than it is, and zoom.
  it("asks whether a click zooms with every earlier room taken out", async () => {
    const { result, journeys } = await run([TYPE_A, click("b"), click("c")], {
      beats: RULES,
    });
    const evidence = evidenceOf(result);
    expect(result.outcome, evidence).toBe("complete");
    const [second, third] = [1, 2].map(
      (i) => markerOf(result, i).actionId as string,
    ) as [string, string];
    const journey = journeys.at(-1) ?? Number.NaN;
    // Premise: the second click zoomed and was given room well past the
    // gap rule's 2500 ms, so room left in would carry the third over it.
    expect(result.decided?.get(second), evidence).toMatchObject({
      arrives: "return",
    });
    const room = (result.pacing?.beats[1]?.restMs ?? 0) - BASE;
    expect(room, evidence).toBeGreaterThan(2500);
    const stamp = (id: string) => {
      const d = result.decided?.get(id);
      return d !== undefined && "designedMs" in d ? d.designedMs : Number.NaN;
    };
    expect(stamp(third) - stamp(second), evidence).toBe(
      BASE + journey + ARRIVE,
    );
    expect(result.decided?.get(third), evidence).not.toHaveProperty("arrives");
    expect(result.pacing?.beats[2]?.restMs, evidence).toBe(BASE);
  });

  // Code review, 2026-11-14. Red if only a click's arrival is recorded:
  // the renderer would decide a drag's pan-or-return from the rendered gap.
  it("records how the camera arrives at a zoomed drag", async () => {
    const { result } = await run([click("a"), DRAG_B], {
      beats: RULES,
      zooms: () => true,
      dragSecond: true,
    });
    const evidence = evidenceOf(result);
    expect(result.outcome, evidence).toBe("complete");
    const dragged = markerOf(result, 1).actionId as string;
    // Within the first zoom's hold on the designed clock: a pan, no room.
    expect(result.decided?.get(dragged), evidence).toMatchObject({
      arrives: "pan",
    });
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

describe("a planned take's closing pause", () => {
  // Red if the walk's tail drops the pause after the last counted step
  // (`pauseMs: pausedSinceCounted + (source.closingPauseMs?.() ?? 0)` to 0):
  // the tail is then TAKE_TAIL_MS alone.
  it("adds a pause after the last step to the planned tail, and still sleeps it", async () => {
    const { result, slept } = await run(
      [click("a"), { do: "pause", ms: 2000 }],
      { beats: RULES, zooms: () => false },
    );
    const evidence = evidenceOf(result);
    expect(result.outcome, evidence).toBe("complete");
    // Premise: the pause was slept live, and nothing zoomed to lengthen the
    // tail on its own.
    expect(slept, evidence).toContain(2000);
    expect(
      [...(result.decided?.values() ?? [])].some((d) => "arrives" in d),
      evidence,
    ).toBe(false);
    expect(result.pacing?.tailMs, evidence).toBeGreaterThanOrEqual(
      2000 + TAKE_TAIL_MS,
    );
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

describe("a take assembled without a plan", () => {
  // `test/fixtures/authored-no-pacing.json` was written by this same
  // assembly at 85287998, before the plan reached the take. Red on any
  // change to how a take without `pacing` writes its trim, held zoom,
  // camera or step timings (e.g. `placeOnPlan` run on every take).
  it("writes what it wrote before the plan, trim and held zoom included", async () => {
    const zoomOut = await run(UNPLANNED_STEPS, {
      camera: gapCamera,
      trim: { start: { ms: 400 }, end: { ms: 3000 } },
    });
    const action = await run(UNPLANNED_STEPS, {
      camera: gapCamera,
      trim: { start: { ms: 100000 }, end: { ms: 3000, after: "action" } },
    });
    const stored = JSON.parse(
      readFileSync(
        new URL("../fixtures/authored-no-pacing.json", import.meta.url),
        "utf8",
      ),
    );
    // Premise: the fixture has a trim on both sides, a held zoom, a clamp
    // and two zooms, so each conversion had something to move.
    expect(stored.zoomOut.trim.tail.offsetMs).toBeGreaterThan(0);
    expect(stored.action.camera.some((c: { end?: unknown }) => c.end)).toBe(
      true,
    );
    expect(stored.action.trimClamped).not.toBeNull();
    expect(stored.zoomOut.camera).toHaveLength(2);
    expect(zoomOut.result.pacing).toBeUndefined();
    expect(
      JSON.parse(
        JSON.stringify({
          zoomOut: positionsOf(zoomOut.result),
          action: positionsOf(action.result),
        }),
      ),
    ).toEqual(stored);
  });
});

/** The page's response after a step: a motion span this long, 50 ms after
 *  the step's marker, by step index (pauses excluded). The same on any
 *  machine, as motion is meant to be. */
const RESPONSE_MS: Record<number, number> = { 0: 400, 1: 250, 4: 300 };

/**
 * `result`'s take assembled again, as `runAuthored` assembled it, from a
 * bundle carrying `RESPONSE_MS` as motion: the fake page paints nothing,
 * so without this every step's motion would be 0 and the finish's motion
 * sum would never be exercised.
 */
function withResponse(
  result: AuthoredResult,
  trim: DemoScript["trim"],
  settledAfterMs = (heldUntilMs: number) => heldUntilMs + PULL_OUT_MS,
) {
  const bundle = result.bundle;
  const document = result.document;
  if (bundle === null || document === null) throw new Error(evidenceOf(result));
  const spans = Object.entries(RESPONSE_MS).map(([i, ms]) => {
    const at = markerOf(result, Number(i)).sourceTimeMs + 50;
    return {
      startMs: at,
      endMs: at + ms,
      ref: `response-${i}`,
      width: 1280,
      height: 800,
      fps: 30,
      byteLength: 0,
    };
  });
  const steps: AuthoredStep[] = result.steps.map(
    ({ outputTiming: _, ...step }) => step,
  );
  const walked = {
    ...result,
    bundle: { ...bundle, motionSpans: [...bundle.motionSpans, ...spans] },
  };
  const assembled = assembleAuthored(
    {
      scriptVersion: 8,
      name: "plan",
      target: PAGE,
      steps: UNPLANNED_STEPS,
      trim,
    },
    {
      sceneId: "plan",
      createdAt: "2026-11-13T09:00:00.000Z",
      viewport: { width: 1280, height: 800 },
      actions: document.actions,
      anchors: document.anchors,
      walked,
      startingBranding: BRANDING_DEFAULTS,
      camera: {
        camera: document.camera.map(({ end: _, ...zoom }) => zoom),
        zoomsSkipped: [],
      },
      steps,
      settledAfterMs,
    },
  );
  return { ...walked, ...assembled, steps };
}

/** Source ms of motion (spans and the cursor's travel) inside each
 *  performed step, `[marker, marker + finishMs]`. */
const motionInSteps = (result: ReturnType<typeof withResponse>) => {
  const bundle = result.bundle;
  const moving = [
    ...(bundle?.motionSpans ?? []),
    ...cursorMotionSpans(bundle?.cursorSamples ?? []),
  ];
  return result.steps.map((step) => {
    const t = step.timing;
    if (t === undefined) return null;
    return moving.reduce(
      (sum, m) =>
        sum +
        Math.max(
          0,
          Math.min(m.endMs, t.markerMs + t.finishMs) -
            Math.max(m.startMs, t.markerMs),
        ),
      0,
    );
  });
};

const positionsOnPlan = (
  result: ReturnType<typeof withResponse>,
): Record<string, unknown> => ({
  trim: result.document?.edits.trim ?? null,
  camera: result.document?.camera ?? null,
  pacing: result.document?.pacing ?? null,
  outputTiming: result.steps.map((s) => s.outputTiming ?? null),
  trimClamped: result.trimClamped ?? null,
  trimUnplaced: result.trimUnplaced ?? null,
});

describe("a planned take is written in output time", () => {
  for (const after of ["zoomOut", "action"] as const) {
    // Red if `trimFromScript` reads the walk's source `timing` rather than
    // the step's `outputTiming` (`timing: planned ?? timing` to `timing`),
    // or if a step's finish is `out(marker + finishMs) - out(marker)`
    // rather than its motion: the slowed take's tail, held end and skeleton
    // timings then move with its slower recording (each seen red at the
    // `trim.tail` line). Also red if `cameraInputs` leaves a designed
    // decision's action on its marker stamp, or `runAuthored` drops
    // `arrives` from the zooms (seen red at the `arrives` line).
    it(`writes one script's trim (after ${after}), camera and step timings alike on a slower machine`, async () => {
      const trim = {
        start: { ms: 400 },
        end: { ms: 3000, ...(after === "action" ? { after } : {}) },
      } as const;
      const recorded = await Promise.all(
        [0, 300].map((lagMs) =>
          run(PLANNED_STEPS, { beats: RULES, camera: gapCamera, trim, lagMs }),
        ),
      );
      const [fastRun, slowRun] = recorded.map((r) => r.result) as [
        AuthoredResult,
        AuthoredResult,
      ];
      const fast = withResponse(fastRun, trim);
      const slow = withResponse(slowRun, trim);
      const evidence = `${JSON.stringify(positionsOnPlan(fast))} ${JSON.stringify(positionsOnPlan(slow))} ${evidenceOf(slowRun)}`;
      expect(fast.outcome, evidence).toBe("complete");
      expect(slow.outcome, evidence).toBe("complete");
      // Premise: the slowed recording's markers sit more than a second
      // later, while the motion inside each step is the same, and some.
      const last = PLANNED_STEPS.length - 2;
      expect(
        markerOf(slowRun, last).sourceTimeMs -
          markerOf(fastRun, last).sourceTimeMs,
        evidence,
      ).toBeGreaterThan(1000);
      expect(motionInSteps(slow), evidence).toEqual(motionInSteps(fast));
      expect(motionInSteps(fast).slice(0, 2), evidence).toEqual([400, 250]);
      // Premise: a trim on both sides, two zooms (a return and a pan), and,
      // after the action, a zoom held through the cut.
      const positions = positionsOnPlan(fast);
      const camera = fast.document?.camera ?? [];
      expect(fast.document?.edits.trim?.head, evidence).toBeDefined();
      expect(fast.document?.edits.trim?.tail, evidence).toBeDefined();
      expect(
        camera.map((c) => c.arrives),
        evidence,
      ).toEqual(["return", "pan"]);
      expect(
        camera.some((c) => c.end !== undefined),
        evidence,
      ).toBe(after === "action");
      // The camera `runAuthored` wrote is the same on both.
      expect(slowRun.document?.camera, evidence).toEqual(
        fastRun.document?.camera,
      );
      expect(positionsOnPlan(slow), evidence).toEqual(positions);
      // The skeleton's finish is the step's motion: the type's response.
      expect(fast.steps[0]?.outputTiming?.finishMs, evidence).toBe(400);
    });
  }

  // Review Focus 5. The output after the last marker is its motion plus
  // `tailMs` of idle, and `tailMs` covers the end trim (and the zoom's
  // settle, unless `after: "action"`), so the end is placed.
  // Red if a step's finish is its whole proportional share of the tail
  // (`finishMs: finishAt - at` in `placeOnPlan`), or if the trim is read
  // from source time (`timing: planned ?? timing` to `timing`): seen red at
  // the `trimUnplaced` line.
  for (const after of ["zoomOut", "action"] as const) {
    it(`places a trim.end of 3000 ms on the last step (after ${after}), inside the planned tail`, async () => {
      const trim = {
        end: { ms: 3000, ...(after === "action" ? { after } : {}) },
      } as const;
      const { result } = await run(PLANNED_STEPS, {
        beats: RULES,
        camera: gapCamera,
        trim,
      });
      const taken = withResponse(result, trim);
      const evidence = `${JSON.stringify(positionsOnPlan(taken))} ${evidenceOf(result)}`;
      const document = taken.document;
      if (document === null || taken.bundle === null) throw new Error(evidence);
      const lastStep = taken.steps.at(-1);
      // Premise: the last step's walk finish is long, and mostly waiting.
      expect(lastStep?.timing?.finishMs, evidence).toBeGreaterThan(2000);
      expect(taken.pacing?.tailMs, evidence).toBeGreaterThanOrEqual(3000);
      expect(taken.trimUnplaced, evidence).toBeUndefined();
      const tail = document.edits.trim?.tail;
      expect(tail?.actionId, evidence).toBe(lastStep?.actionId);
      const { timeline } = resolvePlan(
        planScene(document),
        taken.bundle,
        document,
      );
      // A refilm reads the asked `ms` back as the tail less the skeleton's
      // finish or zoom-out (run-core's `merge.ts`), both on one clock now.
      const t = lastStep?.outputTiming;
      const base =
        after === "action" || t?.zoomOutMs == null
          ? t?.finishMs
          : Math.max(t.finishMs, t.zoomOutMs);
      expect(
        (tail?.offsetMs ?? Number.NaN) - (base ?? Number.NaN),
        evidence,
      ).toBe(3000);
      const markerAt = lastStep?.outputTiming?.markerMs ?? Number.NaN;
      expect(
        markerAt + (tail?.offsetMs ?? Number.NaN),
        evidence,
      ).toBeLessThanOrEqual(timeline.outputDurationMs);
    });
  }
});

describe("a planned take that cannot hold its zoom through the cut", () => {
  // Red if `trimFromScript` drops the hold silently on a planned take
  // (`else if (at.planned) heldUnplaced = true` removed).
  it("says so, and still places the end", async () => {
    const trim = { end: { ms: 3000, after: "action" } } as const;
    const { result } = await run(PLANNED_STEPS, {
      beats: RULES,
      camera: gapCamera,
      trim,
    });
    // A tail planned without the held landing (as before the walk planned
    // it): the end fits, the landing 1150 ms after it does not.
    const short = withResponse(
      {
        ...result,
        ...(result.pacing === undefined
          ? {}
          : { pacing: { ...result.pacing, tailMs: 3000 } }),
      },
      trim,
    );
    const evidence = `${JSON.stringify(positionsOnPlan(short))} ${evidenceOf(result)}`;
    // Premise: the planned take as recorded does hold it.
    expect(
      withResponse(result, trim).document?.camera.some((c) => c.end),
      evidence,
    ).toBe(true);
    expect(short.document?.edits.trim?.tail, evidence).toBeDefined();
    expect(
      short.document?.camera.some((c) => c.end),
      evidence,
    ).toBe(false);
    expect(short.trimHeldUnplaced, evidence).toBe(true);
  });
});

describe("a planned take whose steps cannot be placed on its video", () => {
  // Final review, Minor 1. Red if `assembleAuthored` lets `placeOnPlan`'s
  // throw out (the try around it goes): the whole take, frames and all, is
  // lost to the throw. Also red if a step keeps an `outputTiming` set
  // before the throw, which would stand in for video ms it never was.
  it("keeps the take without the trim and held zoom, and says why", async () => {
    const trim = {
      start: { ms: 400 },
      end: { ms: 3000, after: "action" },
    } as const;
    const { result } = await run(PLANNED_STEPS, {
      beats: RULES,
      camera: gapCamera,
      trim,
    });
    const evidence = evidenceOf(result);
    // Premise: assembled whole, the take has a trim on both sides, a held
    // zoom and the steps' video times, so each had something to lose.
    const whole = withResponse(result, trim);
    expect(whole.document?.edits.trim?.head, evidence).toBeDefined();
    expect(whole.document?.edits.trim?.tail, evidence).toBeDefined();
    expect(
      whole.document?.camera.some((c) => c.end !== undefined),
      evidence,
    ).toBe(true);
    expect(
      whole.steps.some((s) => s.outputTiming !== undefined),
      evidence,
    ).toBe(true);
    // The room policy is asked inside the placement, after earlier steps
    // were placed: a throw there is a throw from `placeOnPlan`.
    let asked = 0;
    const failed = withResponse(result, trim, () => {
      if (++asked > 1) throw new Error("the injected settle failed");
      return 0;
    });
    expect(asked, evidence).toBeGreaterThan(1); // premise: it threw mid-way
    expect(failed.document, evidence).not.toBeNull();
    expect(failed.error, evidence).toBeNull();
    expect(failed.trimPlanFailed, evidence).toBe("the injected settle failed");
    expect(failed.document?.edits.trim, evidence).toBeUndefined();
    expect(
      failed.document?.camera.some((c) => c.end !== undefined),
      evidence,
    ).toBe(false);
    expect(
      failed.steps.filter((s) => s.outputTiming !== undefined),
      evidence,
    ).toEqual([]);
    expect(failed.trimUnplaced, evidence).toBeUndefined();
  });
});

describe("a planned tail with a zoom held through the cut", () => {
  // DEM-178 on a planned take: the zoom held through an `after: "action"`
  // cut lands `motionTimings(1).zoomOutMs` after it, and the tail plays
  // through that and a settle. Red if `plannedHeldEnd() - designed` is
  // dropped from `pacing.tailMs` (walk.ts): the tail is then the trim alone.
  it("plays the tail through the held zoom's landing", async () => {
    const { result } = await run([click("a")], {
      beats: RULES,
      zooms: () => true,
      trim: { end: { ms: 6000, after: "action" } },
    });
    const evidence = evidenceOf(result);
    // Premise: the click zoomed, so a zoom is held, and the trim outlasts
    // the zoom's own hold, so the cut needs it held.
    const id = markerOf(result, 0).actionId;
    expect(result.decided?.get(id), evidence).toMatchObject({
      arrives: "return",
    });
    expect(6000, evidence).toBeGreaterThan(
      CAMERA_DEFAULTS.leadInMs + CAMERA_DEFAULTS.neutral.zoomHoldMs,
    );
    expect(result.pacing?.tailMs, evidence).toBe(
      6000 + motionTimings(1).zoomOutMs + SETTLE_MS,
    );
  });
});

describe("a planned zoomed click the walk scrolled to", () => {
  // Review 6c: the approach scroll sits between the planned rest and the
  // journey (the walk sets off after it), so the camera keeps the room the
  // plan gave it on the rendered timeline, from the act before. The scroll
  // and the typing are given motion here, as real ones paint. Red if the
  // planned room is not after the scroll (walk.ts's zoomed
  // `beats.afterScroll({ zooms: true, … })` to `zooms: false`). The
  // same without any motion, and the room after the scroll's end, are the
  // cases of "the rest sits where the camera needs it" below.
  it("leaves the camera its room on the rendered timeline", async () => {
    const { result, scrolledAt } = await run([TYPE_A, click("far")], {
      beats: RULES,
      camera: gapCamera,
    });
    const evidence = `${evidenceOf(result)} scrolled ${scrolledAt}`;
    const typed = markerOf(result, 0);
    const clicked = markerOf(result, 1);
    // Premise: the click zoomed, from full frame, and its approach scrolled
    // between the typing's end and where the cursor set off.
    expect(
      result.document?.camera.map((c) => c.arrives),
      evidence,
    ).toEqual(["return"]);
    // (The type's own approach asks for a scroll too, before its marker.)
    const scrollAt =
      scrolledAt.find((t) => t > (typed.actEndSourceTimeMs as number)) ??
      Number.NaN;
    expect(scrollAt, evidence).toBeLessThan(
      clicked.approachSourceTimeMs as number,
    );
    const bundle = result.bundle;
    const document = result.document;
    if (bundle === null || document === null) throw new Error(evidence);
    // The typing painted through its act end, as a real field does: the
    // fake page paints nothing, and an act's idle takes a share of the rest
    // after it (the shortcut in `placeOnPlan`), which is not this case.
    const span = (startMs: number, endMs: number, ref: string) => ({
      startMs,
      endMs,
      ref,
      width: 1280,
      height: 800,
      fps: 30,
      byteLength: 0,
    });
    const scrolled = {
      ...bundle,
      motionSpans: [
        ...bundle.motionSpans,
        span(typed.sourceTimeMs, typed.actEndSourceTimeMs as number, "typing"),
        {
          startMs: scrollAt,
          endMs: Math.min(
            scrollAt + 600,
            clicked.approachSourceTimeMs as number,
          ),
          ref: "scroll",
          width: 1280,
          height: 800,
          fps: 30,
          byteLength: 0,
        },
      ],
    };
    const { timeline } = resolvePlan(planScene(document), scrolled, document);
    const out = (ms: number) => toOutputMs(timeline, ms);
    expect(
      out(clicked.sourceTimeMs) - out(typed.actEndSourceTimeMs as number),
      evidence,
    ).toBeGreaterThanOrEqual(NEEDED_MS);
  });
});

/** The take's rendered timeline, on the fake's own bundle (which paints
 *  nothing: every act's span is idle). */
const renderedOf = (result: AuthoredResult) => {
  const { bundle, document } = result;
  if (bundle === null || document === null) throw new Error(evidenceOf(result));
  const { timeline } = resolvePlan(planScene(document), bundle, document);
  return (sourceMs: number) => toOutputMs(timeline, sourceMs);
};

describe("the rest sits where the camera needs it", () => {
  // Sublime, 2026-11-23: a drag 1.27 s after an Enter got a 0.5 s push-in
  // of 1.3 s. The walk planned room before a zoomed click only, so a zoomed
  // drag rested the base and `solveCamera` cut its push-in to the gap. Red
  // if the planned branch is a click's again (`zooms && dragPlan === null
  // && beats !== undefined`).
  it("leaves a zoomed drag after a typed step its room, and the camera its whole push-in", async () => {
    const { result } = await run([TYPE_A, DRAG_B], {
      beats: RULES,
      camera: gapCamera,
      dragSecond: true,
    });
    const evidence = evidenceOf(result);
    expect(result.outcome, evidence).toBe("complete");
    const typed = markerOf(result, 0);
    const dragged = markerOf(result, 1);
    // Premise: the drag zoomed from full frame, the only zoom in the take.
    expect(
      result.document?.camera.map((c) => [c.marker.actionId, c.arrives]),
      evidence,
    ).toEqual([[dragged.actionId, "return"]]);
    const out = renderedOf(result);
    const actEnd = typed.actEndSourceTimeMs ?? Number.NaN;
    expect(
      out(dragged.sourceTimeMs) - out(actEnd),
      evidence,
    ).toBeGreaterThanOrEqual(NEEDED_MS);
    // The picture's side: the push-in that lands before the press is the
    // whole `zoomInMs`, not what a short gap left of it.
    const { bundle, document } = result;
    if (bundle === null || document === null) throw new Error(evidence);
    const { cameraKeys } = resolvePlan(planScene(document), bundle, document);
    const pushIn = cameraKeys.find((k) => k.scale > 1);
    expect(pushIn?.outputTimeMs, evidence).toBeCloseTo(
      out(dragged.sourceTimeMs) + CAMERA_DEFAULTS.leadInMs,
    );
    expect(pushIn?.transitionMs, evidence).toBe(
      motionTimings((document.motion ?? MOTION_DEFAULTS).smoothness).zoomInMs,
    );
  });

  // The same without a plan: the walk waits the room out before the press.
  // Red if the live branch is a click's again (`zooms && dragPlan === null`).
  it("without a plan waits a zoomed drag's room out", async () => {
    const { result } = await run([TYPE_A, DRAG_B], {
      zooms: () => true,
      dragSecond: true,
      camera: gapCamera,
    });
    const evidence = evidenceOf(result);
    expect(result.outcome, evidence).toBe("complete");
    const typed = markerOf(result, 0);
    const dragged = markerOf(result, 1);
    // The camera, deciding again on the stamps with the room taken out,
    // zooms the drag the walk waited for: a wait with no push-in after it
    // would be a hold for nothing.
    expect(
      result.document?.camera.map((c) => c.marker.actionId),
      evidence,
    ).toEqual([dragged.actionId]);
    expect(dragged.roomHeldMs, evidence).toBeGreaterThan(0);
    expect(
      dragged.sourceTimeMs - (typed.actEndSourceTimeMs as number),
      evidence,
    ).toBeGreaterThanOrEqual(NEEDED_MS);
  });

  // Task 7 measured 2600 ms here against 6000: the typing's own idle took
  // a share of the rest planned after it. Red if the compositor's rest
  // starts at the previous marker again (`plannedIdleOf`'s
  // `share(afterAct(prev, restEnd), …)` to `share(prev.sourceTimeMs, …)`).
  it("leaves a zoomed click after a typed step its room from the act's end", async () => {
    const { result } = await run([TYPE_A, click("b")], {
      beats: RULES,
      camera: gapCamera,
    });
    const evidence = evidenceOf(result);
    const typed = markerOf(result, 0);
    const clicked = markerOf(result, 1);
    // Premise: the click zoomed from full frame, and the typing's act holds
    // idle of its own (the fake page paints nothing), which is what took
    // the share; no scroll is involved.
    expect(
      result.document?.camera.map((c) => c.arrives),
      evidence,
    ).toEqual(["return"]);
    const actEnd = typed.actEndSourceTimeMs ?? Number.NaN;
    expect(actEnd - typed.sourceTimeMs, evidence).toBeGreaterThan(0);
    expect(clicked.scrollEndSourceTimeMs, evidence).toBeUndefined();
    const out = renderedOf(result);
    expect(
      out(clicked.sourceTimeMs) - out(actEnd),
      evidence,
    ).toBeGreaterThanOrEqual(NEEDED_MS);
  });

  // Task 7 measured 1510 ms after the scroll against 2050 on the executor:
  // the room was in the rest, before the scroll. Red if the walk leaves the
  // room out of `afterScrollMs` (walk.ts's zoomed `beats.afterScroll({
  // zooms: true, … })` to `zooms: false`), or the compositor drops the
  // scroll's stretch.
  it("gives a zoomed click reached by a scroll its room after the scroll", async () => {
    const { result, journeys } = await run([TYPE_A, click("far")], {
      beats: RULES,
      camera: gapCamera,
    });
    const evidence = evidenceOf(result);
    const typed = markerOf(result, 0);
    const clicked = markerOf(result, 1);
    const scrollEnd = clicked.scrollEndSourceTimeMs ?? Number.NaN;
    // Premise: the click zoomed from full frame, and its approach scrolled
    // after the typing's act and before the cursor set off.
    expect(
      result.document?.camera.map((c) => c.arrives),
      evidence,
    ).toEqual(["return"]);
    expect(scrollEnd, evidence).toBeGreaterThanOrEqual(
      typed.actEndSourceTimeMs ?? Number.NaN,
    );
    expect(scrollEnd, evidence).toBeLessThanOrEqual(
      clicked.approachSourceTimeMs ?? Number.NaN,
    );
    const journey = journeys.at(-1) ?? Number.NaN;
    expect(NEEDED_MS - journey - ARRIVE, evidence).toBeGreaterThan(ARRIVE);

    const beat = result.pacing?.beats[1];
    expect(beat?.beforeActionId, evidence).toBe(clicked.actionId);
    expect(beat?.afterScrollMs, evidence).toBeGreaterThanOrEqual(
      NEEDED_MS - journey - ARRIVE,
    );
    // The rest before the scroll keeps its base: the room is after it.
    expect(beat?.restMs, evidence).toBe(BASE);
    const out = renderedOf(result);
    expect(
      out(clicked.sourceTimeMs) - out(scrollEnd),
      evidence,
    ).toBeGreaterThanOrEqual(NEEDED_MS);
  });

  // Red if a scrolled-to step's after-scroll rest is not an arrive's worth
  // (walk.ts's first `beats.afterScroll({ zooms: false, … })` to `0`), or
  // a step that did
  // not scroll writes one (`...(scrolledTo ? { afterScrollMs } : {})`).
  it("rests an arrive's worth after the scroll before a step that does not zoom", async () => {
    const { result } = await run([TYPE_A, click("far")], {
      beats: RULES,
      zooms: () => false,
    });
    const evidence = evidenceOf(result);
    // Premise: the click scrolled and did not zoom; the typing did not
    // scroll.
    expect(markerOf(result, 1).scrollEndSourceTimeMs, evidence).toBeDefined();
    expect(markerOf(result, 0).scrollEndSourceTimeMs, evidence).toBeUndefined();
    expect(
      result.decided?.get(markerOf(result, 1).actionId),
      evidence,
    ).not.toHaveProperty("arrives");
    expect(result.pacing?.beats, evidence).toEqual([
      {
        beforeActionId: markerOf(result, 0).actionId,
        restMs: OPENING,
        arriveMs: ARRIVE,
      },
      {
        beforeActionId: markerOf(result, 1).actionId,
        restMs: BASE,
        arriveMs: ARRIVE,
        afterScrollMs: ARRIVE,
      },
    ]);
  });

  // Code review, 2026-11-23. Red if the scroll's wait is a click's alone
  // again (`unhurriedScroll`'s `step.action.kind === "click"`): a drag's
  // room is then counted from the typing's end, before the scroll, and the
  // push-in starts while the page is still moving.
  it("without a plan waits a scrolled zoomed drag's room from the scroll's end", async () => {
    const { result } = await run(
      [
        TYPE_A,
        {
          do: "drag",
          from: { on: { stableId: "far" } },
          to: { by: { x: 300, y: 0 } },
        } as never,
      ],
      { zooms: () => true, dragSecond: true },
    );
    const evidence = evidenceOf(result);
    expect(result.outcome, evidence).toBe("complete");
    const typed = markerOf(result, 0);
    const dragged = markerOf(result, 1);
    // Premise: the drag's approach scrolled, after the typing had ended.
    const scrollEnd = dragged.scrollEndSourceTimeMs ?? Number.NaN;
    expect(scrollEnd, evidence).toBeGreaterThan(
      typed.actEndSourceTimeMs ?? Number.NaN,
    );
    expect(dragged.sourceTimeMs - scrollEnd, evidence).toBeGreaterThanOrEqual(
      NEEDED_MS,
    );
  });

  // Red if the marker's scroll end is written only under a plan
  // (`continuous && scrolls` to `beats !== undefined && scrolls`), or if
  // the walk without a plan writes any planned number.
  it("without a plan marks where the scroll ended and plans nothing", async () => {
    const { result } = await run([TYPE_A, click("far")], {
      camera: gapCamera,
    });
    const evidence = evidenceOf(result);
    expect(result.outcome, evidence).toBe("complete");
    expect(result.pacing, evidence).toBeUndefined();
    expect(result.document?.pacing, evidence).toBeUndefined();
    const typed = markerOf(result, 0);
    const clicked = markerOf(result, 1);
    expect(typed.scrollEndSourceTimeMs, evidence).toBeUndefined();
    expect(clicked.scrollEndSourceTimeMs, evidence).toBeGreaterThanOrEqual(
      typed.actEndSourceTimeMs ?? Number.NaN,
    );
    expect(clicked.scrollEndSourceTimeMs, evidence).toBeLessThanOrEqual(
      clicked.approachSourceTimeMs ?? Number.NaN,
    );
    // The live room is still waited out, and the marker carries nothing
    // new beside the scroll's end.
    expect(clicked.roomMs, evidence).toBeGreaterThan(0);
    expect(Object.keys(clicked).sort(), evidence).toEqual([
      "actEndSourceTimeMs",
      "actionId",
      "approachSourceTimeMs",
      "roomHeldMs",
      "roomMs",
      "scrollEndSourceTimeMs",
      "sourceTimeMs",
    ]);
  });
});

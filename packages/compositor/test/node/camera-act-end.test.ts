import { describe, expect, it } from "vitest";
import { validateBundle } from "../../src/index.js";
import {
  CAMERA_DEFAULTS,
  MIN_PAN_MS,
  returnsBetween,
  solveCamera,
} from "../../src/plan/camera";
import { planScene } from "../../src/plan/plan";
import { resolvePlan } from "../../src/plan/resolve";
import type { Timeline } from "../../src/plan/timeline";
import type { CameraIntent } from "../../src/plan/types";
import { proceduralBundle } from "../fixtures/bundle";
import { removedFor, sceneWithZoomOnClick } from "../fixtures/scene";

// The site's hero (2026-10-19): a type at 9411 whose last key painted at
// 10080, then a zoomed click at 11245. The zoom lands 350 ms before the
// click after a 1300 ms push-in, so it set off at 9595, while "4800" was
// still going in. Spec: docs/superpowers/specs/2026-10-19-unhurried-beats-design.md.

// Output time is source time: an identity map keeps every number here
// readable as milliseconds.
const timeline: Timeline = {
  segments: [
    {
      outStartMs: 0,
      outEndMs: 20_000,
      srcStartMs: 0,
      srcEndMs: 20_000,
      kind: "motion",
    },
  ],
  outputDurationMs: 20_000,
  sourceDurationMs: 20_000,
  unplacedPaces: 0,
  nonMonotonicPaces: 0,
  cuts: [],
  unplacedCuts: [],
  interruptions: [],
};
const viewport = { width: 1280, height: 800 };
const rectOf = () => ({ x: 980, y: 620, width: 160, height: 44 });
const { actSettleMs, leadInMs } = CAMERA_DEFAULTS;

const zoomOn = (id: string, actionId: string): CameraIntent => ({
  id,
  kind: "zoom",
  anchorId: "an",
  point: null,
  actionId,
  offsetMs: leadInMs,
  scale: 1.8,
  end: null,
});

const markers = new Map([
  ["first-click", 3144],
  ["type", 9411],
  ["click", 11245],
  ["after", 12000],
]);

const solve = (intents: CameraIntent[], actEnds?: Map<string, number>) =>
  solveCamera(
    intents,
    rectOf,
    timeline,
    markers,
    viewport,
    null,
    undefined,
    actEnds,
  );

const zoomKey = (keys: { scale: number; outputTimeMs: number }[], at: number) =>
  keys.find((k) => k.scale > 1 && k.outputTimeMs === at);

describe("a zoom's move and the acts before it", () => {
  it("starts a zoom's push-in no earlier than an earlier act's end plus the settle", () => {
    const before = zoomKey(
      solve([zoomOn("z", "click")]).keys,
      11245 + leadInMs,
    );
    // Premise: today the push-in sets off during the typing.
    expect(before, "premise: the zoom key").toBeDefined();
    const startBefore =
      (before?.outputTimeMs ?? 0) -
      ((before as { transitionMs?: number })?.transitionMs ?? 0);
    expect(startBefore, "premise: today's start").toBeLessThan(10080);

    const after = zoomKey(
      solve([zoomOn("z", "click")], new Map([["type", 10080]])).keys,
      11245 + leadInMs,
    ) as { outputTimeMs: number; transitionMs: number } | undefined;
    expect(after, "the zoom still lands where it did").toBeDefined();
    expect(
      (after?.outputTimeMs ?? 0) - (after?.transitionMs ?? 0),
    ).toBeGreaterThanOrEqual(10080 + actSettleMs);
  });

  it("leaves every key as it was when no act end is known", () => {
    const none = solve([zoomOn("z", "click")]);
    expect(solve([zoomOn("z", "click")], new Map())).toEqual(none);
    // An act that ends after the click's own marker belongs to a later beat.
    expect(solve([zoomOn("z", "click")], new Map([["after", 12500]]))).toEqual(
      none,
    );
  });

  it("never delays or shortens a pull-out", () => {
    // Two zooms close enough that the first one's pull-out is held back by
    // the second's push-in (code review 2026-10-20, R2/R3): click 1 at 3144
    // lands at 2794; click 2 at 6300 lands at 5950, so the pull-out must be
    // back by 5950 - 1300 - 250 = 4400, before its ideal 4919. An act ending
    // at 5000 shortens the second push-in, and must not move the pull-out.
    const close = new Map([
      ["first-click", 3144],
      ["type", 4600],
      ["second-click", 6300],
    ]);
    const solveClose = (actEnds?: Map<string, number>) =>
      solveCamera(
        [zoomOn("z1", "first-click"), zoomOn("z2", "second-click")],
        rectOf,
        timeline,
        close,
        viewport,
        null,
        undefined,
        actEnds,
      ).keys;
    const pullOut = (keys: { scale: number; outputTimeMs: number }[]) =>
      keys.find((k, i) => i > 0 && k.scale === 1);
    const push = (keys: { scale: number; outputTimeMs: number }[]) =>
      keys.find((k) => k.scale > 1 && k.outputTimeMs === 6300 + leadInMs) as
        | { transitionMs: number }
        | undefined;
    const without = solveClose();
    const withAct = solveClose(new Map([["type", 5000]]));
    // Premises: the pull-out is held back to 4400, and the act does shorten
    // the second push-in.
    expect(pullOut(without)?.outputTimeMs).toBe(4400);
    expect(push(withAct)?.transitionMs).toBeLessThan(
      push(without)?.transitionMs ?? 0,
    );
    expect(pullOut(withAct)).toEqual(pullOut(without));
  });

  it("falls back to the shortest move when an act leaves no room", () => {
    const key = zoomKey(
      solve([zoomOn("z", "click")], new Map([["type", 11200]])).keys,
      11245 + leadInMs,
    ) as { transitionMs: number } | undefined;
    expect(key, "the arrival is kept").toBeDefined();
    expect(key?.transitionMs).toBe(MIN_PAN_MS);
  });
});

describe("a marker's act end and room", () => {
  const withMarkers = (markers: object[]) =>
    validateBundle({ ...proceduralBundle(), markers } as never);

  it("keeps an act end and the room added before the step", () => {
    const bundle = withMarkers([
      {
        actionId: "act-1",
        sourceTimeMs: 400,
        actEndSourceTimeMs: 900,
        roomMs: 1200,
      },
    ]);
    expect(bundle.markers[0]).toEqual({
      actionId: "act-1",
      sourceTimeMs: 400,
      actEndSourceTimeMs: 900,
      roomMs: 1200,
    });
  });

  it("refuses an act that ends before it starts, naming both", () => {
    expect(() =>
      withMarkers([
        { actionId: "act-1", sourceTimeMs: 500, actEndSourceTimeMs: 400 },
      ]),
    ).toThrow(/400.*500|500.*400/);
  });
});

describe("act ends through the plan", () => {
  // sceneWithZoomOnClick zooms on act-3, the click at 9000; act-2 is at 3200.
  const scene = sceneWithZoomOnClick();
  const keysWith = (
    actEnd: number | null,
    cuts: { id: string; actionId: string }[] = [],
  ) => {
    const cut = {
      ...scene,
      edits: { ...scene.edits, removed: removedFor(scene, cuts) },
    };
    const bundle = proceduralBundle({
      markers: [
        { actionId: "act-1", sourceTimeMs: 400 },
        actEnd === null
          ? { actionId: "act-2", sourceTimeMs: 3200 }
          : {
              actionId: "act-2",
              sourceTimeMs: 3200,
              actEndSourceTimeMs: actEnd,
            },
        { actionId: "act-3", sourceTimeMs: 9000 },
      ],
    });
    return resolvePlan(planScene(cut), bundle, cut).cameraKeys;
  };

  it("holds the zoom on act-3 back for act-2's act", () => {
    // Premise: an act ending at 8500 is inside today's push-in.
    const today = keysWith(null).find((k) => k.scale > 1);
    expect(today, "premise: a zoom").toBeDefined();
    expect(
      (today?.outputTimeMs ?? 0) - (today?.transitionMs ?? 0),
    ).toBeLessThan(8500);
    expect(keysWith(8500)).not.toEqual(keysWith(null));
  });

  it("ignores the act end of a step the edit cut", () => {
    const cuts = [{ id: "cut-1", actionId: "act-2" }];
    expect(keysWith(8500, cuts)).toEqual(keysWith(null, cuts));
  });
});

// Review of 2026-10-22: with no room added inside a run (the author's pacing
// "C"), the next click lands about 1350ms after the last and its act ends
// ~200ms after the click. The settle then left a pan between two zooms of
// different scale ~400ms, and the scale popped. Inside a run the author
// traded the settle for flow, so a pan waits for the act alone.
describe("a pan inside a run of zooms", () => {
  const run = new Map([
    ["a", 5000],
    ["b", 6350],
  ]);
  const solveRun = (actEnds: Map<string, number>) =>
    solveCamera(
      [
        { ...zoomOn("za", "a"), scale: 2 },
        { ...zoomOn("zb", "b"), scale: 2.4 },
      ],
      rectOf,
      timeline,
      run,
      viewport,
      null,
      undefined,
      actEnds,
    );

  const panOf = (actEnd: number) => {
    const { keys, segments } = solveRun(new Map([["a", actEnd]]));
    // Premise: the two zooms pan, with no return between them.
    expect(segments).toHaveLength(2);
    expect(segments[0]?.endMs).toBe(segments[1]?.startMs);
    const pan = keys.find((k) => k.scale === 2.4);
    if (!pan) throw new Error("no key for the second zoom");
    return pan;
  };

  // The act outlasts the click's own plateau (5000 + 250 = 5250), so only
  // the act-end wait can hold the pan to 5500.
  it("waits for the act before it", () => {
    const pan = panOf(5500);
    expect(pan.outputTimeMs - pan.transitionMs).toBeGreaterThanOrEqual(5500);
  });

  // The act ends at 5200: with the settle the pan could not leave before
  // 5600, a 400ms move; without it, it leaves at the plateau's end.
  it("but not for the settle", () => {
    const pan = panOf(5200);
    expect(pan.outputTimeMs - pan.transitionMs).toBeLessThan(
      5200 + actSettleMs,
    );
    expect(pan.transitionMs).toBeGreaterThan(actSettleMs + 250);
  });

  // /code-review 2026-10-22: pan or return is the camera's own decision,
  // made where it knows the holds. A drag held in the zoom before keeps it
  // in until its release, so a click soon after the release is a pan — and
  // gets no settle — even when the zoom's arrival is long past.
  it("counts a drag held in the zoom before, as the return does", () => {
    const marks = new Map([
      ["a", 5000],
      ["b", 7800],
    ]);
    const { keys, segments } = solveCamera(
      [
        { ...zoomOn("za", "a"), scale: 2 },
        { ...zoomOn("zb", "b"), scale: 2.4 },
      ],
      rectOf,
      timeline,
      marks,
      viewport,
      null,
      undefined,
      new Map([["a", 6000]]),
      [{ startMs: 5100, endMs: 6000 }],
    );
    // Premise: from the zoom's arrival (4650) the gap to the next (7450)
    // would be a return; from the release (6000) it is a pan, and the
    // segments say pan.
    expect(returnsBetween(4650, 7450, CAMERA_DEFAULTS)).toBe(true);
    expect(returnsBetween(6000, 7450, CAMERA_DEFAULTS)).toBe(false);
    expect(segments[0]?.endMs).toBe(segments[1]?.startMs);
    const pan = keys.find((k) => k.scale === 2.4);
    if (!pan) throw new Error("no key for the second zoom");
    // No settle: it may leave once the act and the release are over.
    expect(pan.outputTimeMs - pan.transitionMs).toBeLessThan(
      6000 + actSettleMs,
    );
  });

  it("still holds a fresh push-in for the settle", () => {
    const far = new Map([
      ["a", 5000],
      ["b", 9000],
    ]);
    const { keys, segments } = solveCamera(
      [zoomOn("za", "a"), zoomOn("zb", "b")],
      rectOf,
      timeline,
      far,
      viewport,
      null,
      undefined,
      new Map([["a", 7200]]),
    );
    // Premise: far enough apart to return between.
    expect(segments[0]?.endMs).toBeLessThan(segments[1]?.departMs ?? 0);
    const pushIn = keys.find(
      (k) => k.scale > 1 && k.outputTimeMs === 9000 + leadInMs,
    );
    if (!pushIn) throw new Error("no push-in key");
    expect(pushIn.outputTimeMs - pushIn.transitionMs).toBeGreaterThanOrEqual(
      7200 + actSettleMs,
    );
  });
});

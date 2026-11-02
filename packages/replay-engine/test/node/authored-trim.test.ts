import { planScene, resolvePlan } from "@demoman/compositor";
import type { AnchorIntent } from "@demoman/resolver";
import {
  BRANDING_DEFAULTS,
  type DemoScript,
  type SceneAnchor,
} from "@demoman/scene-schema";
import { describe, expect, it, vi } from "vitest";
import { TAKE_TAIL_MS } from "../../src/constants.js";
import type {
  AuthoredDeps,
  AuthoredResult,
  EngineDeps,
  PageAgent,
} from "../../src/index.js";
import { runAuthored, STILL_DRAIN_MS } from "../../src/index.js";
import { createCdpFake, fakeScreenshotBase64 } from "../helpers/cdp-fake";
import { createMemoryFrameStore } from "../helpers/frame-store";

/**
 * The walk measures each step's finish once, and the take records the
 * script's trim from it. Driven through the real walk against the fake CDP
 * session: the finish is a walk measurement, and the tail is the walk's sleep.
 */

const PAGE = "https://app.example.com/";
/** How long the fake's slow `type` verb takes. */
const SLOW_MS = 600;
/** What the fake room says the camera needs after a zoom's hold: long
 *  enough that a zoomed click's zoom-out lands after its finish. */
const PULL_OUT_MS = 3000;

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
    trim?: DemoScript["trim"];
    zooms?: boolean;
    slowKey?: string;
    pullOutMs?: number;
  } = {},
): Promise<{ result: AuthoredResult; slowCalls: number; zoomed: string[] }> {
  /** The actions the room said it zooms to. */
  const zoomed: string[] = [];
  const cdp = createCdpFake();
  let clock = 0;
  let slowCalls = 0;
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
    // A slow verb: this one key takes `SLOW_MS` to go in.
    if (
      method === "Input.insertText" &&
      opts.slowKey !== undefined &&
      (params as { text?: string } | undefined)?.text === opts.slowKey
    ) {
      slowCalls++;
      clock += SLOW_MS;
    }
    return send(method, params);
  };
  let n = 0;
  const page: PageAgent = {
    resolve: async (anchors) =>
      anchors.map((a) => ({
        anchorId: a.id,
        strategy: "stableId" as const,
        resolved: true,
        failureReason: null,
      })),
  };
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
        clock += ms;
      },
    },
    mayReplay: true,
    recording: "continuous",
    // `stableId: "gone"` is an element the page does not have.
    captureResolved: async (intent) =>
      intent.fingerprint.stableId === "gone"
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
          },
    newId: (prefix) => `${prefix}-${++n}`,
    sceneId: "trim",
    createdAt: "2026-11-02T09:00:00.000Z",
    viewport: { width: 1280, height: 800 },
    startingBranding: BRANDING_DEFAULTS,
    roomFor: () => ({
      neededMs: () => 0,
      settledAfterMs: (heldUntil) =>
        heldUntil + (opts.pullOutMs ?? PULL_OUT_MS),
      zooms: ({ actionId }) => {
        if (opts.zooms === true) zoomed.push(actionId);
        return opts.zooms ?? false;
      },
    }),
    cameraFor: () => ({ camera: [], zoomsSkipped: [] }),
  };
  const script: DemoScript = {
    scriptVersion: 8,
    name: "trim",
    target: PAGE,
    steps,
    ...(opts.trim === undefined ? {} : { trim: opts.trim }),
  };
  return { result: await runAuthored(script, deps), slowCalls, zoomed };
}

const evidenceOf = (result: AuthoredResult): string =>
  JSON.stringify({
    outcome: result.outcome,
    reason: result.reason,
    documentError: result.documentError,
    steps: result.steps.map((s) => ({
      actionId: s.actionId,
      timing: s.timing,
    })),
    markers: result.bundle?.markers,
    trim: result.document?.edits.trim,
  });

/** The step's timing, which the premise of every case below needs. */
function timingOf(result: AuthoredResult, index: number) {
  const timing = result.steps[index]?.timing;
  expect(timing, evidenceOf(result)).toBeDefined();
  return timing as NonNullable<typeof timing>;
}

/** The last frame the take holds, in source ms. */
const lastFrameMs = (result: AuthoredResult): number =>
  Math.max(...(result.bundle?.keyframes.map((k) => k.sourceTimeMs) ?? []));

/** Where the compositor puts the trim, on the output axis it renders. */
function rendered(result: AuthoredResult) {
  if (result.document === null || result.bundle === null) {
    throw new Error(`no take to render: ${evidenceOf(result)}`);
  }
  return resolvePlan(
    planScene(result.document),
    result.bundle,
    result.document,
  );
}

const CLICK_A = { do: "click", on: { stableId: "a" } } as const;
const CLICK_B = { do: "click", on: { stableId: "b" } } as const;

describe("runAuthored: each step's finish, and the script's trim", () => {
  it("each performed step carries its timing", async () => {
    const steps: DemoScript["steps"] = [
      CLICK_A,
      { do: "type", into: { stableId: "b" }, text: "zq" },
    ];
    const { result, slowCalls } = await run(steps, { slowKey: "z" });
    const quick = await run(steps);
    const evidence = evidenceOf(result);
    // Premise: the fake's slow key really went in, once, and only there.
    expect(slowCalls, evidence).toBe(1);
    expect(quick.slowCalls).toBe(0);
    expect(result.outcome, evidence).toBe("complete");

    const markers = result.bundle?.markers ?? [];
    for (const [i, step] of result.steps.entries()) {
      const timing = timingOf(result, i);
      // The marker is the bundle's own, on the bundle's axis.
      expect(timing.markerMs, evidence).toBe(
        markers.find((m) => m.actionId === step.actionId)?.sourceTimeMs,
      );
      expect(timing.startMs, evidence).toBeLessThanOrEqual(0);
      expect(timing.finishMs, evidence).toBeGreaterThan(0);
      expect(timing.zoomOutMs, evidence).toBeNull();
    }
    // The type's finish is after its verb, slow key and all: exactly
    // SLOW_MS later than the same type without it, and the click's not at all.
    expect(timingOf(result, 1).finishMs, evidence).toBeGreaterThanOrEqual(
      SLOW_MS,
    );
    expect(
      timingOf(result, 1).finishMs - timingOf(quick.result, 1).finishMs,
      evidence,
    ).toBe(SLOW_MS);
    expect(timingOf(result, 0).finishMs, evidence).toBe(
      timingOf(quick.result, 0).finishMs,
    );
  });

  it("trim end 0 after action lands the tail at the last step's finish", async () => {
    const { result } = await run([CLICK_A, CLICK_B], {
      trim: { end: { ms: 0, after: "action" } },
      zooms: true,
    });
    const evidence = evidenceOf(result);
    const timing = timingOf(result, 1);
    // Premise: the click zoomed, and its zoom-out is later than its finish,
    // so "after action" and "after zoomOut" are different instants here.
    expect(timing.zoomOutMs, evidence).not.toBeNull();
    expect(timing.zoomOutMs as number, evidence).toBeGreaterThan(
      timing.finishMs,
    );
    expect(result.document?.edits.trim, evidence).toEqual({
      tail: { actionId: result.steps[1]?.actionId, offsetMs: timing.finishMs },
    });
    // The compositor places it there, inside the film.
    const plan = rendered(result);
    expect(plan.trimUnplaced, evidence).toEqual([]);
    expect(plan.range.endMs, evidence).toBe(timing.markerMs + timing.finishMs);
    expect(plan.range.startMs, evidence).toBe(0);
  });

  it("trim end 0 after zoomOut lands it at the zoom-out when the last click zoomed", async () => {
    // `after` absent: the default is the zoom-out.
    const { result } = await run([CLICK_A, CLICK_B], {
      trim: { end: { ms: 0 } },
      zooms: true,
    });
    const evidence = evidenceOf(result);
    const timing = timingOf(result, 1);
    expect(timing.zoomOutMs, evidence).not.toBeNull();
    expect(timing.zoomOutMs as number, evidence).toBeGreaterThan(
      timing.finishMs,
    );
    expect(result.document?.edits.trim, evidence).toEqual({
      tail: { actionId: result.steps[1]?.actionId, offsetMs: timing.zoomOutMs },
    });
    const plan = rendered(result);
    expect(plan.trimUnplaced, evidence).toEqual([]);
    expect(plan.range.endMs, evidence).toBe(
      timing.markerMs + (timing.zoomOutMs as number),
    );
  });

  it("trim end 0 after zoomOut lands it at the finish when the last click did not zoom", async () => {
    const { result } = await run([CLICK_A, CLICK_B], {
      trim: { end: { ms: 0, after: "zoomOut" } },
      zooms: false,
    });
    const evidence = evidenceOf(result);
    const timing = timingOf(result, 1);
    expect(timing.zoomOutMs, evidence).toBeNull();
    expect(result.document?.edits.trim, evidence).toEqual({
      tail: { actionId: result.steps[1]?.actionId, offsetMs: timing.finishMs },
    });
  });

  it("a start longer than the opening is clamped to it, and says so", async () => {
    const asked = 1_000_000;
    const { result } = await run([CLICK_A, CLICK_B], {
      trim: { start: { ms: asked } },
    });
    const evidence = evidenceOf(result);
    const available = timingOf(result, 0).markerMs;
    // Premise: there is an opening, and it is shorter than asked.
    expect(available, evidence).toBeGreaterThan(0);
    expect(available, evidence).toBeLessThan(asked);
    expect(result.document?.edits.trim, evidence).toEqual({
      head: { actionId: result.steps[0]?.actionId, offsetMs: -available },
    });
    expect(result.trimClamped, evidence).toEqual({
      side: "start",
      askedMs: asked,
      keptMs: available,
    });
    // `markerMs` is on the bundle's axis, whose zero is the output's zero
    // whenever the first frame lands: the clamped head starts the video at
    // its very first instant, not before or after it.
    expect(
      result.bundle?.markers.find(
        (m) => m.actionId === result.steps[0]?.actionId,
      )?.sourceTimeMs,
      evidence,
    ).toBe(available);
    expect(result.bundle?.keyframes[0]?.sourceTimeMs, evidence).toBeGreaterThan(
      0,
    );
    expect(rendered(result).range.startMs, evidence).toBe(0);
    expect(result.trimUnplaced, evidence).toBeUndefined();
  });

  it("a start inside the opening is kept as asked, with no clamp", async () => {
    const { result } = await run([CLICK_A, CLICK_B], {
      trim: { start: { ms: 5 } },
    });
    const evidence = evidenceOf(result);
    expect(timingOf(result, 0).markerMs, evidence).toBeGreaterThan(5);
    expect(result.document?.edits.trim, evidence).toEqual({
      head: { actionId: result.steps[0]?.actionId, offsetMs: -5 },
    });
    expect(result.trimClamped, evidence).toBeUndefined();
    const plan = rendered(result);
    expect(plan.range.startMs, evidence).toBe(timingOf(result, 0).markerMs - 5);
  });

  it("the default start step skips a leading waitForLoad", async () => {
    const { result } = await run([{ do: "waitForLoad" }, CLICK_A], {
      trim: { start: { ms: 0 } },
    });
    const evidence = evidenceOf(result);
    // Premise: the wait was performed, so it was there to be picked.
    expect(result.steps[0]?.actionId, evidence).not.toBeNull();
    expect(result.steps[0]?.timing, evidence).toBeDefined();
    expect(result.document?.edits.trim, evidence).toEqual({
      head: { actionId: result.steps[1]?.actionId, offsetMs: 0 },
    });
  });

  it("an end longer than TAKE_TAIL_MS films past it", async () => {
    const endMs = 5000;
    const { result } = await run([CLICK_A], {
      trim: { end: { ms: endMs, after: "action" } },
    });
    const today = await run([CLICK_A]);
    const evidence = evidenceOf(result);
    const timing = timingOf(result, 0);
    // Premise: today's tail alone stops short of what was asked.
    expect(endMs).toBeGreaterThan(TAKE_TAIL_MS);
    expect(lastFrameMs(today.result), evidence).toBeLessThan(
      timing.markerMs + timing.finishMs + endMs,
    );
    expect(lastFrameMs(result), evidence).toBeGreaterThanOrEqual(
      timing.markerMs + timing.finishMs + endMs,
    );
    expect(result.document?.edits.trim, evidence).toEqual({
      tail: {
        actionId: result.steps[0]?.actionId,
        offsetMs: timing.finishMs + endMs,
      },
    });
    // Placed inside the film, not saturated at its end.
    const plan = rendered(result);
    expect(plan.trimUnplaced, evidence).toEqual([]);
    expect(plan.range.endMs, evidence).toBe(
      timing.markerMs + timing.finishMs + endMs,
    );
    expect(plan.range.endMs, evidence).toBeLessThan(
      plan.timeline.outputDurationMs,
    );
  });

  it("an end after zoomOut, on a step that did not zoom, waits out the zoom before it", async () => {
    const { result, zoomed } = await run(
      [CLICK_A, { do: "type", into: { stableId: "b" }, text: "zq" }],
      // A pull-out long enough to outlast the type that follows the click.
      { trim: { end: { ms: 0 } }, zooms: true, pullOutMs: 10_000 },
    );
    const evidence = evidenceOf(result);
    const click = timingOf(result, 0);
    const type = timingOf(result, 1);
    // Premise: the click zoomed and the type did not, and the click's
    // pull-out is still to come when the type finishes.
    expect(zoomed, evidence).toEqual([result.steps[0]?.actionId]);
    expect(type.zoomOutMs, evidence).not.toBeNull();
    expect(type.zoomOutMs as number, evidence).toBeGreaterThan(type.finishMs);
    // The same camera return, seen from each step's own marker.
    expect(type.markerMs + (type.zoomOutMs as number), evidence).toBe(
      click.markerMs + (click.zoomOutMs as number),
    );
    expect(result.document?.edits.trim, evidence).toEqual({
      tail: { actionId: result.steps[1]?.actionId, offsetMs: type.zoomOutMs },
    });
    expect(result.trimUnplaced, evidence).toBeUndefined();
  });

  it("an end whose step never ran is left uncut, and listed", async () => {
    const { result } = await run(
      [CLICK_A, { do: "click", on: { stableId: "gone" } }],
      { trim: { start: { ms: 0 }, end: { ms: 0 } } },
    );
    const evidence = evidenceOf(result);
    // Premise: the first click ran and the last (the default end) did not.
    expect(result.steps[0]?.timing, evidence).toBeDefined();
    expect(result.steps[1]?.actionId, evidence).toBeNull();
    expect(result.reason, evidence).not.toBeNull();
    expect(result.document?.edits.trim, evidence).toEqual({
      head: { actionId: result.steps[0]?.actionId, offsetMs: 0 },
    });
    expect(result.trimUnplaced, evidence).toEqual(["end"]);
  });

  it("an end past what a stopped run filmed is left uncut, and listed", async () => {
    // Past the wait's own timeout, which the take films while it waits.
    const endMs = 60_000;
    const { result } = await run(
      [CLICK_A, { do: "waitFor", on: { stableId: "a" }, until: "hidden" }],
      { trim: { end: { ms: endMs, after: "action" } } },
    );
    const evidence = evidenceOf(result);
    const timing = timingOf(result, 0);
    // Premise: the end step (the click: a wait is not shown) ran, and the
    // walk then stopped, so it never slept for the tail.
    expect(result.reason, evidence).toBe("waitTimeout");
    expect(lastFrameMs(result), evidence).toBeLessThan(
      timing.markerMs + timing.finishMs + endMs,
    );
    expect(result.document?.edits.trim, evidence).toBeUndefined();
    expect(result.trimUnplaced, evidence).toEqual(["end"]);
  });

  it("an end after zoomOut films that long past the camera's return", async () => {
    const endMs = 4000;
    // A pull-out long enough that the walk's closing overhead after a tail
    // measured from the finish could not reach past it by accident.
    const { result } = await run([CLICK_A], {
      trim: { end: { ms: endMs } },
      zooms: true,
      pullOutMs: 10_000,
    });
    const evidence = evidenceOf(result);
    const timing = timingOf(result, 0);
    const zoomOut = timing.zoomOutMs as number;
    // Premise: the zoom-out is far later than the finish, so filming
    // `endMs` after the finish would stop short of the tail this records.
    expect(timing.zoomOutMs, evidence).not.toBeNull();
    expect(zoomOut - timing.finishMs, evidence).toBeGreaterThan(5000);
    expect(lastFrameMs(result), evidence).toBeGreaterThanOrEqual(
      timing.markerMs + zoomOut + endMs,
    );
    const plan = rendered(result);
    expect(plan.range.endMs, evidence).toBe(timing.markerMs + zoomOut + endMs);
    expect(plan.range.endMs, evidence).toBeLessThan(
      plan.timeline.outputDurationMs,
    );
  });

  it("no trim: no edits.trim and the tail is today's", async () => {
    const { result } = await run([CLICK_A]);
    const evidence = evidenceOf(result);
    expect(result.outcome, evidence).toBe("complete");
    expect(result.document?.edits.trim, evidence).toBeUndefined();
    expect(result.trimClamped, evidence).toBeUndefined();
    const timing = timingOf(result, 0);
    expect(lastFrameMs(result), evidence).toBeGreaterThanOrEqual(
      timing.markerMs + TAKE_TAIL_MS,
    );
    // A start alone, or an end inside today's tail, films the same tail.
    for (const trim of [
      { start: { ms: 0 } },
      { end: { ms: 0, after: "action" as const } },
    ]) {
      const same = await run([CLICK_A], { trim });
      expect(lastFrameMs(same.result), evidenceOf(same.result)).toBe(
        lastFrameMs(result),
      );
    }
  });
});

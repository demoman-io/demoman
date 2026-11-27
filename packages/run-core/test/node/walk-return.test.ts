import {
  CAMERA_DEFAULTS,
  motionTimings,
  planScene,
  resolvePlan,
  returnsBetween,
  toOutputMs,
} from "@demoman/compositor";
import {
  type AuthoredDeps,
  type EngineDeps,
  type PageAgent,
  runAuthored,
  STILL_DRAIN_MS,
} from "@demoman/replay-engine";
import type { AnchorIntent } from "@demoman/resolver";
import {
  BRANDING_DEFAULTS,
  type DemoScript,
  MOTION_DEFAULTS,
  type SceneAnchor,
} from "@demoman/scene-schema";
import { describe, expect, it, vi } from "vitest";
import {
  createCdpFake,
  fakeScreenshotBase64,
} from "../../../replay-engine/test/helpers/cdp-fake";
import { createMemoryFrameStore } from "../../../replay-engine/test/helpers/frame-store";
import { zoomsForClicks } from "../../src/auto-zoom.js";
import {
  ARRIVE_MS,
  actMs,
  afterScroll,
  BASE_REST_MS,
  restBefore,
  tailMs,
} from "../../src/beats.js";
import { createRoomPolicy, PAN_MARGIN_MS } from "../../src/room.js";

// Final review, Important 1: a zoomed click, a pause, and a zoomed click
// whose gap lies within `PAN_MARGIN_MS` short of a return. The walk records
// "return" there, and the camera follows the record, so the plan must give
// the return its room. Real rule, real room policy, real camera: only the
// page and the clock are fakes.

const PAGE = "https://app.example.com/";
const PAGE_ = { width: 1280, height: 800 };
const timings = motionTimings(MOTION_DEFAULTS.smoothness);
const { leadInMs } = CAMERA_DEFAULTS;
const { minPlateauMs } = CAMERA_DEFAULTS.neutral;

/** Each target its own box, far enough apart that both clicks zoom. */
const RECTS: Record<string, { x: number; y: number }> = {
  b: { x: 100, y: 100 },
  c: { x: 900, y: 600 },
};

const anchorFor = (intent: AnchorIntent): SceneAnchor => ({
  id: intent.id,
  fingerprint: {
    ...intent.fingerprint,
    boundingRect: {
      ...(RECTS[intent.fingerprint.stableId ?? ""] ?? { x: 10, y: 20 }),
      width: 100,
      height: 40,
    },
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

/** `navigates`: the first click's release starts and commits a new
 *  top-frame document, as a link to another page does. */
async function walk(steps: DemoScript["steps"], navigates = false) {
  const cdp = createCdpFake();
  let clock = 0;
  let navigated = false;
  const send = cdp.send.bind(cdp);
  cdp.send = async (method, params) => {
    if (
      navigates &&
      !navigated &&
      method === "Input.dispatchMouseEvent" &&
      (params as { type?: string } | undefined)?.type === "mouseReleased"
    ) {
      navigated = true;
      cdp.emit("Page.frameStartedLoading", { frameId: "main" });
      cdp.emit("Page.frameNavigated", { frame: { id: "main" } });
      cdp.emit("Page.frameStoppedLoading", { frameId: "main" });
    }
    if (method === "Page.captureScreenshot") {
      for (let i = 0; i < 3; i++) {
        cdp.emit("Page.screencastFrame", {
          sessionId: 100 + i,
          data: fakeScreenshotBase64(),
          metadata: { deviceWidth: PAGE_.width, deviceHeight: PAGE_.height },
        });
      }
    }
    return send(method, params);
  };
  const page: PageAgent = {
    resolve: async (anchors) =>
      anchors.map((a) => ({
        anchorId: a.id,
        strategy: "stableId" as const,
        resolved: true,
        failureReason: null,
      })),
  };
  const rest = vi.fn(restBefore);
  let n = 0;
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
    captureResolved: async (intent) => ({
      anchor: anchorFor(intent),
      failureReason: null,
      intentResolution: {
        strategy: "stableId",
        candidates: 1,
        failureReason: null,
      },
      pageUrl: null,
    }),
    newId: (prefix) => `${prefix}-${++n}`,
    sceneId: "return",
    createdAt: "2026-11-13T09:00:00.000Z",
    viewport: PAGE_,
    startingBranding: BRANDING_DEFAULTS,
    cameraFor: zoomsForClicks,
    roomFor: (vp, intentOf) => createRoomPolicy(vp, MOTION_DEFAULTS, intentOf),
    beats: {
      restBefore: rest,
      afterScroll,
      actMs,
      tailMs,
      arriveMs: ARRIVE_MS,
    },
  };
  const result = await runAuthored(
    { scriptVersion: 8, name: "return", target: PAGE, steps },
    deps,
  );
  return { result, asked: rest.mock.calls.map(([i]) => i), navigated };
}

describe("a zoomed click paced as a return just short of one", () => {
  // Red if the walk drops its `if (returnShortMs > 0) planRoom(...)` (or
  // the rule stops adding `returnShortMs`): the plan keeps the 2500 ms gap,
  // the recorded return no longer fits, and the camera pans (`arrivesOf`'s
  // guard) instead of returning.
  it("plans the whole return with its margin, and the camera holds, returns and is in before the click", async () => {
    // A pause that puts the second click 2500 ms after the first on the
    // designed clock with nothing added: inside the band.
    const pauseMs = 2000;
    const { result, asked } = await walk([
      { do: "click", on: { stableId: "b" } },
      { do: "pause", ms: pauseMs },
      { do: "click", on: { stableId: "c" } },
    ]);
    const evidence = JSON.stringify({
      outcome: result.outcome,
      reason: result.reason,
      pacing: result.pacing,
      decided: [...(result.decided ?? new Map())],
      asked,
      camera: result.document?.camera,
    });
    expect(result.outcome, evidence).toBe("complete");
    const document = result.document;
    const bundle = result.bundle;
    if (document === null || bundle === null) throw new Error(evidence);

    // Premise: both clicks zoomed, and the second was recorded as a return
    // (the first is one too: there is no zoom before it to pan from).
    expect(
      document.camera.map((c) => c.arrives ?? null),
      evidence,
    ).toEqual(["return", "return"]);
    const beat = result.pacing?.beats[1];
    const second = asked.at(-1);
    if (beat === undefined || second === undefined) throw new Error(evidence);
    // Premise: with no shortfall added, the gap from the first click's
    // marker to the second's is inside the band: a return by the walk's
    // margin, not by the camera's own rule. Measured from the first
    // marker, so what it holds until is `leadInMs` and the second arrival
    // is the gap plus `leadInMs`.
    const baseGap = BASE_REST_MS + pauseMs + second.journeyMs + ARRIVE_MS;
    const returnsAt = (gapMs: number, extra = 0) =>
      returnsBetween(leadInMs, gapMs + leadInMs + extra, timings);
    expect(returnsAt(baseGap), evidence).toBe(false);
    expect(returnsAt(baseGap, PAN_MARGIN_MS), evidence).toBe(true);

    // The plan: the designed gap is a whole return plus the margin.
    const designedGap =
      beat.restMs +
      second.journeyMs +
      beat.arriveMs +
      (beat.afterScrollMs ?? 0);
    expect(second.returnShortMs ?? 0, evidence).toBeGreaterThan(0);
    expect(returnsAt(designedGap, -PAN_MARGIN_MS), evidence).toBe(true);

    // The video: the camera holds its plateau at the first zoom, pulls out,
    // and is fully in again before the second click.
    const { timeline, cameraKeys } = resolvePlan(
      planScene(document),
      bundle,
      document,
    );
    const keysEvidence = `${evidence} keys ${JSON.stringify(cameraKeys)}`;
    expect(
      cameraKeys.map((k) => (k.scale > 1 ? "in" : "out")),
      keysEvidence,
    ).toEqual(["out", "in", "out", "in", "out"]);
    const [, firstIn, pullOut, secondIn] = cameraKeys;
    if (
      firstIn === undefined ||
      pullOut === undefined ||
      secondIn === undefined
    )
      throw new Error(keysEvidence);
    expect(
      pullOut.outputTimeMs - pullOut.transitionMs - firstIn.outputTimeMs,
      keysEvidence,
    ).toBeGreaterThanOrEqual(minPlateauMs);
    expect(
      secondIn.outputTimeMs - secondIn.transitionMs - pullOut.outputTimeMs,
      keysEvidence,
    ).toBeGreaterThanOrEqual(minPlateauMs);
    const secondClick = bundle.markers.find(
      (m) => m.actionId === document.camera[1]?.marker.actionId,
    );
    if (secondClick === undefined) throw new Error(keysEvidence);
    expect(secondIn.outputTimeMs, keysEvidence).toBeLessThanOrEqual(
      toOutputMs(timeline, secondClick.sourceTimeMs),
    );
  });
});

// Ruled 2026-11-20: known waits go on the designed clock. A wait
// step, or a load, between two zoomed clicks takes the page's time, which
// the designed clock does not count: without this the second click panned
// from the first's zoom across a long load. Red if the walk stops reading
// a wait (`waitedSince`), or stops planning the return's room.
describe("a zoomed click after a known wait", () => {
  // Far enough apart that both clicks zoom (the gap rule), near enough that
  // with nothing between them the second pans.
  const PAUSE: DemoScript["steps"][number] = { do: "pause", ms: 1500 };
  const B: DemoScript["steps"][number] = { do: "click", on: { stableId: "b" } };
  const C: DemoScript["steps"][number] = { do: "click", on: { stableId: "c" } };
  const cases: [string, DemoScript["steps"], boolean][] = [
    ["a waitForLoad step", [B, { do: "waitForLoad" }, PAUSE, C], false],
    ["a load the first click started", [B, PAUSE, C], true],
  ];
  it.each(cases)(
    "after %s, returns through full frame, and is in before the click",
    async (_, steps, navigates) => {
      // Premise: the same two clicks with nothing between them both zoom,
      // and the second pans.
      const plain = await walk([B, PAUSE, C]);
      expect(
        plain.result.document?.camera.map((c) => c.arrives ?? null),
        JSON.stringify(plain.result.document?.camera),
      ).toEqual(["return", "pan"]);

      const { result, navigated } = await walk(steps, navigates);
      const evidence = JSON.stringify({
        outcome: result.outcome,
        reason: result.reason,
        pacing: result.pacing,
        decided: [...(result.decided ?? new Map())],
        camera: result.document?.camera,
      });
      expect(result.outcome, evidence).toBe("complete");
      // Premise: the fake committed its document when it was asked to.
      expect(navigated, evidence).toBe(navigates);
      const document = result.document;
      const bundle = result.bundle;
      if (document === null || bundle === null) throw new Error(evidence);
      expect(
        document.camera.map((c) => c.arrives ?? null),
        evidence,
      ).toEqual(["return", "return"]);

      // The video: in, out to full frame, and in again before the click.
      const { timeline, cameraKeys } = resolvePlan(
        planScene(document),
        bundle,
        document,
      );
      const keysEvidence = `${evidence} keys ${JSON.stringify(cameraKeys)}`;
      expect(
        cameraKeys.map((k) => (k.scale > 1 ? "in" : "out")),
        keysEvidence,
      ).toEqual(["out", "in", "out", "in", "out"]);
      const secondIn = cameraKeys[3];
      const secondClick = bundle.markers.find(
        (m) => m.actionId === document.camera[1]?.marker.actionId,
      );
      if (secondIn === undefined || secondClick === undefined)
        throw new Error(keysEvidence);
      expect(secondIn.outputTimeMs, keysEvidence).toBeLessThanOrEqual(
        toOutputMs(timeline, secondClick.sourceTimeMs),
      );
    },
  );
});

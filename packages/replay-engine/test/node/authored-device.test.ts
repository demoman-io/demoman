import type { AnchorIntent } from "@demoman/resolver";
import { BRANDING_DEFAULTS, type DemoScript } from "@demoman/scene-schema";
import { describe, expect, it, vi } from "vitest";
import type {
  AuthoredDeps,
  EngineDeps,
  IntentCapture,
  PageAgent,
} from "../../src/index.js";
import { runAuthored } from "../../src/index.js";
import { type CdpFake, createCdpFake } from "../helpers/cdp-fake";
import { createMemoryFrameStore } from "../helpers/frame-store";

/**
 * An authored run filmed as a device (spec 2026-10-10 §3): the script's
 * device sets the run's size, is put on the page, and is written on the take
 * so a rebuild and a derive reproduce it.
 */
const PAGE = "https://app.example.com/";

function deps(cdp: CdpFake, treePath = "button:1"): AuthoredDeps {
  let n = 0;
  let clock = 0;
  const page: PageAgent = {
    resolve: async (anchors) =>
      anchors.map((a) => ({
        anchorId: a.id,
        strategy: "stableId" as const,
        resolved: true,
        failureReason: null,
      })),
  };
  const encoder: EngineDeps["encoder"] = {
    openSpan: vi.fn(),
    push: vi.fn(async () => undefined),
    closeSpan: vi.fn(async () => null),
    queueDepth: () => 0,
    heapFraction: () => 0.1,
  };
  return {
    cdp,
    page,
    encoder,
    store: createMemoryFrameStore(),
    clock: {
      now: () => (clock += 10),
      sleep: async (ms: number) => {
        clock += ms;
      },
    },
    mayReplay: true,
    captureResolved: async (intent: AnchorIntent): Promise<IntentCapture> => ({
      anchor: {
        id: intent.id,
        fingerprint: {
          ...intent.fingerprint,
          treePath,
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
      },
      failureReason: null,
      intentResolution: {
        strategy: "stableId",
        candidates: 1,
        failureReason: null,
      },
      pageUrl: null,
    }),
    newId: (prefix) => `${prefix}-${++n}`,
    sceneId: "authored-device",
    createdAt: "2026-10-09T09:00:00.000Z",
    viewport: { width: 1280, height: 800 },
    startingBranding: BRANDING_DEFAULTS,
    cameraFor: () => ({ camera: [], zoomsSkipped: [] }),
  };
}

const oneClick = (): DemoScript => ({
  scriptVersion: 1,
  name: "one click",
  target: PAGE,
  steps: [{ do: "click", on: { stableId: "go" } }],
});

describe("an authored run with a device", () => {
  it("films at the device's size and records it on the take", async () => {
    const cdp = createCdpFake();
    const result = await runAuthored(
      { ...oneClick(), scriptVersion: 4, device: "phone" },
      deps(cdp),
    );
    // Premise: the run completed, so the take exists to be read.
    expect(result.completed, JSON.stringify(result.reason)).toBe(1);
    const metrics = cdp.calls.find(
      (c) => c.method === "Emulation.setDeviceMetricsOverride",
    );
    expect(metrics?.params).toMatchObject({
      width: 393,
      height: 852,
      mobile: true,
    });
    expect(result.document?.meta.capture.viewport).toEqual({
      width: 393,
      height: 852,
    });
    expect(result.document?.meta.capture.device).toMatchObject({
      preset: "phone",
      width: 393,
      height: 852,
      touch: true,
    });
    expect(cdp.calls.some((c) => c.method === "Input.dispatchTouchEvent")).toBe(
      true,
    );
  });

  // A phone shows a page with no meta viewport zoomed out (scale 0.401,
  // probe:tap-space), and the walk's rects and input points are the page's
  // own px. The bundle carries the zoom so the compositor draws them where
  // the screen showed them, and auto-zoom is told it for each click.
  it("records the page's zoom, and hands it to auto-zoom", async () => {
    const cdp = createCdpFake();
    cdp.layoutScale = 393 / 980;
    const cameraFor = vi.fn(() => ({ camera: [], zoomsSkipped: [] }));
    const result = await runAuthored(
      { ...oneClick(), scriptVersion: 4, device: "phone" },
      { ...deps(cdp), cameraFor },
    );
    expect(result.completed, JSON.stringify(result.reason)).toBe(1);
    expect(result.bundle?.viewportTransforms).toEqual([
      {
        sourceTimeMs: expect.any(Number),
        scale: 393 / 980,
        offsetX: 0,
        offsetY: 0,
      },
    ]);
    const [actions, , scaleAt] = cameraFor.mock.calls[0] as unknown as [
      { kind: string }[],
      unknown,
      (action: unknown) => number,
    ];
    const click = actions.find((a) => a.kind === "click");
    expect(scaleAt(click)).toBeCloseTo(393 / 980, 6);
  });

  // Scale 1 is a measurement too, so it is recorded rather than assumed.
  it("records an unzoomed page as scale 1", async () => {
    const cdp = createCdpFake();
    const result = await runAuthored(
      { ...oneClick(), scriptVersion: 4, device: "phone" },
      deps(cdp),
    );
    expect(result.bundle?.viewportTransforms).toEqual([
      { sourceTimeMs: expect.any(Number), scale: 1, offsetX: 0, offsetY: 0 },
    ]);
  });

  // Review 2026-10-11, finding 6. A desktop page is never zoomed out, so a
  // desktop run does not ask: the ask was a CDP round trip per measure. The
  // fake answers a zoom regardless, so red if the walk still asks.
  it("does not read the page's zoom on a desktop run", async () => {
    const cdp = createCdpFake();
    cdp.layoutScale = 393 / 980;
    const result = await runAuthored(oneClick(), deps(cdp));
    // Premise: the click was walked, so elements were measured.
    expect(result.completed, JSON.stringify(result.reason)).toBe(1);
    expect(result.bundle?.viewportTransforms).toBeUndefined();
  });

  // A device is the run's size, so a run that names one needs no measured
  // window — and one that names neither has nothing to film at.
  it("needs no measured viewport when the script names a device", async () => {
    const cdp = createCdpFake();
    const { viewport: _measured, ...unmeasured } = deps(cdp);
    const result = await runAuthored(
      { ...oneClick(), scriptVersion: 4, device: "tablet" },
      unmeasured,
    );
    expect(result.completed, JSON.stringify(result.reason)).toBe(1);
    expect(result.document?.meta.capture.viewport).toEqual({
      width: 820,
      height: 1180,
    });
  });

  it("refuses a run with no device, no viewport and nothing measured", async () => {
    const cdp = createCdpFake();
    const { viewport: _measured, ...unmeasured } = deps(cdp);
    await expect(runAuthored(oneClick(), unmeasured)).rejects.toThrow(
      /viewport/,
    );
  });

  it("writes no device on a desktop run", async () => {
    const cdp = createCdpFake();
    const result = await runAuthored(oneClick(), deps(cdp));
    expect(result.completed).toBe(1);
    expect(result.document?.meta.capture.device).toBeUndefined();
    expect(result.document?.meta.capture.viewport).toEqual({
      width: 1280,
      height: 800,
    });
  });
});

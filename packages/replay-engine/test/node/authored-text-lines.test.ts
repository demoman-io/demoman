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
 * An authored click carries no text lines, and the run reports nothing about
 * them. From 2026-10-09 to 2026-10-10 the walk measured the lines on screen
 * at every click, for a zoom narrowed until it cut none of them ("O2"), and
 * reported each click it could not measure as `textLinesUnmeasured`. The
 * zoom fits its target alone now (`zoomsForClicks`), so that report would
 * warn about a framing nothing uses — a false alarm on every page that
 * throws, or where the click is in a frame.
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
    sceneId: "authored-text-lines",
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

describe("an authored click", () => {
  // Red with the 2026-10-09 walk back: the fake no longer answers the
  // text-lines call, so that walk reported "the page answered with nothing
  // this could read" as `textLinesUnmeasured` on this click.
  it("carries no text lines, and the run reports none unmeasured", async () => {
    const cdp = createCdpFake();
    const result = await runAuthored(oneClick(), deps(cdp));
    const click = result.document?.actions[0];
    const evidence = JSON.stringify({
      reason: result.reason,
      completed: result.completed,
      click,
      degradations: result.bundle?.degradations,
    });
    // Premise: the click ran and is in the take, with its rect.
    expect(result.completed, evidence).toBe(1);
    expect(click?.kind, evidence).toBe("click");
    expect(click?.rect, evidence).toBeDefined();
    expect(click && "textLines" in click, evidence).toBe(false);
    expect(
      (result.bundle?.degradations ?? []).filter(
        (d) => d.kind === "textLinesUnmeasured",
      ),
      evidence,
    ).toEqual([]);
  });
});

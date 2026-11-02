import type { AnchorIntent } from "@demoman/resolver";
import {
  BRANDING_DEFAULTS,
  type DemoScript,
  type SceneAnchor,
  type ZoomIntentOf,
} from "@demoman/scene-schema";
import { describe, expect, it, vi } from "vitest";
import type { AuthoredDeps, EngineDeps, PageAgent } from "../../src/index.js";
import { runAuthored, STILL_DRAIN_MS } from "../../src/index.js";
import { createCdpFake, fakeScreenshotBase64 } from "../helpers/cdp-fake";
import { createMemoryFrameStore } from "../helpers/frame-store";

/**
 * The script's zoom intent reaches the room (asked during the walk) and the
 * camera (asked after it) as one lookup, filled by the run — not decided
 * twice. Driven through the real walk against the fake CDP session, since
 * the room asks before a step commits and only the real walk shows that.
 */

const PAGE = "https://app.example.com/";

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

describe("runAuthored: the script's zoom intent", () => {
  it("hands the room and the camera the same lookup, naming the second click's `zoom: false`", async () => {
    const cdp = createCdpFake();
    // Continuous recording keeps what the page paints: let every screenshot
    // paint, as a live page does, so the walk has frames to walk.
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
    const roomSeen: { actionId: string; intent: unknown }[] = [];
    let roomIntentOf: ZoomIntentOf | undefined;
    let cameraIntentOf: ZoomIntentOf | undefined;
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
        // The fake's sleeps resolve at once; the closing still's race
        // against this timeout must not win (replay-engine.test.ts).
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
      sceneId: "zoom-intent",
      createdAt: "2026-11-02T09:00:00.000Z",
      viewport: { width: 1280, height: 800 },
      startingBranding: BRANDING_DEFAULTS,
      roomFor: (_vp, intentOf) => {
        roomIntentOf = intentOf;
        return {
          neededMs: () => 0,
          settledAfterMs: () => 0,
          zooms: (click) => {
            // Read now, mid-walk: the click is not committed yet.
            roomSeen.push({
              actionId: click.actionId,
              intent: intentOf(click.actionId),
            });
            return false;
          },
        };
      },
      cameraFor: (_actions, _vp, _scaleAt, intentOf) => {
        cameraIntentOf = intentOf;
        return { camera: [], zoomsSkipped: [] };
      },
    };
    const script: DemoScript = {
      scriptVersion: 8,
      name: "zoom intent",
      target: PAGE,
      steps: [
        { do: "click", on: { stableId: "a" } },
        { do: "click", on: { stableId: "b" }, zoom: false },
      ],
    };

    const result = await runAuthored(script, deps);
    const ids = result.document?.actions.map((a) => a.id) ?? [];
    const evidence = JSON.stringify({
      ids,
      roomSeen,
      outcome: result.outcome,
      reason: result.reason,
    });

    // Premise: both clicks ran, and the room was asked about both.
    expect(ids, evidence).toHaveLength(2);
    expect(
      roomSeen.map((r) => r.actionId),
      evidence,
    ).toEqual(ids);
    // The room saw the intent while the walk was still running.
    expect(
      roomSeen.map((r) => r.intent),
      evidence,
    ).toEqual([undefined, false]);
    // One decision: the same function reached both, and the camera reads it too.
    expect(roomIntentOf).toBeDefined();
    expect(cameraIntentOf).toBe(roomIntentOf);
    expect(cameraIntentOf?.(ids[0] as string), evidence).toBeUndefined();
    expect(cameraIntentOf?.(ids[1] as string), evidence).toBe(false);
  });
});

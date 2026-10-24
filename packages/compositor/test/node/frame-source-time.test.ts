import { describe, expect, it } from "vitest";
import type { FrameBundle } from "../../src/bundle";
import { createImageFrameSource } from "../../src/ports/frame-source-images";
import type { FrameImage } from "../../src/ports/types";

const stub = (ref: string): FrameImage => ({
  image: { ref } as unknown as CanvasImageSource,
  width: 1280,
  height: 800,
  sourceTimeMs: -1,
});

function bundle(): FrameBundle {
  return {
    bundleVersion: 1,
    sceneId: "scene-1",
    source: "capture",
    dpr: 1,
    viewport: { width: 1280, height: 800 },
    keyframes: [
      {
        ref: "kf:0",
        sourceTimeMs: 0,
        width: 1280,
        height: 800,
        actionId: null,
      },
      {
        ref: "kf:1",
        sourceTimeMs: 5000,
        width: 1280,
        height: 800,
        actionId: null,
      },
    ],
    motionSpans: [],
    cursorSamples: [],
    anchorRects: [],
    markers: [],
    degradations: [],
  } as unknown as FrameBundle;
}

describe("createImageFrameSource", () => {
  it("reports the keyframe time it served, not the time asked for", async () => {
    const frames = createImageFrameSource(bundle(), async (ref) => stub(ref));
    // 4900 falls between keyframes; the source serves kf:0 at 0.
    const served = await frames.at(4900);
    expect(served.sourceTimeMs).toBe(0);
  });

  it("gives two far-apart requests the same time when one keyframe serves both", async () => {
    const frames = createImageFrameSource(bundle(), async (ref) => stub(ref));
    const a = await frames.at(600);
    const b = await frames.at(1100);
    // This equality is the whole point: Task 3 uses it to refuse a verdict.
    expect(a.sourceTimeMs).toBe(b.sourceTimeMs);
  });
});

describe("createImageFrameSource warm", () => {
  /** Three stills, so a range can take some and leave others. */
  function three(): FrameBundle {
    const b = bundle();
    return {
      ...b,
      keyframes: [
        ...b.keyframes,
        { ...b.keyframes[1], ref: "kf:2", sourceTimeMs: 9000 },
      ],
    } as FrameBundle;
  }

  it("decodes the still in force and the ones after it in range, before any draw", async () => {
    const loaded: string[] = [];
    const frames = createImageFrameSource(three(), async (ref) => {
      loaded.push(ref);
      return stub(ref);
    });
    frames.warm?.(2000, 6000);
    expect(loaded).toEqual(["kf:0", "kf:1"]);
    // The draw that reaches a warmed still does not load it again.
    await frames.at(5500);
    expect(loaded).toEqual(["kf:0", "kf:1"]);
  });

  it("keeps a failed warm's reason for the draw that reaches it", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      const frames = createImageFrameSource(three(), async (ref) => {
        throw new Error(`no bytes for ${ref}`);
      });
      frames.warm?.(0, 0);
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(unhandled).toEqual([]);
      await expect(frames.at(100)).rejects.toThrow("no bytes for kf:0");
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });
});

describe("createVideoFrameSource warm", () => {
  it("decodes stills ahead the same way, with no span to serve", async () => {
    const { createVideoFrameSource } = await import(
      "../../src/ports/frame-source-video"
    );
    const loaded: string[] = [];
    const frames = await createVideoFrameSource(bundle(), async (ref) => {
      loaded.push(ref);
      return stub(ref);
    });
    frames.warm?.(0, 5000);
    expect(loaded).toEqual(["kf:0", "kf:1"]);
    await frames.at(5000);
    expect(loaded).toEqual(["kf:0", "kf:1"]);
  });
});

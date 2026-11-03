import type { SceneDocument } from "@demoman/scene-schema";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FrameBundle } from "../../src/bundle";
import { planScene } from "../../src/plan/plan";
import {
  createCollectingImageSink,
  createRecordingGifSink,
  createRecordingVideoSink,
} from "../../src/ports/fakes";
import type { FrameSource } from "../../src/ports/types";
import { renderFrame } from "../../src/render/compose";
import { renderScene, renderScreens } from "../../src/render/render";
import { GIF_800, LANDSCAPE_1080P } from "../../src/render/target";
import { proceduralBundle } from "../fixtures/bundle";
import { readonlyScene } from "../fixtures/scene";

// The node lane has no canvas: renderFrame is stubbed and its calls are the
// draw log (the same arrangement as render-loop.test.ts).
vi.mock("../../src/render/compose", () => ({
  renderFrame: vi.fn(async () => undefined),
  cssToOutput: vi.fn(),
  cssRectToOutput: vi.fn(),
}));
vi.mock("../../src/render/motion-detect", () => ({
  detectKeyframeMotion: vi.fn(async () => []),
}));

const stubSurface = { create: () => ({ getContext: () => ({}) }) as never };
const frames: FrameSource = {
  at: async () => ({
    image: {} as never,
    width: 1280,
    height: 800,
    sourceTimeMs: 0,
  }),
  describe: () => ({ keyframes: [], motionSpans: [] }),
};

// Three clicks with a glide before each (moments.test.ts's fixture), and a
// trim that starts at act-1 so the range does not begin at zero.
const P0 = { x: 120, y: 640 };
const P1 = { x: 200, y: 42 };
const P2 = { x: 640, y: 328 };
const P3 = { x: 1060, y: 642 };
const CLICKS = [1500, 3500, 5500];
const END_MS = 7000;
const anchors = ["a-search", "a-row", "a-checkout"];
const scene: SceneDocument = {
  ...readonlyScene(),
  actions: CLICKS.map((timestamp, i) => ({
    id: `act-${i + 1}`,
    anchorId: anchors[i] as string,
    timestamp,
    marker: `click:${anchors[i]}`,
    kind: "click",
    button: "left",
  })),
  camera: [],
  edits: {
    ...readonlyScene().edits,
    trim: { head: { actionId: "act-1", offsetMs: -200 } },
  },
};
const bundle: FrameBundle = proceduralBundle({
  timing: "real",
  keyframes: [0, ...CLICKS, END_MS].map((sourceTimeMs, i) => ({
    sourceTimeMs,
    ref: `k-${i}`,
    width: 1280,
    height: 800,
    actionId: null,
    byteLength: 0,
  })),
  motionSpans: [],
  cursorSamples: [
    { sourceTimeMs: 0, ...P0 },
    { sourceTimeMs: 1000, ...P0 },
    { sourceTimeMs: 1300, ...P1 },
    { sourceTimeMs: 3000, ...P1 },
    { sourceTimeMs: 3300, ...P2 },
    { sourceTimeMs: 5000, ...P2 },
    { sourceTimeMs: 5300, ...P3 },
    { sourceTimeMs: END_MS, ...P3 },
  ],
  markers: CLICKS.map((sourceTimeMs, i) => ({
    actionId: `act-${i + 1}`,
    sourceTimeMs,
  })),
});

const mp4 = () => ({
  plan: planScene(scene),
  bundle,
  scene,
  target: LANDSCAPE_1080P,
  ports: {
    frames,
    surface: stubSurface,
    video: createRecordingVideoSink(),
    images: createCollectingImageSink(),
  },
});
const gif = () => ({
  ...mp4(),
  target: GIF_800,
  ports: { ...mp4().ports, gif: createRecordingGifSink() },
});

const drawn = () =>
  vi.mocked(renderFrame).mock.calls.map((c) => c[0].outputTimeMs);

beforeEach(() => vi.mocked(renderFrame).mockClear());

describe("renderScreens", () => {
  it.each([
    ["an MP4", mp4],
    ["a GIF", gif],
  ])("records the screens renderScene records for %s", async (_n, make) => {
    const a = await renderScreens(make());
    expect(a.screens.moments.length).toBeGreaterThanOrEqual(2);
    expect(a.screens).toEqual((await renderScene(make())).screens);
  });

  it("draws one image per screen, at the screen's own instant", async () => {
    const args = mp4();
    // Premise: the range starts after zero, so the two axes differ.
    await renderScene(args);
    const startMs = drawn()[0] as number;
    expect(startMs).toBeGreaterThan(0);
    vi.mocked(renderFrame).mockClear();

    const { screens, images } = await renderScreens(mp4());
    expect(screens.moments.length).toBeGreaterThanOrEqual(2);
    expect(images.map((i) => i.step)).toEqual(
      screens.moments.map((m) => m.step),
    );
    expect(drawn()).toEqual(screens.moments.map((m) => startMs + m.ms));
  });

  it("never hands a frame to the video or GIF sink", async () => {
    const m = mp4();
    await renderScreens(m);
    expect(m.ports.video.calls).toEqual([]);
    const g = gif();
    await renderScreens(g);
    expect(g.ports.gif.calls).toEqual([]);
    expect(g.ports.images.files.length).toBeGreaterThanOrEqual(2);
  });
});

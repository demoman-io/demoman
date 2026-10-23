import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { proceduralBundle } from "../../../../../packages/replay-engine/test/helpers/bundles";
import { readonlyScene } from "../../../../../packages/replay-engine/test/helpers/scenes";
import { editorDom } from "../helpers/editor-dom";
import {
  createMemoryPlatform,
  type MemoryPlatform,
} from "../helpers/memory-platform";

const state = vi.hoisted(() => ({ memory: null as MemoryPlatform | null }));
// The real module's other exports (the studio's own copy, such as
// `refilmLine`) stay; only the platform the page builds is the memory one.
vi.mock("#platform", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  createPlatform: () => state.memory,
}));

/**
 * One decoded frame source per bundle, shared by the preview and the
 * hover check. `refreshHints` built its own with a second
 * `createImageFrameSource`/`createVideoFrameSource` call beside the
 * `framesFor` cache the preview draws from, so every bundle was decoded
 * twice — every motion span loaded and demuxed on the way, on the page
 * whose docblock names that cost as what made playback unaffordable.
 */

const imageSourceMock = vi.hoisted(() => vi.fn());

vi.mock("@demoman/compositor", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@demoman/compositor")>();
  imageSourceMock.mockImplementation(actual.createImageFrameSource);
  return {
    ...actual,
    createImageFrameSource: imageSourceMock,
    detectKeyframeMotion: vi.fn().mockResolvedValue([]),
    // One still hover, so the check leaves a banner to wait for.
    hoverVerdicts: vi
      .fn()
      .mockResolvedValue([{ kind: "still", actionId: "act-1" }]),
    // The draw itself is not under test; a fake 2D context would fail it.
    renderFrame: vi.fn().mockResolvedValue(undefined),
  };
});

class FakeOffscreenCanvas {
  width: number;
  height: number;
  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
  }
  getContext(): Record<string, never> {
    return {};
  }
}

describe("editor main — one frame source per bundle", () => {
  let memory: MemoryPlatform;

  beforeEach(() => {
    vi.resetModules();
    editorDom();
    vi.stubGlobal("OffscreenCanvas", FakeOffscreenCanvas);
    imageSourceMock.mockClear();
    memory = createMemoryPlatform();
    state.memory = memory;
    memory.serveScene(() => readonlyScene());
    // `motionSpans: []` so the source is the image one, which reads
    // nothing until a frame is asked for.
    memory.serveBundle(proceduralBundle({ motionSpans: [] }), null);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("builds the source once for the preview draw and the hover check together", async () => {
    const compositor = await import("@demoman/compositor");
    await import("../../../pages/entrypoints/editor/main");

    // Both consumers have run: the hover check has written its report, and
    // the first-frame draw the same snapshot triggers has been through
    // `renderFrame`.
    await vi.waitFor(() => {
      if (!document.querySelector("[data-hover-report]")) {
        throw new Error("hover check not settled yet");
      }
      if (vi.mocked(compositor.renderFrame).mock.calls.length === 0) {
        throw new Error("first frame not drawn yet");
      }
    });

    expect(imageSourceMock).toHaveBeenCalledTimes(1);
  });
});

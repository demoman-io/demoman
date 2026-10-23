import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
 * The studio has no hosted service, driven against the real
 * `entrypoints/editor/main.ts`: it must ask the platform for no share and
 * draw no share surface at all (the share code was cut 2026-10-20, archive
 * Task 9; `studio-bundle.test.ts` asserts it is not in the bundle). The
 * harness is `editor-main-render-failed.test.ts`'s.
 */

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

describe("editor main — hosting off", () => {
  let memory: MemoryPlatform;

  beforeEach(() => {
    vi.resetModules();
    editorDom();
    vi.stubGlobal("OffscreenCanvas", FakeOffscreenCanvas);
    memory = createMemoryPlatform();
    state.memory = memory;
    memory.serveScene(() => readonlyScene());
    memory.serveBundle(null, null);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("draws no share surface", async () => {
    await import("../../../pages/entrypoints/editor/main");
    await vi.waitFor(() => {
      if (!document.querySelector("[data-export-start]"))
        throw new Error("panel not rendered yet");
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    // Whether the page reaches for a share member at all is the bundle's
    // question (studio-bundle.test.ts): the memory platform records only the
    // members it has, so asking it here could not fail.
    expect(document.querySelector('[data-section="share"]')).toBeNull();
  });
});

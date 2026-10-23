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
 * Drives the real `entrypoints/editor/main.ts` through a bundle whose frame
 * source cannot be built at all — the throw-prone step (video decode, in
 * particular) that used to sit OUTSIDE `refreshHints`'s try/catch. Before
 * I4's fix, this left `hintedBundle` set (so the bundle would never be
 * retried) and `hoverReport` at `null` — which `renderHoverReport` treats
 * identically to "the check has not run yet", so a crashed check rendered
 * no banner at all and was indistinguishable from a clean take.
 *
 * `createImageFrameSource` is mocked to throw because jsdom has no real
 * frame store to decode against; everything downstream of that (the
 * session, `refreshHints`, `renderHoverReport`) is the genuine production
 * code.
 */

vi.mock("@demoman/compositor", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@demoman/compositor")>();
  return {
    ...actual,
    createImageFrameSource: () => {
      throw new Error("simulated frame-source construction failure");
    },
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

describe("editor main — a hover check that never runs", () => {
  let memory: MemoryPlatform;

  beforeEach(() => {
    vi.resetModules();
    editorDom();
    vi.stubGlobal("OffscreenCanvas", FakeOffscreenCanvas);
    memory = createMemoryPlatform();
    state.memory = memory;
    memory.serveScene(() => readonlyScene());
    // `motionSpans: []` so `refreshHints` takes the `createImageFrameSource`
    // branch — the one this file mocks to throw.
    memory.serveBundle(proceduralBundle({ motionSpans: [] }), null);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("reports that the check did not run, instead of rendering nothing", async () => {
    await import("../../../pages/entrypoints/editor/main");

    // The take-wide report is a card in the status row since 2026-09-22
    // (`renderTakeNotes`): it is a fact about the whole take, so it stays
    // put rather than following the selection — and it left the dock,
    // which is an instrument panel rather than somewhere to keep standing
    // sentences. It sat on the timeline's own bar from Task 3 until then.
    const report = await vi.waitFor(() => {
      const el = document.getElementById("take-notes");
      if (!el || !/could not run|did not run/i.test(el.textContent ?? "")) {
        throw new Error("hover report not rendered yet");
      }
      return el;
    });

    expect(report.textContent).toMatch(/could not run|did not run/i);
    // And it is NOT in the dock, which is the half of this that would
    // otherwise pass on a report drawn in both places at once.
    expect(document.getElementById("timeline")?.textContent ?? "").not.toMatch(
      /could not run|did not run/i,
    );
  });
});

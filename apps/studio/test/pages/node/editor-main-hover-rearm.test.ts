import type { SceneDocument } from "@demoman/scene-schema";
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
 * Drives the real `entrypoints/editor/main.ts` through an edit that retires
 * the hover report on a bundle that never changes, and proves the check
 * runs again rather than staying silent for the rest of the session.
 *
 * `refreshHints` used to gate purely on `bundle === hintedBundle`, so once
 * `runCommand` nulled `hoverReport` the banner disappeared for good on that
 * bundle. Removing a piece is the edit that nulls it now (state.ts): it
 * changes which steps are in the video, and the check must run again.
 */

const hoverVerdictsMock = vi.hoisted(() => vi.fn());

vi.mock("@demoman/compositor", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@demoman/compositor")>();
  return {
    ...actual,
    detectKeyframeMotion: vi.fn().mockResolvedValue([]),
    hoverVerdicts: hoverVerdictsMock,
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

/** The hover check's sentence, which names how many hovers it flagged. */
const hoverButton = (): HTMLElement | null =>
  document.querySelector("[data-hover-report]");

describe("editor main — the hover check after a retiring edit", () => {
  let memory: MemoryPlatform;

  beforeEach(() => {
    vi.resetModules();
    editorDom();
    vi.stubGlobal("OffscreenCanvas", FakeOffscreenCanvas);
    memory = createMemoryPlatform();
    state.memory = memory;
    // Split at act-2's frame and half a second before act-3's (the take's
    // last frame), so the middle piece holds act-2 and not act-3.
    memory.serveScene(() => {
      const scene = readonlyScene();
      return {
        ...scene,
        edits: {
          ...scene.edits,
          splits: [
            { id: "s1", at: { actionId: "act-2", sourceOffsetMs: 0 } },
            { id: "s2", at: { actionId: "act-3", sourceOffsetMs: -500 } },
          ],
        },
      };
    });
    memory.serveBundle(proceduralBundle({ motionSpans: [] }), null);
    hoverVerdictsMock.mockReset();
    // Scene-aware: still-verdicts for whichever of act-1/2/3 the scene
    // passed in still has. A flat, unconditional mock would not tell a real
    // recompute apart from the gate never having re-armed at all.
    hoverVerdictsMock.mockImplementation(async (scene: SceneDocument) => {
      const present = new Set(scene.actions.map((action) => action.id));
      return ["act-1", "act-2", "act-3"]
        .filter((actionId) => present.has(actionId))
        .map((actionId) => ({ kind: "still" as const, actionId }));
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("recomputes after a piece is removed instead of staying silent for the rest of the session", async () => {
    await import("../../../pages/entrypoints/editor/main");

    await vi.waitFor(() => {
      const button = hoverButton();
      if (!button || !/3 hover moves/.test(button.textContent ?? "")) {
        throw new Error("initial hover report not rendered yet");
      }
    });

    // Removing the middle piece takes act-2 out of the video: select it on
    // the clip, then Delete.
    const pieces = document.querySelectorAll<HTMLElement>("[data-piece]");
    // Premise: two splits make three pieces.
    expect(pieces).toHaveLength(3);
    pieces[1]?.click();
    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Delete", bubbles: true }),
    );

    // The bundle and the action ids never change across this edit. A gate
    // keyed on them alone would leave the banner gone for good; this asserts
    // it comes back, and with the SHRUNK count, so a pass can only mean a
    // real recompute ran against the scene the removal left.
    await vi.waitFor(() => {
      const button = hoverButton();
      if (!button || !/2 hover moves/.test(button.textContent ?? "")) {
        throw new Error("hover report did not recompute after the edit");
      }
    });
  });
});

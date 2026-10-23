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
 * Drives the real `entrypoints/editor/main.ts` through a hover check that is
 * still in flight when the author edits the scene out from under it.
 *
 * `refreshHints` closes over `snapshot.scene` and awaits `hoverVerdicts`,
 * which can take real time (video decode, pixel diffing). If a
 * `deleteAction` lands during that await, `runCommand` nulls `hoverReport`
 * (state.ts's `changesActionIds` guard) precisely so a stale `removable`
 * set is retired — but that guard is only real if nothing overwrites the
 * `null` afterward. `hoverVerdicts` is held pending here so the test can
 * land the edit before letting it resolve, then prove the late write does
 * not land on top of the retirement.
 */

type HoverVerdict = { actionId: string; kind: "still" | "moved" };

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

describe("editor main — a hover check still in flight when the scene changes", () => {
  let memory: MemoryPlatform;
  let putScene: unknown;

  beforeEach(() => {
    vi.resetModules();
    editorDom();
    vi.stubGlobal("OffscreenCanvas", FakeOffscreenCanvas);
    memory = createMemoryPlatform();
    state.memory = memory;
    // One split at act-2's frame: two pieces, so one can be removed.
    memory.serveScene(() => {
      const scene = readonlyScene();
      return {
        ...scene,
        edits: {
          ...scene.edits,
          splits: [{ id: "s1", at: { actionId: "act-2", sourceOffsetMs: 0 } }],
        },
      };
    });
    // `motionSpans: []` so `refreshHints` takes the synchronous,
    // read-nothing `createImageFrameSource` branch.
    memory.serveBundle(proceduralBundle({ motionSpans: [] }), null);
    memory.answer("scenes.put", async (scene: SceneDocument) => {
      putScene = scene;
      return { revision: "r1" };
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("drops a hover verdict that resolves after the scene it was computed against has changed", async () => {
    let resolveStale: (verdicts: HoverVerdict[]) => void = () => undefined;
    const stalePromise = new Promise<HoverVerdict[]>((resolve) => {
      resolveStale = resolve;
    });
    hoverVerdictsMock.mockReset();
    // Any call other than the first (the rearmed recompute a landed edit can
    // trigger — see the id-shape gate in main.ts) settles immediately and
    // harmlessly with nothing removable, so it cannot itself be mistaken for
    // the stale write under test.
    hoverVerdictsMock.mockResolvedValue([]);
    hoverVerdictsMock.mockImplementationOnce(() => stalePromise);

    await import("../../../pages/entrypoints/editor/main");

    await vi.waitFor(() => {
      if (hoverVerdictsMock.mock.calls.length < 1) {
        throw new Error("hoverVerdicts has not been called yet");
      }
    });

    // Removes a piece while the first `hoverVerdicts` call is still
    // pending — the same race the docblock above describes. The second
    // piece is act-2's onward, unrelated to the act-1 verdict resolved
    // below, so a passing test can only mean the drop worked.
    const pieces = document.querySelectorAll<HTMLElement>("[data-piece]");
    // Premise: one split makes two pieces.
    expect(pieces).toHaveLength(2);
    pieces[1]?.click();
    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Delete", bubbles: true }),
    );
    await vi.waitFor(() => {
      if (putScene === undefined)
        throw new Error("the removal has not persisted yet");
    });

    // The stale call finally resolves, well after the scene moved on, with
    // a verdict that WOULD offer a removal if it were allowed to land.
    resolveStale([{ actionId: "act-1", kind: "still" }]);

    // Give the drop's own microtasks (and any rearmed recompute's) room to
    // settle, then assert on steady state rather than a single tick.
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(hoverButton()).toBeNull();
  });
});

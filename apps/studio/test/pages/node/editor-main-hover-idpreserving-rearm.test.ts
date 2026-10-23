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
 * Drives the real `entrypoints/editor/main.ts` through two retirement paths
 * that change neither `bundle` nor the action-id shape, so the gate added
 * for L7a (keyed on exactly those two things) does not by itself re-arm for
 * them:
 *
 * 1. Undo/redo (state.ts) null `hoverReport` unconditionally, including for
 *    an id-preserving command like `rename` — the scene object changes but
 *    its action ids do not.
 * 2. `runCommand` builds a NEW `SceneDocument` object even for an
 *    id-preserving edit, so `refreshHints`'s `stillCurrent()` identity
 *    check drops an in-flight result the moment a rename lands mid-check —
 *    and without a further trigger, nothing ever asks for a recompute
 *    against the scene actually on screen.
 *
 * Both are closed by also gating on `snapshot.hoverReport !== null`.
 */

const hoverVerdictsMock = vi.hoisted(() => vi.fn());
const detectKeyframeMotionMock = vi.hoisted(() => vi.fn());

vi.mock("@demoman/compositor", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@demoman/compositor")>();
  return {
    ...actual,
    detectKeyframeMotion: detectKeyframeMotionMock,
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

describe("editor main — the hover check after a retirement that preserves both the bundle and the action-id shape", () => {
  let memory: MemoryPlatform;

  beforeEach(() => {
    vi.resetModules();
    editorDom();
    vi.stubGlobal("OffscreenCanvas", FakeOffscreenCanvas);
    memory = createMemoryPlatform();
    state.memory = memory;
    memory.serveScene(() => readonlyScene());
    memory.serveBundle(proceduralBundle({ motionSpans: [] }), null);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("recomputes after undoing an id-preserving edit, instead of leaving the banner dark", async () => {
    let putCount = 0;
    memory.answer("scenes.put", async (_scene: SceneDocument) => {
      putCount += 1;
      return { revision: "r1" };
    });
    hoverVerdictsMock.mockReset();
    detectKeyframeMotionMock.mockReset();
    detectKeyframeMotionMock.mockResolvedValue([]);
    // Scene-aware, like the sibling rearm test: still-verdicts for whichever
    // of act-1/2/3 the scene passed in still has. A rename touches none of
    // them, so every call here should keep returning all three.
    hoverVerdictsMock.mockImplementation(async (scene: SceneDocument) => {
      const present = new Set(scene.actions.map((action) => action.id));
      return ["act-1", "act-2", "act-3"]
        .filter((actionId) => present.has(actionId))
        .map((actionId) => ({ kind: "still" as const, actionId }));
    });

    await import("../../../pages/entrypoints/editor/main");

    await vi.waitFor(() => {
      const button = hoverButton();
      if (!button || !/3 hover moves/.test(button.textContent ?? "")) {
        throw new Error("initial hover report not rendered yet");
      }
    });
    const callsBeforeUndo = hoverVerdictsMock.mock.calls.length;

    // Rename: id-preserving, so `runCommand` leaves `hoverReport` as-is —
    // this alone must NOT retire it.
    const nameInput = document.getElementById("name") as HTMLInputElement;
    nameInput.value = "Renamed take";
    nameInput.dispatchEvent(new Event("change"));
    await vi.waitFor(() => {
      if (putCount < 1) throw new Error("rename has not persisted yet");
    });
    expect(hoverButton()).not.toBeNull();

    // Undo the rename. `undo()` (state.ts) nulls `hoverReport`
    // unconditionally while leaving the bundle and the action-id shape both
    // unchanged — the exact gap the gate's bundle+id-shape keys do not
    // cover on their own.
    const undoButton = document.getElementById("undo") as HTMLButtonElement;
    undoButton.click();
    await vi.waitFor(() => {
      if (putCount < 2) throw new Error("undo has not persisted yet");
    });

    await vi.waitFor(() => {
      const button = hoverButton();
      if (!button || !/3 hover moves/.test(button.textContent ?? "")) {
        throw new Error("hover report did not recompute after the undo");
      }
    });
    // A pass on the assertion above could in principle be the ORIGINAL
    // (pre-undo) report never having been touched; this rules that out.
    expect(hoverVerdictsMock.mock.calls.length).toBeGreaterThan(
      callsBeforeUndo,
    );
  });

  it("recomputes after an id-preserving edit lands mid-check, and a subsequent crash still leaves a banner", async () => {
    hoverVerdictsMock.mockReset();
    detectKeyframeMotionMock.mockReset();

    // The first call hangs until the test rejects it by hand — simulating a
    // check that is still decoding when the rename lands. Every later call
    // (the rearm this edit must trigger) rejects immediately: the review's
    // scenario is specifically that the crash and the edit both happen, and
    // the banner must still say so afterward rather than going silent.
    let rejectFirst: (error: unknown) => void = () => undefined;
    const firstCall = new Promise<never>((_, reject) => {
      rejectFirst = reject;
    });
    detectKeyframeMotionMock.mockRejectedValue(
      new Error("simulated decode failure"),
    );
    detectKeyframeMotionMock.mockImplementationOnce(() => firstCall);

    await import("../../../pages/entrypoints/editor/main");

    await vi.waitFor(() => {
      if (detectKeyframeMotionMock.mock.calls.length < 1) {
        throw new Error("the first check has not started yet");
      }
    });

    // Lands the id-preserving edit while that first check is still pending.
    const nameInput = document.getElementById("name") as HTMLInputElement;
    nameInput.value = "Renamed mid-check";
    nameInput.dispatchEvent(new Event("change"));
    await vi.waitFor(() => {
      const el = document.getElementById("name") as HTMLInputElement;
      if (el.value !== "Renamed mid-check") {
        throw new Error("rename has not landed yet");
      }
    });

    // Only now does the stale first check fail — well after the scene
    // moved on, so `stillCurrent()` must drop this particular write.
    rejectFirst(new Error("simulated decode failure"));

    // The rename's own landing is what must have re-armed the gate
    // (`hoverReport` was still `null` at that point — the first check had
    // not written anything yet); confirm a second attempt actually ran
    // rather than the banner just staying empty by coincidence.
    await vi.waitFor(() => {
      if (detectKeyframeMotionMock.mock.calls.length < 2) {
        throw new Error("no recompute was triggered by the rename");
      }
    });

    // The take-wide report is a card in the status row since 2026-09-22
    // (`renderTakeNotes`); it sat on the timeline's own bar from Task 3.
    await vi.waitFor(() => {
      const report = document.getElementById("take-notes");
      if (
        !report ||
        !/could not run|did not run/i.test(report.textContent ?? "")
      ) {
        throw new Error("hover report not rendered yet");
      }
    });
    const report = document.getElementById("take-notes") as HTMLElement;
    expect(report.textContent).toMatch(/could not run|did not run/i);
  });
});

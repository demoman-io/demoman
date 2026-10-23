import type { SceneDocument } from "@demoman/scene-schema";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { proceduralBundle } from "../../../../../packages/replay-engine/test/helpers/bundles";
import { hoverScene } from "../../../../../packages/replay-engine/test/helpers/scenes";
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
 * "Keep this hover" — the per-hover override on the develop-time pixel
 * check — driven against the real `entrypoints/editor/main.ts`.
 *
 * The button exists because the check is sometimes wrong, and an author who
 * disagrees with one verdict must not have to accept it. That makes a Keep
 * that changes nothing observable the exact defect the escape hatch was
 * built to prevent, so this pins both halves of what it does: the clip stops
 * being flagged, and the bulk "Remove N unchanged hovers" offer drops that
 * one from its count.
 *
 * It is deliberately NOT persisted, and that is not an oversight being
 * tested around: the verdict is recomputed from pixels on every develop run,
 * and a later run re-flagging this hover on new evidence is a correct answer
 * to a new question.
 */

const hoverVerdictsMock = vi.hoisted(() => vi.fn());

vi.mock("@demoman/compositor", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@demoman/compositor")>();
  return {
    ...actual,
    // Real motion detection and real frame sources would try to read a
    // frame store jsdom does not have. Neither is what this file tests.
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

const hoverClip = (): HTMLElement | null =>
  document.querySelector('[data-tick="act-h"]');

describe("editor main — keeping one flagged hover", () => {
  let memory: MemoryPlatform;

  beforeEach(() => {
    vi.resetModules();
    editorDom();
    vi.stubGlobal("OffscreenCanvas", FakeOffscreenCanvas);
    memory = createMemoryPlatform();
    state.memory = memory;
    // `hoverScene` puts a real `moveTo` (act-h) between two other actions,
    // which is what gives the cursor lane a clip to flag.
    memory.serveScene(() => hoverScene());
    // `motionSpans: []` so `refreshHints` takes the synchronous
    // `createImageFrameSource` branch rather than awaiting a frame store
    // jsdom does not have.
    memory.serveBundle(proceduralBundle({ motionSpans: [] }), null);
    hoverVerdictsMock.mockReset();
    // Two removable ids, so the count has somewhere to drop TO: a report
    // with one entry would go from a button to no button at all, and
    // "the offer disappeared" is also what a crash looks like.
    hoverVerdictsMock.mockImplementation(async (scene: SceneDocument) => {
      const present = new Set(scene.actions.map((action) => action.id));
      return ["act-h", "act-1"]
        .filter((actionId) => present.has(actionId))
        .map((actionId) => ({ kind: "still" as const, actionId }));
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("clears that hover's flag", async () => {
    await import("../../../pages/entrypoints/editor/main");

    await vi.waitFor(() => {
      const button = hoverButton();
      if (!button || !/2 hover moves/.test(button.textContent ?? "")) {
        throw new Error("hover report not rendered yet");
      }
      if (hoverClip()?.getAttribute("data-flag") !== "unchangedHover") {
        throw new Error("the hover clip is not flagged yet");
      }
    });

    // The author's own two steps: select the hover on the timeline, then
    // Keep it in the panel that opens on it.
    hoverClip()?.click();
    const keep = await vi.waitFor(() => {
      const button = document.querySelector('[data-keep-hover="act-h"]');
      if (!button) throw new Error("Keep not offered on the selected hover");
      return button as HTMLButtonElement;
    });
    keep.click();

    // The flag is what the author sees on the clip, and it is drawn on the
    // timeline tick regardless of what is selected — so it is still visible
    // here even though selecting act-h replaced the demo panel (and its
    // bulk button) with act-h's own step panel.
    expect(hoverClip()?.getAttribute("data-flag")).toBeNull();
    // The step panel's own evidence of the same fact: Keep is offered only
    // while the pixel check still flags this hover.
    expect(document.querySelector('[data-keep-hover="act-h"]')).toBeNull();
    // The bulk button's count reflecting `removable.length` — the second
    // half of what Keep does — is covered at the unit level in
    // `editor-inspector.test.ts` against an arbitrary `hoverReport`; nothing
    // in this design lets an author see the demo panel and a selected
    // step's own panel at once to re-check it live here (there is no
    // deselect gesture yet), so this file's job stops at proving `onKeepHover`
    // reaches `session.setHoverReport` and shows up on screen at all.
    //
    // And the take is untouched: Keep is an argument with the check, not an
    // edit to the demo.
    expect(document.querySelector('[data-tick="act-h"]')).not.toBeNull();
  });
});

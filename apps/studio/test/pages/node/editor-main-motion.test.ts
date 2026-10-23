import {
  migrateToCurrent,
  type SceneCursor,
  type SceneDocument,
  type SceneMotion,
} from "@demoman/scene-schema";
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
 * The Cursor panel's polish rows — Tilt, Click bounce and the Camera group —
 * wired end to end through the real `entrypoints/editor/main.ts`.
 *
 * `editor-view-panels.test.ts` pins which handler each row calls;
 * this file pins what `main.ts` does with it: the drag's own slider survives
 * its `input`, a release commits one undo entry to the saved document, undo
 * takes it back, a saved edit comes back on the next open, and a camera
 * edit re-solves the camera the Zoom lane draws.
 */

vi.mock("@demoman/compositor", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@demoman/compositor")>();
  return {
    ...actual,
    // Real motion detection and a real hover check would read a frame store
    // jsdom does not have. Neither is what this file tests.
    detectKeyframeMotion: vi.fn().mockResolvedValue([]),
    hoverVerdicts: vi.fn().mockResolvedValue([]),
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

/** `readonlyScene` with one zoom on its FIRST action and no authored end,
 *  so the Zoom lane's segment ends where the compositor's own pull-out
 *  lands — a length the smoothness sets — well before the take does. */
function zoomedScene(): SceneDocument {
  const scene = readonlyScene();
  return {
    ...scene,
    camera: [
      {
        id: "cam-1",
        kind: "zoom" as const,
        anchorId: "a-search",
        marker: { actionId: "act-1", offsetMs: 0 },
        scale: 1.6,
      },
    ],
  };
}

const EXPECTED_STDERR = [
  /^Not implemented: HTMLCanvasElement's getContext\(\)/,
  /^the cursor panel could not paint its ".*" preview: no 2D context$/,
];

async function openCursorPanel(): Promise<void> {
  const entry = await vi.waitFor(() => {
    const node = document.querySelector<HTMLButtonElement>(
      '#rail [data-rail="cursor"]',
    );
    if (!node) throw new Error("rail not rendered yet");
    return node;
  });
  entry.click();
  await vi.waitFor(() => {
    if (!document.querySelector("[data-panel-cursor] [data-motion-smoothness]"))
      throw new Error("cursor panel not rendered yet");
  });
}

const slider = (sel: string): HTMLInputElement => {
  const node = document.querySelector<HTMLInputElement>(sel);
  if (!node) throw new Error(`no ${sel}`);
  return node;
};
const readoutOf = (sel: string): string | null | undefined =>
  slider(sel).parentElement?.querySelector(".slider-value")?.textContent;

/** The zoom segment's width on the lane, as `timeline-view.ts` writes it. */
const segmentWidth = (): number => {
  const seg = document.querySelector<HTMLElement>('[data-segment="cam-1"]');
  if (!seg) throw new Error("no zoom segment on the lane");
  return Number.parseFloat(seg.style.width);
};

describe("editor main — the polish rows of the Cursor panel", () => {
  let memory: MemoryPlatform;
  let consoleError: ReturnType<typeof vi.spyOn>;
  let stored: SceneDocument;

  const puts = () => memory.putCalls();
  const saved = (): SceneDocument => {
    const last = puts().at(-1);
    if (!last) throw new Error("the scene was never saved");
    return last.scene as SceneDocument;
  };
  const savedMotion = (): SceneMotion | undefined => saved().motion;
  const savedCursor = (): SceneCursor => saved().cursor;

  beforeEach(() => {
    vi.resetModules();
    editorDom();
    vi.stubGlobal("OffscreenCanvas", FakeOffscreenCanvas);
    const original = console.error.bind(console);
    consoleError = vi
      .spyOn(console, "error")
      .mockImplementation((...args: unknown[]) => {
        const first = args[0];
        if (
          typeof first === "string" &&
          EXPECTED_STDERR.some((line) => line.test(first))
        )
          return;
        original(...args);
      });
    stored = zoomedScene();
    memory = createMemoryPlatform();
    state.memory = memory;
    memory.serveScene(() => stored);
    memory.serveBundle(proceduralBundle({ motionSpans: [] }), null);
  });

  afterEach(() => {
    consoleError.mockRestore();
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  const boot = async (): Promise<void> => {
    await import("../../../pages/entrypoints/editor/main");
    await openCursorPanel();
  };

  // The drag invariant, for a Camera row: the element under the pointer
  // survives its own `input`, and nothing is written until the release.
  it("keeps a dragged camera slider alive, and writes nothing", async () => {
    await boot();
    const smooth = slider("[data-motion-smoothness]");
    smooth.value = "0.9";
    smooth.dispatchEvent(new Event("input"));
    expect(smooth.isConnected).toBe(true);
    expect(document.querySelector("[data-motion-smoothness]")).toBe(smooth);
    expect(readoutOf("[data-motion-smoothness]")).toBe("90%");
    // Past the coalesced recompose, which is where a re-render would land.
    await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
    expect(smooth.isConnected).toBe(true);
    expect(puts()).toHaveLength(0);
  });

  it("keeps a dragged Tilt slider alive, and writes nothing", async () => {
    await boot();
    const tilt = slider("[data-cursor-tilt]");
    tilt.value = "0.9";
    tilt.dispatchEvent(new Event("input"));
    await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
    expect(document.querySelector("[data-cursor-tilt]")).toBe(tilt);
    expect(readoutOf("[data-cursor-tilt]")).toBe("90%");
    expect(puts()).toHaveLength(0);
  });

  it("writes Tilt and Click bounce to the cursor, one undo entry each", async () => {
    await boot();
    const tilt = slider("[data-cursor-tilt]");
    tilt.value = "0.2";
    tilt.dispatchEvent(new Event("input"));
    tilt.dispatchEvent(new Event("change"));
    await vi.waitFor(() => expect(savedCursor().tilt).toBe(0.2));

    const bounce = slider("[data-cursor-bounce]");
    bounce.value = "1.75";
    bounce.dispatchEvent(new Event("change"));
    await vi.waitFor(() => expect(savedCursor().clickBounce).toBe(1.75));
    expect(savedCursor().tilt).toBe(0.2);

    // One undo takes back the bounce and only the bounce.
    document.querySelector<HTMLButtonElement>("#undo")?.click();
    await vi.waitFor(() =>
      expect(readoutOf("[data-cursor-bounce]")).toBe("1.00x"),
    );
    expect(readoutOf("[data-cursor-tilt]")).toBe("20%");
    // And the next takes back the tilt, to the default the document never
    // stored.
    document.querySelector<HTMLButtonElement>("#undo")?.click();
    await vi.waitFor(() => expect(readoutOf("[data-cursor-tilt]")).toBe("50%"));
  });

  it("writes the whole motion block on the first camera edit, and undo takes it back", async () => {
    // Premise: the document starts with no block at all.
    expect(stored.motion).toBeUndefined();
    await boot();
    const blur = slider("[data-motion-blur]");
    blur.value = "0.2";
    blur.dispatchEvent(new Event("input"));
    blur.dispatchEvent(new Event("change"));
    await vi.waitFor(() => expect(savedMotion()?.blur).toBe(0.2));
    expect(savedMotion()).toEqual({ smoothness: 0.5, blur: 0.2, follow: true });
    expect(readoutOf("[data-motion-blur]")).toBe("20%");

    document.querySelector<HTMLButtonElement>("#undo")?.click();
    await vi.waitFor(() => expect(readoutOf("[data-motion-blur]")).toBe("50%"));
    // The undo is saved too, and what it saved has no block again.
    await vi.waitFor(() => expect(savedMotion()).toBeUndefined());
  });

  it("writes Follow cursor from its switch", async () => {
    await boot();
    slider("[data-motion-follow]").click();
    await vi.waitFor(() => expect(savedMotion()?.follow).toBe(false));
    expect(
      document
        .querySelector("[data-motion-follow]")
        ?.getAttribute("aria-checked"),
    ).toBe("false");
  });

  // Persistence: what the editor saved is what the background stores
  // (`scene:put` runs `migrateToCurrent` on it), and the next open shows it.
  it("brings a saved edit back on the next open", async () => {
    await boot();
    const smooth = slider("[data-motion-smoothness]");
    smooth.value = "0.85";
    smooth.dispatchEvent(new Event("change"));
    const tilt = slider("[data-cursor-tilt]");
    tilt.value = "0.15";
    tilt.dispatchEvent(new Event("change"));
    await vi.waitFor(() => expect(savedCursor().tilt).toBe(0.15));

    // The background's own door: validated, upgraded, kept.
    const kept = migrateToCurrent(saved());
    expect(kept.motion?.smoothness).toBe(0.85);
    expect(kept.cursor.tilt).toBe(0.15);

    // A fresh editor over the stored document.
    stored = kept;
    vi.resetModules();
    editorDom();
    await boot();
    expect(slider("[data-motion-smoothness]").value).toBe("0.85");
    expect(readoutOf("[data-motion-smoothness]")).toBe("85%");
    expect(slider("[data-cursor-tilt]").value).toBe("0.15");
  });

  /**
   * A camera edit re-solves the camera. The Zoom lane draws each zoom from
   * `resolved.cameraSegments`, and a zoom with no authored end runs its hold
   * plus a pull-out whose length the smoothness sets
   * (`motionTimings.zoomOutMs`, 700ms at 0 to 1150ms at 1) — so if the
   * resolved plan were cached across a motion edit, the segment would keep
   * its old width.
   */
  it("re-solves the camera the Zoom lane draws when the smoothness moves", async () => {
    await boot();
    await vi.waitFor(() => segmentWidth());
    const before = segmentWidth();
    // Premise: the segment is a real, unclamped run, not pinned to the end
    // of the take — otherwise a longer pull-out could not lengthen it.
    expect(before).toBeGreaterThan(0);
    expect(before).toBeLessThan(80);

    const smooth = slider("[data-motion-smoothness]");
    smooth.value = "1";
    smooth.dispatchEvent(new Event("change"));
    await vi.waitFor(() => expect(savedMotion()?.smoothness).toBe(1));
    await vi.waitFor(() => expect(segmentWidth()).toBeGreaterThan(before));

    // And undo puts the camera back, not just the slider.
    document.querySelector<HTMLButtonElement>("#undo")?.click();
    await vi.waitFor(() => expect(segmentWidth()).toBeCloseTo(before, 6));
  });
});

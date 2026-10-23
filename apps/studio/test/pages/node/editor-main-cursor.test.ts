import type { SceneCursor } from "@demoman/scene-schema";
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

const putAssetMock = vi.hoisted(() => vi.fn(async () => undefined));

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

/** One click to the Cursor panel, as `pickLogo` reaches Background. */
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
    if (!document.querySelector("[data-panel-cursor] [data-cursor-scale]")) {
      throw new Error("cursor panel not rendered yet");
    }
  });
}

/** The scene as it was last written back. */
function savedCursor(memory: MemoryPlatform) {
  const puts = memory.putCalls();
  const last = puts[puts.length - 1];
  if (!last) throw new Error("the scene was never saved");
  return (last.scene as { cursor: SceneCursor }).cursor;
}

/**
 * The two lines this file expects on stderr, both from the same cause:
 * jsdom has no 2D canvas context, so each of the three style previews takes
 * `stylePreview`'s fallback. The first is jsdom's own report of the refused
 * `getContext` (it reaches `console.error` through the default virtual
 * console); the second is the editor's.
 *
 * Anything else is a fault and stays audible — see the spy below.
 */
const EXPECTED_STDERR = [
  /^Not implemented: HTMLCanvasElement's getContext\(\)/,
  /^the cursor panel could not paint its ".*" preview: no 2D context$/,
];

describe("editor main — the Cursor panel", () => {
  let memory: MemoryPlatform;

  // Opening the panel builds the three style-preview buttons, and jsdom has
  // no 2D canvas context, so every one of them takes `stylePreview`'s
  // fallback and prints a "no 2D context" line to stderr — noise this
  // repo's own rule treats as a finding. Swallowed here rather than
  // asserted: the fallback itself is already pinned by
  // `editor-view-panels.test.ts`'s "says so when a style button cannot
  // paint its preview", so this describe only needs stderr quiet, not a
  // second copy of that assertion.
  //
  // A FILTER, not a mute. `mockImplementation(() => undefined)` silenced
  // every `console.error` the editor makes during these tests —
  // `demoPanel`'s missing-container report, `reportError`, the inspector's
  // "rendered nothing" — so a real failure in this file's own paths would
  // have run past in silence, which is the house rule inverted. Anything
  // that is not one of the two expected lines goes back out through the
  // original.
  let consoleError: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.resetModules();
    editorDom();
    vi.stubGlobal("OffscreenCanvas", FakeOffscreenCanvas);
    putAssetMock.mockClear();
    const original = console.error.bind(console);
    consoleError = vi
      .spyOn(console, "error")
      .mockImplementation((...args: unknown[]) => {
        const first = args[0];
        if (
          typeof first === "string" &&
          EXPECTED_STDERR.some((line) => line.test(first))
        ) {
          return;
        }
        original(...args);
      });
    memory = createMemoryPlatform();
    state.memory = memory;
    memory.serveScene(() => readonlyScene());
    memory.serveBundle(null, null);
  });

  afterEach(() => {
    consoleError.mockRestore();
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("fills the panel with all five controls", async () => {
    await import("../../../pages/entrypoints/editor/main");
    await openCursorPanel();
    for (const attr of [
      "data-cursor-hidden",
      "data-cursor-scale",
      "data-cursor-blur",
      "data-cursor-idle",
    ]) {
      expect(document.querySelector(`[${attr}]`)).not.toBeNull();
    }
    expect(document.querySelectorAll("[data-cursor-style]").length).toBe(3);
  });

  it("commits a style to the scene", async () => {
    await import("../../../pages/entrypoints/editor/main");
    await openCursorPanel();
    document
      .querySelector<HTMLButtonElement>('[data-cursor-style="dark"]')
      ?.click();
    await vi.waitFor(() => {
      if (savedCursor(memory).style !== "dark")
        throw new Error("not saved yet");
    });
    expect(savedCursor(memory).style).toBe("dark");
  });

  // The invariant behind the whole drag, stated on the DOM: the element the
  // author's pointer is resting on has to SURVIVE its own `input`.
  //
  // This test used to hold a reference, dispatch `input`, and then wait for
  // a freshly queried `[data-cursor-scale]` to read 1.8 — which asserted
  // that the panel had been REPLACED and called that a drag. It passed while
  // neither slider could be dragged at all: `onCursorPreview` ran a full
  // `render()`, that detached the live `<input type="range">`, and Blink
  // ended the drag with the pointer capture it held. A synthetic `input` on
  // a retained reference cannot see that, which is why the browser lane's
  // `editor-cursor-panel.test.ts` drives a real mouse drag as well; this
  // one is what guards `main.ts`'s own wiring, which that lane never loads.
  it("keeps the dragged slider itself alive, and writes nothing", async () => {
    await import("../../../pages/entrypoints/editor/main");
    await openCursorPanel();
    const scale = document.querySelector<HTMLInputElement>(
      "[data-cursor-scale]",
    );
    if (!scale) throw new Error("no size slider");
    scale.value = "1.8";
    scale.dispatchEvent(new Event("input"));
    // Still in the document, and still the node the panel is showing: a
    // re-render would have replaced it with an equal-looking one.
    expect(scale.isConnected).toBe(true);
    expect(document.querySelector("[data-cursor-scale]")).toBe(scale);
    // So the retained element's own value is what the preview is composing,
    // and the readout above it moved in place rather than being rebuilt.
    expect(scale.value).toBe("1.8");
    expect(
      scale.parentElement?.querySelector(".slider-value")?.textContent,
    ).toBe("1.80x");
    // The preview is coalesced onto an animation frame; this one resolves
    // after it, so the test also covers what that frame does — and does not
    // leave it pending past teardown.
    await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
    expect(scale.isConnected).toBe(true);
    // Nothing reached the undo stack or the store.
    expect(memory.putCalls().length > 0).toBe(false);
  });

  /**
   * A render ends the drag whether or not it meant to, so the preview
   * override must not survive it.
   *
   * `render` rebuilds the Cursor panel, which detaches the
   * `<input type="range">` the pointer is captured to — so after any render
   * no `change` can follow, and `onCursor`, the only thing that used to drop
   * the override, never runs. `main.ts` reaches `render` from the
   * `share:progress` broadcast and from the render `output`/`finished`
   * handlers, none of which knows a slider is down.
   *
   * Undo is the cheapest render to drive from here, and it is also where the
   * bug was visible: the stale patch is layered by `liveCursor` on every
   * snapshot, so the panel and the canvas kept showing the abandoned value
   * while `renderScene` — which reads `session.snapshot().scene` — still
   * exported the stored one. Preview and deliverable disagreed, and nothing
   * said so.
   */
  it("drops an abandoned drag's override when something else renders", async () => {
    await import("../../../pages/entrypoints/editor/main");
    await openCursorPanel();
    const committed = document.querySelector<HTMLInputElement>(
      "[data-cursor-scale]",
    );
    if (!committed) throw new Error("no size slider");
    // A real commit first, so the document's own value is not the default
    // and an override left behind is distinguishable from one that was not.
    committed.value = "1.8";
    committed.dispatchEvent(new Event("input"));
    committed.dispatchEvent(new Event("change"));
    await vi.waitFor(() => {
      if (savedCursor(memory).scale !== 1.8) throw new Error("not saved yet");
    });

    // Now a drag that is never released: `input` only, which is exactly the
    // state the author's pointer is in when a broadcast lands.
    const dragged = document.querySelector<HTMLInputElement>(
      "[data-cursor-scale]",
    );
    if (!dragged) throw new Error("no size slider after the commit");
    dragged.value = "1.2";
    dragged.dispatchEvent(new Event("input"));

    document.querySelector<HTMLButtonElement>("#undo")?.click();
    await vi.waitFor(() => {
      const after = document.querySelector<HTMLInputElement>(
        "[data-cursor-scale]",
      );
      if (!after) throw new Error("no size slider after the undo");
      if (after.value === "1.2") {
        throw new Error("the abandoned drag is still overriding the document");
      }
      // Undo returns the scene to the default, which is where this began.
      expect(after.value).toBe("1");
      expect(
        after.parentElement?.querySelector(".slider-value")?.textContent,
      ).toBe("1.00x");
    });
  });

  it("writes the value when the drag is released", async () => {
    await import("../../../pages/entrypoints/editor/main");
    await openCursorPanel();
    const scale = document.querySelector<HTMLInputElement>(
      "[data-cursor-scale]",
    );
    if (!scale) throw new Error("no size slider");
    scale.value = "1.8";
    scale.dispatchEvent(new Event("input"));
    scale.dispatchEvent(new Event("change"));
    await vi.waitFor(() => {
      if (savedCursor(memory).scale !== 1.8) throw new Error("not saved yet");
    });
    expect(savedCursor(memory).scale).toBe(1.8);
  });
});

import { madeFromOf } from "@demoman/compositor";
import type { SceneDocument } from "@demoman/scene-schema";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  captureBundle,
  proceduralBundle,
} from "../../../../../packages/replay-engine/test/helpers/bundles";
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

// Every `madeFrom` below matches `readonlyScene()`'s own actions — `scene()`
// only ever flips `meta.renderMode`, never `actions` — so the frames read as
// verifiable and this file's `afterEach` console guard sees the approximate
// path this file is not testing stay silent.
const MADE_FROM = madeFromOf(readonlyScene());

/**
 * The render-mode question, absent — and the one control that survives it —
 * driven against the real `entrypoints/editor/main.ts`.
 *
 * Until Task 10 this file drove `renderRenderMode`, `renderFullQuality`,
 * `adoptDemoModeIfComplete` and `useRecordedTake` through a dedicated
 * `#render-mode` / `[data-panel-mode]` control: "Recording or Rebuild?" —
 * decision 1 of spec §2, "replay is a repair tool, never a mode". That
 * control, its Source disclosure and `renderFailure`'s retry button are all
 * gone, and so are the approximations chip and its "Back to your recording"
 * button (plan 2, Task 6): that control now lives on the library card. And
 * since plan 2's Task 7 the rebuild itself is gone from the editor — Export
 * only encodes, and a frameless take is sent to Runs. What is left here is
 * proving the absence — Step 1's four requirements.
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

// The editor page reads frames straight from IndexedDB, which the node lane
// has no implementation of; every read used to fail with "indexedDB is not
// defined" and print a stack. A named refusal keeps the failure path these
// tests exercise, and says what it is.
// The refusal above is for the preview's DRAW. The hover check shares the
// preview's frame source, and the real video source decodes every span when
// it is built, so the same refusal failed the check too. The lazy image
// source loads nothing until a draw asks; motion detection and the hover
// check answer nothing. Plain functions, so a mock restore has nothing to
// strip.
vi.mock("@demoman/compositor", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@demoman/compositor")>();
  return {
    ...actual,
    createVideoFrameSource: async (
      ...args: Parameters<typeof actual.createImageFrameSource>
    ) => actual.createImageFrameSource(...args),
    detectKeyframeMotion: async () => [],
    hoverVerdicts: async () => [],
  };
});

const scene = (mode?: "screen" | "demo"): SceneDocument => {
  const base = readonlyScene();
  return mode === undefined
    ? base
    : { ...base, meta: { ...base.meta, renderMode: mode } };
};

/** A scene that is stale-shaped: retexted since the frames were made, but
 *  the frames themselves unchanged — the state that used to offer a rebuild
 *  (the chip's, then Export's "Rebuild and export"). */
const retextedScene = (): SceneDocument => {
  const base = readonlyScene();
  return {
    ...base,
    actions: base.actions.map((a) =>
      a.id === "act-1" && a.kind === "type" ? { ...a, text: "orders" } : a,
    ),
  };
};

describe("editor main — the render-mode question is gone", () => {
  // The editor reports through `console.error`; anything on it is a path
  // this file did not mean to run. jsdom's own "Not implemented" is
  // excepted: a draw that succeeded is blitted onto a canvas jsdom has no
  // 2D context for, and that is jsdom naming its gap, not the editor.
  let reported: ReturnType<typeof vi.spyOn>;
  let memory: MemoryPlatform;
  /** What the next open reads: the last write, or the case's own take. */
  let current: SceneDocument;
  let puts: SceneDocument[];

  /** Boots main.ts and waits for the timeline to have rendered — the one
   *  signal every scenario below shares, frames or none. */
  async function boot(): Promise<void> {
    await import("../../../pages/entrypoints/editor/main");
    await vi.waitFor(() => {
      if (!document.querySelector('[data-tick="act-1"]')) {
        throw new Error("timeline not rendered yet");
      }
    });
  }

  beforeEach(() => {
    vi.resetModules();
    reported = vi.spyOn(console, "error");
    editorDom();
    puts = [];
    vi.stubGlobal("OffscreenCanvas", FakeOffscreenCanvas);
    vi.stubGlobal("requestAnimationFrame", (fn: () => void) => {
      setTimeout(fn, 0);
      return 1;
    });
    memory = createMemoryPlatform();
    state.memory = memory;
    current = scene("screen");
    memory.serveScene(() => current);
    memory.answer("scenes.put", async (doc: SceneDocument) => {
      puts.push(doc);
      // The next open must read what was just written, or a reload after
      // the write would read the old mode straight back.
      current = doc;
      return { revision: `r${puts.length}` };
    });
  });

  afterEach(() => {
    const said = reported.mock.calls
      .map((c) => c.map(String).join(" "))
      .filter((line) => !line.startsWith("Not implemented: HTMLCanvasElement"));
    reported.mockRestore();
    vi.unstubAllGlobals();
    vi.resetModules();
    expect(said).toEqual([]);
  });

  // Step 1, requirement 1. "Recording or Rebuild?" is not asked — decision 1
  // of spec §2. This file only has to show nothing asks the question.
  it("asks nothing about where the frames came from, on a recording take", async () => {
    memory.answer("bundles.active", async () => ({
      bundle: captureBundle({ madeFrom: MADE_FROM }),
      capture: null,
      replay: null,
    }));
    await boot();

    expect(document.querySelector("[data-render-mode]")).toBeNull();
    expect(document.querySelector("[data-panel-mode]")).toBeNull();
    expect(document.body.textContent).not.toMatch(
      /use your recording|this demo uses your recording/i,
    );
  });

  it("asks nothing about where the frames came from, on a rebuilt take", async () => {
    current = scene("demo");
    memory.answer("bundles.active", async () => ({
      bundle: proceduralBundle({ madeFrom: MADE_FROM }),
      capture: null,
      replay: { outcome: "complete", reason: null, completed: 3, total: 3 },
    }));
    await boot();

    // Fixture guard: the bundle on screen really is the replay one, or the
    // absence above proves nothing about a rebuilt take specifically.
    expect(proceduralBundle().source).toBe("replay");
    expect(document.querySelector("[data-render-mode]")).toBeNull();
    expect(document.querySelector("[data-panel-mode]")).toBeNull();
    expect(document.body.textContent).not.toMatch(
      /use your recording|this demo uses your recording/i,
    );
  });

  // Step 1, requirement 2.
  it("offers no rebuild button anywhere, the Export panel included", async () => {
    current = retextedScene();
    memory.answer("bundles.active", async () => ({
      // `madeFrom` reflects the UNTEXTED scene — what the frames were
      // actually made from — so act-1's new text is not in the frames:
      // the take a rebuild used to be offered on.
      bundle: captureBundle({ madeFrom: MADE_FROM }),
      capture: null,
      replay: null,
    }));
    await boot();

    expect(document.querySelector("[data-regenerate]")).toBeNull();
    expect(document.querySelector("[data-render-full-quality]")).toBeNull();
    // The premise: an editor that drew nothing at all would pass the two
    // assertions above for the wrong reason. The Export panel is where the
    // last rebuild control lived, and it has to actually be up.
    const start = await vi.waitFor(() => {
      const found = document.querySelector("[data-export-start]");
      if (!found) throw new Error("Export panel not drawn yet");
      return found;
    });
    expect(start.textContent).toBe("Export MP4");
    expect(
      document.querySelector("[data-panel-export]")?.textContent,
    ).not.toMatch(/rebuild|as previewed/i);
  });

  // Step 1, requirement 3. The one banner state that survives.
  it("still says a take has no frames", async () => {
    memory.answer("bundles.active", async () => ({
      bundle: null,
      capture: null,
      replay: null,
    }));
    await boot();

    // The studio's re-film line (`nav.rerun`); the extension's said
    // "re-shoot it in Runs".
    expect(document.getElementById("banner")?.textContent).toMatch(
      /^This take has no frames — Ask your agent to re-record this take/,
    );
  });

  // Step 1, requirement 4. `renderFailure`'s retry button is gone; the
  // sentence stays, in re-shoot words since plan 2's Task 7 (a re-shoot on
  // the run page is what writes this status now).
  it("still says why the last re-shoot stopped", async () => {
    memory.answer("bundles.active", async () => ({
      bundle: captureBundle({ madeFrom: MADE_FROM }),
      capture: null,
      replay: {
        outcome: "partial",
        reason: "anchorNotRendered",
        completed: 1,
        total: 3,
      },
    }));
    await boot();

    const box = await vi.waitFor(() => {
      const found = document.querySelector("[data-replay-failure]");
      if (!found) throw new Error("replay failure box not rendered yet");
      return found;
    });
    expect(box.textContent).toMatch(/re-shoot/i);
    expect(box.textContent).not.toMatch(/rebuil/i);
    expect(document.querySelector("button[data-retry-regenerate]")).toBeNull();
  });
});

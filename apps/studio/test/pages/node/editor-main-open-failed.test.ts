import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readonlyScene } from "../../../../../packages/replay-engine/test/helpers/scenes";
import { editorDom } from "../helpers/editor-dom";
import {
  createMemoryPlatform,
  type MemoryPlatform,
} from "../helpers/memory-platform";

/**
 * What the editor says when the take cannot be opened at all — the take
 * deleted under it, the studio gone with the editor still open, the read
 * refused. `session.load()` rejected into `reportError`, so the author got
 * a blank shell and a console line nobody was looking at.
 *
 * Boots the real `main.ts` against the in-memory platform (moved from
 * apps/extension's faked `chrome.runtime`, 2026-10-20).
 */

const state = vi.hoisted(() => ({ memory: null as MemoryPlatform | null }));
// The real module's other exports (the studio's own copy, such as
// `refilmLine`) stay; only the platform the page builds is the memory one.
vi.mock("#platform", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  createPlatform: () => state.memory,
}));

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

const SCENE = readonlyScene();
const failureText = () => document.getElementById("failure")?.textContent ?? "";

describe("editor main — a take that cannot be opened", () => {
  let memory: MemoryPlatform;
  let errors: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.resetModules();
    history.replaceState({}, "", `/editor.html?scene=${SCENE.meta.id}`);
    editorDom();
    vi.stubGlobal("OffscreenCanvas", FakeOffscreenCanvas);
    memory = createMemoryPlatform({
      scenes: [SCENE],
      bundles: { [SCENE.meta.id]: null },
    });
    state.memory = memory;
    // The failure is still reported to the console for the developer; the
    // spy keeps that line out of the test output and lets a test assert it.
    errors = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    errors.mockRestore();
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("says so, with the studio's reason, when the take's read is refused", async () => {
    memory.answer("scenes.get", async () => {
      throw new Error("scene.json could not be read: EACCES");
    });
    await import("../../../pages/entrypoints/editor/main");

    await vi.waitFor(() => {
      if (!/could not be opened/.test(failureText())) {
        throw new Error("open failure not shown yet");
      }
    });
    expect(failureText()).toContain("scene.json could not be read: EACCES");
  });

  it("says so when the take is gone", async () => {
    // A deleted take reads back as null (`http.ts` on `takeNotFound`).
    memory.answer("scenes.get", async () => null);
    await import("../../../pages/entrypoints/editor/main");

    await vi.waitFor(() => {
      if (!/could not be opened/.test(failureText())) {
        throw new Error("open failure not shown yet");
      }
    });
    expect(failureText()).toMatch(/no scene/);
  });

  it("says so when the studio does not answer", async () => {
    // The studio stopped under an open editor: every request rejects.
    const gone = async () => {
      throw new Error(
        "The studio did not answer GET /api/takes (Failed to fetch).",
      );
    };
    memory.answer("scenes.get", gone);
    memory.answer("bundles.active", gone);
    await import("../../../pages/entrypoints/editor/main");

    await vi.waitFor(() => {
      if (!/could not be opened/.test(failureText())) {
        throw new Error("open failure not shown yet");
      }
    });
    expect(failureText()).toContain("The studio did not answer");
  });

  it("says so when the frames cannot be read", async () => {
    // The bundle read refused. This used to be read as "no frames yet" —
    // the pre-replay state — and the page told the author to regenerate.
    memory.answer("bundles.active", async () => {
      throw new Error("bundle.json could not be read");
    });
    await import("../../../pages/entrypoints/editor/main");

    await vi.waitFor(() => {
      if (!/could not be opened/.test(failureText())) {
        throw new Error("open failure not shown yet");
      }
    });
    expect(failureText()).toContain("bundle.json could not be read");
  });

  it("shows nothing of the sort when the take opens", async () => {
    // Positive control for the four above: the box is absent on a take
    // that loads, so a renderer that always printed it would fail here.
    await import("../../../pages/entrypoints/editor/main");
    await vi.waitFor(() => {
      if (!document.querySelector('[data-tick="act-1"]')) {
        throw new Error("timeline not rendered yet");
      }
    });
    expect(failureText()).not.toMatch(/could not be opened/);
    // Premise: the editor read this take through the platform, not some
    // other door.
    expect(memory.calls).toContainEqual({
      member: "scenes",
      method: "get",
      args: [SCENE.meta.id],
    });
  });
});

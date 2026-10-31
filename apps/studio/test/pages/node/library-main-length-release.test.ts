import type { SceneDocument } from "@demoman/scene-schema";
import type { VideoSummary } from "@demoman/studio-protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createMemoryPlatform,
  type MemoryPlatform,
} from "../helpers/memory-platform";

/**
 * A redraw lets go of the Length cells it replaced: a cell that was never
 * on screen stays observed otherwise, holding its closure and scene for
 * the life of the page. The real entrypoint over the memory platform.
 */

const state = vi.hoisted(() => ({ memory: null as MemoryPlatform | null }));
vi.mock("#platform", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  createPlatform: () => state.memory,
}));

// The page does not pass a view to `renderLibrary` yet, so the list is
// asked for here, in the call the page makes.
vi.mock("../../../pages/src/library/view", async (importOriginal) => {
  const real =
    await importOriginal<typeof import("../../../pages/src/library/view")>();
  return {
    ...real,
    renderLibrary: (...a: Parameters<typeof real.renderLibrary>) =>
      real.renderLibrary(a[0], a[1], a[2], a[3], a[4], a[5], a[6], {
        layout: "list",
        sort: { column: "recorded", descending: true },
      }),
  };
});

const take = (id: string, createdAt: string): SceneDocument =>
  ({
    meta: {
      id,
      name: "Create an invoice",
      createdAt,
      capture: { originUrl: "https://app.test/invoices" },
    },
  }) as unknown as SceneDocument;

const video: VideoSummary = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Create an invoice",
  repo: { unknown: true },
  startPage: "https://app.test/",
  versions: 2,
  current: {
    version: 2,
    takeId: "inv-2",
    recordedAt: "2026-10-01T00:00:00Z",
    expired: false,
  },
  pages: [],
  steps: [],
  exports: [],
};

describe("library main — length cells", () => {
  const observed = new Set<Element>();

  beforeEach(() => {
    vi.resetModules();
    observed.clear();
    // Never reports an intersection: every Length cell stays unmeasured.
    vi.stubGlobal(
      "IntersectionObserver",
      class {
        observe = (e: Element) => void observed.add(e);
        unobserve = (e: Element) => void observed.delete(e);
        disconnect = () => observed.clear();
      },
    );
    document.body.innerHTML = `
      <div id="notice" class="hidden" role="alert"></div>
      <main id="root"></main>
    `;
    state.memory = createMemoryPlatform({
      scenes: [
        take("inv-1", "2026-09-20T10:00:00Z"),
        take("inv-2", "2026-10-01T10:00:00Z"),
      ],
      videos: [video],
      videoOf: {
        "inv-1": { videoId: video.id, version: 1, expired: false, exports: [] },
        "inv-2": { videoId: video.id, version: 2, expired: false, exports: [] },
      },
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("observes no Length cell of a drawing the page has since replaced", async () => {
    await import("../../../pages/entrypoints/library/main");
    const lengthCells = () => [
      ...document.querySelectorAll<HTMLElement>('[data-col="length"]'),
    ];
    const first = await vi.waitFor(() => {
      const cells = lengthCells().filter((c) => c.closest("[data-scene]"));
      if (cells.length === 0) throw new Error("no list rows drawn yet");
      return cells;
    });
    // Premise: the stand-in holds the first drawing's cells.
    expect(first.every((c) => observed.has(c))).toBe(true);

    state.memory?.emitTakes();
    await vi.waitFor(() => {
      if (first.some((c) => c.isConnected)) throw new Error("not redrawn yet");
    });

    // Premise: the redraw drew new cells, and they are observed.
    const second = lengthCells().filter((c) => c.closest("[data-scene]"));
    expect(second.length).toBe(first.length);
    expect(second.every((c) => observed.has(c))).toBe(true);
    expect([...observed].filter((e) => !e.isConnected)).toEqual([]);
  });
});

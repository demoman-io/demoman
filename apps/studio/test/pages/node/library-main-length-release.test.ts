import type { SceneDocument } from "@demoman/scene-schema";
import type { VideoSummary } from "@demoman/studio-protocol";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  type MockInstance,
  vi,
} from "vitest";
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
    // Premise: the memory platform serves the studio's default, the list.
    await vi.waitFor(() => {
      if (document.querySelector("[role=treegrid]") === null) {
        throw new Error("no list drawn yet");
      }
    });
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

/**
 * What a Length cell says when it cannot be measured, over the real
 * entrypoint with no IntersectionObserver, so every cell measures at once.
 */
describe("library main — a length that cannot be measured", () => {
  const leadCell = () =>
    document.querySelector<HTMLElement>(
      `[role=row][data-key="f:${video.id}"] [data-col="length"]`,
    );
  /** The flow row's Length cell once it says `title`. */
  const says = (title: string) =>
    vi.waitFor(() => {
      const cell = leadCell();
      if (cell?.title !== title) {
        throw new Error(`the cell says ${cell?.textContent} "${cell?.title}"`);
      }
      return cell;
    });

  let warn: MockInstance<typeof console.warn>;
  beforeEach(() => {
    vi.resetModules();
    vi.stubGlobal("IntersectionObserver", undefined);
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
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
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  // Red: a thrown measure, or the no-frames answer, kept for the session,
  // so the redraws below repaint the first answer.
  it("says each failure, and a redraw measures again", async () => {
    let answer: "throw first" | "no frames" | "throw second" = "throw first";
    state.memory?.answer("bundles.active", async () => {
      if (answer === "no frames") {
        return { bundle: null, replay: null, capture: null };
      }
      throw new Error(answer === "throw first" ? "first" : "second");
    });
    await import("../../../pages/entrypoints/library/main");
    const first = await says("first");
    expect(first.textContent).toBe("—");
    expect(warn.mock.calls.flat().join("\n")).toContain(
      "length of inv-2 could not be measured: first",
    );

    answer = "no frames";
    state.memory?.emitTakes();
    expect((await says("it has no frames")).textContent).toBe("—");

    answer = "throw second";
    state.memory?.emitTakes();
    expect((await says("second")).textContent).toBe("—");
  });

  // Red: `measure`'s early return, which left the cell empty and said
  // nothing.
  it("a row whose document the last listing lacks says so", async () => {
    // The listing and the page's map of it drift only if a document's id
    // reads one way for the map and another for the rows: the first read
    // after this point answers an id no row has.
    const doc = take("loose", "2026-10-02T10:00:00Z");
    let drift = true;
    const meta = doc.meta as { id: string };
    Object.defineProperty(meta, "id", {
      get: () => {
        if (!drift) return "loose";
        drift = false;
        return "drifted";
      },
    });
    state.memory = createMemoryPlatform({ scenes: [doc] });
    drift = true;
    await import("../../../pages/entrypoints/library/main");
    const cell = await vi.waitFor(() => {
      const c = document.querySelector<HTMLElement>(
        '[role=row][data-key="t:loose"] [data-col="length"]',
      );
      if (c === null) throw new Error("no row for the take yet");
      return c;
    });
    // Premise: the drifted read was spent.
    expect(drift).toBe(false);
    expect([cell.textContent, cell.title]).toEqual([
      "—",
      "no document for loose in the last listing",
    ]);
    expect(warn.mock.calls.flat().join("\n")).toContain(
      "length of loose could not be measured: no document for loose in the last listing",
    );
  });
});

import type { SceneDocument } from "@demoman/scene-schema";
import {
  DEFAULT_LIBRARY_VIEW,
  type LibraryViewChoice,
  type VideoSummary,
} from "@demoman/studio-protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createMemoryPlatform,
  type MemoryPlatform,
} from "../helpers/memory-platform";

/**
 * The page shows the view the studio serves, and keeps the author's choice
 * (list spec §1). The real entrypoint over the memory platform.
 *
 * Red if `main.ts` stops passing its view to `renderLibrary` (the List case
 * draws cards), picks a layout of its own (the Grid case draws a list),
 * fetches the folder again on a toggle, drops a write's rejection, or
 * says nothing of an unreadable stored view.
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

const GRID: LibraryViewChoice = {
  layout: "grid",
  sort: { column: "recorded", descending: true },
};

const treegrid = () => document.querySelector("[role=treegrid]");
const cards = () => document.querySelectorAll("article.card");
const calls = (member: string, method: string) =>
  state.memory?.calls.filter(
    (c) => c.member === member && c.method === method,
  ) ?? [];

/** The page has drawn its first pass. */
async function drawn(): Promise<void> {
  await import("../../../pages/entrypoints/library/main");
  await vi.waitFor(() => {
    if (treegrid() === null && cards().length === 0) {
      throw new Error("nothing drawn yet");
    }
  });
}

function button(selector: string): HTMLButtonElement {
  const b = document.querySelector<HTMLButtonElement>(selector);
  if (b === null) throw new Error(`no ${selector} drawn`);
  return b;
}

describe("library main — the view", () => {
  beforeEach(() => {
    vi.resetModules();
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
    vi.resetModules();
  });

  it("the page draws List when the studio serves the default", async () => {
    // Premise: the memory platform serves the protocol's default, a list.
    expect(DEFAULT_LIBRARY_VIEW.layout).toBe("list");
    await drawn();
    expect(treegrid()).not.toBeNull();
    expect(cards().length).toBe(0);
    expect(button('[data-layout="list"]').getAttribute("aria-pressed")).toBe(
      "true",
    );
  });

  it("draws Grid when it serves grid", async () => {
    state.memory?.answer("libraryView.read", async () => ({ view: GRID }));
    await drawn();
    expect(treegrid()).toBeNull();
    expect(cards().length).toBeGreaterThan(0);
    expect(button('[data-layout="grid"]').getAttribute("aria-pressed")).toBe(
      "true",
    );
  });

  it("the toggle writes the choice and redraws without a fetch of the library", async () => {
    await drawn();
    const reads = calls("folder", "read").length;
    // Premise: the first pass read the folder.
    expect(reads).toBeGreaterThan(0);

    button('[data-layout="grid"]').click();

    expect(treegrid()).toBeNull();
    expect(cards().length).toBeGreaterThan(0);
    expect(calls("libraryView", "write").map((c) => c.args[0])).toEqual([
      { layout: "grid", sort: DEFAULT_LIBRARY_VIEW.sort },
    ]);
    // A whole turn, not a microtask: a render the toggle started reaches
    // the folder only after the refresher's queue and the view read.
    await new Promise((resolve) => setTimeout(resolve));
    expect(calls("folder", "read").length).toBe(reads);
  });

  it("a sort click writes the new sort", async () => {
    await drawn();
    button('[data-sort="size"]').click();
    expect(calls("libraryView", "write").map((c) => c.args[0])).toEqual([
      { layout: "list", sort: { column: "size", descending: true } },
    ]);
    // The redraw shows it: the Size heading is the sorted one now.
    expect(
      document
        .querySelector('[role=columnheader][data-col="size"]')
        ?.getAttribute("aria-sort"),
    ).toBe("descending");
  });

  it("an unreadable view is said on the console and List still draws", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    state.memory?.answer("libraryView.read", async () => ({
      view: DEFAULT_LIBRARY_VIEW,
      unreadable: "settings.json is not JSON",
    }));
    await drawn();
    expect(treegrid()).not.toBeNull();
    expect(warn.mock.calls.flat().join(" ")).toContain(
      "settings.json is not JSON",
    );
  });

  it("a read that fails is said on the console and the studio's default draws", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    state.memory?.answer("libraryView.read", async () => {
      throw new Error("the studio is gone");
    });
    await drawn();
    expect(treegrid()).not.toBeNull();
    expect(warn.mock.calls.flat().join(" ")).toContain("the studio is gone");
  });

  it("a write that fails is said on the notice line and the view stays as chosen for this session", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    state.memory?.answer("libraryView.write", async () => {
      throw new Error("the disk is full");
    });
    await drawn();
    button('[data-layout="grid"]').click();

    const notice = document.querySelector<HTMLElement>("#notice");
    await vi.waitFor(() => {
      if (notice?.classList.contains("hidden") !== false) {
        throw new Error("nothing said yet");
      }
    });
    expect(notice?.textContent).toBe(
      "The view was not saved: the disk is full.",
    );
    expect(warn.mock.calls.flat().join(" ")).toContain("the disk is full");
    // Not reset: Grid is still drawn, and still after the next pass.
    const before = cards()[0];
    expect(before).toBeDefined();
    state.memory?.emitTakes();
    await vi.waitFor(() => {
      if (before?.isConnected !== false) throw new Error("not redrawn yet");
    });
    expect(cards().length).toBeGreaterThan(0);
    expect(treegrid()).toBeNull();
  });

  it("a write that replaced an unreadable settings file says so", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    state.memory?.answer("libraryView.write", async () => ({
      replaced: "settings.json was not an object; kept at settings.json.bak",
    }));
    await drawn();
    button('[data-layout="grid"]').click();
    const notice = document.querySelector<HTMLElement>("#notice");
    await vi.waitFor(() => {
      if (notice?.classList.contains("hidden") !== false) {
        throw new Error("nothing said yet");
      }
    });
    expect(notice?.textContent).toContain("kept at settings.json.bak");
  });
});

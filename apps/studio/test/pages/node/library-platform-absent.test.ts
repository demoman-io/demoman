import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildLibraryModel,
  formatBytes,
  type LibraryModel,
  type LibraryRow,
} from "../../../pages/src/library/state";
import { renderLibrary } from "../../../pages/src/library/view";
import { mountTopbar } from "../../../pages/src/shell/topbar";

/**
 * What the library and the top bar draw on the studio's platform, which
 * lacks the extension's members (Launch D2, Task 11): no storage control,
 * no Needs a look flag — and a sentence where Restore's button would be
 * when there is no Runs page.
 *
 * Each case names the production change that reddens it: the storage case
 * goes red if `createHeader` attaches the storage panel unconditionally;
 * the flag case if `tags` draws the flag without `openReview`; the line
 * case if `row` ignores `rerunLine`.
 */

const row: LibraryRow = {
  sceneId: "a",
  name: "Checkout",
  label: "Checkout",
  origin: "app.test",
  path: "/checkout",
  createdAt: "2026-09-01T00:00:00Z",
  when: "Sep 1, 12:00 AM",
  time: "12:00 AM",
  hosted: false,
  recoverable: false,
  frameBytes: 100,
  outputBytes: 20,
  state: "Motion reclaimed",
  canRestore: true,
  authored: false,
  servesReshoot: false,
  needsLook: true,
};
const model: LibraryModel = {
  usedBytes: 0,
  budgetBytes: 0,
  fraction: 0,
  chromeNearLimit: false,
  migrating: false,
  migrationFailed: false,
  notice: null,
  rows: [row],
};
const base = {
  edit: vi.fn(),
  restore: vi.fn(),
  backToRecording: vi.fn(),
  remove: vi.fn(),
  preview: vi.fn(),
  rename: vi.fn(),
  renameVideo: vi.fn(),
};

describe("the library without the extension-only members", () => {
  beforeEach(() => {
    document.body.innerHTML = `<div data-storage-slot></div><main id="root"></main>`;
  });

  it("draws no storage control, no size line and no flag when they are absent", () => {
    const root = document.querySelector("#root") as HTMLElement;
    renderLibrary(root, model, base, new Map());
    // Premise: the fixture has a flagged, reclaimed row.
    expect(root.querySelector('[data-row="a"]')).not.toBeNull();
    expect(model.rows[0]?.needsLook).toBe(true);
    expect(document.querySelector("[data-storage-trigger]")).toBeNull();
    expect(document.querySelector("[data-storage]")).toBeNull();
    expect(root.querySelector("[data-size]")).toBeNull();
    expect(root.querySelector("[data-needs-look]")).toBeNull();
  });

  it("draws all three when the page passes their actions", () => {
    const root = document.querySelector("#root") as HTMLElement;
    renderLibrary(
      root,
      model,
      {
        ...base,
        reclaim: vi.fn(),
        setBudget: vi.fn(),
        openReview: vi.fn(),
      },
      new Map(),
    );
    expect(document.querySelector("[data-storage-trigger]")).not.toBeNull();
    expect(root.querySelector("[data-size]")).not.toBeNull();
    expect(root.querySelector("[data-needs-look]")).not.toBeNull();
  });

  it("puts the platform's sentence where Restore's button would be", () => {
    const root = document.querySelector("#root") as HTMLElement;
    renderLibrary(
      root,
      model,
      { ...base, rerunLine: () => "Ask the agent to run its script again." },
      new Map(),
    );
    expect(root.querySelector('[data-action="restore"]')).toBeNull();
    expect(root.querySelector("[data-rerun-line]")?.textContent).toBe(
      "Ask the agent to run its script again.",
    );
  });
});

describe("the top bar", () => {
  // Red: drop the href `mountTopbar` sets.
  it("points the Settings tab at the platform's page", () => {
    document.body.innerHTML = `
      <nav><a href="library.html" data-tab="library">L</a>
      <a href="settings.html" data-tab="settings">S</a></nav>`;
    mountTopbar({
      nav: {
        editor: (id) => id,
        library: () => "library",
        kits: () => "/kits-page.html",
        firstTakeHint: () => "",
        rerun: () => ({ kind: "line", text: "" }),
        onOpen: () => undefined,
      },
    });
    expect(
      document.querySelector('[data-tab="settings"]')?.getAttribute("href"),
    ).toBe("/kits-page.html");
  });
});

/**
 * The studio's listing through the real model builder and the real view:
 * sizes on the cards and in the bar, a folder that will not read as a row of
 * its own, and the empty card in the platform's words.
 */
describe("the library with the Studio's sizes and unreadable folders", () => {
  const MB = 1024 ** 2;
  const STUDIO_HINT =
    "Ask your agent for a demo video. Each take shows up here, grouped by the day you made it.";
  const scene = (id: string, name: string) =>
    ({
      meta: {
        id,
        name,
        createdAt: "2026-09-01T00:00:00Z",
        capture: { originUrl: "https://app.test/x" },
      },
    }) as never;
  const build = (
    args: Partial<Parameters<typeof buildLibraryModel>[0]> = {},
  ): LibraryModel =>
    buildLibraryModel({
      scenes: [],
      migrating: false,
      migrationFailed: false,
      notice: null,
      needsLook: new Set(),
      ...args,
    });

  beforeEach(() => {
    document.body.innerHTML = `<div data-storage-slot></div><main id="root"></main>`;
  });

  it("with sizes, each card states its size and the bar states the total", () => {
    const m = build({
      scenes: [scene("a", "One"), scene("b", "Two")],
      sizes: { a: MB, b: 2 * MB, broken: MB },
      unreadable: [{ folder: "broken", reason: "scene.json is not valid" }],
    });
    // Premise: the unreadable folder's megabyte is the difference between
    // the rows' 3 MB and the library's 4.
    expect(m.rows.map((r) => r.sizeBytes)).toEqual([MB, 2 * MB]);
    expect(m.unreadable?.[0]?.sizeBytes).toBe(MB);
    expect(formatBytes(3 * MB)).not.toBe(formatBytes(4 * MB));
    const root = document.querySelector("#root") as HTMLElement;
    renderLibrary(root, m, base, new Map());
    const sizes = [...root.querySelectorAll("[data-row] [data-size]")].map(
      (n) => n.textContent,
    );
    expect(sizes.sort()).toEqual([formatBytes(MB), formatBytes(2 * MB)]);
    const total = document.querySelector("[data-library-total]");
    expect(total?.textContent).toBe(`Storage${formatBytes(4 * MB)}`);
    expect(total?.closest("[data-storage-slot]")).not.toBeNull();
    expect(document.querySelector("[data-storage-trigger]")).toBeNull();
  });

  it("a folder the Studio could not measure states no size, and the total says it is partial", () => {
    const m = build({
      scenes: [scene("a", "One"), scene("b", "Two")],
      // b and the unreadable folder are left out: the studio could not
      // measure them.
      sizes: { a: MB },
      unreadable: [{ folder: "broken", reason: "scene.json is not valid" }],
    });
    // Red: default a missing size to 0 in buildLibraryModel (`?? 0`) — b's
    // card and the row say "0 B", and the total reads as the whole sum.
    expect(m.rows.map((r) => [r.sceneId, r.sizeBytes])).toEqual([
      ["a", MB],
      ["b", undefined],
    ]);
    expect(m.unreadable?.[0]?.sizeBytes).toBeUndefined();
    expect({ total: m.totalBytes, unmeasured: m.unmeasured }).toEqual({
      total: MB,
      unmeasured: 2,
    });
    const root = document.querySelector("#root") as HTMLElement;
    renderLibrary(root, m, base, new Map());
    // The premise: both cards and the row are drawn, so an absent size is
    // the card's choice, not a missing card.
    expect(root.querySelector('[data-row="a"] [data-size]')?.textContent).toBe(
      formatBytes(MB),
    );
    expect(root.querySelector('[data-row="b"]')).not.toBeNull();
    expect(root.querySelector('[data-row="b"] [data-size]')).toBeNull();
    const row = root.querySelector('[data-unreadable-row="broken"]');
    expect(row?.textContent).toContain("scene.json is not valid");
    expect(row?.querySelector("[data-size]")).toBeNull();
    // Red: drop the `+` in createHeader's update — the bar states 1 MB as
    // what the folder holds.
    const total = document.querySelector("[data-library-total]");
    expect(total?.textContent).toBe(`Storage${formatBytes(MB)}+`);
    // Folders, not takes: one of the two is the unreadable row, which the
    // page says is not a take. Red: count it as "takes" in createHeader.
    expect(total?.getAttribute("title")).toBe(
      "2 folders could not be measured",
    );
    expect(total?.getAttribute("aria-label")).toBe(
      `Storage: ${formatBytes(MB)}+ (2 folders could not be measured)`,
    );
  });

  it("an unreadable folder is a row with its reason and a Delete; nothing else", () => {
    const remove = vi.fn();
    const root = document.querySelector("#root") as HTMLElement;
    renderLibrary(
      root,
      build({
        scenes: [scene("a", "One")],
        sizes: { a: MB, broken: 3 * MB },
        unreadable: [{ folder: "broken", reason: "scene.json is not valid" }],
      }),
      { ...base, remove },
      new Map(),
    );
    const section = root.querySelector("[data-unreadable]");
    expect(section?.querySelector("h2")?.textContent).toBe("Couldn't read");
    const row = root.querySelector('[data-unreadable-row="broken"]');
    expect(row).not.toBeNull();
    expect(row?.textContent).toContain("broken");
    expect(row?.textContent).toContain("scene.json is not valid");
    expect(row?.textContent).toContain(formatBytes(3 * MB));
    // After the dated sections.
    const dated = root.querySelector("[data-section]");
    expect(dated).not.toBeNull();
    expect(
      (dated?.compareDocumentPosition(section as Node) ?? 0) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(row?.querySelector('[data-action="edit"]')).toBeNull();
    expect(row?.querySelector("input")).toBeNull();
    expect(row?.querySelectorAll("button").length).toBe(1);
    row?.querySelector<HTMLElement>('[data-action="delete"]')?.click();
    expect(remove).toHaveBeenCalledWith("broken", "folder");
  });

  it("a library of only unreadable folders shows them, not the empty card", () => {
    const root = document.querySelector("#root") as HTMLElement;
    const m = build({
      sizes: { broken: MB },
      unreadable: [{ folder: "broken", reason: "no scene.json" }],
    });
    // Premise: no listed take, so only the unreadable check keeps the
    // empty card away.
    expect(m.rows.length).toBe(0);
    renderLibrary(root, m, base, new Map());
    expect(root.querySelector('[data-unreadable-row="broken"]')).not.toBeNull();
    expect(root.querySelector("[data-empty]")).toBeNull();
  });

  it("the empty card says the platform's hint", () => {
    const root = document.querySelector("#root") as HTMLElement;
    const m = build({ emptyHint: STUDIO_HINT });
    expect(m.rows.length).toBe(0);
    renderLibrary(root, m, base, new Map());
    const card = root.querySelector("[data-empty]");
    expect(card?.textContent).toContain("No recordings yet");
    expect(card?.textContent).toContain(STUDIO_HINT);
    expect(card?.textContent).not.toContain("toolbar");
  });

  it("says when new takes will not show by themselves", () => {
    const root = document.querySelector("#root") as HTMLElement;
    renderLibrary(
      root,
      build({ unwatched: "takes could not be watched (EMFILE)" }),
      base,
      new Map(),
    );
    expect(root.querySelector("[data-unwatched]")?.textContent).toBe(
      "New takes will not show until you reload — takes could not be watched (EMFILE).",
    );
  });
});

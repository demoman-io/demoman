// apps/studio/test/pages/node/library-view-select.test.ts
//
// The library's bulk selection, as the view draws it (spec 2026-10-30
// flows-and-bulk-delete §1.2). What the page does with a selection —
// deleting it — is library-main-bulk-delete.test.ts.
import type { VideoSummary } from "@demoman/studio-protocol";
import { describe, expect, it, vi } from "vitest";
import {
  emptySelection,
  type Selection,
} from "../../../pages/src/library/selection";
import type {
  LibraryModel,
  LibraryRow,
  VideoGroup,
} from "../../../pages/src/library/state";
import { renderLibrary } from "../../../pages/src/library/view";

const NOW = new Date(2026, 9, 30, 12);

const takeRow = (sceneId: string, name: string, at: Date): LibraryRow => ({
  sceneId,
  name,
  label: name,
  origin: "app.test",
  path: "",
  createdAt: at.toISOString(),
  when: "Oct 30, 9:00 AM",
  time: "9:00 AM",
  hosted: false,
  recoverable: false,
  frameBytes: 0,
  outputBytes: 0,
  state: "Complete",
  canRestore: false,
  authored: true,
  servesReshoot: false,
  needsLook: false,
});

const flow = (id: string, row: LibraryRow): VideoGroup => ({
  video: {
    id,
    name: row.name,
    repo: { unknown: true },
    startPage: "https://app.test/",
    versions: 1,
    current: null,
    pages: [],
    steps: [],
    exports: [],
  } as VideoSummary,
  current: row,
  versions: [{ ...row, version: 1 }],
});

const a = takeRow("a", "Create an invoice", new Date(2026, 9, 30, 9));
const b = takeRow("b", "Export a report", new Date(2026, 9, 30, 8));
const c = takeRow("c", "Loose take", new Date(2026, 9, 30, 7));
const d = takeRow("d", "Old flow", new Date(2026, 8, 1, 9));

const model: LibraryModel = {
  usedBytes: 0,
  budgetBytes: 0,
  fraction: 1,
  chromeNearLimit: false,
  migrating: false,
  migrationFailed: false,
  notice: null,
  rows: [a, b, c, d],
  groups: [flow("f1", a), flow("f2", b), flow("f4", d)],
};

const actions = () => ({
  edit: vi.fn(),
  restore: vi.fn(),
  backToRecording: vi.fn(),
  remove: vi.fn(),
  preview: vi.fn(),
  rename: vi.fn(),
  renameVideo: vi.fn(),
  select: vi.fn(),
  clearSelection: vi.fn(),
  deleteSelected: vi.fn(),
});

const draw = (
  selection: Selection,
  acts = actions(),
  bulk?: { busy: boolean; said: string | null },
) => {
  const root = document.createElement("div");
  document.body.replaceChildren(root);
  renderLibrary(root, model, acts, new Map(), NOW, selection, bulk);
  return { root, acts };
};

const picked = (...ids: string[]): Selection => ({
  ids: new Set(ids),
  anchor: ids.at(-1) ?? null,
});

describe("bulk selection in the library view", () => {
  it("the fixture has three flows, one in a folded month, and one loose take", () => {
    const { root } = draw(emptySelection());
    expect(root.querySelectorAll("article[data-video]")).toHaveLength(3);
    expect(
      root.querySelector('[data-row="c"]')?.hasAttribute("data-video"),
    ).toBe(false);
    const old = root.querySelector('[data-row="d"]')?.closest("details");
    expect(old?.open).toBe(false);
  });

  it("a flow card has a select checkbox and a take card has none", () => {
    const { root } = draw(emptySelection());
    const box = root.querySelector(
      '[data-row="a"] input[type="checkbox"][data-select]',
    ) as HTMLInputElement;
    expect(box.getAttribute("aria-label")).toBe("Select Create an invoice");
    expect(box.checked).toBe(false);
    expect(root.querySelector('[data-row="c"] [data-select]')).toBeNull();
    expect(root.hasAttribute("data-selecting")).toBe(false);
    expect(root.querySelector("[data-selection-bar]")).toBeNull();
  });

  it("with one ticked, every flow card shows its box and the bar counts them", () => {
    const one = draw(picked("f1")).root;
    expect(one.hasAttribute("data-selecting")).toBe(true);
    expect(
      one.querySelector('[data-row="a"]')?.hasAttribute("data-selected"),
    ).toBe(true);
    expect(
      one.querySelector('[data-row="b"]')?.hasAttribute("data-selected"),
    ).toBe(false);
    expect(
      (one.querySelector('[data-row="a"] [data-select]') as HTMLInputElement)
        .checked,
    ).toBe(true);
    expect(one.querySelector("[data-selection-count]")?.textContent).toBe(
      "1 flow selected",
    );
    const two = draw(picked("f1", "f2")).root;
    expect(two.querySelector("[data-selection-count]")?.textContent).toBe(
      "2 flows selected",
    );
  });

  it("the checkbox selects its flow", () => {
    const { root, acts } = draw(emptySelection());
    (
      root.querySelector('[data-row="b"] [data-select]') as HTMLInputElement
    ).click();
    expect(acts.select).toHaveBeenCalledWith("f2", false, ["f1", "f2"]);
    expect(acts.edit).not.toHaveBeenCalled();
  });

  it("while selecting, a card click calls select instead of edit", () => {
    const { root, acts } = draw(picked("f1"));
    (
      root.querySelector('[data-row="b"] [data-preview]') as HTMLElement
    ).click();
    expect(acts.select).toHaveBeenCalledWith("f2", false, ["f1", "f2"]);
    expect(acts.edit).not.toHaveBeenCalled();
  });

  it("while selecting, the page is marked selecting, which the stylesheet reads to hide a flow's Edit and Delete", () => {
    const { root } = draw(picked("f1"));
    expect(root.hasAttribute("data-selecting")).toBe(true);
    // Hidden by CSS (library/index.html), asserted painted in the shots lane.
    expect(
      root.querySelector('[data-row="b"] [data-action="delete"]'),
    ).not.toBeNull();
    const idle = draw(emptySelection()).root;
    expect(
      idle.querySelector('[data-row="b"] [data-action="delete"]'),
    ).not.toBeNull();
  });

  it("shift-click skips cards in folded sections", () => {
    const { root, acts } = draw(picked("f1"));
    root
      .querySelector('[data-row="b"] [data-select]')
      ?.dispatchEvent(
        new MouseEvent("click", { bubbles: true, shiftKey: true }),
      );
    expect(acts.select).toHaveBeenCalledWith("f2", true, ["f1", "f2"]);
  });

  it("Cancel clears and Delete deletes the selection", () => {
    const { root, acts } = draw(picked("f1"));
    (
      root.querySelector(
        '[data-action="cancel-selection"]',
      ) as HTMLButtonElement
    ).click();
    (
      root.querySelector('[data-action="delete-selected"]') as HTMLButtonElement
    ).click();
    expect(acts.clearSelection).toHaveBeenCalledTimes(1);
    expect(acts.deleteSelected).toHaveBeenCalledTimes(1);
  });

  it("busy bar disables Cancel and Delete and says Deleting 3 flows…", () => {
    const { root } = draw(picked("f1", "f2", "f4"), actions(), {
      busy: true,
      said: null,
    });
    expect(root.querySelector("[data-selection-count]")?.textContent).toBe(
      "Deleting 3 flows…",
    );
    for (const action of ["cancel-selection", "delete-selected"]) {
      expect(
        (root.querySelector(`[data-action="${action}"]`) as HTMLButtonElement)
          .disabled,
      ).toBe(true);
    }
  });

  it("the bar says what a bulk delete left behind", () => {
    const { root } = draw(picked("f1"), actions(), {
      busy: false,
      said: "Deleted 1 of 2 flows. Create an invoice stayed: it is being exported.",
    });
    expect(root.querySelector("[data-selection-said]")?.textContent).toMatch(
      /Create an invoice stayed/,
    );
  });
});

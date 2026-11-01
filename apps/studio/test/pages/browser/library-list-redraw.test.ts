import type { LibraryViewChoice, VideoSummary } from "@demoman/studio-protocol";
import { page, userEvent } from "@vitest/browser/context";
import { beforeEach, describe, expect, it, vi } from "vitest";
// The page's own markup and rules, and the real view, so the rows redrawn
// are the rows the page renders.
import shell from "../../../pages/entrypoints/library/index.html?raw";
import {
  clickSelect,
  emptySelection,
  type Selection,
} from "../../../pages/src/library/selection";
import type {
  LibraryModel,
  LibraryRow,
  VideoGroup,
} from "../../../pages/src/library/state";
import {
  applySelection,
  renderLibrary,
  statusKey,
} from "../../../pages/src/library/view";
import { mountShell, node, pageParts } from "../helpers/shell-css";

/**
 * The list across redraws (spec 2026-10-31-library-list-view §4.5) and its
 * rename (§4.6). A redraw is `renderLibrary` again with a model, as the
 * page's folder watcher calls it on any change in `~/.demoman`. Real keys
 * and clicks throughout; every failure says where focus was and which rows
 * were on screen.
 */

const { css, body } = pageParts(shell, ".library-list .select-box");

const NOW = new Date(2026, 9, 30, 12);

const take = (sceneId: string, at: Date): LibraryRow => ({
  sceneId,
  name: "",
  label: sceneId,
  origin: "app.example.com",
  path: "/orders",
  createdAt: at.toISOString(),
  when: `${sceneId} when`,
  time: `${sceneId} time`,
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

const flow = (id: string, name: string, versions: LibraryRow[]): VideoGroup => {
  const numbered = versions.map((v, i) => ({
    ...v,
    version: versions.length - i,
  }));
  return {
    video: {
      id,
      name,
      repo: { unknown: true },
      startPage: "https://app.example.com/",
      versions: versions.length,
      current: null,
      pages: [],
      steps: [],
      exports: [],
      kept: null,
    } as VideoSummary,
    current: numbered[0] ?? null,
    versions: numbered,
  };
};

// Today: A (two videos), B, E, and a take in no flow; Yesterday: C; a
// past month, folded by default: D.
const a2 = take("a2", new Date(2026, 9, 30, 9));
const a1 = take("a1", new Date(2026, 9, 30, 8, 30));
const b1 = take("b1", new Date(2026, 9, 30, 8));
const e1 = take("e1", new Date(2026, 9, 30, 7));
const loose = take("loose", new Date(2026, 9, 30, 6));
const c1 = take("c1", new Date(2026, 9, 29, 10));
const d1 = take("d1", new Date(2026, 8, 1, 9));
const GROUPS = [
  flow("A", "Create an invoice", [a2, a1]),
  flow("B", "Edit profile", [b1]),
  flow("E", "Export a report", [e1]),
  flow("C", "Sign up", [c1]),
  flow("D", "Archive", [d1]),
];

/** The library, less the flows named: what the watcher sees after they
 *  were deleted elsewhere. */
function model(...gone: string[]): LibraryModel {
  const groups = GROUPS.filter((g) => !gone.includes(g.video.id));
  const kept = new Set(groups.flatMap((g) => g.versions.map((v) => v.sceneId)));
  return {
    usedBytes: 0,
    budgetBytes: 0,
    fraction: 1,
    chromeNearLimit: false,
    migrating: false,
    migrationFailed: false,
    notice: null,
    rows: [a2, a1, b1, e1, loose, c1, d1].filter(
      (r) => kept.has(r.sceneId) || r === loose,
    ),
    groups,
  };
}

let selection: Selection;
let view: LibraryViewChoice;
let rowStatus: Map<string, string>;
let acts: ReturnType<typeof actions>;

/** The page's actions, as main.ts composes them: the real selection, and a
 *  view change that redraws, as the page's does. */
function actions() {
  return {
    edit: vi.fn(),
    restore: vi.fn(),
    backToRecording: vi.fn(),
    remove: vi.fn(),
    preview: vi.fn(),
    rename: vi.fn(),
    renameVideo: vi.fn(),
    setView: vi.fn((next: LibraryViewChoice) => {
      view = next;
      redraw();
    }),
    select: vi.fn((id: string, how: "toggle" | "range", order: string[]) => {
      selection = clickSelect(selection, id, how, order);
      applySelection(node("#root"), acts, selection);
    }),
    clearSelection: vi.fn(),
  };
}

const RECORDED = { column: "recorded", descending: true } as const;
const BY_NAME = { column: "name", descending: false } as const;

/** The watcher's redraw: the whole library drawn again. */
function redraw(m: LibraryModel = model()): void {
  renderLibrary(
    node("#root"),
    m,
    acts,
    rowStatus,
    NOW,
    selection,
    undefined,
    view,
  );
}

/** A stop just before the list, to Tab in from. */
let before: HTMLButtonElement;

function mount(): void {
  mountShell("dark", css);
  document.body.innerHTML = body;
  selection = emptySelection();
  view = { layout: "list", sort: RECORDED };
  rowStatus = new Map();
  acts = actions();
  redraw();
  before = document.createElement("button");
  before.textContent = "before";
  grid().before(before);
}

const grid = (): HTMLElement => node("[data-list]");
const row = (key: string): HTMLElement =>
  node(`[data-list] [role=row][data-key="${key}"]`);
const cell = (key: string, col: string): HTMLElement =>
  row(key).querySelector(`[data-col="${col}"]`) as HTMLElement;
const nameText = (key: string): string | null | undefined =>
  cell(key, "name").querySelector("[data-name-text]")?.textContent;
const field = (): HTMLInputElement | null =>
  document.querySelector<HTMLInputElement>("[data-list] [data-name]");
const onScreen = (): string[] =>
  [
    ...grid().querySelectorAll<HTMLElement>(
      "[role=row][data-key]:not([hidden])",
    ),
  ].map((r) => r.dataset.key as string);
const expanded = (key: string): string | null =>
  row(key).getAttribute("aria-expanded");
const ticked = (): string[] =>
  [
    ...grid().querySelectorAll<HTMLElement>('[role=row][aria-selected="true"]'),
  ].map((r) => r.dataset.key as string);
/** Where focus is: a row's key, `key/col` for a cell or a control in it,
 *  `key/name field` for the rename field, `head/col` for a column heading,
 *  else what holds it outside the list. */
function focused(): string {
  const a = document.activeElement as HTMLElement | null;
  const head = a?.closest<HTMLElement>("[data-list] [data-list-head]");
  if (a != null && head != null) {
    return `head/${a.closest<HTMLElement>("[role=columnheader]")?.dataset.col}`;
  }
  const r = a?.closest<HTMLElement>("[data-list] [role=row][data-key]");
  if (a == null || r == null) {
    return `outside: ${a?.tagName ?? "nothing"} ${a?.textContent ?? ""}`;
  }
  if (a === r) return r.dataset.key as string;
  const col = a.closest<HTMLElement>("[role=gridcell]")?.dataset.col;
  return `${r.dataset.key}/${col}${a.matches("[data-name]") ? " field" : ""}`;
}
const where = (): string =>
  `focused ${focused()}; rows on screen ${onScreen().join(", ")}`;

async function enter(): Promise<void> {
  before.focus();
  await userEvent.keyboard("{Tab}");
}

async function press(keys: string, expected: string): Promise<void> {
  await userEvent.keyboard(keys);
  expect(focused(), `after ${keys}: ${where()}`).toBe(expected);
}

/** From the first row to flow A's name cell: ↓, the first → opens A, the
 *  next three walk select, open, name. */
const TO_A_NAME = "{ArrowDown}{ArrowRight}{ArrowRight}{ArrowRight}{ArrowRight}";

beforeEach(async () => {
  await page.viewport(1280, 900);
});

describe("the fixture", () => {
  it("has what the cases below sample", () => {
    mount();
    expect(onScreen()).toEqual([
      "h:today",
      "f:A",
      "f:B",
      "f:E",
      "t:loose",
      "h:yesterday",
      "f:C",
      expect.stringMatching(/^h:month:/),
    ]);
    // Flows and a take in no flow carry a Rename; nothing is open yet.
    expect(row("f:A").querySelector('[data-action="rename"]')).not.toBeNull();
    expect(
      row("t:loose").querySelector('[data-action="rename"]'),
    ).not.toBeNull();
    expect(field()).toBeNull();
  });
});

describe("a redraw", () => {
  it("keeps focus on the same row and column and does not scroll", async () => {
    mount();
    await enter();
    await press(TO_A_NAME, "f:A/name");
    // The stop Tab came from goes with the redraw; gone first, so the page
    // is as tall before it as after.
    before.remove();
    // A screenful of three rows, and the page scrolled to its foot, so the
    // focused cell is out of view: a focus that may scroll would.
    await page.viewport(1280, Math.round(row("f:A").offsetHeight * 3));
    window.scrollTo(0, document.documentElement.scrollHeight);
    const y = window.scrollY;
    // Premise: the list is taller than the window, and the cell is above it.
    expect(y, where()).toBeGreaterThan(0);
    expect(cell("f:A", "name").getBoundingClientRect().bottom).toBeLessThan(0);
    const old = cell("f:A", "name");
    redraw();
    // Premise: every row was replaced.
    expect(old.isConnected).toBe(false);
    expect(focused(), where()).toBe("f:A/name");
    expect(window.scrollY, where()).toBe(y);
    // And the stop is the grid's one Tab stop.
    expect(cell("f:A", "name").tabIndex, where()).toBe(0);
  });

  it("when the focused row is deleted, focus lands on the row now in its place, else the one before", async () => {
    mount();
    await enter();
    await press("{ArrowDown}{ArrowDown}", "f:B");
    redraw(model("B"));
    expect(focused(), where()).toBe("f:E");
    // The last row, a month heading whose only flow goes: none is in its
    // place, so the one before.
    await press("{End}", onScreen().at(-1) as string);
    expect(onScreen().at(-1), where()).toMatch(/^h:month:/);
    redraw(model("B", "D"));
    expect(focused(), where()).toBe("f:C");
  });

  it("while focus is outside the list leaves it outside", async () => {
    mount();
    await enter();
    await press("{ArrowDown}", "f:A");
    const toggle = node("[data-layout-toggle] button");
    toggle.focus();
    redraw();
    expect(document.activeElement, where()).toBe(toggle);
  });

  // Red: the redraw's grid starting its Tab stop over at the first row, as
  // a grid nobody had entered does.
  it("while focus is outside the list keeps the Tab stop on the row it left", async () => {
    mount();
    const after = document.createElement("button");
    after.textContent = "after";
    document.body.append(after);
    await enter();
    await press("{ArrowDown}{ArrowDown}", "f:B");
    await press("{Tab}", "outside: BUTTON after");
    const old = row("f:B");
    redraw();
    // Premise: every row was replaced, and focus stayed out.
    expect(old.isConnected, where()).toBe(false);
    expect(document.activeElement, where()).toBe(after);
    await press("{Shift>}{Tab}{/Shift}", "f:B");
  });

  it("after a sort from the headings keeps focus on that sort", async () => {
    mount();
    await enter();
    await press("{ArrowUp}", "head/name");
    await press("{Enter}", "head/name");
    expect(view.sort, where()).toEqual(BY_NAME);
    // By pointer too.
    await userEvent.click(node('[data-list] [data-sort="size"]'));
    expect(view.sort.column, where()).toBe("size");
    expect(focused(), where()).toBe("head/size");
  });
});

describe("folds", () => {
  it("open flows and collapsed headings survive a redraw, a sort and a switch to Grid and back", async () => {
    mount();
    await enter();
    // A opened and Yesterday closed from the keys.
    await press("{ArrowDown}{ArrowRight}", "f:A");
    await press("{End}{ArrowUp}{ArrowUp}{Enter}", "h:yesterday");
    const keep = (when: string): void => {
      expect(expanded("f:A"), `${when}: ${where()}`).toBe("true");
      expect(expanded("h:yesterday"), `${when}: ${where()}`).toBe("false");
      expect(row("v:a2").hidden, `${when}: ${where()}`).toBe(false);
      expect(row("f:C").hidden, `${when}: ${where()}`).toBe(true);
    };
    redraw();
    keep("after a redraw");
    acts.setView({ layout: "list", sort: BY_NAME });
    // Premise: a flat sort, no headings.
    expect(grid().querySelector("[data-heading]"), where()).toBeNull();
    expect(expanded("f:A"), where()).toBe("true");
    acts.setView({ layout: "list", sort: RECORDED });
    keep("after a sort and back");
    acts.setView({ layout: "grid", sort: RECORDED });
    expect(document.querySelector("[data-list]"), "cards drawn").toBeNull();
    acts.setView({ layout: "list", sort: RECORDED });
    keep("after Grid and back");
  });

  it("a fold made in place survives a redraw", async () => {
    mount();
    const month = onScreen().at(-1) as string;
    // A click on the month heading's label and on B's chevron, in place.
    // The label: its cell spans the heading, under the empty cells.
    await userEvent.click(
      cell(month, "name").querySelector("[data-name-text]") as HTMLElement,
    );
    await userEvent.click(cell("f:B", "open"));
    // Premise: both opened without a redraw.
    expect(expanded(month)).toBe("true");
    expect(expanded("f:B")).toBe("true");
    redraw();
    expect(expanded(month), where()).toBe("true");
    expect(row("f:D").hidden, where()).toBe(false);
    expect(expanded("f:B"), where()).toBe("true");
    expect(row("v:b1").hidden, where()).toBe(false);
  });
});

describe("selection", () => {
  it("survives a sort and a switch to Grid and back", async () => {
    mount();
    await enter();
    await press("{ArrowDown} ", "f:A");
    await press("{End}{ArrowUp} ", "f:C");
    expect(ticked(), where()).toEqual(["f:A", "f:C"]);
    acts.setView({ layout: "list", sort: BY_NAME });
    expect(ticked().sort(), where()).toEqual(["f:A", "f:C"]);
    acts.setView({ layout: "grid", sort: BY_NAME });
    expect(
      [...document.querySelectorAll<HTMLElement>("article[data-selected]")]
        .map((a) => a.dataset.video)
        .sort(),
    ).toEqual(["A", "C"]);
    acts.setView({ layout: "list", sort: RECORDED });
    expect(ticked(), where()).toEqual(["f:A", "f:C"]);
  });
});

describe("renaming", () => {
  it("a rename typed during a redraw keeps its text, focus and caret", async () => {
    mount();
    await enter();
    await press(`${TO_A_NAME}{Enter}`, "f:A/name field");
    // The whole name is selected, so typing replaces it; two ← leave the
    // caret inside what was typed.
    await userEvent.keyboard("Draft{ArrowLeft}{ArrowLeft}");
    const old = field() as HTMLInputElement;
    expect(old.value, where()).toBe("Draft");
    expect(old.selectionStart, where()).toBe(3);
    const y = window.scrollY;
    redraw();
    // Premise: the field is a new one.
    expect(old.isConnected).toBe(false);
    expect(focused(), where()).toBe("f:A/name field");
    expect(field()?.value, where()).toBe("Draft");
    expect([field()?.selectionStart, field()?.selectionEnd], where()).toEqual([
      3, 3,
    ]);
    expect(window.scrollY, where()).toBe(y);
    // The caret really is there: the next key lands at it.
    await userEvent.keyboard("X{Enter}");
    expect(acts.renameVideo, where()).toHaveBeenCalledWith("A", "DraXft");
  });

  it("Enter saves through rename/renameVideo and focus returns to the name cell", async () => {
    mount();
    await enter();
    await press(`${TO_A_NAME}{Enter}`, "f:A/name field");
    await press("Invoices{Enter}", "f:A/name");
    expect(acts.renameVideo, where()).toHaveBeenCalledWith("A", "Invoices");
    expect(field(), where()).toBeNull();
    expect(nameText("f:A"), where()).toBe("Invoices");
    // A take in no flow names its take. Back to the row, A closed, down to
    // the take; it has no box, so → walks select, open, name.
    await press(
      "{Escape}{ArrowLeft}{ArrowDown}{ArrowDown}{ArrowDown}",
      "t:loose",
    );
    await press(
      "{ArrowRight}{ArrowRight}{ArrowRight}{Enter}",
      "t:loose/name field",
    );
    await press("Mine{Enter}", "t:loose/name");
    expect(acts.rename, where()).toHaveBeenCalledWith("loose", "Mine");
    expect(acts.renameVideo).toHaveBeenCalledTimes(1);
    expect(acts.edit).not.toHaveBeenCalled();
  });

  it("Escape cancels, and the page's Escape does not hear it", async () => {
    mount();
    const reached: string[] = [];
    const listen = (e: KeyboardEvent) => reached.push(e.key);
    document.addEventListener("keydown", listen);
    try {
      await enter();
      await press(`${TO_A_NAME}{Enter}`, "f:A/name field");
      reached.length = 0;
      await press("zzz{Escape}", "f:A/name");
      expect(field(), where()).toBeNull();
      expect(nameText("f:A"), where()).toBe("Create an invoice");
      expect(acts.renameVideo, where()).not.toHaveBeenCalled();
      // main.ts clears the selection on an Escape it hears. Premise: the
      // listener hears the keys around it.
      expect(reached, where()).toEqual(["z", "z", "z"]);
    } finally {
      document.removeEventListener("keydown", listen);
    }
  });

  it("the Rename button opens the field", async () => {
    mount();
    await userEvent.click(
      row("f:B").querySelector('[data-action="rename"]') as HTMLElement,
    );
    expect(focused(), where()).toBe("f:B/name field");
    expect(field()?.value, where()).toBe("Edit profile");
    expect(acts.edit, where()).not.toHaveBeenCalled();
    await press("{Escape}", "f:B/name");
  });

  it("ticking a flow's checkbox while a rename field is open still selects it", async () => {
    mount();
    await enter();
    await press(`${TO_A_NAME}{Enter}`, "f:A/name field");
    await userEvent.click(node('[data-list] [data-select="B"]'));
    expect(acts.select, where()).toHaveBeenCalledWith("B", "toggle", [
      "A",
      "B",
      "E",
      "C",
    ]);
    expect(ticked(), where()).toEqual(["f:B"]);
    // The field closed on the way, unchanged, so nothing was sent.
    expect(field(), where()).toBeNull();
    expect(acts.renameVideo, where()).not.toHaveBeenCalled();
  });

  it("the click that ends a rename opens nothing, and the field saves on the way", async () => {
    for (const [what, target] of [
      ["B's name", () => cell("f:B", "name")],
      ["a blank part of A's row", () => cell("f:A", "size")],
    ] as const) {
      mount();
      await enter();
      await press(`${TO_A_NAME}{Enter}`, "f:A/name field");
      await userEvent.keyboard("Invoices");
      await userEvent.click(target());
      expect(acts.edit, `${what}: ${where()}`).not.toHaveBeenCalled();
      expect(field(), `${what}: ${where()}`).toBeNull();
      expect(acts.renameVideo, `${what}: ${where()}`).toHaveBeenCalledWith(
        "A",
        "Invoices",
      );
      expect(nameText("f:A"), `${what}: ${where()}`).toBe("Invoices");
    }
  });

  it("a click on the open field opens nothing and leaves it open", async () => {
    mount();
    await enter();
    await press(`${TO_A_NAME}{Enter}`, "f:A/name field");
    await userEvent.click(field() as HTMLInputElement);
    expect(acts.edit, where()).not.toHaveBeenCalled();
    expect(focused(), where()).toBe("f:A/name field");
  });

  it("a refused rename's sentence shows on the row's status line", () => {
    mount();
    const said = "Couldn't rename: another video is called Edit profile.";
    rowStatus.set(statusKey("video", "A"), said);
    rowStatus.set(statusKey("take", "loose"), "Couldn't rename: disk full.");
    redraw();
    for (const [key, text] of [
      ["f:A", said],
      ["t:loose", "Couldn't rename: disk full."],
    ] as const) {
      const line = row(key).querySelector("[data-status]");
      expect(line?.textContent, key).toBe(text);
      expect(row(key).getAttribute("aria-describedby"), key).toBe(line?.id);
    }
  });
});

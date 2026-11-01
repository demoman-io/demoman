import type { VideoSummary } from "@demoman/studio-protocol";
import { page, userEvent } from "@vitest/browser/context";
import { beforeEach, describe, expect, it, vi } from "vitest";
// The page's own markup and rules, and the real view, so the rows the keys
// move over are the rows the page renders.
import shell from "../../../pages/entrypoints/library/index.html?raw";
import { TYPE_AHEAD_MS } from "../../../pages/src/library/list-keys";
import { nextSort } from "../../../pages/src/library/list-model";
import {
  clickSelect,
  emptySelection,
  type Selection,
  selectAll,
} from "../../../pages/src/library/selection";
import type {
  LibraryModel,
  LibraryRow,
  VideoGroup,
} from "../../../pages/src/library/state";
import {
  applySelection,
  type LibraryActions,
  renderLibrary,
} from "../../../pages/src/library/view";
import { mountShell, node, pageParts } from "../helpers/shell-css";

/**
 * The list's keyboard (spec 2026-10-31-library-list-view §4.3): the APG
 * treegrid's, with the Mac's keys. Real keys throughout, through
 * `userEvent.keyboard`; every failure says where focus was and which rows
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
const MODEL: LibraryModel = {
  usedBytes: 0,
  budgetBytes: 0,
  fraction: 1,
  chromeNearLimit: false,
  migrating: false,
  migrationFailed: false,
  notice: null,
  rows: [a2, a1, b1, e1, loose, c1, d1],
  groups: [
    flow("A", "Create an invoice", [a2, a1]),
    flow("B", "Edit profile", [b1]),
    flow("E", "Export a report", [e1]),
    flow("C", "Sign up", [c1]),
    flow("D", "Archive", [d1]),
  ],
};

type Bulk = { busy: boolean; said: string | null };

let selection: Selection;
let bulk: Bulk | undefined;
let acts: ReturnType<typeof actions>;

/** The page's selection, as main.ts composes it: the real `selection.ts`,
 *  shown in place by the real `applySelection`. */
function actions() {
  const show = (): void => applySelection(node("#root"), acts, selection, bulk);
  return {
    edit: vi.fn(),
    restore: vi.fn(),
    backToRecording: vi.fn(),
    remove: vi.fn(),
    preview: vi.fn(),
    rename: vi.fn(),
    renameVideo: vi.fn(),
    setView: vi.fn(),
    select: vi.fn<NonNullable<LibraryActions["select"]>>(
      (id, how, order, from) => {
        selection = clickSelect(selection, id, how, order, from);
        show();
      },
    ),
    selectAll: vi.fn<NonNullable<LibraryActions["selectAll"]>>((order) => {
      selection = selectAll(selection, order);
      show();
    }),
    clearSelection: vi.fn(),
    deleteSelected: vi.fn(),
  };
}

/** Focusable stops just before and after the list, to see a Tab enter
 *  and leave it. */
let before: HTMLButtonElement;
let after: HTMLButtonElement;

const SORT = { column: "recorded", descending: true } as const;

function mount(ticked: readonly string[] = [], withBulk?: Bulk) {
  mountShell("dark", css);
  document.body.innerHTML = body;
  after = document.createElement("button");
  after.textContent = "after";
  document.body.append(after);
  selection = { ids: new Set(ticked), anchor: ticked[0] ?? null, range: [] };
  if (ticked.length === 0) selection = emptySelection();
  bulk = withBulk;
  acts = actions();
  renderLibrary(node("#root"), MODEL, acts, new Map(), NOW, selection, bulk, {
    layout: "list",
    sort: SORT,
    project: null,
  });
  before = document.createElement("button");
  before.textContent = "before";
  grid().before(before);
}

const grid = (): HTMLElement => node("[data-list]");
const row = (key: string): HTMLElement =>
  node(`[data-list] [role=row][data-key="${key}"]`);
const onScreen = (): string[] =>
  [
    ...grid().querySelectorAll<HTMLElement>(
      "[role=row][data-key]:not([hidden])",
    ),
  ].map((r) => r.dataset.key as string);
/** Where focus is: a row's key, `key/col` for a cell or a control in it,
 *  `head/col` for a column heading, else what holds it outside the list. */
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
  return `${r.dataset.key}/${a.closest<HTMLElement>("[role=gridcell]")?.dataset.col}`;
}
const where = (): string =>
  `focused ${focused()}; rows on screen ${onScreen().join(", ")}`;
const ticked = (): string[] =>
  [
    ...grid().querySelectorAll<HTMLElement>('[role=row][aria-selected="true"]'),
  ].map((r) => r.dataset.key as string);
/** Everything in the grid a Tab can land on, by its tab order rather than
 *  its attribute: a button with no `tabindex` is a stop too. */
const tabStops = (): string[] =>
  [...grid().querySelectorAll<HTMLElement>("*")]
    .filter(
      (e) =>
        e.tabIndex >= 0 &&
        !(e as HTMLButtonElement).disabled &&
        e.closest("[hidden]") === null,
    )
    .map(
      (e) =>
        e.dataset.key ??
        e.closest<HTMLElement>("[data-key]")?.dataset.key ??
        (e.closest("[data-list-head]") !== null
          ? `head/${e.closest<HTMLElement>("[role=columnheader]")?.dataset.col}`
          : e.tagName),
    );

/** Enters the list the way the author does: one Tab from the stop before
 *  it. */
async function enter(): Promise<void> {
  before.focus();
  await userEvent.keyboard("{Tab}");
}

async function press(keys: string, expected: string): Promise<void> {
  await userEvent.keyboard(keys);
  expect(focused(), `after ${keys}: ${where()}`).toBe(expected);
}

/**
 * Records, from now until `stop`, where focus was after each key and when
 * each key went down: a type-ahead's premise is that no two keys of one
 * search are further apart than `TYPE_AHEAD_MS`, which only the keys' own
 * times can say (CI's runner is about 5x slower than a laptop).
 */
function recordKeys() {
  const after: string[] = [];
  const at: number[] = [];
  const down = (e: KeyboardEvent) => at.push(e.timeStamp);
  const up = () => after.push(focused());
  document.addEventListener("keydown", down, true);
  document.addEventListener("keyup", up, true);
  return {
    after,
    /** The longest pause between two keys, and the premise's message. */
    pause(): { ms: number; said: string } {
      const ms = Math.max(0, ...at.slice(1).map((t, i) => t - (at[i] ?? t)));
      return {
        ms,
        said: `premise: the longest pause between keys was ${ms.toFixed(0)} ms, the search lapses after ${TYPE_AHEAD_MS}; ${where()}`,
      };
    },
    stop() {
      document.removeEventListener("keydown", down, true);
      document.removeEventListener("keyup", up, true);
    },
  };
}

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
    // A has two videos, hidden while it is closed; D is under a folded month.
    expect(row("v:a2").hidden).toBe(true);
    expect(row("v:a1").hidden).toBe(true);
    expect(row("f:D").hidden).toBe(true);
    // The actions cell holds more than one control, so End has a choice.
    expect(
      row("f:A").querySelectorAll('[data-col="actions"] button').length,
    ).toBeGreaterThan(1);
  });
});

describe("Tab", () => {
  it("enters the grid once and the next Tab leaves it", async () => {
    mount();
    expect(tabStops(), where()).toEqual(["h:today"]);
    await enter();
    expect(focused(), where()).toBe("h:today");
    await press("{ArrowDown}", "f:A");
    expect(tabStops(), where()).toEqual(["f:A"]);
    await press("{ArrowRight}{ArrowRight}", "f:A/select");
    expect(tabStops(), where()).toEqual(["f:A"]);
    // Out of the cells, A closed again, and on to B.
    await press("{ArrowLeft}{ArrowLeft}{ArrowDown}", "f:B");
    await userEvent.keyboard("{Tab}");
    expect(document.activeElement, where()).toBe(after);
    // Back in, at the row last focused.
    await press("{Shift>}{Tab}{/Shift}", "f:B");
    expect(tabStops(), where()).toEqual(["f:B"]);
    // And out the other way, past the head.
    await userEvent.keyboard("{Shift>}{Tab}{/Shift}");
    expect(document.activeElement, where()).toBe(before);
  });
});

describe("the column headings", () => {
  it("↑ from the first row reaches Name; Enter sorts by it; ↓ returns", async () => {
    mount();
    await enter();
    await press("{ArrowUp}", "head/name");
    // The head holds the one Tab stop while it has focus.
    expect(tabStops(), where()).toEqual(["head/name"]);
    await press("{Enter}", "head/name");
    expect(acts.setView, where()).toHaveBeenCalledWith({
      layout: "list",
      sort: nextSort(SORT, "name"),
      project: null,
    });
    await press("{ArrowDown}", "h:today");
    expect(tabStops(), where()).toEqual(["h:today"]);
  });

  it("↑ from a cell keeps a sortable column; ← and → walk the headings; Home, End and letters do nothing", async () => {
    mount();
    await enter();
    // Today is open, so → enters its cells: select, open, name, …,
    // size, recorded, actions.
    await press("{ArrowRight}", "h:today/select");
    await press("{End}", "h:today/actions");
    await press("{ArrowLeft}", "h:today/recorded");
    await press("{ArrowLeft}", "h:today/size");
    await press("{ArrowRight}", "h:today/recorded");
    await press("{ArrowUp}", "head/recorded");
    // Recorded is the last sort; Length has none, so ← skips it.
    await press("{ArrowRight}", "head/recorded");
    await press("{ArrowLeft}", "head/size");
    await press("{ArrowLeft}", "head/videos");
    await press("{Home}{End}e", "head/videos");
    // A column with no sort button goes to Name's.
    await press("{ArrowDown}{ArrowRight}{ArrowRight}", "h:today/open");
    await press("{ArrowUp}", "head/name");
    expect(acts.setView, where()).not.toHaveBeenCalled();
  });
});

// Red: list-keys.ts stepping by index over every sort button, so ← and →
// land on a heading the narrow list does not draw and focus vanishes.
it("at 560px ← and → skip the headings a narrow list drops", async () => {
  await page.viewport(560, 900);
  mount();
  const drawn = (col: string) =>
    node(`[data-list-head] [data-col="${col}"] [data-sort]`).checkVisibility();
  // Premise: Videos and Size are dropped, Where and Recorded drawn.
  expect(["where", "videos", "recorded", "size"].map(drawn)).toEqual([
    true,
    false,
    true,
    false,
  ]);
  await enter();
  await press("{ArrowRight}{End}{ArrowLeft}", "h:today/recorded");
  await press("{ArrowUp}", "head/recorded");
  await press("{ArrowRight}", "head/recorded");
  await press("{ArrowLeft}", "head/where");
  await press("{ArrowRight}", "head/recorded");
});

describe("moving", () => {
  it("↓ and ↑ skip hidden rows", async () => {
    mount();
    await enter();
    const down = onScreen();
    for (const key of down.slice(1)) await press("{ArrowDown}", key);
    // The last row stays the last.
    await press("{ArrowDown}", down[down.length - 1] as string);
    for (const key of down.slice(0, -1).reverse()) {
      await press("{ArrowUp}", key);
    }
  });

  it("→ opens a closed flow, then enters its first cell; ← leaves the first cell, closes, then goes to the parent", async () => {
    mount();
    await enter();
    await press("{ArrowDown}{ArrowRight}", "f:A");
    expect(row("f:A").getAttribute("aria-expanded"), where()).toBe("true");
    expect(row("v:a2").hidden, where()).toBe(false);
    await press("{ArrowRight}", "f:A/select");
    await press("{ArrowRight}", "f:A/open");
    await press("{ArrowLeft}", "f:A/select");
    await press("{ArrowLeft}", "f:A");
    await press("{ArrowLeft}", "f:A");
    expect(row("f:A").getAttribute("aria-expanded"), where()).toBe("false");
    expect(row("v:a2").hidden, where()).toBe(true);
    await press("{ArrowLeft}", "h:today");
  });

  it("← on a video row goes to its flow; a row with no children enters its cells", async () => {
    mount();
    await enter();
    await press("{ArrowDown}{ArrowRight}{ArrowDown}{ArrowDown}", "v:a1");
    await press("{ArrowLeft}", "f:A");
    await press("{ArrowDown}{ArrowRight}", "v:a2/select");
  });

  it("in cells, ↓ and ↑ keep the column", async () => {
    mount();
    await enter();
    // The first → opens A; the next three walk to its name.
    await press(
      "{ArrowDown}{ArrowRight}{ArrowRight}{ArrowRight}{ArrowRight}",
      "f:A/name",
    );
    await press("{ArrowDown}", "v:a2/name");
    await press("{ArrowDown}{ArrowDown}", "f:B/name");
    await press("{ArrowUp}", "v:a1/name");
  });

  it("Home and End: first and last row; in cells, first and last cell", async () => {
    mount();
    await enter();
    const rows = onScreen();
    await press("{End}", rows[rows.length - 1] as string);
    await press("{Home}", "h:today");
    await press("{ArrowDown}{ArrowRight}{ArrowRight}{End}", "f:A/actions");
    expect(
      (document.activeElement as HTMLElement).dataset.action,
      `the last control in the row: ${where()}`,
    ).toBe("delete");
    await press("{Home}", "f:A/select");
  });

  it("Cmd+↑ and Cmd+↓: first and last row, keeping the column in cells", async () => {
    mount();
    await enter();
    const rows = onScreen();
    const last = rows[rows.length - 1] as string;
    await press("{ArrowDown}{ArrowDown}", "f:B");
    await press("{Meta>}{ArrowDown}{/Meta}", last);
    await press("{Meta>}{ArrowUp}{/Meta}", "h:today");
    await press(
      "{ArrowDown}{ArrowRight}{ArrowRight}{ArrowRight}{ArrowRight}",
      "f:A/name",
    );
    await press("{Meta>}{ArrowDown}{/Meta}", `${last}/name`);
    await press("{Meta>}{ArrowUp}{/Meta}", "h:today/name");
  });

  it("Page Up and Page Down move a screenful of rows", async () => {
    mount();
    const rowHeight = row("f:A").offsetHeight;
    // Room for two rows and a half: a screenful is two rows.
    await page.viewport(1280, Math.round(rowHeight * 2.5));
    const fit = Math.floor(document.documentElement.clientHeight / rowHeight);
    // Premise: more than one row, and fewer than the list holds.
    expect(fit, `${rowHeight}px rows`).toBe(2);
    await enter();
    await press("{ArrowDown}", "f:A");
    await press("{PageDown}", "f:E");
    await press("{PageUp}", "f:A");
    const rows = onScreen();
    await press(
      "{PageDown}{PageDown}{PageDown}{PageDown}",
      rows[rows.length - 1] as string,
    );
    await press("{PageUp}{PageUp}{PageUp}{PageUp}", "h:today");
  });
});

describe("Enter", () => {
  it("on a flow row opens it, and on a video row that video", async () => {
    mount();
    await enter();
    await press("{ArrowDown}{Enter}", "f:A");
    expect(acts.edit, where()).toHaveBeenCalledWith("a2");
    await press("{ArrowRight}{ArrowDown}{ArrowDown}{Enter}", "v:a1");
    expect(acts.edit, where()).toHaveBeenLastCalledWith("a1");
    expect(acts.edit).toHaveBeenCalledTimes(2);
  });

  it("on a heading row folds and unfolds it", async () => {
    mount();
    await enter();
    await press("{Enter}", "h:today");
    expect(row("h:today").getAttribute("aria-expanded"), where()).toBe("false");
    expect(onScreen().slice(0, 2), where()).toEqual(["h:today", "h:yesterday"]);
    await press("{Enter}", "h:today");
    expect(row("f:A").hidden, where()).toBe(false);
    expect(acts.edit).not.toHaveBeenCalled();
  });

  it("on the name cell opens the field, focused", async () => {
    mount();
    await enter();
    await press("{ArrowDown}{ArrowRight}{ArrowRight}{ArrowRight}", "f:A/open");
    await press("{ArrowRight}{Enter}", "f:A/name");
    const field = document.activeElement as HTMLInputElement;
    expect(field.matches("[data-name]"), where()).toBe(true);
    expect(field.value, where()).toBe("Create an invoice");
    expect(acts.edit, where()).not.toHaveBeenCalled();
  });
});

describe("selecting", () => {
  // Red: Enter falling through to `edit` while flows are ticked (DEM-35).
  it("Enter while flows are ticked does what a click does: a flow toggles, a video opens nothing", async () => {
    mount(["B"]);
    expect(ticked(), "the fixture ticks B").toEqual(["f:B"]);
    await enter();
    await press("{ArrowDown}{Enter}", "f:A");
    expect(acts.select, where()).toHaveBeenCalledWith("A", "toggle", [
      "A",
      "B",
      "E",
      "C",
    ]);
    await press("{ArrowRight}{ArrowDown}{ArrowDown}{Enter}", "v:a1");
    expect(acts.edit, where()).not.toHaveBeenCalled();
    expect(ticked(), where()).toEqual(["f:A", "f:B"]);
  });

  it("Space toggles the flow, from the row, a cell with no control, or its checkbox", async () => {
    mount();
    await enter();
    await press("{ArrowDown} ", "f:A");
    expect(acts.select, where()).toHaveBeenCalledWith("A", "toggle", [
      "A",
      "B",
      "E",
      "C",
    ]);
    expect(ticked(), where()).toEqual(["f:A"]);
    // The first → opens A; the next three walk to its name.
    await press(
      "{ArrowRight}{ArrowRight}{ArrowRight}{ArrowRight} ",
      "f:A/name",
    );
    expect(ticked(), where()).toEqual([]);
    // On the checkbox itself: one tick, not the key's and the box's own.
    await press("{Home} ", "f:A/select");
    expect(ticked(), where()).toEqual(["f:A"]);
    expect(
      (row("f:A").querySelector("[data-select]") as HTMLInputElement).checked,
      where(),
    ).toBe(true);
    // A take in no flow is not a flow: nothing to tick. Back to the row,
    // A closed, and down to it.
    await press(
      "{Escape}{ArrowLeft}{ArrowDown}{ArrowDown}{ArrowDown} ",
      "t:loose",
    );
    expect(acts.select, where()).toHaveBeenCalledTimes(3);
  });

  it("Shift+↓ twice then Shift+↑ once leaves the anchor and one more", async () => {
    mount();
    await enter();
    await press("{ArrowDown} ", "f:A");
    await press("{Shift>}{ArrowDown}{ArrowDown}{/Shift}", "f:E");
    expect(ticked(), where()).toEqual(["f:A", "f:B", "f:E"]);
    await press("{Shift>}{ArrowUp}{/Shift}", "f:B");
    expect(ticked(), where()).toEqual(["f:A", "f:B"]);
  });

  // Red: selection.ts's range dropping every id of the last range, so C,
  // folded away under Yesterday, left the selection unseen.
  it("a Shift range keeps a flow a fold has hidden since the last one", async () => {
    mount();
    await enter();
    await press("{ArrowDown} ", "f:A");
    // Over B, E, the take in no flow and Yesterday's heading to C.
    await press(
      "{Shift>}{ArrowDown}{ArrowDown}{ArrowDown}{ArrowDown}{ArrowDown}{/Shift}",
      "f:C",
    );
    expect(ticked(), where()).toEqual(["f:A", "f:B", "f:E", "f:C"]);
    await press("{ArrowUp}{Enter}", "h:yesterday");
    // Premise: C is off screen now.
    expect(row("f:C").hidden, where()).toBe(true);
    await press("{ArrowUp}{ArrowUp}{Shift>}{ArrowUp}{/Shift}", "f:B");
    expect(ticked(), where()).toEqual(["f:A", "f:B", "f:C"]);
  });

  // Red: the row the move started from left out (with no anchor the
  // range was a toggle of the next flow alone), or `from` not sent.
  it("Shift+↓ with nothing ticked ticks the row it starts from too; Shift+↑ shrinks back to it", async () => {
    mount();
    await enter();
    await press("{ArrowDown}", "f:A");
    // Premise: nothing is ticked, so there is no anchor.
    expect(ticked(), where()).toEqual([]);
    await press("{Shift>}{ArrowDown}{/Shift}", "f:B");
    expect(ticked(), where()).toEqual(["f:A", "f:B"]);
    await press("{Shift>}{ArrowUp}{/Shift}", "f:A");
    expect(ticked(), where()).toEqual(["f:A"]);
  });

  it("Cmd+A selects only the flows on screen", async () => {
    mount();
    await enter();
    // Yesterday folded: C is off screen, as D is under its month.
    await press("{End}{ArrowUp}{ArrowUp}{Enter}", "h:yesterday");
    expect(row("f:C").hidden, where()).toBe(true);
    await press("{Meta>}a{/Meta}", "h:yesterday");
    expect(acts.selectAll, where()).toHaveBeenCalledWith(["A", "B", "E"]);
    expect(ticked(), where()).toEqual(["f:A", "f:B", "f:E"]);
  });

  it("Escape in a cell goes back to the row and keeps the selection; on a row it is the page's", async () => {
    mount(["A"]);
    const reached: boolean[] = [];
    const listen = (e: KeyboardEvent) => {
      if (e.key === "Escape") reached.push(e.defaultPrevented);
    };
    document.addEventListener("keydown", listen);
    try {
      await enter();
      await press("{ArrowDown}{ArrowRight}{ArrowRight}", "f:A/select");
      await press("{Escape}", "f:A");
      // main.ts's listener clears on Escape: it must not hear this one.
      expect(reached, where()).toEqual([]);
      await press("{Escape}", "f:A");
      expect(reached, where()).toEqual([false]);
    } finally {
      document.removeEventListener("keydown", listen);
    }
  });
});

describe("Cmd+Backspace", () => {
  it("with a selection deletes the selection", async () => {
    mount(["B"]);
    await enter();
    await press("{ArrowDown}{Meta>}{Backspace}{/Meta}", "f:A");
    expect(acts.deleteSelected, where()).toHaveBeenCalledTimes(1);
    expect(acts.remove, where()).not.toHaveBeenCalled();
  });

  it("without one deletes the focused flow, video or take", async () => {
    mount();
    await enter();
    await press("{ArrowDown}{ArrowDown}{Meta>}{Backspace}{/Meta}", "f:B");
    expect(acts.remove, where()).toHaveBeenLastCalledWith("B", "video");
    await press("{ArrowUp}{ArrowRight}{ArrowDown}{ArrowDown}", "v:a1");
    await userEvent.keyboard("{Meta>}{Backspace}{/Meta}");
    expect(acts.remove, where()).toHaveBeenLastCalledWith("a1", "take");
    await press("{End}{ArrowUp}{ArrowUp}{ArrowUp}", "t:loose");
    await userEvent.keyboard("{Meta>}{Backspace}{/Meta}");
    expect(acts.remove, where()).toHaveBeenLastCalledWith("loose", "take");
    expect(acts.remove).toHaveBeenCalledTimes(3);
    expect(acts.deleteSelected).not.toHaveBeenCalled();
  });
});

describe("type-ahead", () => {
  it('"ex" jumps to Export a report; after a pause "c" starts a new search', async () => {
    mount();
    await enter();
    // Premise: "e" alone is Edit profile, before Export.
    await press("e", "f:B");
    const keys = recordKeys();
    try {
      await press("{Home}ex", "f:E");
      const { ms, said } = keys.pause();
      expect(ms, said).toBeLessThanOrEqual(TYPE_AHEAD_MS);
    } finally {
      keys.stop();
    }
    const typedAt = performance.now();
    // Not a fixed sleep: wait until the search has lapsed, however long
    // the lane took to get here.
    await vi.waitFor(
      () => {
        if (performance.now() - typedAt <= TYPE_AHEAD_MS) {
          throw new Error("the search has not lapsed yet");
        }
      },
      { timeout: TYPE_AHEAD_MS * 4 },
    );
    await userEvent.keyboard("c");
    // "exc" matches nothing; a new search for "c" wraps round to Create.
    await vi.waitFor(() => {
      expect(focused(), where()).toBe("f:A");
    });
  });

  // Red: a Space inside a search falling through to Space's own case,
  // which ticks the focused flow and ends the search, so the "a" after it
  // starts a new one and jumps to Archive.
  it('a Space inside a search is part of it: "export a" finds Export a report and ticks nothing', async () => {
    mount();
    await enter();
    // The past month open, so Archive is on screen for a lone "a" to find.
    await press("{End}{Enter}", onScreen().at(-1) as string);
    expect(row("f:D").hidden, where()).toBe(false);
    await press("{Home}", "h:today");
    const keys = recordKeys();
    try {
      await userEvent.keyboard("export a");
      const { ms, said } = keys.pause();
      expect(ms, said).toBeLessThanOrEqual(TYPE_AHEAD_MS);
    } finally {
      keys.stop();
    }
    expect(focused(), where()).toBe("f:E");
    expect(ticked(), where()).toEqual([]);
    expect(acts.select, where()).not.toHaveBeenCalled();
  });
});

describe("type-ahead after another key", () => {
  it("a letter after an arrow or a fold searches from where focus is", async () => {
    mount();
    await enter();
    const keys = recordKeys();
    try {
      // "e" is Edit profile; ↓↑ ends the search, so from B the next "e" is
      // Export; →← (open E, close it) moves nothing and ends it too, so
      // from E "e" wraps round to Edit profile.
      await userEvent.keyboard(
        "e{ArrowDown}{ArrowUp}e{ArrowRight}{ArrowLeft}e",
      );
      expect(keys.after, where()).toEqual([
        "f:B",
        "f:E",
        "f:B",
        "f:E",
        "f:E",
        "f:E",
        "f:B",
      ]);
      // Premise: all of it inside one search's pause, so it was the keys
      // that ended each search, not a lapse.
      const { ms, said } = keys.pause();
      expect(ms, said).toBeLessThanOrEqual(TYPE_AHEAD_MS);
    } finally {
      keys.stop();
    }
  });

  it("a letter after a click searches from where the click put focus", async () => {
    mount();
    await enter();
    const keys = recordKeys();
    try {
      await press("e", "f:B");
      // E's chevron: it opens E and focuses its cell.
      await userEvent.click(
        row("f:E").querySelector('[data-col="open"]') as HTMLElement,
      );
      expect(focused(), where()).toBe("f:E/open");
      // From E, the next "e" wraps round to Edit profile.
      await press("e", "f:B/open");
      // Premise: the click, not a lapse, started the new search.
      const { ms, said } = keys.pause();
      expect(ms, said).toBeLessThanOrEqual(TYPE_AHEAD_MS);
    } finally {
      keys.stop();
    }
  });
});

describe("Cmd+A on a flow's actions", () => {
  it("moves focus to the row, which the selection does not hide", async () => {
    mount();
    await enter();
    await press("{ArrowDown}{ArrowRight}{ArrowRight}{End}", "f:A/actions");
    await press("{Meta>}a{/Meta}", "f:A");
    // Premise: the row's actions are hidden now.
    expect(ticked(), where()).toContain("f:A");
    const actionsCell = row("f:A").querySelector(
      '[data-col="actions"]',
    ) as HTMLElement;
    expect(
      actionsCell.checkVisibility({ visibilityProperty: true }),
      where(),
    ).toBe(false);
    expect(
      (document.activeElement as HTMLElement).checkVisibility({
        visibilityProperty: true,
      }),
      where(),
    ).toBe(true);
  });
});

describe("Space on a flow row's button", () => {
  // Red: Space in a cell selecting the flow from any cell, and cancelling
  // the button's own press.
  it("presses it: Rename opens the name field and ticks nothing", async () => {
    mount();
    await enter();
    // The first → opens A, the next moves into its cells; End is Delete,
    // and Rename sits before Edit.
    await press(
      "{ArrowDown}{ArrowRight}{ArrowRight}{End}{ArrowLeft}{ArrowLeft}",
      "f:A/actions",
    );
    // Premise: focus is on the Rename button.
    expect(
      (document.activeElement as HTMLElement).getAttribute("aria-label"),
      where(),
    ).toMatch(/^Rename /);
    await userEvent.keyboard(" ");
    const field = document.activeElement as HTMLInputElement;
    expect(field.matches("[data-name]"), where()).toBe(true);
    expect(field.value, where()).toBe("Create an invoice");
    expect(ticked(), where()).toEqual([]);
    expect(acts.select, where()).not.toHaveBeenCalled();
  });
});

describe("Cmd+A on a video's actions", () => {
  // Red: focus left on a control the selecting state hides (video rows'
  // actions hide as flow rows' do).
  it("moves focus to the video's row, which the selection does not hide", async () => {
    mount();
    await enter();
    // The first → opens A; ↓ is its newest video.
    await press("{ArrowDown}{ArrowRight}{ArrowDown}", "v:a2");
    await press("{ArrowRight}{End}", "v:a2/actions");
    await press("{Meta>}a{/Meta}", "v:a2");
    // Premise: the video row's actions are hidden now.
    const actionsCell = row("v:a2").querySelector(
      '[data-col="actions"]',
    ) as HTMLElement;
    expect(
      actionsCell.checkVisibility({ visibilityProperty: true }),
      where(),
    ).toBe(false);
  });
});

describe("while a bulk delete runs", () => {
  it("Space, Cmd+A, Shift+↓ and Cmd+Backspace change nothing", async () => {
    mount(["A"], { busy: true, said: null });
    // Premise: the page shows it busy, as main.ts's run does.
    expect(
      (row("f:B").querySelector("[data-select]") as HTMLInputElement).disabled,
    ).toBe(true);
    await enter();
    await press("{ArrowDown}{ArrowDown} ", "f:B");
    await userEvent.keyboard("{Meta>}a{/Meta}");
    await press("{Shift>}{ArrowDown}{/Shift}", "f:B");
    await userEvent.keyboard("{Meta>}{Backspace}{/Meta}");
    expect(ticked(), where()).toEqual(["f:A"]);
    for (const call of [
      acts.select,
      acts.selectAll,
      acts.deleteSelected,
      acts.remove,
    ]) {
      expect(call, where()).not.toHaveBeenCalled();
    }
    expect(document.querySelector("dialog[open]"), where()).toBeNull();
  });
});

describe("while a name is being typed", () => {
  it("the grid's keys stand down", async () => {
    mount();
    await enter();
    // The first → opens A; the next three walk to its name.
    await press(
      "{ArrowDown}{ArrowRight}{ArrowRight}{ArrowRight}{ArrowRight}{Enter}",
      "f:A/name",
    );
    const field = document.activeElement as HTMLInputElement;
    expect(field.matches("[data-name]"), where()).toBe(true);
    await userEvent.keyboard("{ArrowDown}{Home} e{Meta>}a{/Meta}");
    expect(document.activeElement, where()).toBe(field);
    // Enter is the field's: it saves, and opens nothing.
    await userEvent.keyboard("{Enter}");
    expect(acts.renameVideo, where()).toHaveBeenCalledTimes(1);
    expect(acts.select).not.toHaveBeenCalled();
    expect(acts.selectAll).not.toHaveBeenCalled();
    expect(acts.edit).not.toHaveBeenCalled();
  });
});

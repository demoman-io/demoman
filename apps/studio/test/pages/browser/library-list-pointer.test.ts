import type { VideoSummary } from "@demoman/studio-protocol";
import { commands, page, userEvent } from "@vitest/browser/context";
import { beforeEach, describe, expect, it, vi } from "vitest";
// The page's own markup and rules, and the real view, so the rows clicked
// are the rows the page renders.
import shell from "../../../pages/entrypoints/library/index.html?raw";
import type { Selection } from "../../../pages/src/library/selection";
import type {
  LibraryModel,
  LibraryRow,
  VideoGroup,
} from "../../../pages/src/library/state";
import { renderLibrary } from "../../../pages/src/library/view";
import type { PagePoint } from "../helpers/point-command";
import { mountShell, node, pageParts } from "../helpers/shell-css";

declare module "@vitest/browser/context" {
  interface BrowserCommands {
    /** See `test/helpers/point-command.ts`; registered in `vitest.config.ts`. */
    pressBetween: (from: PagePoint, to: PagePoint | null) => Promise<void>;
  }
}

/**
 * What a click does in the library's list (spec 2026-10-31
 * library-list-view §4.2, §4.4): it opens, like a card, with the card's
 * exceptions. Real input throughout — a synthetic click has no pointerdown
 * and no text selection, which two of the exceptions turn on.
 */

const { css, body } = pageParts(shell, "[data-selecting] .select-box");

const NOW = new Date(2026, 9, 30, 12);

const take = (
  sceneId: string,
  at: Date,
  extra: Partial<LibraryRow> = {},
): LibraryRow => ({
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
  ...extra,
});

const flow = (id: string, versions: LibraryRow[]): VideoGroup => {
  const numbered = versions.map((v, i) => ({
    ...v,
    version: versions.length - i,
  }));
  return {
    video: {
      id,
      name: `Flow ${id}`,
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

// Today: A (two videos), B (its motion reclaimed: a rerun line), E (its
// lead expired); Yesterday: C; a past month, folded by default: D. And a
// take in no flow, today.
const a2 = take("a2", new Date(2026, 9, 30, 9));
const a1 = take("a1", new Date(2026, 9, 30, 8, 30));
const b1 = take("b1", new Date(2026, 9, 30, 8), { canRestore: true });
const e1 = take("e1", new Date(2026, 9, 30, 7), { expired: true });
const c1 = take("c1", new Date(2026, 9, 29, 10));
const d1 = take("d1", new Date(2026, 8, 1, 9));
const loose = take("loose", new Date(2026, 9, 30, 6));
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
    flow("A", [a2, a1]),
    flow("B", [b1]),
    flow("E", [e1]),
    flow("C", [c1]),
    flow("D", [d1]),
  ],
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
  setView: vi.fn(),
  rerunLine: () => "Run `run({ flow })` again to film it.",
});

let acts: ReturnType<typeof actions>;

function mount(selection?: Selection, layout: "list" | "grid" = "list") {
  mountShell("dark", css);
  document.body.innerHTML = body;
  acts = actions();
  renderLibrary(
    node("#root"),
    MODEL,
    acts,
    new Map(),
    NOW,
    selection,
    undefined,
    {
      layout,
      sort: { column: "recorded", descending: true },
      project: null,
    },
  );
}

const row = (key: string): HTMLElement =>
  node(`[data-list] [role=row][data-key="${key}"]`);
const cell = (key: string, col: string): HTMLElement =>
  row(key).querySelector(`[data-col="${col}"]`) as HTMLElement;
const nameText = (key: string): HTMLElement =>
  cell(key, "name").querySelector("[data-name-text]") as HTMLElement;

beforeEach(async () => {
  await page.viewport(1280, 900);
  window.getSelection()?.removeAllRanges();
});

describe("the fixture", () => {
  it("has what the cases below sample", () => {
    mount();
    // Flows start closed: a flow's videos are hidden until it opens.
    expect(row("f:A").getAttribute("aria-expanded")).toBe("false");
    expect(row("v:a2").hidden).toBe(true);
    // E's lead has no footage here; A's does.
    expect(e1.expired).toBe(true);
    expect(
      MODEL.groups?.find((g) => g.video.id === "E")?.current?.sceneId,
    ).toBe("e1");
    // D sits under a past month, folded at first.
    const month = row("f:D").previousElementSibling as HTMLElement;
    expect(month.dataset.heading).toMatch(/^month:/);
    expect(month.getAttribute("aria-expanded")).toBe("false");
    expect(row("f:D").hidden).toBe(true);
    // C sits under Yesterday, open at first.
    expect(row("h:yesterday").getAttribute("aria-expanded")).toBe("true");
    expect(row("f:C").hidden).toBe(false);
    // A flow row carries a checkbox and a Delete.
    expect(row("f:A").querySelector("[data-select]")).not.toBeNull();
    expect(row("f:A").querySelector('[data-action="delete"]')).not.toBeNull();
    // B, which has footage here, says its rerun line, with a code span.
    expect(row("f:B").hasAttribute("data-absent")).toBe(false);
    expect(
      row("f:B").querySelector("[data-status] [data-rerun-line] code")
        ?.textContent,
    ).toBe("run({ flow })");
  });
});

describe("a click in the list", () => {
  it("on a flow row opens its row's video", async () => {
    mount();
    await userEvent.click(nameText("f:A"));
    expect(acts.edit).toHaveBeenCalledTimes(1);
    expect(acts.edit).toHaveBeenCalledWith("a2");
    // Where, not Recorded: the hovered row's actions float over its end.
    await userEvent.click(cell("f:B", "where"));
    expect(acts.edit).toHaveBeenLastCalledWith("b1");
  });

  it("on a video row opens that video", async () => {
    mount();
    await userEvent.click(cell("f:A", "open"));
    await userEvent.click(nameText("v:a1"));
    expect(acts.edit).toHaveBeenCalledTimes(1);
    expect(acts.edit).toHaveBeenCalledWith("a1");
  });

  it("on a take in no flow opens it", async () => {
    mount();
    await userEvent.click(nameText("t:loose"));
    expect(acts.edit).toHaveBeenCalledWith("loose");
  });

  it("on the chevron opens the flow and does not call edit", async () => {
    mount();
    await userEvent.click(cell("f:A", "open"));
    expect(row("f:A").getAttribute("aria-expanded")).toBe("true");
    expect(row("v:a2").hidden).toBe(false);
    expect(row("v:a1").hidden).toBe(false);
    expect(acts.edit).not.toHaveBeenCalled();
    // And closes it again, in place: the same row element, not a redraw.
    const before = row("f:A");
    await userEvent.click(cell("f:A", "open"));
    expect(row("f:A")).toBe(before);
    expect(row("f:A").getAttribute("aria-expanded")).toBe("false");
    expect(row("v:a2").hidden).toBe(true);
  });

  it("on a checkbox selects and does not call edit", async () => {
    mount();
    await userEvent.click(node('[data-list] [data-select="A"]'));
    expect(acts.select).toHaveBeenCalledWith("A", "toggle", [
      "A",
      "B",
      "E",
      "C",
    ]);
    expect(acts.edit).not.toHaveBeenCalled();
  });

  it("on a button does that button's thing and does not call edit", async () => {
    mount();
    await userEvent.click(
      row("f:A").querySelector('[data-action="delete"]') as HTMLElement,
    );
    expect(acts.remove).toHaveBeenCalledTimes(1);
    expect(acts.edit).not.toHaveBeenCalled();
    // The row's own Edit opens the editor once, not once for the button
    // and again for the row.
    await userEvent.click(
      row("f:A").querySelector('[data-action="edit"]') as HTMLElement,
    );
    expect(acts.edit).toHaveBeenCalledTimes(1);
  });

  it("that ends a text selection does not call edit", async () => {
    mount();
    const text = nameText("f:A");
    text.scrollIntoView({ block: "center" });
    const r = text.getBoundingClientRect();
    const y = r.top + r.height / 2;
    await commands.pressBetween({ x: r.left + 1, y }, { x: r.right - 1, y });
    // Premise: the drag selected the name, so the click it ends is copying.
    expect(window.getSelection()?.toString()).not.toBe("");
    expect(acts.edit).not.toHaveBeenCalled();
  });

  // Red: the rows' `user-select: none` reaching the status line (the drag
  // selects nothing, and the click it ends opens the editor), or a click
  // on the line opening the editor or ticking the flow.
  it("on the status line selects its text and opens nothing, with nothing ticked or with flows ticked", async () => {
    mount();
    const code = row("f:B").querySelector(
      "[data-status] [data-rerun-line] code",
    ) as HTMLElement;
    code.scrollIntoView({ block: "center" });
    const r = code.getBoundingClientRect();
    const y = r.top + r.height / 2;
    await commands.pressBetween({ x: r.left + 1, y }, { x: r.right - 1, y });
    expect(window.getSelection()?.toString(), "the drag's text").toContain(
      "run({",
    );
    expect(acts.edit).not.toHaveBeenCalled();
    window.getSelection()?.removeAllRanges();
    await userEvent.click(code);
    expect(acts.edit).not.toHaveBeenCalled();
    mount({ ids: new Set(["A"]), anchor: "A", range: [] });
    await userEvent.click(
      row("f:B").querySelector(
        "[data-status] [data-rerun-line]",
      ) as HTMLElement,
    );
    expect(acts.select).not.toHaveBeenCalled();
    expect(acts.edit).not.toHaveBeenCalled();
  });

  it("on a flow whose lead video has no footage does nothing, and its chevron still opens it", async () => {
    mount();
    await userEvent.click(nameText("f:E"));
    await userEvent.click(cell("f:E", "where"));
    expect(acts.edit).not.toHaveBeenCalled();
    await userEvent.click(cell("f:E", "open"));
    expect(row("f:E").getAttribute("aria-expanded")).toBe("true");
    expect(row("v:e1").hidden).toBe(false);
  });

  it("on a heading folds it and its rows, in place", async () => {
    mount();
    await userEvent.click(cell("f:A", "open"));
    await userEvent.click(nameText("h:today"));
    expect(row("h:today").getAttribute("aria-expanded")).toBe("false");
    for (const key of ["f:A", "v:a2", "f:B", "t:loose"]) {
      expect(row(key).hidden, key).toBe(true);
    }
    // Unfolding gives back the flow as it was: A open, B closed.
    await userEvent.click(nameText("h:today"));
    expect(row("v:a2").hidden).toBe(false);
    expect(row("v:b1").hidden).toBe(true);
    expect(acts.edit).not.toHaveBeenCalled();
  });

  it("on a jump link to a folded heading opens it", async () => {
    mount();
    const month = row("f:D").previousElementSibling as HTMLElement;
    const link = node(`[data-jumps] a[data-nav="${month.id}"]`);
    await userEvent.click(link);
    expect(month.getAttribute("aria-expanded")).toBe("true");
    expect(row("f:D").hidden).toBe(false);
  });
});

describe("selecting in the list", () => {
  const ticked = (id: string): Selection => ({
    ids: new Set([id]),
    anchor: id,
    range: [],
  });

  it("while anything is selected, a click on a flow selects instead, and the row's actions are hidden", async () => {
    mount(ticked("A"));
    await userEvent.click(nameText("f:B"));
    expect(acts.select).toHaveBeenCalledWith("B", "toggle", [
      "A",
      "B",
      "E",
      "C",
    ]);
    expect(acts.edit).not.toHaveBeenCalled();
    const buttons = [
      ...cell("f:B", "actions").querySelectorAll<HTMLElement>("button"),
    ];
    expect(buttons.length).toBeGreaterThan(0);
    for (const b of buttons) {
      expect(getComputedStyle(b).visibility, b.dataset.action).toBe("hidden");
    }
  });

  // Red: a video row opening the editor while flows are ticked (the
  // selection lost), or its Edit and Delete left showing beside the bar's.
  it("while anything is selected, a click on a video row does nothing, and its actions are hidden", async () => {
    mount(ticked("A"));
    await userEvent.click(cell("f:A", "open"));
    // Premise: A is open, its videos on screen.
    expect(row("v:a1").hidden).toBe(false);
    await userEvent.click(nameText("v:a1"));
    await userEvent.click(cell("v:a1", "recorded"));
    expect(acts.edit).not.toHaveBeenCalled();
    expect(acts.select).not.toHaveBeenCalled();
    await userEvent.hover(cell("v:a1", "where"));
    expect(row("v:a1").matches(":hover")).toBe(true);
    const buttons = [
      ...cell("v:a1", "actions").querySelectorAll<HTMLElement>("button"),
    ];
    expect(
      buttons.map((b) => b.dataset.action),
      "premise: the video row has its Edit and Delete",
    ).toEqual(expect.arrayContaining(["edit", "delete"]));
    for (const b of buttons) {
      expect(getComputedStyle(b).visibility, b.dataset.action).toBe("hidden");
    }
  });

  // Red: the selecting rule hiding them at rest too, or the row's hover
  // and focus no longer revealing them (list spec §2.1: on hover or
  // keyboard focus).
  it("with nothing selected the row's actions show on its hover and its focus", async () => {
    mount();
    const actions = cell("f:B", "actions").querySelector(
      ".row-actions",
    ) as HTMLElement;
    const del = actions.querySelector('[data-action="delete"]') as HTMLElement;
    const shows = () => [
      getComputedStyle(actions).opacity,
      getComputedStyle(del).visibility,
    ];
    // At rest they keep their cell, unseen.
    expect(shows()).toEqual(["0", "visible"]);
    await userEvent.hover(cell("f:B", "where"));
    expect(shows()).toEqual(["1", "visible"]);
    await userEvent.hover(cell("f:C", "where"));
    expect(shows()).toEqual(["0", "visible"]);
    // The keyboard on the row: Space and the keys need no pointer. From
    // A, ↓ is B.
    row("f:A").focus();
    await userEvent.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(row("f:B"));
    expect(shows()).toEqual(["1", "visible"]);
  });

  // Red: `:focus-within` revealing them, which a chevron's click (it
  // focuses the cell) holds on after the pointer has gone.
  it("a click's focus does not hold the row's actions and checkbox on screen; the keyboard's does", async () => {
    mount();
    const actions = cell("f:B", "actions").querySelector(
      ".row-actions",
    ) as HTMLElement;
    const box = row("f:B").querySelector("[data-select]") as HTMLElement;
    const shows = () => [
      getComputedStyle(actions).opacity,
      getComputedStyle(box).opacity,
    ];
    await userEvent.click(cell("f:B", "open"));
    // Premise: the click put focus in the row.
    expect(row("f:B").contains(document.activeElement)).toBe(true);
    await userEvent.hover(cell("f:C", "where"));
    expect(row("f:B").matches(":hover")).toBe(false);
    expect(shows()).toEqual(["0", "0"]);
    // Escape in a cell goes back to the row, by the keyboard.
    await userEvent.keyboard("{Escape}");
    expect(document.activeElement).toBe(row("f:B"));
    expect(shows()).toEqual(["1", "1"]);
  });

  it("while anything is selected, the row's actions stay hidden under the pointer", async () => {
    mount(ticked("A"));
    await userEvent.hover(cell("f:B", "where"));
    // Premise: the pointer is on the row.
    expect(row("f:B").matches(":hover")).toBe(true);
    const del = row("f:B").querySelector(
      '[data-action="delete"]',
    ) as HTMLElement;
    expect(getComputedStyle(del).visibility).toBe("hidden");
  });

  // Red: dropping the rows' `user-select: none` (cells), or list.ts's
  // clearing of the range a Shift-click makes (names, which stay
  // selectable for the drag above).
  it("Shift-click selects flows, not the text between them", async () => {
    mount(ticked("A"));
    for (const [from, to] of [
      [cell("f:A", "where"), cell("f:E", "where")],
      [nameText("f:A"), nameText("f:E")],
    ] as const) {
      await userEvent.click(from);
      await userEvent.click(to, { modifiers: ["Shift"] });
      expect(acts.select).toHaveBeenLastCalledWith("E", "range", [
        "A",
        "B",
        "E",
        "C",
      ]);
      expect(window.getSelection()?.toString(), from.dataset.col).toBe("");
    }
  });

  it("Cmd-click with nothing selected starts a selection", async () => {
    mount();
    await userEvent.click(nameText("f:B"), { modifiers: ["Meta"] });
    expect(acts.select).toHaveBeenCalledWith("B", "toggle", [
      "A",
      "B",
      "E",
      "C",
    ]);
    expect(acts.edit).not.toHaveBeenCalled();
  });

  it("Shift-click asks for a range in on-screen order, skipping a folded heading", async () => {
    mount(ticked("A"));
    await userEvent.click(nameText("h:yesterday"));
    // Premise: Yesterday's flow is off screen now.
    expect(row("f:C").hidden).toBe(true);
    await userEvent.click(nameText("f:E"), { modifiers: ["Shift"] });
    expect(acts.select).toHaveBeenCalledWith("E", "range", ["A", "B", "E"]);
    expect(acts.edit).not.toHaveBeenCalled();
  });
});

describe("a click while a name is being typed", () => {
  it("on the row's checkbox still selects", async () => {
    mount();
    // Stand-in for the rename field: a [data-name] input in the name cell,
    // focused, so the press that follows starts with it focused.
    const field = document.createElement("input");
    field.setAttribute("data-name", "");
    cell("f:A", "name").append(field);
    field.focus();
    expect(document.activeElement).toBe(field);
    await userEvent.click(node('[data-list] [data-select="A"]'));
    expect(acts.select).toHaveBeenCalledWith("A", "toggle", [
      "A",
      "B",
      "E",
      "C",
    ]);
  });
});

describe("a click on a card", () => {
  it("with Cmd and nothing selected starts a selection", async () => {
    mount(undefined, "grid");
    const card = node('article[data-video="B"]');
    // Premise: cards are drawn, and nothing is selected.
    expect(node("#root").hasAttribute("data-selecting")).toBe(false);
    await userEvent.click(card, { modifiers: ["Meta"] });
    expect(acts.select).toHaveBeenCalledWith("B", "toggle", [
      "A",
      "B",
      "E",
      "C",
    ]);
    expect(acts.edit).not.toHaveBeenCalled();
  });

  it("on a take in no flow still opens it with Cmd", async () => {
    mount(undefined, "grid");
    await userEvent.click(node('article[data-row="loose"]'), {
      modifiers: ["Meta"],
    });
    expect(acts.edit).toHaveBeenCalledWith("loose");
    expect(acts.select).not.toHaveBeenCalled();
  });
});

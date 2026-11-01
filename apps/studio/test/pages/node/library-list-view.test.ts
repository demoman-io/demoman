// apps/studio/test/pages/node/library-list-view.test.ts
//
// The library's list view, drawn: a treegrid (spec 2026-10-31
// library-list-view §1, §2, §4.1). Clicks, keys and redraws are other files.
import type { LibraryViewChoice, VideoSummary } from "@demoman/studio-protocol";
import { describe, expect, it, vi } from "vitest";
import {
  type ListSort,
  listEntries,
} from "../../../pages/src/library/list-model";
import type {
  LibraryModel,
  LibraryRow,
  VideoGroup,
} from "../../../pages/src/library/state";
import { renderLibrary } from "../../../pages/src/library/view";

const NOW = new Date(2026, 9, 30, 12);
const MB = 1024 ** 2;

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
  when: `${sceneId} date and time`,
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

const flow = (
  id: string,
  name: string,
  versions: LibraryRow[], // newest first
  repo: VideoSummary["repo"] = { unknown: true },
): VideoGroup => {
  const numbered = versions.map((v, i) => ({
    ...v,
    version: versions.length - i,
  }));
  return {
    video: {
      id,
      name,
      repo,
      startPage: "https://app.example.com/",
      versions: versions.length,
      current: null,
      pages: [],
      steps: [],
      exports: [],
    } as VideoSummary,
    current: numbered[0] ?? null,
    versions: numbered,
  };
};

// Task 1's fixture, with what this file samples added: Flow A's lead has
// its motion reclaimed and is hosted, its middle video has an MP4 and a
// gone GIF, its oldest expired. Flow B gains an unsized newest video.
const a3 = take("a3", new Date(2026, 9, 30, 9), {
  sizeBytes: MB,
  hosted: true,
  state: "Motion reclaimed",
  canRestore: true,
});
const a2 = take("a2", new Date(2026, 9, 30, 8), {
  sizeBytes: 2 * MB,
  exports: [
    { path: "/out/a2.mp4", fileType: "mp4", exists: true },
    { path: "/out/a2.gif", fileType: "gif", exists: false },
  ],
});
const a1 = take("a1", new Date(2026, 9, 30, 7), {
  sizeBytes: 4 * MB,
  expired: true,
});
const b2 = take("b2", new Date(2026, 9, 29, 10));
const b1 = take("b1", new Date(2026, 9, 29, 9), { sizeBytes: 3 * MB });
const c1 = take("c1", new Date(2026, 8, 1, 9));
const loose = take("loose", new Date(2026, 9, 30, 6), { sizeBytes: 9 * MB });
const groups = [
  flow("A", "Flow 10", [a3, a2, a1], { key: "github.com/acme/web" }),
  flow("B", "Flow 2", [b2, b1]),
  flow("C", "", [c1]),
];
const model: LibraryModel = {
  usedBytes: 0,
  budgetBytes: 0,
  fraction: 1,
  chromeNearLimit: false,
  migrating: false,
  migrationFailed: false,
  notice: null,
  rows: [a3, a2, a1, loose, b2, b1, c1].sort((x, y) =>
    y.createdAt.localeCompare(x.createdAt),
  ),
  groups,
};

const RECENT: ListSort = { column: "recorded", descending: true };
const LIST: LibraryViewChoice = { layout: "list", sort: RECENT };
const BY_NAME: LibraryViewChoice = {
  layout: "list",
  sort: { column: "name", descending: false },
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
  measure: vi.fn(),
  rerunLine: (_sceneId: string, _authored: boolean) =>
    "Run `run({ flow })` again to film it.",
});

const draw = (
  view: LibraryViewChoice | undefined = LIST,
  m: LibraryModel = model,
  acts: ReturnType<typeof actions> = actions(),
  rowStatus = new Map<string, string>(),
) => {
  const root = document.createElement("div");
  document.body.replaceChildren(root);
  renderLibrary(root, m, acts, rowStatus, NOW, undefined, undefined, view);
  const grid = root.querySelector<HTMLElement>("[data-list]");
  return { root, grid, acts };
};

const rowOf = (grid: HTMLElement | null, key: string): HTMLElement =>
  grid?.querySelector(`[role=row][data-key="${key}"]`) as HTMLElement;
const cell = (row: HTMLElement, col: string): HTMLElement =>
  row.querySelector(`[role=gridcell][data-col="${col}"]`) as HTMLElement;

describe("the fixture", () => {
  it("has what the cases below sample", () => {
    expect(a3.hosted).toBe(true);
    expect(a3.state).toBe("Motion reclaimed");
    expect(groups[0]?.current?.sceneId).toBe("a3");
    expect(a1.expired).toBe(true);
    expect(groups[1]?.versions.map((v) => v.sizeBytes)).toEqual([
      undefined,
      3 * MB,
    ]);
    expect(groups[2]?.versions).toHaveLength(1);
    expect(c1.sizeBytes).toBeUndefined();
  });
});

describe("the list view", () => {
  // Red: renderList drawing no row per entry, or the wrong level.
  it("List draws a treegrid with a head row and a row per entry", () => {
    const { grid } = draw();
    expect(grid?.getAttribute("role")).toBe("treegrid");
    expect(grid?.getAttribute("aria-multiselectable")).toBe("true");
    const entries = listEntries(model, RECENT, NOW);
    const rows = [
      ...(grid?.querySelectorAll<HTMLElement>("[role=row][data-key]") ?? []),
    ];
    expect(grid?.querySelectorAll("[role=row][data-list-head]")).toHaveLength(
      1,
    );
    expect(rows.map((r) => r.dataset.key)).toEqual(entries.map((e) => e.key));
    expect(rows.map((r) => r.getAttribute("aria-level"))).toEqual(
      entries.map((e) => String(e.level)),
    );
    expect(grid?.getAttribute("aria-rowcount")).toBe(
      String(entries.length + 1),
    );
    // Siblings under one parent: Today holds Flow A and the loose take.
    const today = rows.filter(
      (r) => r.dataset.key === "f:A" || r.dataset.key === "t:loose",
    );
    expect(today.map((r) => r.getAttribute("aria-posinset"))).toEqual([
      "1",
      "2",
    ]);
    expect(today.map((r) => r.getAttribute("aria-setsize"))).toEqual([
      "2",
      "2",
    ]);
  });

  it("every flow row has a chevron cell, including a one-video flow", () => {
    const { grid } = draw();
    for (const key of ["f:A", "f:B", "f:C"]) {
      const row = rowOf(grid, key);
      expect(cell(row, "open").querySelector("svg")).not.toBeNull();
      expect(row.getAttribute("aria-expanded")).toBe("false");
    }
    expect(groups[2]?.versions).toHaveLength(1);
  });

  it("a loose take has neither checkbox nor chevron", () => {
    const { grid } = draw();
    const row = rowOf(grid, "t:loose");
    expect(row.dataset.take).toBe("loose");
    expect(cell(row, "select").childElementCount).toBe(0);
    expect(cell(row, "open").childElementCount).toBe(0);
    expect(row.hasAttribute("aria-expanded")).toBe(false);
    expect(row.hasAttribute("aria-selected")).toBe(false);
    // While a flow has both.
    const a = rowOf(grid, "f:A");
    expect(cell(a, "select").querySelector("[data-select=A]")).not.toBeNull();
    expect(a.getAttribute("aria-selected")).toBe("false");
  });

  it("cells say what §2.1 says", () => {
    const { grid } = draw();
    const a = rowOf(grid, "f:A");
    expect(cell(a, "where").textContent).toBe(
      "acme/web · app.example.com/orders",
    );
    expect(cell(a, "videos").textContent).toBe("3");
    expect(cell(a, "size").textContent).toBe("7 MB");
    const b = rowOf(grid, "f:B");
    expect(cell(b, "size").textContent).toBe("3 MB+");
    expect(cell(b, "size").title).toBe("1 video could not be measured");
    expect(cell(rowOf(grid, "f:C"), "size").textContent).toBe("—");
    // Under a day heading the time alone; in a flat sort date and time.
    expect(cell(a, "recorded").textContent).toBe("a3 time");
    const flat = draw(BY_NAME).grid;
    expect(cell(rowOf(flat, "f:A"), "recorded").textContent).toBe(
      "a3 date and time",
    );
  });

  it("a video row's Where lists its exports, a gone one marked", () => {
    const { grid } = draw();
    const row = rowOf(grid, "v:a2");
    expect(row.dataset.videoRow).toBe("a2");
    expect(cell(row, "name").textContent).toBe("Video 2");
    const files = [...cell(row, "where").querySelectorAll("[data-export]")];
    expect(files.map((f) => f.textContent)).toEqual([
      "a2.mp4MP4",
      "a2.gifGIF · gone",
    ]);
    expect(files.map((f) => f.hasAttribute("data-gone"))).toEqual([
      false,
      true,
    ]);
    expect(
      cell(row, "actions").querySelector('[data-action="edit"]'),
    ).not.toBeNull();
  });

  // Red: drawing Edit on a row whose footage is gone, or a Where with no
  // reason (§2.4).
  it("a video with no footage says why and has no Edit", () => {
    const { grid } = draw();
    const row = rowOf(grid, "v:a1");
    const where = cell(row, "where");
    // The platform's line carries a code span, drawn as code, not ticks.
    expect(where.textContent).toBe(
      "Expired — run run({ flow }) again to film it.",
    );
    expect(where.querySelector("code")?.textContent).toBe("run({ flow })");
    expect(where.textContent).not.toContain("`");
    expect(where.title).toBe("Expired — run run({ flow }) again to film it.");
    const buttons = cell(row, "actions");
    expect(buttons.querySelector('[data-action="edit"]')).toBeNull();
    expect(buttons.querySelector('[data-action="delete"]')).not.toBeNull();
  });

  it("the name cell carries the state tag", () => {
    const { grid } = draw();
    const name = cell(rowOf(grid, "f:A"), "name");
    expect(name.querySelector("[data-state-chip]")?.textContent).toBe(
      "Motion reclaimed",
    );
    expect(name.textContent?.startsWith("Flow 10")).toBe(true);
  });

  it("no Hosted tag is drawn even when hosted is true", () => {
    expect(a3.hosted).toBe(true);
    const { grid } = draw();
    expect(grid?.querySelector("[data-hosted]")).toBeNull();
    // The card still draws it, so the gate is the list's own.
    expect(
      draw({ ...LIST, layout: "grid" }).root.querySelector("[data-hosted]"),
    ).not.toBeNull();
  });

  it("an untitled flow shows its label; the Actions cell has Rename", () => {
    const { grid } = draw();
    const c = rowOf(grid, "f:C");
    expect(cell(c, "name").textContent).toBe("c1");
    expect(c.getAttribute("aria-label")).toBe("c1");
    const rename = cell(rowOf(grid, "f:A"), "actions").querySelector(
      '[data-action="rename"]',
    );
    expect(rename?.getAttribute("aria-label")).toBe("Rename Flow 10");
    // Back, Restore, Rename, Edit, Delete: whichever the card shows.
    expect(
      [
        ...cell(rowOf(grid, "f:A"), "actions").querySelectorAll(
          "[data-action]",
        ),
      ].map((b) => b.getAttribute("data-action")),
    ).toEqual(["rename", "edit", "delete"]);
  });

  it("Length is a columnheader without a sort button", () => {
    const { grid } = draw();
    const length = grid?.querySelector(
      '[role=columnheader][data-col="length"]',
    );
    expect(length?.textContent).toBe("Length");
    expect(length?.querySelector("button")).toBeNull();
    // Its neighbours do sort, so the absence is Length's own.
    expect(
      grid?.querySelector('[role=columnheader] button[data-sort="size"]'),
    ).not.toBeNull();
  });

  it("the sorted column has aria-sort descending", () => {
    const { grid } = draw();
    const sorted = [
      ...(grid?.querySelectorAll("[role=columnheader][aria-sort]") ?? []),
    ];
    expect(sorted.map((h) => h.getAttribute("data-col"))).toEqual(["recorded"]);
    expect(sorted[0]?.getAttribute("aria-sort")).toBe("descending");
    const byName = draw(BY_NAME).grid;
    expect(
      byName
        ?.querySelector('[role=columnheader][data-col="name"]')
        ?.getAttribute("aria-sort"),
    ).toBe("ascending");
  });

  it("a row's status from rowStatus is a data-status line named by aria-describedby", () => {
    const status = new Map([["video:B", "Could not delete: it is open."]]);
    const { grid } = draw(LIST, model, actions(), status);
    const row = rowOf(grid, "f:B");
    const line = row.querySelector("[data-status]") as HTMLElement;
    expect(line.textContent).toBe("Could not delete: it is open.");
    expect(line.getAttribute("role")).toBeNull();
    expect(line.closest("[role=gridcell]")).toBeNull();
    expect(row.lastElementChild).toBe(line);
    expect(row.getAttribute("aria-describedby")).toBe(line.id);
    expect(grid?.ownerDocument.getElementById(line.id)).toBe(line);
    // A row with nothing said has neither.
    const c = rowOf(grid, "f:C");
    expect(c.querySelector("[data-status]")).toBeNull();
    expect(c.hasAttribute("aria-describedby")).toBe(false);
  });

  // Red: an open flow row keeping its lead's sentence beside the video row
  // that owns it (said twice), or a closed one leaving it to that video
  // row, which is hidden (Back pressed on the flow row said nothing the
  // author could see).
  it("a flow's lead take status is said once on screen: on the flow row while closed, on its video row while open", () => {
    expect(groups[2]?.versions).toHaveLength(1);
    const status = new Map([["take:c1", "Could not delete: it is open."]]);
    // By name: no headings, so C is not under its folded month.
    const { grid } = draw(BY_NAME, model, actions(), status);
    const flowRow = rowOf(grid, "f:C");
    const shown = () =>
      [
        ...(grid as HTMLElement).querySelectorAll<HTMLElement>(
          "[data-status] > .notice",
        ),
      ].filter((p) => p.closest("[hidden]") === null);
    // Premise: C is on screen and starts closed, its video row hidden.
    expect(flowRow.hidden).toBe(false);
    expect(flowRow.getAttribute("aria-expanded")).toBe("false");
    expect(rowOf(grid, "v:c1").hidden).toBe(true);
    expect(shown()).toHaveLength(1);
    expect(shown()[0]?.closest("[role=row]")).toBe(flowRow);
    expect(shown()[0]?.textContent).toBe("Could not delete: it is open.");
    expect(flowRow.getAttribute("aria-describedby")).toBe(
      flowRow.querySelector("[data-status]")?.id,
    );
    cell(flowRow, "open").click();
    expect(flowRow.getAttribute("aria-expanded")).toBe("true");
    expect(shown()).toHaveLength(1);
    expect(shown()[0]?.closest("[role=row]")).toBe(rowOf(grid, "v:c1"));
    // Nothing else is said of the flow, so it has no description now.
    expect(flowRow.hasAttribute("aria-describedby")).toBe(false);
    cell(flowRow, "open").click();
    expect(shown()[0]?.closest("[role=row]")).toBe(flowRow);
  });

  it("the rerun line where Restore has no button is the row's line too", () => {
    expect(a3.canRestore).toBe(true);
    const { grid } = draw();
    const row = rowOf(grid, "f:A");
    expect(
      cell(row, "actions").querySelector('[data-action="restore"]'),
    ).toBeNull();
    const line = row.querySelector("[data-status] [data-rerun-line]");
    expect(line?.textContent).toBe("Run run({ flow }) again to film it.");
    expect(row.getAttribute("aria-describedby")).toBe(
      line?.closest("[data-status]")?.id,
    );
  });

  it("headings appear only under Recorded descending", () => {
    const { root, grid } = draw();
    const headings = [
      ...(grid?.querySelectorAll<HTMLElement>("[role=row][data-heading]") ??
        []),
    ];
    expect(headings.map((h) => h.dataset.key)).toEqual([
      "h:today",
      "h:yesterday",
      "h:month:2026-09",
    ]);
    // The past month starts folded and hides what is under it.
    const month = rowOf(grid, "h:month:2026-09");
    expect(month.getAttribute("aria-expanded")).toBe("false");
    expect(rowOf(grid, "f:C").hidden).toBe(true);
    expect(rowOf(grid, "f:A").hidden).toBe(false);
    // A closed flow hides its videos.
    expect(rowOf(grid, "v:a3").hidden).toBe(true);
    expect(
      root.querySelector("[data-jumps]")?.querySelectorAll("[data-nav]"),
    ).toHaveLength(3);
    for (const sort of [
      BY_NAME,
      { layout: "list", sort: { column: "recorded", descending: false } },
    ] as LibraryViewChoice[]) {
      expect(draw(sort).grid?.querySelector("[data-heading]")).toBeNull();
    }
  });

  // Red: dropping `was.drawn` (an opened month folds back on every redraw)
  // or `was.collapsed` (a closed Today springs open).
  it("a redraw keeps each fold as the author left it", () => {
    const { root, grid } = draw();
    // As a click will (Task 5): open the past month, close Today.
    rowOf(grid, "h:month:2026-09").setAttribute("aria-expanded", "true");
    rowOf(grid, "h:today").setAttribute("aria-expanded", "false");
    renderLibrary(
      root,
      model,
      actions(),
      new Map(),
      NOW,
      undefined,
      undefined,
      LIST,
    );
    const again = root.querySelector<HTMLElement>("[data-list]");
    expect(again).not.toBe(grid);
    expect(rowOf(again, "h:month:2026-09").getAttribute("aria-expanded")).toBe(
      "true",
    );
    expect(rowOf(again, "f:C").hidden).toBe(false);
    expect(rowOf(again, "h:today").getAttribute("aria-expanded")).toBe("false");
    expect(rowOf(again, "f:A").hidden).toBe(true);
    // Flows it drew closed stay closed.
    expect(rowOf(again, "f:C").getAttribute("aria-expanded")).toBe("false");
  });

  it("a flat sort hides the jump list", () => {
    const { root } = draw(BY_NAME);
    expect(root.querySelector("[data-jumps]")?.childElementCount).toBe(0);
  });

  it("an empty library draws the empty card, not a treegrid", () => {
    const { root, grid } = draw(LIST, { ...model, rows: [], groups: [] });
    expect(grid).toBeNull();
    expect(root.querySelector("[data-empty]")).not.toBeNull();
  });

  it("only unreadable folders draws the Couldn't read section and no treegrid", () => {
    const { root, grid } = draw(LIST, {
      ...model,
      rows: [],
      groups: [],
      unreadable: [{ folder: "broken", reason: "Not JSON" }],
    });
    expect(grid).toBeNull();
    expect(root.querySelector("[data-empty]")).toBeNull();
    expect(root.querySelector('[data-unreadable-row="broken"]')).not.toBeNull();
  });

  it("the Couldn't read section follows the list", () => {
    const { grid } = draw(LIST, {
      ...model,
      unreadable: [{ folder: "broken", reason: "Not JSON" }],
    });
    expect(grid?.nextElementSibling?.hasAttribute("data-unreadable")).toBe(
      true,
    );
  });

  // Red if the list draws the card section (spec §2.3: "in the list's row
  // style, each row with its Delete").
  it("List draws the Couldn't read folders as rows in the list's style, not cards", () => {
    const reason = "scene.json is not a video (Unexpected end of JSON input)";
    const { root, grid, acts } = draw(
      LIST,
      {
        ...model,
        unreadable: [
          { folder: "broken", reason, sizeBytes: 2048 },
          { folder: "unmeasured", reason: "Not JSON" },
        ],
      },
      actions(),
      new Map([["folder:broken", "Not deleted: a render is running."]]),
    );
    const section = root.querySelector<HTMLElement>("[data-unreadable]");
    expect(section?.id).toBe("unreadable");
    expect(section?.textContent).toContain("Couldn't read");
    expect(section?.querySelector(".card")).toBeNull();
    expect(section?.querySelector("article")).toBeNull();
    // Outside the treegrid's keys: not inside it, and no row role.
    expect(grid?.contains(section as Node)).toBe(false);
    expect(section?.querySelector("[role]")).toBeNull();
    const row = section?.querySelector<HTMLElement>(
      '.unreadable-row[data-unreadable-row="broken"]',
    );
    expect(row?.querySelector('[data-col="name"]')?.textContent).toBe("broken");
    const why = row?.querySelector<HTMLElement>('[data-col="where"]');
    expect(why?.textContent).toBe(reason);
    expect(why?.title).toBe(reason);
    expect(row?.querySelector('[data-col="size"]')?.textContent).toBe("2 KB");
    expect(
      section?.querySelector(
        '[data-unreadable-row="unmeasured"] [data-col="size"]',
      )?.textContent,
    ).toBe("—");
    expect(row?.querySelector("[data-status]")?.textContent).toBe(
      "Not deleted: a render is running.",
    );
    // A Tab stop, and the card's own action.
    const remove = row?.querySelector<HTMLButtonElement>(
      '[data-action="delete"]',
    );
    expect(remove?.tabIndex).toBe(0);
    remove?.click();
    expect(acts.remove).toHaveBeenCalledWith("broken", "folder");
  });

  it("Grid keeps the Couldn't read cards", () => {
    const { root } = draw(
      { ...LIST, layout: "grid" },
      { ...model, unreadable: [{ folder: "broken", reason: "Not JSON" }] },
    );
    expect(
      root.querySelector('article.card[data-unreadable-row="broken"]'),
    ).not.toBeNull();
    expect(root.querySelector(".unreadable-row")).toBeNull();
  });

  it("without view, renderLibrary still draws cards", () => {
    const root = document.createElement("div");
    renderLibrary(root, model, actions(), new Map(), NOW);
    expect(root.querySelector("[data-list]")).toBeNull();
    expect(root.querySelectorAll("article[data-row]").length).toBe(4);
    expect(
      root.querySelector<HTMLElement>("[data-layout-toggle]")?.hidden,
    ).toBe(true);
  });

  it("the toggle marks List pressed and calls setView with layout grid and the same sort", () => {
    const { root, acts } = draw(BY_NAME);
    const list = root.querySelector(
      'button[data-layout="list"]',
    ) as HTMLButtonElement;
    const grid = root.querySelector(
      'button[data-layout="grid"]',
    ) as HTMLButtonElement;
    expect(list.getAttribute("aria-pressed")).toBe("true");
    expect(grid.getAttribute("aria-pressed")).toBe("false");
    expect(grid.getAttribute("aria-label")).toBe("Grid");
    grid.click();
    expect(acts.setView).toHaveBeenCalledWith({
      layout: "grid",
      sort: { column: "name", descending: false },
    });
    // Grid pressed once the page draws cards.
    const cards = draw({ ...BY_NAME, layout: "grid" }).root;
    expect(
      cards
        .querySelector('button[data-layout="grid"]')
        ?.getAttribute("aria-pressed"),
    ).toBe("true");
  });

  it("no setView: no toggle and no sort buttons", () => {
    const { setView: _, ...rest } = actions();
    const root = document.createElement("div");
    renderLibrary(
      root,
      model,
      rest,
      new Map(),
      NOW,
      undefined,
      undefined,
      LIST,
    );
    expect(root.querySelector("[data-list]")).not.toBeNull();
    expect(root.querySelector("[data-sort]")).toBeNull();
    expect(
      root.querySelector<HTMLElement>("[data-layout-toggle]")?.hidden,
    ).toBe(true);
  });

  it("a click on a sort button calls setView with nextSort", () => {
    const sortBy = (view: LibraryViewChoice, column: string) => {
      const { grid, acts } = draw(view);
      (
        (grid as HTMLElement).querySelector(
          `button[data-sort="${column}"]`,
        ) as HTMLElement
      ).click();
      return acts.setView.mock.calls[0]?.[0];
    };
    expect(sortBy(LIST, "size")).toEqual({
      layout: "list",
      sort: { column: "size", descending: true },
    });
    const bySize: LibraryViewChoice = {
      layout: "list",
      sort: { column: "size", descending: true },
    };
    expect(sortBy(bySize, "size")).toEqual({
      layout: "list",
      sort: { column: "size", descending: false },
    });
    expect(sortBy(LIST, "name")).toEqual({
      layout: "list",
      sort: { column: "name", descending: false },
    });
  });

  it("asks measure to fill each row's Length cell", () => {
    const { grid, acts } = draw();
    const lead = cell(rowOf(grid, "f:A"), "length");
    expect(acts.measure).toHaveBeenCalledWith("a3", lead);
    expect(acts.measure).toHaveBeenCalledWith(
      "a2",
      cell(rowOf(grid, "v:a2"), "length"),
    );
    // A list draws no thumbnails.
    expect(acts.preview).not.toHaveBeenCalled();
  });

  it("selection shows on the list row", () => {
    const root = document.createElement("div");
    document.body.replaceChildren(root);
    const sel = { ids: new Set(["B"]), anchor: "B", range: [] };
    renderLibrary(root, model, actions(), new Map(), NOW, sel, undefined, LIST);
    const grid = root.querySelector<HTMLElement>("[data-list]");
    expect(rowOf(grid, "f:B").getAttribute("aria-selected")).toBe("true");
    expect(rowOf(grid, "f:A").getAttribute("aria-selected")).toBe("false");
    expect(
      (cell(rowOf(grid, "f:B"), "select").firstElementChild as HTMLInputElement)
        .checked,
    ).toBe(true);
  });
});

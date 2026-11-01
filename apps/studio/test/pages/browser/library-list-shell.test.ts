import type { VideoSummary } from "@demoman/studio-protocol";
import { cdp, page, userEvent } from "@vitest/browser/context";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
// The page's own markup and rules, the studio's sheet the build links
// beside them, and the real view: the rows measured are the rows the
// studio paints.
import studioCss from "../../../pages/assets/studio.css?raw";
import shell from "../../../pages/entrypoints/library/index.html?raw";
import type {
  LibraryModel,
  LibraryRow,
  VideoGroup,
} from "../../../pages/src/library/state";
import { renderLibrary, statusKey } from "../../../pages/src/library/view";
import { mountShell, node, pageParts, parse } from "../helpers/shell-css";

/**
 * The list's look, motion and narrow widths (spec 2026-10-31
 * library-list-view §2.1, §4.7), read from the painted page: the shipped
 * shell, the page's rules and studio.css, as the studio build serves them.
 * Geometry is the rects, and where a rect could lie about what shows (a
 * sticky head, a hover's edge) the pixels or the hit test say it.
 */

const { css, body } = pageParts(shell, ".library-list .select-box");

const NOW = new Date(2026, 9, 30, 20);

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
  when: "Oct 30, 9:00 AM",
  time: "9:00 AM",
  hosted: false,
  recoverable: false,
  frameBytes: 0,
  outputBytes: 0,
  sizeBytes: 12 * 1024 ** 2,
  state: "Complete",
  canRestore: false,
  authored: true,
  servesReshoot: false,
  needsLook: false,
  ...extra,
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

const LONG = "Checkout ".repeat(23).slice(0, 200);
const today = (h: number, m = 0) => new Date(2026, 9, 30, h, m);

// Today, newest first: A (two videos, with exports, one gone), the long
// name, R (motion reclaimed, so a tag, and the rerun line where Restore
// would be), S (a refused delete said on its row), a take in no flow, then
// enough one-video flows that the list runs well past a 900px window.
const a2 = take("a2", today(19), {
  exports: [
    { path: "/out/a2.mp4", fileType: "mp4", exists: true },
    { path: "/out/a2.gif", fileType: "gif", exists: false },
  ],
});
const a1 = take("a1", today(18, 30));
const long = take("long", today(18));
const r1 = take("r1", today(17), {
  state: "Motion reclaimed",
  canRestore: true,
});
const s1 = take("s1", today(16));
const loose = take("loose", today(15));
const filler = Array.from({ length: 30 }, (_, i) =>
  take(`n${i}`, today(14, 59 - i)),
);
const MODEL: LibraryModel = {
  usedBytes: 0,
  budgetBytes: 0,
  fraction: 1,
  chromeNearLimit: false,
  migrating: false,
  migrationFailed: false,
  notice: null,
  rows: [a2, a1, long, r1, s1, loose, ...filler],
  groups: [
    flow("A", "Create an invoice", [a2, a1]),
    flow("L", LONG, [long]),
    flow("R", "Reclaimed", [r1]),
    flow("S", "Refused", [s1]),
    ...filler.map((t, i) => flow(`N${i}`, `Flow ${i}`, [t])),
  ],
};

const noop = () => {};
const ACTIONS = {
  edit: noop,
  restore: noop,
  backToRecording: noop,
  remove: noop,
  preview: noop,
  rename: noop,
  renameVideo: noop,
  select: noop,
  setView: noop,
  rerunLine: () => "Run it again to film it.",
  // The page's measurer writes a length into the cell it is handed.
  measure: (_scene: string, c: HTMLElement) => {
    c.textContent = "0:09";
  },
};

const REFUSED = "Couldn't delete: it is open.";

/** The page as the studio serves it: dark, `data-studio`, studio.css. With
 *  `motion`, the transitions the lane's helper switches off are left on,
 *  for the cases that read them. */
function mount(motion = false, ticked: readonly string[] = []) {
  mountShell("dark", `${css}\n${studioCss}`);
  const sheet = document.head.querySelector("[data-shell]") as HTMLElement;
  if (motion) {
    const off = "* { transition: none !important; }";
    expect(sheet.textContent).toContain(off);
    sheet.textContent = (sheet.textContent ?? "").replace(off, "");
  }
  document.documentElement.setAttribute("data-studio", "");
  document.body.innerHTML = body;
  draw(ticked);
}

/** The page's render, as main.ts calls it on every change: first draw or
 *  redraw. */
function draw(ticked: readonly string[] = []) {
  renderLibrary(
    node("#root"),
    MODEL,
    ACTIONS,
    new Map([[statusKey("video", "S"), REFUSED]]),
    NOW,
    { ids: new Set(ticked), anchor: ticked[0] ?? null, range: [] },
    undefined,
    { layout: "list", sort: { column: "recorded", descending: true } },
  );
}

const grid = (): HTMLElement => node("[data-list]");
const head = (): HTMLElement => node("[data-list] [data-list-head]");
const row = (key: string): HTMLElement =>
  node(`[data-list] [role=row][data-key="${key}"]`);
const cell = (key: string, col: string): HTMLElement =>
  row(key).querySelector(`[data-col="${col}"]`) as HTMLElement;
const shown = (): HTMLElement[] => [
  ...grid().querySelectorAll<HTMLElement>("[role=row][data-key]:not([hidden])"),
];
const rendered = (e: Element): boolean => e.checkVisibility();
const rectOf = (e: Element) => {
  const { left, top, width, height } = e.getBoundingClientRect();
  return { left, top, width, height };
};
/** Every column's cells' lefts, head row included, of the rows shown; a
 *  date heading is a label across the row, not cells in the columns. */
const lefts = (col: string): number[] =>
  [head(), ...shown().filter((r) => r.dataset.heading === undefined)].map(
    (r) =>
      (
        r.querySelector(`[data-col="${col}"]`) as HTMLElement
      ).getBoundingClientRect().left,
  );
/** The actions float over each row's end, so what lines up is their
 *  right edge: every row's, head and headings included. */
const actionRights = (): number[] =>
  [head(), ...shown()].map(
    (r) =>
      (
        r.querySelector('[data-col="actions"]') as HTMLElement
      ).getBoundingClientRect().right,
  );
/** What paints at a point: the hit test, which follows paint order. */
const at = (x: number, y: number): Element | null =>
  document.elementFromPoint(x, y);

/** The page's pixels, as Chrome painted them; `at(x, y)` in CSS px. */
async function pixels(): Promise<(x: number, y: number) => number[]> {
  // Unsaved, the provider answers with the base64 string itself rather
  // than the `{ path, base64 }` its typing describes (export-panel-shots).
  const shot: unknown = await page.screenshot({ base64: true, save: false });
  const base64 =
    typeof shot === "string" ? shot : (shot as { base64: string }).base64;
  const image = new Image();
  image.src = base64.startsWith("data:")
    ? base64
    : `data:image/png;base64,${base64}`;
  await image.decode();
  const canvas = document.createElement("canvas");
  canvas.width = image.width;
  canvas.height = image.height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("no 2d context");
  context.drawImage(image, 0, 0);
  const scale = image.width / window.innerWidth;
  // A scaled shot blends a 2px edge into its neighbours: the cases that
  // read pixels size the page to the runner's frame.
  expect(scale, "the tester frame is scaled").toBe(1);
  return (x, y) => [
    ...context.getImageData(Math.floor(x * scale), Math.floor(y * scale), 1, 1)
      .data,
  ];
}
const close = (a: number[], b: readonly number[], by = 6): boolean =>
  [0, 1, 2].every((i) => Math.abs((a[i] ?? 0) - (b[i] ?? 0)) <= by);

beforeEach(async () => {
  await page.viewport(1440, 900);
  window.scrollTo(0, 0);
});

afterEach(async () => {
  await cdp().send("Emulation.setEmulatedMedia", { features: [] });
});

describe("the fixture", () => {
  it("has what the cases below sample", () => {
    mount();
    // A's videos are drawn, closed: what the hidden case and the fade read.
    expect(row("f:A").getAttribute("aria-expanded")).toBe("false");
    expect(row("v:a2").hidden).toBe(true);
    // The long name is 200 characters, and R has a tag and the rerun line.
    expect(cell("f:L", "name").textContent).toHaveLength(200);
    expect(row("f:R").querySelector(".row-tags .tag")).not.toBeNull();
    expect(row("f:R").querySelector("[data-rerun-line]")).not.toBeNull();
    expect(row("f:S").querySelector("[data-status]")?.textContent).toBe(
      REFUSED,
    );
    // The list runs past the window, so it scrolls.
    expect(document.documentElement.scrollHeight).toBeGreaterThan(
      window.innerHeight * 1.5,
    );
    // Every column is drawn at full width.
    for (const col of ["size", "length", "videos", "where"]) {
      expect(rendered(cell("f:A", col)), col).toBe(true);
    }
  });
});

describe("the list's look", () => {
  it("rows are 34px, a heading 14px more, and every column lines up across rows", async () => {
    mount();
    await userEvent.click(cell("f:A", "open"));
    // Premise: a heading, flows, video rows and the take in no flow.
    const kinds = shown().map((r) => r.dataset.key?.slice(0, 2));
    expect(new Set(kinds)).toEqual(new Set(["h:", "f:", "v:", "t:"]));
    for (const r of shown()) {
      if (r.querySelector("[data-status]") !== null) continue;
      expect(r.getBoundingClientRect().height, r.dataset.key).toBeCloseTo(
        r.dataset.heading === undefined ? 34 : 48,
        1,
      );
    }
    for (const col of [
      "select",
      "open",
      "name",
      "where",
      "videos",
      "length",
      "size",
      "recorded",
    ]) {
      const xs = lefts(col);
      expect(new Set(xs).size, `${col}: ${xs.join(", ")}`).toBe(1);
    }
    const ends = actionRights();
    expect(new Set(ends).size, `actions: ${ends.join(", ")}`).toBe(1);
    // And the columns are laid side by side, not stacked.
    const name = cell("f:A", "name").getBoundingClientRect();
    const where = cell("f:A", "where").getBoundingClientRect();
    expect(where.left).toBeGreaterThanOrEqual(name.right);
    expect(where.top).toBe(name.top);
  });

  it("hover shows the actions without moving any cell", async () => {
    mount();
    const cells = [...row("f:N3").children];
    const actions = cell("f:N3", "actions").querySelector(
      ".row-actions",
    ) as HTMLElement;
    const before = cells.map(rectOf);
    expect(getComputedStyle(actions).opacity).toBe("0");
    await userEvent.hover(cell("f:N3", "where"));
    expect(getComputedStyle(actions).opacity).toBe("1");
    expect(getComputedStyle(actions).visibility).toBe("visible");
    expect(cells.map(rectOf)).toEqual(before);
    // And the hovered row's actions paint: Delete is what the hit test
    // finds at its own centre.
    const del = actions.querySelector('[data-action="delete"]') as HTMLElement;
    const d = del.getBoundingClientRect();
    expect(
      at(d.left + d.width / 2, d.top + d.height / 2)?.closest("button"),
    ).toBe(del);
  });

  it("a 200-character name truncates and does not move the Where column", () => {
    mount();
    const text = cell("f:L", "name").querySelector(
      "[data-name-text]",
    ) as HTMLElement;
    // Truncated: clipped to its cell, with more text than room.
    expect(text.scrollWidth).toBeGreaterThan(text.clientWidth);
    expect(getComputedStyle(text).textOverflow).toBe("ellipsis");
    expect(text.getBoundingClientRect().right).toBeLessThanOrEqual(
      cell("f:L", "name").getBoundingClientRect().right + 0.5,
    );
    expect(text.title).toBe(LONG);
    expect(cell("f:L", "where").getBoundingClientRect().left).toBe(
      cell("f:N0", "where").getBoundingClientRect().left,
    );
  });

  it("a tag sits in its row's name cell, after the name", () => {
    mount();
    const tag = row("f:R").querySelector(".row-tags") as HTMLElement;
    const name = cell("f:R", "name").getBoundingClientRect();
    const t = tag.getBoundingClientRect();
    expect(t.left).toBeGreaterThanOrEqual(name.left);
    expect(t.right).toBeLessThanOrEqual(name.right + 0.5);
    expect(t.top).toBeGreaterThanOrEqual(name.top);
    expect(t.bottom).toBeLessThanOrEqual(name.bottom + 0.5);
    expect(
      at(t.left + t.width / 2, t.top + t.height / 2)?.closest(".row-tags"),
    ).toBe(tag);
  });

  it("a video's exports are labels on its row's line, a gone one struck", async () => {
    mount();
    await userEvent.click(cell("f:A", "open"));
    const labels = [
      ...cell("v:a2", "where").querySelectorAll<HTMLElement>(".export-type"),
    ];
    expect(labels.map((l) => l.textContent)).toEqual(["MP4", "GIF · gone"]);
    const name = cell("v:a2", "name")
      .querySelector("[data-name-text]")
      ?.getBoundingClientRect() as DOMRect;
    for (const l of labels) {
      const b = l.getBoundingClientRect();
      expect(
        Math.abs(b.top + b.height / 2 - (name.top + name.height / 2)),
        l.textContent ?? "",
      ).toBeLessThan(2);
    }
    expect(getComputedStyle(labels[1] as Element).textDecorationLine).toBe(
      "line-through",
    );
  });

  it("the toggle marks the layout shown", () => {
    mount();
    const list = node("[data-layout-toggle] [data-layout='list']");
    const grid = node("[data-layout-toggle] [data-layout='grid']");
    expect(list.getAttribute("aria-pressed")).toBe("true");
    expect(getComputedStyle(list).backgroundColor).not.toBe(
      getComputedStyle(grid).backgroundColor,
    );
  });

  it("numbers use tabular figures and sit right", () => {
    mount();
    for (const col of ["videos", "length", "recorded", "size"]) {
      expect(getComputedStyle(cell("f:A", col)).fontVariantNumeric, col).toBe(
        "tabular-nums",
      );
    }
    for (const col of ["videos", "size"]) {
      const c = cell("f:A", col);
      const range = document.createRange();
      range.selectNodeContents(c);
      // Premise: the cell holds a number with room to spare.
      expect(range.getBoundingClientRect().width, col).toBeGreaterThan(0);
      expect(
        Math.abs(
          range.getBoundingClientRect().right - c.getBoundingClientRect().right,
        ),
        col,
      ).toBeLessThan(1);
    }
  });

  it("a hidden row paints nothing", () => {
    mount();
    const v = row("v:a2");
    expect(v.hidden).toBe(true);
    expect(v.getBoundingClientRect().height).toBe(0);
    expect(rendered(v)).toBe(false);
    // The rows either side of it touch.
    expect(row("f:L").getBoundingClientRect().top).toBeCloseTo(
      row("f:A").getBoundingClientRect().bottom,
      1,
    );
  });

  it("a refused delete paints as an error, the rerun line as the card's quieter line", () => {
    mount();
    const error = row("f:S").querySelector("[data-status] p") as HTMLElement;
    const rerun = row("f:R").querySelector(
      "[data-status] [data-rerun-line]",
    ) as HTMLElement;
    expect(error.classList.contains("notice-error")).toBe(true);
    expect(rerun.classList.contains("row-rerun")).toBe(true);
    expect(rerun.closest(".notice-error")).toBeNull();
    const e = getComputedStyle(error);
    const r = getComputedStyle(rerun);
    expect(parse(e.backgroundColor)[3]).toBeGreaterThan(0);
    expect(parse(r.backgroundColor)[3]).toBe(0);
    // The studio draws a notice as a panel: its ring, which the line lacks.
    expect(e.boxShadow).not.toBe("none");
    expect(r.boxShadow).toBe("none");
    // Each sits under its row's cells, from the name column on.
    const s = row("f:S").querySelector("[data-status]") as HTMLElement;
    expect(s.getBoundingClientRect().top).toBeGreaterThanOrEqual(
      cell("f:S", "name").getBoundingClientRect().bottom,
    );
    expect(s.getBoundingClientRect().left).toBe(
      cell("f:S", "name").getBoundingClientRect().left,
    );
  });

  it("the head row stays at the top while the list scrolls", () => {
    mount();
    const bar = node(".topbar");
    // At rest, under the top bar.
    expect(head().getBoundingClientRect().top).toBeGreaterThanOrEqual(
      bar.getBoundingClientRect().bottom,
    );
    window.scrollTo(0, grid().getBoundingClientRect().top + 400);
    const h = head().getBoundingClientRect();
    // Premise: rows have gone up past where the head sits.
    expect(row("f:N0").getBoundingClientRect().top).toBeLessThan(0);
    expect(h.top).toBeCloseTo(
      Math.max(0, bar.getBoundingClientRect().bottom),
      1,
    );
    // What paints at the head's place is the head, not a row under it.
    for (const y of [h.top + 1, h.top + h.height / 2, h.bottom - 1]) {
      expect(at(h.left + 200, y)?.closest("[role=row]"), String(y)).toBe(
        head(),
      );
    }
    // And it is opaque, on the page's own ground: the hit test finds the
    // head whatever its background, so a see-through head that shows the
    // rows under it would pass the lines above (Red: no `background`).
    const ground = getComputedStyle(document.body).backgroundColor;
    expect(parse(ground)[3], ground).toBe(1);
    expect(getComputedStyle(head()).backgroundColor).toBe(ground);
  });

  it("while flows are ticked the head sticks under the selection bar, and the keyboard's row clears both", async () => {
    mount(false, ["N0"]);
    const bar = node("[data-selection-bar]");
    const target = row("f:N4");
    // N4 put 14px under the bar's bottom, so once both stick it is half
    // under the head.
    window.scrollTo(
      0,
      window.scrollY +
        target.getBoundingClientRect().top -
        (bar.getBoundingClientRect().height + 12 + 14),
    );
    const b = bar.getBoundingClientRect();
    const h = head().getBoundingClientRect();
    // Premise: the bar is stuck at its 12px, and the list ran under it.
    expect(b.top).toBeCloseTo(12, 1);
    expect(row("f:N0").getBoundingClientRect().top).toBeLessThan(0);
    // The head sits beneath the bar, and is what paints at its middle.
    expect(h.top).toBeCloseTo(b.bottom, 1);
    expect(at(h.left + 200, h.top + h.height / 2)?.closest("[role=row]")).toBe(
      head(),
    );
    // Premise: N4 is on screen but under the head.
    expect(target.getBoundingClientRect().top).toBeGreaterThan(h.top);
    expect(target.getBoundingClientRect().top).toBeLessThan(h.bottom);
    const next = shown()[shown().indexOf(target) + 1] as HTMLElement;
    next.focus({ preventScroll: true });
    await userEvent.keyboard("{ArrowUp}");
    expect(document.activeElement).toBe(target);
    expect(target.getBoundingClientRect().top).toBeGreaterThanOrEqual(
      head().getBoundingClientRect().bottom - 0.5,
    );
  });

  it("the selection bar's height follows the bar as it wraps, and goes with it", async () => {
    mount(false, ["N0"]);
    const root = node("#root");
    const bar = node("[data-selection-bar]");
    const said = () => root.style.getPropertyValue("--selection-bar");
    expect(said()).toBe(`${bar.getBoundingClientRect().height}px`);
    // A narrower window wraps the bar's line under its buttons.
    const before = bar.getBoundingClientRect().height;
    bar.style.width = "200px";
    await expect
      .poll(() => bar.getBoundingClientRect().height)
      .toBeGreaterThan(before);
    await expect.poll(said).toBe(`${bar.getBoundingClientRect().height}px`);
    // Nothing ticked: no bar, and no height left behind.
    draw();
    expect(document.querySelector("[data-selection-bar]")).toBeNull();
    expect(said()).toBe("");
  });

  it("the keyboard's row moves clear of the head", async () => {
    mount();
    // N4 put 14px from the window's top, so once the head sticks there
    // the row is half under it.
    const target = row("f:N4");
    window.scrollTo(
      0,
      window.scrollY + target.getBoundingClientRect().top - 14,
    );
    const h = head().getBoundingClientRect();
    // Premise: the head is stuck, and the row is under it but on screen.
    expect(h.top).toBeCloseTo(0, 1);
    expect(target.getBoundingClientRect().top).toBeGreaterThan(0);
    expect(target.getBoundingClientRect().top).toBeLessThan(h.bottom - 10);
    // The row below it on screen (its own video row is closed).
    const next = shown()[shown().indexOf(target) + 1] as HTMLElement;
    expect(next.dataset.key).toBe("f:N5");
    next.focus({ preventScroll: true });
    await userEvent.keyboard("{ArrowUp}");
    expect(document.activeElement).toBe(target);
    expect(target.getBoundingClientRect().top).toBeGreaterThanOrEqual(
      head().getBoundingClientRect().bottom - 0.5,
    );
  });

  it("the keyboard's row shows its inset edge and differs from a hovered row", async () => {
    await page.viewport(960, 640);
    mount();
    const before = document.createElement("button");
    before.textContent = "before";
    grid().before(before);
    before.focus();
    await userEvent.keyboard("{Tab}{ArrowDown}");
    const focused = row("f:A");
    expect(document.activeElement).toBe(focused);
    expect(focused.matches(":focus-visible")).toBe(true);
    await userEvent.hover(cell("f:N1", "where"));
    const hovered = row("f:N1");
    const rest = row("f:N5");
    const f = getComputedStyle(focused);
    const h = getComputedStyle(hovered);
    // One background for both, and not the resting one.
    expect(f.backgroundColor).toBe(h.backgroundColor);
    expect(h.backgroundColor).not.toBe(getComputedStyle(rest).backgroundColor);
    const paint = await pixels();
    const edge = (r: HTMLElement) => {
      const b = r.getBoundingClientRect();
      return paint(b.left + 0.5, b.top + b.height / 2);
    };
    const inside = (r: HTMLElement) => {
      const b = r.getBoundingClientRect();
      return paint(b.left + 4, b.top + 3);
    };
    // The focus ink, resolved by the page: a probe coloured with it.
    const probe = document.createElement("i");
    probe.style.color = "var(--focus)";
    document.body.append(probe);
    const ink = parse(getComputedStyle(probe).color);
    probe.remove();
    // The keyboard's row: a 2px edge in the focus ink, inside the row.
    expect(close(edge(focused), ink, 24), `${edge(focused)}`).toBe(true);
    // The hovered row has no edge: its left is its background, as inside.
    expect(close(edge(hovered), inside(hovered)), `${edge(hovered)}`).toBe(
      true,
    );
    // And the hover paints: its ground is not the resting row's.
    expect(close(inside(hovered), inside(rest), 2)).toBe(false);
  });

  it("at 720px wide Size is gone and nothing scrolls sideways", async () => {
    await page.viewport(720, 900);
    mount();
    for (const r of [head(), ...shown()]) {
      const size = r.querySelector('[data-col="size"]') as HTMLElement;
      expect(rendered(size), r.dataset.key).toBe(false);
    }
    for (const col of ["length", "videos", "where", "actions"]) {
      expect(rendered(cell("f:A", col)), col).toBe(true);
    }
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(
      document.documentElement.clientWidth,
    );
    expect(grid().scrollWidth).toBeLessThanOrEqual(grid().clientWidth);
    const last = cell("f:A", "actions").getBoundingClientRect();
    expect(last.right).toBeLessThanOrEqual(
      grid().getBoundingClientRect().right + 0.5,
    );
  });

  // Red: the tag strip kept at full width (`flex: none`), which crushes
  // the name beside it to "R." here.
  it("at 720px a tagged name keeps its words and the tag is the one clipped", async () => {
    await page.viewport(720, 900);
    mount();
    const name = cell("f:R", "name").querySelector(
      "[data-name-text]",
    ) as HTMLElement;
    const strip = row("f:R").querySelector(".row-tags") as HTMLElement;
    const em = Number.parseFloat(getComputedStyle(name).fontSize);
    const said = JSON.stringify({
      name: [name.clientWidth, name.scrollWidth],
      strip: [strip.clientWidth, strip.scrollWidth],
      cell: cell("f:R", "name").clientWidth,
    });
    // Premise: the cell is too narrow for the name and the whole tag.
    expect(
      name.scrollWidth + strip.scrollWidth,
      `the cell fits both: ${said}`,
    ).toBeGreaterThan(cell("f:R", "name").clientWidth);
    expect(name.getBoundingClientRect().width, said).toBeGreaterThanOrEqual(
      4 * em,
    );
    expect(name.scrollWidth, `the name is cut: ${said}`).toBeLessThanOrEqual(
      name.clientWidth,
    );
    expect(strip.scrollWidth, `the tag is not cut: ${said}`).toBeGreaterThan(
      strip.clientWidth,
    );
  });

  it("at 560px Length and Videos are gone too", async () => {
    await page.viewport(560, 900);
    mount();
    for (const r of [head(), ...shown()]) {
      for (const col of ["size", "length", "videos"]) {
        const c = r.querySelector(`[data-col="${col}"]`) as HTMLElement;
        expect(rendered(c), `${r.dataset.key} ${col}`).toBe(false);
      }
    }
    for (const col of ["name", "where", "recorded", "actions"]) {
      expect(rendered(cell("f:A", col)), col).toBe(true);
    }
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(
      document.documentElement.clientWidth,
    );
    expect(grid().scrollWidth).toBeLessThanOrEqual(grid().clientWidth);
    // The columns left still line up, and the actions end every row.
    for (const col of ["name", "where", "recorded"]) {
      expect(new Set(lefts(col)).size, col).toBe(1);
    }
    expect(new Set(actionRights()).size).toBe(1);
  });

  it("under 900px tall the list does not paint over anything", async () => {
    await page.viewport(1280, 720);
    mount();
    const bar = node(".topbar");
    const jump = node("[data-jumps] a");
    const toggle = node("[data-layout-toggle] [data-layout='grid']");
    for (const scroll of [0, 24, 90]) {
      window.scrollTo(0, scroll);
      for (const e of [bar, jump, toggle]) {
        const b = e.getBoundingClientRect();
        if (b.bottom <= 0) continue;
        const y = Math.max(b.top, 0) + Math.min(b.height, b.bottom) / 2;
        const hit = at(b.left + Math.min(b.width / 2, 20), y);
        expect(
          hit?.closest("[data-list]"),
          `${scroll}: ${e.className}`,
        ).toBeNull();
      }
    }
    // The list sits right of the jump list, not under it.
    expect(grid().getBoundingClientRect().left).toBeGreaterThanOrEqual(
      node(".library-side").getBoundingClientRect().right,
    );
  });
});

/** The painted box of the first run of text in `e`: the glyphs, not the
 *  cell or button that holds them. */
function textBox(e: Element): DOMRect {
  const walk = document.createTreeWalker(e, NodeFilter.SHOW_TEXT);
  for (let t = walk.nextNode(); t !== null; t = walk.nextNode()) {
    if ((t.textContent ?? "").trim() === "") continue;
    const range = document.createRange();
    range.selectNodeContents(t);
    return range.getBoundingClientRect();
  }
  throw new Error(`no text in ${e.outerHTML.slice(0, 120)}`);
}

/** The value columns, as they read along a row. */
const VALUES = ["name", "where", "videos", "length", "size", "recorded"];
const NUMBERS = new Set(["videos", "length", "size"]);

// The author's review in a real studio window (look pass, 2026-11-01).
describe("the list's look, as the author reviewed it", () => {
  // Red: Recorded before Size in list.ts's COLUMNS.
  it("the columns read Name, Where, Videos, Length, Size, Recorded, in the DOM and on screen", () => {
    mount();
    const heads = [
      ...head().querySelectorAll<HTMLElement>("[role=columnheader]"),
    ].filter((h) => VALUES.includes(h.dataset.col as string));
    expect(heads.map((h) => h.dataset.col)).toEqual(VALUES);
    expect(heads.map((h) => h.textContent)).toEqual([
      "Name",
      "Where",
      "Videos",
      "Length",
      "Size",
      "Recorded",
    ]);
    const painted = [...heads]
      .sort(
        (a, b) =>
          a.getBoundingClientRect().left - b.getBoundingClientRect().left,
      )
      .map((h) => h.dataset.col);
    expect(painted).toEqual(VALUES);
    // Every row's cells in the same order as the head's.
    for (const r of [row("f:A"), row("h:today"), row("t:loose")]) {
      const cols = [...r.querySelectorAll<HTMLElement>("[role=gridcell]")]
        .map((c) => c.dataset.col as string)
        .filter((c) => VALUES.includes(c));
      expect(cols, r.dataset.key).toEqual(VALUES);
    }
  });

  for (const width of [1440, 720]) {
    // A guard the reorder and the floating actions must keep: green on
    // the code before them. Red: a number heading's text left-aligned
    // (`text-align` off the head's number cells), or Name's heading
    // indented as a video's name is.
    it(`at ${width}px every column heading's text edge is its values' edge`, async () => {
      await page.viewport(width, 900);
      mount();
      const visible = VALUES.filter((c) =>
        rendered(head().querySelector(`[data-col="${c}"]`) as Element),
      );
      // Premise: at 720 Size is dropped and the rest drawn; at 1440 all.
      expect(visible).toEqual(
        width === 720 ? VALUES.filter((c) => c !== "size") : VALUES,
      );
      const said: string[] = [];
      for (const col of visible) {
        const h = textBox(
          head().querySelector(`[data-col="${col}"]`) as Element,
        );
        const valueCell = cell("f:A", col);
        // Premise: the first flow has a value in every column.
        expect((valueCell.textContent ?? "").trim(), col).not.toBe("");
        const v = textBox(valueCell);
        const edge = NUMBERS.has(col) ? "right" : "left";
        said.push(`${col} ${edge}: head ${h[edge]} value ${v[edge]}`);
        expect(
          Math.abs(h[edge] - v[edge]),
          said.join("; "),
        ).toBeLessThanOrEqual(1);
      }
    });
  }

  it("the sorted heading's emphasis does not move its text", () => {
    mount();
    const at = () =>
      textBox(head().querySelector('[data-col="recorded"]') as Element).left;
    // Premise: Recorded is the sorted column.
    expect(
      head().querySelector('[data-col="recorded"]')?.getAttribute("aria-sort"),
    ).toBe("descending");
    const sorted = at();
    const font = getComputedStyle(
      head().querySelector('[data-sort="recorded"]') as Element,
    ).fontWeight;
    // The same column unsorted: the view sorted by Name instead.
    renderLibrary(
      node("#root"),
      MODEL,
      ACTIONS,
      new Map(),
      NOW,
      { ids: new Set(), anchor: null, range: [] },
      undefined,
      { layout: "list", sort: { column: "name", descending: false } },
    );
    expect(
      head().querySelector('[data-col="recorded"]')?.hasAttribute("aria-sort"),
    ).toBe(false);
    expect(at()).toBe(sorted);
    expect(
      getComputedStyle(
        head().querySelector('[data-sort="recorded"]') as Element,
      ).fontWeight,
    ).toBe(font);
  });

  // Red: the heading in the flows' columns (chevron in Open, label in
  // Name), a row's height and hairline, the mono count and the row hover.
  it("a date heading reads as a section label: at the list's left edge, sans, with room above and no row hairline", async () => {
    await page.viewport(960, 640);
    mount();
    const h = row("h:today");
    const listLeft = head()
      .querySelector('[data-col="select"]')
      ?.getBoundingClientRect().left as number;
    const chev = (
      cell("h:today", "open").querySelector(".chev") as Element
    ).getBoundingClientRect();
    const label = textBox(
      cell("h:today", "name").querySelector("[data-name-text]") as Element,
    );
    const count = cell("h:today", "name").querySelector(
      "[data-section-count]",
    ) as HTMLElement;
    const flowName = textBox(
      cell("f:A", "name").querySelector("[data-name-text]") as Element,
    );
    const flowChev = (
      cell("f:A", "open").querySelector(".chev") as Element
    ).getBoundingClientRect();
    const said = JSON.stringify({ listLeft, chev, label, flowName });
    // The chevron leads, at the list's left edge, smaller than a flow's.
    expect(chev.left, said).toBeLessThanOrEqual(listLeft + 1);
    expect(chev.width, said).toBeLessThan(flowChev.width);
    // The label follows it, left of the Name column; a flow's name
    // starts further right.
    expect(label.left, said).toBeGreaterThan(chev.right);
    expect(label.left, said).toBeLessThan(
      head().querySelector('[data-col="name"]')?.getBoundingClientRect()
        .left as number,
    );
    expect(flowName.left, said).toBeGreaterThan(label.left + 20);
    // The UI sans, label and count, at 12px 600.
    for (const e of [cell("h:today", "name"), count]) {
      expect(getComputedStyle(e).fontFamily, e.className).not.toMatch(/mono/i);
    }
    const style = getComputedStyle(
      cell("h:today", "name").querySelector("[data-name-text]") as Element,
    );
    expect([style.fontSize, style.fontWeight]).toEqual(["12px", "600"]);
    // More room above it than a row has: from the head's bottom to the
    // label's top, against one flow's bottom to the next's name.
    const above = label.top - head().getBoundingClientRect().bottom;
    const rowAbove =
      textBox(cell("f:L", "name").querySelector("[data-name-text]") as Element)
        .top - row("f:A").getBoundingClientRect().bottom;
    expect(above, `${above} vs ${rowAbove}`).toBeGreaterThan(rowAbove + 10);

    const paint = await pixels();
    const ground = paint(
      listLeft + 2,
      head().getBoundingClientRect().bottom + 4,
    );
    const box = h.getBoundingClientRect();
    const x = cell("f:A", "where").getBoundingClientRect().left + 40;
    // A flow's last pixel is its hairline; the heading's is the ground.
    const fa = row("f:A").getBoundingClientRect();
    expect(
      close(paint(x, fa.bottom - 0.5), ground, 2),
      "premise: a flow's hairline",
    ).toBe(false);
    expect(
      close(paint(x, box.bottom - 0.5), ground, 2),
      `${paint(x, box.bottom - 0.5)}`,
    ).toBe(true);
    // And its rule runs on through the Where column, level with the label.
    const ruled = [];
    for (let y = Math.floor(label.top); y <= Math.ceil(label.bottom); y++) {
      ruled.push(!close(paint(x, y + 0.5), ground, 2));
    }
    expect(ruled, "the heading's rule").toContain(true);

    // No hover ground on a heading; a flow's hover has one.
    await userEvent.hover(cell("h:today", "where"));
    expect(h.matches(":hover")).toBe(true);
    expect(parse(getComputedStyle(h).backgroundColor)[3]).toBe(0);
    // The keyboard's heading keeps its inset edge.
    h.focus();
    await userEvent.keyboard("{ArrowDown}{ArrowUp}");
    expect(document.activeElement).toBe(h);
    expect(h.matches(":focus-visible")).toBe(true);
    expect(getComputedStyle(h).boxShadow).toMatch(/inset/);
  });

  // Red: the actions in a grid track of their own, which holds its width
  // empty at rest and keeps Recorded off the row's end.
  it("the actions float over the row's end: nothing moves, the date ends the row, and the value under them is covered", async () => {
    await page.viewport(960, 640);
    mount();
    // A row on screen unscrolled: a hover would scroll to one that is
    // not, and the pixels read a scrolled frame unhovered.
    const r = row("f:N0");
    expect(r.getBoundingClientRect().bottom).toBeLessThan(innerHeight);
    const actions = cell("f:N0", "actions").querySelector(
      ".row-actions",
    ) as HTMLElement;
    const g = grid().getBoundingClientRect();
    const recorded = cell("f:N0", "recorded").getBoundingClientRect();
    // The date ends the row: no track is held after it.
    expect(recorded.right, JSON.stringify({ recorded, g })).toBeCloseTo(
      g.right,
      0,
    );
    const cells = [...r.children];
    const before = cells.map(rectOf);
    expect(getComputedStyle(actions).opacity).toBe("0");
    await userEvent.hover(cell("f:N0", "where"));
    expect(getComputedStyle(actions).opacity).toBe("1");
    expect(cells.map(rectOf)).toEqual(before);
    const a = actions.getBoundingClientRect();
    // Over the trailing end, right-aligned to the row.
    expect(a.right).toBeCloseTo(g.right, 0);
    expect(a.left).toBeLessThan(recorded.right);
    // Premise: the date's text sits under the actions.
    const date = textBox(cell("f:N0", "recorded"));
    expect(date.right, JSON.stringify({ date, a })).toBeGreaterThan(
      a.left + 30,
    );
    // Covered cleanly, never half: from the date's own left edge to the
    // actions' first button, across the date's line, the paint is the
    // hovered row's ground (the Videos cell's blank left, in the same
    // row). The fade is the gap before it.
    const paint = await pixels();
    const y = date.top + date.height / 2;
    const v = cell("f:N0", "videos").getBoundingClientRect();
    const ground = paint(v.left + 3, y);
    const first = actions
      .querySelector("button")
      ?.getBoundingClientRect() as DOMRect;
    const seen: number[][] = [];
    // Premise: the date starts in that span, so it holds its glyphs.
    expect(date.left).toBeLessThan(first.left);
    for (let x = Math.ceil(recorded.left); x < first.left + 4; x++) {
      for (const dy of [-3, 0, 3]) seen.push(paint(x + 0.5, y + dy));
    }
    expect(seen.length).toBeGreaterThan(0);
    expect(
      seen.every((p) => close(p, ground, 3)),
      `${JSON.stringify(ground)} vs ${JSON.stringify(seen)}`,
    ).toBe(true);
    // Delete is what the hit test finds at its own centre.
    const del = actions.querySelector('[data-action="delete"]') as HTMLElement;
    const d = del.getBoundingClientRect();
    expect(
      at(d.left + d.width / 2, d.top + d.height / 2)?.closest("button"),
    ).toBe(del);
  });

  it("while flows are ticked the actions stay hidden under the pointer, and nothing moves", async () => {
    mount(false, ["N0"]);
    const cells = [...row("f:N3").children];
    const before = cells.map(rectOf);
    await userEvent.hover(cell("f:N3", "where"));
    expect(row("f:N3").matches(":hover")).toBe(true);
    const actionsCell = cell("f:N3", "actions");
    expect(actionsCell.checkVisibility({ visibilityProperty: true })).toBe(
      false,
    );
    expect(cells.map(rectOf)).toEqual(before);
  });
});

/** Where focus is: `key/col` for a cell or a control in it. */
const focusedAt = (): string => {
  const a = document.activeElement as HTMLElement;
  const r = a.closest<HTMLElement>("[role=row][data-key]");
  return `${r?.dataset.key}/${a.closest<HTMLElement>("[role=gridcell]")?.dataset.col}`;
};

/** The date's glyphs left of the first action button, as painted: how
 *  many of its pixels are bright as text is, never as a ground is. */
function dateGlyphs(
  paint: (x: number, y: number) => number[],
  key: string,
): number {
  const date = textBox(cell(key, "recorded"));
  const first = cell(key, "actions")
    .querySelector("button")
    ?.getBoundingClientRect() as DOMRect;
  // Premise: some of the date sits left of the buttons, where no icon is.
  expect(date.left + 4, key).toBeLessThan(first.left);
  let bright = 0;
  for (
    let x = Math.ceil(date.left);
    x < Math.min(date.right, first.left);
    x++
  ) {
    for (let y = Math.ceil(date.top); y < date.bottom; y++) {
      if (Math.max(...paint(x + 0.5, y + 0.5).slice(0, 3)) > 120) bright++;
    }
  }
  return bright;
}

// Fix round 1 of the look pass (the coordinator's five).
describe("the look pass's focus, cover and Couldn't read heading", () => {
  // Red: the row's `:has(:focus-visible)` revealing the cover over the
  // Recorded cell that holds the focus.
  it("a keyboard-focused Recorded cell is not under the actions", async () => {
    await page.viewport(960, 640);
    mount();
    row("f:A").focus();
    await userEvent.keyboard("{ArrowRight}{ArrowRight}{End}");
    for (let i = 0; i < 6 && !focusedAt().endsWith("/recorded"); i++) {
      await userEvent.keyboard("{ArrowLeft}");
    }
    expect(focusedAt()).toBe("f:A/recorded");
    const c = cell("f:A", "recorded");
    expect(c.matches(":focus-visible")).toBe(true);
    const b = c.getBoundingClientRect();
    const hit = at(b.left + b.width / 2, b.top + b.height / 2);
    expect(hit?.closest("[role=gridcell]"), hit?.outerHTML.slice(0, 80)).toBe(
      c,
    );
    expect(dateGlyphs(await pixels(), "f:A")).toBeGreaterThan(5);
  });

  // Red: `overflow: hidden` on the actions cell clipping the ring that
  // stands 2px outside the last button.
  it("a focused action button's ring paints whole, past the row's end", async () => {
    await page.viewport(960, 640);
    mount();
    row("f:A").focus();
    await userEvent.keyboard("{ArrowRight}{ArrowRight}{End}");
    const del = document.activeElement as HTMLElement;
    expect(del.dataset.action).toBe("delete");
    expect(del.matches(":focus-visible")).toBe(true);
    const ink = parse(getComputedStyle(del).outlineColor);
    const d = del.getBoundingClientRect();
    const paint = await pixels();
    const outside = paint(d.right + 3, d.top + d.height / 2);
    expect(close(outside, ink, 24), `${outside} vs ${ink}`).toBe(true);
  });

  // Red: the cover's opaque ground kept on a device that never hovers,
  // where the actions always show.
  it("on a device with no hover the dates still paint beside the buttons", async () => {
    await page.viewport(960, 640);
    mount();
    // The page's own `(hover: none)` rules, applied as such a device
    // applies them. Not CDP's emulation: touch emulation turns the query
    // true but the lane's screenshot still paints the hover rules
    // (measured: the same glyphs with the cover's ground on and off), and
    // setEmulatedMedia does not emulate `hover` at all.
    const sheet = document.head.querySelector("[data-shell]") as HTMLElement;
    const query = "@media (hover: none)";
    expect(sheet.textContent?.split(query).length ?? 0).toBeGreaterThan(1);
    sheet.textContent = (sheet.textContent ?? "").replaceAll(
      query,
      "@media all",
    );
    const actions = cell("f:N0", "actions").querySelector(
      ".row-actions",
    ) as HTMLElement;
    // Premise: the buttons show at rest there.
    expect(getComputedStyle(actions).opacity).toBe("1");
    expect(dateGlyphs(await pixels(), "f:N0")).toBeGreaterThan(5);
  });

  // Red: the heading's actions cell at the row's top, in the 14px above
  // its label's line.
  it("a heading's focused actions cell sits on its label's line", async () => {
    await page.viewport(960, 640);
    mount();
    row("h:today").focus();
    await userEvent.keyboard("{ArrowRight}{End}");
    expect(focusedAt()).toBe("h:today/actions");
    const c = cell("h:today", "actions");
    const line = cell("h:today", "name").getBoundingClientRect();
    const b = c.getBoundingClientRect();
    expect(b.top, JSON.stringify({ b, line })).toBeGreaterThanOrEqual(
      line.top - 0.5,
    );
    expect(b.bottom, JSON.stringify({ b, line })).toBeLessThanOrEqual(
      line.bottom + 0.5,
    );
    const ink = parse(getComputedStyle(c).outlineColor);
    const paint = await pixels();
    const x = b.left + b.width / 2;
    // The outline's top edge is on the label's line, not in the space above.
    const rowTop = row("h:today").getBoundingClientRect().top;
    expect(close(paint(x, line.top + 1), ink, 24), "on the line").toBe(true);
    expect(close(paint(x, rowTop + 1), ink, 24), "above the line").toBe(false);
  });

  // Red: the cards' heading (mono, uppercase, 4px above) drawn under the
  // list.
  it("Couldn't read under the list is a section label as the date headings are", () => {
    mount();
    renderLibrary(
      node("#root"),
      {
        ...MODEL,
        unreadable: [
          {
            folder: "take-half-written",
            reason: "no scene.json",
            sizeBytes: 30,
          },
        ],
      },
      ACTIONS,
      new Map(),
      NOW,
      { ids: new Set(), anchor: null, range: [] },
      undefined,
      { layout: "list", sort: { column: "recorded", descending: true } },
    );
    const section = node("[data-unreadable]");
    // Premise: it is drawn under the list, as rows.
    expect(section.querySelector(".unreadable-list")).not.toBeNull();
    const h2 = section.querySelector(".section-head h2") as HTMLElement;
    const count = section.querySelector(
      ".section-head .section-count",
    ) as HTMLElement;
    for (const e of [h2, count]) {
      expect(getComputedStyle(e).fontFamily, e.tagName).not.toMatch(/mono/i);
    }
    const date = cell("h:today", "name").querySelector(
      "[data-name-text]",
    ) as HTMLElement;
    const hs = getComputedStyle(h2);
    const ds = getComputedStyle(date);
    expect([hs.fontSize, hs.fontWeight, hs.color, hs.textTransform]).toEqual([
      ds.fontSize,
      ds.fontWeight,
      ds.color,
      "none",
    ]);
    expect(getComputedStyle(count).color).toBe(
      getComputedStyle(
        cell("h:today", "name").querySelector(
          "[data-section-count]",
        ) as Element,
      ).color,
    );
    // The same room above: from what stands over each to its label.
    const gap = textBox(h2).top - grid().getBoundingClientRect().bottom;
    const dateGap = textBox(date).top - head().getBoundingClientRect().bottom;
    expect(Math.abs(gap - dateGap), `${gap} vs ${dateGap}`).toBeLessThanOrEqual(
      1,
    );
  });
});

describe("the list's motion", () => {
  // Red: the fade on every video row's first style, which a redraw gives
  // each open video row again, though nothing opened.
  it("fades the videos of a flow being opened, never on a redraw", async () => {
    mount(true);
    const runs: string[] = [];
    grid().addEventListener("transitionrun", (event) => {
      const r = (event.target as HTMLElement).closest<HTMLElement>(
        "[role=row]",
      );
      if (event.target === r) runs.push(r?.dataset.key as string);
    });
    await userEvent.click(cell("f:A", "open"));
    await expect.poll(() => runs).toEqual(["v:a2", "v:a1"]);
    draw();
    // Premise: the redraw drew A open, with new rows.
    expect(row("f:A").getAttribute("aria-expanded")).toBe("true");
    expect(row("v:a2").hidden).toBe(false);
    for (const key of ["v:a2", "v:a1"]) {
      expect(row(key).getAnimations(), key).toHaveLength(0);
    }
  });

  it("turns the chevron and fades video rows in 120ms", async () => {
    mount(true);
    const chev = cell("f:A", "open").querySelector(".chev") as Element;
    expect(getComputedStyle(chev).transitionDuration).toMatch(/0\.12s/);
    expect(getComputedStyle(row("v:a2")).transitionDuration).toBe("0.12s");
    expect(getComputedStyle(row("v:a2")).transitionProperty).toBe("opacity");
    await userEvent.click(cell("f:A", "open"));
    // Turned once open; the height is never animated.
    expect(getComputedStyle(chev).transform).not.toBe("none");
    expect(getComputedStyle(row("v:a2")).transitionProperty).not.toMatch(
      /height|all/,
    );
  });

  it("reduced motion sets the chevron's and the rows' transition durations to 0", async () => {
    await cdp().send("Emulation.setEmulatedMedia", {
      features: [{ name: "prefers-reduced-motion", value: "reduce" }],
    });
    expect(matchMedia("(prefers-reduced-motion: reduce)").matches).toBe(true);
    mount(true);
    const chev = cell("f:A", "open").querySelector(".chev") as Element;
    for (const d of getComputedStyle(chev).transitionDuration.split(", ")) {
      expect(d).toBe("0s");
    }
    expect(getComputedStyle(row("v:a2")).transitionDuration).toBe("0s");
  });
});

// The look to open and check by eye (gitignored, as every lane's shots):
// A open with its videos, Flow 2 under the pointer. Each shot asserts the
// one thing a glance at it would check first: nothing runs off sideways.
describe("the list's shots", () => {
  for (const [width, height] of [
    [1440, 900],
    [720, 900],
  ] as const) {
    it(`shoots the list at ${width}x${height}`, async () => {
      await page.viewport(width, height);
      mount();
      await userEvent.click(cell("f:A", "open"));
      await userEvent.hover(cell("f:N2", "where"));
      expect(row("v:a2").hidden).toBe(false);
      expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(
        document.documentElement.clientWidth,
      );
      await page.screenshot({
        path: `__screenshots__/library-list/list-${width}x${height}.png`,
      });
    });
  }
});

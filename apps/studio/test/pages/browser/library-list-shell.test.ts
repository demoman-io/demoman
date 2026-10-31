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
/** Every column's cells' lefts, head row included, of the rows shown. */
const lefts = (col: string): number[] =>
  [head(), ...shown()].map(
    (r) =>
      (
        r.querySelector(`[data-col="${col}"]`) as HTMLElement
      ).getBoundingClientRect().left,
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
  it("rows are 34px and every column lines up across rows", async () => {
    mount();
    await userEvent.click(cell("f:A", "open"));
    // Premise: a heading, flows, video rows and the take in no flow.
    const kinds = shown().map((r) => r.dataset.key?.slice(0, 2));
    expect(new Set(kinds)).toEqual(new Set(["h:", "f:", "v:", "t:"]));
    for (const r of shown()) {
      if (r.querySelector("[data-status]") !== null) continue;
      expect(r.getBoundingClientRect().height, r.dataset.key).toBeCloseTo(
        34,
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
      "recorded",
      "size",
      "actions",
    ]) {
      const xs = lefts(col);
      expect(new Set(xs).size, `${col}: ${xs.join(", ")}`).toBe(1);
    }
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
    await userEvent.hover(cell("f:N3", "recorded"));
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
    await userEvent.hover(cell("f:N1", "recorded"));
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
    // The columns left still line up.
    for (const col of ["name", "where", "recorded", "actions"]) {
      expect(new Set(lefts(col)).size, col).toBe(1);
    }
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
      await userEvent.hover(cell("f:N2", "recorded"));
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

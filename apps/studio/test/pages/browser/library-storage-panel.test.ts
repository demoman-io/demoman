import { page, userEvent } from "@vitest/browser/context";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import shell from "../../../pages/entrypoints/library/index.html?raw";
import type {
  LibraryModel,
  LibraryRow,
} from "../../../pages/src/library/state";
import { renderLibrary } from "../../../pages/src/library/view";
import {
  contrast,
  ink,
  mountShell,
  node,
  pageParts,
  surface,
} from "../helpers/shell-css";

/**
 * The Recordings page's storage panel, as Chrome runs and paints it.
 *
 * Until 2026-10-06 the storage controls were a `<details>` under the title,
 * and opening it pushed every card down the page. The panel is a popover
 * now, and every claim about it is a claim about layout, the top layer or
 * focus — none of which jsdom has — so they live here.
 */

const { css, body: bodyHtml } = pageParts(shell, ".storage-panel");

const base: LibraryRow = {
  sceneId: "a",
  name: "Checkout",
  label: "Checkout",
  origin: "localhost:4000",
  path: "/checkout",
  createdAt: "2026-09-13T14:15:03Z",
  when: "Sep 13, 2:15 PM",
  time: "2:15 PM",
  hosted: false,
  recoverable: false,
  frameBytes: 18 * 1024 ** 2,
  outputBytes: 3 * 1024 ** 2,
  state: "Complete",
  canRestore: false,
  authored: false,
  servesReshoot: false,
  needsLook: false,
};

const MODEL: LibraryModel = {
  usedBytes: 127 * 1024 ** 2,
  budgetBytes: 2 * 1024 ** 3,
  fraction: 0.062,
  chromeNearLimit: false,
  migrating: false,
  migrationFailed: false,
  notice: null,
  // Enough cards that the list runs under the panel, and past the fold
  // at the heights below, so the page can scroll.
  rows: Array.from({ length: 12 }, (_, i) => ({
    ...base,
    sceneId: `r${i}`,
    path: `/p${i}`,
  })),
};

const NOW = new Date(2026, 8, 13, 20);

function actions() {
  return {
    reclaim: vi.fn(),
    setBudget: vi.fn(),
    edit: vi.fn(),
    restore: vi.fn(),
    backToRecording: vi.fn(),
    remove: vi.fn(),
    preview: vi.fn(),
    filter: vi.fn(),
    rename: vi.fn(),
    renameVideo: vi.fn(),
    openReview: vi.fn(),
  };
}

type Actions = ReturnType<typeof actions>;

function mount(
  scheme: "light" | "dark" = "light",
  model: LibraryModel = MODEL,
): Actions {
  mountShell(scheme, css);
  document.body.innerHTML = bodyHtml;
  const a = actions();
  renderLibrary(node("#root"), model, a, new Map(), undefined, NOW);
  return a;
}

const panel = () => node("[data-storage]");
const trigger = () => node("[data-storage-trigger]");
const budget = () => node("[data-storage-budget]") as HTMLInputElement;
const isOpen = () => panel().matches(":popover-open");

afterEach(() => {
  window.scrollTo(0, 0);
});

afterAll(async () => {
  await page.viewport(414, 896);
});

describe("the storage panel", () => {
  it("floats over the list: opening it moves nothing in the page", async () => {
    await page.viewport(1280, 800);
    mount();
    const section = node('[data-section="today"]');
    const firstCard = node('[data-row="r0"]');
    const before = [section, firstCard].map((n) => n.getBoundingClientRect());

    await userEvent.click(trigger());
    expect(isOpen()).toBe(true);

    const after = [section, firstCard].map((n) => n.getBoundingClientRect());
    expect(after.map((r) => [r.top, r.left])).toEqual(
      before.map((r) => [r.top, r.left]),
    );

    // And it is painted over the cards, not merely positioned among them.
    // The premise first: the panel overlaps some card's box — it opens from
    // the left column (2026-10-08) and reaches over the list — then what is
    // hit in the overlap is the panel, not that card.
    const p = panel().getBoundingClientRect();
    const overlap = [...document.querySelectorAll("[data-row]")]
      .map((card) => {
        const c = card.getBoundingClientRect();
        const left = Math.max(c.left, p.left);
        const right = Math.min(c.right, p.right);
        const top = Math.max(c.top, p.top);
        const bottom = Math.min(c.bottom, p.bottom);
        return right > left + 4 && bottom > top + 4
          ? { x: (left + right) / 2, y: (top + bottom) / 2 }
          : null;
      })
      .find((o) => o !== null);
    expect(overlap, "the panel overlaps no card").toBeDefined();
    const { x, y } = overlap as { x: number; y: number };
    const hit = document.elementFromPoint(x, y);
    expect(panel().contains(hit), `hit ${hit?.outerHTML.slice(0, 80)}`).toBe(
      true,
    );
  });

  // The trigger sits at the top bar's right end since 2026-10-08.
  it("opens under the trigger with its right edge on the trigger's", async () => {
    await page.viewport(1280, 800);
    mount();
    await userEvent.click(trigger());
    const t = trigger().getBoundingClientRect();
    const p = panel().getBoundingClientRect();
    expect(p.top).toBeGreaterThanOrEqual(t.bottom);
    expect(p.top - t.bottom).toBeLessThan(12);
    expect(Math.abs(p.right - t.right)).toBeLessThanOrEqual(1);
    expect(p.width).toBe(300);
  });

  it("keeps inside the window at phone width", async () => {
    await page.viewport(320, 740);
    mount();
    // Premise: an unclamped panel, 300px from the trigger's left edge,
    // would leave the window — or the clamp below is never exercised.
    const t = trigger().getBoundingClientRect();
    expect(
      t.left + 300,
      "an unclamped panel would stay in the window",
    ).toBeGreaterThan(document.documentElement.clientWidth - 16);

    await userEvent.click(trigger());
    const p = panel().getBoundingClientRect();
    const width = document.documentElement.clientWidth;
    expect(p.left).toBeGreaterThanOrEqual(16);
    expect(p.right).toBeLessThanOrEqual(width - 16);
    expect(document.documentElement.scrollWidth).toBe(width);
  });

  // Both ways the column sits: held in view on a wide window (it scrolls
  // with the page until it sticks, then stays), and scrolling with the
  // page under 1024px. Either way the panel keeps to the trigger.
  it.each([1280, 800])(
    "stays with the trigger as the page scrolls (%ipx)",
    async (width) => {
      await page.viewport(width, 600);
      mount();
      await userEvent.click(trigger());
      // Premise: the page can scroll by the distance used below.
      expect(
        document.documentElement.scrollHeight - window.innerHeight,
      ).toBeGreaterThan(100);
      // The edge that faces the trigger stays 6px off it, on whichever
      // side the panel opened — in a 600px window it may not fit below a
      // trigger at the foot of a tall column, and opens above, capped.
      const gap = () => {
        const p = panel().getBoundingClientRect();
        const t = trigger().getBoundingClientRect();
        return panel().dataset.side === "above"
          ? t.top - p.bottom
          : p.top - t.bottom;
      };
      // Within a pixel: the panel's place is rounded to whole pixels, the
      // trigger's edge is not.
      const off = () => Math.abs(gap() - 6);
      expect(off(), `opened ${panel().dataset.side}`).toBeLessThanOrEqual(1);
      const side = panel().dataset.side;
      window.scrollBy(0, 100);
      expect(window.scrollY).toBe(100);
      // The panel follows on the scroll event, which lands a frame later,
      // and keeps the side it opened on.
      await expect.poll(off).toBeLessThanOrEqual(1);
      expect(panel().dataset.side).toBe(side);
      // Never over its own trigger.
      const p = panel().getBoundingClientRect();
      const t = trigger().getBoundingClientRect();
      expect(p.bottom <= t.top || p.top >= t.bottom).toBe(true);
    },
  );

  it("closes on Escape and on a click outside it", async () => {
    await page.viewport(1280, 800);
    mount();
    await userEvent.click(trigger());
    expect(isOpen()).toBe(true);
    expect(trigger().hasAttribute("data-open")).toBe(true);
    await userEvent.keyboard("{Escape}");
    expect(isOpen()).toBe(false);
    expect(trigger().hasAttribute("data-open")).toBe(false);

    await userEvent.click(trigger());
    expect(isOpen()).toBe(true);
    await userEvent.click(node("h1"));
    expect(isOpen()).toBe(false);
  });

  it("saves the budget on Enter, and stays open over the render that follows", async () => {
    await page.viewport(1280, 800);
    const a = mount();
    await userEvent.click(trigger());
    await userEvent.tripleClick(budget());
    await userEvent.keyboard("3{Enter}");
    expect(a.setBudget).toHaveBeenCalledWith(3 * 1024 ** 3);

    // What the page does with a saved budget: render again, with the new
    // numbers. The rows are new elements after it; the panel is not.
    const oldRow = node('[data-row="r0"]');
    renderLibrary(
      node("#root"),
      { ...MODEL, budgetBytes: 3 * 1024 ** 3, fraction: 0.041 },
      a,
      new Map(),
      undefined,
      NOW,
    );
    expect(node('[data-row="r0"]')).not.toBe(oldRow);
    expect(isOpen()).toBe(true);
    expect(node("[data-storage-used]").textContent).toBe(
      "127 MB used of a 3 GB budget",
    );
    expect(document.activeElement).toBe(budget());
    expect(a.setBudget).toHaveBeenCalledTimes(1);
  });

  it("saves the budget when the author clicks away from it", async () => {
    await page.viewport(1280, 800);
    const a = mount();
    await userEvent.click(trigger());
    await userEvent.tripleClick(budget());
    await userEvent.keyboard("1.5");
    expect(a.setBudget).not.toHaveBeenCalled();
    await userEvent.click(node("h1"));
    expect(isOpen()).toBe(false);
    expect(a.setBudget).toHaveBeenCalledWith(1.5 * 1024 ** 3);
  });

  it("carries a budget still being typed across a render, without saving it", async () => {
    await page.viewport(1280, 800);
    const a = mount();
    await userEvent.click(trigger());
    await userEvent.tripleClick(budget());
    // "1." is the case that matters: a number field reads it back as "1"
    // or "", so the text survives only if the field itself does.
    await userEvent.keyboard("1.");
    const field = budget();
    expect(document.activeElement).toBe(field);
    // A render some other action triggered — a rename on a card, say.
    renderLibrary(node("#root"), MODEL, a, new Map(), undefined, NOW);
    expect(isOpen()).toBe(true);
    expect(budget()).toBe(field);
    expect(document.activeElement).toBe(field);
    expect(a.setBudget).not.toHaveBeenCalled();
    await userEvent.keyboard("5{Enter}");
    expect(a.setBudget).toHaveBeenCalledWith(1.5 * 1024 ** 3);
  });
});

describe.each(["light", "dark"] as const)("the storage panel, %s", (scheme) => {
  it("is legible, and its surface steps off the page's", async () => {
    await page.viewport(1280, 800);
    mount(scheme);
    await userEvent.click(trigger());
    const ground = surface("body", "[data-storage]");
    expect(contrast(ink(".storage-title"), ground)).toBeGreaterThanOrEqual(7);
    expect(contrast(ink("[data-storage-used]"), ground)).toBeGreaterThanOrEqual(
      4.5,
    );
    expect(contrast(ink(".storage-hint"), ground)).toBeGreaterThanOrEqual(4.5);
    expect(
      contrast(ink("[data-meter]"), surface("body", "[data-storage-trigger]")),
    ).toBeGreaterThanOrEqual(4.5);
    expect(surface("body", "[data-storage]")).not.toEqual(surface("body"));
    // A hairline ring as well as the drop shadow: the panel floats over
    // cards of its own tone, and in dark the drop shadow is lost on the
    // page, so the ring is the only edge it has there.
    expect(getComputedStyle(panel()).boxShadow).toMatch(/0px 0px 0px 1px/);
  });
});

import { page, userEvent } from "@vitest/browser/context";
import { afterAll, describe, expect, it } from "vitest";
// The page's own markup and rules — the shell it links comes in through
// the helper — and the real view, so the rows measured are the rows the
// page renders.
import shell from "../../../pages/entrypoints/library/index.html?raw";
import type {
  LibraryModel,
  LibraryRow,
} from "../../../pages/src/library/state";
import { renderLibrary } from "../../../pages/src/library/view";
import {
  contrast,
  ink,
  length,
  mountShell,
  node,
  pageParts,
  parse,
  radius,
  surface,
  token,
} from "../helpers/shell-css";

/**
 * The Recordings page's painted surface, in both themes.
 *
 * Restyled 2026-09-13 to match the popup: the shell stylesheet the two
 * share, cards that answer the pointer, icon-only Edit and Delete, a size
 * line with less weight, and no "Complete" label. Then laid out as a grid
 * of thumbnail-first cards, because a 720px column of horizontal strips
 * left a laptop screen two-thirds empty. Each of those is a claim about
 * what the page paints, and the popup-shell lesson applies — tokens in a
 * source file say nothing about it. So this mounts the shipped stylesheets
 * and the real view's output and reads computed style back.
 */

const { css, body: bodyHtml } = pageParts(shell, "article.card:hover");

const base: LibraryRow = {
  sceneId: "done",
  name: "",
  label: "localhost:4000/checkout",
  origin: "localhost:4000",
  path: "/checkout",
  createdAt: "2026-09-13T14:15:03Z",
  when: "Sep 13, 2:15 PM",
  time: "2:15 PM",
  hosted: true,
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
  usedBytes: 412 * 1024 ** 2,
  budgetBytes: 4 * 1024 ** 3,
  fraction: 0.1,
  chromeNearLimit: false,
  migrating: false,
  migrationFailed: false,
  notice: null,
  rows: [
    base,
    {
      ...base,
      sceneId: "reclaimed",
      name: "Checkout",
      label: "Checkout",
      when: "Sep 12, 9:40 AM",
      time: "9:40 AM",
      hosted: false,
      recoverable: true,
      frameBytes: 0,
      state: "Motion reclaimed",
      canRestore: true,
      authored: false,
      servesReshoot: false,
      needsLook: false,
    },
    { ...base, sceneId: "three", origin: "staging.example.com", path: "" },
    { ...base, sceneId: "four", path: "/settings" },
    { ...base, sceneId: "five", path: "/onboarding" },
  ],
};

const noop = {
  reclaim() {},
  setBudget() {},
  edit() {},
  restore() {},
  backToRecording() {},
  remove() {},
  preview() {},
  rename() {},
  renameVideo() {},
  openReview() {},
};

// The clock the sections are measured from: the evening of the day the
// fixture rows were made, in whatever zone the lane runs in, so all five
// sit under one "Today" heading and the grid below has one row set to
// measure. (A row made after `now` also counts as today.)
const NOW = new Date(2026, 8, 13, 20);

function mount(scheme: "light" | "dark", model: LibraryModel = MODEL) {
  mountShell(scheme, css);
  document.body.innerHTML = bodyHtml;
  renderLibrary(node("#root"), model, noop, new Map(), NOW);
  node("#notice").classList.remove("hidden");
  node("#notice").textContent = "Couldn't read storage: no reply.";
  return { surface, ink, radius };
}

const CARD = '[data-row="done"]';

afterAll(async () => {
  await page.viewport(414, 896);
});

describe.each(["light", "dark"] as const)(
  "the Recordings page, %s",
  (scheme) => {
    it("paints its own background and keeps text legible on the shell and the cards", () => {
      const { surface, ink } = mount(scheme);
      expect(parse(getComputedStyle(node("body")).backgroundColor)[3]).toBe(1);
      expect(contrast(ink("h1"), surface("body"))).toBeGreaterThanOrEqual(7);
      expect(
        contrast(ink(`${CARD} [data-name]`), surface("body", CARD)),
      ).toBeGreaterThanOrEqual(7);
      // The size line is meant to weigh less than the title, and still be read.
      expect(
        contrast(ink(`${CARD} [data-size]`), surface("body", CARD)),
      ).toBeGreaterThanOrEqual(4.5);
      expect(
        Number.parseFloat(
          getComputedStyle(node(`${CARD} [data-size]`)).fontSize,
        ),
      ).toBeLessThan(
        Number.parseFloat(
          getComputedStyle(node(`${CARD} [data-name]`)).fontSize,
        ),
      );
    });

    it("tones and rounds a card the way the popup does", () => {
      const { surface, radius } = mount(scheme);
      const card = node(CARD);
      // Flat since 2026-09-20: the ring that used to separate a card from
      // the page is gone and the card's own tone does it, exactly as on
      // the popup. Both halves asserted — a card with no ring AND no tone
      // step is not flat, it is missing.
      expect(Number.parseFloat(getComputedStyle(card).borderTopWidth)).toBe(0);
      expect(getComputedStyle(card).boxShadow).toBe("none");
      expect(
        contrast(surface("body", CARD), surface("body")),
      ).toBeGreaterThanOrEqual(1.1);
      expect(radius(CARD)).toBe(length("--radius-card"));
      expect(radius(`${CARD} [data-action="edit"]`)).toBe(length("--radius"));
      // Edge to edge since 2026-10-05: the picture is square-cornered and
      // the card's own rounding clips it, which needs the card to clip.
      expect(radius(`${CARD} [data-preview]`)).toBe(0);
      expect(getComputedStyle(card).overflow).toBe("hidden");
    });

    it("rounds the empty state as a card", () => {
      const { radius } = mount(scheme);
      renderLibrary(node("#root"), { ...MODEL, rows: [] }, noop, new Map());
      expect(radius("[data-empty]")).toBe(length("--radius-card"));
      // The shell's `.empty`, shared with Settings: the glyph beside the
      // title, not above it, and the text left-aligned, not centred.
      const glyph = node("[data-empty] .empty > svg").getBoundingClientRect();
      const title = node("[data-empty] strong").getBoundingClientRect();
      expect(glyph.width).toBe(22);
      expect(glyph.right).toBeLessThanOrEqual(title.left);
      expect(glyph.top).toBeLessThan(title.bottom);
      expect(getComputedStyle(node("[data-empty] strong")).textAlign).not.toBe(
        "center",
      );
    });

    // The card's quiet icon buttons restyle every action's hover, and that
    // rule once matched Delete at the shell's own specificity and won,
    // taking its red away. The production change that reddens it:
    // dropping the card's `.btn-danger` hover rule.
    it("turns Delete red under the pointer, and Edit not", async () => {
      mount(scheme);
      const del = `${CARD} [data-action="delete"]`;
      const edit = `${CARD} [data-action="edit"]`;
      await userEvent.hover(node(del));
      expect(ink(del)).toEqual(token("--error"));
      expect(parse(getComputedStyle(node(del)).backgroundColor)).toEqual(
        token("--error-soft"),
      );
      await userEvent.hover(node(edit));
      expect(ink(edit)).not.toEqual(token("--error"));
      await userEvent.hover(node("h1"));
    });

    it("highlights a card under the pointer", async () => {
      const { surface } = mount(scheme);
      const card = node(CARD);
      const resting = surface("body", CARD);
      await userEvent.hover(card);
      const hovered = surface("body", CARD);
      // Hover was a firmer ring plus a lift until 2026-09-20; flat, it is a
      // tone step. `not.toEqual` is not enough on its own — it passes on a
      // change of one part in 255, which is a highlight nobody can see — so
      // the step is measured as well.
      expect(hovered).not.toEqual(resting);
      expect(contrast(hovered, resting)).toBeGreaterThan(1.05);
      await userEvent.unhover(card);
    });

    it("tones the page notice as an error, and a warn chip as a warning", () => {
      const { surface, ink } = mount(scheme);
      const notice = surface("body", "#notice");
      expect(contrast(ink("#notice"), notice)).toBeGreaterThanOrEqual(4.5);
      expect(notice[0]).toBeGreaterThan(notice[1]);
      const chip = '[data-row="reclaimed"] [data-state-chip]';
      expect(
        contrast(ink(chip), surface("body", '[data-row="reclaimed"]', chip)),
      ).toBeGreaterThanOrEqual(4.5);
    });

    it("flags a take that needs a look on its picture, square and in the warn tone, beside its other tags", async () => {
      const flagged = '[data-row="done"] [data-needs-look]';
      const { surface, ink } = mount(scheme, {
        ...MODEL,
        rows: MODEL.rows.map((r) =>
          r.sceneId === "done" ? { ...r, needsLook: true } : r,
        ),
      });
      const box = node(`${CARD} [data-preview]`).getBoundingClientRect();
      const flag = node(flagged).getBoundingClientRect();
      const glyph = node(`${flagged} svg`).getBoundingClientRect();
      const hosted = node(`${CARD} [data-hosted]`).getBoundingClientRect();
      // The premise: a glyph is painted, at a size a person can see.
      expect(glyph.width).toBeGreaterThanOrEqual(12);
      // On the picture's bottom-left, first in the strip, on the hosted
      // tag's line and as tall as it: one row of tags, not a pill and a dot.
      expect(flag.left).toBeLessThan(box.left + 16);
      expect(flag.bottom).toBeGreaterThan(box.bottom - 16);
      expect(flag.right).toBeLessThan(hosted.left);
      expect(flag.top).toBeCloseTo(hosted.top, 0);
      expect(flag.height).toBeCloseTo(hosted.height, 0);
      expect(flag.width).toBeCloseTo(flag.height, 0);
      // The warn tone: the glyph clears the 3:1 a meaningful icon needs on
      // its own fill, and the fill reads as warm (red over blue).
      const fill = surface("body", CARD, `${CARD} [data-preview]`, flagged);
      expect(contrast(ink(flagged), fill)).toBeGreaterThanOrEqual(3);
      expect(fill[0]).toBeGreaterThan(fill[2]);
      // Visible at rest: the card's own actions wait for the pointer, and a
      // flag that did too would not be "at a glance".
      expect(getComputedStyle(node(flagged)).opacity).toBe("1");
      await page.screenshot({
        path: `__screenshots__/library-needs-look-${scheme}.png`,
        element: node(CARD),
      });
    });

    // Nav tabs and chips were fully round until 2026-09-14; they sit on the
    // same control radius as everything else now.
    it("keeps the tabs and tags on the control radius", () => {
      const { radius } = mount(scheme);
      expect(radius("[data-tabs] a")).toBe(length("--radius"));
      expect(radius(`${CARD} .tag`)).toBe(length("--radius"));
    });

    // The card at rest is a thumbnail, a name, and where and when. The size
    // line and the actions come with the pointer, or with focus anywhere in
    // the card, so the keyboard reaches them too. Opacity is what is read:
    // `visibility` or `display` would take the actions out of the tab order
    // and the layout, and the rects the test below measures with them.
    it("keeps the size line and the actions out of sight until the card is hovered or focused", async () => {
      mount(scheme);
      const card = node(CARD);
      const opacity = (selector: string) =>
        Number.parseFloat(
          getComputedStyle(node(`${CARD} ${selector}`)).opacity,
        );
      expect(opacity(".row-actions"), "actions at rest").toBe(0);
      expect(opacity("[data-size]"), "size at rest").toBe(0);
      // The two sentences share one place: the size replaces the place
      // and time, it does not add a line under them.
      const metaRect = node(`${CARD} .row-meta`).getBoundingClientRect();
      const sizeRect = node(`${CARD} [data-size]`).getBoundingClientRect();
      expect(sizeRect.top).toBe(metaRect.top);
      expect(sizeRect.height).toBe(metaRect.height);
      // What stays: the name, the place, and a state chip.
      expect(opacity("[data-name]")).toBe(1);
      expect(opacity(".row-meta")).toBe(1);
      expect(
        Number.parseFloat(
          getComputedStyle(node('[data-row="reclaimed"] [data-state-chip]'))
            .opacity,
        ),
      ).toBe(1);
      await userEvent.hover(card);
      expect(opacity(".row-actions"), "actions under the pointer").toBe(1);
      expect(opacity("[data-size]"), "size under the pointer").toBe(1);
      expect(opacity(".row-meta"), "place under the pointer").toBe(0);
      // Onto the page title, not `unhover`: that parks the pointer at the
      // body's centre, which at most window sizes is another card.
      await userEvent.hover(node("h1"));
      expect(opacity(".row-actions"), "actions after the pointer left").toBe(0);
      expect(opacity(".row-meta"), "place after the pointer left").toBe(1);
      node(`${CARD} [data-name]`).focus();
      expect(opacity(".row-actions"), "actions with focus in the card").toBe(1);
      (document.activeElement as HTMLElement).blur();
      expect(opacity(".row-actions"), "actions after blur").toBe(0);
    });

    it("heads each section under the page title, legibly and with less weight", () => {
      const { surface, ink } = mount(scheme);
      const head = '[data-section="today"] h2';
      expect(node(head).textContent).toBe("Today");
      expect(contrast(ink(head), surface("body"))).toBeGreaterThanOrEqual(7);
      expect(
        contrast(
          ink('[data-section="today"] [data-section-count]'),
          surface("body"),
        ),
      ).toBeGreaterThanOrEqual(4.5);
      // Between the count beside it and the page title above it. Against
      // the count, not only the title: with the heading's own rule gone
      // the h2 inherits the summary's 12px, which is still under the h1.
      const size = (selector: string) =>
        Number.parseFloat(getComputedStyle(node(selector)).fontSize);
      expect(size(head)).toBeGreaterThan(
        size('[data-section="today"] [data-section-count]'),
      );
      expect(size(head)).toBeLessThan(size("h1"));
      // Settings' section heading since 2026-10-06: Manrope at 20px. Outfit
      // is left to the page title and the dialogs.
      expect(getComputedStyle(node(head)).fontFamily).toMatch(/^"?Manrope/);
      expect(getComputedStyle(node(head)).fontSize).toBe("20px");
      expect(getComputedStyle(node(head)).fontWeight).toBe("700");
      // Settings' chevron, turned a quarter while the section is open. The
      // section renders open, so no transition is in flight to read.
      const chev = node('[data-section="today"] .chev');
      expect(chev.getBoundingClientRect().width).toBe(16);
      expect(getComputedStyle(chev).transform).toMatch(
        /^matrix\([^,]+, 1, -1,/,
      );
      expect(
        getComputedStyle(node('[data-section="today"] summary')).cursor,
      ).toBe("pointer");
    });

    // Settings' shape since 2026-10-08: the title and the jump list in a
    // left column held in view; the list beside it, its first day level
    // with the jump list (the filter row sat there until 2026-10-30). The
    // storage trigger is in the top bar.
    it("holds the title and jump list in a column, the first day level with them", async () => {
      await page.viewport(1280, 900);
      mount(scheme);
      const side = node("[data-header]");
      const title = node("[data-header] h1").getBoundingClientRect();
      const jumps = node("[data-jumps]").getBoundingClientRect();
      const first = node('[data-section="today"]').getBoundingClientRect();
      expect(getComputedStyle(side).position).toBe("sticky");
      expect(jumps.top - title.bottom).toBeCloseTo(28, 0);
      expect(
        Math.abs(first.top - jumps.top),
        `the first day at ${first.top}, the jump list at ${jumps.top}`,
      ).toBeLessThan(1);
      expect(side.getBoundingClientRect().right).toBeLessThanOrEqual(
        first.left,
      );
      expect(side.contains(node('[data-section="today"]'))).toBe(false);
      expect(
        node("[data-storage-trigger]").closest(".topbar"),
        "the storage trigger is not in the top bar",
      ).not.toBeNull();
    });

    it("stacks the column over the list under 1024px", async () => {
      await page.viewport(800, 900);
      mount(scheme);
      const side = node("[data-header]");
      const first = node('[data-section="today"]').getBoundingClientRect();
      expect(getComputedStyle(side).position).toBe("static");
      expect(first.top).toBeGreaterThan(side.getBoundingClientRect().bottom);
      await page.viewport(1280, 900);
    });

    it("runs the thumbnail edge to edge, with the length on its corner", () => {
      const { surface, ink } = mount(scheme);
      const card = node(CARD).getBoundingClientRect();
      const box = node(`${CARD} [data-preview]`).getBoundingClientRect();
      expect(box.left).toBe(card.left);
      expect(box.right).toBe(card.right);
      expect(box.top).toBe(card.top);
      // The preview port fills the badge in; stand in for it here.
      const badge = node(`${CARD} [data-duration]`);
      badge.textContent = "1:24";
      badge.hidden = false;
      const at = badge.getBoundingClientRect();
      expect(at.right).toBeGreaterThan(box.right - 16);
      expect(at.bottom).toBeGreaterThan(box.bottom - 16);
      expect(at.width).toBeGreaterThan(0);
      // The editor clock's face (2026-10-08): Manrope, tabular figures, so
      // a length reads the same on the card and in the editor.
      const face = getComputedStyle(badge);
      expect(face.fontFamily, "the length is not in Manrope").toMatch(
        /^Manrope\b/,
      );
      expect(face.fontVariantNumeric).toBe("tabular-nums");
      expect(
        contrast(
          ink(`${CARD} [data-duration]`),
          surface(
            "body",
            CARD,
            `${CARD} [data-preview]`,
            `${CARD} [data-duration]`,
          ),
        ),
      ).toBeGreaterThanOrEqual(4.5);
      // The chips sit on the opposite corner, clear of the length.
      const chip = node(`${CARD} [data-hosted]`).getBoundingClientRect();
      expect(chip.left).toBeLessThan(box.left + 16);
      expect(chip.bottom).toBeGreaterThan(box.bottom - 16);
      expect(chip.right).toBeLessThan(at.left);
    });

    it("stacks the thumbnail over the text, with the actions at the card's right edge", () => {
      mount(scheme);
      // The whole card opens the editor, and says so with the pointer; the
      // name inside it is a field and says that instead.
      expect(getComputedStyle(node(CARD)).cursor).toBe("pointer");
      expect(getComputedStyle(node(`${CARD} [data-name]`)).cursor).toBe("text");
      const card = node(CARD).getBoundingClientRect();
      const preview = node(`${CARD} [data-preview]`).getBoundingClientRect();
      const title = node(`${CARD} [data-name]`).getBoundingClientRect();
      const edit = node(`${CARD} [data-action="edit"]`).getBoundingClientRect();
      const del = node(
        `${CARD} [data-action="delete"]`,
      ).getBoundingClientRect();
      expect(preview.bottom).toBeLessThanOrEqual(title.top);
      expect(preview.width).toBeGreaterThan(card.width * 0.8);
      expect(del.right).toBeGreaterThan(card.right - 24);
      expect(edit.right).toBeLessThan(del.left);
      expect(edit.left).toBeGreaterThan(card.left + card.width / 2);
      // On the name's own line, not a footer under it.
      const middle = (r: DOMRect) => r.top + r.height / 2;
      expect(Math.abs(middle(edit) - middle(title))).toBeLessThan(2);
      // Square and glyph-sized: a control with no words in it.
      expect(Math.abs(edit.width - edit.height)).toBeLessThan(1);
      expect(node(`${CARD} [data-action="edit"]`).textContent?.trim()).toBe("");
      expect(
        node(`${CARD} [data-action="edit"]`).getAttribute("aria-label"),
      ).toMatch(/^Edit /);
    });
  },
);

describe("the Recordings grid", () => {
  /** How many cards share the first row: distinct left edges among the
   *  cards whose top matches the first card's. */
  const columns = (): number => {
    const cards = [...document.querySelectorAll<HTMLElement>("[data-row]")];
    const first = cards[0]?.getBoundingClientRect();
    if (first === undefined) throw new Error("no cards rendered");
    const lefts = new Set(
      cards
        .map((c) => c.getBoundingClientRect())
        .filter((r) => Math.abs(r.top - first.top) < 1)
        .map((r) => Math.round(r.left)),
    );
    return lefts.size;
  };

  // Five cards, so a four-column row is distinguishable from "everything
  // on one row", and so there is a partial second row to check the
  // alignment of. Cards were centred as a group until 2026-09-14; under a
  // section heading they sit left, on the heading's own edge, and a
  // partial last row keeps its columns — a card under the second column
  // is exactly as wide as the card above it. The production change that
  // reddens this: a fixed column count, the old single-column list, or
  // the centred flex wrap coming back. A column fewer from 1024px since
  // 2026-10-08, when the filters and the jump list took a column of their
  // own at the left; under 1024 that column stacks over the list, so an
  // 800px window keeps its two.
  it.each([
    [800, 2],
    [1120, 2],
    [1440, 3],
  ])(
    "at a %ipx window lays the cards out in %i columns under their heading",
    async (width, want) => {
      await page.viewport(width, 900);
      mount("light");
      expect(columns()).toBe(want);
      // The content box: the page's padding is not the grid's to fill.
      const main = node("#root").getBoundingClientRect();
      // The heading line — chevron and text — is the edge the cards sit on.
      const heading = node(
        '[data-section="today"] summary',
      ).getBoundingClientRect();
      const rects = [...document.querySelectorAll("[data-row]")].map((c) =>
        c.getBoundingClientRect(),
      );
      const first = rects[0];
      if (first === undefined) throw new Error("no cards");
      expect(
        Math.abs(first.left - heading.left),
        "first card on the heading's edge",
      ).toBeLessThan(2);
      expect(first.top, "cards below their heading").toBeGreaterThan(
        heading.bottom,
      );
      // The first row fills the page's width: the last card in it ends at
      // the page's right edge, so no column's worth of space is left over.
      const row = rects.filter((r) => Math.abs(r.top - first.top) < 1);
      expect(
        Math.abs(Math.max(...row.map((r) => r.right)) - main.right),
        "first row reaches the right edge",
      ).toBeLessThan(2);
      // The partial last row sits under the first column, at the same width.
      const last = rects.filter((r) => r.top > first.top + 1);
      expect(last.length, "a partial second row to measure").toBeGreaterThan(0);
      const lastFirst = last.reduce((a, b) => (b.left < a.left ? b : a));
      expect(
        Math.abs(lastFirst.left - first.left),
        "last row under the first column",
      ).toBeLessThan(2);
      expect(
        Math.abs(lastFirst.width - first.width),
        "last row at the column's width",
      ).toBeLessThan(2);
      // And the page block itself is centred in a window wider than its cap.
      if (width > 1300) {
        const block = node(".page").getBoundingClientRect();
        const left = block.left;
        const right = window.innerWidth - block.right;
        expect(
          Math.abs(left - right),
          `page gutters ${left} vs ${right}`,
        ).toBeLessThan(2);
        // (1440 - 1280) / 2: the cap's own gutter. Flush left is 0.
        expect(block.left).toBeGreaterThanOrEqual(80);
      }
    },
  );

  // The build moves the shell's <link> to the END of the head, after the
  // page's inline <style>. Mounted that way round, the shell's
  // `body { margin: 0 }` used to beat the page's `margin: 0 auto` and its
  // 13px font beat the page's 14px — the page shipped flush left while
  // every test here, mounting shell-first, stayed green (2026-09-14). The
  // shell now sits in a cascade layer; this mounts BOTH orders and asks
  // for the same picture. The production change that reddens it: taking
  // the `@layer shell` wrapper off assets/shell.css.
  it.each(["source", "build"] as const)(
    "paints the same with the sheets in %s order",
    async (order) => {
      await page.viewport(1440, 900);
      mountShell("light", css, order);
      document.body.innerHTML = bodyHtml;
      renderLibrary(node("#root"), MODEL, noop, new Map());
      const block = node(".page").getBoundingClientRect();
      const left = block.left;
      const right = window.innerWidth - block.right;
      expect(
        Math.abs(left - right),
        `page gutters in ${order} order: ${left} vs ${right}`,
      ).toBeLessThan(2);
      expect(
        block.left,
        `left gutter in ${order} order`,
      ).toBeGreaterThanOrEqual(80);
      expect(getComputedStyle(node("body")).fontSize).toBe("14px");
    },
  );

  // A past month starts folded. Its summary is a line below Today's last
  // card, nothing inside it is painted, and opening it puts its cards
  // below the summary rather than over anything. Checked at a short
  // window as well, where the editor's preview once painted over the
  // timeline while every rect reported a clean gap.
  it.each([900, 600])(
    "folds a past month under the open sections at a %ipx-tall window",
    async (height) => {
      await page.viewport(1120, height);
      mount("light", {
        ...MODEL,
        rows: [
          ...MODEL.rows,
          {
            ...base,
            sceneId: "july",
            createdAt: "2026-07-05T12:00:00Z",
            when: "Jul 5, 11:02 AM",
            time: "11:02 AM",
          },
        ],
      });
      const july = node(
        '[data-section^="month:2026-07"]',
      ) as HTMLDetailsElement;
      expect(july.open).toBe(false);
      const summary = july.querySelector("summary") as HTMLElement;
      // Below the fold at the short window: bring it up before hit-testing,
      // since elementFromPoint knows nothing outside the viewport. Every
      // rect below is read after the scroll, so they move together.
      summary.scrollIntoView({ block: "center" });
      const todayCards = [
        ...document.querySelectorAll('[data-section="today"] [data-row]'),
      ].map((c) => c.getBoundingClientRect());
      const line = summary.getBoundingClientRect();
      expect(
        line.top,
        "the month line below Today's cards",
      ).toBeGreaterThanOrEqual(Math.max(...todayCards.map((r) => r.bottom)));
      expect(line.height).toBeGreaterThan(0);
      // `checkVisibility`, not the rect: Chrome lays a closed fold's content
      // out under `content-visibility: hidden`, so the card still reports a
      // height while nothing of it is painted or reachable.
      const card = node('[data-row="july"]');
      expect(card.checkVisibility(), "a folded card is not visible").toBe(
        false,
      );
      // Nothing of the folded card is under the pointer at the summary's
      // line: what is hit there is the summary itself.
      const hit = document.elementFromPoint(
        line.left + 10,
        line.top + line.height / 2,
      );
      expect(
        summary.contains(hit),
        `hit ${hit?.tagName ?? "nothing"} at the month line`,
      ).toBe(true);
      july.open = true;
      expect(card.checkVisibility(), "an opened card is visible").toBe(true);
      const opened = card.getBoundingClientRect();
      expect(opened.height).toBeGreaterThan(0);
      expect(opened.top).toBeGreaterThanOrEqual(
        summary.getBoundingClientRect().bottom,
      );
      expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(
        document.documentElement.clientWidth,
      );
    },
  );

  // The page paints a thumbnail when its card comes near the viewport,
  // through an IntersectionObserver (library/main.ts). A card inside a
  // closed fold has a rect — Chrome lays it out under
  // `content-visibility: hidden` — and this asks the observer the page
  // uses, with the page's own margin, to say it is NOT intersecting there,
  // and IS once the fold opens. Without the second half an opened month
  // would sit on its "Loading" boxes forever, and no rect would say so.
  it("reports a folded card as out of view, and in view once its month opens", async () => {
    await page.viewport(1120, 900);
    mount("light", {
      ...MODEL,
      rows: [
        ...MODEL.rows,
        { ...base, sceneId: "july", createdAt: "2026-07-05T12:00:00Z" },
      ],
    });
    const july = node('[data-section^="month:2026-07"]') as HTMLDetailsElement;
    july.querySelector("summary")?.scrollIntoView({ block: "center" });
    const box = node('[data-row="july"] [data-preview]');
    const seen: boolean[] = [];
    const observer = new IntersectionObserver(
      (entries) => {
        for (const e of entries) seen.push(e.isIntersecting);
      },
      { rootMargin: "200px" },
    );
    observer.observe(box);
    await expect.poll(() => seen.length, { timeout: 2000 }).toBe(1);
    expect(seen[0], "folded: the first report").toBe(false);
    july.open = true;
    await expect.poll(() => seen.length, { timeout: 2000 }).toBe(2);
    expect(seen[1], "opened: the second report").toBe(true);
    observer.disconnect();
  });

  // 280 as well as 400: a grid track cannot shrink below its minimum, so
  // a bare 270px minimum put a card past the right edge of any viewport
  // narrower than 294px (24px of page padding plus the track) while 400
  // stayed green; at 300 the card still fit, 6px inside the edge, so 300
  // proved nothing. The production change that reddens this:
  // `minmax(270px, 1fr)` without the `min(…, 100%)` guard. Measured on
  // the cards rather than the document below 400: the shell's nav tabs
  // overflow a narrow window on their own (measured 2026-09-14, 373px for
  // a 300px window), which is the shell's to fix, not this page's, and a
  // document-wide check would report it as the grid's.
  it.each([400, 280])(
    "drops to one column at a %ipx window, with every card inside it",
    async (width) => {
      await page.viewport(width, 900);
      mount("light");
      expect(columns()).toBe(1);
      const edge = document.documentElement.clientWidth;
      for (const card of document.querySelectorAll("[data-row]")) {
        const r = card.getBoundingClientRect();
        expect(
          r.right,
          `${card.getAttribute("data-row")} right`,
        ).toBeLessThanOrEqual(edge);
        expect(
          r.left,
          `${card.getAttribute("data-row")} left`,
        ).toBeGreaterThanOrEqual(0);
      }
      if (width >= 400) {
        expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(edge);
      }
    },
  );
});

describe("the Recordings page's type", () => {
  it("resolves the shell's faces from the extension's own files", async () => {
    mount("light");
    const manrope = await document.fonts.load('500 14px "Manrope"');
    const outfit = await document.fonts.load('500 28px "Outfit"');
    expect(manrope.map((f) => f.status)).toEqual(["loaded"]);
    expect(outfit.map((f) => f.status)).toEqual(["loaded"]);
    expect(getComputedStyle(node("body")).fontFamily).toMatch(/Manrope/);
    expect(getComputedStyle(node("h1")).fontFamily).toMatch(/Outfit/);
    expect(node("h1").textContent).toBe("Recordings");
  });
});

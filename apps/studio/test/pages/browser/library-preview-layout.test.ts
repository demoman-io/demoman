import { afterEach, describe, expect, it } from "vitest";
import pageHtml from "../../../pages/entrypoints/library/index.html?raw";
import type { LibraryActions } from "../../../pages/src/library/view";
import { renderLibrary } from "../../../pages/src/library/view";
import { mountShell, pageParts, parse } from "../helpers/shell-css";

const FIXTURE_MADE = "2026-09-01T00:00:00Z";

/**
 * The page's OWN stylesheets, lifted out of the entrypoint it ships in:
 * the shell it links and the rules it keeps inline.
 *
 * Pasting the rules into this file would assert that a copy of the CSS
 * works — the copy the extension loads could drift from it without a single
 * test going red.
 */
const { css } = pageParts(pageHtml, "[data-preview]");

const model = {
  usedBytes: 1,
  budgetBytes: 10,
  fraction: 0.1,
  chromeNearLimit: false,
  migrating: false,
  migrationFailed: false,
  notice: null,
  rows: [
    {
      sceneId: "s-1",
      name: "A demo with a fairly long name that has to wrap somewhere",
      label: "A demo with a fairly long name that has to wrap somewhere",
      origin: "app.test",
      path: "/a/fairly/long/path/that/has/to/be/clipped/somewhere/too",
      createdAt: FIXTURE_MADE,
      when: "Sep 13, 2:15 PM",
      time: "2:15 PM",
      hosted: true,
      recoverable: false,
      frameBytes: 1,
      outputBytes: 0,
      state: "Complete" as const,
      canRestore: true,
      authored: false,
      servesReshoot: false,
      needsLook: false,
    },
  ],
};

const actions: LibraryActions = {
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

let mounted: HTMLElement[] = [];

function mountPage(
  width: string,
  scheme: "light" | "dark" = "light",
): {
  box: HTMLElement;
  article: HTMLElement;
} {
  mountShell(scheme, css);
  const root = document.createElement("main");
  root.style.width = width;
  document.body.append(root);
  mounted.push(root);
  // The clock the sections are measured from, beside the fixture's own
  // date: a take from a past month renders inside a folded section, where
  // no pointer reaches it and nothing of it is painted, and this test is
  // about the thumbnail, not the fold.
  renderLibrary(root, model, actions, new Map(), new Date(FIXTURE_MADE));
  return {
    box: root.querySelector("[data-preview]") as HTMLElement,
    article: root.querySelector("article") as HTMLElement,
  };
}

afterEach(() => {
  for (const node of mounted) node.remove();
  mounted = [];
});

describe("library preview layout", () => {
  for (const scheme of ["light", "dark"] as const) {
    it(`paints no mat around the picture in ${scheme}`, () => {
      // Since 2026-10-05 the thumbnail is the bare image: a letterboxed
      // keyframe's bars are the card's colour, not a grey of the box's own,
      // and no hairline divides the picture from the text below it.
      const { box } = mountPage("720px", scheme);
      const style = getComputedStyle(box);
      expect(
        parse(style.backgroundColor)[3],
        `the preview box paints its own surface (${style.backgroundColor}) in ${scheme}`,
      ).toBe(0);
      expect(
        Number.parseFloat(style.borderBottomWidth),
        `the preview box draws a ${style.borderBottomWidth} rule under it in ${scheme}`,
      ).toBe(0);
    });
  }

  it("keeps the note inside the box while the canvas is hidden", () => {
    // At mount the canvas is `hidden` and the note says "Loading preview…".
    // The canvas rule sets `display: block`, which beats the UA's `[hidden]`
    // rule, so without its own `[hidden]` rule the canvas kept its width and
    // pushed the note out of the box — visible in a screenshot, invisible
    // to every other assertion here.
    const { box } = mountPage("720px");
    const note = box.querySelector("[data-preview-note]") as HTMLElement;
    const canvas = box.querySelector("[data-preview-canvas]") as HTMLElement;
    expect(canvas.hidden).toBe(true);
    expect(getComputedStyle(canvas).display).toBe("none");
    const boxRect = box.getBoundingClientRect();
    const noteRect = note.getBoundingClientRect();
    expect(
      noteRect.left,
      `the note (left ${noteRect.left}) starts before its box (left ${boxRect.left})`,
    ).toBeGreaterThanOrEqual(boxRect.left);
    expect(
      noteRect.right,
      `the note (right ${noteRect.right}) runs past its box (right ${boxRect.right})`,
    ).toBeLessThanOrEqual(boxRect.right);
  });

  for (const width of ["720px", "360px"] as const) {
    it(`sits above the row's text, filling the card's width, at ${width}`, () => {
      const { box, article } = mountPage(width);
      const text = article.querySelector(".row-text") as HTMLElement;
      const boxRect = box.getBoundingClientRect();
      const textRect = text.getBoundingClientRect();
      const cardRect = article.getBoundingClientRect();
      expect(
        textRect.top,
        `the text (top ${textRect.top}) did not start below the preview (bottom ${boxRect.bottom})`,
      ).toBeGreaterThanOrEqual(boxRect.bottom);
      // The thumbnail is the card's picture, so it takes the whole inner
      // width; a 200px box in a 340px card is the old row layout leaking.
      expect(
        boxRect.width,
        `the preview (${boxRect.width}px) does not fill its card (${cardRect.width}px)`,
      ).toBeGreaterThan(cardRect.width * 0.8);
      // And the grid rows line up: the box is 16:9 whatever the card width.
      expect(boxRect.width / boxRect.height).toBeCloseTo(16 / 9, 1);
      expect(
        article.scrollWidth,
        `the card overflows: content ${article.scrollWidth}px in a ${article.clientWidth}px card`,
      ).toBeLessThanOrEqual(article.clientWidth);
    });
  }

  it("clips a long host and path to one line rather than wrapping it", () => {
    const { article } = mountPage("360px");
    const meta = article.querySelector(".row-meta") as HTMLElement;
    const line = Number.parseFloat(getComputedStyle(meta).lineHeight);
    expect(meta.getBoundingClientRect().height).toBeLessThan(line * 1.5);
    expect(meta.scrollWidth).toBeGreaterThan(meta.clientWidth);
    // The full line survives in the title, for a pointer.
    expect(meta.title).toBe(`app.test${model.rows[0]?.path ?? ""}`);
  });
});

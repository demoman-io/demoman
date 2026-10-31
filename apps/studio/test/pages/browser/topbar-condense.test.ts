// apps/studio/test/pages/browser/topbar-condense.test.ts
import { page } from "@vitest/browser/context";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import library from "../../../pages/entrypoints/library/index.html?raw";
import settings from "../../../pages/entrypoints/settings/index.html?raw";
import type { LibraryModel } from "../../../pages/src/library/state";
import { renderLibrary } from "../../../pages/src/library/view";
import { mountShell, node, pageParts } from "../helpers/shell-css";

/**
 * The top bar condenses and never wraps (2026-10-08). It used to wrap its
 * right end under its left when the two did not fit, which read as broken
 * in a header. Now one ladder, the same on every tabbed page and sized for
 * Recordings (the widest right end), gives room back step by step:
 *
 *   under 900px  Recordings' storage trigger drops its words
 *   under 760px  the wordmark goes
 *   under 560px  the tabs keep their glyphs and lose their words
 *
 * The invariant is asserted across a sweep, not at a few chosen widths, so
 * a step that fires too late shows up wherever it overflows.
 */

const MODEL: LibraryModel = {
  usedBytes: 1.4 * 1024 ** 3,
  budgetBytes: 2 * 1024 ** 3,
  fraction: 0.7,
  chromeNearLimit: false,
  migrating: false,
  migrationFailed: false,
  notice: null,
  rows: [],
};

/** Every right-end piece a page can carry: the widest bar that page can
 *  draw. (The account menu was the extension's; archived 2026-10-20.) */
async function mount(name: "library" | "settings") {
  const [html, carries] =
    name === "library"
      ? [library, ".storage-panel"]
      : [settings, "[data-section"];
  const parts = pageParts(html, carries);
  mountShell("light", parts.css, "build");
  document.body.innerHTML = parts.body;
  if (name === "library") {
    renderLibrary(
      node("#root"),
      MODEL,
      {
        reclaim() {},
        setBudget() {},
        edit() {},
        restore() {},
        backToRecording() {},
        remove() {},
        preview() {},
      } as never,
      new Map(),
      new Date(2026, 9, 8, 12),
    );
  }
}

const shown = (el: Element) =>
  getComputedStyle(el).display !== "none" &&
  el.getBoundingClientRect().width > 1;

/** What a reader of the bar sees at this width, in words. */
function readout() {
  const word = node(".logomark-word");
  return {
    wordmark: shown(word),
    tabWords: [...document.querySelectorAll(".tab-label")].map(shown),
    storageWords: document.querySelector(".storage-label")
      ? shown(node(".storage-label"))
      : null,
  };
}

const PAGES = ["library", "settings"] as const;

afterEach(() => {
  for (const open of document.querySelectorAll<HTMLElement>(":popover-open"))
    open.hidePopover();
});

afterAll(async () => {
  await page.viewport(414, 896);
});

describe("the top bar never wraps", () => {
  // From a wide desktop window down to a phone, every 20px, plus each
  // step's edges on both sides.
  const WIDTHS = [
    ...Array.from({ length: 55 }, (_, i) => 1440 - i * 20),
    899,
    900,
    759,
    760,
    559,
    560,
    360,
  ];

  it.each(PAGES)(
    "%s: one 64px line, nothing past the window, at every width",
    async (name) => {
      await page.viewport(1440, 800);
      await mount(name);
      // The premise: the bar carries everything it can at full width, or a
      // sweep of an emptier bar would pass for the wrong reason.
      expect(readout(), "full width").toEqual({
        wordmark: true,
        tabWords: [true, true],
        storageWords: name === "library" ? true : null,
      });

      const failures: string[] = [];
      for (const width of WIDTHS) {
        await page.viewport(width, 800);
        const inner = node(".topbar-inner");
        const bar = node(".topbar").getBoundingClientRect();
        const pad = Number.parseFloat(getComputedStyle(inner).paddingRight);
        const edge = inner.getBoundingClientRect().right - pad;
        const right = node(".topbar-actions").getBoundingClientRect().right;
        const tabs = node("[data-tabs]").getBoundingClientRect();
        const actions = node(".topbar-actions").getBoundingClientRect();
        const why = [
          bar.height !== 64 && `bar ${bar.height}px tall`,
          inner.scrollWidth > inner.clientWidth &&
            `bar content ${inner.scrollWidth} in ${inner.clientWidth}`,
          document.documentElement.scrollWidth > width &&
            `page ${document.documentElement.scrollWidth} wide`,
          right > edge + 0.5 && `actions end at ${right}, edge ${edge}`,
          tabs.right > actions.left &&
            `tabs end at ${tabs.right}, actions start ${actions.left}`,
        ].filter(Boolean);
        if (why.length > 0)
          failures.push(
            `${width}px: ${why.join("; ")} ${JSON.stringify(readout())}`,
          );
      }
      expect(failures, failures.join("\n")).toEqual([]);
    },
  );
});

describe("the ladder", () => {
  it.each([
    [
      1000,
      {
        wordmark: true,
        tabWords: true,
        storageWords: true,
      },
    ],
    [
      820,
      {
        wordmark: true,
        tabWords: true,
        storageWords: false,
      },
    ],
    [
      680,
      {
        wordmark: false,
        tabWords: true,
        storageWords: false,
      },
    ],
    [
      420,
      {
        wordmark: false,
        tabWords: false,
        storageWords: false,
      },
    ],
  ] as const)(
    "at %ipx, gives back what that step gives back",
    async (width, want) => {
      await page.viewport(width, 800);
      const spots: string[] = [];
      for (const name of PAGES) {
        await mount(name);
        const r = readout();
        expect(
          {
            wordmark: r.wordmark,
            tabWords: r.tabWords,
          },
          name,
        ).toEqual({
          wordmark: want.wordmark,
          tabWords: [want.tabWords, want.tabWords],
        });
        if (name === "library")
          expect(r.storageWords, "storage words").toBe(want.storageWords);
        // A tab without its word still says it: to a screen reader through
        // the hidden word, and under the pointer through its title.
        for (const tab of document.querySelectorAll<HTMLAnchorElement>(
          "[data-tabs] a",
        )) {
          expect(tab.textContent?.trim()).toMatch(/^(Flows|Settings)$/);
          expect(tab.title).toBe(tab.textContent?.trim());
        }
        const mark = node(".logomark").getBoundingClientRect();
        const tabs = node("[data-tabs]").getBoundingClientRect();
        spots.push(
          [mark.left, mark.width, tabs.left, tabs.width]
            .map(Math.round)
            .join(","),
        );
      }
      // One ladder for every page: the mark and the tabs do not move
      // between tabs at any step.
      expect(new Set(spots).size, spots.join(" | ")).toBe(1);
    },
  );
});

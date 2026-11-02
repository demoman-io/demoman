import { page } from "@vitest/browser/context";
import { afterAll, describe, expect, it } from "vitest";
// The page's own markup and rules, the studio's sheet the build links
// beside them, and the real view: the row measured is the one the studio
// paints.
import studioCss from "../../../pages/assets/studio.css?raw";
import shell from "../../../pages/entrypoints/library/index.html?raw";
import type { Rail } from "../../../pages/src/library/projects";
import type { LibraryModel } from "../../../pages/src/library/state";
import { renderLibrary } from "../../../pages/src/library/view";
import { mountShell, node, pageParts } from "../helpers/shell-css";

/**
 * A phone's tab row with three-digit counts on every tab (spec 2026-11-02
 * search-narrow, review 1): the tabs scroll inside their strip, the
 * pressed one in view, and the row never runs past the list's end.
 */

const { css, body } = pageParts(shell, "article.card:hover");

const RAIL: Rail = { all: 579, projects: [], none: 0, unreadable: 0 };
const COUNTS = { inRepo: 123, notInRepo: 456, all: 579 };

const MODEL: LibraryModel = {
  usedBytes: 0,
  budgetBytes: 4 * 1024 ** 3,
  fraction: 0,
  chromeNearLimit: false,
  migrating: false,
  migrationFailed: false,
  notice: null,
  rows: [
    {
      sceneId: "one",
      name: "",
      label: "localhost:4000/checkout",
      origin: "localhost:4000",
      path: "/checkout",
      createdAt: "2026-09-13T14:15:03Z",
      when: "Sep 13, 2:15 PM",
      time: "2:15 PM",
      hosted: true,
      recoverable: false,
      frameBytes: 1024,
      outputBytes: 1024,
      state: "Complete",
      canRestore: false,
      authored: false,
      servesReshoot: false,
      needsLook: false,
    },
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
  setView: noop,
  goTab: noop,
  search: noop,
};

/** The page as the studio serves it, at All with every count three digits. */
function mount() {
  mountShell("dark", `${css}\n${studioCss}`);
  document.documentElement.setAttribute("data-studio", "");
  document.body.innerHTML = body;
  renderLibrary(
    node("#root"),
    MODEL,
    ACTIONS,
    new Map(),
    new Date(2026, 8, 13, 20),
    undefined,
    undefined,
    {
      layout: "list",
      sort: { column: "recorded", descending: true },
      project: null,
    },
    {
      place: "all",
      tab: "all",
      rail: RAIL,
      tabs: COUNTS,
      search: { query: "", sort: null, elsewhere: [] },
    },
  );
}

const rect = (e: Element) => e.getBoundingClientRect();
const pills = () => [
  ...document.querySelectorAll<HTMLElement>(".place-tabs [data-tab]"),
];

afterAll(async () => {
  await page.viewport(414, 896);
});

describe("a phone's tab row with three-digit counts", () => {
  for (const width of [390, 360]) {
    // Red: the strip with no sideways scroll (the toggle pushed past the
    // list's end), the pressed tab left out of view, or the tabs' labels
    // free to wrap (`white-space: nowrap` off).
    it(`at ${width}px the tabs scroll in their strip, the pressed one in view, and nothing runs past the row`, async () => {
      await page.viewport(width, 640);
      mount();
      const strip = node(".place-tabs");
      const row = rect(node("[data-tabs-row]"));
      const toggle = rect(node("[data-layout-toggle]"));
      const pressed = node('.place-tabs [aria-pressed="true"]');
      const said = JSON.stringify({
        row,
        strip: [rect(strip).left, rect(strip).right, strip.scrollLeft],
        scroll: [strip.scrollWidth, strip.clientWidth],
        pills: pills().map((p) => [
          p.textContent,
          rect(p).left,
          rect(p).top,
          rect(p).right,
        ]),
        toggle: [toggle.left, toggle.right],
      });
      // Premises: every count three digits, All pressed, and the tabs
      // wider than their strip.
      expect(
        pills().map((p) => p.querySelector(".side-count")?.textContent),
        said,
      ).toEqual(["123", "456", "579"]);
      expect(pressed.dataset.tab, said).toBe("all");
      expect(strip.scrollWidth, said).toBeGreaterThan(strip.clientWidth);
      const html = document.documentElement;
      expect(html.scrollWidth, said).toBeLessThanOrEqual(html.clientWidth);
      expect(toggle.right, said).toBeLessThanOrEqual(row.right + 0.5);
      expect(new Set(pills().map((p) => rect(p).top)).size, said).toBe(1);
      for (const p of pills()) {
        const label = document.createRange();
        label.selectNodeContents(p.firstChild as Text);
        expect(label.getClientRects().length, `${p.textContent} ${said}`).toBe(
          1,
        );
      }
      // The pressed tab whole inside the strip, and its count painted.
      const s = rect(strip);
      const t = rect(pressed);
      expect(t.left, said).toBeGreaterThanOrEqual(s.left - 0.5);
      expect(t.right, said).toBeLessThanOrEqual(s.right + 0.5);
      const count = pressed.querySelector(".side-count") as HTMLElement;
      const c = rect(count);
      const hit = document.elementFromPoint(
        c.left + c.width / 2,
        c.top + c.height / 2,
      );
      expect(hit === null ? null : pressed.contains(hit), said).toBe(true);
      await page.screenshot({
        path: `__screenshots__/library-tab-row/counts-${width}.png`,
      });
    });
  }
});

import { page } from "@vitest/browser/context";
import { afterAll, describe, expect, it } from "vitest";
import shell from "../../../pages/entrypoints/library/index.html?raw";
import type {
  LibraryModel,
  LibraryRow,
} from "../../../pages/src/library/state";
import { renderLibrary } from "../../../pages/src/library/view";
import { mountShell, node, pageParts } from "../helpers/shell-css";

/**
 * The Recordings page as it is painted, for a person to look at.
 *
 * The design pass of 2026-10-06 held this page to Settings: its section
 * heading, its chevron, its empty state, its rhythm under the title. Each
 * of those is asserted in `library-shell.test.ts`; this file exists for
 * what no assertion tells apart — a glyph that is the wrong shape, a
 * heading that crowds its cards, a page that reads unevenly — and writes
 * every state in both themes, at a laptop and a phone width, to
 * `__screenshots__/library/`. The thumbnails are painted stand-ins: the
 * real ones come off IndexedDB through the preview port, which this lane
 * does not run.
 */

const { css, body: bodyHtml } = pageParts(shell, "article.card:hover");

// A Tuesday evening, so the fixture spans Today, Yesterday, a dated day
// of the last week and a folded past month.
const NOW = new Date(2026, 9, 6, 18);
const at = (m: number, d: number, h: number, min = 0): Date =>
  new Date(2026, m - 1, d, h, min);

function take(
  sceneId: string,
  made: Date,
  over: Partial<LibraryRow> = {},
): LibraryRow {
  return {
    sceneId,
    name: sceneId,
    label: sceneId,
    origin: "localhost:4000",
    path: "/checkout",
    createdAt: made.toISOString(),
    when: made.toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    }),
    time: made.toLocaleTimeString(undefined, {
      hour: "numeric",
      minute: "2-digit",
    }),
    hosted: false,
    recoverable: false,
    frameBytes: 38 * 1024 ** 2,
    outputBytes: 6 * 1024 ** 2,
    state: "Complete",
    canRestore: false,
    authored: false,
    servesReshoot: false,
    needsLook: false,
    ...over,
  };
}

const ROWS: LibraryRow[] = [
  take("Checkout with a saved card", at(10, 6, 14, 14), { hosted: true }),
  take("Invite a teammate", at(10, 6, 11, 5), { path: "/settings/team" }),
  take("", at(10, 6, 9, 40), {
    label: "app.northwind.dev/orders",
    origin: "app.northwind.dev",
    path: "/orders",
  }),
  take("Onboarding: connect Stripe", at(10, 5, 16, 31), {
    hosted: true,
    path: "/onboarding",
  }),
  take("Export a CSV report", at(10, 2, 15, 48), {
    path: "/reports",
    state: "Motion reclaimed",
    canRestore: true,
    frameBytes: 2 * 1024 ** 2,
  }),
  take("Dark mode toggle", at(10, 2, 9, 20), {
    path: "/settings/appearance",
    state: "Keyframes only",
  }),
  take("Search the order history", at(8, 21, 10, 12), {
    origin: "app.northwind.dev",
    path: "/orders",
  }),
  take("Refund a payment", at(8, 14, 13, 2), { path: "/payments" }),
];

const MODEL: LibraryModel = {
  usedBytes: 1.42 * 1024 ** 3,
  budgetBytes: 2 * 1024 ** 3,
  fraction: 0.71,
  chromeNearLimit: false,
  migrating: false,
  migrationFailed: false,
  notice: null,
  rows: ROWS,
};

const noop = {
  reclaim() {},
  setBudget() {},
  edit() {},
  restore() {},
  backToRecording() {},
  remove() {},
  preview() {},
  filter() {},
  rename() {},
  openReview() {},
};

// One stand-in page per card, so the grid reads as a library of
// different recordings rather than eight copies of one.
const PALETTES = [
  ["#f8fafc", "#4f46e5"],
  ["#ffffff", "#6366f1"],
  ["#0b1120", "#22d3ee"],
  ["#eef2ff", "#635bff"],
  ["#ffffff", "#16a34a"],
  ["#18181b", "#a78bfa"],
  ["#fafaf9", "#f59e0b"],
  ["#f1f5f9", "#0f766e"],
];

function paintThumbnails(): number {
  const boxes = [...document.querySelectorAll<HTMLElement>("[data-preview]")];
  boxes.forEach((box, i) => {
    const canvas = box.querySelector("canvas") as HTMLCanvasElement;
    const [ground, accent] = PALETTES[i % PALETTES.length] as [string, string];
    canvas.width = 640;
    canvas.height = 360;
    const g = canvas.getContext("2d") as CanvasRenderingContext2D;
    g.fillStyle = ground;
    g.fillRect(0, 0, 640, 360);
    g.fillStyle = "#0f172a";
    g.fillRect(0, 0, 640, 36);
    g.fillStyle = "rgba(100,116,139,0.35)";
    for (let row = 0; row < 5; row++) g.fillRect(48, 80 + row * 40, 360, 12);
    g.fillStyle = accent;
    g.fillRect(48, 290, 140, 30);
    canvas.hidden = false;
    const note = box.querySelector("[data-preview-note]") as HTMLElement;
    note.textContent = "";
    const badge = box.querySelector("[data-duration]") as HTMLElement;
    badge.textContent = `0:${String(12 + i * 7).padStart(2, "0")}`;
    badge.hidden = false;
  });
  return boxes.length;
}

const VIEWPORTS = [
  { name: "laptop", width: 1280, height: 1500 },
  { name: "phone", width: 414, height: 896 },
] as const;

afterAll(async () => {
  await page.viewport(414, 896);
});

describe("the Recordings page, painted", () => {
  for (const scheme of ["light", "dark"] as const) {
    for (const viewport of VIEWPORTS) {
      it(`draws a full library in ${scheme} at ${viewport.name}`, async () => {
        await page.viewport(viewport.width, viewport.height);
        mountShell(scheme, css);
        document.body.innerHTML = bodyHtml;
        renderLibrary(node("#root"), MODEL, noop, new Map(), undefined, NOW);
        // The premise the picture is for: every kind of heading the page
        // has, each with its chevron, and every card painted.
        const heads = [...document.querySelectorAll("[data-section] h2")].map(
          (h) => h.textContent,
        );
        expect(heads).toHaveLength(4);
        expect(heads.slice(0, 2)).toEqual(["Today", "Yesterday"]);
        expect(heads[2]).toMatch(/2/);
        expect(document.querySelectorAll("[data-section] .chev")).toHaveLength(
          4,
        );
        // Every card, the folded month's too: a closed section still holds
        // its cards, it only hides them.
        expect(paintThumbnails()).toBe(ROWS.length);
        await page.screenshot({
          path: `__screenshots__/library/full-${scheme}-${viewport.name}.png`,
        });
      });
    }

    it(`draws an empty library in ${scheme}`, async () => {
      await page.viewport(1280, 800);
      mountShell(scheme, css);
      document.body.innerHTML = bodyHtml;
      renderLibrary(
        node("#root"),
        { ...MODEL, usedBytes: 0, fraction: 0, rows: [] },
        noop,
        new Map(),
        undefined,
        NOW,
      );
      expect(document.querySelector("[data-empty] .empty svg")).not.toBeNull();
      await page.screenshot({
        path: `__screenshots__/library/empty-${scheme}.png`,
      });
    });

    it(`draws a filter that matches nothing in ${scheme}`, async () => {
      await page.viewport(1280, 800);
      mountShell(scheme, css);
      document.body.innerHTML = bodyHtml;
      renderLibrary(
        node("#root"),
        MODEL,
        noop,
        new Map(),
        { host: "gone.test", state: null },
        NOW,
      );
      expect(
        document.querySelector("[data-empty-filtered] .empty svg"),
      ).not.toBeNull();
      await page.screenshot({
        path: `__screenshots__/library/no-match-${scheme}.png`,
      });
    });
  }
});

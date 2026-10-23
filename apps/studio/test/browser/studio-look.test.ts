import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Page } from "playwright";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  distance,
  hairlineAt,
  LIME,
  limeOutsideItsPlaces,
  luma,
  pixelsAt,
  type Rgb,
} from "./look-probes.js";
import type { PlainTake } from "./painted-take.js";
import {
  api,
  pageEvidence,
  type Studio,
  settled,
  sizeWindow,
  startStudio,
  watchConsole,
} from "./studio-harness.js";
import {
  DAY_TWO,
  openPage,
  type PageName,
  painted,
  seedHome,
} from "./studio-pages.js";

// The studio's look (spec docs/superpowers/specs/2026-10-19-studio-design-
// system-design.md), asserted on the real built pages in a real window and
// on their painted result. One `describe` per part of the plan
// (docs/superpowers/plans/2026-10-19-studio-design-system.md).
//
// darwin only, as the screenshot set is: the library's thumbnails come from
// `sips`, and `openPage` waits for every card's picture.

const LANE_MS = 120_000;
const BG: Rgb = [10, 10, 10];

let running: Studio | null = null;
const homes: string[] = [];

afterEach(async () => {
  const studio = running;
  running = null;
  try {
    if (studio !== null) await studio.stop();
  } finally {
    for (const home of homes.splice(0)) {
      await rm(home, { recursive: true, force: true });
    }
  }
});

/** A seeded studio with its window open at `width`×`height`. */
async function openStudio(
  width = 1440,
  height = 900,
  settings?: Record<string, unknown>,
  extra: PlainTake[] = [],
): Promise<{
  studio: Studio;
  page: Page;
  editorTake: string;
  console_: ReturnType<typeof watchConsole>;
  open: (name: PageName) => Promise<void>;
}> {
  const home = await mkdtemp(join(tmpdir(), "studio-look-"));
  homes.push(home);
  const { editorTake } = await seedHome(home, extra);
  if (settings !== undefined) {
    await writeFile(join(home, "settings.json"), JSON.stringify(settings));
  }
  const studio = await startStudio(home, join(home, "out"));
  running = studio;
  const opened = await api(studio, "/api/window", { method: "POST", body: {} });
  expect(opened.status, `${opened.text}\n${studio.logs.join("\n")}`).toBe(200);
  const context = studio.context();
  const page = context.pages()[0] as Page;
  const console_ = watchConsole(page);
  await sizeWindow(context, page, width, height);
  const thumbs = new Set<string>();
  return {
    studio,
    page,
    editorTake,
    console_,
    open: (name) =>
      openPage(page, studio, name, editorTake, thumbs, 4 + extra.length),
  };
}

const PATHS = (editorTake: string): Record<PageName, string> => ({
  library: "/",
  kits: "/settings.html",
  editor: `/editor.html?scene=${editorTake}`,
});

describe("the studio marker", () => {
  it.runIf(process.platform === "darwin")(
    "marks every page from its first byte and paints it in Geist on the near-black",
    async () => {
      const { studio, page, editorTake, open } = await openStudio();
      for (const name of ["library", "kits", "editor"] as const) {
        const url = `${studio.origin}${PATHS(editorTake)[name]}`;
        const served = await (await page.request.get(url)).text();
        expect(served, `${name} as served`).toMatch(
          /<html[^>]*\bdata-studio\b[^>]*\bdata-theme="dark"/,
        );
        // `openPage` waits until the page's pictures are painted: four
        // cards' previews, the kit hero, the editor's preview.
        await open(name);
        // Faces load when asked for: `load` fetches the face and answers
        // with what it found, so an empty answer is a face the page lacks.
        const fonts = await page.evaluate(async () => ({
          sans: (await document.fonts.load('13px "Geist"')).length > 0,
          mono: (await document.fonts.load('12px "Geist Mono"')).length > 0,
          body: getComputedStyle(document.body).fontFamily,
          height: innerHeight,
        }));
        expect(fonts.sans, `${name}: Geist loaded`).toBe(true);
        expect(fonts.mono, `${name}: Geist Mono loaded`).toBe(true);
        expect(fonts.body, name).toMatch(/^"?Geist"?,/);
        const [corner] = await pixelsAt(page, [[2, fonts.height - 2]]);
        expect(
          distance(corner as Rgb, BG),
          `${name}: the ground paints ${JSON.stringify(corner)}; ${await pageEvidence(page)}`,
        ).toBeLessThanOrEqual(2);
      }
    },
    LANE_MS,
  );
});

/** At least this much lighter than both sides: a painted hairline. White 8%
 *  over the near-black is about 19 levels of luma. */
const LINE_STEP = 6;

describe("header and frame", () => {
  // Spec §4, §5.1. Red: drop the figure's display rule (it stays `hidden`),
  // set --line to transparent, or give the topbar back its 64px.
  it.runIf(process.platform === "darwin")(
    "draws the bare figure, a 56px header over a hairline, the two rails and the jump list's current row",
    async () => {
      const { page, open } = await openStudio(1440, 900);
      const xs: number[] = [];
      for (const name of ["library", "kits"] as const) {
        await open(name);
        const g = await page.evaluate(() => {
          const rect = (sel: string) => {
            const el = document.querySelector<HTMLElement>(sel);
            if (el === null) return null;
            const r = el.getBoundingClientRect();
            return {
              left: r.left,
              right: r.right,
              top: r.top,
              bottom: r.bottom,
              width: r.width,
              height: r.height,
              display: getComputedStyle(el).display,
            };
          };
          return {
            figure: rect(".logomark .figure"),
            disc: rect(".logomark .disc"),
            word: rect(".logomark .logomark-word"),
            topbar: rect(".topbar"),
            page: rect(".page"),
            current: rect(
              '[data-jumps] [aria-current="true"], .section-nav a[aria-current="true"]',
            ),
          };
        });
        const said = `${name}: ${JSON.stringify(g)}`;
        // The premise: every part the probes below sample is on the page.
        expect(g.figure, said).not.toBeNull();
        expect(g.topbar, said).not.toBeNull();
        expect(g.page, said).not.toBeNull();
        expect(g.current, said).not.toBeNull();
        const figure = g.figure as NonNullable<typeof g.figure>;
        const topbar = g.topbar as NonNullable<typeof g.topbar>;
        const frame = g.page as NonNullable<typeof g.page>;
        const current = g.current as NonNullable<typeof g.current>;

        expect(figure.display, said).not.toBe("none");
        expect(Math.abs(figure.height - 20), said).toBeLessThanOrEqual(1);
        expect(g.disc?.display, said).toBe("none");
        expect(g.word?.display, said).toBe("none");
        const [ink] = await pixelsAt(page, [
          [figure.left + figure.width / 2, figure.top + figure.height * 0.5],
        ]);
        expect(
          distance(ink as Rgb, [244, 244, 245]),
          `${said}; the figure paints ${JSON.stringify(ink)}`,
        ).toBeLessThanOrEqual(8);
        xs.push(figure.left);

        expect(topbar.height, said).toBe(56);
        const under = await hairlineAt(
          page,
          frame.left + 200,
          topbar.bottom - 0.5,
          "h",
        );
        expect(
          under.line - Math.max(under.before, under.after),
          `${said}; under the header ${JSON.stringify(under)}`,
        ).toBeGreaterThanOrEqual(LINE_STEP);
        for (const x of [frame.left + 0.5, frame.right - 0.5]) {
          const rail = await hairlineAt(page, x, 600, "v");
          expect(
            rail.line - Math.max(rail.before, rail.after),
            `${said}; the rail at x ${x}: ${JSON.stringify(rail)}`,
          ).toBeGreaterThanOrEqual(LINE_STEP);
        }
        const [row] = await pixelsAt(page, [
          [current.left + 4, current.top + current.height / 2],
        ]);
        expect(
          luma(row as Rgb) - luma(BG),
          `${said}; the current row paints ${JSON.stringify(row)}`,
        ).toBeGreaterThanOrEqual(LINE_STEP);
      }
      expect(Math.abs((xs[0] as number) - (xs[1] as number))).toBeLessThan(0.5);
    },
    LANE_MS,
  );
});

describe("controls", () => {
  // Spec §3.5, §3.6. Red: put Export or the focus ring back on --accent,
  // give a segment its 6px corner back, or let a box-shadow ring cover the
  // focus outline.
  it.runIf(process.platform === "darwin")(
    "pills every button and segment, paints Export in ink, keeps lime to its places, and rings focus in white",
    async () => {
      const { page, open } = await openStudio(1440, 900);
      for (const name of ["kits", "library", "editor"] as const) {
        await open(name);
        const corners = await page.evaluate(() =>
          [
            ...document.querySelectorAll<HTMLElement>(
              ".btn:not(.btn-icon), .segmented .segment",
            ),
          ]
            .filter((el) => el.getClientRects().length > 0)
            .map((el) => ({
              what: `${el.className} "${(el.textContent ?? "").trim().slice(0, 20)}"`,
              radius: Number.parseFloat(
                getComputedStyle(el).borderTopLeftRadius,
              ),
              height: el.getBoundingClientRect().height,
            })),
        );
        // The premise: Settings and the editor have buttons to measure (the
        // library's cards carry icon buttons only).
        if (name !== "library") expect(corners.length, name).toBeGreaterThan(0);
        const square = corners.filter((c) => c.radius < c.height / 2 - 0.5);
        expect(square, `${name}: buttons that are not pills`).toEqual([]);
        expect(await limeOutsideItsPlaces(page), `${name}: lime`).toEqual([]);
      }

      // Export, filled in ink with a dark label (the editor is open).
      const exp = await page.evaluate(() => {
        const r = (
          document.getElementById("export-open") as HTMLElement
        ).getBoundingClientRect();
        return { x: r.left + 6, y: r.top + r.height / 2 };
      });
      const [fill] = await pixelsAt(page, [[exp.x, exp.y]]);
      expect(
        distance(fill as Rgb, [244, 244, 245]),
        `Export paints ${JSON.stringify(fill)}`,
      ).toBeLessThanOrEqual(8);

      // Focus, by keyboard, on a Pull requests segment: the white outline
      // paints just outside it.
      await open("kits");
      const target = '[aria-label="Pull requests"] [role="radio"]';
      let focused = false;
      for (let i = 0; i < 80 && !focused; i++) {
        await page.keyboard.press("Tab");
        focused = await page.evaluate(
          (sel) => document.activeElement?.matches(sel) ?? false,
          target,
        );
      }
      expect(focused, "Tab reached a Pull requests segment").toBe(true);
      // Settings scrolls smoothly; bring the segment to the middle at once,
      // so the rect is the one the screenshot paints.
      const ring = await page.evaluate(() => {
        (document.activeElement as HTMLElement).scrollIntoView({
          block: "center",
          behavior: "instant",
        });
        const r = (
          document.activeElement as HTMLElement
        ).getBoundingClientRect();
        const el = document.activeElement as HTMLElement;
        const cs = getComputedStyle(el);
        return {
          x: r.left + r.width / 2,
          y: r.top - 3,
          evidence: {
            visible: el.matches(":focus-visible"),
            outline: cs.outline,
            offset: cs.outlineOffset,
            top: r.top,
            text: el.textContent,
          },
        };
      });
      const [outline] = await pixelsAt(page, [[ring.x, ring.y]]);
      expect(
        distance(outline as Rgb, [244, 244, 245]),
        `the focus ring paints ${JSON.stringify(outline)}; ${JSON.stringify(ring)}`,
      ).toBeLessThanOrEqual(16);
    },
    LANE_MS,
  );
});

/** A take named past any card's width (Review Focus 5). */
const LONG_NAME: PlainTake = {
  id: "take-long-name",
  name: "Create an invoice for Hollis & Grant, then filter the overdue ones, export the list and send the reminder",
  createdAt: DAY_TWO,
  ground: "#e0e7ff",
};

describe("library", () => {
  // Spec §5.2. Red: drop the card's ring, give the thumbnail its square
  // corners back, or let the group heading's rule stop at its words.
  it.runIf(process.platform === "darwin")(
    "frames each card, rules each group to the column's edge, sets data in mono, and clips a long name",
    async () => {
      const { page, open } = await openStudio(1440, 900, undefined, [
        LONG_NAME,
      ]);
      await open("library");
      // The premise, asserted: the seeded cards, the unreadable row, groups.
      expect(LONG_NAME.name.length).toBeGreaterThan(100);
      const g = await page.evaluate(() => {
        const cards = [
          ...document.querySelectorAll<HTMLElement>(
            "article.card:not([data-unreadable-row])",
          ),
        ];
        const box = (el: Element) => {
          const r = el.getBoundingClientRect();
          return { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
        };
        const content = document.querySelector(
          ".library-content",
        ) as HTMLElement;
        const cs = getComputedStyle(content);
        const long = [
          ...document.querySelectorAll<HTMLInputElement>("[data-name]"),
        ].find((i) => i.value.length > 100);
        const unread = document.querySelector("[data-unreadable-row]");
        const head = document.querySelector(".section-head") as HTMLElement;
        const headTitle = head.querySelector("h2") as HTMLElement;
        return {
          cards: cards.map((c) => ({
            ...box(c),
            radius: getComputedStyle(c).borderTopLeftRadius,
            thumb: getComputedStyle(
              c.querySelector("[data-preview]") as HTMLElement,
            ).borderTopLeftRadius,
            duration: getComputedStyle(
              c.querySelector("[data-duration]") as HTMLElement,
            ).fontFamily,
          })),
          groups: document.querySelectorAll(".section-head").length,
          contentRight: box(content).right - Number.parseFloat(cs.paddingRight),
          head: { ...box(head), mid: box(head).top + head.offsetHeight / 2 },
          headFont: getComputedStyle(headTitle).fontFamily,
          headCase: getComputedStyle(headTitle).textTransform,
          long:
            long === undefined
              ? null
              : {
                  clipped: long.scrollWidth > long.clientWidth,
                  ellipsis: getComputedStyle(long).textOverflow,
                  card: box(long.closest("article") as Element),
                },
          unread:
            unread === null
              ? null
              : {
                  font: getComputedStyle(
                    unread.querySelector(
                      "[data-unreadable-name]",
                    ) as HTMLElement,
                  ).fontFamily,
                  remove: getComputedStyle(
                    unread.querySelector(
                      '[data-action="delete"]',
                    ) as HTMLElement,
                  ).color,
                },
          scroll: document.scrollingElement?.scrollWidth ?? 0,
          width: innerWidth,
        };
      });
      const said = JSON.stringify(g);
      expect(g.cards.length, said).toBe(5);
      expect(g.groups, said).toBeGreaterThanOrEqual(2);
      expect(g.long, said).not.toBeNull();
      expect(g.unread, said).not.toBeNull();

      for (const c of g.cards) {
        expect(c.radius, said).toBe("12px");
        expect(c.thumb, said).toBe("8px");
        expect(c.duration, said).toMatch(/^"?Geist Mono"?/);
      }
      for (const c of g.cards.filter((c) => c.bottom < 880).slice(0, 3)) {
        const ring = await hairlineAt(page, c.left + 0.5, c.bottom - 30, "v");
        expect(
          ring.line - Math.max(ring.before, ring.after),
          `a card's ring at ${c.left}: ${JSON.stringify(ring)}`,
        ).toBeGreaterThanOrEqual(LINE_STEP);
      }
      expect(g.headFont, said).toMatch(/^"?Geist Mono"?/);
      expect(g.headCase, said).toBe("uppercase");
      const rule = await hairlineAt(page, g.contentRight - 6, g.head.mid, "h");
      expect(
        rule.line - Math.max(rule.before, rule.after),
        `the group rule near the column's edge: ${JSON.stringify(rule)}`,
      ).toBeGreaterThanOrEqual(LINE_STEP);

      const long = g.long as NonNullable<typeof g.long>;
      expect(long.clipped, said).toBe(true);
      expect(long.ellipsis, said).toBe("ellipsis");
      const widths = new Set(g.cards.map((c) => Math.round(c.right - c.left)));
      expect(widths.size, `card widths ${[...widths].join(", ")}`).toBe(1);

      const unread = g.unread as NonNullable<typeof g.unread>;
      expect(unread.font, said).toMatch(/^"?Geist Mono"?/);
      expect(unread.remove, said).toBe("rgb(248, 113, 113)");

      await sizeWindow(page.context(), page, 1280, 720);
      const narrow = await page.evaluate(() => ({
        scroll: document.scrollingElement?.scrollWidth ?? 0,
        width: innerWidth,
      }));
      expect(narrow.scroll, JSON.stringify(narrow)).toBeLessThanOrEqual(
        narrow.width,
      );
    },
    LANE_MS,
  );
});

describe("settings", () => {
  // Spec §5.5. Red: give the kit tiles their 132px back, drop the hairline
  // between the control groups, or set the group labels in sans again.
  it.runIf(process.platform === "darwin")(
    "draws the kit strip, stars the default in lime, and divides Background, Frame and Logo by hairlines",
    async () => {
      const { page, open } = await openStudio(1440, 900);
      await open("kits");
      const g = await page.evaluate(() => {
        const box = (el: Element) => {
          const r = el.getBoundingClientRect();
          return { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
        };
        const stars = [...document.querySelectorAll(".kit-star")].map((s) => ({
          ...box(s),
          pressed: s.getAttribute("aria-pressed"),
        }));
        const groups = [
          ...document.querySelectorAll(".kit-controls .branding-group"),
        ].map((el) => {
          const title = el.querySelector(".branding-group-title");
          return {
            ...box(el),
            font: title === null ? null : getComputedStyle(title).fontFamily,
            upper:
              title === null ? null : getComputedStyle(title).textTransform,
          };
        });
        const chosen = document.querySelector('.kit-pick[aria-pressed="true"]');
        const fresh = document.querySelector(".kit-new .kit-pick, .kit-new");
        return {
          tiles: [...document.querySelectorAll(".kit-tile")].map(
            (t) => t.getBoundingClientRect().width,
          ),
          stars,
          groups,
          chosen: chosen === null ? null : box(chosen),
          freshBorder:
            fresh === null ? null : getComputedStyle(fresh).borderTopStyle,
        };
      });
      const said = JSON.stringify(g);
      // The premise: two kits (one the default), New kit, three groups.
      expect(g.stars.length, said).toBe(2);
      expect(g.stars.filter((s) => s.pressed === "true").length, said).toBe(1);
      expect(g.groups.length, said).toBe(3);
      expect(g.chosen, said).not.toBeNull();

      for (const w of g.tiles) expect(Math.round(w), said).toBe(148);
      // Duplicate and Delete as small ghost pills, Delete in danger.
      expect(
        await page
          .locator("[data-kit-delete]")
          .evaluate((e) => getComputedStyle(e).color),
      ).toBe("rgb(248, 113, 113)");
      expect(g.freshBorder, said).toBe("dashed");
      const centres = await pixelsAt(
        page,
        g.stars.map((s) => [(s.left + s.right) / 2, (s.top + s.bottom) / 2]),
      );
      g.stars.forEach((s, i) => {
        const d = distance(centres[i] as Rgb, LIME);
        if (s.pressed === "true") {
          expect(
            d,
            `the default star paints ${JSON.stringify(centres[i])}`,
          ).toBeLessThanOrEqual(24);
        } else {
          expect(
            d,
            `another star paints ${JSON.stringify(centres[i])}`,
          ).toBeGreaterThan(60);
        }
      });
      const chosen = g.chosen as NonNullable<typeof g.chosen>;
      const [ring] = await pixelsAt(page, [
        // An inset ring since the review (the outline is the focus ring's).
        [chosen.left + 0.5, (chosen.top + chosen.bottom) / 2],
      ]);
      expect(
        distance(ring as Rgb, [244, 244, 245]),
        `the chosen kit's ring paints ${JSON.stringify(ring)}`,
      ).toBeLessThanOrEqual(40);

      for (const grp of g.groups) {
        expect(grp.font, said).toMatch(/^"?Geist Mono"?/);
        expect(grp.upper, said).toBe("uppercase");
      }
      const [a, b, c] = g.groups as [
        (typeof g.groups)[number],
        (typeof g.groups)[number],
        (typeof g.groups)[number],
      ];
      for (const right of [b, c]) {
        const y = Math.min(right.top + 30, 880);
        const line = await hairlineAt(page, right.left + 0.5, y, "v");
        expect(
          line.line - Math.max(line.before, line.after),
          `the hairline at the left of a group (x ${right.left}): ${JSON.stringify(line)} ${said}`,
        ).toBeGreaterThanOrEqual(LINE_STEP);
      }
      expect(a.top, said).toBeLessThan(900);
    },
    LANE_MS,
  );
});

/** The editor's parts, as laid out. */
function editorParts(page: Page) {
  return page.evaluate(() => {
    const box = (sel: string) => {
      const el = document.querySelector<HTMLElement>(sel);
      if (el === null || el.getClientRects().length === 0) return null;
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      // A closed inspector keeps its box, hidden (`visibility`), as its
      // column collapses: not drawn is not there.
      if (cs.visibility === "hidden" || r.width < 1) return null;
      return {
        left: r.left,
        right: r.right,
        top: r.top,
        bottom: r.bottom,
        width: r.width,
        height: r.height,
        radius: cs.borderTopLeftRadius,
        shadow: cs.boxShadow,
      };
    };
    return {
      header: box("body > header"),
      cards: [...document.querySelectorAll("header .head-card")].map((c) => {
        const cs = getComputedStyle(c);
        return { radius: cs.borderTopLeftRadius, shadow: cs.boxShadow };
      }),
      main: box("main"),
      rail: box("#rail"),
      aside: box("aside:has(.inspector)"),
      dock: box("#dock"),
      exportOpen: box("#export-open"),
      width: innerWidth,
      height: innerHeight,
    };
  });
}

type Box = { left: number; right: number; top: number; bottom: number };
const overlap = (a: Box, b: Box): boolean =>
  a.left < b.right - 1 &&
  b.left < a.right - 1 &&
  a.top < b.bottom - 1 &&
  b.top < a.bottom - 1;

async function lineStep(
  page: Page,
  x: number,
  y: number,
  axis: "h" | "v",
): Promise<number> {
  const l = await hairlineAt(page, x, y, axis);
  // Beside bright picture (the film fills a stacked stage to its edge) no
  // hairline reads lighter than the film; measure it against the dark side.
  if (Math.max(l.before, l.after) > 60) {
    return l.line - Math.min(l.before, l.after);
  }
  return l.line - Math.max(l.before, l.after);
}

describe("editor layout", () => {
  // Spec §5.3, direction B. Red: give the cards their float back (--seam,
  // --float), drop a hairline, or let the stage paint over the dock.
  it.runIf(process.platform === "darwin")(
    "is one surface divided by hairlines, the rail between the preview and the inspector",
    async () => {
      const { page, open } = await openStudio(1440, 900);
      await open("editor");
      const p = await editorParts(page);
      const said = JSON.stringify(p);
      // The premise: every part is laid out, the inspector open.
      for (const k of ["header", "main", "rail", "aside", "dock"] as const) {
        expect(p[k], `${k}: ${said}`).not.toBeNull();
      }
      const header = p.header as Box & { height: number };
      const main = p.main as Box;
      const rail = p.rail as Box & { width: number };
      const aside = p.aside as Box;
      const dock = p.dock as Box;

      expect(Math.round(header.height), said).toBe(52);
      expect(
        await lineStep(page, 600, header.bottom - 0.5, "h"),
        said,
      ).toBeGreaterThanOrEqual(LINE_STEP);
      expect(Math.abs(rail.left - main.right), said).toBeLessThanOrEqual(1);
      expect(Math.abs(aside.left - rail.right), said).toBeLessThanOrEqual(1);
      expect(Math.round(rail.width), said).toBe(52);
      // Sampled in the well's letterbox (the film is width-bound here, so
      // its top 18px are well): a hairline beside the white film cannot read
      // lighter than the film.
      for (const x of [rail.left + 0.5, aside.left + 0.5]) {
        expect(
          await lineStep(page, x, main.top + 6, "v"),
          `x ${x}: ${said}`,
        ).toBeGreaterThanOrEqual(LINE_STEP);
      }
      expect(
        await lineStep(page, 4, dock.top + 0.5, "h"),
        said,
      ).toBeGreaterThanOrEqual(LINE_STEP);
      for (const k of ["rail", "aside", "dock"] as const) {
        expect(p[k]?.radius, `${k}: ${said}`).toBe("0px");
        expect(p[k]?.shadow, `${k}: ${said}`).toBe("none");
      }
      for (const c of p.cards) {
        expect(c.radius, said).toBe("0px");
        expect(c.shadow, said).toBe("none");
      }
      const [well] = await pixelsAt(page, [[main.left + 4, main.top + 4]]);
      expect(
        distance(well as Rgb, [7, 7, 7]),
        `the preview's well paints ${JSON.stringify(well)}`,
      ).toBeLessThanOrEqual(2);

      // A long name clips; Export stays on screen.
      await page.evaluate((name) => {
        (document.getElementById("name") as HTMLInputElement).value = name;
      }, LONG_NAME.name);
      const named = await page.evaluate(() => {
        const n = document.getElementById("name") as HTMLInputElement;
        const e = (
          document.getElementById("export-open") as HTMLElement
        ).getBoundingClientRect();
        return {
          clipped: n.scrollWidth > n.clientWidth,
          ellipsis: getComputedStyle(n).textOverflow,
          export: { left: e.left, right: e.right, top: e.top },
          width: innerWidth,
        };
      });
      expect(named.clipped, JSON.stringify(named)).toBe(true);
      expect(named.ellipsis, JSON.stringify(named)).toBe("ellipsis");
      expect(named.export.right, JSON.stringify(named)).toBeLessThanOrEqual(
        named.width,
      );
      expect(named.export.top, JSON.stringify(named)).toBeLessThan(52);

      // Closing the inspector: the rail goes to the window's edge, and no
      // hairline is left standing where the inspector began.
      const before = aside.left;
      await page.locator(".inspector-close").first().click();
      await vi.waitFor(
        async () => {
          const now = await editorParts(page);
          if (now.aside !== null)
            throw new Error(`still open: ${JSON.stringify(now.aside)}`);
          if (Math.abs((now.rail?.right ?? 0) - now.width) > 1) {
            throw new Error(
              `the rail ends at ${now.rail?.right} of ${now.width}`,
            );
          }
        },
        { timeout: 5_000, interval: 50 },
      );
      await settled(page);
      const after = await editorParts(page);
      if (before < (after.rail?.left ?? 0) - 2) {
        expect(
          await lineStep(page, before + 0.5, main.top + 6, "v"),
          `a line left at the inspector's old edge: ${JSON.stringify(after)}`,
        ).toBeLessThan(LINE_STEP);
      }
    },
    LANE_MS,
  );

  it.runIf(process.platform === "darwin")(
    "keeps the dock clear of the stage under 900px tall, and stacks narrow windows with a hairline at each part",
    async () => {
      const { page, open } = await openStudio(1280, 720);
      await open("editor");
      const p = await painted(page);
      expect(p.dockBand, JSON.stringify(p)).not.toBeNull();
      for (const hit of p.dockBand as string[]) {
        expect(hit, JSON.stringify(p.dockBand)).toMatch(/: dock$/);
      }
      // The same band, by decoded pixels: the dock's top hairline painted
      // at five x positions across the stage, where a stage painting over
      // the timeline would cover it.
      const short = await editorParts(page);
      const stage = short.main as Box;
      for (const f of [0.1, 0.3, 0.5, 0.7, 0.9]) {
        const x = stage.left + (stage.right - stage.left) * f;
        expect(
          await lineStep(page, x, (short.dock as Box).top + 0.5, "h"),
          `the dock's hairline at x ${Math.round(x)}; ${JSON.stringify(short)}`,
        ).toBeGreaterThanOrEqual(LINE_STEP);
      }

      for (const [w, h] of [
        [900, 800],
        [600, 800],
      ] as const) {
        await sizeWindow(page.context(), page, w, h);
        await settled(page);
        const s = await editorParts(page);
        const said = `${w}x${h}: ${JSON.stringify(s)}`;
        const parts = (["header", "main", "rail", "dock", "aside"] as const)
          .map((k) => [k, s[k]] as const)
          .filter(
            (e): e is readonly [(typeof e)[0], NonNullable<(typeof e)[1]>] =>
              e[1] !== null,
          );
        expect(parts.length, said).toBeGreaterThanOrEqual(4);
        for (let i = 0; i < parts.length; i++) {
          for (let j = i + 1; j < parts.length; j++) {
            const [a, ra] = parts[i] as (typeof parts)[number];
            const [b, rb] = parts[j] as (typeof parts)[number];
            expect(overlap(ra, rb), `${a} and ${b} overlap; ${said}`).toBe(
              false,
            );
          }
        }
        // The premise the case's name claims: the inspector stacked under
        // the dock, not beside it.
        if (s.aside !== null) {
          expect(
            s.aside.top,
            `the inspector under the dock; ${said}`,
          ).toBeGreaterThanOrEqual((s.dock as Box).bottom - 1);
        }
        for (const [k, r] of parts) {
          // The header carries its own hairline under it (asserted above);
          // the preview's top edge is that line, and the rail is a column.
          if (k === "header" || k === "main" || k === "rail" || r.top <= 1) {
            continue;
          }
          if (r.top + 0.5 > s.height) continue;
          expect(
            await lineStep(
              page,
              r.left + Math.min(40, r.width / 2),
              r.top + 0.5,
              "h",
            ),
            `${k}'s top hairline; ${said}`,
          ).toBeGreaterThanOrEqual(LINE_STEP);
        }
      }

      // Under 615px with the panel closed: the page's other stacked
      // template (the open panel above is the 951px one again).
      await page.locator(".inspector-close").first().click();
      await vi.waitFor(
        async () => {
          const now = await editorParts(page);
          if (now.aside !== null) throw new Error("the inspector is open");
        },
        { timeout: 5_000, interval: 50 },
      );
      const closed = await editorParts(page);
      const closedSaid = `600x800 closed: ${JSON.stringify(closed)}`;
      const shown = (["header", "main", "rail", "dock"] as const).map(
        (k) => [k, closed[k]] as const,
      );
      for (const [k, r] of shown)
        expect(r, `${k}; ${closedSaid}`).not.toBeNull();
      for (let i = 0; i < shown.length; i++) {
        for (let j = i + 1; j < shown.length; j++) {
          const [a, ra] = shown[i] as (typeof shown)[number];
          const [b, rb] = shown[j] as (typeof shown)[number];
          expect(
            overlap(ra as Box, rb as Box),
            `${a} and ${b}; ${closedSaid}`,
          ).toBe(false);
        }
      }
      const closedDock = closed.dock as Box;
      expect(
        await lineStep(page, closedDock.left + 40, closedDock.top + 0.5, "h"),
        `the dock's hairline; ${closedSaid}`,
      ).toBeGreaterThanOrEqual(LINE_STEP);
      expect(
        await page.evaluate(() => document.scrollingElement?.scrollWidth ?? 0),
        closedSaid,
      ).toBeLessThanOrEqual(closed.width);
    },
    LANE_MS,
  );
});

/** `rgba` composited over `base`. */
const over = (
  base: Rgb,
  [r, g, b, a]: [number, number, number, number],
): Rgb => [
  base[0] * (1 - a) + r * a,
  base[1] * (1 - a) + g * a,
  base[2] * (1 - a) + b * a,
];

/** Spec §5.4: "between 1 and 2", the author's pick. */
const LANES = {
  clip: {
    fill: [130, 185, 70, 0.3],
    glyph: "rgb(156, 204, 92)",
  },
  zoom: {
    fill: [150, 125, 235, 0.3],
    glyph: "rgb(181, 159, 255)",
  },
  mask: {
    fill: [225, 110, 95, 0.3],
    glyph: "rgb(251, 142, 124)",
  },
} as const;

/** Each lane under the pointer: the same hue, the fill stronger. */
const HOVERED = {
  clip: { fill: [130, 185, 70, 0.45] },
  zoom: { fill: [150, 125, 235, 0.45] },
  mask: { fill: [225, 110, 95, 0.45] },
} as const;

describe("timeline", () => {
  // Spec §5.3, §5.4. Red: put the lanes back on today's solid fills, give a
  // block back its ring in the hue (gone 2026-10-19, the author), or put the
  // playhead back on lime (or anything but ink).
  it.runIf(process.platform === "darwin")(
    "paints each lane in its hue, flat, draws a white playhead and no lime",
    async () => {
      const { page, open } = await openStudio(1440, 900);
      await open("editor");
      // The premise: a mask, added the way the author adds one (a click on
      // the Mask lane), beside the take's own clip and zoom.
      await page
        .locator('.lane[data-lane="mask"] .track')
        .click({ position: { x: 600, y: 15 } });
      await vi.waitFor(
        async () => {
          const n = await page
            .locator('.lane[data-lane="mask"] .seg:not([data-ghost])')
            .count();
          if (n === 0) throw new Error(`no mask: ${await pageEvidence(page)}`);
        },
        { timeout: 5_000, interval: 50 },
      );
      await page.mouse.move(5, 5);
      await settled(page);
      const t = await page.evaluate(() => {
        const box = (el: Element | null) => {
          if (el === null) return null;
          const r = el.getBoundingClientRect();
          return { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
        };
        const lane = (k: string) => {
          const seg = document.querySelector(
            `.lane[data-lane="${k}"] .seg:not([data-ghost])`,
          );
          const track = document.querySelector(
            `.lane[data-lane="${k}"] .track`,
          );
          const glyph = document.querySelector(
            `.lane[data-lane="${k}"] .lane-head svg`,
          );
          return {
            seg: box(seg),
            track: box(track),
            glyph: glyph === null ? null : getComputedStyle(glyph).color,
          };
        };
        const play = document.querySelector("#transport [data-transport-play]");
        const tick = document.querySelector(".ruler .tick");
        const clock = document.querySelector("#toolbar-clock .stage-clock");
        return {
          clip: lane("clip"),
          zoom: lane("zoom"),
          mask: lane("mask"),
          playhead: box(document.querySelector(".playhead")),
          ruler: box(document.querySelector(".ruler")),
          dock: box(document.getElementById("dock")),
          play: box(play),
          tick: tick === null ? null : getComputedStyle(tick).fontFamily,
          clock: clock === null ? null : getComputedStyle(clock).fontFamily,
          zoomFont: (() => {
            const z = document.querySelector('[data-lane="zoom"] .seg');
            return z === null ? null : getComputedStyle(z).fontFamily;
          })(),
        };
      });
      const said = JSON.stringify(t);
      for (const k of ["clip", "zoom", "mask"] as const) {
        expect(t[k].seg, `${k}: ${said}`).not.toBeNull();
      }
      expect(t.playhead, said).not.toBeNull();
      expect(t.play, said).not.toBeNull();

      // The ground under a segment: the dock, then the track's fill.
      const track = over([10, 10, 10], [255, 255, 255, 0.03]);
      for (const k of ["clip", "zoom", "mask"] as const) {
        const seg = t[k].seg as Box;
        const lane = LANES[k];
        const [fill, edge] = await pixelsAt(page, [
          [seg.left + (seg.right - seg.left) / 2, seg.top + 5],
          // The top edge: the left one is where the playhead rests at 0:00.
          [seg.left + (seg.right - seg.left) / 2, seg.top + 0.5],
        ]);
        const want = over(
          track,
          lane.fill as unknown as [number, number, number, number],
        );
        expect(
          distance(fill as Rgb, want),
          `${k} fills ${JSON.stringify(fill)}, want ${JSON.stringify(want.map(Math.round))}`,
        ).toBeLessThanOrEqual(8);
        // Flat: the top edge paints the fill over the track's own hairline
        // (8% white, which shows through the translucent block), and no
        // ring in the hue on top of that.
        const edgeWant = over(
          over(track, [255, 255, 255, 0.08]),
          lane.fill as unknown as [number, number, number, number],
        );
        expect(
          distance(edge as Rgb, edgeWant),
          `${k}'s edge paints ${JSON.stringify(edge)}, want the fill over the hairline ${JSON.stringify(edgeWant.map(Math.round))}`,
        ).toBeLessThanOrEqual(8);
        expect(t[k].glyph, `${k}'s glyph`).toBe(lane.glyph);
      }

      const ph = t.playhead as Box;
      const ruler = t.ruler as Box;
      const [line] = await pixelsAt(page, [
        [(ph.left + ph.right) / 2, ruler.bottom + 3],
      ]);
      expect(
        distance(line as Rgb, [244, 244, 245]),
        `the playhead paints ${JSON.stringify(line)}`,
      ).toBeLessThanOrEqual(12);
      const dock = t.dock as Box;
      const lime = (await limeOutsideItsPlaces(page)).filter((s) => {
        const [x, y] = (s.split(" ")[0] as string).split(",").map(Number) as [
          number,
          number,
        ];
        return (
          x >= dock.left && x <= dock.right && y >= dock.top && y <= dock.bottom
        );
      });
      expect(lime, "lime in the timeline").toEqual([]);

      const play = t.play as Box;
      expect(Math.round(play.right - play.left), said).toBe(36);
      const [disc] = await pixelsAt(page, [
        [play.left + 5, (play.top + play.bottom) / 2],
      ]);
      expect(
        distance(disc as Rgb, [244, 244, 245]),
        `Play paints ${JSON.stringify(disc)}`,
      ).toBeLessThanOrEqual(12);

      // The glyph reads on the white disc, paused and playing. Red: let the
      // studio's active-transport ink reach Play (the pause bars went white
      // on white, found by the author 2026-10-19).
      const glyphInk = async () => {
        const g = await page
          .locator("#transport [data-transport-play] svg")
          .evaluate((e) => {
            const r = e.getBoundingClientRect();
            return { left: r.left, top: r.top, w: r.width, h: r.height };
          });
        const points: Array<[number, number]> = [];
        for (let i = 1; i < 16; i++) {
          for (let j = 1; j < 16; j++) {
            points.push([g.left + (g.w * i) / 16, g.top + (g.h * j) / 16]);
          }
        }
        const painted = await pixelsAt(page, points);
        return Math.min(...painted.map((c) => luma(c as Rgb)));
      };
      const playButton = page.locator("#transport [data-transport-play]");
      expect(await glyphInk(), "the paused glyph's darkest pixel").toBeLessThan(
        60,
      );
      await playButton.click();
      await page.mouse.move(5, 5);
      await vi.waitFor(
        async () => {
          if ((await playButton.getAttribute("data-active")) === null) {
            throw new Error(`not playing: ${await pageEvidence(page)}`);
          }
        },
        { timeout: 5_000, interval: 20 },
      );
      // Its colour transitions; sample where it settles, not on the way.
      await vi.waitFor(
        async () => {
          const running = await playButton.evaluate(
            (e) => e.getAnimations({ subtree: true }).length,
          );
          if (running > 0) throw new Error(`${running} transitions running`);
        },
        { timeout: 2_000, interval: 20 },
      );
      const playingInk = await glyphInk();
      // The premise: still playing when the screenshot was taken.
      expect(
        await playButton.getAttribute("data-active"),
        "still playing after the sample",
      ).not.toBeNull();
      expect(
        playingInk,
        `the pause glyph's darkest pixel; colour ${await playButton.evaluate((e) => getComputedStyle(e).color)}`,
      ).toBeLessThan(60);
      // The page's face, not mono (the author, 2026-10-22).
      expect(t.tick, said).toMatch(/^"?Geist"?,/);
      expect(t.clock, said).toMatch(/^"?Geist"?,/);
      expect(t.zoomFont, said).toMatch(/^"?Geist"?,/);

      // Hover: the author asked for the lane's colour, brighter. Red: drop
      // the `.seg:hover` rule, or hover to another hue.
      for (const k of ["clip", "zoom", "mask"] as const) {
        const seg = t[k].seg as Box;
        const x = seg.left + (seg.right - seg.left) / 2;
        await page.mouse.move(x, (seg.top + seg.bottom) / 2);
        // The premise: the pointer is on this block, not a cap or a ghost.
        const under = await page.evaluate(
          ([px, py]) =>
            document
              .elementFromPoint(px as number, py as number)
              ?.closest(".seg")
              ?.matches(":hover") ?? false,
          [x, (seg.top + seg.bottom) / 2],
        );
        expect(under, `${k}: the pointer is over its block`).toBe(true);
        // The hover is instant; the wait is for the browser's style pass.
        const target = `rgba(${HOVERED[k].fill.join(", ")})`;
        await vi.waitFor(
          async () => {
            const bg = await page.evaluate(
              ([px, py]) => {
                const el = document
                  .elementFromPoint(px as number, py as number)
                  ?.closest(".seg");
                return el ? getComputedStyle(el).backgroundColor : null;
              },
              [x, (seg.top + seg.bottom) / 2],
            );
            if (bg !== target) throw new Error(`${k} is ${bg}, want ${target}`);
          },
          { timeout: 2_000, interval: 20 },
        );
        const [fill, edge] = await pixelsAt(page, [
          [x, seg.top + 5],
          [x, seg.top + 0.5],
        ]);
        const rest = over(
          track,
          LANES[k].fill as unknown as [number, number, number, number],
        );
        const want = over(
          track,
          HOVERED[k].fill as unknown as [number, number, number, number],
        );
        expect(
          distance(fill as Rgb, want),
          `${k} hovered fills ${JSON.stringify(fill)}, want ${JSON.stringify(want.map(Math.round))}`,
        ).toBeLessThanOrEqual(8);
        // Brighter, and by enough to see: further from rest than the
        // tolerance above, in every channel's sum.
        const sum = ([r, g, b]: Rgb) => r + g + b;
        expect(
          sum(fill as Rgb) - sum(rest),
          `${k} hovered ${JSON.stringify(fill)} vs rest ${JSON.stringify(rest.map(Math.round))}`,
        ).toBeGreaterThan(24);
        const edgeWant = over(
          over(track, [255, 255, 255, 0.08]),
          HOVERED[k].fill as unknown as [number, number, number, number],
        );
        expect(
          distance(edge as Rgb, edgeWant),
          `${k}'s hovered edge paints ${JSON.stringify(edge)}, want the fill over the hairline ${JSON.stringify(edgeWant.map(Math.round))}`,
        ).toBeLessThanOrEqual(8);
      }

      // The steps read by their icons here (the author, 2026-10-19), and a
      // selected step is a soft tile. Red: hide the icons in studio.css as
      // the extension's page does, or drop the selected tile.
      const step = page.locator('.lane[data-lane="clip"] .tick').first();
      const icon = await step.evaluate((e) => {
        const svg = e.querySelector("svg");
        const cs = svg === null ? null : getComputedStyle(svg);
        return { display: cs?.display, width: cs?.width };
      });
      expect(icon, "the step's icon paints").toEqual({
        display: "block",
        width: "16px",
      });
      await step.click();
      await page.mouse.move(5, 5);
      await vi.waitFor(
        async () => {
          const bg = await step.evaluate(
            (e) =>
              `${e.hasAttribute("data-selected")} ${getComputedStyle(e).backgroundColor}`,
          );
          if (bg !== "true rgba(255, 255, 255, 0.18)") {
            throw new Error(`the selected step is ${bg}`);
          }
        },
        { timeout: 2_000, interval: 20 },
      );

      // The Clip block stays lit with the pointer on one of its steps or a
      // trim handle, which sit beside the block in the lane, not in it (the
      // author, 2026-10-19). Red: drop the `.track:has(...)` selector.
      const clipBlock = '.lane[data-lane="clip"] .seg[data-clip-block]';
      const want = `rgba(${HOVERED.clip.fill.join(", ")})`;
      for (const over of [
        '.lane[data-lane="clip"] .tick',
        '.lane[data-lane="clip"] [data-trim="head"]',
      ]) {
        const target = page.locator(over).first();
        await target.hover();
        // The premise: the pointer is on the step or handle, and so off the
        // block, which is the state the block used to go dark in.
        const premise = await page.evaluate(
          ([o, b]) => ({
            on: document.querySelector(o as string)?.matches(":hover") ?? false,
            block:
              document.querySelector(b as string)?.matches(":hover") ?? null,
          }),
          [over, clipBlock],
        );
        expect(premise, `${over}: ${JSON.stringify(premise)}`).toEqual({
          on: true,
          block: false,
        });
        await vi.waitFor(
          async () => {
            const bg = await page
              .locator(clipBlock)
              .evaluate((e) => getComputedStyle(e).backgroundColor);
            if (bg !== want) {
              throw new Error(`over ${over}, the block is ${bg}, want ${want}`);
            }
          },
          { timeout: 2_000, interval: 20 },
        );
      }
    },
    LANE_MS,
  );
});

describe("space on a clicked button", () => {
  // The author, 2026-10-19: clicking Repeat and pressing Space toggled
  // Repeat, where YouTube plays. Red: drop `pointerFocused` from the editor's
  // keydown guard (main.ts), and Space toggles Repeat again.
  it(
    "plays from Space after a click, and leaves Space to a button reached by Tab",
    async () => {
      const { page, open } = await openStudio(1440, 900);
      await open("editor");
      const repeat = page.locator("#transport [data-transport-repeat]");
      const play = page.locator("#transport [data-transport-play]");
      const state = async () => ({
        repeat: await repeat.getAttribute("aria-pressed"),
        playing: (await play.getAttribute("data-playing")) !== null,
        focused: await page.evaluate(() => {
          const a = document.activeElement;
          return a === null
            ? "nothing"
            : `${a.tagName.toLowerCase()}${a.hasAttribute("data-transport-repeat") ? "[repeat]" : ""}${a.hasAttribute("data-transport-play") ? "[play]" : ""}`;
        }),
      });
      const settle = (
        want: (s: Awaited<ReturnType<typeof state>>) => boolean,
        what: string,
      ) =>
        vi.waitFor(
          async () => {
            const now = await state();
            if (!want(now)) throw new Error(`${what}: ${JSON.stringify(now)}`);
          },
          { timeout: 3_000, interval: 20 },
        );

      // A mouse click on Repeat: it toggles, and (the premise) Chrome leaves
      // the focus on it, which is what used to give it the Space bar.
      const before = (await state()).repeat;
      expect(before, "Repeat says its state").not.toBeNull();
      await repeat.click();
      const clicked = before === "true" ? "false" : "true";
      await settle((s) => s.repeat === clicked, "the click toggled Repeat");
      expect((await state()).focused, "focus after the click").toBe(
        "button[repeat]",
      );
      expect((await state()).playing, "paused before Space").toBe(false);

      await page.keyboard.press("Space");
      await settle((s) => s.playing, "Space played");
      expect((await state()).repeat, "Space left Repeat alone").toBe(clicked);
      await page.keyboard.press("Space");
      await settle((s) => !s.playing, "Space paused");
      expect((await state()).repeat, "Space left Repeat alone").toBe(clicked);

      // Enter still presses the clicked button.
      await page.keyboard.press("Enter");
      await settle((s) => s.repeat === before, "Enter toggled Repeat");
      expect((await state()).playing, "Enter did not play").toBe(false);

      // Reached by the keyboard, Repeat keeps Space: away and back by Tab.
      await page.keyboard.press("Tab");
      await page.keyboard.press("Shift+Tab");
      expect((await state()).focused, "Shift+Tab came back").toBe(
        "button[repeat]",
      );
      await page.keyboard.press("Space");
      await settle(
        (s) => s.repeat === clicked,
        "Space pressed tabbed-to Repeat",
      );
      expect(
        (await state()).playing,
        "Space on a tabbed-to button did not play",
      ).toBe(false);

      // Play clicked: Space toggles it once, not twice (the click Chrome
      // would make of the press is stopped).
      await play.click();
      await settle((s) => s.playing, "the click played");
      await page.keyboard.press("Space");
      await settle((s) => !s.playing, "Space paused a clicked Play");
    },
    LANE_MS,
  );
});

describe("review fixes", () => {
  // Found by the final review (ledger "Final:"); each line names the
  // regression it would catch.
  it.runIf(process.platform === "darwin")(
    "a destructive answer and the current row's count read as they should",
    async () => {
      const { page, open } = await openStudio(1440, 900);
      await open("library");
      // A count on the current row clears 4.5:1: --ink-3, not --ink-4.
      expect(
        await page
          .locator('.side-item[aria-current="true"] .side-count')
          .evaluate((e) => getComputedStyle(e).color),
      ).toBe("rgb(143, 143, 152)");
      // Delete's confirmation answers in danger, not in ink.
      await page.locator('[data-row] [data-action="delete"]').first().click();
      const go = page.locator(".confirm-dialog[open] .confirm-go-danger");
      await go.waitFor({ timeout: 5_000 });
      expect(await go.evaluate((e) => getComputedStyle(e).color)).toBe(
        "rgb(248, 113, 113)",
      );
      await page.keyboard.press("Escape");
    },
    LANE_MS,
  );

  it.runIf(process.platform === "darwin")(
    "rings a focused chosen kit in white, and frames a field with a hairline",
    async () => {
      const { page, open } = await openStudio(1440, 900);
      await open("kits");
      // Keyboard modality first, so the focus is :focus-visible.
      await page.keyboard.press("Tab");
      const chosen = page.locator('.kit-pick[aria-pressed="true"]');
      await chosen.focus();
      const ring = await chosen.evaluate((e) => {
        const r = e.getBoundingClientRect();
        return {
          visible: e.matches(":focus-visible"),
          color: getComputedStyle(e).outlineColor,
          x: r.left - 3,
          y: (r.top + r.bottom) / 2,
        };
      });
      expect(ring.visible, JSON.stringify(ring)).toBe(true);
      expect(ring.color, JSON.stringify(ring)).toBe("rgb(244, 244, 245)");
      const [white] = await pixelsAt(page, [[ring.x, ring.y]]);
      expect(
        distance(white as Rgb, [244, 244, 245]),
        `the focus ring paints ${JSON.stringify(white)}`,
      ).toBeLessThanOrEqual(24);
      await page.evaluate(() =>
        (document.activeElement as HTMLElement | null)?.blur(),
      );

      const field = page.locator("[data-colour-text]").first();
      await field.scrollIntoViewIfNeeded();
      const f = await field.evaluate((e) => {
        const r = e.getBoundingClientRect();
        return {
          left: r.left,
          top: r.top,
          bottom: r.bottom,
          radius: getComputedStyle(e).borderTopLeftRadius,
        };
      });
      expect(f.radius, JSON.stringify(f)).toBe("8px");
      expect(
        await lineStep(page, f.left + 0.5, (f.top + f.bottom) / 2, "v"),
        `the field's ring; ${JSON.stringify(f)}`,
      ).toBeGreaterThanOrEqual(LINE_STEP);
    },
    LANE_MS,
  );

  it.runIf(process.platform === "darwin")(
    "keeps a clamped zoom's warning ring, rings the keycaps, and keeps Export on screen in a narrow window",
    async () => {
      const { page, open } = await openStudio(1440, 900);
      await open("editor");
      const clamped = await page.evaluate(() => {
        const seg = document.querySelector(
          '.lane[data-lane="zoom"] .seg:not([data-ghost])',
        ) as HTMLElement;
        seg.setAttribute("data-clamped", "true");
        return getComputedStyle(seg).boxShadow;
      });
      // --warn #f5a969.
      expect(clamped).toContain("rgb(245, 169, 105)");

      await page.locator("#shortcuts-open").click();
      // Keyboard shortcuts is an inspector panel since 2026-10-19.
      const cap = page
        .locator("#inspector [data-panel-shortcuts] .keycap")
        .first();
      await cap.waitFor({ timeout: 5_000 });
      const c = await cap.evaluate((e) => {
        const r = e.getBoundingClientRect();
        return {
          left: r.left,
          top: r.top,
          bottom: r.bottom,
          shadow: getComputedStyle(e).boxShadow,
        };
      });
      expect(c.shadow, JSON.stringify(c)).toContain("0.13");
      expect(
        await lineStep(page, c.left + 0.5, (c.top + c.bottom) / 2, "v"),
        `a keycap's ring; ${JSON.stringify(c)}`,
      ).toBeGreaterThanOrEqual(LINE_STEP);
      await page.keyboard.press("Escape");

      await sizeWindow(page.context(), page, 520, 800);
      await settled(page);
      const e = await page.evaluate(() => {
        const r = (
          document.getElementById("export-open") as HTMLElement
        ).getBoundingClientRect();
        return { right: r.right, bottom: r.bottom, width: innerWidth };
      });
      expect(e.right, JSON.stringify(e)).toBeLessThanOrEqual(e.width);
    },
    LANE_MS,
  );
});

describe("dark only", () => {
  // Spec §6: a theme an older studio stored changes nothing on screen, and
  // nothing is drawn to choose one. Red: put the theme back on the studio's
  // platform (the page then follows "light" and clears data-theme), or mount
  // the switch whatever the platform has.
  it.runIf(process.platform === "darwin")(
    "a stored light theme changes nothing, and no switch is drawn",
    async () => {
      const { page, console_, open } = await openStudio(1440, 900, {
        theme: "light",
      });
      for (const name of ["library", "kits", "editor"] as const) {
        await open(name);
        const seen = await page.evaluate(() => ({
          theme: document.documentElement.dataset.theme ?? null,
          toggles: document.querySelectorAll("[data-theme-toggle]").length,
          slot:
            document.querySelector("[data-theme-slot]")?.children.length ?? 0,
          height: innerHeight,
        }));
        expect(seen, name).toMatchObject({
          theme: "dark",
          toggles: 0,
          slot: 0,
        });
        const [corner] = await pixelsAt(page, [[2, seen.height - 2]]);
        expect(
          distance(corner as Rgb, BG),
          `${name}: the ground paints ${JSON.stringify(corner)}`,
        ).toBeLessThanOrEqual(2);
      }
      expect(console_.faults(), console_.lines.join("\n")).toEqual([]);
    },
    LANE_MS,
  );
});

describe("Take info's history", () => {
  // Review 2026-10-19: the studio's history rows dropped the summary and
  // every warning with it, so an export made before a reload — or by an
  // agent — said nowhere that its logo was left out. The author's ruling: a
  // chip on the row, like Outdated, that unfolds them. Red: drop
  // `warningsChip` or the unfolded caveats from `drawFileRow`, or the
  // `caveats` from `outputRowOf`.
  it.runIf(process.platform === "darwin")(
    "wears a warnings chip on an export that came with one, and unfolds it under the row",
    async () => {
      const { page, editorTake, open } = await openStudio(1440, 900);
      const home = homes[homes.length - 1] as string;
      const file = join(home, "out", "warned.mp4");
      await mkdir(join(home, "out"), { recursive: true });
      await writeFile(file, "not a real video");
      const renderedAt = "2026-10-19T14:14:00.000Z";
      await writeFile(
        join(home, "takes", editorTake, "outputs.json"),
        JSON.stringify([
          {
            path: file,
            fileType: "mp4",
            aspect: "16:9",
            byteLength: 16,
            renderedAt,
            sceneDigest: "an earlier scene",
            report: {
              outcome: "saved",
              takeId: editorTake,
              aspect: "16:9",
              width: 1920,
              height: 1080,
              fps: 30,
              fileType: "mp4",
              file: { path: file, byteLength: 16, downloadId: null },
              warnings: {
                logo: "decode failed",
                unavailableSpans: [],
                detailViolations: [],
              },
              summary: `Saved ${file}, but the logo is missing (decode failed).`,
            },
          },
        ]),
      );
      await open("editor");
      await page.locator("#take-meta").click();
      const chip = page.locator(
        `#take-info [data-output-warnings="${file}@${renderedAt}"]`,
      );
      await chip.waitFor({ timeout: 5_000 });
      expect(await chip.textContent()).toBe("1 warning");
      // Painted, not only present: the chip is what is drawn at its own
      // centre, on its name's line beside Outdated, in the warn hue.
      const drawn = await chip.evaluate((n) => {
        const r = n.getBoundingClientRect();
        const at = document.elementFromPoint(
          r.left + r.width / 2,
          r.top + r.height / 2,
        );
        return {
          onTop: at === n || n.contains(at),
          color: getComputedStyle(n).color,
          line: n.closest(".output-head")?.textContent ?? null,
        };
      });
      expect(drawn, JSON.stringify(drawn)).toMatchObject({
        onTop: true,
        color: "rgb(245, 169, 105)",
      });
      expect(drawn.line).toContain("Outdated");

      await chip.click();
      const body = page.locator("#take-info [data-output-warnings-body]");
      await body.waitFor({ timeout: 5_000 });
      expect(await body.textContent()).toBe(
        "The logo is missing (decode failed).",
      );
      expect(await chip.getAttribute("aria-expanded")).toBe("true");
      // Keyboard focus stays on the chip the redraw replaced.
      expect(
        await page.evaluate(
          () =>
            document.activeElement?.getAttribute("data-output-warnings") ??
            null,
        ),
      ).toBe(`${file}@${renderedAt}`);
      const shown = await body.evaluate((n) => {
        const r = n.getBoundingClientRect();
        const at = document.elementFromPoint(
          r.left + r.width / 2,
          r.top + r.height / 2,
        );
        return { onTop: at === n || n.contains(at), height: r.height };
      });
      expect(shown.onTop, JSON.stringify(shown)).toBe(true);
      expect(shown.height).toBeGreaterThan(10);
      const shots = process.env.STUDIO_LOOK_SHOT_DIR;
      if (shots !== undefined) {
        await page.screenshot({ path: join(shots, "take-info-warnings.png") });
      }
    },
    LANE_MS,
  );
});

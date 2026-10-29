import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createLibrary } from "@demoman/runner/studio";
import { NEUTRAL_BACKGROUND, WALLPAPERS } from "@demoman/scene-schema";
import type { Page, Route } from "playwright";
import { afterEach, describe, expect, it, vi } from "vitest";
import { distance, limeOutsideItsPlaces, pixelsAt } from "./look-probes.js";
import type { PlainTake } from "./painted-take.js";
import {
  api,
  type Studio,
  sizeWindow,
  startStudio,
  watchConsole,
} from "./studio-harness.js";
import {
  joinVideo,
  ONE_VERSION_EXPORT,
  openPage,
  PAINT_MS,
  PLAIN,
  painted,
  seedHome,
  settle,
  UNREADABLE,
  VIDEO_TAKES,
} from "./studio-pages.js";

// The screenshot set the author looks at (D3, Task 8): the studio's editor,
// library and Brand kit pages, at a laptop's 1280x720 and 1440x900, in the
// studio's one theme (dark only since 2026-10-19), plus the editor stacked
// at 900x800, from the real server, the real built
// pages and a real Chrome for Testing window. Each shot is asserted on its
// painted result beside it, so a shot that shows a broken page also fails
// the lane:
//
// - no page scrolls sideways;
// - the editor's timeline card is not painted over by the stage (the sub-900px
//   overflow `CLAUDE.md` names: a rect alone reported a clean gap), probed
//   along a band just inside the card's top edge;
// - every library card's preview holds its take's picture;
// - the body is the near-black ground (dark only since 2026-10-19);
// - two fixes from looking at the first set: the library's jump list names
//   the folders that couldn't be read (they sit below the fold), and the
//   Brand kit page, one section, draws no jump list of one;
// - and, from review, a shot scrolled to the unreadable row (every library
//   shot has it below the fold): the row and its Delete paint, with the
//   folder's name, the reason and the size;
// - and the editor's Zoom lane with two zooms the camera pans between, the
//   first block ending where the second sets off.
//
// A second case shoots Settings with a take it was asked to open while a kit
// save failed: the notice and its "Open the take", with Details closed and
// open.
//
// darwin only: the library's thumbnails are made by `sips` (spec §7.1),
// which only macOS has, and a card with no thumbnail has nothing to sample.
// The route's own tests inject the thumbnailer and run everywhere.
//
// Measured locally (2026-10-17, M-series Mac, headless, seven runs): the
// whole case 3.8-7.7 s (the slower runs cold), of which seeding is
// 0.6-2.1 s and the twelve shots 3.2-5.6 s. x5 for CI is 39 s; 120 s
// leaves room for a cold Chromium start on top.
const LANE_MS = 120_000;

const SHOTS = fileURLToPath(
  new URL("./__screenshots__/studio/", import.meta.url),
);
const SIZES = [
  { width: 1280, height: 720 },
  { width: 1440, height: 900 },
] as const;
/** Dark only (spec 2026-10-19 §6): one theme, kept as a loop so the shots
 *  keep their `-dark` names. */
const THEMES = ["dark"] as const;

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

/** The unreadable row as painted: whether the points at its centre and at
 *  its Delete button's centre land inside them; its words; how opaque its
 *  name, reason and size are as drawn (each one's opacity times its
 *  ancestors'); and how far the reason's text runs past the row's right
 *  edge. */
function unreadableRowPaint(page: Page, folder: string) {
  return page.evaluate((name) => {
    const row = document.querySelector<HTMLElement>(
      `[data-unreadable-row="${CSS.escape(name)}"]`,
    );
    if (row === null) return null;
    const lands = (el: Element | null): boolean => {
      if (el === null) return false;
      const r = el.getBoundingClientRect();
      const hit = document.elementFromPoint(
        r.left + r.width / 2,
        r.top + r.height / 2,
      );
      return hit !== null && el.contains(hit);
    };
    const opacity = (el: Element | null): number => {
      let o = el === null ? 0 : 1;
      for (let n = el; n !== null; n = n.parentElement) {
        o *= Number(getComputedStyle(n).opacity);
      }
      return Math.round(o * 100) / 100;
    };
    const nameEl = row.querySelector("[data-unreadable-name]");
    const reasonEl = row.querySelector<HTMLElement>("[data-reason]");
    const sizeEl = row.querySelector<HTMLElement>("[data-size]");
    // The reason's text as laid out, against the row's own right edge.
    let reasonOverflow = Number.NaN;
    if (reasonEl !== null) {
      const range = document.createRange();
      range.selectNodeContents(reasonEl);
      const right = Math.max(
        ...[...range.getClientRects()].map((r) => r.right),
      );
      reasonOverflow = Math.round(right - row.getBoundingClientRect().right);
    }
    return {
      rowHit: lands(row),
      removeHit: lands(row.querySelector('[data-action="delete"]')),
      text: row.innerText,
      reason: reasonEl?.innerText.trim() ?? "",
      size: sizeEl?.innerText.trim() ?? "",
      shown: {
        name: opacity(nameEl),
        reason: opacity(reasonEl),
        size: opacity(sizeEl),
      },
      reasonOverflow,
    };
  }, folder);
}

/** The Settings notice as painted: its height, its title, its Details
 *  (open or not, and the reason inside), and the "Open the take" button —
 *  for each part, whether the point at its centre lands on it, whether it
 *  sits inside the notice and the viewport, and its opacity as drawn (its
 *  own times its ancestors'). */
function offerPaint(page: Page) {
  return page.evaluate(() => {
    const notice = document.getElementById("notice");
    if (notice === null) return null;
    const n = notice.getBoundingClientRect();
    const paint = (el: HTMLElement | null) => {
      if (el === null) return null;
      const r = el.getBoundingClientRect();
      const hit = document.elementFromPoint(
        r.left + r.width / 2,
        r.top + r.height / 2,
      );
      let opacity = 1;
      for (let e: Element | null = el; e !== null; e = e.parentElement) {
        opacity *= Number(getComputedStyle(e).opacity);
      }
      return {
        text: el.innerText.trim(),
        hit: hit !== null && el.contains(hit),
        insideNotice:
          r.left >= n.left - 0.5 &&
          r.right <= n.right + 0.5 &&
          r.top >= n.top - 0.5 &&
          r.bottom <= n.bottom + 0.5,
        onScreen:
          r.width > 0 && r.height > 0 && r.top >= 0 && r.bottom <= innerHeight,
        opacity: Math.round(opacity * 100) / 100,
        midY: Math.round(r.top + r.height / 2),
      };
    };
    const details = notice.querySelector<HTMLDetailsElement>(
      "details.notice-details",
    );
    return {
      height: Math.round(n.height),
      title: paint(notice.querySelector<HTMLElement>(".notice-title")),
      detailsOpen: details?.open ?? null,
      reasonText:
        notice.querySelector("[data-notice-reason]")?.textContent ?? null,
      reason: details?.open
        ? paint(notice.querySelector<HTMLElement>("[data-notice-reason]"))
        : null,
      button: paint(notice.querySelector<HTMLElement>("[data-open-asked]")),
    };
  });
}

/** WCAG relative luminance of a computed `rgb()`/`rgba()` colour. */
function luminance(css: string): number {
  const m = /rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?\)/.exec(
    css,
  );
  if (m === null) throw new Error(`not an rgb() colour: ${css}`);
  if (m[4] !== undefined && Number(m[4]) < 1) {
    throw new Error(`the body's background is not opaque: ${css}`);
  }
  const [r, g, b] = [m[1], m[2], m[3]].map((v) => {
    const c = Number(v) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

describe("the Studio's screenshot set", () => {
  it.runIf(process.platform === "darwin")(
    "shoots the editor, library and Brand kit pages at two sizes in the Studio's one theme, and the editor stacked, each asserted on its paint",
    async () => {
      const started = Date.now();
      const home = await mkdtemp(join(tmpdir(), "studio-shots-"));
      homes.push(home);
      const { editorTake } = await seedHome(home);
      const ids = [editorTake, ...PLAIN.map((t) => t.id)];
      const seeded = Date.now();
      await rm(SHOTS, { recursive: true, force: true });
      await mkdir(SHOTS, { recursive: true });

      const studio = await startStudio(home, join(home, "out"));
      running = studio;
      const opened = await api(studio, "/api/window", {
        method: "POST",
        body: {},
      });
      expect(opened.status, `${opened.text}\n${studio.logs.join("\n")}`).toBe(
        200,
      );
      const context = studio.context();
      const page = context.pages()[0] as Page;
      const console_ = watchConsole(page);
      // The premise of the library's previews: each take's thumbnail came
      // from the studio's own route, as a JPEG.
      const thumbs = new Set<string>();
      page.on("response", (r) => {
        const m = /\/api\/takes\/([^/]+)\/thumbs\//.exec(r.url());
        if (
          m !== null &&
          r.status() === 200 &&
          r.headers()["content-type"] === "image/jpeg"
        ) {
          thumbs.add(decodeURIComponent(m[1] as string));
        }
      });

      const shots: string[] = [];
      /** Each page's open to its settled paint, for the closing line. */
      const opens: string[] = [];
      for (const theme of THEMES) {
        for (const size of SIZES) {
          await sizeWindow(context, page, size.width, size.height);
          for (const name of ["editor", "library", "kits"] as const) {
            const opening = Date.now();
            await openPage(page, studio, name, editorTake, thumbs);
            opens.push(`${name} ${Date.now() - opening}`);
            const file = join(
              SHOTS,
              `${name}-${size.width}x${size.height}-${theme}.png`,
            );
            await page.screenshot({ path: file });
            shots.push(file);
            const at = `${name} ${size.width}x${size.height} ${theme}`;
            const p = await painted(page);
            expect(p.theme, `${at}: the page's theme`).toBe(theme);
            // Lime in its three places only (spec 2026-10-19 §3.5).
            expect(await limeOutsideItsPlaces(page), `${at}: lime`).toEqual([]);
            expect(
              p.scrollWidth,
              `${at}: no sideways scroll (${JSON.stringify(p)})`,
            ).toBeLessThanOrEqual(p.innerWidth);
            if (name === "editor") {
              expect(
                p.dockBand?.every((h) => h.endsWith(": dock")),
                `${at}: the band across the dock's top edge is the dock's: ${JSON.stringify(p.dockBand)}`,
              ).toBe(true);
              // The re-film line left the Export panel for a take with frames
              // on 2026-10-19 (the author: the panel is for exporting; how a
              // studio take is filmed again is parked). It was measured here
              // for E2's wrap (its own line, inside the panel); it still
              // draws for a take with no frames and in the re-shoot failure
              // box, which this fixture's framed take has neither of. Red:
              // draw it back under the button.
              const refilm = await page.evaluate(() => ({
                panel:
                  document.querySelector(
                    "[data-panel-export] [data-export-start]",
                  ) !== null,
                line:
                  document.querySelector(
                    "[data-panel-export] [data-rerun-line]",
                  ) !== null,
              }));
              expect(refilm, `${at}: the Export panel`).toEqual({
                panel: true,
                line: false,
              });
            }
            if (name === "library") {
              expect(
                [...thumbs].sort(),
                `${at}: every take's thumbnail came from the route`,
              ).toEqual([...ids].sort());
              // The fixture's claim, "one of them with a cut": the cut
              // take's length badge differs from its plain siblings', which
              // share one base scene and so one length. The badge follows
              // the first frame, so it is waited for.
              const lengths = await vi.waitFor(
                async () => {
                  const read = await page.evaluate(
                    (rows) => {
                      const out: Record<string, string | null> = {};
                      for (const id of rows) {
                        const badge = document.querySelector<HTMLElement>(
                          `[data-row="${CSS.escape(id)}"] [data-duration]`,
                        );
                        out[id] =
                          badge === null || badge.hidden
                            ? null
                            : (badge.textContent ?? "");
                      }
                      return out;
                    },
                    PLAIN.map((t) => t.id),
                  );
                  if (Object.values(read).some((v) => v === null)) {
                    throw new Error(
                      `badges not shown: ${JSON.stringify(read)}`,
                    );
                  }
                  return read as Record<string, string>;
                },
                { timeout: PAINT_MS, interval: 50 },
              );
              // L2: each thumbnail's picture has an edge where it meets the
              // card-coloured bars. The fixture's recordings are 1280x800,
              // so every picture is pillarboxed in its 16:9 box (the
              // premise); the canvas is sized to the picture, at the box's
              // full height, and carries the ring. Red while the canvas
              // fills the box (the ring would ring the box, clipped away).
              const edges = await page.evaluate(
                (rows) => {
                  const out: Record<string, unknown> = {};
                  for (const id of rows) {
                    const box = document.querySelector(
                      `[data-row="${CSS.escape(id)}"] [data-preview]`,
                    );
                    const canvas = box?.querySelector("[data-preview-canvas]");
                    if (!box || !canvas) {
                      out[id] = null;
                      continue;
                    }
                    const b = box.getBoundingClientRect();
                    const c = canvas.getBoundingClientRect();
                    out[id] = {
                      narrower: b.width - c.width,
                      fullHeight: Math.abs(b.height - c.height) <= 1,
                      centred:
                        Math.abs(c.left - b.left - (b.right - c.right)) <= 1,
                      ring: getComputedStyle(canvas).boxShadow,
                    };
                  }
                  return out;
                },
                PLAIN.map((t) => t.id),
              );
              for (const [id, e] of Object.entries(edges)) {
                const edge = e as {
                  narrower: number;
                  fullHeight: boolean;
                  centred: boolean;
                  ring: string;
                } | null;
                const said = `${at}: ${id}'s thumbnail ${JSON.stringify(edge)}`;
                expect(edge, said).not.toBeNull();
                expect(edge?.narrower, said).toBeGreaterThan(8);
                expect(edge?.fullHeight, said).toBe(true);
                expect(edge?.centred, said).toBe(true);
                expect(edge?.ring, said).toMatch(/\b1px\b/);
              }
              const cut = PLAIN.filter((t) => (t.cuts ?? []).length > 0);
              const plain = PLAIN.filter((t) => (t.cuts ?? []).length === 0);
              expect(cut.length, "one take with a cut").toBe(1);
              const lengthsSaid = `${at}: lengths ${JSON.stringify(lengths)}`;
              expect(
                new Set(plain.map((t) => lengths[t.id])).size,
                `${lengthsSaid}: the plain takes share one length`,
              ).toBe(1);
              expect(
                lengths[(cut[0] as PlainTake).id],
                `${lengthsSaid}: the cut take's length is its own`,
              ).not.toBe(lengths[(plain[0] as PlainTake).id]);
              // Both days, then the folder that would not read: named in the
              // jump list, which is in view where the section is not.
              expect(
                p.jumps.map((j) => [/ (\d+)$/.exec(j.text)?.[1], j.painted]),
                `${at}: the jump list ${JSON.stringify(p.jumps)}`,
              ).toEqual([
                ["2", true],
                ["2", true],
                ["1", true],
              ]);
              expect(p.jumps[0]?.text).toBe("Yesterday 2");
              expect(p.jumps[2]?.text).toBe("Couldn't read 1");

              // The unreadable row, scrolled to: every library shot above
              // has it below the fold, so it gets a shot of its own.
              await page.evaluate(() =>
                document
                  .getElementById("unreadable")
                  ?.scrollIntoView({ block: "start", behavior: "instant" }),
              );
              const rowFile = join(
                SHOTS,
                `library-unreadable-${size.width}x${size.height}-${theme}.png`,
              );
              await page.screenshot({ path: rowFile });
              shots.push(rowFile);
              const row = await unreadableRowPaint(page, UNREADABLE);
              if (row === null) throw new Error(`${at}: no unreadable row`);
              const said = `${at}: ${JSON.stringify(row)}`;
              expect(
                { row: row.rowHit, remove: row.removeHit },
                `${said}: the row and its Delete paint`,
              ).toEqual({ row: true, remove: true });
              expect(row.text, `${said}: the folder's name`).toContain(
                UNREADABLE,
              );
              expect(row.reason, `${said}: the reason`).toMatch(/JSON/);
              expect(row.text).toContain(row.reason);
              expect(row.size, `${said}: the size`).toMatch(
                /^\d+(\.\d+)? (B|KB|MB)$/,
              );
              expect(row.text).toContain(row.size);
              // Shown, not only present: a word at opacity 0 is in
              // innerText and in no one's view.
              expect(row.shown, `${said}: the row's words, drawn`).toEqual({
                name: 1,
                reason: 1,
                size: 1,
              });
              expect(
                row.reasonOverflow,
                `${said}: the reason stays inside the row`,
              ).toBeLessThanOrEqual(0);
              // And with the pointer on Delete, where it goes to use the
              // row: the words stay (the take card's swap would hide them).
              await page
                .locator(
                  `[data-unreadable-row="${UNREADABLE}"] [data-action="delete"]`,
                )
                .hover();
              // Settled under the pointer: Delete is hovered (the premise),
              // and the take card's 120 ms opacity swap, if any, has run.
              await vi.waitFor(
                async () => {
                  const settled = await page.evaluate(
                    ([folder]) =>
                      document
                        .querySelector(
                          `[data-unreadable-row="${folder}"] [data-action="delete"]`,
                        )
                        ?.matches(":hover") === true &&
                      document
                        .getAnimations()
                        .every((x) => x.playState !== "running"),
                    [UNREADABLE] as const,
                  );
                  if (!settled)
                    throw new Error(`${at}: Delete is not hovered yet`);
                },
                { timeout: PAINT_MS, interval: 50 },
              );
              const hovered = await unreadableRowPaint(page, UNREADABLE);
              expect(
                hovered?.shown,
                `${at}: with the pointer on Delete, the row's words, drawn`,
              ).toEqual({ name: 1, reason: 1, size: 1 });
              await page.mouse.move(0, 0);
            }
            if (name === "kits") {
              // Three sections (Brand kit, Export, Pull requests): the title and a
              // jump list of exactly those three. It was the title alone while
              // Brand kit was the page's only section.
              expect(
                { side: p.settingsSide, links: p.settingsLinks },
                `${at}: the side column`,
              ).toEqual({
                side: "Settings\nBrand kit\nExport\nPull requests",
                links: 3,
              });
              // K2: the preview is capped against the window, so the first
              // row of controls is on screen with it. Red at 720 tall while
              // the 480px-wide preview fills the fold.
              const controls = await page.evaluate(() => {
                const solid = document.querySelector(
                  '[data-group="background"] [data-bg-kind="solid"]',
                );
                const preview = document.querySelector(
                  ".kit-hero .kit-preview",
                );
                if (!solid || !preview) return null;
                const p = preview.getBoundingClientRect();
                const canvas = preview as HTMLCanvasElement;
                return {
                  solidBottom: solid.getBoundingClientRect().bottom,
                  innerHeight: window.innerHeight,
                  // Scaled evenly, not squashed: the drawn shape keeps the
                  // canvas's own ratio.
                  ratioDrift: Math.abs(
                    p.width / p.height - canvas.width / canvas.height,
                  ),
                };
              });
              const controlsSaid = `${at}: the first control row ${JSON.stringify(controls)}`;
              expect(controls, controlsSaid).not.toBeNull();
              expect(controls?.solidBottom, controlsSaid).toBeLessThanOrEqual(
                controls?.innerHeight ?? 0,
              );
              expect(controls?.ratioDrift, controlsSaid).toBeLessThan(0.02);
            }
            const lum = luminance(p.bg);
            expect(
              lum,
              `${at}: the body (${p.bg}, ${lum.toFixed(4)}) is the near-black ground`,
            ).toBeLessThan(0.01);
          }
        }
      }
      // The editor stacked (spec 2026-10-19 §5.3): the inspector under the
      // dock, each part over a hairline (studio-look asserts the lines).
      await sizeWindow(context, page, 900, 800);
      await openPage(page, studio, "editor", editorTake, thumbs);
      const stacked = join(SHOTS, "editor-900x800-dark.png");
      await page.screenshot({ path: stacked });
      shots.push(stacked);
      const sp = await painted(page);
      expect(
        sp.scrollWidth,
        `editor 900x800: ${JSON.stringify(sp)}`,
      ).toBeLessThanOrEqual(sp.innerWidth);
      expect(await limeOutsideItsPlaces(page), "editor 900x800: lime").toEqual(
        [],
      );
      // Two zooms the camera pans between (2026-10-22): each block drawn
      // from its push-in setting off, the first ending where the second
      // sets off. A second zoom is added just past the take's own through
      // the Zoom lane, as an author would, which places it too close for a
      // return between them. Asserted on the paint: the two meet, the
      // first's last pixels are its own and the second's first are its.
      await sizeWindow(context, page, 1440, 900);
      await openPage(page, studio, "editor", editorTake, thumbs);
      const zoomLane = '[data-track="zoom"]';
      const first = await page
        .locator(`${zoomLane} [data-segment]`)
        .boundingBox();
      if (first === null) throw new Error("the take's zoom is not drawn");
      await page.mouse.click(
        first.x + first.width + 4,
        first.y + first.height / 2,
      );
      await page.waitForFunction(
        (lane) =>
          document.querySelectorAll(`${lane} [data-segment]`).length === 2,
        zoomLane,
        { timeout: PAINT_MS },
      );
      await settle(page, "editor zoom hand-off");
      const handoff = join(SHOTS, "editor-zoom-handoff-1440x900-dark.png");
      await page.screenshot({ path: handoff });
      shots.push(handoff);
      const blocks = await page.evaluate((lane) => {
        const [a, b] = [
          ...document.querySelectorAll<HTMLElement>(`${lane} [data-segment]`),
        ].sort(
          (x, y) =>
            x.getBoundingClientRect().left - y.getBoundingClientRect().left,
        );
        if (!a || !b) return null;
        const ra = a.getBoundingClientRect();
        const rb = b.getBoundingClientRect();
        const y = ra.top + ra.height / 2;
        const owns = (el: HTMLElement, x: number) => {
          const hit = document.elementFromPoint(x, y);
          return hit !== null && el.contains(hit);
        };
        return {
          gap: Math.round((rb.left - ra.right) * 10) / 10,
          // 6px in: a cap's grab area reaches 3px past its block
          // (`.cap::after`), so the touching edge is the neighbour's.
          firstOwnsItsEnd: owns(a, ra.right - 6),
          secondOwnsItsStart: owns(b, rb.left + 6),
          secondStartsAfterFirst: rb.left > ra.left + 10,
        };
      }, zoomLane);
      expect(blocks, "editor zoom hand-off: the two blocks as painted").toEqual(
        {
          gap: expect.any(Number),
          firstOwnsItsEnd: true,
          secondOwnsItsStart: true,
          secondStartsAfterFirst: true,
        },
      );
      expect(
        Math.abs(blocks?.gap ?? Number.NaN),
        `editor zoom hand-off: ${JSON.stringify(blocks)}`,
      ).toBeLessThan(1.5);
      expect(shots).toHaveLength(10);
      expect(console_.faults(), console_.lines.join("\n")).toEqual([]);
      running = null;
      expect(await studio.stop(), studio.logs.join("\n")).toBe(0);
      console.info(
        `studio shots lane: seeding ${seeded - started} ms, shots ${Date.now() - seeded} ms; opens (ms) ${opens.join(", ")}; wrote ${shots.join(", ")}`,
      );
    },
    LANE_MS,
  );

  // The library's videos (local video library spec §6): a video of three
  // versions, opened, at a laptop's 1280x720 (under 900 tall) and 1440x900,
  // in the studio's one theme (dark only since 2026-10-19, so no light
  // shot). Asserted on the paint: each version's line is on screen and not
  // covered, and the expired one shows its re-record line, inside the card.
  it.runIf(process.platform === "darwin")(
    "shoots a video's versions opened, the expired one with its line, each asserted on its paint",
    async () => {
      const home = await mkdtemp(join(tmpdir(), "studio-shots-video-"));
      homes.push(home);
      const { editorTake } = await seedHome(home, VIDEO_TAKES);
      const videoId = await joinVideo(home);
      await mkdir(SHOTS, { recursive: true });
      const [v1, v2, v3, neighbour] = VIDEO_TAKES.map((t) => t.id) as [
        string,
        string,
        string,
        string,
      ];
      const frames = join(home, "takes", v1, "frames");
      // Premise: the oldest version has a recording for expiry to take.
      expect(await stat(frames).then(() => true)).toBe(true);
      const studio = await startStudio(home, join(home, "out"));
      running = studio;
      const opened = await api(studio, "/api/window", {
        method: "POST",
        body: {},
      });
      expect(opened.status, `${opened.text}\n${studio.logs.join("\n")}`).toBe(
        200,
      );
      const context = studio.context();
      const page = context.pages()[0] as Page;
      const console_ = watchConsole(page);
      const shots: string[] = [];
      const visible = { onScreen: true, hit: true, opacity: 1 };
      /** Each named element as painted: on screen, the point at its centre
       *  its own, and its opacity as drawn. */
      const shown = (selectors: string[]) =>
        page.evaluate((sels) => {
          const opacity = (el: Element): number => {
            let o = 1;
            for (let n: Element | null = el; n !== null; n = n.parentElement) {
              o *= Number(getComputedStyle(n).opacity);
            }
            return Math.round(o * 100) / 100;
          };
          return sels.map((sel) => {
            const el = document.querySelector(sel);
            if (el === null) return null;
            const r = el.getBoundingClientRect();
            const hit = document.elementFromPoint(
              r.left + r.width / 2,
              r.top + r.height / 2,
            );
            return {
              onScreen:
                r.width > 0 &&
                r.height > 0 &&
                r.top >= 0 &&
                r.bottom <= innerHeight,
              hit: hit !== null && el.contains(hit),
              opacity: opacity(el),
            };
          });
        }, selectors);
      for (const size of SIZES) {
        await sizeWindow(context, page, size.width, size.height);
        // The four takes seedHome makes, the neighbour, and this video's
        // one card.
        await openPage(page, studio, "library", editorTake, new Set(), 6);
        const at = `library video ${size.width}x${size.height}`;
        const cardSel = `article[data-video="${videoId}"]`;
        const card = page.locator(cardSel);
        // One card for the three takes, showing the current (newest).
        expect(await card.getAttribute("data-row"), at).toBe(v3);
        // Its repo leads its line.
        expect(
          await card.locator("[data-meta]").textContent(),
          `${at}: the card's line`,
        ).toMatch(/^acme\/web · /);
        await card.locator(".versions-count").click();
        await page
          .locator(`[data-versions="${videoId}"] [data-version-row="${v1}"]`)
          .scrollIntoViewIfNeeded();
        // At rest: the pointer off the card and the fold's focus let go, so
        // the card's hover and focus-within reveals are not what is shot.
        await page.mouse.move(0, 0);
        await page.evaluate(() =>
          (document.activeElement as HTMLElement).blur(),
        );
        await settle(page, at);
        const file = join(
          SHOTS,
          `library-versions-${size.width}x${size.height}-dark.png`,
        );
        await page.screenshot({ path: file });
        shots.push(file);
        const p = await painted(page);
        expect(p.theme, `${at}: the page's theme`).toBe("dark");
        expect(await limeOutsideItsPlaces(page), `${at}: lime`).toEqual([]);
        expect(
          p.scrollWidth,
          `${at}: no sideways scroll (${JSON.stringify(p)})`,
        ).toBeLessThanOrEqual(p.innerWidth);
        const rows = await page.evaluate((video) => {
          const card = document.querySelector(`article[data-video="${video}"]`);
          const cardRight = card?.getBoundingClientRect().right ?? 0;
          return [
            ...document.querySelectorAll(
              `[data-versions="${video}"] [data-version-row]`,
            ),
          ].map((row) => {
            const line = row.querySelector("[data-rerun-line]");
            let lineOverflow: number | null = null;
            if (line !== null) {
              const range = document.createRange();
              range.selectNodeContents(line);
              lineOverflow = Math.round(
                Math.max(...[...range.getClientRects()].map((r) => r.right)) -
                  cardRight,
              );
            }
            return {
              id: row.getAttribute("data-version-row"),
              number: row.querySelector(".version-number")?.textContent,
              edit: row.querySelector('[data-action="edit"]') !== null,
              line: (line as HTMLElement | null)?.innerText ?? null,
              lineOverflow,
              exports: [...row.querySelectorAll("[data-export]")].map((e) => [
                (e as HTMLElement).innerText.replace(/\s+/g, " ").trim(),
                e.hasAttribute("data-gone"),
              ]),
            };
          });
        }, videoId);
        const said = `${at}: ${JSON.stringify(rows)}`;
        // Newest first, every version painted where it can be read.
        expect(
          rows.map((r) => [r.id, r.number]),
          said,
        ).toEqual([
          [v3, "v3"],
          [v2, "v2"],
          [v1, "v1"],
        ]);
        const row = (id: string) =>
          `[data-versions="${videoId}"] [data-version-row="${id}"]`;
        for (const id of [v3, v2, v1]) {
          expect(
            await shown([
              `${row(id)} .version-number`,
              `${row(id)} .version-when`,
            ]),
            `${said}: ${id}'s number and day`,
          ).toEqual([visible, visible]);
        }
        // The newest version's exports, each painted; the moved one gone.
        expect(rows[0]?.exports, said).toEqual([
          ["Create an invoice.mp4 MP4", false],
          ["Create an invoice.gif GIF · gone", true],
        ]);
        expect(
          await shown([
            `${row(v3)} [data-export]:not([data-gone])`,
            `${row(v3)} [data-export][data-gone]`,
          ]),
          `${said}: the exports`,
        ).toEqual([visible, visible]);
        // The expired one (the studio's own expiry took it as it started)
        // says only how to record it again; the others can be opened.
        expect(
          rows.map((r) => [r.id, r.edit, r.line !== null]),
          said,
        ).toEqual([
          [v3, true, false],
          [v2, true, false],
          [v1, false, true],
        ]);
        const expired = rows[2];
        expect(expired?.line, said).toContain("Ask your agent to re-record");
        // The call names the video, which a run records again; never the
        // take, which the runner refuses.
        expect(expired?.line, said).toContain(
          `run({ video: { id: "${videoId}" } })`,
        );
        expect(
          await shown([`${row(v1)} [data-rerun-line]`]),
          `${said}: the line`,
        ).toEqual([visible]);
        expect(
          expired?.lineOverflow,
          `${said}: the line stays inside the card`,
        ).toBeLessThanOrEqual(0);
        // A video of one version (the neighbour) has no fold: its export
        // is on its card, painted. Red (final review 14): draw exports only
        // in the fold.
        const alone = `article[data-row="${neighbour}"]`;
        expect(
          await page.evaluate(
            (sel) =>
              [...document.querySelectorAll(`${sel} [data-export]`)].map((e) =>
                (e as HTMLElement).innerText.replace(/\s+/g, " ").trim(),
              ),
            alone,
          ),
          `${at}: the one-version card's exports`,
        ).toEqual([`${ONE_VERSION_EXPORT} MP4`]);
        expect(
          await page.locator(`${alone} [data-versions]`).count(),
          `${at}: premise, the one-version card has no fold`,
        ).toBe(0);
        expect(
          await shown([`${alone} [data-export]`]),
          `${at}: the one-version card's export`,
        ).toEqual([visible]);
        // The fold stretches only its own card: the neighbour in its grid
        // row keeps its height, and the page below it is not the neighbour.
        const beside = await page.evaluate(
          ([cardSel, other]) => {
            const a = document.querySelector(cardSel)?.getBoundingClientRect();
            const b = document
              .querySelector(`article[data-row="${other}"]`)
              ?.getBoundingClientRect();
            if (!a || !b) return null;
            const below = document.elementFromPoint(
              b.left + b.width / 2,
              b.bottom + 12,
            );
            return {
              sameRow: Math.abs(a.top - b.top) < 1,
              shorter: a.bottom - b.bottom,
              belowIsNeighbour:
                below?.closest(`article[data-row="${other}"]`) != null,
            };
          },
          [cardSel, neighbour] as const,
        );
        expect(
          beside,
          `${at}: the neighbour ${JSON.stringify(beside)}`,
        ).toEqual({
          sameRow: true,
          shorter: expect.any(Number),
          belowIsNeighbour: false,
        });
        expect(
          beside?.shorter,
          `${at}: ${JSON.stringify(beside)}`,
        ).toBeGreaterThan(40);

        // With the pointer on a version row, its Edit and Delete paint and
        // are where a click lands.
        await page.locator(`${row(v2)} .version-number`).hover();
        await vi.waitFor(
          async () => {
            const done = await page.evaluate(() =>
              document.getAnimations().every((x) => x.playState !== "running"),
            );
            if (!done) throw new Error(`${at}: still animating`);
          },
          { timeout: PAINT_MS, interval: 50 },
        );
        const hoverFile = join(
          SHOTS,
          `library-version-hover-${size.width}x${size.height}-dark.png`,
        );
        await page.screenshot({ path: hoverFile });
        shots.push(hoverFile);
        expect(
          await shown([
            `${row(v2)} [data-action="edit"]`,
            `${row(v2)} [data-action="delete"]`,
          ]),
          `${at}: v2's Edit and Delete under the pointer`,
        ).toEqual([visible, visible]);
        await page.mouse.move(0, 0);
      }
      // The recording is really gone, by the studio's own expiry.
      expect(
        await stat(frames).then(
          () => true,
          () => false,
        ),
      ).toBe(false);
      expect(shots).toHaveLength(4);
      expect(console_.faults(), console_.lines.join("\n")).toEqual([]);
      running = null;
      expect(await studio.stop(), studio.logs.join("\n")).toBe(0);
    },
    LANE_MS,
  );

  // The split tool (spec 2026-10-22, and the mockup the author approved):
  // the take PLAIN seeds with a removed piece opens with a join at the very
  // end of its clip, a dot above the lane centred on its line, and the
  // piece's edge where the tail trim was; ⌘B splits the clip into two
  // rounded pieces with a gap, each lit on its own; the dot opens a card
  // that restores. Each asserted on the painted page, and shot.
  it.runIf(process.platform === "darwin")(
    "shoots split pieces, a join's dot and its card, each asserted on its paint",
    async () => {
      const home = await mkdtemp(join(tmpdir(), "studio-shots-split-"));
      homes.push(home);
      await seedHome(home);
      await mkdir(SHOTS, { recursive: true });
      const cutTake = PLAIN.find((t) => (t.cuts ?? []).length > 0);
      if (cutTake === undefined)
        throw new Error("PLAIN has no take with a cut");
      const studio = await startStudio(home, join(home, "out"));
      running = studio;
      const opened = await api(studio, "/api/window", {
        method: "POST",
        body: {},
      });
      expect(opened.status, `${opened.text}\n${studio.logs.join("\n")}`).toBe(
        200,
      );
      const context = studio.context();
      const page = context.pages()[0] as Page;
      const console_ = watchConsole(page);
      await sizeWindow(context, page, 1280, 720);
      await openPage(page, studio, "editor", cutTake.id, new Set());

      /** An element's box, the clip track's, whether the pointer would hit
       *  it at its centre, and the colour it means to paint. */
      const probe = (selector: string, pseudo: string | null = null) =>
        page.evaluate(
          ({ sel, pseudo }) => {
            const node = document.querySelector<HTMLElement>(sel);
            if (node === null) return null;
            const r = node.getBoundingClientRect();
            const t = document
              .querySelector('[data-track="clip"]')
              ?.getBoundingClientRect();
            const cx = r.left + r.width / 2;
            const cy = r.top + r.height / 2;
            const hit = document.elementFromPoint(cx, cy);
            return {
              left: r.left,
              right: r.right,
              top: r.top,
              bottom: r.bottom,
              cx,
              cy,
              trackTop: t?.top ?? 0,
              trackBottom: t?.bottom ?? 0,
              onTop: hit === node || node.contains(hit),
              hit: hit?.outerHTML.slice(0, 120) ?? null,
              paint: getComputedStyle(node, pseudo).backgroundColor,
            };
          },
          { sel: selector, pseudo },
        );
      const rgbOf = (css: string): [number, number, number] => {
        const m = css.match(/\d+(\.\d+)?/g)?.map(Number) ?? [];
        return [m[0] ?? 0, m[1] ?? 0, m[2] ?? 0];
      };

      const dot = await vi.waitFor(
        async () => {
          const d = await probe("[data-join]", "::before");
          if (d === null) throw new Error("no join drawn yet");
          return d;
        },
        { timeout: PAINT_MS, interval: 100 },
      );
      const seam = await probe("[data-seam]");
      if (seam === null) throw new Error("a join with no line");
      const evidence = JSON.stringify({ dot, seam });
      // Centred on its line, at the end of the lane as anywhere else.
      expect(Math.abs(dot.cx - seam.cx), evidence).toBeLessThanOrEqual(1);
      expect(seam.right, evidence).toBeLessThanOrEqual(
        (await probe('[data-track="clip"]'))?.right ?? 0,
      );
      // Above the lane, and the one thing there to press.
      expect(dot.bottom, evidence).toBeLessThanOrEqual(dot.trackTop + 2);
      expect(dot.onTop, evidence).toBe(true);
      // Painted: the dot's middle and the line's top are the join's orange.
      const orange = rgbOf(dot.paint);
      const [dotPx, seamPx] = await pixelsAt(page, [
        [dot.cx, dot.cy],
        [seam.cx, seam.top + 3],
      ]);
      expect(distance(dotPx ?? [0, 0, 0], orange), evidence).toBeLessThan(40);
      expect(distance(seamPx ?? [0, 0, 0], orange), evidence).toBeLessThan(90);
      // Frames removed at the end: the piece's edge is there, not the trim.
      expect(await page.locator('[data-trim="tail"]').count()).toBe(0);
      expect(await page.locator('[data-edge="end"]').count()).toBe(1);

      const tool = await probe("[data-timeline-tools] [data-split-tool]");
      expect(tool, "the Split button, as painted").toMatchObject({
        onTop: true,
      });

      // Off the take's start, then ⌘B: two pieces with a gap between.
      for (let i = 0; i < 2; i += 1)
        await page.keyboard.press("Shift+ArrowRight");
      await page.keyboard.press("Meta+b");
      await vi.waitFor(
        async () => {
          if ((await page.locator(".piece-wrap").count()) !== 2)
            throw new Error("not split yet");
        },
        { timeout: PAINT_MS, interval: 100 },
      );
      // A second split, so there is a piece in the middle.
      for (let i = 0; i < 2; i += 1)
        await page.keyboard.press("Shift+ArrowRight");
      await page.keyboard.press("Meta+b");
      await vi.waitFor(
        async () => {
          const n = await page.locator(".piece-wrap").count();
          if (n !== 3) throw new Error(`${n} pieces, not 3`);
        },
        { timeout: PAINT_MS, interval: 100 },
      );
      const first = await probe(".piece-wrap:first-child .piece");
      const second = await probe(".piece-wrap:nth-child(2) .piece");
      if (first === null || second === null) throw new Error("no pieces");
      const pieces = JSON.stringify({ first, second });
      expect(second.left - first.right, pieces).toBeGreaterThanOrEqual(1.5);
      const midY = (first.top + first.bottom) / 2;
      const gapX = (first.right + second.left) / 2;
      // Pointer on the first piece: it lights, the second does not.
      await page.mouse.move(first.left + 30, first.top + 4);
      await vi.waitFor(
        async () => {
          const lit = await probe(".piece-wrap:first-child .piece");
          if (lit?.paint === first.paint) {
            throw new Error(`not lit yet: ${JSON.stringify(lit)}`);
          }
        },
        { timeout: PAINT_MS, interval: 50 },
      );
      const [litPx, unlitPx, gapPx] = await pixelsAt(page, [
        [first.left + 20, first.top + 4],
        [second.right - 20, second.top + 4],
        [gapX, midY - 8],
      ]);
      const painted = JSON.stringify({ litPx, unlitPx, gapPx, pieces });
      expect(
        distance(litPx ?? [0, 0, 0], unlitPx ?? [0, 0, 0]),
        `only the hovered piece lights: ${painted}`,
      ).toBeGreaterThan(6);
      expect(
        distance(gapPx ?? [0, 0, 0], unlitPx ?? [0, 0, 0]),
        `the gap between pieces is not a piece's fill: ${painted}`,
      ).toBeGreaterThan(6);

      // Pointer on the middle piece: its own edges show, and nothing of the
      // end pieces' — not their edges, not the trim (the author, 2026-10-22).
      const middle = await probe(".piece-wrap:nth-child(2) .piece");
      if (middle === null) throw new Error("no middle piece");
      await page.mouse.move((middle.left + middle.right) / 2, middle.top + 4);
      const shown = () =>
        page.evaluate(() =>
          Object.fromEntries(
            [
              [
                "middle start",
                '.piece-wrap:nth-child(2) > [data-edge="start"]',
              ],
              ["middle end", '.piece-wrap:nth-child(2) > [data-edge="end"]'],
              ["first end", '.piece-wrap:first-child > [data-edge="end"]'],
              ["head trim", '[data-trim="head"]'],
            ].map(([name, sel]) => {
              const n = document.querySelector(sel as string);
              return [name, n === null ? null : getComputedStyle(n).opacity];
            }),
          ),
        );
      await vi.waitFor(
        async () => {
          const o = await shown();
          if (o["middle start"] !== "1" || o["head trim"] !== "0")
            throw new Error(`still changing: ${JSON.stringify(o)}`);
        },
        { timeout: PAINT_MS, interval: 50 },
      );
      expect(await shown()).toEqual({
        "middle start": "1",
        "middle end": "1",
        "first end": "0",
        "head trim": "0",
      });

      await page.screenshot({
        path: join(SHOTS, "editor-split-1280x720-dark.png"),
      });

      // The dot opens a card, inside the window, and its Restore restores.
      await page.mouse.move(dot.cx, dot.cy);
      await page.mouse.down();
      await page.mouse.up();
      const card = await vi.waitFor(
        async () => {
          const c = await probe("[data-join-card]");
          if (c === null) throw new Error("no card yet");
          return c;
        },
        { timeout: PAINT_MS, interval: 100 },
      );
      const box = JSON.stringify(card);
      // Whole, inside the window and above its dot: nothing clips it.
      expect(card.left, box).toBeGreaterThanOrEqual(0);
      expect(card.top, box).toBeGreaterThanOrEqual(0);
      expect(card.right, box).toBeLessThanOrEqual(1280);
      expect(card.bottom, box).toBeLessThanOrEqual(dot.top);
      const title = await probe("[data-join-card] b");
      expect(
        title?.onTop,
        `the card's title is not covered: ${JSON.stringify(title)}`,
      ).toBe(true);
      expect(await page.locator("[data-join-card]").innerText()).toMatch(
        /removed/,
      );
      const restore = await probe("[data-join-card] [data-restore]");
      expect(restore?.onTop, JSON.stringify(restore)).toBe(true);
      await page.screenshot({
        path: join(SHOTS, "editor-split-card-1280x720-dark.png"),
      });
      await page.locator("[data-join-card] [data-restore]").click();
      await vi.waitFor(
        async () => {
          if ((await page.locator("[data-join]").count()) !== 0) {
            throw new Error("the join is still drawn");
          }
        },
        { timeout: PAINT_MS, interval: 100 },
      );
      expect(console_.faults(), console_.lines.join("\n")).toEqual([]);
      running = null;
      expect(await studio.stop(), studio.logs.join("\n")).toBe(0);
    },
    LANE_MS,
  );

  // The Wallpaper style (spec 2026-10-28, "Editor and Brand kit UI"): the
  // editor's Background panel on vivid-1, at 1280x800 and below full screen
  // at 1280x720, and the Brand kit page on a kit on dark-1. Asserted on the
  // paint: each of the ten tiles shows its thumbnail (a thumbnail that did
  // not load paints the tile's one fill), the chosen tile's ring shows in
  // the gap around it, and the preview's background is the wallpaper, not
  // the neutral the compositor paints when it has no image.
  it.runIf(process.platform === "darwin")(
    "shoots the Wallpaper grid in the Background panel and on the Brand kit page, each asserted on its paint",
    async () => {
      const home = await mkdtemp(join(tmpdir(), "studio-shots-wallpaper-"));
      homes.push(home);
      const { editorTake } = await seedHome(home);
      await mkdir(SHOTS, { recursive: true });
      const library = createLibrary(home);
      const scene = await library.getScene(editorTake);
      if (scene === null) throw new Error("the seeded take did not read back");
      await library.putScene({
        ...scene,
        branding: {
          ...scene.branding,
          background: { kind: "wallpaper", id: "vivid-1" },
        },
      });
      // The default kit, Launch (the one the page selects), on dark-1.
      const kitsFile = join(home, "kits.json");
      const kits = JSON.parse(await readFile(kitsFile, "utf8")) as {
        kits: { id: string; branding: { background: unknown } }[];
      };
      const launch = kits.kits.find((k) => k.id === "kit-launch");
      if (launch === undefined) throw new Error("seedHome made no Launch kit");
      launch.branding.background = { kind: "wallpaper", id: "dark-1" };
      // Night on an upload that is not there: its tile has to say so.
      const night = kits.kits.find((k) => k.id === "kit-night");
      if (night === undefined) throw new Error("seedHome made no Night kit");
      night.branding.background = { kind: "image", ref: "assets/moved.webp" };
      await writeFile(kitsFile, `${JSON.stringify(kits, null, 2)}\n`);

      const studio = await startStudio(home, join(home, "out"));
      running = studio;
      const opened = await api(studio, "/api/window", {
        method: "POST",
        body: {},
      });
      expect(opened.status, `${opened.text}\n${studio.logs.join("\n")}`).toBe(
        200,
      );
      const context = studio.context();
      const page = context.pages()[0] as Page;
      const console_ = watchConsole(page);
      const thumbs = new Map<string, number>();
      page.on("response", (r) => {
        const m = /\/wallpapers\/([a-z0-9-]+)-thumb\.webp$/.exec(r.url());
        if (m !== null) thumbs.set(m[1] as string, r.status());
      });
      const neutral = [NEUTRAL_BACKGROUND.from, NEUTRAL_BACKGROUND.to].map(
        (hex) =>
          [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16)) as [
            number,
            number,
            number,
          ],
      );
      /** The grid as painted: each tile's spread of colours over a 4x3
       *  sweep inside it, and the ring colour above the pressed tile beside
       *  the same point above an unpressed one. */
      const grid = async (at: string) => {
        // Every thumbnail settled, loaded or not: a broken one must reach
        // the pixel assertion, not time out here.
        await vi.waitFor(
          async () => {
            const done = await page.evaluate(() =>
              [
                ...document.querySelectorAll<HTMLImageElement>(
                  "[data-wallpaper-id] img",
                ),
              ].map((i) => i.complete),
            );
            if (done.length !== WALLPAPERS.length || done.includes(false))
              throw new Error(`thumbnails settling: ${JSON.stringify(done)}`);
          },
          { timeout: PAINT_MS, interval: 100 },
        );
        // The whole grid in view: on Settings it sits below the fold.
        await page.locator(".wallpaper-grid").evaluate((g) =>
          // Instant: the page scrolls smoothly, and a shot mid-scroll
          // samples the tiles where they were.
          g.scrollIntoView({ block: "nearest", behavior: "instant" }),
        );
        await settle(page, at);
        const tiles = await page.evaluate(() =>
          [
            ...document.querySelectorAll<HTMLElement>(
              "button[data-wallpaper-id]",
            ),
          ].map((b) => {
            const r = b.getBoundingClientRect();
            const hit = document.elementFromPoint(
              r.left + r.width / 2,
              r.top + r.height / 2,
            );
            return {
              id: b.getAttribute("data-wallpaper-id") as string,
              pressed: b.getAttribute("aria-pressed") === "true",
              left: r.left,
              top: r.top,
              width: r.width,
              height: r.height,
              onTop: hit !== null && b.contains(hit),
              hit: hit?.outerHTML.slice(0, 80) ?? null,
            };
          }),
        );
        // The lower right of each tile: Chrome draws a broken image's icon
        // in its top left corner, which would read as a picture there.
        const sweep = tiles.flatMap((t) =>
          [0.5, 0.65, 0.8, 0.9].flatMap((fx) =>
            [0.6, 0.75, 0.9].map(
              (fy) => [t.left + t.width * fx, t.top + t.height * fy] as const,
            ),
          ),
        );
        const pressed = tiles.find((t) => t.pressed);
        const other = tiles.find((t) => !t.pressed);
        if (pressed === undefined || other === undefined)
          throw new Error(`${at}: no pressed tile ${JSON.stringify(tiles)}`);
        // The panel's own ground: the empty cell after the upload tile, the
        // grid's sixteenth of sixteen.
        const empty = await page.evaluate(() => {
          const grid = document
            .querySelector(".wallpaper-grid")
            ?.getBoundingClientRect();
          const up = document
            .querySelector("[data-wallpaper-upload]")
            ?.getBoundingClientRect();
          if (grid === undefined || up === undefined) return null;
          const x = up.right + (up.width + 8) / 2;
          return { x, y: up.top + up.height / 2, inGrid: x < grid.right };
        });
        if (empty === null || !empty.inGrid)
          throw new Error(`${at}: no empty cell after the upload tile`);
        const px = await pixelsAt(page, [
          ...sweep,
          [empty.x, empty.y],
          [pressed.left + pressed.width / 2, pressed.top - 3],
          [other.left + other.width / 2, other.top - 3],
        ]);
        const spread = tiles.map((t, i) => {
          const own = px.slice(i * 12, i * 12 + 12);
          let most = 0;
          for (const a of own)
            for (const b of own) most = Math.max(most, distance(a, b));
          return { id: t.id, spread: most, onTop: t.onTop, hit: t.hit };
        });
        return {
          tiles,
          spread,
          ground: px.at(-3) as [number, number, number],
          ring: px.at(-2) as [number, number, number],
          beside: px.at(-1) as [number, number, number],
        };
      };
      /** The colour a preview canvas paints in its background, at `fx`,
       *  `fy` of its box; waited on while the image is still decoding. */
      const ground = async (selector: string, fx: number, fy: number) => {
        const read = async () => {
          const r = await page.evaluate((sel) => {
            const c = document.querySelector(sel)?.getBoundingClientRect();
            return c === undefined
              ? null
              : { left: c.left, top: c.top, width: c.width, height: c.height };
          }, selector);
          if (r === null) throw new Error(`no ${selector}`);
          const [p] = await pixelsAt(page, [
            [r.left + r.width * fx, r.top + r.height * fy],
          ]);
          return p as [number, number, number];
        };
        const off = (p: [number, number, number]) =>
          Math.min(...neutral.map((n) => distance(p, n)));
        try {
          await vi.waitFor(
            async () => {
              const p = await read();
              if (off(p) <= 30) throw new Error(`still neutral: ${p}`);
            },
            { timeout: PAINT_MS, interval: 200 },
          );
        } catch {
          // Said by the assertion below, with what the page showed.
        }
        const p = await read();
        return { px: p, off: off(p) };
      };
      const checkGrid = async (at: string) => {
        const g = await grid(at);
        const evidence = JSON.stringify({ g, thumbs: [...thumbs] });
        expect(
          g.tiles.map((t) => t.id),
          `${at}: one tile per built-in`,
        ).toEqual(WALLPAPERS.map((w) => w.id));
        expect(
          g.spread.filter((t) => !t.onTop || t.spread <= 6),
          `${at}: every tile paints its thumbnail, uncovered: ${evidence}`,
        ).toEqual([]);
        // The premise of the ring check: the point beside it is the
        // panel's ground, and the ring is the ink drawn over it.
        expect(
          distance(g.beside, g.ground),
          `${at}: the point beside the ring is the panel's ground: ${evidence}`,
        ).toBeLessThanOrEqual(6);
        expect(
          distance(g.ring, g.beside),
          `${at}: the pressed tile's ring shows: ${evidence}`,
        ).toBeGreaterThan(60);
        return g;
      };

      // The editor's Background panel, at full height and below it.
      for (const size of [
        { width: 1280, height: 800 },
        { width: 1280, height: 720 },
      ]) {
        const at = `editor wallpaper ${size.width}x${size.height}`;
        await sizeWindow(context, page, size.width, size.height);
        await openPage(page, studio, "editor", editorTake, new Set());
        await page.locator('#rail [data-rail="background"]').click();
        await page.locator("[data-wallpaper-upload]").waitFor();
        await page.mouse.move(0, 0);
        const g = await checkGrid(at);
        expect(
          g.tiles.find((t) => t.pressed)?.id,
          `${at}: the take's wallpaper is the pressed tile`,
        ).toBe("vivid-1");
        // Left of the recording, mid-height: the frame's padding, and the
        // contain fit's bars beside it.
        const bg = await ground("#preview", 0.02, 0.5);
        const failure = await page.locator("#failure").innerText();
        expect(
          bg.off,
          `${at}: the preview's background is the wallpaper, not the neutral (${JSON.stringify(bg)}; failure band: ${failure})`,
        ).toBeGreaterThan(30);
        expect(failure, `${at}: nothing failed`).not.toMatch(
          /background image/i,
        );
        const p = await painted(page);
        expect(
          p.dockBand?.every((h) => h.endsWith(": dock")),
          `${at}: the band across the dock's top edge is the dock's: ${JSON.stringify(p.dockBand)}`,
        ).toBe(true);
        expect(
          p.scrollWidth,
          `${at}: no sideways scroll (${JSON.stringify(p)})`,
        ).toBeLessThanOrEqual(p.innerWidth);
        expect(await limeOutsideItsPlaces(page), `${at}: lime`).toEqual([]);
        await page.screenshot({
          path: join(
            SHOTS,
            `editor-wallpaper-${size.width}x${size.height}-dark.png`,
          ),
        });
      }

      // Blur (spec 2026-10-28, "Blur"), below full screen: the slider under
      // the grid, inside the panel and on top of it; then dragged to its end
      // by a real mouse and released, and the preview's margin, sharp
      // before, holds far less detail after.
      {
        const at = "editor wallpaper blur 1280x720";
        await page
          .locator("input[data-wallpaper-blur]")
          .evaluate((s) =>
            s.scrollIntoView({ block: "nearest", behavior: "instant" }),
          );
        await settle(page, at);
        const placed = await page.evaluate(() => {
          const s = document.querySelector<HTMLInputElement>(
            "input[data-wallpaper-blur]",
          );
          const row = s?.closest(".slider-row")?.getBoundingClientRect();
          const grid = document
            .querySelector(".wallpaper-grid")
            ?.getBoundingClientRect();
          if (s === null || row === undefined || grid === undefined)
            return null;
          const r = s.getBoundingClientRect();
          const hit = document.elementFromPoint(
            r.left + r.width / 2,
            r.top + r.height / 2,
          );
          return {
            value: s.value,
            row: {
              top: row.top,
              bottom: row.bottom,
              left: row.left,
              right: row.right,
            },
            grid: { bottom: grid.bottom, left: grid.left, right: grid.right },
            slider: { left: r.left, right: r.right, y: r.top + r.height / 2 },
            onTop: hit === s,
            innerHeight,
          };
        });
        if (placed === null) throw new Error(`${at}: no Blur slider`);
        const said = JSON.stringify(placed);
        // The take on vivid-1 with no blur saved: sharp, at 0.
        expect(placed.value, said).toBe("0");
        expect(placed.onTop, `${at}: the slider is on top: ${said}`).toBe(true);
        expect(
          placed.row.top,
          `${at}: under the grid: ${said}`,
        ).toBeGreaterThanOrEqual(placed.grid.bottom);
        expect(placed.row.left, said).toBeGreaterThanOrEqual(
          placed.grid.left - 1,
        );
        expect(placed.row.right, said).toBeLessThanOrEqual(
          placed.grid.right + 1,
        );
        expect(
          placed.row.bottom,
          `${at}: in view: ${said}`,
        ).toBeLessThanOrEqual(placed.innerHeight);
        /** The preview's margin as painted: the summed second difference of
         *  grey along its left edge and its top, sampled every 2 CSS px. */
        const marginDetail = async () => {
          const r = await page.evaluate(() => {
            const c = document
              .querySelector("#preview")
              ?.getBoundingClientRect();
            return c === undefined
              ? null
              : { left: c.left, top: c.top, width: c.width, height: c.height };
          });
          if (r === null) throw new Error(`${at}: no #preview`);
          const column: [number, number][] = [];
          for (
            let y = r.top + r.height * 0.05;
            y < r.top + r.height * 0.95;
            y += 2
          )
            column.push([r.left + r.width * 0.02, y]);
          const row: [number, number][] = [];
          for (
            let x = r.left + r.width * 0.05;
            x < r.left + r.width * 0.95;
            x += 2
          )
            row.push([x, r.top + r.height * 0.02]);
          const px = await pixelsAt(page, [...column, ...row]);
          const grey = px.map(([a, b, c]) => (a + b + c) / 3);
          let sum = 0;
          for (const [from, to] of [
            [0, column.length],
            [column.length, grey.length],
          ] as const)
            for (let i = from + 1; i < to - 1; i++)
              sum += Math.abs(
                (grey[i - 1] as number) +
                  (grey[i + 1] as number) -
                  2 * (grey[i] as number),
              );
          return sum;
        };
        const sharp = await marginDetail();
        // A frame-time log across the drag: what the author's pointer feels
        // (reported, not asserted: a headless frame clock is no hand's).
        await page.evaluate(() => {
          const w = window as unknown as {
            __frames: number[];
            __stop: boolean;
          };
          w.__frames = [];
          w.__stop = false;
          let last = performance.now();
          const tick = (now: number) => {
            w.__frames.push(now - last);
            last = now;
            if (!w.__stop) requestAnimationFrame(tick);
          };
          requestAnimationFrame(tick);
        });
        await page.mouse.move(placed.slider.left + 4, placed.slider.y);
        await page.mouse.down();
        // Half way, held: the preview follows the drag before any commit.
        const half =
          placed.slider.left + (placed.slider.right - placed.slider.left) / 2;
        for (let i = 1; i <= 30; i++) {
          await page.mouse.move(
            placed.slider.left + 4 + ((half - placed.slider.left - 4) * i) / 30,
            placed.slider.y,
          );
          // One move a frame, as a hand moves: each `input` its own preview.
          await page.evaluate(
            () =>
              new Promise((done) => requestAnimationFrame(() => done(null))),
          );
        }
        // Read before any screenshot, which stalls frames of its own.
        const frames = await page.evaluate(() => {
          const w = window as unknown as {
            __frames: number[];
            __stop: boolean;
          };
          w.__stop = true;
          return w.__frames;
        });
        const midDrag = await vi.waitFor(
          async () => {
            const d = await marginDetail();
            if (d >= sharp * 0.8)
              throw new Error(
                `${at}: mid-drag margin still sharp: ${d} of ${sharp}`,
              );
            return d;
          },
          { timeout: PAINT_MS, interval: 100 },
        );
        await page.mouse.move(placed.slider.right + 20, placed.slider.y, {
          steps: 10,
        });
        await page.mouse.up();
        await vi.waitFor(
          async () => {
            const v = await page
              .locator("input[data-wallpaper-blur]")
              .evaluate((s) => (s as HTMLInputElement).value);
            if (v !== "1") throw new Error(`${at}: the slider reads ${v}`);
          },
          { timeout: PAINT_MS, interval: 100 },
        );
        await settle(page, at);
        const blurred = await marginDetail();
        const sorted = [...frames].sort((a, b) => a - b);
        const evidence = JSON.stringify({
          sharp,
          midDrag,
          blurred,
          frames: frames.length,
          medianFrameMs: sorted[Math.floor(sorted.length / 2)],
          worstFrameMs: sorted.at(-1),
        });
        console.info(`${at}: ${evidence}`);
        // The fixture: the sharp margin crosses vivid-1's band edges.
        expect(sharp, evidence).toBeGreaterThan(200);
        expect(
          blurred,
          `${at}: the margin is blurred: ${evidence}`,
        ).toBeLessThan(sharp * 0.5);
        expect(await page.locator("#failure").innerText(), at).not.toMatch(
          /background image/i,
        );
        await page.screenshot({
          path: join(SHOTS, "editor-wallpaper-blur-1280x720-dark.png"),
        });
        // The panel close up: the grid and the slider under it.
        await page
          .locator('.branding-group[data-group="background"]')
          .screenshot({
            path: join(SHOTS, "editor-wallpaper-blur-panel-1280x720-dark.png"),
          });
      }

      // The Brand kit page, its default kit on dark-1.
      await sizeWindow(context, page, 1280, 800);
      await openPage(page, studio, "kits", editorTake, new Set());
      const at = "kits wallpaper 1280x800";
      const g = await checkGrid(at);
      expect(g.tiles.find((t) => t.pressed)?.id, at).toBe("dark-1");
      const hero = await ground("[data-preview-kit]", 0.02, 0.2);
      expect(
        hero.off,
        `${at}: the kit's preview is the wallpaper, not the neutral (${JSON.stringify(hero)})`,
      ).toBeGreaterThan(30);
      expect(
        await page.locator("[data-wallpaper-error]").count(),
        `${at}: no load error`,
      ).toBe(0);
      // Night's image did not load: its tile carries the alert, painted on
      // top of the neutral it shows instead, and names why.
      const alert = page.locator(
        '[data-kit-tile="kit-night"] [data-kit-thumb-alert]',
      );
      await alert.waitFor({ timeout: PAINT_MS });
      const alertPaint = await alert.evaluate((a) => {
        const r = a.getBoundingClientRect();
        const hit = document.elementFromPoint(
          r.left + r.width / 2,
          r.top + r.height / 2,
        );
        return {
          onTop: hit !== null && a.contains(hit),
          label: a.getAttribute("aria-label") ?? "",
          width: r.width,
        };
      });
      expect(alertPaint.onTop, JSON.stringify(alertPaint)).toBe(true);
      expect(alertPaint.label).toContain("assets/moved.webp");
      await alert.evaluate((a) =>
        a.scrollIntoView({ block: "center", behavior: "instant" }),
      );
      await page.screenshot({
        path: join(SHOTS, "kits-wallpaper-strip-1280x800-dark.png"),
      });
      const p = await painted(page);
      expect(
        p.scrollWidth,
        `${at}: no sideways scroll (${JSON.stringify(p)})`,
      ).toBeLessThanOrEqual(p.innerWidth);
      await page.screenshot({
        path: join(SHOTS, "kits-wallpaper-1280x800-dark.png"),
      });
      // The tiles' pictures came from the pages' own folder.
      expect(
        [...thumbs.entries()].filter(([, status]) => status >= 400),
        JSON.stringify([...thumbs]),
      ).toEqual([]);
      // Night's missing image is the one fault this home was built to have.
      expect(
        console_
          .faults()
          .filter((l) => !/\/api\/wallpaper\?ref=assets%2Fmoved\.webp/.test(l)),
        console_.lines.join("\n"),
      ).toEqual([]);
      running = null;
      expect(await studio.stop(), studio.logs.join("\n")).toBe(0);
    },
    LANE_MS,
  );

  // The take an agent asked for while a kit save was in flight, and the
  // save failed: Settings stays (leaving would take the failure out of
  // view), and the notice offers the take. The save is held at the route
  // until the page says it is waiting on it, so the open is sure to land
  // inside it; the home is then made read-only, so the studio's own write
  // is what refuses. Two shots, Details closed and open, each asserted on its paint,
  // then the button is pressed and has to open the take.
  it(
    "shoots Settings offering a take it did not open because a kit save failed",
    async () => {
      const home = await mkdtemp(join(tmpdir(), "studio-shots-offer-"));
      homes.push(home);
      const { editorTake } = await seedHome(home);
      await mkdir(SHOTS, { recursive: true });
      const studio = await startStudio(home, join(home, "out"));
      running = studio;
      const opened = await api(studio, "/api/window", {
        method: "POST",
        body: {},
      });
      expect(opened.status, opened.text).toBe(200);
      const context = studio.context();
      const page = context.pages()[0] as Page;
      const console_ = watchConsole(page);
      await sizeWindow(context, page, 1280, 720);
      await openPage(page, studio, "kits", editorTake, new Set());

      // 1. New kit, its save held at the route.
      let held: Route | null = null;
      await page.route(`${studio.origin}/api/kits`, async (route) => {
        if (route.request().method() !== "PUT") {
          await route.continue();
          return;
        }
        held = route;
      });
      await page.locator("[data-kit-new]").click();
      await vi.waitFor(
        () => {
          if (held === null) throw new Error("the kit save never left");
        },
        { timeout: PAINT_MS, interval: 20 },
      );

      // 2. The agent's second `npx demoman studio <take>`, while it is
      // held. The studio says it was opened; the page says it is waiting.
      const asked = await api(studio, "/api/window", {
        method: "POST",
        body: { takeId: editorTake },
      });
      expect(asked.status, asked.text).toBe(200);
      const path = `/editor.html?scene=${editorTake}`;
      await vi.waitFor(
        () => {
          const line = console_.lines.find((l) =>
            l.includes(`asked to open ${path}; waiting for`),
          );
          if (line === undefined) {
            throw new Error(
              `the page never said it was waiting: ${console_.lines.join("\n")}`,
            );
          }
        },
        { timeout: PAINT_MS, interval: 20 },
      );

      // 3. The save, let through to a home it cannot write.
      await chmod(home, 0o555);
      try {
        await (held as Route | null)?.continue();
        await vi.waitFor(
          async () => {
            const p = await offerPaint(page);
            if (p?.button == null) {
              throw new Error(`no offer yet: ${JSON.stringify(p)}`);
            }
          },
          { timeout: PAINT_MS, interval: 50 },
        );
      } finally {
        await chmod(home, 0o755);
      }
      // The premise: the save really failed at the studio, and nothing
      // has left the page.
      expect(page.url()).toBe(`${studio.origin}/settings.html`);
      expect(
        console_.lines.some((l) => l.startsWith("response: 500 PUT")),
        console_.lines.join("\n"),
      ).toBe(true);

      for (const theme of THEMES) {
        await settle(page, "kits");
        const at = `offer 1280x720 ${theme}`;
        await page.screenshot({
          path: join(SHOTS, `kits-offer-1280x720-${theme}.png`),
        });
        const shown = {
          hit: true,
          insideNotice: true,
          onScreen: true,
          opacity: 1,
        };
        const offer = await offerPaint(page);
        const said = `${at}: ${JSON.stringify(offer)}`;
        // The fault as a short title, its words behind Details (in the
        // page, not drawn), and the offer beneath.
        expect(offer?.title, said).toMatchObject({
          text: "Couldn't add a kit",
          ...shown,
        });
        expect(offer?.detailsOpen, said).toBe(false);
        expect(offer?.reasonText, said).toMatch(/The kits were not saved/);
        expect(offer?.button, said).toMatchObject({
          text: "Open the take",
          ...shown,
        });
        // Compact: the button at the end of the title's row, not on a row
        // of its own. Red with `.notice-actions` back inside the body:
        // its centre then sits a row below the title's.
        expect(
          Math.abs((offer?.button?.midY ?? 0) - (offer?.title?.midY ?? 999)),
          `${said}: the button on the title's row`,
        ).toBeLessThanOrEqual(2);

        // Details, opened: the reason is drawn inside the notice.
        await page.locator("#notice .notice-details > summary").click();
        await settle(page, "kits");
        await page.screenshot({
          path: join(SHOTS, `kits-offer-details-1280x720-${theme}.png`),
        });
        const opened = await offerPaint(page);
        const openSaid = `${at}, Details open: ${JSON.stringify(opened)}`;
        expect(opened?.detailsOpen, openSaid).toBe(true);
        expect(opened?.reason, openSaid).toMatchObject(shown);
        expect(opened?.reason?.text, openSaid).toMatch(
          /The kits were not saved/,
        );
        expect(opened?.button, openSaid).toMatchObject(shown);
        await page.locator("#notice .notice-details > summary").click();
        const p = await painted(page);
        expect(p.theme, `${at}: the page's theme`).toBe(theme);
        expect(await limeOutsideItsPlaces(page), `${at}: lime`).toEqual([]);
        // A fault says it is one: the error notice's glyph in --danger (the
        // studio strips the tint, so the glyph is where the colour is).
        expect(
          await page
            .locator("#notice > svg")
            .first()
            .evaluate((e) => getComputedStyle(e).color),
          `${at}: the notice's glyph`,
        ).toBe("rgb(248, 113, 113)");
        expect(p.scrollWidth, `${at}: no sideways scroll`).toBeLessThanOrEqual(
          p.innerWidth,
        );
        const lum = luminance(p.bg);
        expect(
          lum,
          `${at}: the body (${p.bg}) is the near-black ground`,
        ).toBeLessThan(0.01);
      }

      // 4. The button opens what was asked for.
      await page.locator("#notice [data-open-asked]").click();
      await page.waitForURL(`${studio.origin}${path}`, {
        timeout: PAINT_MS,
      });

      // The faults are the refused save's and nothing else: the 500, the
      // browser's line for it, and the page's own report. Off macOS, also
      // the editor's previews: the studio makes them with sips, which only
      // macOS has, so the editor step 4 opens is answered 500 for them —
      // before this line or after it, as the machine's speed falls (CI,
      // 2026-10-18). The screenshot set above runs on macOS alone for the
      // same reason.
      const noSips = process.platform !== "darwin";
      const faults = console_
        .faults()
        .filter(
          (l) =>
            !l.startsWith("response: 500 PUT") &&
            !/status of 500/.test(l) &&
            !l.includes("demoman settings: add a kit") &&
            !(noSips && /^response: 500 GET \S+\/thumbs\//.test(l)),
        );
      expect(faults, console_.lines.join("\n")).toEqual([]);
      running = null;
      expect(await studio.stop(), studio.logs.join("\n")).toBe(0);
    },
    LANE_MS,
  );
});

import { execFileSync } from "node:child_process";
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
import {
  LEGACY_FLOWS_DIR as KEPT_DIR,
  type KeptVideo,
  keptFileName,
  serializeKept,
} from "@demoman/run-core";
import { createLibrary, createVideoStore } from "@demoman/runner/studio";
import { NEUTRAL_BACKGROUND, WALLPAPERS } from "@demoman/scene-schema";
import {
  DEFAULT_LIBRARY_VIEW,
  type LibraryViewChoice,
  pathFor,
  placeSearch,
  type TakesAnswer,
} from "@demoman/studio-protocol";
import type { Page, Route } from "playwright";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  distance,
  limeOutsideItsPlaces,
  luma,
  pixelsAt,
} from "./look-probes.js";
import type { PlainTake } from "./painted-take.js";
import {
  api,
  pageEvidence,
  type Studio,
  sizeWindow,
  startStudio,
  watchConsole,
} from "./studio-harness.js";
import {
  GRID_VIEW,
  joinVideo,
  ONE_VERSION_EXPORT,
  openPage,
  PAINT_MS,
  PLAIN,
  painted,
  seedHome,
  settle,
  storeLibraryView,
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
// save failed: the notice and its "Open the video", with Details closed and
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
 *  (open or not, and the reason inside), and the "Open the video" button —
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

const ACME = "github.com/acme/web";
const GLOBEX = "github.com/globex/api";
const LOCAL = "local:/Users/me/scratch";
/** The word only the globex flow's steps hold: its last button's name. */
const SEARCHED = "ledger";
/** The globex flow's name: wider than the name's floor beside a why. */
const GLOBEX_NAME = "Filter the open invoices by customer";
/** The checkout button's name: its step is wider than the name cell, so
 *  the why starts at SEARCHED (`whyOf`), and runs on past the cap after it,
 *  so the name is held at its floor. */
const RECONCILE = `Reconcile the ${SEARCHED} against the open invoices`;

/** The projects home: acme/web's two flows (the invoice one kept in a real
 *  checkout), globex/api's one, an unpushed repo's one, flows in no
 *  project, and the folder that would not read. */
async function seedProjects(): Promise<{
  home: string;
  invoice: string;
  globex: string;
}> {
  const home = await mkdtemp(join(tmpdir(), "studio-shots-projects-"));
  homes.push(home);
  const checkout = await mkdtemp(join(tmpdir(), "studio-shots-projrepo-"));
  homes.push(checkout);
  // A real checkout of acme/web, as a kept mark's key is read from its
  // root: the upkeep reads it again to follow a moved repo, and a root
  // that is no checkout would be a "Couldn't read" row of its own.
  for (const args of [
    ["init", "-q"],
    ["remote", "add", "origin", "git@github.com:acme/web.git"],
  ])
    execFileSync("git", args, { cwd: checkout, stdio: "pipe" });
  await seedHome(home, VIDEO_TAKES);
  const invoice = await joinVideo(home);
  const library = createLibrary(home);
  const store = createVideoStore(home, library);
  // A second owner's project: one flow of one take.
  const lone = (PLAIN[0] as PlainTake).id;
  const made = await store.create({
    // Long enough that, beside the search's why, it is cut at its floor.
    name: GLOBEX_NAME,
    repo: { key: GLOBEX },
    startPage: "https://app.example.com/",
  });
  if (!made.ok) throw new Error("the globex flow could not be made");
  // Its checkout button named for itself, so one flow's steps hold a word
  // (SEARCHED) no other flow has; renamed before it joins, at its revision.
  const scene = await library.getScene(lone);
  if (scene === null) throw new Error(`${lone} was not seeded`);
  await library.putScene({
    ...scene,
    anchors: scene.anchors.map((a) =>
      a.id === "a-checkout"
        ? {
            ...a,
            fingerprint: {
              ...a.fingerprint,
              accessibleName: RECONCILE,
            },
          }
        : a,
    ),
  });
  const read = await library.getSceneRead(lone);
  expect(read, `premise: ${lone} was seeded`).not.toBeNull();
  await library.putJson(lone, "status.json", { outcome: "complete" });
  await store.join(lone, {
    videoId: made.video.id,
    made: {
      repo: { none: "seeded" },
      agent: { none: "seeded" },
      by: { none: "seeded" },
      door: "mcp",
    },
    recordedRevision: read?.revision ?? null,
  });
  // An unpushed repo: one flow of one more take, keyed by its folder.
  const loneLocal = (PLAIN[1] as PlainTake).id;
  const scratch = await store.create({
    name: "Scratch",
    repo: { key: LOCAL },
    startPage: "https://app.example.com/",
  });
  if (!scratch.ok) throw new Error("the local flow could not be made");
  const readLocal = await library.getSceneRead(loneLocal);
  expect(readLocal, `premise: ${loneLocal} was seeded`).not.toBeNull();
  await library.putJson(loneLocal, "status.json", { outcome: "complete" });
  await store.join(loneLocal, {
    videoId: scratch.video.id,
    made: {
      repo: { none: "seeded" },
      agent: { none: "seeded" },
      by: { none: "seeded" },
      door: "mcp",
    },
    recordedRevision: readLocal?.revision ?? null,
  });
  // The invoice flow is kept in acme/web: one flow on each of its tabs.
  const file = `${KEPT_DIR}/${keptFileName("Create an invoice")}`;
  await mkdir(join(checkout, KEPT_DIR), { recursive: true });
  await writeFile(
    join(checkout, file),
    serializeKept({
      keptVersion: 2,
      flow: invoice,
      deliver: "files",
      name: "Create an invoice",
      script: {
        scriptVersion: 1,
        name: "Create an invoice",
        target: "https://app.example.com/",
        viewport: { width: 1280, height: 800 },
        steps: [{ do: "waitForLoad" }],
      } as KeptVideo["script"],
      scale: 1,
      logo: null,
      wallpaper: null,
      outputs: [
        {
          path: "o.mp4",
          fileType: "mp4",
          aspect: "16:9",
          quality: "share",
        },
      ],
      report: null,
    } satisfies KeptVideo),
  );
  expect(
    (await store.setKept(invoice, { root: checkout, file, key: ACME })).ok,
    "premise: the invoice flow is marked kept",
  ).toBe(true);
  return { home, invoice, globex: made.video.id };
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
              // The rail (the jump list until 2026-11-01): All flows, the
              // takes in no project, then the folder that would not read,
              // each painted.
              expect(
                p.rail,
                `${at}: the rail ${JSON.stringify(p.rail)}`,
              ).toEqual([
                { text: `All flows ${ids.length}`, painted: true },
                { text: `No project ${ids.length}`, painted: true },
                { text: "Couldn't read 1", painted: true },
              ]);

              // The unreadable row, in its own place (by its address: a
              // rail click would save the pick): it gets a shot of its own.
              await page.goto(`${studio.origin}/?project=unreadable`);
              await page
                .locator(`[data-unreadable-row="${UNREADABLE}"]`)
                .waitFor();
              await settle(page, at);
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
      // Export's Files ticked by a real pointer (2026-10-30): one press
      // makes every ticked file. Red if a click on a row does not tick it,
      // or the button does not name what the press will make.
      await sizeWindow(context, page, 1440, 900);
      await openPage(page, studio, "editor", editorTake, thumbs);
      await page.locator('[data-file-type="gif"]').click();
      await page.locator('[data-file-type="stills"]').click();
      const files = await page.evaluate(() => ({
        ticked: [
          ...document.querySelectorAll<HTMLInputElement>("[data-file-type]"),
        ]
          .filter((b) => b.checked)
          .map((b) => b.dataset.fileType),
        button: document.querySelector("[data-export-start]")?.textContent,
      }));
      expect(files, "editor: the Files rows after two clicks").toEqual({
        ticked: ["mp4", "gif", "stills"],
        button: "Export MP4 + GIF + stills",
      });
      const ticked = join(SHOTS, "editor-export-files-1440x900-dark.png");
      await page.screenshot({ path: ticked });
      shots.push(ticked);
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
      expect(shots).toHaveLength(11);
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
          [v3, "Video 3"],
          [v2, "Video 2"],
          [v1, "Video 1"],
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
        expect(expired?.line, said).toContain(
          "Expired — ask your agent to film it again",
        );
        // The call names the flow, which a run films again; never the
        // video, which the runner refuses.
        expect(expired?.line, said).toContain(
          `run({ flow: { id: "${videoId}" } })`,
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

  // The library's list (spec 2026-10-31-library-list-view §6), the view a
  // studio with nothing stored draws: at both sizes the list as it opens, a
  // flow of three videos opened, a flow ticked, and a sort by size (no
  // headings); then the list in a 720-wide window. Each asserted on its
  // paint; the accessibility tree read once, as a screen reader gets it
  // (§5 item 17), with the snapshot written beside the shots.
  it.runIf(process.platform === "darwin")(
    "shoots the list as it opens, a flow opened, a flow ticked, a flat sort and a narrow window, each asserted on its paint",
    async () => {
      const home = await mkdtemp(join(tmpdir(), "studio-shots-list-"));
      homes.push(home);
      await seedHome(home, VIDEO_TAKES);
      const invoice = await joinVideo(home);
      await mkdir(SHOTS, { recursive: true });
      const [v1, v2, v3] = VIDEO_TAKES.map((t) => t.id) as [
        string,
        string,
        string,
      ];
      const studio = await startStudio(home, join(home, "out"));
      running = studio;
      // The premise: nothing is stored, so the studio serves its default.
      const served = await api(studio, "/api/settings/library-view");
      expect(served.status, served.text).toBe(200);
      expect(served.json()).toEqual({ view: DEFAULT_LIBRARY_VIEW });
      expect(DEFAULT_LIBRARY_VIEW.layout).toBe("list");
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
      const flowRow = (id: string) => `[data-list] [data-flow="${id}"]`;
      const videoRow = (id: string) => `[data-list] [data-video-row="${id}"]`;
      /** Each shown row under `sel` as painted: its label, on screen, and
       *  the point at its name cell's centre its own. */
      const rowsPainted = (sel: string) =>
        page.evaluate((s) => {
          return [...document.querySelectorAll<HTMLElement>(s)]
            .filter((r) => !r.hidden)
            .map((r) => {
              const cell = r.querySelector('[data-col="name"]') ?? r;
              const b = cell.getBoundingClientRect();
              const hit = document.elementFromPoint(
                b.left + Math.min(b.width / 2, 40),
                b.top + b.height / 2,
              );
              return {
                label: r.getAttribute("aria-label"),
                onScreen: b.height > 0 && b.top >= 0 && b.bottom <= innerHeight,
                hit: hit !== null && r.contains(hit),
              };
            });
        }, sel);
      /** Where each column heading starts, as painted. */
      const columnsAt = () =>
        page.evaluate(() =>
          [
            ...document.querySelectorAll<HTMLElement>(
              "[data-list-head] [role=columnheader]",
            ),
          ].map(
            (h) =>
              `${h.dataset.col} ${Math.round(h.getBoundingClientRect().left)}`,
          ),
        );
      const allPainted = (rows: { onScreen: boolean; hit: boolean }[]) =>
        rows.every((r) => r.onScreen && r.hit);
      /** The flows (and takes in no flow) the list shows. */
      const FLOWS = "[data-list] [role=row][data-scene]:not([data-video-row])";
      /** Opens the library and waits for the list, its flows and their
       *  lengths painted. */
      const openList = async (at: string) => {
        await page.goto(`${studio.origin}/`);
        try {
          await vi.waitFor(
            async () => {
              const cards = await page
                .locator("article.card[data-row]")
                .count();
              const rows = await rowsPainted(FLOWS);
              if (cards !== 0 || rows.length < 4 || !allPainted(rows)) {
                throw new Error(`${cards} cards; rows ${JSON.stringify(rows)}`);
              }
              const unmeasured = await page.evaluate(
                (s) =>
                  [...document.querySelectorAll<HTMLElement>(s)]
                    .filter((r) => !r.hidden)
                    .filter(
                      (r) =>
                        (r.querySelector('[data-col="length"]')?.textContent ??
                          "") === "",
                    )
                    .map((r) => r.getAttribute("aria-label")),
                FLOWS,
              );
              if (unmeasured.length > 0) {
                throw new Error(
                  `lengths not painted: ${unmeasured.join(", ")}`,
                );
              }
            },
            { timeout: PAINT_MS, interval: 100 },
          );
        } catch (error) {
          throw new Error(
            `${at}: the list did not paint: ${String(error)}; page: ${await pageEvidence(page)}; log: ${studio.logs.join("\n")}`,
          );
        }
        await page.mouse.move(0, 0);
        await settle(page, at);
      };
      /** The shot, and what every list shot is asserted on. */
      const shoot = async (name: string, at: string) => {
        const file = join(SHOTS, `${name}-dark.png`);
        await page.screenshot({ path: file });
        shots.push(file);
        const p = await painted(page);
        expect(p.theme, `${at}: the page's theme`).toBe("dark");
        expect(
          p.scrollWidth,
          `${at}: no sideways scroll (${JSON.stringify(p)})`,
        ).toBeLessThanOrEqual(p.innerWidth);
        expect(await page.locator("[role=treegrid]").count(), at).toBe(1);
        expect(await limeOutsideItsPlaces(page), `${at}: lime`).toEqual([]);
      };

      let aria: string | null = null;
      for (const size of SIZES) {
        const wh = `${size.width}x${size.height}`;
        await sizeWindow(context, page, size.width, size.height);
        // The sort the last size left is put back: the first open below
        // is the studio's default, the second the same view stored.
        if (shots.length > 0) {
          await storeLibraryView(studio, DEFAULT_LIBRARY_VIEW);
        }
        let at = `library list ${wh}`;
        await openList(at);
        await shoot(`library-list-${wh}`, at);
        expect(
          await page
            .locator('[data-layout="list"]')
            .getAttribute("aria-pressed"),
          `${at}: List is the pressed one`,
        ).toBe("true");
        // Headed by day under the default sort, every flow closed.
        expect(await page.locator("[data-list] [data-heading]").count()).toBe(
          3,
        );
        expect(await rowsPainted(`${FLOWS}[aria-expanded="true"]`)).toEqual([]);
        // "Couldn't read" in the list's rows (spec §2.3), in its own place
        // since the projects rail (2026-11-01): no card drawn there, each
        // part painted, its Delete at the row's end. With no treegrid
        // beside it, the old "under each column's heading" and "below the
        // list" checks have nothing to measure against.
        await page.goto(`${studio.origin}/?project=unreadable`);
        await page.locator(`[data-unreadable-row="${UNREADABLE}"]`).waitFor();
        const unreadable = await page.evaluate((folder) => {
          const content = document.querySelector(".library-content");
          const list = document.querySelector(".unreadable-list");
          const section = document.querySelector("[data-unreadable]");
          const row = document.querySelector<HTMLElement>(
            `[data-unreadable-row="${CSS.escape(folder)}"]`,
          );
          if (
            content === null ||
            list === null ||
            section === null ||
            row === null
          ) {
            return null;
          }
          const c = content.getBoundingClientRect();
          const l = list.getBoundingClientRect();
          const r = row.getBoundingClientRect();
          const lands = (sel: string): boolean => {
            const el = row.querySelector(sel);
            if (el === null) return false;
            const b = el.getBoundingClientRect();
            const hit = document.elementFromPoint(
              b.left + Math.min(b.width / 2, 20),
              b.top + b.height / 2,
            );
            let o = 1;
            for (let n: Element | null = el; n !== null; n = n.parentElement) {
              o *= Number(getComputedStyle(n).opacity);
            }
            return hit !== null && el.contains(hit) && o === 1;
          };
          const del = row.querySelector('[data-action="delete"]');
          return {
            cards: section.querySelectorAll(".card, article").length,
            treegrid: document.querySelector("[role=treegrid]") !== null,
            ends:
              del !== null &&
              Math.abs(del.getBoundingClientRect().right - l.right) < 1,
            inColumn: r.left >= c.left - 0.5 && r.right <= c.right + 0.5,
            height: Math.round(r.height),
            name: lands('[data-col="name"]'),
            reason: lands('[data-col="where"]'),
            size: lands('[data-col="size"]'),
            remove: lands('[data-action="delete"]'),
          };
        }, UNREADABLE);
        expect(unreadable, `${at}: Couldn't read, as painted`).toEqual({
          cards: 0,
          treegrid: false,
          ends: true,
          inColumn: true,
          height: 34,
          name: true,
          reason: true,
          size: true,
          remove: true,
        });
        // Back to All flows, by its address (a rail click saves the pick).
        await openList(at);

        at = `library list open ${wh}`;
        const closedColumns = await columnsAt();
        await page.locator(`${flowRow(invoice)} [data-col="open"]`).click();
        await vi.waitFor(
          async () => {
            const rows = await rowsPainted("[data-list] [data-video-row]");
            if (rows.length !== 3 || !allPainted(rows)) {
              throw new Error(`video rows ${JSON.stringify(rows)}`);
            }
          },
          { timeout: PAINT_MS, interval: 100 },
        );
        await page.mouse.move(0, 0);
        await settle(page, at);
        await shoot(`library-list-open-${wh}`, at);
        // Opening a flow moves no column: its videos' longer dates once
        // widened Recorded and pushed every column left of it.
        expect(await columnsAt(), `${at}: the columns`).toEqual(closedColumns);
        // The flow's three videos, newest first, beneath it.
        expect(
          await page.evaluate(
            (sel) =>
              [...document.querySelectorAll<HTMLElement>(sel)]
                .filter((r) => !r.hidden)
                .map((r) => r.getAttribute("aria-label")),
            "[data-list] [role=row][data-key]",
          ),
          at,
        ).toEqual(
          expect.arrayContaining([
            "Create an invoice",
            "Video 3",
            "Video 2",
            "Video 1",
          ]),
        );
        for (const v of [v3, v2, v1]) {
          expect(
            await page.locator(videoRow(v)).getAttribute("aria-level"),
            `${at}: ${v}`,
          ).toBe("3");
        }

        at = `library list selecting ${wh}`;
        await page.locator(flowRow(invoice)).hover();
        await page.locator(`[data-select="${invoice}"]`).click();
        await vi.waitFor(
          async () => {
            const selected = await page
              .locator(flowRow(invoice))
              .getAttribute("aria-selected");
            const bar = await page.locator("[data-selection-bar]").isVisible();
            if (selected !== "true" || !bar) {
              throw new Error(`aria-selected ${selected}, bar shown ${bar}`);
            }
          },
          { timeout: PAINT_MS, interval: 100 },
        );
        await page.mouse.move(0, 0);
        await settle(page, at);
        if (aria === null) {
          aria = await page.locator("[role=treegrid]").ariaSnapshot();
          await writeFile(join(SHOTS, "library-list-aria.txt"), aria);
          // The sort is the one fact here read off an attribute: neither an
          // aria snapshot nor Chrome's DevTools accessibility tree carries
          // aria-sort (CDP's columnheaders list readonly and required only,
          // measured 2026-10-31). The header is found by its role and name.
          const sorts = await page
            .getByRole("treegrid", { name: "Flows" })
            .getByRole("columnheader")
            .evaluateAll((hs) =>
              hs.flatMap((h) =>
                h.hasAttribute("aria-sort")
                  ? [`${h.textContent} ${h.getAttribute("aria-sort")}`]
                  : [],
              ),
            );
          expect(sorts, `${at}: the sorted column`).toEqual([
            "Recorded descending",
          ]);
          const lines = aria.split("\n");
          expect(lines[0], aria).toMatch(/^- treegrid "Flows"/);
          const flowAt = lines.findIndex((l) =>
            /- row "Create an invoice"/.test(l),
          );
          const flow = lines[flowAt] ?? "";
          expect(flow, aria).toContain("[expanded]");
          expect(flow, aria).toContain("[selected]");
          expect(flow, aria).toContain("[level=2]");
          const videos = ["Video 3", "Video 2", "Video 1"].map((v) =>
            lines.findIndex((l) => l.includes(`- row "${v}"`)),
          );
          expect(videos, aria).toEqual([...videos].sort((a, b) => a - b));
          expect(videos[0] as number, aria).toBeGreaterThan(flowAt);
          for (const i of videos) expect(lines[i], aria).toContain("[level=3]");
        }
        await shoot(`library-list-selecting-${wh}`, at);
        expect(
          await rowsPainted(flowRow(invoice)),
          `${at}: the ticked flow, not under the bar`,
        ).toEqual([{ label: "Create an invoice", onScreen: true, hit: true }]);

        at = `library list sorted ${wh}`;
        await page.keyboard.press("Escape");
        await vi.waitFor(async () => {
          if ((await page.locator("[data-selecting]").count()) > 0) {
            throw new Error("still selecting");
          }
        });
        await page.locator('[data-sort="size"]').click();
        await vi.waitFor(
          async () => {
            const sort = await page
              .locator('[role=columnheader][data-col="size"]')
              .getAttribute("aria-sort");
            const headings = await page
              .locator("[data-list] [data-heading]")
              .count();
            if (sort !== "descending" || headings !== 0) {
              throw new Error(`size ${sort}, ${headings} headings`);
            }
          },
          { timeout: PAINT_MS, interval: 100 },
        );
        await page.mouse.move(0, 0);
        await settle(page, at);
        await shoot(`library-list-sorted-${wh}`, at);
        expect(allPainted(await rowsPainted(FLOWS)), at).toBe(true);
        // The sort was the author's choice, kept by the studio.
        const kept = await api(studio, "/api/settings/library-view");
        expect(kept.json(), at).toEqual({
          view: {
            layout: "list",
            sort: { column: "size", descending: true },
            project: null,
          },
        });
      }

      // A row's status sentence, as a screen reader gets it (Ruling C: the
      // line is a role-less div in the row, after its cells). A rename to
      // a taken name is refused, and the row says why.
      {
        const at = "library list status 1440x900";
        const report = '[data-list] [role=row][aria-label="Export a report"]';
        await page.locator(report).hover();
        await page.locator(`${report} [data-action="rename"]`).click();
        await page.keyboard.type("Create an invoice");
        await page.keyboard.press("Enter");
        await vi.waitFor(
          async () => {
            const said = await page
              .locator(`${report} [data-status]`)
              .textContent()
              .catch(() => null);
            if (!said?.includes("Couldn't rename")) {
              throw new Error(`the row says ${JSON.stringify(said)}`);
            }
          },
          { timeout: PAINT_MS, interval: 100 },
        );
        await page.mouse.move(0, 0);
        await settle(page, at);
        await shoot("library-list-status-1440x900", at);
        const tree = await page.locator("[role=treegrid]").ariaSnapshot();
        await writeFile(join(SHOTS, "library-list-status-aria.txt"), tree);
        const lines = tree.split("\n");
        const from = lines.findIndex((l) =>
          l.includes('- row "Export a report"'),
        );
        const next = lines.findIndex(
          (l, i) => i > from && /^ {2}- row /.test(l),
        );
        expect(
          lines.slice(from, next === -1 ? undefined : next).join("\n"),
          `${at}: the sentence is read with its row\n${tree}`,
        ).toContain("Couldn't rename");
      }

      // A narrow window: the list keeps to it, its headings on their rows.
      const at = "library list narrow 720x900";
      await sizeWindow(context, page, 720, 900);
      await storeLibraryView(studio, DEFAULT_LIBRARY_VIEW);
      await openList(at);
      await shoot("library-list-narrow-720x900", at);
      expect(await page.locator("[data-list] [data-heading]").count()).toBe(3);
      expect(
        await rowsPainted("[data-list] [data-heading]"),
        `${at}: the headings`,
      ).toEqual(
        ["Today", "Yesterday", expect.any(String)].map((label) => ({
          label,
          onScreen: true,
          hit: true,
        })),
      );
      // The narrow list in Couldn't read: the size cell goes with the Size
      // column, and no painted cell runs under Delete, which floats over
      // the row's end. Red: drop `.unreadable-list` from the narrow
      // container's `[data-col="size"]` rule.
      const unreadAt = "library unreadable narrow 720x900";
      await page.goto(`${studio.origin}/?project=unreadable`);
      await page.locator(`[data-unreadable-row="${UNREADABLE}"]`).waitFor();
      // Not `shoot`: that asserts the treegrid, which this place has none of.
      const unreadFile = join(
        SHOTS,
        "library-unreadable-narrow-720x900-dark.png",
      );
      await page.screenshot({ path: unreadFile });
      shots.push(unreadFile);
      const unreadPaint = await painted(page);
      expect(unreadPaint.theme, `${unreadAt}: the page's theme`).toBe("dark");
      expect(
        unreadPaint.scrollWidth,
        `${unreadAt}: no sideways scroll (${JSON.stringify(unreadPaint)})`,
      ).toBeLessThanOrEqual(unreadPaint.innerWidth);
      expect(await limeOutsideItsPlaces(page), `${unreadAt}: lime`).toEqual([]);
      const narrowRow = await page.evaluate((folder) => {
        const content = document.querySelector(".library-content");
        const row = document.querySelector<HTMLElement>(
          `.unreadable-list [data-unreadable-row="${CSS.escape(folder)}"]`,
        );
        const del = row?.querySelector('[data-action="delete"]');
        if (content == null || row == null || del == null) return null;
        const cs = getComputedStyle(content);
        const inner =
          content.clientWidth -
          Number.parseFloat(cs.paddingLeft) -
          Number.parseFloat(cs.paddingRight);
        const name = row.querySelector('[data-col="name"]') as HTMLElement;
        const n = name.getBoundingClientRect();
        const hit = document.elementFromPoint(
          n.left + Math.min(n.width / 2, 20),
          n.top + n.height / 2,
        );
        const d = del.getBoundingClientRect();
        const size = row.querySelector<HTMLElement>('[data-col="size"]');
        return {
          container: inner,
          namePainted: hit !== null && name.contains(hit),
          sizePainted:
            size?.checkVisibility() === true &&
            size.getBoundingClientRect().width > 0,
          underDelete: [
            ...row.querySelectorAll<HTMLElement>(
              ":scope > [data-col]:not([data-col='actions'])",
            ),
          ].flatMap((c) => {
            const b = c.getBoundingClientRect();
            return b.width > 0 &&
              b.left < d.right &&
              b.right > d.left &&
              b.top < d.bottom &&
              b.bottom > d.top
              ? [`${c.dataset.col} "${c.textContent}"`]
              : [];
          }),
        };
      }, UNREADABLE);
      const narrowSaid = `${unreadAt}: ${JSON.stringify(narrowRow)}`;
      expect(narrowRow, narrowSaid).not.toBeNull();
      // Premises: the row is drawn and painted, and the list is narrow
      // enough for its container rule.
      expect(narrowRow?.namePainted, narrowSaid).toBe(true);
      expect(narrowRow?.container, narrowSaid).toBeLessThan(760);
      expect(narrowRow?.sizePainted, narrowSaid).toBe(false);
      expect(narrowRow?.underDelete, narrowSaid).toEqual([]);

      expect(shots).toHaveLength(SIZES.length * 4 + 3);
      // The refused rename's 409 is the browser's own line for a refusal
      // the page answered; nothing else may fault.
      expect(
        console_
          .faults()
          .filter((l) => !(l.includes("409") && l.includes("/api/videos/"))),
        console_.lines.join("\n"),
      ).toEqual([]);
      running = null;
      expect(await studio.stop(), studio.logs.join("\n")).toBe(0);
    },
    LANE_MS,
  );

  // Kept flows and filmed commits (share links part 1, Task 9): "Create an
  // invoice" kept in a checkout, its versions filmed at two commits (the
  // newest with changes) and one with none. In the list as it opens, the
  // flow under its recorded day's heading (a kept flow has no heading of its
  // own) with its In repo tag; the flow
  // opened, each video's commit beside its name. At both sizes (720 is
  // under 900 tall). Each asserted on its paint, and the premises (the
  // listing says it is kept, and what each version filmed) asserted first.
  it.runIf(process.platform === "darwin")(
    "shoots a flow in the repo under its day's heading with its In repo tag, and its videos' commits, each asserted on its paint",
    async () => {
      const home = await mkdtemp(join(tmpdir(), "studio-shots-kept-"));
      homes.push(home);
      const checkout = await mkdtemp(join(tmpdir(), "studio-shots-repo-"));
      homes.push(checkout);
      const { editorTake } = await seedHome(home, VIDEO_TAKES);
      const invoice = await joinVideo(home);
      const [v1, v2, v3] = VIDEO_TAKES.map((t) => t.id) as [
        string,
        string,
        string,
      ];
      const file = `${KEPT_DIR}/${keptFileName("Create an invoice")}`;
      const recipe: KeptVideo = {
        keptVersion: 2,
        flow: invoice,
        deliver: "files",
        name: "Create an invoice",
        script: {
          scriptVersion: 1,
          name: "Create an invoice",
          target: "https://app.example.com/",
          viewport: { width: 1280, height: 800 },
          steps: [{ do: "waitForLoad" }],
        } as KeptVideo["script"],
        scale: 1,
        logo: null,
        wallpaper: null,
        outputs: [
          { path: "o.mp4", fileType: "mp4", aspect: "16:9", quality: "share" },
        ],
        report: null,
      };
      await mkdir(join(checkout, KEPT_DIR), { recursive: true });
      await writeFile(join(checkout, file), serializeKept(recipe));
      const library = createLibrary(home);
      const marked = await createVideoStore(home, library).setKept(invoice, {
        root: checkout,
        file,
        // Keyed, as every mark is by now: the checkout is no git repo, so an
        // unkeyed mark would be an upkeep row beside the cards.
        key: "github.com/acme/app",
      });
      expect(marked.ok, "premise: the flow is marked kept").toBe(true);
      const CODE = {
        [v3]: { commit: "3f9a2c1d5e7b", tree: "t3", dirty: true },
        [v2]: { commit: "8b41e07a9c2f", tree: "t2", dirty: false },
        [v1]: { none: "not a git checkout" },
      };
      for (const [take, filmedCode] of Object.entries(CODE)) {
        await library.putJson(take, "report.json", { filmedCode });
      }
      // A kept flow of one video (most flows), filmed at a clean commit,
      // with one export: its card has no fold, so the commit sits on the
      // card beside the export.
      const lone = (PLAIN[0] as PlainTake).id;
      const store = createVideoStore(home, library);
      const made = await store.create({
        name: "Filter invoices",
        repo: { key: "github.com/acme/web" },
        startPage: "https://app.example.com/",
      });
      if (!made.ok) throw new Error("the one-video flow could not be made");
      const loneFlow = made.video.id;
      const read = await library.getSceneRead(lone);
      expect(read, `premise: ${lone} was seeded`).not.toBeNull();
      await store.join(lone, {
        videoId: loneFlow,
        made: {
          repo: { none: "seeded" },
          agent: { none: "seeded" },
          by: { none: "seeded" },
          door: "mcp",
        },
        recordedRevision: read?.revision ?? null,
      });
      await library.putJson(lone, "status.json", { outcome: "complete" });
      const loneExport = join(home, "out", "Filter invoices.mp4");
      await writeFile(loneExport, "an exported video");
      await library.appendOutput(lone, {
        path: loneExport,
        fileType: "mp4",
        aspect: "16:9",
        byteLength: 1,
        renderedAt: new Date().toISOString(),
        sceneDigest: "digest",
        report: { outcome: "saved" } as never,
      });
      const loneFile = `${KEPT_DIR}/${keptFileName("Filter invoices")}`;
      await writeFile(
        join(checkout, loneFile),
        serializeKept({ ...recipe, flow: loneFlow, name: "Filter invoices" }),
      );
      expect(
        (
          await store.setKept(loneFlow, {
            root: checkout,
            file: loneFile,
            key: "github.com/acme/app",
          })
        ).ok,
        "premise: the one-video flow is marked kept",
      ).toBe(true);
      const LONE_CODE = { commit: "c0ffee1234ab", tree: "t0", dirty: false };
      await library.putJson(lone, "report.json", { filmedCode: LONE_CODE });
      await mkdir(SHOTS, { recursive: true });
      const studio = await startStudio(home, join(home, "out"));
      running = studio;
      // The premises, as the studio answers them.
      const takes = await api(studio, pathFor("takes"));
      expect(takes.status, takes.text).toBe(200);
      const answer = takes.json() as TakesAnswer;
      expect(answer.videos.find((v) => v.id === invoice)?.kept).toEqual({
        root: checkout,
        file,
        deliver: "files",
        key: "github.com/acme/app",
      });
      for (const take of [v1, v2, v3]) {
        expect(answer.videoOf[take]?.filmedCode, take).toEqual(CODE[take]);
      }
      expect(answer.videoOf[lone]).toMatchObject({
        videoId: loneFlow,
        filmedCode: LONE_CODE,
      });
      expect(answer.videos.find((v) => v.id === loneFlow)).toMatchObject({
        versions: 1,
        kept: { root: checkout, file: loneFile },
      });
      // Today holds a flow that is not kept: the heading has something to
      // lead.
      expect(
        answer.videos.filter((v) => v.id !== invoice && v.kept === null),
      ).not.toEqual([]);
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
      const visible = { onScreen: true, hit: true, opacity: 1, inside: true };
      /** Each element as painted: on screen, the point at its centre its
       *  own, its opacity as drawn, and inside the cell `within` names. */
      const shown = (selectors: [string, string][]) =>
        page.evaluate((sels) => {
          return sels.map(([sel, within]) => {
            const el = document.querySelector(sel);
            if (el === null) return null;
            const r = el.getBoundingClientRect();
            const hit = document.elementFromPoint(
              r.left + r.width / 2,
              r.top + r.height / 2,
            );
            let opacity = 1;
            for (let n: Element | null = el; n !== null; n = n.parentElement) {
              opacity *= Number(getComputedStyle(n).opacity);
            }
            const c = el.closest(within)?.getBoundingClientRect();
            return {
              onScreen:
                r.width > 0 &&
                r.height > 0 &&
                r.top >= 0 &&
                r.bottom <= innerHeight,
              hit: hit !== null && el.contains(hit),
              opacity: Math.round(opacity * 100) / 100,
              inside:
                c !== undefined &&
                r.left >= c.left - 0.5 &&
                r.right <= c.right + 0.5,
            };
          });
        }, selectors);
      const flowRow = `[data-list] [data-flow="${invoice}"]`;
      const tagSel = `${flowRow} [data-kept]`;
      const nameCell = '[role="gridcell"][data-col="name"]';
      const whereCell = '[role="gridcell"][data-col="where"]';
      const videoRow = (id: string) => `[data-list] [data-video-row="${id}"]`;
      const shoot = async (name: string, at: string) => {
        const shot = join(SHOTS, `${name}-dark.png`);
        await page.screenshot({ path: shot });
        shots.push(shot);
        const p = await painted(page);
        expect(p.theme, `${at}: the page's theme`).toBe("dark");
        expect(
          p.scrollWidth,
          `${at}: no sideways scroll (${JSON.stringify(p)})`,
        ).toBeLessThanOrEqual(p.innerWidth);
        expect(await limeOutsideItsPlaces(page), `${at}: lime`).toEqual([]);
      };
      for (const size of SIZES) {
        const wh = `${size.width}x${size.height}`;
        await sizeWindow(context, page, size.width, size.height);
        await storeLibraryView(studio, DEFAULT_LIBRARY_VIEW);
        let at = `library kept ${wh}`;
        await page.goto(`${studio.origin}/`);
        await vi.waitFor(
          async () => {
            if ((await shown([[tagSel, nameCell]]))[0]?.hit !== true) {
              throw new Error(`${at}: the Kept tag is not painted yet`);
            }
          },
          { timeout: PAINT_MS, interval: 100 },
        );
        await page.mouse.move(0, 0);
        await settle(page, at);
        await shoot(`library-list-kept-${wh}`, at);
        // No section is keyed or labelled In repo; the kept flow sits under
        // the heading of the day it was recorded.
        const order = await page.evaluate(() =>
          [
            ...document.querySelectorAll<HTMLElement>(
              "[data-list] [role=row][data-key]",
            ),
          ]
            .filter((r) => !r.hidden)
            .map((r) => r.dataset.key as string),
        );
        const headings = order.filter((k) => k.startsWith("h:"));
        expect(order, `${at}: premise: the kept flow is listed`).toContain(
          `f:${invoice}`,
        );
        expect(
          headings.length,
          `${at}: premise: the list has day headings`,
        ).toBeGreaterThan(0);
        expect(headings, `${at}: no kept section`).not.toContain("h:kept");
        expect(
          await page.locator('[data-heading="kept"]').count(),
          `${at}: no kept heading is painted`,
        ).toBe(0);
        const above = order
          .slice(0, order.indexOf(`f:${invoice}`))
          .filter((k) => k.startsWith("h:"))
          .at(-1);
        expect(above, `${at}: the flow's heading`).toBe("h:today");
        expect(
          await shown([['[data-heading="today"] [data-name-text]', nameCell]]),
          `${at}: the Today heading`,
        ).toEqual([visible]);
        // The tag: its word, its tooltip (where the recipe is), its glyph
        // drawn, and all of it painted inside the name cell.
        const tag = page.locator(tagSel);
        expect(await tag.innerText(), at).toBe("In repo");
        expect(await tag.getAttribute("title"), at).toBe(`${checkout}/${file}`);
        expect(
          await page.evaluate((sel) => {
            const svg = document.querySelector(
              `${sel} svg[data-icon="bookmark"]`,
            ) as SVGGraphicsElement | null;
            const b = svg?.getBBox();
            return b === undefined ? null : b.width > 10 && b.height > 10;
          }, tagSel),
          `${at}: the bookmark glyph is drawn`,
        ).toBe(true);
        expect(
          await shown([
            [tagSel, nameCell],
            [`${flowRow} [data-name-text]`, nameCell],
          ]),
          `${at}: the tag and the name`,
        ).toEqual([visible, visible]);

        at = `library kept open ${wh}`;
        await page.locator(`${flowRow} [data-col="open"]`).click();
        await vi.waitFor(
          async () => {
            if (
              (await shown([[videoRow(v3), "[role=row]"]]))[0]?.hit !== true
            ) {
              throw new Error(`${at}: the video rows are not painted yet`);
            }
          },
          { timeout: PAINT_MS, interval: 100 },
        );
        await page.mouse.move(0, 0);
        await settle(page, at);
        await shoot(`library-list-kept-open-${wh}`, at);
        const commits = await page.evaluate(
          (ids) =>
            ids.map((id) => {
              const c = document.querySelector<HTMLElement>(
                `[data-list] [data-video-row="${id}"] [data-commit]`,
              );
              return c === null ? null : [c.innerText, c.title];
            }),
          [v3, v2, v1],
        );
        expect(commits, at).toEqual([
          ["3f9a2c1*", "3f9a2c1d5e7b"],
          ["8b41e07", "8b41e07a9c2f"],
          null,
        ]);
        // Each commit painted whole beside its video's name, and the
        // newest video's exports still painted in Where: a commit in the
        // Where cell pushed them out of it at 1440 wide.
        expect(
          await shown([
            [`${videoRow(v3)} [data-commit]`, nameCell],
            [`${videoRow(v2)} [data-commit]`, nameCell],
            [`${videoRow(v3)} [data-export]:not([data-gone])`, whereCell],
            [`${videoRow(v3)} [data-export][data-gone]`, whereCell],
          ]),
          `${at}: the commits and the exports`,
        ).toEqual([visible, visible, visible, visible]);

        // The cards: the same day sections with no kept one, the flow in
        // Today, the tag on the card's picture, and the commits in its
        // opened versions.
        at = `library kept cards ${wh}`;
        await openPage(page, studio, "library", editorTake, new Set(), 6);
        const card = `article[data-video="${invoice}"]`;
        const sections = await page.evaluate(() =>
          [...document.querySelectorAll<HTMLElement>("[data-section]")].map(
            (x) => x.dataset.section,
          ),
        );
        expect(sections, `${at}: premise: Today is listed`).toContain("today");
        expect(sections, `${at}: no kept section`).not.toContain("kept");
        expect(
          await page.evaluate(
            (sel) =>
              document
                .querySelector(sel)
                ?.closest<HTMLElement>("[data-section]")?.dataset.section,
            card,
          ),
          `${at}: the kept card sits in Today`,
        ).toBe("today");
        await page.locator(`${card} .versions-count`).click();
        const version = (id: string) => `${card} [data-version-row="${id}"]`;
        await page.locator(version(v1)).scrollIntoViewIfNeeded();
        await page.mouse.move(0, 0);
        await page.evaluate(() =>
          (document.activeElement as HTMLElement).blur(),
        );
        await settle(page, at);
        await shoot(`library-cards-kept-${wh}`, at);
        expect(
          await page.locator(`${card} [data-kept]`).getAttribute("title"),
          at,
        ).toBe(`${checkout}/${file}`);
        expect(
          await page.evaluate(
            (ids) =>
              ids.map(
                (id) =>
                  document.querySelector<HTMLElement>(
                    `[data-version-row="${id}"] [data-commit]`,
                  )?.innerText ?? null,
              ),
            [v3, v2, v1],
          ),
          at,
        ).toEqual(["3f9a2c1*", "8b41e07", null]);
        expect(
          await shown([
            [`${card} [data-kept]`, "[data-preview]"],
            [`${version(v3)} [data-commit]`, ".version-head"],
            [`${version(v2)} [data-commit]`, ".version-head"],
            [`${version(v3)} .version-when`, ".version-head"],
          ]),
          `${at}: the card's tag, the commits and a day beside one`,
        ).toEqual([visible, visible, visible, visible]);
        // The one-video flow's card: no fold, its commit on its exports'
        // line, before the export, each painted whole.
        const loneCard = `article[data-video="${loneFlow}"]`;
        await page.locator(loneCard).scrollIntoViewIfNeeded();
        await page.mouse.move(0, 0);
        await settle(page, at);
        await shoot(`library-cards-kept-one-${wh}`, at);
        expect(
          await page.locator(`${loneCard} [data-versions]`).count(),
          `${at}: premise, the one-video card has no fold`,
        ).toBe(0);
        expect(
          await page.evaluate((sel) => {
            const c = document.querySelector<HTMLElement>(
              `${sel} [data-commit]`,
            );
            const x = document.querySelector(`${sel} [data-export]`);
            if (c === null || x === null) return null;
            const a = c.getBoundingClientRect();
            const b = x.getBoundingClientRect();
            return {
              text: c.innerText,
              title: c.title,
              before: a.right <= b.left,
              sameLine:
                Math.abs(a.top + a.height / 2 - (b.top + b.height / 2)) < 4,
            };
          }, loneCard),
          `${at}: the one-video card's commit`,
        ).toEqual({
          text: "c0ffee1",
          title: "c0ffee1234ab",
          before: true,
          sameLine: true,
        });
        expect(
          await shown([
            [`${loneCard} [data-commit]`, ".card-exports"],
            [`${loneCard} [data-export] .export-name`, ".card-exports"],
            [`${loneCard} [data-export] .export-type`, ".card-exports"],
            [`${loneCard} [data-kept]`, "[data-preview]"],
          ]),
          `${at}: the one-video card's commit, export and tag`,
        ).toEqual([visible, visible, visible, visible]);
      }
      expect(shots).toHaveLength(SIZES.length * 4);
      expect(console_.faults(), console_.lines.join("\n")).toEqual([]);
      running = null;
      expect(await studio.stop(), studio.logs.join("\n")).toBe(0);
    },
    LANE_MS,
  );

  // Bulk delete (spec 2026-10-30 flows-and-bulk-delete §1.2): two flows
  // ticked, the bar over the list, at both sizes; then, at the laptop size,
  // a bulk delete one flow of which an agent's export holds, and the bar
  // naming the flow that stayed. Asserted on the paint.
  it.runIf(process.platform === "darwin")(
    "shoots flows ticked for a bulk delete, and what a partial one left, each asserted on its paint",
    async () => {
      const home = await mkdtemp(join(tmpdir(), "studio-shots-bulk-"));
      homes.push(home);
      const { editorTake } = await seedHome(home, VIDEO_TAKES);
      const invoice = await joinVideo(home);
      const neighbour = (VIDEO_TAKES[3] as PlainTake).id;
      const report = (
        JSON.parse(
          await readFile(join(home, "takes", neighbour, "video.json"), "utf8"),
        ) as { videoId: string }
      ).videoId;
      expect(report, "premise: the neighbour is a flow of its own").not.toBe(
        invoice,
      );
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
      const shots: string[] = [];
      const visible = { onScreen: true, hit: true, opacity: 1 };
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
      const box = (flow: string) =>
        `article[data-video="${flow}"] [data-select]`;
      // Smallest last: the partial delete runs there, and it deletes.
      for (const size of [...SIZES].sort((a, b) => b.height - a.height)) {
        await sizeWindow(context, page, size.width, size.height);
        await openPage(page, studio, "library", editorTake, new Set(), 6);
        const at = `library bulk ${size.width}x${size.height}`;
        await page.locator(box(invoice)).click();
        await page.locator(box(report)).click();
        await page.mouse.move(0, 0);
        await settle(page, at);
        const file = join(
          SHOTS,
          `library-selecting-${size.width}x${size.height}-dark.png`,
        );
        await page.screenshot({ path: file });
        shots.push(file);
        expect(
          await page.locator("[data-selection-count]").textContent(),
          at,
        ).toBe("2 flows selected");
        expect(
          await shown([
            "[data-selection-bar]",
            '[data-action="delete-selected"]',
            box(invoice),
            box(report),
          ]),
          `${at}: the bar and both ticks, with the pointer away`,
        ).toEqual([visible, visible, visible, visible]);
        expect(
          await page.evaluate(
            (sel) =>
              [...document.querySelectorAll(sel)].map(
                (b) => getComputedStyle(b).display,
              ),
            `article[data-video="${report}"] :is([data-action="edit"], [data-action="delete"])`,
          ),
          `${at}: a flow's own Edit and Delete step aside while selecting`,
        ).toEqual(["none", "none"]);
        expect(await limeOutsideItsPlaces(page), `${at}: lime`).toEqual([]);
        if (size.height >= 900) {
          await page.keyboard.press("Escape");
          await vi.waitFor(async () => {
            if ((await page.locator("[data-selection-bar]").count()) !== 0) {
              throw new Error(`${at}: Esc left the bar up`);
            }
          });
          continue;
        }
        // An agent's export holds the report's one video.
        const busy = join(home, "takes", neighbour, ".busy");
        await mkdir(busy, { recursive: true });
        await writeFile(
          join(busy, "lease.json"),
          JSON.stringify({
            pid: process.pid,
            op: "export",
            door: "agent",
            jobId: "shots",
            startedAt: new Date().toISOString(),
          }),
        );
        await page.locator('[data-action="delete-selected"]').click();
        await page.locator("[data-confirm-go]").click();
        const said = page.locator("[data-selection-said]");
        await said.waitFor({ timeout: PAINT_MS });
        expect(await said.textContent(), at).toBe(
          "Deleted 1 of 2 flows. Export a report stayed: This video is being exported by an agent.",
        );
        await page.mouse.move(0, 0);
        await settle(page, `${at} after`);
        const after = join(
          SHOTS,
          `library-partly-deleted-${size.width}x${size.height}-dark.png`,
        );
        await page.screenshot({ path: after });
        shots.push(after);
        expect(
          await shown(["[data-selection-said]", box(report)]),
          `${at}: the sentence, and the flow that stayed still ticked`,
        ).toEqual([visible, visible]);
        expect(
          await page.locator(`article[data-video="${invoice}"]`).count(),
        ).toBe(0);
      }
      expect(shots).toHaveLength(SIZES.length + 1);
      // The refused delete's 409 is the browser's own console line for a
      // refusal the page answered; nothing else may fault.
      expect(
        console_.faults().filter((l) => !l.includes(`/api/videos/${report}`)),
        console_.lines.join("\n"),
      ).toEqual([]);
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
          `${at}: the video's wallpaper is the pressed tile`,
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

  // The library by project (spec 2026-11-01-library-projects-design): the
  // rail, each tab, a day ticked through its heading's box, the layout
  // toggle in the tab row, and the owner line over a project's name, at the
  // laptop sizes, a short window and a narrow one. Asserted on the paint.
  it.runIf(process.platform === "darwin")(
    "shoots the projects rail, each tab, a ticked day and the toggle in the tab row, each asserted on its paint",
    async () => {
      const { home, invoice } = await seedProjects();
      await mkdir(SHOTS, { recursive: true });
      const studio = await startStudio(home, join(home, "out"));
      running = studio;
      // The premise, as the studio answers it: three project keys, flows in
      // no project, and the one kept flow.
      const takes = await api(studio, pathFor("takes"));
      expect(takes.status, takes.text).toBe(200);
      const answer = takes.json() as TakesAnswer;
      const keys = answer.videos.map((v) =>
        "key" in v.repo ? v.repo.key : null,
      );
      expect(
        [...new Set(keys.filter((k) => k !== null))].sort(),
        JSON.stringify(answer.videos),
      ).toEqual([ACME, GLOBEX, LOCAL]);
      // The studio wraps every take in a flow, so each card is a video; the
      // ones with no repo key are No project.
      const noKey = keys.filter((k) => k === null).length;
      expect(noKey, "premise: flows in no project").toBeGreaterThan(0);
      expect(
        answer.videos.filter((v) => v.kept !== null).map((v) => v.id),
        "premise: one kept flow",
      ).toEqual([invoice]);
      const acmeFlows = keys.filter((k) => k === ACME).length;
      expect(acmeFlows, "premise: acme/web has two flows").toBe(2);
      const counts = {
        all: answer.videos.length,
        acme: acmeFlows,
        none: noKey,
        globex: keys.filter((k) => k === GLOBEX).length,
        local: keys.filter((k) => k === LOCAL).length,
        unreadable: answer.unreadable.length,
      };
      expect(counts.globex, "premise: globex/api has one flow").toBe(1);
      expect(counts.local, "premise: the unpushed repo has one flow").toBe(1);
      expect(counts.unreadable, "premise: one folder would not read").toBe(1);
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
      const FLOWS = "[data-list] [role=row][data-scene]:not([data-video-row])";
      const acmeAt = `${studio.origin}/${placeSearch({ project: ACME })}`;
      type Look = {
        /** How many flow rows (and takes in no flow) the place lists. */
        rows: number;
        /** The pressed tab, or null when the place shows none. */
        tab: "inRepo" | "notInRepo" | "all" | null;
        /** The place pressed in the rail. */
        place: string;
        /** The owner line over the title, or null when the place has none. */
        owner: string | null;
        /** The title is a local project's: a name and a dim "local". */
        local?: boolean;
        /** A date heading carries a select-all box. */
        box: boolean;
        /** The kept flow's "In repo" tag keeps its glyph, painted. */
        tagGlyph?: boolean;
      };
      const open = async (url: string, at: string, tab: string | null) => {
        await page.goto(url);
        if (tab !== null) await page.locator(`[data-tab="${tab}"]`).click();
        try {
          await vi.waitFor(
            async () => {
              const cards = await page
                .locator("article.card[data-row]")
                .count();
              const rows = await page.locator(FLOWS).count();
              if (cards !== 0 || rows === 0) {
                throw new Error(`${cards} cards, ${rows} rows`);
              }
            },
            { timeout: PAINT_MS, interval: 100 },
          );
        } catch (error) {
          throw new Error(
            `${at}: the list did not paint: ${String(error)}; page: ${await pageEvidence(page)}; log: ${studio.logs.join("\n")}`,
          );
        }
        await page.mouse.move(0, 0);
        await settle(page, at);
      };
      const maxLuma = async (b: number[]) => {
        const [l, t, r, bt] = b as [number, number, number, number];
        const pts: [number, number][] = [];
        for (let y = t; y <= bt; y += 1) {
          for (let x = l; x <= r; x += 1) pts.push([x, y]);
        }
        return Math.max(...(await pixelsAt(page, pts)).map(luma));
      };
      // The rail's places as painted in `scope` (the rail, or the switcher's
      // open menu): the fixture's words and counts, one to a row, and the
      // dim part of a project's name dimmer than the name beside it, on the
      // computed colours and on the pixels.
      const railLook = async (scope: string, at: string) => {
        const railItems = await page.evaluate(
          (scope) =>
            [
              ...document.querySelectorAll<HTMLElement>(
                `${scope} .side-list > *`,
              ),
            ].map((c) => ({
              // textContent: a project's label is a flex row, whose
              // parts innerText puts on lines of their own.
              text: [
                c.querySelector(".side-label")?.textContent ?? "",
                c.querySelector(".side-count")?.textContent ?? "",
              ].join(" "),
              top: Math.round(c.getBoundingClientRect().top),
            })),
          scope,
        );
        const ev = `${at}: ${JSON.stringify(railItems)}`;
        expect(
          railItems.map((r) => r.text),
          `${at}: the places' labels and counts ${ev}`,
        ).toEqual([
          `All flows ${counts.all}`,
          `acme/web ${counts.acme}`,
          `globex/api ${counts.globex}`,
          `scratch local ${counts.local}`,
          `No project ${counts.none}`,
          `Couldn't read ${counts.unreadable}`,
        ]);
        // One item to a row, top to bottom in the order above.
        const tops = railItems.map((r) => r.top);
        expect(
          tops.every((t, i) => i === 0 || t - (tops[i - 1] as number) > 2),
          `${at}: each place has its own row ${ev}`,
        ).toBe(true);
        // The dim part of a project's name reads dimmer than the name beside
        // it in every rail state, on the computed colours and on the pixels.
        const dims = await page.evaluate((scope) => {
          const box = (e: Element) => {
            const r = e.getBoundingClientRect();
            return [r.left, r.top, r.right, r.bottom].map(Math.round);
          };
          const rgb = (e: Element) =>
            (getComputedStyle(e).color.match(/[\d.]+/g) ?? [])
              .slice(0, 3)
              .map(Number);
          return [
            ...document.querySelectorAll<HTMLElement>(`${scope} .side-item`),
          ].flatMap((a) => {
            const dim = a.querySelector(".proj-dim");
            const name = a.querySelector(".place-name");
            if (dim === null || name === null) return [];
            return [
              {
                text: [
                  a.querySelector(".side-label")?.textContent ?? "",
                  a.querySelector(".side-count")?.textContent ?? "",
                ].join(" "),
                current: a.getAttribute("aria-current") === "true",
                dim: { rgb: rgb(dim), box: box(dim) },
                name: { rgb: rgb(name), box: box(name) },
              },
            ];
          });
        }, scope);
        const unselected = dims.filter((d) => !d.current);
        expect(
          dims.map((d) => d.text),
          `${at}: premise: the owner/repo items and the local one carry a dim part`,
        ).toEqual([
          `acme/web ${counts.acme}`,
          `globex/api ${counts.globex}`,
          `scratch local ${counts.local}`,
        ]);
        expect(
          unselected.length,
          `${at}: premise: at most one of them is current, the rest are unselected`,
        ).toBeGreaterThanOrEqual(2);
        for (const d of dims) {
          const step =
            luma(d.name.rgb as [number, number, number]) -
            luma(d.dim.rgb as [number, number, number]);
          expect(
            step,
            `${at}: "${d.text}"'s dim part is dimmer than its name by a visible step ${JSON.stringify(d)}`,
          ).toBeGreaterThanOrEqual(30);
          const dimPx = await maxLuma(d.dim.box);
          const namePx = await maxLuma(d.name.box);
          expect(
            dimPx,
            `${at}: "${d.text}"'s dim part is painted over the ground`,
          ).toBeGreaterThan(60);
          expect(
            namePx - dimPx,
            `${at}: "${d.text}": the name's pixels are brighter than the dim part's (${namePx} vs ${dimPx})`,
          ).toBeGreaterThanOrEqual(15);
        }
      };
      const shoot = async (name: string, at: string, look: Look) => {
        const shot = join(SHOTS, `library-projects-${name}-dark.png`);
        await page.screenshot({ path: shot });
        shots.push(shot);
        const p = await painted(page);
        expect(p.theme, `${at}: the page's theme`).toBe("dark");
        expect(
          p.scrollWidth,
          `${at}: no sideways scroll (${JSON.stringify(p)})`,
        ).toBeLessThanOrEqual(p.innerWidth);
        expect(await limeOutsideItsPlaces(page), `${at}: lime`).toEqual([]);
        // Under 1024px the rail folds into the title band's switcher (spec
        // 2026-11-01, Addendum): the place is named by its button, and the
        // rail's places are its menu's.
        const narrow = p.innerWidth < 1024;
        const band = narrow ? "[data-place-switch]" : "[data-place-title]";
        const seen = await page.evaluate(
          ([flow, band]) => {
            const drawn = (s: string) =>
              (document.querySelector(s)?.getClientRects().length ?? 0) > 0;
            const glyph = document.querySelector(
              `[data-list] [data-flow="${flow}"] [data-kept] svg`,
            );
            let tagGlyphPainted: boolean | null = null;
            if (glyph !== null) {
              const g = glyph.getBoundingClientRect();
              const hit = document.elementFromPoint(
                g.left + g.width / 2,
                g.top + g.height / 2,
              );
              tagGlyphPainted =
                g.width > 0 && hit !== null && !!hit.closest("[data-kept]");
            }
            const rect = (s: string) =>
              document.querySelector(s)?.getBoundingClientRect() ?? null;
            const centre = (r: DOMRect) =>
              [r.left + r.width / 2, r.top + r.height / 2] as const;
            const row = rect("[data-tabs-row]");
            const toggle = rect("[data-layout-toggle]");
            const button = document.querySelector(
              "[data-layout-toggle] button",
            );
            let toggleHit = false;
            if (button !== null) {
              const [x, y] = centre(button.getBoundingClientRect());
              const hit = document.elementFromPoint(x, y);
              toggleHit = hit !== null && button.contains(hit);
            }
            const box = document.querySelector<HTMLInputElement>(
              "[data-heading] [data-select-group]",
            );
            let boxHit: boolean | null = null;
            if (box !== null) {
              const [x, y] = centre(box.getBoundingClientRect());
              boxHit = document.elementFromPoint(x, y) === box;
            }
            const owner = document.querySelector<HTMLElement>(
              `${band} [data-place-owner]`,
            );
            const name = rect(`${band} [data-place-name]`);
            const railBox = rect("[data-rail]");
            const bandBox = rect(band);
            const switcher = document.querySelector("[data-place-switch]");
            let switchHit = false;
            if (switcher !== null) {
              const [x, y] = centre(switcher.getBoundingClientRect());
              const hit = document.elementFromPoint(x, y);
              switchHit = hit !== null && switcher.contains(hit);
            }
            let ownerSeen: {
              text: string | null;
              onScreen: boolean;
              hit: boolean;
              clipped: string[];
              leftOfName: boolean;
              clearOfRail: boolean;
              inBand: boolean;
              rect: number[];
            } | null = null;
            if (owner !== null) {
              const o = owner.getBoundingClientRect();
              const [x, y] = centre(o);
              const hit = document.elementFromPoint(x, y);
              // An ancestor that clips (overflow other than visible) and does
              // not hold the whole line.
              const clipped: string[] = [];
              for (
                let a = owner.parentElement;
                a !== null;
                a = a.parentElement
              ) {
                const cs = getComputedStyle(a);
                if (cs.overflowX === "visible" && cs.overflowY === "visible") {
                  continue;
                }
                const r = a.getBoundingClientRect();
                if (
                  o.left < r.left - 0.5 ||
                  o.right > r.right + 0.5 ||
                  o.top < r.top - 0.5 ||
                  o.bottom > r.bottom + 0.5
                ) {
                  clipped.push(`${a.tagName.toLowerCase()}.${a.className}`);
                }
              }
              ownerSeen = {
                text: owner.textContent,
                onScreen:
                  o.width > 0 &&
                  o.height > 0 &&
                  o.top >= 0 &&
                  o.left >= 0 &&
                  o.right <= innerWidth &&
                  o.bottom <= innerHeight,
                hit: hit !== null && owner.contains(hit),
                clipped,
                leftOfName:
                  name !== null &&
                  o.right <= name.left + 0.5 &&
                  o.top < name.bottom &&
                  o.bottom > name.top,
                clearOfRail:
                  railBox !== null &&
                  (o.bottom <= railBox.top + 0.5 ||
                    o.top >= railBox.bottom - 0.5 ||
                    o.right <= railBox.left + 0.5 ||
                    o.left >= railBox.right - 0.5),
                // Across, inside the title band's element; down, its middle
                // there (a glyph's box stands taller than a line of 1).
                inBand:
                  bandBox !== null &&
                  o.left >= bandBox.left - 0.5 &&
                  o.right <= bandBox.right + 0.5 &&
                  y >= bandBox.top &&
                  y <= bandBox.bottom,
                rect: [o.left, o.top, o.right, o.bottom].map(Math.round),
              };
            }
            return {
              rows: document.querySelectorAll(
                "[data-list] [role=row][data-scene]:not([data-video-row])",
              ).length,
              // Only the tabs that are painted: a hidden row keeps its state.
              pressedTabs: [
                ...document.querySelectorAll<HTMLElement>(
                  "[data-tab][aria-pressed='true']",
                ),
              ]
                .filter((b) => b.getClientRects().length > 0)
                .map((b) => b.dataset.tab),
              // The rail's, or the switcher menu's: the one the width uses.
              place:
                document
                  .querySelector(
                    `${band === "[data-place-switch]" ? "[data-place-menu]" : "[data-rail]"} [data-place][aria-current="true"]`,
                  )
                  ?.getAttribute("data-place") ?? null,
              railDrawn: drawn("[data-rail]"),
              switchDrawn: drawn("[data-place-switch]"),
              plainTitleDrawn: drawn("[data-place-title]"),
              switchHit,
              plainTitleText:
                document.querySelector("[data-place-title]")?.textContent ??
                null,
              switchText:
                switcher?.querySelector(".place-switch-name")?.textContent ??
                null,
              rowInside:
                row !== null &&
                toggle !== null &&
                toggle.left >= row.left - 0.5 &&
                toggle.right <= row.right + 0.5 &&
                toggle.top >= row.top - 0.5 &&
                toggle.bottom <= row.bottom + 0.5,
              rects: { row, toggle },
              toggleHit,
              boxHit,
              ownerSeen,
              tagGlyphPainted,
            };
          },
          [invoice, band] as const,
        );
        const ev = `${at}: ${JSON.stringify(seen)}`;
        expect(seen.rows, `${at}: the flows listed ${ev}`).toBe(look.rows);
        expect(seen.place, `${at}: the rail's current place ${ev}`).toBe(
          look.place,
        );
        expect(seen.pressedTabs, `${at}: the pressed tab ${ev}`).toEqual(
          look.tab === null ? [] : [look.tab],
        );
        expect(
          seen.rowInside,
          `${at}: the toggle sits in the tab row ${ev}`,
        ).toBe(true);
        expect(
          seen.toggleHit,
          `${at}: the toggle is painted, not under the row ${ev}`,
        ).toBe(true);
        expect(
          seen.boxHit,
          `${at}: the heading's box is its own at its centre ${ev}`,
        ).toBe(look.box ? true : null);
        // Premise: the rail is built at every width, so its not being drawn
        // under 1024px is the stylesheet's rule, not an empty rail.
        expect(p.rail.length, `${at}: the rail has items`).toBeGreaterThan(0);
        if (narrow) {
          expect(
            p.rail.some((r) => r.painted),
            `${at}: no rail item is painted ${JSON.stringify(p.rail)}`,
          ).toBe(false);
          expect(
            {
              railDrawn: seen.railDrawn,
              switchDrawn: seen.switchDrawn,
              switchHit: seen.switchHit,
              plainTitleDrawn: seen.plainTitleDrawn,
            },
            `${at}: the switcher, not the rail ${ev}`,
          ).toEqual({
            railDrawn: false,
            switchDrawn: true,
            switchHit: true,
            plainTitleDrawn: false,
          });
          // The button names the place as the plain title would.
          expect(seen.plainTitleText, `${at}: premise: a title`).toBeTruthy();
          expect(seen.switchText, `${at}: the button's words ${ev}`).toBe(
            seen.plainTitleText,
          );
          // The menu is closed until it is pressed.
          expect(
            await page
              .locator("[data-place-menu]")
              .evaluate((m) => m.matches(":popover-open")),
            `${at}: the menu is closed`,
          ).toBe(false);
          expect(
            await page
              .locator("[data-place-switch]")
              .getAttribute("aria-expanded"),
            `${at}: the button says the menu is closed`,
          ).toBe("false");
        } else {
          expect(
            p.rail.every((r) => r.painted),
            `${at}: rail ${JSON.stringify(p.rail)}`,
          ).toBe(true);
          expect(
            { railDrawn: seen.railDrawn, switchDrawn: seen.switchDrawn },
            `${at}: the rail, not the switcher ${ev}`,
          ).toEqual({ railDrawn: true, switchDrawn: false });
          await railLook("[data-rail]", at);
        }
        if (look.local === true) {
          const loc = await page.evaluate((band) => {
            const e = document.querySelector<HTMLElement>(
              `${band} [data-place-local]`,
            );
            const n = document.querySelector(`${band} [data-place-name]`);
            if (e === null || n === null) return null;
            const r = e.getBoundingClientRect();
            const nr = n.getBoundingClientRect();
            return {
              text: e.textContent,
              rect: [r.left, r.top, r.right, r.bottom].map(Math.round),
              rightOfName: r.left >= nr.right - 0.5,
              sameLine: r.top < nr.bottom && r.bottom > nr.top,
              nameRect: [nr.left, nr.top, nr.right, nr.bottom].map(Math.round),
            };
          }, band);
          expect(
            loc?.text,
            `${at}: the title's local marker ${JSON.stringify(loc)}`,
          ).toBe(" local");
          expect(
            loc,
            `${at}: the marker follows the name on its line`,
          ).toMatchObject({
            rightOfName: true,
            sameLine: true,
          });
          const dimPx = await maxLuma((loc as { rect: number[] }).rect);
          const namePx = await maxLuma(
            (loc as { nameRect: number[] }).nameRect,
          );
          expect(
            dimPx,
            `${at}: the local marker is painted over the ground`,
          ).toBeGreaterThan(60);
          expect(
            namePx - dimPx,
            `${at}: the title's name is brighter than its local marker (${namePx} vs ${dimPx})`,
          ).toBeGreaterThanOrEqual(15);
        }
        if (look.tagGlyph === true) {
          expect(
            seen.tagGlyphPainted,
            `${at}: the kept flow's tag keeps its glyph, painted ${ev}`,
          ).toBe(true);
        }
        if (look.owner === null) {
          expect(seen.ownerSeen, `${at}: no owner line`).toBeNull();
          return;
        }
        const o = seen.ownerSeen;
        expect(o?.text, `${at}: the owner line ${ev}`).toBe(look.owner);
        expect(o, `${at}: the owner line is painted ${ev}`).toMatchObject({
          onScreen: true,
          hit: true,
          clipped: [],
          leftOfName: true,
          clearOfRail: true,
          inBand: true,
        });
        // The pixels: its text is lighter than the ground around it.
        const [l, t, r, b] = (o as { rect: number[] }).rect as [
          number,
          number,
          number,
          number,
        ];
        const pts: [number, number][] = [];
        for (let y = t; y <= b; y += 2) {
          for (let x = l; x <= r; x += 2) pts.push([x, y]);
        }
        const lumas = (await pixelsAt(page, pts)).map(luma);
        expect(
          Math.max(...lumas) - Math.min(...lumas),
          `${at}: the owner line's text is painted over the ground ${ev}`,
        ).toBeGreaterThan(40);
      };
      const acme = placeSearch({ project: ACME });

      for (const size of SIZES) {
        const wh = `${size.width}x${size.height}`;
        await sizeWindow(context, page, size.width, size.height);
        await storeLibraryView(studio, DEFAULT_LIBRARY_VIEW);
        let at = `projects all ${wh}`;
        await open(`${studio.origin}/${placeSearch("all")}`, at, null);
        await shoot(`all-${wh}`, at, {
          rows: counts.all,
          tab: "all",
          place: placeSearch("all"),
          owner: null,
          box: true,
        });
        for (const [tab, rows] of [
          ["inRepo", 1],
          ["notInRepo", 1],
          ["all", counts.acme],
        ] as const) {
          at = `projects acme/web ${tab} ${wh}`;
          await open(acmeAt, at, tab);
          await shoot(`acme-${tab}-${wh}`, at, {
            rows,
            tab,
            place: acme,
            owner: "acme/",
            box: true,
          });
        }
        at = `projects none ${wh}`;
        await open(`${studio.origin}/${placeSearch("none")}`, at, null);
        await shoot(`none-${wh}`, at, {
          rows: counts.none,
          tab: null,
          place: placeSearch("none"),
          owner: null,
          box: true,
        });
        // A day ticked through its heading's box; the bar reads its count.
        at = `projects acme/web a ticked day ${wh}`;
        await open(acmeAt, at, "all");
        const heading = page.locator("[data-heading]").first();
        await heading.hover();
        const group = heading.locator("[data-select-group]");
        const ids = JSON.parse(
          (await group.getAttribute("data-select-group")) as string,
        ) as string[];
        expect(ids.length, `${at}: premise: the day holds both flows`).toBe(2);
        await group.click();
        try {
          await vi.waitFor(
            async () => {
              const said = await page
                .locator("[data-selection-count]")
                .textContent({ timeout: 1000 });
              if (said !== "2 flows selected") {
                throw new Error(`the bar says ${said}`);
              }
            },
            { timeout: PAINT_MS, interval: 100 },
          );
        } catch (error) {
          throw new Error(
            `${at}: ${String(error)}; page: ${await pageEvidence(page)}`,
          );
        }
        expect(
          await group.isChecked(),
          `${at}: the heading's box is ticked`,
        ).toBe(true);
        await page.mouse.move(0, 0);
        await settle(page, at);
        await shoot(`ticked-${wh}`, at, {
          rows: counts.acme,
          tab: "all",
          place: acme,
          owner: "acme/",
          box: true,
        });
      }

      // A short window, and the narrow one, where the switcher's button
      // names the project in the title band.
      for (const [w, h] of [
        [1280, 800],
        [720, 900],
      ] as const) {
        const at = `projects acme/web ${w}x${h}`;
        await sizeWindow(context, page, w, h);
        await open(acmeAt, at, "all");
        await shoot(`acme-all-${w}x${h}`, at, {
          rows: counts.acme,
          tab: "all",
          place: acme,
          owner: "acme/",
          box: true,
          tagGlyph: w === 720,
        });
      }

      // A local project's title: its folder name and a dim "local".
      for (const [w, h] of [
        [1440, 900],
        [720, 900],
      ] as const) {
        const at = `projects local ${w}x${h}`;
        await sizeWindow(context, page, w, h);
        await open(
          `${studio.origin}/${placeSearch({ project: LOCAL })}`,
          at,
          "all",
        );
        await shoot(`local-${w}x${h}`, at, {
          rows: counts.local,
          tab: "all",
          place: placeSearch({ project: LOCAL }),
          owner: null,
          local: true,
          box: true,
        });
      }

      // The narrow switcher opened (spec 2026-11-01, Addendum): the rail's
      // places with their counts in a menu over the list, the current one
      // marked. Esc and a click outside close it; a pick, by click or by
      // keyboard, changes the place and saves the pick.
      {
        const at = "projects switcher 720x900";
        await sizeWindow(context, page, 720, 900);
        await storeLibraryView(studio, DEFAULT_LIBRARY_VIEW);
        await open(acmeAt, at, "all");
        const button = page.locator("[data-place-switch]");
        const menu = page.locator("[data-place-menu]");
        const state = () =>
          page.evaluate(() => ({
            open:
              document
                .querySelector("[data-place-menu]")
                ?.matches(":popover-open") ?? null,
            expanded: document
              .querySelector("[data-place-switch]")
              ?.getAttribute("aria-expanded"),
            focus:
              document.activeElement === null
                ? null
                : document.activeElement.matches("[data-place-switch]")
                  ? "switch"
                  : (document.activeElement.getAttribute("data-place") ??
                    document.activeElement.tagName),
            search: location.search,
            title:
              document.querySelector("[data-place-title]")?.textContent ?? null,
          }));
        const until = async (
          what: string,
          ok: (s: Awaited<ReturnType<typeof state>>) => boolean,
        ) => {
          try {
            await vi.waitFor(
              async () => {
                const now = await state();
                if (!ok(now)) throw new Error(JSON.stringify(now));
              },
              { timeout: PAINT_MS, interval: 50 },
            );
          } catch (error) {
            throw new Error(
              `${at}: ${what}: ${String(error)}; page: ${await pageEvidence(page)}`,
            );
          }
        };
        const saved = async () =>
          (
            (await api(studio, "/api/settings/library-view")).json() as {
              view: LibraryViewChoice;
            }
          ).view.project;
        const places = [
          placeSearch("all"),
          acme,
          placeSearch({ project: GLOBEX }),
          placeSearch({ project: LOCAL }),
          placeSearch("none"),
          placeSearch("unreadable"),
        ];
        expect(await saved(), `${at}: premise: no pick saved`).toBeNull();
        await button.click();
        await until(
          "the button opens the menu, on the current place",
          (s) => s.open === true && s.expanded === "true" && s.focus === acme,
        );
        await page.mouse.move(0, 0);
        await settle(page, at);
        const shot = join(
          SHOTS,
          "library-projects-switcher-open-720x900-dark.png",
        );
        await page.screenshot({ path: shot });
        shots.push(shot);
        expect(await limeOutsideItsPlaces(page), `${at}: lime`).toEqual([]);
        const m = await menu.evaluate((menu) => {
          const r = menu.getBoundingClientRect();
          const b = (
            document.querySelector("[data-place-switch]") as Element
          ).getBoundingClientRect();
          const under = [
            document.querySelector("[data-tabs-row]"),
            document.querySelector("[data-list]"),
          ].flatMap((e) => (e === null ? [] : [e.getBoundingClientRect()]));
          return {
            rect: [r.left, r.top, r.right, r.bottom].map(Math.round),
            inWindow:
              r.left >= 0 &&
              r.top >= 0 &&
              r.right <= innerWidth &&
              r.bottom <= innerHeight,
            underButton: r.top >= b.bottom - 0.5,
            clipped: menu.scrollHeight > menu.clientHeight + 0.5,
            items: [...menu.querySelectorAll<HTMLElement>("[data-place]")].map(
              (a) => {
                const ir = a.getBoundingClientRect();
                const hit = document.elementFromPoint(
                  ir.left + ir.width / 2,
                  ir.top + ir.height / 2,
                );
                return {
                  place: a.dataset.place,
                  role: a.getAttribute("role"),
                  current: a.getAttribute("aria-current") === "true",
                  hit: hit !== null && a.contains(hit),
                  inside:
                    ir.top >= r.top - 0.5 &&
                    ir.bottom <= r.bottom + 0.5 &&
                    ir.left >= r.left - 0.5 &&
                    ir.right <= r.right + 0.5,
                  overPage: under.some(
                    (u) =>
                      ir.left < u.right &&
                      ir.right > u.left &&
                      ir.top < u.bottom &&
                      ir.bottom > u.top,
                  ),
                  // A point in the row's left padding: its fill, not its text.
                  fillAt: [
                    Math.round(ir.left + 4),
                    Math.round(ir.top + ir.height / 2),
                  ],
                };
              },
            ),
          };
        });
        const ev = `${at}: ${JSON.stringify(m)}`;
        expect(
          m.items.map((i) => i.place),
          `${at}: every place ${ev}`,
        ).toEqual(places);
        expect(
          m.items.every((i) => i.role === "menuitem"),
          ev,
        ).toBe(true);
        expect(
          m.items.filter((i) => i.current).map((i) => i.place),
          `${at}: the current place ${ev}`,
        ).toEqual([acme]);
        // Premise: the menu lies over the tab row or the list, so a hit on
        // each row is the menu painted on top, not a clear patch of page.
        expect(
          m.items.some((i) => i.overPage),
          `${at}: premise: over the list ${ev}`,
        ).toBe(true);
        expect(
          m.items.every((i) => i.hit),
          `${at}: every row painted on top ${ev}`,
        ).toBe(true);
        expect(
          m.items.every((i) => i.inside),
          `${at}: every row inside the menu ${ev}`,
        ).toBe(true);
        expect(
          {
            inWindow: m.inWindow,
            underButton: m.underButton,
            clipped: m.clipped,
          },
          `${at}: the menu in the window, under its button, not cut ${ev}`,
        ).toEqual({ inWindow: true, underButton: true, clipped: false });
        // The current row's fill is its own on the pixels.
        const fills = (
          await pixelsAt(
            page,
            m.items.map((i) => i.fillAt as [number, number]),
          )
        ).map(luma);
        const currentFill = fills[1] as number;
        for (const [i, f] of fills.entries()) {
          if (i === 1) continue;
          expect(
            currentFill - f,
            `${at}: the current row's fill reads apart from ${places[i]}'s (${fills.join(", ")})`,
          ).toBeGreaterThanOrEqual(4);
        }
        await railLook("[data-place-menu]", at);

        // Esc closes it and gives the button the keyboard back. The lime
        // probe above blurred the row the menu opened on; it goes back
        // there first, where opening the menu had put it.
        await menu.locator(`[data-place="${acme}"]`).focus();
        await until(
          "premise: the keyboard is in the menu",
          (s) => s.open === true && s.focus === acme,
        );
        await page.keyboard.press("Escape");
        await until(
          "Esc closes the menu",
          (s) =>
            s.open === false && s.expanded === "false" && s.focus === "switch",
        );
        // A click outside closes it and picks nothing.
        await button.click();
        await until("it opens again", (s) => s.open === true);
        await page.mouse.click(700, 880);
        await until(
          "a click outside closes it",
          (s) => s.open === false && s.expanded === "false",
        );
        expect((await state()).search, `${at}: nothing picked`).toBe(acme);
        expect(await saved(), `${at}: nothing saved`).toBeNull();

        // A click on a place picks it, as the rail's click does.
        await button.click();
        await until("it opens to pick", (s) => s.open === true);
        await menu.locator(`[data-place="${places[2]}"]`).click();
        await until(
          "a click picks globex/api",
          (s) =>
            s.open === false &&
            s.search === places[2] &&
            s.title === "globex/api",
        );
        expect(
          await button.textContent(),
          `${at}: the button names the pick`,
        ).toBe("globex/api");
        await vi.waitFor(
          async () => {
            if ((await saved()) !== GLOBEX)
              throw new Error(`saved ${await saved()}`);
          },
          { timeout: PAINT_MS, interval: 50 },
        );

        // And by keyboard: Enter on the button, End, Enter.
        await button.focus();
        await page.keyboard.press("Enter");
        await until(
          "Enter opens it on the current place",
          (s) => s.open === true && s.focus === places[2],
        );
        await page.keyboard.press("End");
        await until("End reaches the last place", (s) => s.focus === places[5]);
        await page.keyboard.press("ArrowUp");
        await until("ArrowUp steps back one", (s) => s.focus === places[4]);
        await page.keyboard.press("Enter");
        await until(
          "Enter picks No project",
          (s) =>
            s.open === false &&
            s.search === places[4] &&
            s.title === "No project" &&
            s.focus === "switch",
        );
        await vi.waitFor(
          async () => {
            if ((await saved()) !== "none")
              throw new Error(`saved ${await saved()}`);
          },
          { timeout: PAINT_MS, interval: 50 },
        );
      }

      // The grid: a date heading's box sits inside the section's summary,
      // so its click and Space tick the day without folding the section.
      {
        const at = "projects grid 1440x900";
        await sizeWindow(context, page, 1440, 900);
        await storeLibraryView(studio, GRID_VIEW);
        await page.goto(acmeAt);
        const section = page.locator("details.section[data-section]").first();
        await section.waitFor();
        const box = section.locator("summary [data-select-group]");
        const opens = () =>
          section.evaluate((d) => (d as HTMLDetailsElement).open);
        const bar = async (want: string | null) => {
          try {
            await vi.waitFor(
              async () => {
                const said = await page
                  .locator("[data-selection-count]")
                  .textContent({ timeout: 1000 })
                  .catch(() => null);
                if (said !== want) throw new Error(`the bar says ${said}`);
              },
              { timeout: PAINT_MS, interval: 100 },
            );
          } catch (error) {
            throw new Error(
              `${at}: ${String(error)}; open ${await opens()}; page: ${await pageEvidence(page)}`,
            );
          }
        };
        expect(await opens(), `${at}: premise: the section is open`).toBe(true);
        expect(
          (
            JSON.parse(
              (await box.getAttribute("data-select-group")) as string,
            ) as string[]
          ).length,
          `${at}: premise: the box holds the day's two flows`,
        ).toBe(2);
        await section.locator("summary.section-head").hover();
        await box.click();
        await bar("2 flows selected");
        expect(await box.isChecked(), `${at}: the click ticked it`).toBe(true);
        expect(await opens(), `${at}: the click did not fold the section`).toBe(
          true,
        );
        await box.click();
        await bar(null);
        await box.focus();
        await page.keyboard.press("Space");
        await bar("2 flows selected");
        expect(await box.isChecked(), `${at}: Space ticked it`).toBe(true);
        expect(await opens(), `${at}: Space did not fold the section`).toBe(
          true,
        );
        await page.mouse.move(0, 0);
        await settle(page, at);
        const shot = join(
          SHOTS,
          "library-projects-grid-ticked-1440x900-dark.png",
        );
        await page.screenshot({ path: shot });
        shots.push(shot);
        expect(await limeOutsideItsPlaces(page), `${at}: lime`).toEqual([]);
        const hit = await box.evaluate((b) => {
          const r = b.getBoundingClientRect();
          return (
            document.elementFromPoint(
              r.left + r.width / 2,
              r.top + r.height / 2,
            ) === b
          );
        });
        expect(hit, `${at}: the grid heading's box is painted`).toBe(true);
      }
      expect(shots).toHaveLength(SIZES.length * 6 + 6);
      expect(console_.faults(), console_.lines.join("\n")).toEqual([]);
      running = null;
      expect(await studio.stop(), studio.logs.join("\n")).toBe(0);
    },
    LANE_MS,
  );

  // The library's search box (spec 2026-11-02 library-search): a word only
  // one flow's steps hold, typed in All flows, at the projects home. The
  // results, the why beside the flow, the box in the tab row and the
  // address, each on its paint; the same results after a reload; and the
  // same word in a project that has none of it.
  it.runIf(process.platform === "darwin")(
    "shoots a search in the tab row, its results and why they matched, each asserted on its paint",
    async () => {
      const { home, globex } = await seedProjects();
      await mkdir(SHOTS, { recursive: true });
      const studio = await startStudio(home, join(home, "out"));
      running = studio;
      // The premise, as the studio lists it: the word is in the globex
      // flow's steps, and in no flow's name, page or other steps.
      const takes = await api(studio, pathFor("takes"));
      expect(takes.status, takes.text).toBe(200);
      const { videos } = takes.json() as TakesAnswer;
      const word = new RegExp(`\\b${SEARCHED}`, "i");
      const listed = JSON.stringify(
        videos.map((v) => ({ id: v.id, name: v.name, steps: v.steps })),
      );
      expect(
        videos.find((v) => v.id === globex)?.steps,
        `premise: the globex flow's steps hold the word ${listed}`,
      ).toContain(`click ${RECONCILE}`);
      expect(
        videos.filter((v) => word.test(v.name)).map((v) => v.id),
        `premise: no flow's name holds the word ${listed}`,
      ).toEqual([]);
      expect(
        videos
          .filter((v) => [...v.steps, ...v.pages].some((s) => word.test(s)))
          .map((v) => v.id),
        `premise: no other flow's steps or pages hold it ${listed}`,
      ).toEqual([globex]);
      expect(videos.length, "premise: more flows than the one").toBeGreaterThan(
        1,
      );
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
      const why = `step: …${SEARCHED} against the open invoices`;
      const whyFull = `step: click ${RECONCILE}`;
      // The listed flows (and takes in no flow), and the search's paint.
      const look = () =>
        page.evaluate((searched) => {
          const centre = (r: DOMRect) =>
            [r.left + r.width / 2, r.top + r.height / 2] as const;
          const hits = (e: Element) => {
            const r = e.getBoundingClientRect();
            if (r.width === 0 || r.height === 0) return false;
            const hit = document.elementFromPoint(...centre(r));
            return hit !== null && e.contains(hit);
          };
          const rect = (e: Element | null) => {
            if (e === null) return null;
            const r = e.getBoundingClientRect();
            return [r.left, r.top, r.right, r.bottom].map(Math.round);
          };
          // The why against its cell: the whole sentence's width (the
          // premise that it is cut), the name's painted width against its
          // floor (35% of the cell, index.html), and the matched word inside
          // the part of the why that is drawn, short of a cut why's "…".
          const besideName = (w: HTMLElement, searched: string) => {
            const cell = w.closest<HTMLElement>("[data-col]") as HTMLElement;
            const style = getComputedStyle(cell);
            const content =
              cell.clientWidth -
              Number.parseFloat(style.paddingLeft) -
              Number.parseFloat(style.paddingRight);
            const probe = document.createElement("span");
            probe.className = "match-why";
            probe.style.cssText = "position: absolute; max-width: none";
            cell.append(probe);
            probe.textContent = w.title;
            const full = probe.getBoundingClientRect().width;
            probe.textContent = "…";
            const ellipsis = probe.getBoundingClientRect().width;
            probe.remove();
            const name = cell.querySelector("[data-name-text]");
            const n = name?.getBoundingClientRect();
            const floor = 0.35 * content;
            const nameHit =
              n === undefined
                ? null
                : document.elementFromPoint(
                    n.left + floor - 2,
                    n.top + n.height / 2,
                  );
            const text = w.firstChild as Text | null;
            const i = text?.data.indexOf(searched) ?? -1;
            const range = document.createRange();
            if (text !== null && i >= 0) {
              range.setStart(text, i);
              range.setEnd(text, i + searched.length);
            }
            const r = range.getBoundingClientRect();
            const drawnTo =
              w.getBoundingClientRect().right -
              (w.scrollWidth > w.clientWidth ? ellipsis : 0);
            const wordHit = document.elementFromPoint(
              r.left + r.width / 2,
              r.top + r.height / 2,
            );
            return {
              title: w.title,
              cell: content,
              full,
              floor,
              name: n?.width ?? null,
              word: [r.left, r.right],
              drawnTo,
              fullWiderThanCell: full > content,
              nameWiderThanFloor: name !== null && name.scrollWidth > floor,
              nameAtFloor:
                n !== undefined &&
                n.width >= floor - 0.5 &&
                nameHit !== null &&
                (name?.contains(nameHit) ?? false),
              wordPainted:
                i >= 0 &&
                r.width > 0 &&
                r.right <= drawnTo + 0.5 &&
                wordHit !== null &&
                w.contains(wordHit),
            };
          };
          const box = document.querySelector<HTMLInputElement>("[data-search]");
          const row = document.querySelector("[data-tabs-row]");
          const toggle = document.querySelector("[data-layout-toggle]");
          const b = box?.getBoundingClientRect();
          const t = toggle?.getBoundingClientRect();
          const rw = row?.getBoundingClientRect();
          return {
            rows: [
              ...document.querySelectorAll<HTMLElement>(
                "[data-list] [role=row][data-scene]:not([data-video-row])",
              ),
            ].map((r) => ({
              id: r.dataset.flow ?? r.dataset.take ?? "",
              painted: hits(r),
              // Each copy of the why: where it lives, its words, whether
              // it is drawn and its own at its centre.
              whys: [
                ...r.querySelectorAll<HTMLElement>("[data-match-why]"),
              ].map((w) => ({
                slot: w.dataset.matchWhy,
                text: w.textContent,
                drawn: w.getClientRects().length > 0,
                hit: hits(w),
                // Painted whole: no ellipsis inside it, and its right edge
                // inside its cell, so the cell's clip cuts nothing either.
                whole:
                  w.scrollWidth <= w.clientWidth &&
                  w.getBoundingClientRect().right <=
                    (w.closest("[data-col]")?.getBoundingClientRect().right ??
                      0) +
                      0.5,
                rect: rect(w),
                ...besideName(w, searched),
              })),
            })),
            box:
              box === null || b === undefined
                ? null
                : {
                    value: box.value,
                    hit: hits(box),
                    inRow: row?.contains(box) === true,
                    // Inside the row's box, and before the toggle: left of
                    // it on its line, or on a line above it.
                    insideRow:
                      rw !== undefined &&
                      b.left >= rw.left - 0.5 &&
                      b.right <= rw.right + 0.5 &&
                      b.top >= rw.top - 0.5 &&
                      b.bottom <= rw.bottom + 0.5,
                    beforeToggle:
                      toggle !== null &&
                      t !== undefined &&
                      (box.compareDocumentPosition(toggle) &
                        Node.DOCUMENT_POSITION_FOLLOWING) !==
                        0 &&
                      (b.right <= t.left + 0.5 || b.bottom <= t.top + 0.5),
                    rect: rect(box),
                    toggle: rect(toggle),
                    row: rect(row),
                  },
            search: location.search,
            list:
              document.querySelector("[data-list]")?.getBoundingClientRect()
                .width ?? null,
          };
        }, SEARCHED);
      type Seen = Awaited<ReturnType<typeof look>>;
      const until = async (
        at: string,
        what: string,
        ok: (s: Seen) => boolean,
      ) => {
        try {
          await vi.waitFor(
            async () => {
              const now = await look();
              if (!ok(now)) throw new Error(JSON.stringify(now));
            },
            { timeout: PAINT_MS, interval: 50 },
          );
        } catch (error) {
          throw new Error(
            `${at}: ${what}: ${String(error)}; page: ${await pageEvidence(page)}; log: ${studio.logs.join("\n")}`,
          );
        }
      };
      const onlyGlobex = (s: Seen) =>
        s.rows.length === 1 && s.rows[0]?.id === globex;
      // The text inside a box is lighter than the ground it sits on.
      const inked = async (box: number[]) => {
        const [l, t, r, b] = box as [number, number, number, number];
        const pts: [number, number][] = [];
        for (let y = t; y <= b; y += 1) {
          for (let x = l; x <= r; x += 2) pts.push([x, y]);
        }
        const lumas = (await pixelsAt(page, pts)).map(luma);
        return Math.max(...lumas) - Math.min(...lumas);
      };
      const all = `${studio.origin}/${placeSearch("all")}`;
      for (const [w, h] of [
        [1440, 900],
        [1280, 720],
        [720, 900],
      ] as const) {
        const at = `search ${w}x${h}`;
        await sizeWindow(context, page, w, h);
        await storeLibraryView(studio, DEFAULT_LIBRARY_VIEW);
        await page.goto(all);
        await until(at, "premise: All flows lists every flow", (s) =>
          videos.every((v) => s.rows.some((r) => r.id === v.id)),
        );
        await page.locator("[data-search]").pressSequentially(SEARCHED);
        await until(at, "the results are the globex flow alone", onlyGlobex);
        await page.mouse.move(0, 0);
        await settle(page, at);
        const shot = join(SHOTS, `library-search-${w}x${h}-dark.png`);
        await page.screenshot({ path: shot });
        shots.push(shot);
        const s = await look();
        const ev = `${at}: ${JSON.stringify(s)}`;
        // Premise: a list of 600 or more, where the box keeps its place in
        // the row; under 600 it folds (the narrow pass below).
        expect(
          s.list,
          `${at}: premise: the list's width ${ev}`,
        ).toBeGreaterThanOrEqual(600);
        const p = await painted(page);
        expect(p.theme, `${at}: the page's theme`).toBe("dark");
        expect(
          p.scrollWidth,
          `${at}: no sideways scroll (${JSON.stringify(p)})`,
        ).toBeLessThanOrEqual(p.innerWidth);
        expect(
          s.rows.map((r) => ({ id: r.id, painted: r.painted })),
          `${at}: the results ${ev}`,
        ).toEqual([{ id: globex, painted: true }]);
        // Both copies carry the why; the width shows one of them, wide the
        // name cell's, under a 760px list Where's.
        const whys = s.rows[0]?.whys ?? [];
        expect(
          whys.map((x) => [x.slot, x.text]),
          `${at}: premise: the row carries the why twice ${ev}`,
        ).toEqual([
          ["name", why],
          ["where", why],
        ]);
        expect(
          whys.map((x) => x.title),
          `${at}: premise: the whole step is in the title ${ev}`,
        ).toEqual([whyFull, whyFull]);
        const shown = whys.filter((x) => x.drawn);
        // Beside the name it runs past its cap and is cut; in Where's
        // place, over Videos and Length, it reads whole.
        expect(
          shown.map((x) => ({ slot: x.slot, hit: x.hit, whole: x.whole })),
          `${at}: one copy of the why is painted, its own at its centre ${ev}`,
        ).toEqual([
          { slot: w === 720 ? "where" : "name", hit: true, whole: w === 720 },
        ]);
        // The matched word is painted, and wide, the name keeps its floor.
        // Premise: the whole step is wider than the cell, so the why is
        // cut, and the name wider than its floor, so the floor holds it.
        expect(
          shown.map((x) => ({
            fullWiderThanCell: x.fullWiderThanCell,
            nameWiderThanFloor: x.slot === "name" ? x.nameWiderThanFloor : null,
          })),
          `${at}: premise: the step wider than its cell, the name than its floor ${ev}`,
        ).toEqual([
          {
            fullWiderThanCell: true,
            nameWiderThanFloor: w === 720 ? null : true,
          },
        ]);
        expect(
          shown.map((x) => ({
            wordPainted: x.wordPainted,
            nameAtFloor: x.slot === "name" ? x.nameAtFloor : null,
          })),
          `${at}: the matched word painted, the name at least its floor ${ev}`,
        ).toEqual([
          { wordPainted: true, nameAtFloor: w === 720 ? null : true },
        ]);
        expect(
          await inked(shown[0]?.rect as number[]),
          `${at}: the why's words are painted over the ground ${ev}`,
        ).toBeGreaterThan(40);
        expect(
          {
            value: s.box?.value,
            hit: s.box?.hit,
            inRow: s.box?.inRow,
            insideRow: s.box?.insideRow,
            beforeToggle: s.box?.beforeToggle,
          },
          `${at}: the box, painted in the tab row before the toggle ${ev}`,
        ).toEqual({
          value: SEARCHED,
          hit: true,
          inRow: true,
          insideRow: true,
          beforeToggle: true,
        });
        const address = new URLSearchParams(s.search);
        expect(
          [address.get("project"), address.get("q")],
          `${at}: the address carries the search ${ev}`,
        ).toEqual(["all", SEARCHED]);
        expect(await limeOutsideItsPlaces(page), `${at}: lime`).toEqual([]);
        // A reload reads the search back from the address.
        await page.reload();
        await until(
          at,
          "after a reload, the same results and the word in the box",
          (s) =>
            onlyGlobex(s) &&
            s.rows[0]?.painted === true &&
            s.box?.value === SEARCHED,
        );
      }

      // Under a 600px list (spec 2026-11-02 search-narrow): empty and
      // unfocused the box is its glyph alone, between the tabs and the
      // toggle; holding the word unfocused it stays open there, the word
      // in view. Each on its paint.
      {
        const at = "search narrow 560x900";
        await sizeWindow(context, page, 560, 900);
        await storeLibraryView(studio, DEFAULT_LIBRARY_VIEW);
        await page.goto(all);
        await until(at, "premise: All flows lists every flow", (s) =>
          videos.every((v) => s.rows.some((r) => r.id === v.id)),
        );
        await page.mouse.move(0, 0);
        await settle(page, at);
        // The row as painted: the field, the tabs' right end, the toggle,
        // the glyph, and what is on top at the field's middle.
        const row = () =>
          page.evaluate(() => {
            const r = (sel: string) => {
              const e = document.querySelector(sel);
              if (e === null) return null;
              const b = e.getBoundingClientRect();
              return [b.left, b.top, b.right, b.bottom];
            };
            const input = document.querySelector<HTMLInputElement>(
              "[data-search]",
            ) as HTMLInputElement;
            const f = input.getBoundingClientRect();
            const hit = document.elementFromPoint(
              f.left + f.width / 2,
              f.top + f.height / 2,
            );
            const pills = [
              ...document.querySelectorAll(".place-tabs [data-tab]"),
            ].map((p) => p.getBoundingClientRect());
            return {
              list:
                document.querySelector("[data-list]")?.getBoundingClientRect()
                  .width ?? null,
              field: r(".search-field"),
              input: [f.left, f.top, f.right, f.bottom],
              glyph: r(".search-field > svg"),
              toggle: r("[data-layout-toggle]"),
              pillsRight: Math.max(...pills.map((p) => p.right)),
              pillTops: [...new Set(pills.map((p) => Math.round(p.top)))],
              hit: hit === input,
              whole: input.scrollWidth <= input.clientWidth,
              value: input.value,
              focused: document.activeElement === input,
              scroll: [
                document.documentElement.scrollWidth,
                document.documentElement.clientWidth,
              ],
            };
          });
        type Row = Awaited<ReturnType<typeof row>>;
        const between = (x: Row) => {
          const [fl, , fr] = x.field as number[];
          const [tl] = x.toggle as number[];
          return (
            (fl as number) >= x.pillsRight + 7.5 &&
            (fr as number) <= (tl as number) - 7.5
          );
        };
        const folded = await row();
        const ev = `${at}: ${JSON.stringify(folded)}`;
        const shot = join(SHOTS, "library-search-folded-560x900-dark.png");
        await page.screenshot({ path: shot });
        shots.push(shot);
        expect(
          folded.list,
          `${at}: premise: a list under 600 ${ev}`,
        ).toBeLessThan(600);
        expect(
          folded.scroll[0],
          `${at}: no sideways scroll ${ev}`,
        ).toBeLessThanOrEqual(folded.scroll[1] as number);
        expect(
          folded.pillTops,
          `${at}: the tabs on one line ${ev}`,
        ).toHaveLength(1);
        const [il, it_, ir, ib] = folded.input as [
          number,
          number,
          number,
          number,
        ];
        expect(
          {
            width: Math.round(ir - il),
            between: between(folded),
            // Beside the toggle, the row's 12px gap from it.
            toToggle: Math.round(
              ((folded.toggle as number[])[0] as number) - ir,
            ),
            hit: folded.hit,
            value: folded.value,
            focused: folded.focused,
          },
          `${at}: the glyph's square between the tabs and the toggle, beside the toggle, on top ${ev}`,
        ).toEqual({
          width: 32,
          between: true,
          toToggle: 12,
          hit: true,
          value: "",
          focused: false,
        });
        // The glyph is painted, and nothing left of it (the placeholder
        // would start at the square's left edge).
        const [gl] = folded.glyph as number[];
        const mid = (it_ + ib) / 2;
        expect(
          await inked([
            Math.ceil(gl as number),
            Math.round(mid - 6),
            Math.floor(ir - 4),
            Math.round(mid + 6),
          ]),
          `${at}: the glyph's ink ${ev}`,
        ).toBeGreaterThan(20);
        expect(
          await inked([
            Math.ceil(il + 2),
            Math.round(mid - 6),
            Math.floor((gl as number) - 2),
            Math.round(mid + 6),
          ]),
          `${at}: no ink left of the glyph ${ev}`,
        ).toBeLessThan(8);

        await page.locator("[data-search]").pressSequentially(SEARCHED);
        await until(at, "the results are the globex flow alone", onlyGlobex);
        await page.locator("[data-search]").blur();
        await page.mouse.move(0, 0);
        await settle(page, at);
        const held = await row();
        const hev = `${at} held: ${JSON.stringify(held)}`;
        const heldShot = join(SHOTS, "library-search-held-560x900-dark.png");
        await page.screenshot({ path: heldShot });
        shots.push(heldShot);
        const [hl, ht, hr, hb] = held.input as [number, number, number, number];
        expect(
          {
            between: between(held),
            hit: held.hit,
            whole: held.whole,
            value: held.value,
            focused: held.focused,
            open: hr - hl > 64,
          },
          `${at}: holding the word, open between the tabs and the toggle ${hev}`,
        ).toEqual({
          between: true,
          hit: true,
          whole: true,
          value: SEARCHED,
          focused: false,
          open: true,
        });
        const [, , gr] = held.glyph as number[];
        expect(
          await inked([
            Math.ceil((gr as number) + 2),
            Math.round(ht + 6),
            Math.floor(hr - 4),
            Math.round(hb - 6),
          ]),
          `${at}: the word's ink in the box ${hev}`,
        ).toBeGreaterThan(40);
        expect(await limeOutsideItsPlaces(page), `${at}: lime`).toEqual([]);
      }

      // The word in acme/web, which has none of it: "None here.", and a
      // link to where it is, painted.
      {
        const at = "search none here 1440x900";
        await sizeWindow(context, page, 1440, 900);
        await page.goto(`${studio.origin}/${placeSearch({ project: ACME })}`);
        await until(
          at,
          "premise: acme/web lists flows",
          (s) => s.rows.length > 0,
        );
        await page.locator("[data-search]").pressSequentially(SEARCHED);
        const line = page.locator("[data-none-here]");
        await line.waitFor({ timeout: PAINT_MS });
        await page.mouse.move(0, 0);
        await settle(page, at);
        const none = await line.evaluate((p) => {
          const hits = (e: Element) => {
            const r = e.getBoundingClientRect();
            const hit = document.elementFromPoint(
              r.left + r.width / 2,
              r.top + r.height / 2,
            );
            return r.width > 0 && hit !== null && e.contains(hit);
          };
          const rect = (e: Element) => {
            const r = e.getBoundingClientRect();
            return [r.left, r.top, r.right, r.bottom].map(Math.round);
          };
          const link = p.querySelector("a");
          return {
            text: p.textContent,
            hit: hits(p),
            rect: rect(p),
            link:
              link === null
                ? null
                : {
                    text: link.textContent,
                    place: link.dataset.place,
                    href: link.getAttribute("href"),
                    hit: hits(link),
                    rect: rect(link),
                  },
            rows: document.querySelectorAll(
              "[data-list] [role=row][data-scene]",
            ).length,
          };
        });
        const ev = `${at}: ${JSON.stringify(none)}`;
        expect(
          { text: none.text, hit: none.hit, rows: none.rows },
          `${at}: the line, painted, with no rows ${ev}`,
        ).toEqual({ text: "None here. 1 in globex/api.", hit: true, rows: 0 });
        expect(none.link, `${at}: its link, painted ${ev}`).toMatchObject({
          text: "1 in globex/api",
          place: placeSearch({ project: GLOBEX }),
          href: `${placeSearch({ project: GLOBEX })}&q=${SEARCHED}`,
          hit: true,
        });
        expect(
          await inked(none.link?.rect as number[]),
          `${at}: the link's words are painted over the ground ${ev}`,
        ).toBeGreaterThan(40);
        expect(await limeOutsideItsPlaces(page), `${at}: lime`).toEqual([]);
      }
      expect(shots).toHaveLength(5);
      expect(console_.faults(), console_.lines.join("\n")).toEqual([]);
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
          text: "Open the video",
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

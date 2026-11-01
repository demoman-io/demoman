// The studio's pages as the browser lane opens them: a seeded home (the
// library, the take the editor opens, the kits), each page opened and
// waited on until its pictures are painted, and the painted facts a shot is
// asserted on. Moved out of studio-shots.test.ts (2026-10-19) so
// studio-look.test.ts asserts the same pages the screenshot set shows.
import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { OutputRecord } from "@demoman/run-core";
import { createLibrary, createVideoStore } from "@demoman/runner/studio";
import {
  DEFAULT_LIBRARY_VIEW,
  type LibraryViewChoice,
} from "@demoman/studio-protocol";
import type { Page } from "playwright";
import { vi } from "vitest";
import { type PlainTake, seedPlainTakes, seedTake } from "./painted-take.js";
import { api, pageEvidence, type Studio } from "./studio-harness.js";

/** A page's load to its settled paint: 145-290 ms here over 36 opens (the
 *  first library open, which makes every thumbnail with sips, 197-290 ms).
 *  x5 is 1.5 s; the room on top is for sips and decoders on a loaded
 *  machine. */
export const PAINT_MS = 20_000;

const LOGO = fileURLToPath(
  new URL("../../../runner/test/fixtures/frame.jpg", import.meta.url),
);

/** Two days, two takes each; one of them with a cut (asserted by its length
 *  badge on every library shot). Relative to the run,
 *  so the days stay in the week the library names day by day (Yesterday,
 *  then "Thu, Oct 15") rather than folding into a month. Local hours. */
const daysAgo = (days: number, hour: number): string => {
  const d = new Date();
  d.setDate(d.getDate() - days);
  d.setHours(hour, 0, 0, 0);
  return d.toISOString();
};
export const DAY_ONE = daysAgo(2, 11);
export const DAY_TWO = daysAgo(1, 11);
export const PLAIN: PlainTake[] = [
  {
    id: "take-invoices",
    name: "Filter invoices",
    createdAt: DAY_TWO,
    ground: "#dbeafe",
  },
  {
    id: "take-signup",
    name: "Sign up with a cut",
    createdAt: DAY_ONE,
    ground: "#dcfce7",
    cuts: ["act-2"],
  },
  {
    id: "take-settings",
    name: "Change a setting",
    createdAt: DAY_ONE,
    ground: "#fef3c7",
  },
];
export const UNREADABLE = "take-half-written";

/** One video's three versions, oldest first (local video library §5):
 *  the oldest past expiry's 30 days with a script, so the studio's own
 *  expiry as it starts removes its recording; the middle one as old with
 *  no script, which expiry keeps; the newest today, its current version. */
export const VIDEO_TAKES: PlainTake[] = [
  {
    id: "invoice-v1",
    name: "Create an invoice",
    createdAt: daysAgo(40, 11),
    ground: "#fee2e2",
  },
  {
    id: "invoice-v2",
    name: "Create an invoice",
    createdAt: daysAgo(35, 11),
    ground: "#e0e7ff",
  },
  {
    id: "invoice-v3",
    name: "Create an invoice",
    createdAt: daysAgo(0, 9),
    ground: "#ccfbf1",
  },
  // Not a version: a take of the same day, so the video's card has a
  // neighbour in its row for the opened fold to (not) stretch.
  {
    id: "report-today",
    name: "Export a report",
    createdAt: daysAgo(0, 8),
    ground: "#fde68a",
  },
];

/** The newest version's exports: one on disk, one since moved away. */
export const VIDEO_EXPORTS = ["Create an invoice.mp4", "Create an invoice.gif"];

/** The neighbour's one export: a video of one version has no fold, so its
 *  card lists it. */
export const ONE_VERSION_EXPORT = "Export a report.mp4";

/** Joins the first three `VIDEO_TAKES` (seeded by `seedHome`'s `extra`) as
 *  one video of `acme/web`, each complete and recorded as it is, the way a
 *  run joins its take, and gives the newest `VIDEO_EXPORTS`; the fourth is
 *  a video of its own, of one version, with `ONE_VERSION_EXPORT`. */
export async function joinVideo(home: string): Promise<string> {
  const library = createLibrary(home);
  const store = createVideoStore(home, library);
  const made = await store.create({
    name: "Create an invoice",
    repo: { key: "github.com/acme/web" },
    startPage: "https://app.example.com/",
  });
  if (!made.ok) throw new Error("the video could not be made");
  const [kept, gone] = VIDEO_EXPORTS.map((n) => join(home, "out", n)) as [
    string,
    string,
  ];
  const report = join(home, "out", ONE_VERSION_EXPORT);
  await mkdir(join(home, "out"), { recursive: true });
  await writeFile(kept, "an exported video");
  await writeFile(report, "an exported video");
  for (const [takeId, path, fileType] of [
    ["invoice-v3", kept, "mp4"],
    ["invoice-v3", gone, "gif"],
    ["report-today", report, "mp4"],
  ] as const) {
    await library.appendOutput(takeId, {
      path,
      fileType,
      aspect: "16:9",
      byteLength: 1,
      renderedAt: new Date().toISOString(),
      sceneDigest: "digest",
      report: { outcome: "saved" } as unknown as OutputRecord["report"],
    });
  }
  const alone = await store.create({
    name: "Export a report",
    repo: { key: "github.com/acme/web" },
    startPage: "https://app.example.com/",
  });
  if (!alone.ok) throw new Error("the one-version video could not be made");
  for (const [i, t] of VIDEO_TAKES.entries()) {
    await library.putJson(t.id, "status.json", { outcome: "complete" });
    if (i !== 1) await library.putJson(t.id, "script.json", {});
    const read = await library.getSceneRead(t.id);
    if (read === null) throw new Error(`${t.id} was not seeded`);
    await store.join(t.id, {
      videoId: i < 3 ? made.video.id : alone.video.id,
      made: {
        repo: { none: "seeded" },
        agent: { none: "seeded" },
        by: { none: "seeded" },
        door: "mcp",
      },
      recordedRevision: read.revision,
    });
  }
  return made.video.id;
}

/** The library, the take the editor opens, and the kits. */
export async function seedHome(
  home: string,
  extra: PlainTake[] = [],
): Promise<{ editorTake: string }> {
  const take = await seedTake(home);
  await createLibrary(home).putScene({
    ...take.scene,
    meta: {
      ...take.scene.meta,
      name: "Checkout with a zoom",
      createdAt: daysAgo(1, 13),
    },
  });
  await seedPlainTakes(home, take, [...PLAIN, ...extra]);
  // A folder whose scene.json will not parse: a row, never a missing card.
  await mkdir(join(home, "takes", UNREADABLE), { recursive: true });
  await writeFile(
    join(home, "takes", UNREADABLE, "scene.json"),
    '{ "schemaVersion": 7, "meta": ',
  );
  // Two kits, the default with a logo.
  const ref = "assets/launch-logo.jpg";
  await mkdir(join(home, "assets"), { recursive: true });
  await copyFile(LOGO, join(home, ref));
  await writeFile(
    join(home, "kits.json"),
    `${JSON.stringify(
      {
        kits: [
          {
            id: "kit-launch",
            name: "Launch",
            branding: {
              background: { kind: "solid", color: "#1f6feb" },
              logo: { ref, corner: "bottom-right", size: 0.06, opacity: 0.9 },
              padding: 0.08,
            },
          },
          {
            id: "kit-night",
            name: "Night",
            branding: {
              background: {
                kind: "gradient",
                from: "#0f172a",
                to: "#6d28d9",
                angle: 135,
              },
              logo: null,
              padding: 0.12,
            },
          },
        ],
        default: "kit-launch",
      },
      null,
      2,
    )}\n`,
  );
  return { editorTake: take.takeId };
}

// ------------------------------------------------------------ the picture

/** A canvas's pixels, copied onto one of the test's own (reading the page's
 *  canvas directly makes Chrome warn on its console): how many are opaque,
 *  and how many distinct colours a sparse sweep finds. */
export function canvasPixels(page: Page, selector: string) {
  return page.evaluate((sel) => {
    return [...document.querySelectorAll<HTMLCanvasElement>(sel)].map((c) => {
      const owner = c.closest("[data-row]")?.getAttribute("data-row") ?? null;
      if (c.width === 0 || c.height === 0 || c.hidden) {
        return { owner, width: c.width, opaque: 0, colors: 0 };
      }
      const copy = new OffscreenCanvas(c.width, c.height);
      const ctx = copy.getContext("2d", {
        willReadFrequently: true,
      }) as OffscreenCanvasRenderingContext2D;
      ctx.drawImage(c, 0, 0);
      const px = ctx.getImageData(0, 0, c.width, c.height).data;
      let opaque = 0;
      const seen = new Set<number>();
      for (let i = 0; i < px.length; i += 4) {
        if ((px[i + 3] as number) > 0) opaque++;
        if (i % (4 * 31) === 0) {
          seen.add(
            ((px[i] as number) << 16) |
              ((px[i + 1] as number) << 8) |
              (px[i + 2] as number),
          );
        }
      }
      return { owner, width: c.width, opaque, colors: seen.size };
    });
  }, selector);
}

/** The painted facts every shot is asserted on. */
export function painted(page: Page) {
  return page.evaluate(() => {
    const root = document.scrollingElement as Element;
    const bg = getComputedStyle(document.body).backgroundColor;
    // The sub-900px overflow (CLAUDE.md): the stage painting down into the
    // timeline's card. A band of points 2px inside `#dock`'s top edge, at
    // five x positions across `#stage`'s width, so an overlap of a few
    // pixels is caught where a probe at the timeline's centre would need
    // the stage to reach halfway down the lanes. Each hit must be the
    // dock's, never the stage's.
    const dock = document.getElementById("dock");
    const stage = document.getElementById("stage");
    let dockBand: string[] | null = null;
    if (dock !== null && stage !== null) {
      const d = dock.getBoundingClientRect();
      const st = stage.getBoundingClientRect();
      dockBand = [0.1, 0.3, 0.5, 0.7, 0.9].map((f) => {
        const x = st.left + st.width * f;
        const y = d.top + 2;
        const hit = document.elementFromPoint(x, y);
        const where =
          hit === null
            ? "nothing"
            : stage.contains(hit)
              ? `stage (${hit.tagName.toLowerCase()}${hit.id ? `#${hit.id}` : ""})`
              : dock.contains(hit)
                ? "dock"
                : hit.outerHTML.slice(0, 80);
        return `${Math.round(x)},${Math.round(y)}: ${where}`;
      });
    }
    // The jump list's links as painted: each one's text, and whether the
    // point at its centre is the link itself (not covered, not clipped).
    const jumps = [
      ...document.querySelectorAll<HTMLElement>("[data-jumps] a[data-nav]"),
    ].map((a) => {
      const r = a.getBoundingClientRect();
      const hit = document.elementFromPoint(
        r.left + r.width / 2,
        r.top + r.height / 2,
      );
      return {
        text: a.innerText.replace(/\s+/g, " ").trim(),
        painted: hit !== null && a.contains(hit),
      };
    });
    const side = document.querySelector<HTMLElement>(".settings-side");
    return {
      scrollWidth: root.scrollWidth,
      innerWidth,
      theme: document.documentElement.dataset.theme ?? null,
      bg,
      dockBand,
      jumps,
      settingsSide: side === null ? null : side.innerText.trim(),
      settingsLinks: document.querySelectorAll(".settings-side a").length,
    };
  });
}

// ------------------------------------------------------------ the pages

/** The library's cards: the view the library's shots and looks were made
 *  for before the list became the studio's default (list spec §1). */
export const GRID_VIEW: LibraryViewChoice = {
  layout: "grid",
  sort: { ...DEFAULT_LIBRARY_VIEW.sort },
};

/** Stores `view` as the studio's Library view, as the page's toggle does. */
export async function storeLibraryView(
  studio: Studio,
  view: LibraryViewChoice,
): Promise<void> {
  const put = await api(studio, "/api/settings/library-view", {
    method: "PUT",
    body: { view },
  });
  if (put.status !== 200) {
    throw new Error(
      `PUT /api/settings/library-view: ${put.status} ${put.text}\nstudio log:\n${studio.logs.join("\n")}`,
    );
  }
}

export type PageName = "editor" | "library" | "kits";

/** Opens `name` and waits until its pictures are painted. The library
 *  opens on its cards (`GRID_VIEW`, stored first); the list has its own
 *  lane in studio-shots.test.ts. */
export async function openPage(
  page: Page,
  studio: Studio,
  name: PageName,
  editorTake: string,
  thumbs: Set<string>,
  /** The library's cards: the editor's take, PLAIN, and any `extra`
   *  `seedHome` was given. */
  cards = 4,
): Promise<void> {
  const path =
    name === "editor"
      ? `/editor.html?scene=${editorTake}`
      : name === "library"
        ? "/"
        : "/settings.html";
  if (name === "library") await storeLibraryView(studio, GRID_VIEW);
  await page.goto(`${studio.origin}${path}`);
  try {
    if (name === "editor") {
      await vi.waitFor(
        async () => {
          const [px] = await canvasPixels(page, "#preview");
          if (px === undefined || px.colors <= 8) {
            throw new Error(`#preview is not painted: ${JSON.stringify(px)}`);
          }
        },
        { timeout: PAINT_MS, interval: 100 },
      );
    } else if (name === "library") {
      await vi.waitFor(
        async () => {
          // The premise: the cards are drawn, not the list.
          const lists = await page.locator("[role=treegrid]").count();
          const drawn = await page.locator("article.card[data-row]").count();
          if (lists !== 0 || drawn === 0) {
            throw new Error(`${lists} lists and ${drawn} cards drawn`);
          }
          const rows = await page.locator("[data-row]").count();
          const unreadable = await page
            .locator("[data-unreadable-row]")
            .count();
          if (rows !== cards || unreadable !== 1) {
            throw new Error(`${rows} cards and ${unreadable} unreadable rows`);
          }
          // Every card's preview, painted: the cards below the fold paint
          // only near the viewport, so each is brought to it first.
          for (const row of await page.locator("[data-row]").all()) {
            await row.scrollIntoViewIfNeeded();
          }
          const px = await canvasPixels(page, "[data-preview-canvas]");
          const blank = px.filter((p) => p.opaque === 0 || p.colors < 2);
          if (px.length !== cards || blank.length > 0) {
            throw new Error(`previews not painted: ${JSON.stringify(px)}`);
          }
        },
        { timeout: PAINT_MS, interval: 100 },
      );
      await page.evaluate(() => window.scrollTo(0, 0));
    } else {
      await vi.waitFor(
        async () => {
          const tiles = await page.locator("[data-kit-tile]").count();
          const logo = await page
            .locator('[data-logo-thumb="ready"] img')
            .count();
          const [hero] = await canvasPixels(page, "[data-preview-kit]");
          if (tiles !== 2 || logo !== 1 || (hero?.colors ?? 0) < 2) {
            throw new Error(
              `${tiles} kit tiles, ${logo} logo thumbs, hero ${JSON.stringify(hero)}`,
            );
          }
        },
        { timeout: PAINT_MS, interval: 100 },
      );
    }
  } catch (error) {
    throw new Error(
      `${name} did not paint within ${PAINT_MS / 1000} s: ${String(error)}; thumbs served: ${[...thumbs].join(", ")}; page: ${await pageEvidence(page)}; log: ${studio.logs.join("\n")}`,
    );
  }
  await settle(page, name);
}

/** Fonts loaded and no transition still running, so the shot is the
 *  settled page. (Until 2026-10-19 it also waited for the theme toggle; the
 *  studio is dark only and has none.) */
export async function settle(page: Page, name: string): Promise<void> {
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  await vi.waitFor(
    async () => {
      const running = await page.evaluate(() =>
        document
          .getAnimations()
          .filter(
            (a) =>
              a.playState === "running" &&
              a.effect?.getTiming().iterations !== Number.POSITIVE_INFINITY,
          )
          .map((a) => (a as CSSTransition).transitionProperty ?? a.id),
      );
      if (running.length > 0) {
        throw new Error(`${name}: still animating: ${running.join(", ")}`);
      }
    },
    { timeout: PAINT_MS, interval: 50 },
  );
}

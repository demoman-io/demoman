import { existsSync } from "node:fs";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExportAnswer, OutputRecord } from "@demoman/run-core";
import { createLibrary, exportTake } from "@demoman/runner/studio";
import type { SceneAnswer, WindowAnswer } from "@demoman/studio-protocol";
import type { Page } from "playwright";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Rgb } from "../../../runner/src/decode-probe-entry.js";
import { launch } from "../../../runner/src/launch.js";
import { DISK_TAKE_RED, makeDiskTake } from "../../../runner/test/disk-take.js";
import { sampleImage } from "../../../runner/test/mp4-probe.js";
import { readStudioState } from "../../src/state-file.js";
import { seedTake } from "./painted-take.js";
import {
  api,
  PAGES,
  pageEvidence,
  type Studio,
  startStudio,
} from "./studio-harness.js";

// The studio end to end, on the picture: the real server (`runServe`), the
// real built pages, a real Chrome for Testing app window (`window.ts`, its
// launch only wrapped so this test can hold the context), an edit made with
// the editor's own keyboard and controls, an export through the real queue
// (`exportTake`, door "studio"), and the GIF that lands decoded. Then the
// agent's door exports the same take and must say the same sentence.
//
// Measured locally (2026-10-16, M-series Mac, headless, three runs): the
// whole case 5.9-6.0 s, of which the seeding (painting, muxing, the
// untrimmed reference GIF) is 2.0 s and the studio's window, edit and export
// 1.7-1.8 s. x5 for CI (fff4505) is 30 s; 60 s leaves room for a cold
// Chromium start on top.
const LANE_MS = 60_000;
/** The studio's export, Export pressed to the saved row: inside the 1.8 s
 *  the whole studio part measured, so x5 with room. */
const EXPORT_WAIT_MS = 30_000;
/** The span's first frame in the preview, from the press that reaches it:
 *  114-116 ms here over five runs (the span's decoder stands up on that
 *  draw). x5 for CI is 0.6 s; 15 s is room for a cold decoder on a loaded
 *  runner, where this lane runs beside the extension's lanes (ci-ts.yml). */
const SPAN_PAINT_MS = 15_000;

/** The span's frames are this blue behind the red text; the keyframes are
 *  white, so blue in the preview is a motion frame and nothing else. */
const SPAN_BLUE: Rgb = [0, 0, 255];

// ------------------------------------------------------------ the studio

let running: Studio | null = null;
const homes: string[] = [];

afterEach(async () => {
  const studio = running;
  running = null;
  try {
    // A stop that fails (the studio did not exit) is still this case's
    // failure, and the temp homes still go.
    if (studio !== null) await studio.stop();
  } finally {
    for (const home of homes.splice(0)) {
      await rm(home, { recursive: true, force: true });
    }
  }
});

async function sceneOf(studio: Studio, takeId: string): Promise<SceneAnswer> {
  const got = await api(studio, `/api/takes/${takeId}/scene`);
  if (got.status !== 200) {
    throw new Error(`GET scene answered ${got.status}: ${got.text}`);
  }
  return got.json() as SceneAnswer;
}

// ------------------------------------------------------------ the picture

/** What `#preview` holds now: its size, how many distinct colours a sparse
 *  sweep finds, and how many pixels are the span's blue or the text's red. */
async function previewPixels(page: Page): Promise<{
  width: number;
  height: number;
  colors: number;
  blue: number;
  red: number;
}> {
  return page.evaluate(
    ([blue, red]) => {
      // Copied onto a canvas of the test's own and read there: reading the
      // page's canvas again and again makes Chrome warn on its console
      // (willReadFrequently), a line this test would then have caused.
      const canvas = document.getElementById("preview") as HTMLCanvasElement;
      const { width, height } = canvas;
      const copy = new OffscreenCanvas(width, height);
      const ctx = copy.getContext("2d", {
        willReadFrequently: true,
      }) as OffscreenCanvasRenderingContext2D;
      ctx.drawImage(canvas, 0, 0);
      const px = ctx.getImageData(0, 0, width, height).data;
      const near = (i: number, [r, g, b]: number[]) =>
        Math.abs((px[i] as number) - (r as number)) <= 40 &&
        Math.abs((px[i + 1] as number) - (g as number)) <= 40 &&
        Math.abs((px[i + 2] as number) - (b as number)) <= 40;
      const seen = new Set<number>();
      let blues = 0;
      let reds = 0;
      for (let i = 0; i < px.length; i += 4) {
        if (i % (4 * 97) === 0) {
          seen.add(
            ((px[i] as number) << 16) |
              ((px[i + 1] as number) << 8) |
              (px[i + 2] as number),
          );
        }
        if (near(i, blue as number[])) blues++;
        if (near(i, red as number[])) reds++;
      }
      return { width, height, colors: seen.size, blue: blues, red: reds };
    },
    [SPAN_BLUE, DISK_TAKE_RED] as const,
  );
}

/** A GIF's frame delays, summed, in ms: walks the blocks (GIF89a §§17-27). */
function gifDurationMs(bytes: Uint8Array): { ms: number; frames: number } {
  const ascii = String.fromCharCode(...bytes.subarray(0, 6));
  if (ascii !== "GIF89a" && ascii !== "GIF87a") {
    throw new Error(`not a GIF: it starts "${ascii}"`);
  }
  const at = (i: number) => {
    const b = bytes[i];
    if (b === undefined) throw new Error(`the GIF ends early, at byte ${i}`);
    return b;
  };
  const skipSubBlocks = (from: number): number => {
    let i = from;
    for (let size = at(i); size !== 0; size = at(i)) i += size + 1;
    return i + 1;
  };
  let i = 13;
  const screen = at(10);
  if (screen & 0x80) i += 3 * 2 ** ((screen & 0x07) + 1);
  let centis = 0;
  let frames = 0;
  for (;;) {
    const block = at(i);
    if (block === 0x3b) break;
    if (block === 0x21) {
      const label = at(i + 1);
      if (label === 0xf9) centis += at(i + 4) | (at(i + 5) << 8);
      i = skipSubBlocks(i + 2);
    } else if (block === 0x2c) {
      frames += 1;
      const packed = at(i + 9);
      i += 10;
      if (packed & 0x80) i += 3 * 2 ** ((packed & 0x07) + 1);
      i = skipSubBlocks(i + 1);
    } else {
      throw new Error(`unexpected GIF block 0x${block.toString(16)} at ${i}`);
    }
  }
  return { ms: centis * 10, frames };
}

/** Where the first frame is read: its corners (the background around the
 *  window) and its middle (the page). */
const FIRST_FRAME_POINTS: [number, number][] = [
  [0.02, 0.02],
  [0.98, 0.02],
  [0.5, 0.5],
  [0.02, 0.98],
  [0.98, 0.98],
];

/** The decoded GIF: its first frame's block means (a flat frame reads one
 *  colour at every point), and the text's red in its last frame (as D1's
 *  GIF tests read it). */
async function readGif(bytes: Uint8Array) {
  const read = await sampleImage(bytes, "image/gif", {
    colors: [DISK_TAKE_RED],
    blockPoints: FIRST_FRAME_POINTS,
  });
  const first = read.readings[0];
  const last = read.readings.at(-1);
  if (first === undefined || last === undefined) {
    throw new Error("the GIF decoded no frame");
  }
  // The widest gap, per channel, between any two of the first frame's blocks.
  let spread = 0;
  for (const a of first.blocks) {
    for (const b of first.blocks) {
      for (let c = 0; c < 3; c++) {
        spread = Math.max(spread, Math.abs((a[c] ?? 0) - (b[c] ?? 0)));
      }
    }
  }
  return { read, first, spread, lastRed: last.colorCounts[0] ?? 0 };
}

/** The agent's export, on a browser of its own. */
async function agentExport(
  home: string,
  outDir: string,
  takeId: string,
): Promise<ExportAnswer> {
  const launched = await launch({ headless: true });
  try {
    return await exportTake(
      { takeId, fileType: "gif" },
      {
        library: createLibrary(home),
        videos: { videoOf: async () => null, get: async () => null },
        session: {
          headless: true,
          openWorkPage: async () => ({
            ok: true as const,
            page: await launched.context.newPage(),
          }),
        },
        home,
        wallpapersDir: join(
          import.meta.dirname,
          "..",
          "..",
          "pages",
          "public",
          "wallpapers",
        ),
        outDir,
        log: () => undefined,
        door: "agent",
      },
      () => undefined,
    );
  } finally {
    await launched.close();
  }
}

// ------------------------------------------------------------------ test

describe("the Studio, in a real window", () => {
  it(
    "edits a take with the editor's own controls, exports a GIF through the queue, and says what the agent's export says",
    async () => {
      const started = Date.now();
      const home = await mkdtemp(join(tmpdir(), "studio-lane-"));
      homes.push(home);
      const outDir = join(home, "out");
      expect(
        existsSync(join(PAGES, "editor.html")),
        `the Studio pages are built at ${PAGES} (run \`pnpm -r build\`)`,
      ).toBe(true);

      // 1. The take, and its premises.
      const take = await seedTake(home);
      const { takeId } = take;
      expect(
        take.scene.camera.map((c) => [c.kind, c.anchorId, c.scale]),
        "the premise: the take zooms on the search field",
      ).toEqual([["zoom", "a-search", 2.2]]);
      expect(
        take.bundle.motionSpans.map((s) => [s.ref, s.byteLength > 0]),
        "the premise: the take has one muxed motion span on disk",
      ).toEqual([[`span:${takeId}:0`, true]]);
      const cursor = take.bundle.cursorSamples;
      expect(
        cursor.length > 1 &&
          (cursor[0]?.x !== cursor.at(-1)?.x ||
            cursor[0]?.y !== cursor.at(-1)?.y),
        `the premise: the cursor moves (${JSON.stringify(cursor)})`,
      ).toBe(true);
      expect(
        take.scene.canvas.aspect,
        "the premise: not portrait yet",
      ).not.toBe("9:16");
      expect(
        take.scene.edits.trim,
        "the premise: the take is untrimmed",
      ).toBeUndefined();

      // The untrimmed take's GIF, in a library of its own, so the studio's
      // outputs.json is the studio's alone.
      const refHome = await mkdtemp(join(tmpdir(), "studio-lane-ref-"));
      homes.push(refHome);
      await mkdir(join(refHome, "takes"), { recursive: true });
      await cp(join(home, "takes", takeId), join(refHome, "takes", takeId), {
        recursive: true,
      });
      const untrimmed = await agentExport(
        refHome,
        join(refHome, "out"),
        takeId,
      );
      if (untrimmed.outcome !== "saved" || untrimmed.fileType === "stills") {
        throw new Error(
          `the untrimmed reference: ${JSON.stringify(untrimmed)}`,
        );
      }
      const untrimmedGif = gifDurationMs(await readFile(untrimmed.file.path));
      const seeded = Date.now();

      // 2. The studio, and its window on the take.
      const studio = await startStudio(home, outDir);
      running = studio;
      const opened = await api(studio, "/api/window", {
        method: "POST",
        body: { takeId },
      });
      expect(opened.status, `${opened.text}\n${studio.logs.join("\n")}`).toBe(
        200,
      );
      const windowAnswer = opened.json() as WindowAnswer;
      expect(windowAnswer.path).toBe(`/editor.html?scene=${takeId}`);
      const context = studio.context();
      const pages = context.pages();
      // The app window opened alone: no about:blank beside it.
      expect(
        pages.map((p) => p.url()),
        "the Studio's browser holds exactly the app window",
      ).toEqual([`${studio.origin}${windowAnswer.path}`]);
      const page = pages[0] as Page;

      // Every console line and page error from a load this test watched
      // from its start, and every CSP violation the page reports.
      const consoleLines: string[] = [];
      page.on("console", (m) =>
        consoleLines.push(`${m.type()}: ${m.text()} (${m.location().url})`),
      );
      page.on("pageerror", (e) => consoleLines.push(`pageerror: ${e.message}`));
      page.on("response", (r) => {
        if (r.status() >= 400) {
          consoleLines.push(
            `response: ${r.status()} ${r.request().method()} ${r.url()}`,
          );
        }
      });
      await context.addInitScript(() => {
        const w = window as unknown as { __csp: string[] };
        w.__csp = [];
        document.addEventListener("securitypolicyviolation", (e) => {
          w.__csp.push(`${e.violatedDirective} ${e.blockedURI}`);
        });
      });
      // A laptop's window, not the headless default of ~760x520, in which
      // the export panel would not be open beside the preview.
      const cdp = await context.newCDPSession(page);
      const { windowId } = (await cdp.send("Browser.getWindowForTarget")) as {
        windowId: number;
      };
      await cdp.send("Browser.setWindowBounds", {
        windowId,
        bounds: { width: 1440, height: 900 },
      });
      await cdp.detach();
      await page.reload();
      const arrivals: Page[] = [];
      context.on("page", (p) => arrivals.push(p));
      const cspViolations = () =>
        page.evaluate(() => (window as unknown as { __csp: string[] }).__csp);

      // 3a. The preview paints the take: a picture, not a blank canvas.
      await vi.waitFor(
        async () => {
          const px = await previewPixels(page);
          if (px.colors <= 8 || px.red === 0) {
            throw new Error(`#preview is not painted: ${JSON.stringify(px)}`);
          }
        },
        { timeout: 30_000, interval: 100 },
      );

      // 3b. A motion frame. One Shift+→ puts the playhead at 0.5 s, which is
      // inside the span (source 0.4-3.2 s; measured, and asserted here: the
      // preview shows the span's blue, which no keyframe has).
      await page.locator("body").focus();
      const clock = page.locator("#toolbar-clock");
      const first = await previewPixels(page);
      expect(
        first.blue,
        `the premise: the take's first frame, a keyframe, has no blue: ${JSON.stringify(first)}`,
      ).toBe(0);
      expect(
        await clock.innerText(),
        "the premise: the playhead starts at the head",
      ).toMatch(/^0:00 \//);
      await page.keyboard.press("Shift+ArrowRight");
      let atSpan = first;
      const spanStarted = Date.now();
      try {
        await vi.waitFor(
          async () => {
            atSpan = await previewPixels(page);
            if (atSpan.blue < 500) throw new Error("no blue yet");
          },
          { timeout: SPAN_PAINT_MS, interval: 50 },
        );
      } catch {
        throw new Error(
          `the preview painted no motion frame at 0.5 s within ${SPAN_PAINT_MS / 1000} s: ${JSON.stringify({ preview: atSpan, clock: await clock.innerText(), consoleLines, page: await pageEvidence(page), log: studio.logs })}`,
        );
      }
      const spanPaintMs = Date.now() - spanStarted;

      // 3c. Trim the end at the playhead, through the timeline's shortcut:
      // forward to 3.0 s first, so the GIF keeps more than a moment. Each
      // press is 0.5 s (NUDGE_COARSE_MS), and each waits for the clock to
      // show where that press put the playhead, so the trim's position is
      // the presses' and not how fast the page drew.
      const TRIM_AT_MS = 3_000;
      let playheadMs = 500;
      let presses = 1;
      while (playheadMs < TRIM_AT_MS) {
        await page.keyboard.press("Shift+ArrowRight");
        presses += 1;
        playheadMs += 500;
        const want = `0:0${Math.floor(playheadMs / 1000)} /`;
        try {
          await expect
            .poll(() => clock.innerText(), { timeout: 5_000 })
            .toMatch(new RegExp(`^${want}`));
        } catch {
          throw new Error(
            `after ${presses} presses (the playhead at ${playheadMs} ms) the clock reads "${await clock.innerText()}", not "${want}…"; preview: ${JSON.stringify(await previewPixels(page))}; page: ${await pageEvidence(page)}`,
          );
        }
      }
      const before = await sceneOf(studio, takeId);
      await page.keyboard.press("o");
      const trimmed = await vi.waitFor(
        async () => {
          const now = await sceneOf(studio, takeId);
          if (
            now.revision === before.revision ||
            now.scene.edits.trim?.tail === undefined
          ) {
            throw new Error(
              `the trim is not saved yet: ${JSON.stringify(now.scene.edits.trim)}; page: ${await pageEvidence(page)}`,
            );
          }
          return now;
        },
        { timeout: 15_000, interval: 100 },
      );

      // 3d. Portrait, from the aspect control under the preview.
      await page.locator('[data-aspect="9:16"]:visible').click();
      await vi.waitFor(
        async () => {
          const now = await sceneOf(studio, takeId);
          if (now.scene.canvas.aspect !== "9:16") {
            throw new Error(`the aspect is ${now.scene.canvas.aspect}`);
          }
        },
        { timeout: 15_000, interval: 100 },
      );

      // 3e. GIF, Export, and the outcome row's summary.
      await page.locator('[data-file-type="gif"]').click();
      await expect
        .poll(() =>
          page.locator('[data-file-type="gif"]').getAttribute("aria-checked"),
        )
        .toBe("true");
      await page.locator("[data-export-start]").click();
      const summaryLocator = page.locator(
        '[data-save-outcome="saved"] .muted[data-save-summary]',
      );
      try {
        await summaryLocator.waitFor({ timeout: EXPORT_WAIT_MS });
      } catch (error) {
        const outcome = await page
          .locator("[data-panel-export]")
          .innerText()
          .catch((e: unknown) => `(unreadable: ${String(e)})`);
        throw new Error(
          `no saved summary: ${String(error)}\nexport panel: ${outcome}\nconsole: ${consoleLines.join("\n")}\nlog: ${studio.logs.join("\n")}`,
        );
      }
      const pageSummary = await summaryLocator.innerText();
      const exported = Date.now();

      // The render ran in the studio's headless browser, not the person's:
      // the export above saved, and no page opened in this browser while it
      // did (a visible work window, 2026-10-23, is what this guards). The
      // app window is still the editor.
      expect(
        arrivals.map((p) => p.url()),
        `pages that opened in the person's browser\n${studio.logs.join("\n")}`,
      ).toEqual([]);
      expect(context.pages().map((p) => p.url())).toEqual([
        `${studio.origin}${windowAnswer.path}`,
      ]);

      // 4. outputs.json: one row, its file there, its summary the page's.
      const rows = JSON.parse(
        await readFile(join(home, "takes", takeId, "outputs.json"), "utf8"),
      ) as OutputRecord[];
      expect(rows, JSON.stringify(rows)).toHaveLength(1);
      const row = rows[0] as OutputRecord;
      expect(row.fileType, JSON.stringify(row)).toBe("gif");
      expect(row.aspect).toBe("9:16");
      expect(existsSync(row.path), row.path).toBe(true);
      expect(row.report.summary).toBe(pageSummary);
      const report = row.report;
      if (report.outcome !== "saved" || report.fileType === "stills") {
        throw new Error(JSON.stringify(report));
      }
      expect(report.file.path).toBe(row.path);

      // The GIF decodes, in portrait, at the size the report names.
      const gifBytes = await readFile(row.path);
      const gif = await readGif(gifBytes);
      expect([gif.read.width, gif.read.height], JSON.stringify(report)).toEqual(
        [report.width, report.height],
      );
      expect(report.height).toBeGreaterThan(report.width);
      // Not one flat colour: the first frame's corners (the background) and
      // middle (the page) differ. Its red is not asked for: the 9:16 camera
      // has not reached the field in the first frame ...
      expect(gif.spread, JSON.stringify(gif.first)).toBeGreaterThan(20);
      // ... and the last frame shows the frames' own red text, as D1 reads it.
      expect(
        gif.lastRed,
        JSON.stringify(gif.read.readings.at(-1)),
      ).toBeGreaterThan(20);
      // The edited length: shorter than the untrimmed take's GIF.
      const trimmedGif = gifDurationMs(gifBytes);
      expect(
        trimmedGif.ms,
        JSON.stringify({
          trimmedGif,
          untrimmedGif,
          trim: trimmed.scene.edits.trim,
        }),
      ).toBeLessThan(untrimmedGif.ms - 500);

      // No CSP violation and no console fault on the page, start to end.
      expect(await cspViolations(), consoleLines.join("\n")).toEqual([]);
      expect(
        consoleLines.filter(
          (l) =>
            l.startsWith("error") ||
            l.startsWith("warning") ||
            l.startsWith("pageerror") ||
            l.startsWith("response"),
        ),
        consoleLines.join("\n"),
      ).toEqual([]);

      // 5. The agent's door, on the same take as the studio left it, saves
      // to the same path (the studio's file moved aside) and says the same
      // sentence.
      await rename(row.path, `${row.path}.studio`);
      const agent = await agentExport(home, outDir, takeId);
      if (agent.outcome !== "saved" || agent.fileType === "stills") {
        throw new Error(`the agent's export: ${JSON.stringify(agent)}`);
      }
      expect(
        agent.file.path,
        "the premise: both doors name the file alike",
      ).toBe(row.path);
      expect(agent.summary).toBe(pageSummary);

      // The studio ends cleanly: exit 0, and studio.json removed.
      running = null;
      expect(await studio.stop(), studio.logs.join("\n")).toBe(0);
      expect(await readStudioState(home)).toBeNull();

      console.info(
        `studio lane: span painted ${spanPaintMs} ms after its press, seeding ${seeded - started} ms, studio ${exported - seeded} ms, total ${Date.now() - started} ms; GIF ${trimmedGif.ms} ms of ${untrimmedGif.ms} ms`,
      );
    },
    LANE_MS,
  );
});

describe("the editor's size readout in the Studio", () => {
  it(
    "names the size the Studio will export at: Sharing's frame for a 4K-backed take, and follows the setting",
    async () => {
      const home = await mkdtemp(join(tmpdir(), "studio-readout-"));
      homes.push(home);
      // A 16:9 take whose keyframes claim 3840 x 2400, which at Full backs
      // the 4K tier (`pickLandscapeTarget`): the readout can only read 1080p
      // if the editor passes the studio's quality to `targetFor`.
      const disk = await makeDiskTake(home);
      const library = createLibrary(home);
      const bundle = {
        ...disk.bundle,
        keyframes: disk.bundle.keyframes.map((k) => ({
          ...k,
          width: 3840,
          height: 2400,
        })),
      };
      await library.frameStore(disk.takeId).putBundle(disk.takeId, bundle);
      await library.putScene({
        ...disk.original,
        canvas: { ...disk.original.canvas, aspect: "16:9" },
      });
      expect(
        Math.max(...bundle.keyframes.map((k) => k.width)),
        "the premise: the keyframes back the 4K tier",
      ).toBe(3840);
      await writeFile(
        join(home, "settings.json"),
        '{"exportQuality":"share"}\n',
      );

      const studio = await startStudio(home, join(home, "out"));
      running = studio;
      const opened = await api(studio, "/api/window", {
        method: "POST",
        body: { takeId: disk.takeId },
      });
      expect(opened.status, `${opened.text}\n${studio.logs.join("\n")}`).toBe(
        200,
      );
      const context = studio.context();
      const page = context.pages()[0] as Page;
      const cdp = await context.newCDPSession(page);
      const { windowId } = (await cdp.send("Browser.getWindowForTarget")) as {
        windowId: number;
      };
      await cdp.send("Browser.setWindowBounds", {
        windowId,
        bounds: { width: 1440, height: 900 },
      });
      await cdp.detach();

      const readout = page.locator("[data-size-readout]");
      const said = async () => (await readout.textContent()) ?? "";
      await vi.waitFor(
        async () => {
          if (!(await said()).includes("Video "))
            throw new Error(`no readout yet: ${await pageEvidence(page)}`);
        },
        { timeout: 30_000, interval: 100 },
      );
      expect(await said(), await pageEvidence(page)).toContain(
        "Video 1920 × 1080",
      );
      expect(await said()).not.toContain("3840");

      // The positive control, and the refresh: choose Full elsewhere, look at
      // the window again, and the same readout names the 4K frame.
      const put = await api(studio, "/api/settings/export-quality", {
        method: "PUT",
        body: { exportQuality: "full" },
      });
      expect(put.status, put.text).toBe(200);
      await page.evaluate(() => window.dispatchEvent(new Event("focus")));
      await vi.waitFor(
        async () => {
          if (!(await said()).includes("Video 3840 × 2160")) {
            throw new Error(`the readout says "${await said()}"`);
          }
        },
        { timeout: 15_000, interval: 100 },
      );
    },
    LANE_MS,
  );
});

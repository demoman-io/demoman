// DEM-154/155: the key and click marks are in the picture. The compare
// script `compare/scripts/inputs.json` (Mod+K, Escape, a double-click, a
// right-click, a click, a Shift-click) runs through the real executor (held
// clock, the default), is exported, and is read from decoded frames at
// instants taken from the resolved plan, as the export composes it: the
// keycap pill at the bottom centre, the ×2 tag and the right-click mouse
// beside the pointer, and no ripple at the right-click.
//
// Every region is derived from the plan (the camera, the pointer, the
// action's own rect) and the pill's mockup geometry; none depends on a
// glyph's advance width, so CI's fonts cannot move one.
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CURSOR_ART,
  composeForTarget,
  cssRectToOutput,
  cssToOutput,
  type FrameBundle,
  planScene,
  sampleCursor,
  sceneCameraAt,
  toSourceMs,
} from "@demoman/compositor";
import {
  DEFAULT_EXPORT_QUALITY,
  type ExportAnswer,
  frameOf,
  targetFor,
} from "@demoman/run-core";
import type { SceneDocument } from "@demoman/scene-schema";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type {
  Rect as FrameRect,
  RectReading,
} from "../src/decode-probe-entry.js";
import { createLocalExecutor } from "../src/executor/executor.js";
import { createLibrary } from "../src/executor/library.js";
import type { LocalExecutor } from "../src/executor/types.js";
import { listenOnLoopback } from "../src/loopback.js";
import { ownVideo, WALLPAPERS_DIR } from "./fixture.js";
import { sampleMp4 } from "./mp4-probe.js";

// Measured locally (2026-11-24, Mac): the run and the 2560x1758 export
// together 15.4 s; the timeouts are x5 for CI's slower composing (fff4505)
// with margin, as the dialog test's.
const RUN_MS = 120_000;
const EXPORT_MS = 300_000;

type Rgb = [number, number, number];
/** `#111c` over white: 17 · 0.8 + 255 · 0.2. */
const PILL_ON_WHITE: Rgb = [65, 65, 65];
const TAG_DARK: Rgb = [0x18, 0x18, 0x1b];
const MOUSE_BLUE: Rgb = [0x1a, 0x73, 0xe8];
/** A ripple's dark edge (`rgba(15, 23, 42, 0.75 · (1 - t))`) over white,
 *  40 ms into its 400 ms (t = 0.1). */
const RIPPLE_EDGE: Rgb = [93, 98, 111];
/** `#items > div.selected`'s `#cde`. */
const SELECTED: Rgb = [0xcc, 0xdd, 0xee];
const COLORS = [PILL_ON_WHITE, TAG_DARK, MOUSE_BLUE, RIPPLE_EDGE, SELECTED];
const [PILL, TAG, BLUE, RIPPLE, SEL] = [0, 1, 2, 3, 4];

/** The mockup's pill (`KEYCAP_PILL`), in its 1280-wide stage's px. */
const PILL_BOTTOM = 58;
const PILL_HEIGHT = 64; // 2 · padY 10 + cap 44
const PILL_PAD = 10;
const CAP = 44;
/** The tag's text is 15 px against the mockup's 32 px pointer; ours is
 *  `CURSOR_ART`'s 40, so the tag and mouse scale by this against `uiScale`. */
const POINTER_UNIT = CURSOR_ART.light.height / 32;

const html = () =>
  readFile(join(import.meta.dirname, "fixtures", "inputs-app.html"), "utf8");
const script = async () =>
  JSON.parse(
    await readFile(
      join(import.meta.dirname, "..", "compare", "scripts", "inputs.json"),
      "utf8",
    ),
  ) as { name: string; steps: unknown[]; viewport: unknown };

let server: Server;
let home: string;
let executor: LocalExecutor;
let takeId: string;
let recording: unknown;
let outcome: unknown;

beforeAll(async () => {
  const page = await html();
  server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(page);
  });
  const url = `${await listenOnLoopback(server)}/`;
  home = await mkdtemp(join(tmpdir(), "demoman-inputs-picture-"));
  executor = createLocalExecutor({
    wallpapersDir: WALLPAPERS_DIR,
    home,
    headless: true,
    standInDisplay: true,
    env: { ...process.env, DEMOMAN_DISPLAY: "1440x900@2" },
    outDir: join(home, "out"),
    log: () => undefined,
  });
  const run = await executor.request("run", {
    video: ownVideo(),
    callId: "inputs-picture-take",
    script: {
      ...(await script()),
      target: url,
      // A white page on a white background: a mark reads against white.
      look: {
        branding: {
          background: { kind: "solid", color: "#ffffff" },
          logo: null,
        },
      },
    },
  });
  const report = run.ok
    ? (run.value as {
        outcome?: unknown;
        provenance?: { takeId?: unknown };
        run?: { recording?: unknown };
      })
    : undefined;
  const id = report?.provenance?.takeId;
  if (typeof id !== "string") {
    throw new Error(`the take was not made: ${JSON.stringify(run)}`);
  }
  takeId = id;
  recording = report?.run?.recording;
  outcome = report?.outcome;
}, RUN_MS);

afterAll(async () => {
  await executor?.close();
  server?.close();
  if (home) await rm(home, { recursive: true, force: true });
});

type Box = { x: number; y: number; width: number; height: number };

describe("keys and clicks in a held take", () => {
  it(
    "draws the pill, the ×2 tag and the right-click mouse where the plan puts them",
    async () => {
      expect(outcome, JSON.stringify({ outcome, recording })).toBe("complete");
      expect(recording, JSON.stringify(recording)).toMatchObject({
        clock: "held",
      });
      const out = await executor.request("export", {
        takeId,
        callId: "inputs-picture-export",
        quality: DEFAULT_EXPORT_QUALITY,
      });
      if (!out.ok) throw new Error(JSON.stringify(out));
      const answer = out.value as ExportAnswer;
      if (answer.outcome !== "saved" || answer.fileType === "stills") {
        throw new Error(JSON.stringify(answer));
      }

      // The composition the export drew: the same target, the same plan.
      const library = createLibrary(home);
      const scene = (await library.getScene(takeId)) as SceneDocument;
      const bundle = (await library
        .frameStore(takeId)
        .getBundle(takeId)) as FrameBundle;
      const target = targetFor(
        "mp4",
        scene.canvas.aspect,
        bundle,
        frameOf(scene),
        {
          quality: DEFAULT_EXPORT_QUALITY,
        },
      );
      expect(
        [target.width, target.height],
        `premise: the export's size is the target composed here; ${JSON.stringify(answer)}`,
      ).toEqual([answer.width, answer.height]);
      const { resolved, presentation } = composeForTarget({
        plan: planScene(scene),
        bundle,
        scene,
        target,
      });
      const { frameRect } = presentation;
      const viewport = resolved.plan.viewport;
      const W = target.width;
      const H = target.height;
      const plan = JSON.stringify({
        range: resolved.range,
        keycaps: resolved.keycaps,
        clickTags: resolved.clickTags,
        rightClicks: resolved.rightClicks,
        pulseOutputMs: resolved.pulseOutputMs,
      });

      // Premise: the plan has the marks this take asked for, in order.
      expect(
        resolved.keycaps.map((p) => [p.caps, p.suffix]),
        `the pills; ${plan}`,
      ).toEqual([
        [[{ glyph: "command" }, { text: "K" }], undefined],
        [[{ text: "esc" }], undefined],
        [[{ glyph: "shift" }], "+ click"],
      ]);
      expect(
        resolved.clickTags.map((t) => t.count),
        plan,
      ).toEqual([2]);
      expect(resolved.rightClicks.length, plan).toBe(1);
      const [modK, , shift] = resolved.keycaps as [
        (typeof resolved.keycaps)[number],
        (typeof resolved.keycaps)[number],
        (typeof resolved.keycaps)[number],
      ];
      const tagMs = (resolved.clickTags[0] as { outputMs: number }).outputMs;
      const rightMs = resolved.rightClicks[0] as number;

      const clickOf = (
        pred: (a: SceneDocument["actions"][number]) => boolean,
      ) => {
        const a = scene.actions.find((x) => x.kind === "click" && pred(x));
        const rect = a && "rect" in a ? a.rect : undefined;
        if (rect === undefined) {
          throw new Error(
            `premise: the click and its rect; ${JSON.stringify(scene.actions)}`,
          );
        }
        return rect;
      };
      const row2 = clickOf((a) => "clicks" in a && a.clicks === 2);
      const row4 = clickOf((a) => "button" in a && a.button === "right");
      const row3 = clickOf(
        (a) => "modifiers" in a && a.modifiers !== undefined,
      );

      // --- Where things are at an output instant, from the plan. ---
      const cameraAt = (ms: number) =>
        sceneCameraAt(resolved, presentation, target, ms);
      const tipAt = (ms: number) => {
        const css = sampleCursor(
          resolved.cursor,
          toSourceMs(resolved.timeline, ms),
        );
        if (css === null)
          throw new Error(`premise: a pointer at ${ms}; ${plan}`);
        return cssToOutput(css, cameraAt(ms), frameRect, viewport);
      };
      /** The pointer's `uiScale` as `renderFrame` computes it. */
      const uiAt = (ms: number) =>
        (H / 1080) * resolved.cursorLook.scale * cameraAt(ms).scale;
      const rowAt = (rect: Box, ms: number) =>
        cssRectToOutput(rect, cameraAt(ms), frameRect, viewport);
      const s = W / 1280;
      const pillTop = H - (PILL_BOTTOM + PILL_HEIGHT) * s;
      /** The pill's top padding, across its middle: pill fill only, for any
       *  caps (every pill is at least 2 · 14 + 44 = 72 px wide, centred). */
      const pillBand: Box = {
        x: W / 2 - 20 * s,
        y: pillTop + 2 * s,
        width: 40 * s,
        height: (PILL_PAD - 4) * s,
      };
      /** Left of centre, inside the caps' height: the ⌘ cap of a ⌘K pill.
       *  K's cap is 44 px for any K narrower than 20 px, and K's ink starts
       *  right of centre; a wider K would only push ⌘ further left. */
      const commandCap: Box = {
        x: W / 2 - 70 * s,
        y: pillTop + (PILL_PAD + 8) * s,
        width: 67 * s,
        height: (CAP - 16) * s,
      };
      /** Lower right of the pointer's tip, clear of the arrow (24 · uiScale
       *  wide): where the tag (from 44, 33) and the mouse (from 30, 25) sit,
       *  in the mockup's pointer units. */
      const besideAt = (ms: number): Box => {
        const tip = tipAt(ms);
        const k = uiAt(ms) * POINTER_UNIT;
        return {
          x: tip.x + 26 * k,
          y: tip.y + 20 * k,
          width: 90 * k,
          height: 60 * k,
        };
      };
      /** Upper left of the tip, which only a ripple (radius 16 to 51 ·
       *  uiScale, a full circle) reaches: the arrow, tag and mouse all hang
       *  down and to the right. */
      const upperLeftAt = (ms: number): Box => {
        const tip = tipAt(ms);
        const u = uiAt(ms);
        return {
          x: tip.x - 55 * u,
          y: tip.y - 55 * u,
          width: 47 * u,
          height: 47 * u,
        };
      };
      const inset = (r: Box): Box => ({
        x: r.x + r.width * 0.3,
        y: r.y + r.height * 0.2,
        width: r.width * 0.7,
        height: r.height * 0.6,
      });

      // --- The instants, all from the plan, and what to read at each. ---
      const end = resolved.range.endMs - 40;
      const reads: { name: string; ms: number; box: Box }[] = [
        {
          name: "before the first pill: band",
          ms: modK.range.startMs - 100,
          box: pillBand,
        },
        {
          name: "⌘K pill: band",
          ms: (modK.range.startMs + modK.range.endMs) / 2,
          box: pillBand,
        },
        {
          name: "⌘K pill: ⌘ cap",
          ms: (modK.range.startMs + modK.range.endMs) / 2,
          box: commandCap,
        },
        {
          name: "double-click: beside",
          ms: tagMs + 270,
          box: besideAt(tagMs + 270),
        },
        {
          name: "after the tag: beside",
          ms: tagMs + 560 + 120,
          box: besideAt(tagMs + 560 + 120),
        },
        {
          name: "double-click: upper left",
          ms: tagMs + 40,
          box: upperLeftAt(tagMs + 40),
        },
        {
          name: "after its ripples: upper left",
          ms: tagMs + 560,
          box: upperLeftAt(tagMs + 560),
        },
        {
          name: "right-click: beside",
          ms: rightMs + 350,
          box: besideAt(rightMs + 350),
        },
        {
          name: "after the mouse: beside",
          ms: rightMs + 700 + 120,
          box: besideAt(rightMs + 700 + 120),
        },
        {
          name: "right-click: upper left",
          ms: rightMs + 40,
          box: upperLeftAt(rightMs + 40),
        },
        {
          name: "before the Shift pill: band",
          ms: shift.range.startMs - 60,
          box: pillBand,
        },
        {
          name: "Shift pill: band",
          ms: (shift.range.startMs + shift.range.endMs) / 2,
          box: pillBand,
        },
        {
          name: "Shift pill: row 3",
          ms: shift.range.endMs - 150,
          box: inset(rowAt(row3, shift.range.endMs - 150)),
        },
        { name: "last frame: row 3", ms: end, box: inset(rowAt(row3, end)) },
      ];
      for (const r of reads) {
        expect(
          r.ms,
          `premise: ${r.name} at ${r.ms} is inside the export; ${plan}`,
        ).toBeGreaterThanOrEqual(resolved.range.startMs);
        expect(r.ms, `${r.name}; ${plan}`).toBeLessThan(resolved.range.endMs);
      }
      // Premise: the double- and right-click's pointer is on its row.
      for (const [name, rect, ms] of [
        ["row 2", row2, tagMs],
        ["row 4", row4, rightMs],
      ] as const) {
        const tip = tipAt(ms);
        const r = rowAt(rect, ms);
        expect(
          tip.x >= r.x - 2 &&
            tip.x <= r.x + r.width + 2 &&
            tip.y >= r.y - 2 &&
            tip.y <= r.y + r.height + 2,
          `premise: the pointer at ${JSON.stringify(tip)} is on ${name} ${JSON.stringify(r)} at ${ms}`,
        ).toBe(true);
      }

      const frac = (b: Box): FrameRect => [
        Math.max(0, b.x / W),
        Math.max(0, b.y / H),
        Math.min(1, (b.x + b.width) / W),
        Math.min(1, (b.y + b.height) / H),
      ];
      const atSecs = [
        ...new Set(reads.map((r) => (r.ms - resolved.range.startMs) / 1000)),
      ].sort((a, b) => a - b);
      const bytes = new Uint8Array(await readFile(answer.file.path));
      const sample = await sampleMp4(bytes, {
        colors: COLORS,
        rects: reads.map((r) => frac(r.box)),
        atSecs,
      });
      /** Rect i of `reads`, at its own instant. */
      const got = reads.map((r, i) => {
        const t = (r.ms - resolved.range.startMs) / 1000;
        const frame = sample.readings.find((f) => f.tSec === t);
        if (frame === undefined) throw new Error(`no frame read at ${t}`);
        const rect = frame.rects[i] as RectReading;
        return { ...r, t, rect };
      });
      const said = JSON.stringify({
        frame: [W, H],
        file: answer.file.path,
        reads: got.map((g) => ({
          name: g.name,
          outputMs: Math.round(g.ms),
          t: Number(g.t.toFixed(3)),
          box: [g.box.x, g.box.y, g.box.width, g.box.height].map(Math.round),
          total: g.rect.total,
          meanLuma: Math.round(g.rect.meanLuma),
          nearWhite: g.rect.nearWhite,
          pill: g.rect.colorCounts[PILL],
          tag: g.rect.colorCounts[TAG],
          blue: g.rect.colorCounts[BLUE],
          ripple: g.rect.colorCounts[RIPPLE],
          selected: g.rect.colorCounts[SEL],
        })),
        plan,
      });
      const read = (name: string) => {
        const g = got.find((x) => x.name === name);
        if (g === undefined) throw new Error(name);
        return {
          ...g.rect,
          share: (c: number) =>
            (g.rect.colorCounts[c] as number) / g.rect.total,
          count: (c: number) => g.rect.colorCounts[c] as number,
          at: `${name} (output ${Math.round(g.ms)} ms, t=${g.t.toFixed(3)} s, mean luma ${Math.round(g.rect.meanLuma)})`,
        };
      };

      // Premise: no pill before the first press; the band is white page.
      const before = read("before the first pill: band");
      expect(
        before.share(PILL),
        `no pill-dark at ${before.at}; ${said}`,
      ).toBeLessThan(0.02);
      expect(
        before.meanLuma,
        `white under the band at ${before.at}; ${said}`,
      ).toBeGreaterThan(230);
      // Premise: the take ends on row 3 selected.
      const last = read("last frame: row 3");
      expect(
        last.share(SEL),
        `row 3 selected at ${last.at}; ${said}`,
      ).toBeGreaterThan(0.8);

      // ⌘K: the band is pill-dark, and the ⌘ cap carries white ink.
      const band = read("⌘K pill: band");
      expect(
        band.share(PILL),
        `pill-dark at ${band.at}; ${said}`,
      ).toBeGreaterThan(0.8);
      const cmd = read("⌘K pill: ⌘ cap");
      // Measured 0.73 pill-dark (the rest is the cap's fill and ink).
      expect(
        cmd.share(PILL),
        `the pill covers the ⌘ cap at ${cmd.at}; ${said}`,
      ).toBeGreaterThan(0.4);
      expect(
        cmd.nearWhite / cmd.total,
        `white ink at the ⌘ cap at ${cmd.at}; ${said}`,
      ).toBeGreaterThan(0.02);

      // The double-click: tag-dark beside row 2, gone once the tag is.
      // Measured 778 px per unit² (the tag is ~36 x 26 units), then 0.
      const k2 = (ms: number) => (uiAt(ms) * POINTER_UNIT) ** 2;
      const tag = read("double-click: beside");
      expect(
        tag.count(TAG) / k2(tagMs + 270),
        `tag-dark (px per pointer unit²) at ${tag.at}; ${said}`,
      ).toBeGreaterThan(200);
      const tagGone = read("after the tag: beside");
      expect(
        tagGone.count(TAG) / k2(tagMs + 680),
        `no tag-dark at ${tagGone.at}; ${said}`,
      ).toBeLessThan(50);
      // And its ripple: the control that the upper-left read sees one.
      const ripple = read("double-click: upper left");
      const rippleGone = read("after its ripples: upper left");
      const u2 = (ms: number) => uiAt(ms) ** 2;
      expect(
        ripple.count(RIPPLE) / u2(tagMs + 40),
        `ripple edge (px per uiScale²) at ${ripple.at}; ${said}`,
      ).toBeGreaterThan(RIPPLE_MIN);
      expect(
        rippleGone.count(RIPPLE) / u2(tagMs + 560),
        `no ripple edge at ${rippleGone.at}; ${said}`,
      ).toBeLessThan(RIPPLE_MIN / 4);

      // The right-click: mouse-blue beside row 4, gone after, and no ripple.
      // Measured 99 px per unit² (the lit button is ~10 x 15), then 0.
      const mouse = read("right-click: beside");
      expect(
        mouse.count(BLUE) / k2(rightMs + 350),
        `mouse-blue (px per pointer unit²) at ${mouse.at}; ${said}`,
      ).toBeGreaterThan(60);
      const mouseGone = read("after the mouse: beside");
      expect(
        mouseGone.count(BLUE) / k2(rightMs + 820),
        `no mouse-blue at ${mouseGone.at}; ${said}`,
      ).toBeLessThan(10);
      const noRipple = read("right-click: upper left");
      expect(
        noRipple.count(RIPPLE) / u2(rightMs + 40),
        `no ripple edge at the right-click, ${noRipple.at}; ${said}`,
      ).toBeLessThan(RIPPLE_MIN / 4);

      // The Shift-click: a pill again, translucent over the page, and the
      // page shows its answer while the pill is up.
      const under = read("before the Shift pill: band");
      expect(
        under.meanLuma,
        `premise: white under the band at ${under.at}; ${said}`,
      ).toBeGreaterThan(230);
      const shiftBand = read("Shift pill: band");
      expect(
        shiftBand.share(PILL),
        `pill-dark at ${shiftBand.at}; ${said}`,
      ).toBeGreaterThan(0.8);
      // `#111c` over white reads 65; opaque it would read 17.
      expect(
        shiftBand.meanLuma,
        `the page shows through the pill at ${shiftBand.at}; ${said}`,
      ).toBeGreaterThan(40);
      const row3During = read("Shift pill: row 3");
      expect(
        row3During.share(SEL),
        `row 3 selected while the pill is up, ${row3During.at}; ${said}`,
      ).toBeGreaterThan(0.8);

      if (process.env.DEM154_KEEP_MP4) {
        const { copyFile } = await import("node:fs/promises");
        await copyFile(answer.file.path, process.env.DEM154_KEEP_MP4);
      }
    },
    RUN_MS + EXPORT_MS,
  );
});

/** Fewest ripple-edge px per uiScale² in the upper-left quarter, 40 ms
 *  in. Measured 35.6 at the double-click, 0.26 once its ripples were over
 *  and 0 at the right-click; 12 leaves 3x for CI's encode. */
const RIPPLE_MIN = 12;

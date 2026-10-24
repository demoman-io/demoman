// Slow tier: runs a take and exports it in software. `pnpm test:fast` skips it; `pnpm test` and CI run it.
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FrameBundle } from "@demoman/compositor";
import type { ExportAnswer } from "@demoman/run-core";
import type { SceneDocument } from "@demoman/scene-schema";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLocalExecutor } from "../src/executor/executor.js";
import { createLibrary } from "../src/executor/library.js";
import type { LocalExecutor } from "../src/executor/types.js";
import { ownVideo } from "./fixture.js";
import { mp4FrameTimes, readMp4Crops } from "./mp4-probe.js";

// Spec 2026-10-19 (unhurried beats), on the picture. The site's hero typed
// "4800" and clicked "Create invoice", and the camera set off toward the
// button 1.65 s before the click, while the amount was still going in. The
// film must show the typing finished, and a settle, before the camera
// moves; and the camera settled on the button before the click.
//
// Measured locally as executor-export-zooms.test.ts measures its own: a run
// of a two-step take, then one export. x5 for CI (fff4505).
const RUN_MS = 60_000;
const EXPORT_MS = 120_000;
const SETTLE_MS = 400;
/** Mean per-channel change between frames (0-255, `frameTimes`) above which
 *  the whole picture moved: the camera. A key or the cursor changes a few
 *  pixels and reads far under it; the premises below assert the gap. */
const CAMERA_CHANGE = 2;
/** Most of a 1300 ms push-in reads as the camera moving; its eased ends
 *  can fall under CAMERA_CHANGE. */
const PUSH_IN_MIN_MS = 900;

const PAGE = `<!doctype html><meta charset=utf-8><title>Unhurried</title>
<style>
  body { margin: 0; background: #fff; font: 16px sans-serif; }
  #amount { position: absolute; left: 40px; top: 40px; width: 240px;
    height: 36px; font: 20px monospace; }
  #create { position: absolute; left: 320px; top: 40px; width: 160px;
    height: 40px; background: #1e40af; color: #fff; border: 0; }
  .grid { position: absolute; inset: 120px 300px 120px 300px;
    background: repeating-linear-gradient(90deg, #111 0 20px, #eee 20px 40px); }
</style>
<input id="amount" aria-label="Amount">
<div class="grid"></div>
<button id="create">Create invoice</button>`;

let server: Server;
let url: string;
let home: string;
let executor: LocalExecutor;
let takeId: string;

beforeAll(async () => {
  server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(PAGE);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  home = await mkdtemp(join(tmpdir(), "demoman-unhurried-"));
  executor = createLocalExecutor({
    home,
    headless: true,
    outDir: join(home, "out"),
    log: () => undefined,
  });
  const run = await executor.request("run", {
    video: ownVideo(),
    callId: "unhurried-take",
    script: {
      scriptVersion: 1,
      name: "Unhurried",
      target: url,
      viewport: { width: 1280, height: 800 },
      look: {
        branding: {
          background: { kind: "solid", color: "#00c853" },
          logo: null,
          padding: 0,
        },
      },
      steps: [
        { do: "waitForLoad" },
        { do: "type", into: { stableId: "amount" }, text: "48004800" },
        { do: "click", on: { text: "Create invoice" } },
        { do: "pause", ms: 800 },
      ],
    },
  });
  const id = run.ok
    ? (run.value as { provenance?: { takeId?: unknown } }).provenance?.takeId
    : undefined;
  if (typeof id !== "string") {
    throw new Error(`the take was not made: ${JSON.stringify(run)}`);
  }
  takeId = id;
}, RUN_MS);

afterAll(async () => {
  await executor.close();
  server.close();
  await rm(home, { recursive: true, force: true });
});

describe("a typed field and a far click, filmed unhurried", () => {
  it(
    "shows the value finished and settled before the camera moves, and the camera still before the click",
    async () => {
      const library = createLibrary(home);
      const scene = (await library.getScene(takeId)) as SceneDocument;
      const bundle = (await library
        .frameStore(takeId)
        .getBundle(takeId)) as FrameBundle;
      const typeAction = scene.actions.find((a) => a.kind === "type");
      const clickAction = scene.actions.find((a) => a.kind === "click");
      const marker = (id: string | undefined) =>
        bundle.markers.find((m) => m.actionId === id);
      const typed = marker(typeAction?.id);
      const click = marker(clickAction?.id);
      const facts = () =>
        JSON.stringify({ markers: bundle.markers, camera: scene.camera });
      // Premises: the click is zoomed and the type recorded its act's end.
      expect(
        scene.camera.map((c) => c.marker.actionId),
        facts(),
      ).toContain(clickAction?.id);
      expect(typed?.actEndSourceTimeMs, facts()).toBeDefined();
      const typeAt = typed?.sourceTimeMs as number;
      const typedEnd = typed?.actEndSourceTimeMs as number;
      const clickAt = click?.sourceTimeMs as number;

      const out = await executor.request("export", {
        takeId,
        callId: "unhurried-export",
        // The film the ink thresholds below were measured on. At high
        // (2026-10-23's default) the focus ring alone read 0.3 of the
        // field's peak before the first key, past the 0.2 premise.
        quality: "share",
      });
      if (!out.ok) throw new Error(JSON.stringify(out));
      const answer = out.value as ExportAnswer;
      if (answer.outcome !== "saved" || answer.fileType === "stills") {
        throw new Error(JSON.stringify(answer));
      }
      const bytes = new Uint8Array(await readFile(answer.file.path));
      const read = await mp4FrameTimes(bytes);
      const frames = read.timesSec.map((t, i) => ({
        ms: t * 1000,
        change: read.changes[i] ?? 0,
      }));
      const evidence = () =>
        `${facts()} frames ${JSON.stringify(
          frames
            .filter((f) => f.ms > typeAt - 200 && f.ms < clickAt + 200)
            .map((f) => [Math.round(f.ms), Math.round(f.change * 100) / 100]),
        )}`;

      // A continuous replay's film runs on the take's own clock: the
      // timeline maps source to output one to one, so markers are film times.
      // Premise: the typing shows on film as small changes inside its act.
      const typing = frames.filter(
        (f) => f.ms > typeAt && f.ms <= typedEnd + 50 && f.change > 0,
      );
      expect(typing.length, evidence()).toBeGreaterThan(2);
      expect(Math.max(...typing.map((f) => f.change)), evidence()).toBeLessThan(
        CAMERA_CHANGE,
      );
      // Premise: the camera does move toward the button before the click.
      const moving = frames.filter(
        (f) => f.ms > typeAt && f.ms < clickAt && f.change >= CAMERA_CHANGE,
      );
      expect(moving.length, evidence()).toBeGreaterThan(0);

      // The camera sets off only after the value is in and has settled.
      const frameMs = 1000 / 30;
      expect(
        (moving[0] as { ms: number }).ms,
        evidence(),
      ).toBeGreaterThanOrEqual(typedEnd + SETTLE_MS - frameMs);
      // The same, measured from the picture rather than from the take's own
      // record of the act (final review I2): the first frame where the field
      // holds the whole value. Padding 0 and the Auto canvas make the frame
      // the viewport, so the field's CSS rect is its place in the frame.
      expect(read.width / read.height, evidence()).toBeCloseTo(1280 / 800, 2);
      const movingMs = (moving[0] as { ms: number }).ms;
      const sampled = frames.filter(
        (f) => f.ms >= typeAt - 100 && f.ms < movingMs,
      );
      const crops = await readMp4Crops(
        bytes,
        sampled.map((f) => f.ms / 1000),
        [40 / 1280, 40 / 800, 280 / 1280, 76 / 800],
        { width: 240, height: 36 },
        true,
      );
      // Dark pixels in the field: the glyphs. Not edge energy, which also
      // jumps when the sharp settled still replaces the motion frames, with
      // no more text in the field (a full-suite run, 2026-10-20).
      const ink = crops.map((c) => {
        const grey = Buffer.from(c.grey ?? "", "base64");
        let dark = 0;
        for (const level of grey) if (level < 128) dark++;
        return dark;
      });
      const peak = Math.max(...ink);
      const inkSaid = () =>
        `${evidence()} ink ${JSON.stringify(
          sampled.map((f, i) => [Math.round(f.ms), ink[i] ?? 0]),
        )}`;
      // A glyph's worth of dark pixels, from the film itself (fonts differ
      // between machines): the rises that are not noise or a caret's blink. The
      // focus ring arrives first, larger, and is left out by the median.
      const rises = ink
        .slice(1)
        .map((e, i) => e - (ink[i] ?? e))
        // Over 3% of the field's most: past the encoder's noise and a caret.
        .filter((d) => d > 0.03 * peak)
        .sort((a, b) => a - b);
      const glyph = rises[Math.floor(rises.length / 2)] ?? 0;
      // Premises: the field starts near empty, and the eight keys show as
      // separate rises.
      expect(ink[0] ?? peak, inkSaid()).toBeLessThan(0.2 * peak);
      expect(rises.length, inkSaid()).toBeGreaterThanOrEqual(6);
      // The whole value: within half a glyph of the most the field held (a
      // caret's blink is less than that).
      const full = ink.findIndex((e) => e >= peak - glyph / 2);
      const fullValueMs = (sampled[full] as { ms: number }).ms;
      expect(movingMs, inkSaid()).toBeGreaterThanOrEqual(
        fullValueMs + SETTLE_MS - frameMs,
      );
      // At its own speed: the push-in takes its full length (1300 ms at the
      // default smoothness), not a move squeezed into whatever room was
      // left. Without the replay's wait the render can only start it late
      // and fast (camera.ts' fallback); this is what tells the two apart.
      const lastMove = moving.at(-1) as { ms: number };
      expect(
        lastMove.ms - (moving[0] as { ms: number }).ms,
        evidence(),
      ).toBeGreaterThanOrEqual(PUSH_IN_MIN_MS);
      // And it is settled on the button before the click.
      const beforeClick = frames.filter(
        (f) => f.ms >= clickAt - 300 && f.ms <= clickAt - 2 * frameMs,
      );
      expect(beforeClick.length, evidence()).toBeGreaterThan(3);
      expect(
        Math.max(...beforeClick.map((f) => f.change)),
        evidence(),
      ).toBeLessThan(CAMERA_CHANGE);
    },
    EXPORT_MS,
  );
});

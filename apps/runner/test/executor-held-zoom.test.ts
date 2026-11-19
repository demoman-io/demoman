import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CAMERA_DEFAULTS } from "@demoman/compositor";
import type { SceneDocument } from "@demoman/scene-schema";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLocalExecutor } from "../src/executor/executor.js";
import { createLibrary } from "../src/executor/library.js";
import type { LocalExecutor } from "../src/executor/types.js";
import { ownVideo, WALLPAPERS_DIR } from "./fixture.js";

// A one-click take, as executor-export-zooms.test.ts records one. No export:
// the default 1440p export took over 120 s on an ubuntu runner without a GPU
// (PR #100). That the 1.347 this saves is the export's own grant is the
// run-core test's (`auto-zoom-held-default.test.ts`, pinned to the measured
// grant) and `apps/runner/compare/pacing-pairs.mjs`'s, which exports it.
const RUN_MS = 60_000;

/** One small button, so the zoom's fit is the default and nothing else. */
const APP = `<!doctype html><meta charset=utf-8><title>Held zoom</title>
<style>body{margin:0;background:#fff}
button{position:absolute;left:660px;top:420px;width:120px;height:48px;border:0;background:#1e40af;color:#fff;font:16px sans-serif}</style>
<button>Go</button>`;

let server: Server;
let home: string;
let executor: LocalExecutor;
let report: { zoomDefault?: string } & Record<string, unknown>;
let takeId: string;
const was = {
  held: process.env.DEMOMAN_HELD_CLOCK,
  display: process.env.DEMOMAN_DISPLAY,
};

/**
 * DEM-164: a held take records its stills at the flow's scale, here 2x as
 * the CLI records (`standInDisplay`, `DEMOMAN_DISPLAY`), which back less than
 * the camera's 1.8x at the default export. The take is saved with the zoom
 * its stills back, and says so.
 */
beforeAll(async () => {
  delete process.env.DEMOMAN_HELD_CLOCK;
  process.env.DEMOMAN_DISPLAY = "1440x900@2";
  server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(APP);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  home = await mkdtemp(join(tmpdir(), "demoman-held-zoom-"));
  executor = createLocalExecutor({
    wallpapersDir: WALLPAPERS_DIR,
    home,
    headless: true,
    standInDisplay: true,
    outDir: join(home, "out"),
    log: () => undefined,
  });
  const run = await executor.request("run", {
    video: ownVideo(),
    callId: "make-held-zoom-take",
    script: {
      scriptVersion: 1,
      name: "Held zoom",
      target: url,
      viewport: { width: 1440, height: 900 },
      steps: [
        { do: "waitForLoad" },
        { do: "click", on: { text: "Go" } },
        { do: "pause", ms: 1000 },
      ],
    },
  });
  report = (run.ok ? run.value : {}) as typeof report;
  const id = (report as { provenance?: { takeId?: unknown } }).provenance
    ?.takeId;
  if (typeof id !== "string") {
    throw new Error(`the held take was not made: ${JSON.stringify(run)}`);
  }
  takeId = id;
}, RUN_MS);

afterAll(async () => {
  await executor?.close();
  for (const [key, value] of [
    ["DEMOMAN_HELD_CLOCK", was.held],
    ["DEMOMAN_DISPLAY", was.display],
  ] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  server?.close();
  if (home) await rm(home, { recursive: true, force: true });
});

describe("a held take at 2x", () => {
  it(
    "is saved with the zoom its stills back, and says why",
    async () => {
      const library = createLibrary(home);
      const scene = (await library.getScene(takeId)) as SceneDocument;
      const zoom = scene.camera.find((c) => c.kind === "zoom");
      const evidence = JSON.stringify({
        recording: (report as { run?: { recording?: unknown } }).run?.recording,
        camera: scene.camera,
        zoomDefault: scene.zoomDefault,
        zoomsSkipped: scene.zoomsSkipped,
      });
      // The premises: recorded held, at 2x, with a zoom on the click.
      expect(scene.meta.capture.displayScale, evidence).toBe(2);
      expect(zoom, evidence).toBeDefined();

      expect(scene.zoomDefault, evidence).toEqual({
        scale: expect.closeTo(1.347, 3),
        stillScale: 2,
      });
      expect(zoom?.scale, evidence).toBe(scene.zoomDefault?.scale);
      expect(zoom?.scale, evidence).toBeLessThan(
        CAMERA_DEFAULTS.defaultZoomScale,
      );
      expect(report.zoomDefault, evidence).toBe(
        "Zooms start at 1.35x, not 1.8x: the video's frames are 2x, and the default export cannot zoom further without upscaling them.",
      );
    },
    RUN_MS,
  );
});

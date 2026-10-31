// apps/runner/test/final-still.test.ts
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FrameBundle } from "@demoman/compositor";
import { DEFAULT_EXPORT_QUALITY, frameOf, targetFor } from "@demoman/run-core";
import type { SceneDocument } from "@demoman/scene-schema";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Rgb } from "../src/decode-probe-entry.js";
import {
  renderFinalStill,
  STILL_MAX_WIDTH,
} from "../src/executor/final-still.js";
import { createLibrary } from "../src/executor/library.js";
import { type Launched, launch } from "../src/launch.js";
import { renderToFiles } from "../src/render.js";
import { DISK_TAKE_RED, makeDiskTake } from "./disk-take.js";
import { WALLPAPERS_DIR } from "./fixture.js";
import { sampleImage } from "./mp4-probe.js";

const BLUE: Rgb = [0, 0, 255];
let home: string;
let launched: Launched;
let take: { takeId: string; original: SceneDocument; bundle: FrameBundle };

/** A solid blue 1280x800 JPEG, painted in the page. */
async function blueFrame(): Promise<Uint8Array> {
  const base64 = await launched.page.evaluate(async () => {
    const canvas = new OffscreenCanvas(1280, 800);
    const ctx = canvas.getContext("2d") as OffscreenCanvasRenderingContext2D;
    ctx.fillStyle = "#0000ff";
    ctx.fillRect(0, 0, 1280, 800);
    const blob = await canvas.convertToBlob({
      type: "image/jpeg",
      quality: 0.95,
    });
    let binary = "";
    for (const b of new Uint8Array(await blob.arrayBuffer()))
      binary += String.fromCharCode(b);
    return btoa(binary);
  });
  return new Uint8Array(Buffer.from(base64, "base64"));
}

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), "demoman-final-still-"));
  take = await makeDiskTake(home);
  launched = await launch({ headless: true });
  // The take's FIRST keyframe made blue: its last stays the red text, so a
  // still of the start and a still of the end differ.
  const first = take.bundle.keyframes[0];
  if (first === undefined) throw new Error("the disk take has no keyframes");
  await createLibrary(home)
    .frameStore(take.takeId)
    .putKeyframe(take.takeId, 0, await blueFrame());
}, 60_000);

afterAll(async () => {
  await launched?.close();
  await rm(home, { recursive: true, force: true });
});

const counts = async (bytes: Uint8Array) => {
  const read = await sampleImage(bytes, "image/png", {
    colors: [DISK_TAKE_RED, BLUE],
  });
  const last = read.readings.at(-1);
  if (last === undefined) throw new Error("no readings");
  return {
    width: read.width,
    height: read.height,
    red: last.colorCounts[0] ?? 0,
    blue: last.colorCounts[1] ?? 0,
  };
};

describe("renderFinalStill", () => {
  it("renders the take's last frame, the size export would", async () => {
    const library = createLibrary(home);
    const still = await renderFinalStill({
      library,
      takeId: take.takeId,
      page: launched.page,
      home,
      wallpapersDir: WALLPAPERS_DIR,
    });
    expect(still, JSON.stringify(still)).toHaveProperty("path");
    const path = (still as { path: string }).path;
    expect(path).toBe(join(library.takeDir(take.takeId), "final-still.png"));
    const seen = await counts(await readFile(path));

    // The size: the MP4 export's own frame, no wider than STILL_MAX_WIDTH.
    const exported = targetFor(
      "mp4",
      take.original.canvas.aspect,
      take.bundle,
      frameOf(take.original),
      { quality: DEFAULT_EXPORT_QUALITY },
    );
    const width = Math.min(STILL_MAX_WIDTH, exported.width);
    expect([seen.width, seen.height], JSON.stringify(seen)).toEqual([
      width,
      Math.round((exported.height * width) / exported.width),
    ]);
    // The last frame: the page's red text, and none of the first frame's blue.
    expect(seen.red, JSON.stringify(seen)).toBeGreaterThan(50);
    expect(seen.blue, JSON.stringify(seen)).toBe(0);
  }, 120_000);

  // The premise of the case above: the film's start IS blue, so "no blue"
  // there means the still is the end and not the start.
  it("the fixture's first frame is blue (premise)", async () => {
    const library = createLibrary(home);
    const store = library.frameStore(take.takeId);
    const target = targetFor(
      "stills",
      take.original.canvas.aspect,
      take.bundle,
      frameOf(take.original),
    );
    const rendered = await renderToFiles({
      scene: take.original,
      bundle: take.bundle,
      store,
      page: launched.page,
      target,
      fileType: "stills",
      logo: null,
      wallpaper: null,
      outputTimesMs: [0],
    });
    expect(rendered.files).toHaveLength(1);
    const seen = await counts(rendered.files[0]?.bytes as Uint8Array);
    expect(seen.blue, JSON.stringify(seen)).toBeGreaterThan(1000);
  }, 120_000);

  it("says why when the take has no frames, and throws nothing", async () => {
    const still = await renderFinalStill({
      library: createLibrary(home),
      takeId: "scene-nope",
      page: launched.page,
      home,
      wallpapersDir: WALLPAPERS_DIR,
    });
    expect(still, JSON.stringify(still)).toHaveProperty("unavailable");
  }, 60_000);
});

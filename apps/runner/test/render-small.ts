import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FrameBundle, RenderTarget } from "@demoman/compositor";
import type { SceneDocument } from "@demoman/scene-schema";
import type { Page } from "playwright";
import { readonlyScene } from "../../../packages/compositor/test/fixtures/scene.js";
import { createFileFrameStore, type RunnerStore } from "../src/frame-store.js";
import { launch } from "../src/launch.js";
import { renderToFiles } from "../src/render.js";
import { FIXTURE_HEIGHT, FIXTURE_WIDTH, jpeg } from "./fixtures/jpeg.js";

/**
 * `readonlyScene()`'s own bundle, keyframe-only (no motion span — the
 * keyframe path is the simpler of the two `framesFor` branches and is
 * enough to exercise the render phase end to end; `mux.test.ts` already
 * proves the video-span path decodes for real). Every keyframe's `ref`
 * actually holds bytes in `store`, put there through the store's own
 * `putKeyframe` rather than a hand-rolled ref string, so this fixture never
 * has to know the store's internal naming scheme.
 */
export async function keyframeOnlyBundle(
  store: RunnerStore,
  scene: SceneDocument,
): Promise<FrameBundle> {
  const sceneId = scene.meta.id;
  const times = [0, 400, 3200, 9000];
  const actionIds: (string | null)[] = [null, "act-1", "act-2", "act-3"];
  const refs = await Promise.all(
    times.map((_, i) => store.putKeyframe(sceneId, i, jpeg())),
  );
  return {
    bundleVersion: 1,
    sceneId,
    source: "replay",
    dpr: 1,
    viewport: { width: 1280, height: 800 },
    keyframes: times.map((sourceTimeMs, i) => ({
      sourceTimeMs,
      ref: refs[i] as string,
      width: FIXTURE_WIDTH,
      height: FIXTURE_HEIGHT,
      actionId: actionIds[i] as string | null,
      byteLength: 0,
    })),
    motionSpans: [],
    cursorSamples: [
      { sourceTimeMs: 0, x: 120, y: 640 },
      { sourceTimeMs: 400, x: 200, y: 42 },
      { sourceTimeMs: 3200, x: 640, y: 328 },
      { sourceTimeMs: 9000, x: 1060, y: 642 },
    ],
    cursorGaps: [],
    anchorRects: [
      {
        actionId: "act-1",
        anchorId: "a-search",
        rect: { x: 40, y: 24, width: 320, height: 36 },
      },
      {
        actionId: "act-2",
        anchorId: "a-row",
        rect: { x: 60, y: 300, width: 1160, height: 56 },
      },
      {
        actionId: "act-3",
        anchorId: "a-checkout",
        rect: { x: 980, y: 620, width: 160, height: 44 },
      },
    ],
    markers: [
      { actionId: "act-1", sourceTimeMs: 400 },
      { actionId: "act-2", sourceTimeMs: 3200 },
      { actionId: "act-3", sourceTimeMs: 9000 },
    ],
    degradations: [],
  };
}

/**
 * `keyframeOnlyBundle`'s shape, with its four keyframes replaced by one per
 * output frame of a `ms`-long film at `fps`, alternating between `pictures`.
 * Keyframe i sits half a frame before output frame i, so frame i shows
 * keyframe i whatever rounding the frame times carry: every frame of the film
 * is a different picture from the one before. Its markers and cursor fall
 * inside `ms`, so nothing in the scene asks for time the film does not have.
 */
export async function alternatingBundle(
  store: RunnerStore,
  scene: SceneDocument,
  pictures: [Uint8Array, Uint8Array],
  fps: number,
  ms: number,
): Promise<FrameBundle> {
  const base = await keyframeOnlyBundle(store, scene);
  const step = 1000 / fps;
  const count = Math.round(ms / step);
  const keyframes = await Promise.all(
    Array.from({ length: count }, async (_, i) => ({
      sourceTimeMs: i === 0 ? 0 : (i - 0.5) * step,
      ref: await store.putKeyframe(
        scene.meta.id,
        100 + i,
        new Uint8Array(pictures[i % 2] as Uint8Array),
      ),
      width: FIXTURE_WIDTH,
      height: FIXTURE_HEIGHT,
      actionId: null,
      byteLength: 0,
    })),
  );
  return {
    ...base,
    keyframes,
    markers: [],
    anchorRects: [],
    cursorSamples: base.cursorSamples.map((c, i) => ({
      ...c,
      sourceTimeMs: (ms * i) / base.cursorSamples.length,
    })),
  };
}

/** A small real film of the keyframe-only bundle, at `target`'s size and rate:
 *  the measure lane's fixture. Its own store and headless browser, both gone
 *  before it returns. With `alternating`, the bundle is `alternatingBundle`'s
 *  instead: a film `alternating.ms` long whose picture changes every frame,
 *  between a white and a black JPEG made in the page. */
export async function renderSmallFilm(
  target: RenderTarget,
  alternating?: { ms: number },
): Promise<Buffer> {
  const dir = await mkdtemp(join(tmpdir(), "demoman-small-film-"));
  const launched = await launch({ headless: true });
  try {
    const scene = readonlyScene();
    const store = createFileFrameStore(dir);
    const bundle =
      alternating === undefined
        ? await keyframeOnlyBundle(store, scene)
        : await alternatingBundle(
            store,
            scene,
            [
              await fillJpeg(launched.page, "#ffffff"),
              await fillJpeg(launched.page, "#000000"),
            ],
            target.fps,
            alternating.ms,
          );
    const rendered = await renderToFiles({
      scene,
      bundle,
      store,
      page: launched.page,
      target,
      fileType: "mp4",
      logo: null,
    });
    const file = rendered.files[0];
    if (file === undefined) throw new Error("the render produced no file");
    return file.bytes;
  } finally {
    await launched.close();
    await rm(dir, { recursive: true, force: true });
  }
}

/** A real `FIXTURE_WIDTH`x`FIXTURE_HEIGHT` JPEG of one flat colour, encoded by
 *  the page's own canvas — as `frame.jpg` was made. */
async function fillJpeg(page: Page, color: string): Promise<Uint8Array> {
  const base64 = await page.evaluate(
    async ([fill, w, h]) => {
      const canvas = new OffscreenCanvas(w as number, h as number);
      const ctx = canvas.getContext("2d") as OffscreenCanvasRenderingContext2D;
      ctx.fillStyle = fill as string;
      ctx.fillRect(0, 0, w as number, h as number);
      const blob = await canvas.convertToBlob({
        type: "image/jpeg",
        quality: 0.9,
      });
      const bytes = new Uint8Array(await blob.arrayBuffer());
      let binary = "";
      for (const b of bytes) binary += String.fromCharCode(b);
      return btoa(binary);
    },
    [color, FIXTURE_WIDTH, FIXTURE_HEIGHT] as const,
  );
  return new Uint8Array(Buffer.from(base64, "base64"));
}

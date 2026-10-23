import { createLibrary } from "@demoman/runner/studio";
import type { SceneDocument } from "@demoman/scene-schema";
import type { Page } from "playwright";
import { expect } from "vitest";
import type { ParkedSpan } from "../../../runner/src/encoder.js";
import { type Launched, launch } from "../../../runner/src/launch.js";
import { muxSpans } from "../../../runner/src/mux.js";
import { makeDiskTake } from "../../../runner/test/disk-take.js";

// Takes with real pictures, for the studio's browser lanes: the runner's
// disk take given a motion span muxed from painted frames (`seedTake`, the
// take the editor lane edits and exports), and more takes beside it whose
// keyframes are painted in colours of their own (`seedPlainTakes`), so a
// library of them shows cards that can be told apart.

/** The compositor's bundle, by way of the disk take (this app does not
 *  depend on @demoman/compositor). */
export type FrameBundle = Awaited<ReturnType<typeof makeDiskTake>>["bundle"];

export const VIEWPORT = { width: 1280, height: 800 };
export const SPAN = { startMs: 400, endMs: 3200, frames: 12 };

// ---------------------------------------------------------------- the take

/** Frames of the take's motion span: blue, the same red "northwind" in the
 *  search field as the keyframes, and a white block that moves across. */
export async function paintSpanFrames(page: Page): Promise<Uint8Array[]> {
  const frames = await page.evaluate(
    async ([w, h, count]) => {
      const out: string[] = [];
      for (let i = 0; i < (count as number); i++) {
        const canvas = new OffscreenCanvas(w as number, h as number);
        const ctx = canvas.getContext(
          "2d",
        ) as OffscreenCanvasRenderingContext2D;
        ctx.fillStyle = "#0000ff";
        ctx.fillRect(0, 0, w as number, h as number);
        ctx.fillStyle = "#ff0000";
        ctx.font = "bold 30px sans-serif";
        ctx.textBaseline = "middle";
        ctx.fillText("northwind", 46, 42);
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(100 + i * 80, 400, 120, 120);
        const blob = await canvas.convertToBlob({
          type: "image/jpeg",
          quality: 0.95,
        });
        const bytes = new Uint8Array(await blob.arrayBuffer());
        let binary = "";
        for (const b of bytes) binary += String.fromCharCode(b);
        out.push(btoa(binary));
      }
      return out;
    },
    [VIEWPORT.width, VIEWPORT.height, SPAN.frames] as const,
  );
  return frames.map((b64) => new Uint8Array(Buffer.from(b64, "base64")));
}

/**
 * The runner's disk take (painted keyframes, cursor motion), given a zoom on
 * the search field and one real motion span, muxed by the runner's own mux
 * from painted frames — so the preview has video to decode, as a filmed
 * take does.
 */
export async function seedTake(home: string): Promise<{
  takeId: string;
  scene: SceneDocument;
  bundle: FrameBundle;
}> {
  const disk = await makeDiskTake(home);
  const { takeId } = disk;
  const scene: SceneDocument = {
    ...disk.original,
    camera: [
      {
        id: "cam-search",
        kind: "zoom",
        anchorId: "a-search",
        marker: { actionId: "act-1", offsetMs: -300 },
        scale: 2.2,
      },
    ],
  };
  const library = createLibrary(home);
  const store = library.frameStore(takeId);
  const ref = `span:${takeId}:0`;
  const bundle: FrameBundle = {
    ...disk.bundle,
    // From the search field to the checkout: a 9:16 crop follows the
    // pointer, so starting on the field puts the red text in its first
    // frame (as D1's zoom case rests it there).
    cursorSamples: [
      { sourceTimeMs: 0, x: 200, y: 42 },
      { sourceTimeMs: 9000, x: 1060, y: 642 },
    ],
    motionSpans: [
      {
        startMs: SPAN.startMs,
        endMs: SPAN.endMs,
        ref,
        width: VIEWPORT.width,
        height: VIEWPORT.height,
        fps: (SPAN.frames * 1000) / (SPAN.endMs - SPAN.startMs),
        byteLength: 0,
      },
    ],
  };
  const launched: Launched = await launch({ headless: true });
  try {
    const frames = await paintSpanFrames(launched.page);
    for (const [i, bytes] of frames.entries()) {
      await store.putParked(`${takeId}:replay`, i, bytes);
    }
    const parked: ParkedSpan = {
      index: 0,
      ref,
      startMs: SPAN.startMs,
      endMs: SPAN.endMs,
      firstFrameIndex: 0,
      frames: SPAN.frames,
      // Evenly from the span's start to its end: where the mux put these
      // painted frames before it took each frame's own time.
      frameMs: Array.from(
        { length: SPAN.frames },
        (_, i) =>
          SPAN.startMs + (i * (SPAN.endMs - SPAN.startMs)) / (SPAN.frames - 1),
      ),
      width: VIEWPORT.width,
      height: VIEWPORT.height,
      kept: true,
    };
    const lines: string[] = [];
    const outcome = await muxSpans({
      sceneId: takeId,
      page: launched.page,
      store,
      spans: [parked],
      bundle,
      report: (line) => lines.push(line),
    });
    expect(
      outcome.muxed.map((m) => m.kept),
      `the span muxed: ${JSON.stringify({ outcome, lines })}`,
    ).toEqual([true]);
  } finally {
    await launched.close();
  }
  await store.putBundle(takeId, bundle);
  await library.putScene(scene);
  return { takeId, scene, bundle };
}

// ------------------------------------------------------- more takes

export interface PlainTake {
  id: string;
  name: string;
  /** ISO time; the library groups its cards by this day. */
  createdAt: string;
  /** The keyframes' ground, a CSS colour. */
  ground: string;
  /** Remove these actions' stretches (their ids in `readonlyScene`). */
  cuts?: string[];
}

/** One 1280x800 keyframe: `ground`, the disk take's red "northwind" in the
 *  search field, and a dark bar of rows below it, as JPEG bytes. */
async function paintKeyframe(page: Page, ground: string): Promise<Uint8Array> {
  const b64 = await page.evaluate(
    async ([w, h, fill]) => {
      const canvas = new OffscreenCanvas(w as number, h as number);
      const ctx = canvas.getContext("2d") as OffscreenCanvasRenderingContext2D;
      ctx.fillStyle = fill as string;
      ctx.fillRect(0, 0, w as number, h as number);
      ctx.fillStyle = "#ff0000";
      ctx.font = "bold 30px sans-serif";
      ctx.textBaseline = "middle";
      ctx.fillText("northwind", 46, 42);
      ctx.fillStyle = "#1f2937";
      for (let row = 0; row < 5; row++) {
        ctx.fillRect(60, 160 + row * 90, 1160, 56);
      }
      const blob = await canvas.convertToBlob({
        type: "image/jpeg",
        quality: 0.95,
      });
      const bytes = new Uint8Array(await blob.arrayBuffer());
      let binary = "";
      for (const b of bytes) binary += String.fromCharCode(b);
      return btoa(binary);
    },
    [VIEWPORT.width, VIEWPORT.height, ground] as const,
  );
  return new Uint8Array(Buffer.from(b64, "base64"));
}

/**
 * Takes beside `base` (a `seedTake`): its scene and bundle under each new
 * id, name and day, with keyframes painted on each take's own ground and no
 * motion span, so the library's thumbnails (made from keyframes alone)
 * differ card to card.
 */
export async function seedPlainTakes(
  home: string,
  base: { scene: SceneDocument; bundle: FrameBundle },
  takes: readonly PlainTake[],
): Promise<void> {
  const library = createLibrary(home);
  const launched = await launch({ headless: true });
  try {
    for (const t of takes) {
      const bytes = await paintKeyframe(launched.page, t.ground);
      const store = library.frameStore(t.id);
      const keyframes = await Promise.all(
        base.bundle.keyframes.map(async (k, i) => ({
          ...k,
          ref: await store.putKeyframe(t.id, i, new Uint8Array(bytes)),
          byteLength: bytes.byteLength,
        })),
      );
      await store.putBundle(t.id, {
        ...base.bundle,
        sceneId: t.id,
        keyframes,
        motionSpans: [],
      });
      await library.putScene({
        ...base.scene,
        meta: {
          ...base.scene.meta,
          id: t.id,
          name: t.name,
          createdAt: t.createdAt,
        },
        edits: {
          ...base.scene.edits,
          // Each cut step's stretch, to the next step's frame, the way a
          // schema 12 migration converts a step cut.
          removed: (t.cuts ?? []).map((actionId, i) => {
            const ids = base.scene.actions.map((a) => a.id);
            const next = ids[ids.indexOf(actionId) + 1];
            return {
              id: `cut-${i + 1}`,
              start: { actionId, sourceOffsetMs: 0 },
              end:
                next === undefined
                  ? null
                  : { actionId: next, sourceOffsetMs: 0 },
            };
          }),
        },
      });
    }
  } finally {
    await launched.close();
  }
}

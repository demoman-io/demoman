import { type FrameBundle, madeFromOf } from "@demoman/compositor";
import type { SceneDocument } from "@demoman/scene-schema";
import { readonlyScene } from "../../../packages/compositor/test/fixtures/scene.js";
import type { Rgb } from "../src/decode-probe-entry.js";
import { createLibrary } from "../src/executor/library.js";
import { launch } from "../src/launch.js";

// A take built on disk rather than run, shared by the export tests that read
// the picture (the retext test, the GIF and stills tests).
//
// Frames painted in a page show the typed text "northwind" in pure red
// inside the search field (the rect `readonlyScene` and its bundle both
// record for `a-search`), so the original is a colour the picture can count,
// and an overlay drawn over it — the field's edge colour, then `#111827`
// ink — is another.

export const DISK_TAKE_RED: Rgb = [255, 0, 0];
export const DISK_TAKE_INK: Rgb = [17, 24, 39];
const VIEWPORT = { width: 1280, height: 800 };
const SEARCH = { x: 40, y: 24, width: 320, height: 36 };

/** A 1280x800 frame of the app: white, with the field's typed text in red. */
async function paintedFrame(): Promise<Uint8Array> {
  const launched = await launch({ headless: true });
  try {
    const base64 = await launched.page.evaluate(
      async ([w, h, rect, text]) => {
        const { x, y, height } = rect as typeof SEARCH;
        const canvas = new OffscreenCanvas(w as number, h as number);
        const ctx = canvas.getContext(
          "2d",
        ) as OffscreenCanvasRenderingContext2D;
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(0, 0, w as number, h as number);
        ctx.fillStyle = "#ff0000";
        ctx.font = "bold 30px sans-serif";
        ctx.textBaseline = "middle";
        ctx.fillText(text as string, x + 6, y + height / 2);
        const blob = await canvas.convertToBlob({
          type: "image/jpeg",
          quality: 0.95,
        });
        const bytes = new Uint8Array(await blob.arrayBuffer());
        let binary = "";
        for (const b of bytes) binary += String.fromCharCode(b);
        return btoa(binary);
      },
      [VIEWPORT.width, VIEWPORT.height, SEARCH, "northwind"] as const,
    );
    return new Uint8Array(Buffer.from(base64, "base64"));
  } finally {
    await launched.close();
  }
}

/** Builds the take in `home`'s library: its frames, bundle and scene. */
export async function makeDiskTake(home: string): Promise<{
  takeId: string;
  original: SceneDocument;
  bundle: FrameBundle;
}> {
  const original = readonlyScene();
  const takeId = original.meta.id;
  const library = createLibrary(home);
  const store = library.frameStore(takeId);
  const frame = await paintedFrame();
  const times = [0, 400, 3200, 9000];
  const actionIds = [null, "act-1", "act-2", "act-3"];
  const keyframes = await Promise.all(
    times.map(async (sourceTimeMs, i) => ({
      sourceTimeMs,
      ref: await store.putKeyframe(takeId, i, new Uint8Array(frame)),
      width: VIEWPORT.width,
      height: VIEWPORT.height,
      actionId: actionIds[i] as string | null,
      byteLength: frame.byteLength,
    })),
  );
  const bundle: FrameBundle = {
    bundleVersion: 1,
    sceneId: takeId,
    source: "replay",
    dpr: 1,
    viewport: VIEWPORT,
    keyframes,
    motionSpans: [],
    cursorSamples: [
      { sourceTimeMs: 0, x: 900, y: 600 },
      { sourceTimeMs: 9000, x: 1060, y: 642 },
    ],
    cursorGaps: [],
    anchorRects: [
      { actionId: "act-1", anchorId: "a-search", rect: SEARCH },
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
    // What the frames typed: "northwind", as every CLI take records it.
    madeFrom: madeFromOf(original),
  };
  await store.putBundle(takeId, bundle);
  await library.putScene(original);
  return { takeId, original, bundle };
}

/** The take's scene with act-1's typed text edited, as the studio would
 *  leave it. */
export function editedScene(
  original: SceneDocument,
  text: string,
): SceneDocument {
  return {
    ...original,
    actions: original.actions.map((a) =>
      a.id === "act-1" && a.kind === "type" ? { ...a, text } : a,
    ),
  };
}

/** Every case puts the scene AND the bundle it reads, so no case depends on
 *  what an earlier one left in the shared library. */
export async function putTake(
  home: string,
  takeId: string,
  scene: SceneDocument,
  frames: FrameBundle,
): Promise<void> {
  const library = createLibrary(home);
  await library.frameStore(takeId).putBundle(takeId, frames);
  await library.putScene(scene);
}

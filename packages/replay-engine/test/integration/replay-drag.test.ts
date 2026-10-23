import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { madeFromOf } from "@demoman/compositor";
import type { SceneDocument } from "@demoman/scene-schema";
import { describe, expect, it } from "vitest";
import { runReplay } from "../../src/index.js";
import {
  selectorPageAgent,
  withReplayBrowser,
} from "../helpers/cdp-playwright";
import { createNodeFrameEncoder } from "../helpers/frame-encoder-node";
import { createMemoryFrameStore } from "../helpers/frame-store";
import { scene } from "../helpers/replay-scene";

/**
 * A take with a drag, rebuilt from its document (final review, finding 4):
 * the document source handed the walk a drag with no ends, and the run died
 * as a port failure. The drag is the runner's own fixture canvas.
 */
const DRAG_URL = pathToFileURL(
  join(
    import.meta.dirname,
    "..",
    "..",
    "..",
    "..",
    "apps",
    "runner",
    "test",
    "fixtures",
    "drag-app.html",
  ),
).href;
const SELECTORS = { pad: "#pad" };

function dragScene(): SceneDocument {
  const base = scene({ anchorIds: Object.keys(SELECTORS) });
  return {
    ...base,
    meta: {
      ...base.meta,
      capture: { ...base.meta.capture, originUrl: DRAG_URL },
    },
    actions: [
      {
        id: "act-1",
        kind: "drag",
        anchorId: "pad",
        timestamp: 0,
        marker: "drag:pad",
        toAnchorId: "pad",
        fromAt: { x: 0.1, y: 0.5 },
        to: { at: { x: 0.9, y: 0.5 } },
      },
    ],
  } as SceneDocument;
}

const midPixel = (page: Parameters<typeof selectorPageAgent>[0]) =>
  page.evaluate(() => {
    const pad = document.querySelector("#pad") as HTMLCanvasElement;
    const g = pad.getContext("2d") as CanvasRenderingContext2D;
    return Array.from(g.getImageData(200, 120, 1, 1).data.slice(0, 3));
  });

describe("a drag rebuilt from its take", () => {
  it("draws the same line, from the spots the take kept", async () => {
    await withReplayBrowser(
      async ({ cdp, page }) => {
        // The premise: the canvas starts white where the line will go.
        expect(await midPixel(page)).toEqual([255, 255, 255]);
        const doc = dragScene();
        const store = createMemoryFrameStore();
        const result = await runReplay(doc, {
          cdp,
          page: selectorPageAgent(page, SELECTORS),
          encoder: createNodeFrameEncoder(store, doc.meta.id),
          store,
          clock: {
            now: () => Date.now(),
            sleep: (ms: number) => new Promise<void>((r) => setTimeout(r, ms)),
          },
          mayReplay: true,
          madeFrom: madeFromOf(doc),
        });
        expect(result.reason, JSON.stringify(result.reason)).toBeNull();
        expect(result.completed).toBe(1);
        expect(Math.max(...(await midPixel(page)))).toBeLessThan(80);
      },
      { url: DRAG_URL, readySelector: "#pad" },
    );
  }, 60_000);
});

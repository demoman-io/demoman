import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { frameOf, targetFor } from "@demoman/run-core";
import type { Page } from "playwright";
import { describe, expect, it, onTestFinished } from "vitest";
import { readonlyScene } from "../../../packages/compositor/test/fixtures/scene.js";
import { createFileFrameStore } from "../src/frame-store.js";
import { launch } from "../src/launch.js";
import { listenOnLoopback } from "../src/loopback.js";
import { renderToFiles } from "../src/render.js";
import { readMp4Crops } from "./mp4-probe.js";
import { fillJpeg, keyframeOnlyBundle } from "./render-small.js";

const WIDTH = 1280;
/** The `faintly` look's levels (`same-picture.ts`): the least change the
 *  refresh counts as a change, so a different instant or framing is more. */
const FAINTLY = 13;
// Measured locally 2026-11-03: mp4 6 s, gif 1.5 s (browser launches included);
// x5 for CI (fff4505) with margin.
const TIMEOUT_MS = 150_000;

const tempDir = (prefix: string) => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  onTestFinished(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  return dir;
};

async function blankPage(): Promise<Page> {
  const launched = await launch();
  onTestFinished(async () => {
    await launched.close();
  });
  return launched.page;
}

/** A loopback page, which is a secure context: ImageDecoder needs one. */
async function decodePage(): Promise<Page> {
  const server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end("<!doctype html><meta charset=utf-8><title>decode</title>");
  });
  const origin = await listenOnLoopback(server);
  onTestFinished(() => new Promise<void>((r) => server.close(() => r())));
  const page = await blankPage();
  await page.goto(origin);
  return page;
}

/** Each image at `atSec` (a GIF's frame by time; a PNG's only frame), drawn
 *  `WIDTH` wide as grey levels, base64. */
async function greys(
  page: Page,
  items: { bytes: Buffer; type: string; atSec: number }[],
): Promise<Buffer[]> {
  const out = await page.evaluate(
    async ([list, width]) => {
      const toGrey = (canvas: OffscreenCanvas) => {
        const ctx = canvas.getContext(
          "2d",
        ) as OffscreenCanvasRenderingContext2D;
        const px = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
        const grey = new Uint8Array(canvas.width * canvas.height);
        for (let i = 0; i < grey.length; i++) {
          grey[i] = Math.round(
            0.299 * (px[i * 4] as number) +
              0.587 * (px[i * 4 + 1] as number) +
              0.114 * (px[i * 4 + 2] as number),
          );
        }
        return grey;
      };
      const result: string[] = [];
      for (const item of list as {
        base64: string;
        type: string;
        atSec: number;
      }[]) {
        const data = Uint8Array.from(atob(item.base64), (c) => c.charCodeAt(0));
        const decoder = new ImageDecoder({ data, type: item.type });
        await decoder.tracks.ready;
        const count = decoder.tracks.selectedTrack?.frameCount ?? 0;
        let end = 0;
        let index = count - 1;
        for (let i = 0; i < count; i++) {
          const { image } = await decoder.decode({ frameIndex: i });
          end += (image.duration ?? 0) / 1e6;
          image.close();
          if (item.atSec < end) {
            index = i;
            break;
          }
        }
        const { image } = await decoder.decode({
          frameIndex: count === 1 ? 0 : index,
        });
        const height = Math.round(
          (image.displayHeight * width) / image.displayWidth,
        );
        const canvas = new OffscreenCanvas(width as number, height);
        const ctx = canvas.getContext(
          "2d",
        ) as OffscreenCanvasRenderingContext2D;
        ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
        image.close();
        let binary = "";
        for (const b of toGrey(canvas)) binary += String.fromCharCode(b);
        result.push(btoa(binary));
      }
      return result;
    },
    [
      items.map((i) => ({
        base64: i.bytes.toString("base64"),
        type: i.type,
        atSec: i.atSec,
      })),
      WIDTH,
    ] as const,
  );
  return out.map((b) => Buffer.from(b, "base64"));
}

const meanAbs = (a: Buffer, b: Buffer): number => {
  expect(a.length, "the two pictures are the same size").toBe(b.length);
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    sum += Math.abs((a[i] as number) - (b[i] as number));
  }
  return sum / a.length;
};

describe("renderToFiles with screensOnly", () => {
  for (const fileType of ["mp4", "gif"] as const) {
    it(
      `${fileType}: each screen is a ${WIDTH}-wide picture of the instant the full render shows`,
      async () => {
        const scene = readonlyScene();
        const store = createFileFrameStore(tempDir("demoman-screens-"));
        // The pointer holds still, as in executor-export-screens.test.ts: a
        // film that is never still has no screens.
        const still = { sourceTimeMs: 0, x: 900, y: 600 };
        const plain = await keyframeOnlyBundle(store, scene);
        // The later keyframes are a different picture, so a screen drawn
        // from the wrong instant is a different picture too.
        const dark = await store.putKeyframe(
          scene.meta.id,
          50,
          await fillJpeg(await blankPage(), "#101828"),
        );
        const bundle = {
          ...plain,
          keyframes: plain.keyframes.map((k, i) =>
            i >= 2 ? { ...k, ref: dark } : k,
          ),
          cursorSamples: [still, { ...still, sourceTimeMs: 9000 }],
        };
        const target = targetFor(fileType, "16:9", bundle, frameOf(scene));
        const page = await blankPage();
        const only = await renderToFiles({
          wallpaper: null,
          scene,
          bundle,
          store,
          page,
          target,
          fileType,
          logo: null,
          screensOnly: { width: WIDTH },
        });
        const full = await renderToFiles({
          wallpaper: null,
          scene,
          bundle,
          store,
          page: await blankPage(),
          target,
          fileType,
          logo: null,
        });
        // Premise: the target is not already 1280 wide, so the scaler has
        // real work to do (the mp4 target is wider, the gif's narrower).
        if (fileType === "mp4")
          expect(target.width, "the mp4 target's width").toBeGreaterThan(WIDTH);
        else
          expect(target.width, "the gif target's width").toBeLessThan(WIDTH);
        // The PNGs' own width, from the IHDR header: not redrawn first.
        for (const f of only.files) {
          expect(
            f.bytes.subarray(1, 4).toString("latin1"),
            String(f.name),
          ).toBe("PNG");
          expect(
            f.bytes.readUInt32BE(16),
            `${f.name}'s own width (target ${target.width})`,
          ).toBe(WIDTH);
        }
        // Premise: the fixture has screens, more than one, so a loop over
        // them that ran zero times could not pass.
        const moments = only.screens?.moments ?? [];
        expect(moments.length).toBeGreaterThan(1);
        expect(only.files.length).toBe(moments.length);
        expect(only.screens).toEqual(full.screens);
        expect(only.rendered).toEqual(full.rendered);
        expect(only.files.map((f) => f.name)).toEqual(
          moments.map((m) =>
            m.step === null ? "final.png" : `step-${m.step}.png`,
          ),
        );
        const file = full.files[0];
        if (file === undefined) throw new Error("the full render has no file");
        const pngs = await greys(
          await decodePage(),
          only.files.map((f) => ({
            bytes: f.bytes,
            type: "image/png",
            atSec: 0,
          })),
        );
        // Premise: the pictures are not blank, or any two would match.
        for (const grey of pngs) {
          const mean = grey.reduce((s, v) => s + v, 0) / grey.length;
          const spread =
            grey.reduce((s, v) => s + Math.abs(v - mean), 0) / grey.length;
          expect(
            spread,
            "the screen has something drawn on it",
          ).toBeGreaterThan(1);
        }
        // Premise: the screens are not all one picture, so the comparison
        // below can tell one instant from another.
        expect(
          Math.max(...pngs.map((p) => meanAbs(p, pngs[0] as Buffer))),
          "the screens differ from the first by",
        ).toBeGreaterThan(FAINTLY);
        let film: Buffer[];
        if (fileType === "mp4") {
          const crops = await readMp4Crops(
            file.bytes,
            moments.map((m) => m.ms / 1000),
            [0, 0, 1, 1],
            { width: WIDTH, height: pngs[0] ? pngs[0].length / WIDTH : 0 },
            true,
          );
          film = crops.map((c) => Buffer.from(c.grey as string, "base64"));
        } else {
          film = await greys(
            await decodePage(),
            moments.map((m) => ({
              bytes: file.bytes,
              type: "image/gif",
              atSec: m.ms / 1000,
            })),
          );
        }
        for (const [i, png] of pngs.entries()) {
          const diff = meanAbs(png, film[i] as Buffer);
          expect(
            diff,
            `screen ${i} (${only.files[i]?.name} at ${moments[i]?.ms}ms) differs from the ${fileType}'s frame there by ${diff.toFixed(2)} levels`,
          ).toBeLessThan(FAINTLY);
        }
      },
      TIMEOUT_MS,
    );
  }
});

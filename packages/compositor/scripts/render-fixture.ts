import {
  createReadStream,
  existsSync,
  mkdirSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { extname, join } from "node:path";
import { build } from "esbuild";
import { chromium } from "playwright";
import type { DetailViolation } from "../src/render/detail";

const FIXTURES = join(import.meta.dirname, "..", ".fixtures");
const OUT = join(FIXTURES, "out");
const TYPES: Record<string, string> = {
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
};
/** Bytes pulled back per CDP round trip. Base64 inflates this by 4/3. */
const CHUNK_BYTES = 4_000_000;

interface RenderManifest {
  files: { name: string; byteLength: number }[];
  detailViolations: Record<string, DetailViolation[]>;
}

async function main(): Promise<void> {
  if (!existsSync(join(FIXTURES, "bundle.json"))) {
    throw new Error(
      "no harvested bundle — run `pnpm --filter @demoman/compositor harvest` first",
    );
  }
  mkdirSync(OUT, { recursive: true });

  const bundled = await build({
    entryPoints: [join(import.meta.dirname, "render-entry.ts")],
    bundle: true,
    format: "iife",
    write: false,
    target: "chrome120",
  });
  const script = bundled.outputFiles[0]?.text ?? "";

  // Serve the harvested frames so the page can fetch them; file:// cannot.
  // "/" is a blank page on the same origin, so every fetch below is same-origin.
  const server = createServer((req, res) => {
    const url = decodeURIComponent(req.url ?? "/");
    if (url === "/") {
      res.writeHead(200, { "content-type": "text/html" });
      res.end("<!doctype html><meta charset=utf-8><title>render</title>");
      return;
    }
    const path = join(FIXTURES, url.slice(1));
    if (!path.startsWith(FIXTURES) || !existsSync(path)) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, {
      "content-type": TYPES[extname(path)] ?? "application/octet-stream",
    });
    createReadStream(path).pipe(res);
  });
  // Loopback, explicitly: `listen(0, resolve)` with no host binds every
  // interface, and this server answers any path under FIXTURES with no
  // authentication at all. `127.0.0.1` rather than `localhost` on both
  // sides — `localhost` can resolve to `::1`, which a v4-only bind does
  // not answer.
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;

  // The renderer needs OffscreenCanvas and WebCodecs, which Node has not —
  // so this drives a real browser, exactly as the extension's offscreen
  // document will. Nothing here is a capture of a preview surface: the page
  // encodes frames it composed offline, on a fixed timeline.
  const browser = await chromium.launch();
  const page = await browser.newPage();
  page.on("console", (message) => console.log(`[page] ${message.text()}`));
  page.on("pageerror", (error) =>
    console.error(`[page error] ${error.message}`),
  );
  await page.goto(`http://127.0.0.1:${port}/`);
  await page.addScriptTag({ content: script });

  const started = Date.now();
  const manifest: RenderManifest = await page.evaluate(() =>
    (
      globalThis as unknown as { renderAll: () => Promise<RenderManifest> }
    ).renderAll(),
  );
  console.log(`rendered in ${((Date.now() - started) / 1000).toFixed(1)}s`);

  for (const file of manifest.files) {
    const parts: Buffer[] = [];
    for (let offset = 0; offset < file.byteLength; offset += CHUNK_BYTES) {
      const base64 = await page.evaluate(
        ([name, from, length]) =>
          (
            globalThis as unknown as {
              readChunk: (n: string, o: number, l: number) => string;
            }
          ).readChunk(name as string, from as number, length as number),
        [file.name, offset, CHUNK_BYTES] as const,
      );
      parts.push(Buffer.from(base64, "base64"));
    }
    const bytes = Buffer.concat(parts);
    writeFileSync(join(OUT, file.name), bytes);
    console.log(
      `${file.name}  ${(bytes.byteLength / 1_000_000).toFixed(2)} MB`,
    );
  }

  // A silent clamp is the thing detail.ts exists to prevent. If the camera
  // asked for zoom the source frames could not back, say so here — a soft
  // deliverable that nobody was warned about is the failure mode.
  //
  // Two faults, named apart. Since 2026-09-21 `clampToSourceDetail` also
  // reports an UPSCALE with no cut at all — requested and granted both on
  // the 1.0 floor — and printed as a clamp that read "requested 1.00x,
  // granted 1.00x", a cut that never happened, without the one number that
  // says what did: the width the output wanted.
  let cut = 0;
  let upscaled = 0;
  for (const [name, violations] of Object.entries(manifest.detailViolations)) {
    for (const violation of violations) {
      const at = `${name}  t=${violation.outputTimeMs.toFixed(0)}ms`;
      const widths =
        `source ${violation.sourceWidth}px, ` +
        `needed ${Math.round(violation.neededWidth)}px`;
      if (violation.grantedScale < violation.requestedScale) {
        cut++;
        console.warn(
          `zoom cut  ${at}  requested ${violation.requestedScale.toFixed(3)}x, ` +
            `granted ${violation.grantedScale.toFixed(3)}x (${widths})`,
        );
      } else {
        upscaled++;
        console.warn(
          `upscaled  ${at}  ${(violation.neededWidth / violation.sourceWidth).toFixed(2)}x ` +
            `at zoom ${violation.grantedScale.toFixed(3)}x (${widths})`,
        );
      }
    }
  }
  console.log(
    cut + upscaled === 0
      ? "no detail violations"
      : `${cut} zoom cut(s), ${upscaled} upscaled key(s)`,
  );

  await browser.close();
  server.close();
  console.log(`-> ${OUT}`);
}

await main();

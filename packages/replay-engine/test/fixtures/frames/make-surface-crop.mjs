// Makes the surface-crop fixtures, with Chrome's own JPEG encoder:
//   node packages/replay-engine/test/fixtures/frames/make-surface-crop.mjs
// The page is unhurried-beats' (a field, a button, a striped block), at a
// 1280x800 viewport, as a screencast frame on a 1x display shows it.
// - crop-good.jpg: the page, typed "4800480".
// - crop-surface.jpg: the window's unscaled surface at DPR 3: the page's
//   top-left third magnified 3x, at the same 1280x800 (what CI filmed).
// - crop-typed.jpg: the page with the last key in, "48004800".
// - crop-scrolled.jpg: the page scrolled down 120 px.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright";

const VIEW = { width: 1280, height: 800 };
const page = (value, scroll) => `<!doctype html><meta charset=utf-8>
<style>
  body { margin: 0; background: #fff; font: 16px sans-serif; height: 2000px; }
  #amount { position: absolute; left: 40px; top: 40px; width: 240px;
    height: 36px; font: 20px monospace; }
  #create { position: absolute; left: 320px; top: 40px; width: 160px;
    height: 40px; background: #1e40af; color: #fff; border: 0; }
  .grid { position: absolute; left: 300px; top: 120px; width: 680px; height: 560px;
    background: repeating-linear-gradient(90deg, #111 0 20px, #eee 20px 40px); }
</style>
<input id="amount" aria-label="Amount" value="${value}">
<div class="grid"></div>
<button id="create">Create invoice</button>
<script>scrollTo(0, ${scroll});</script>`;

const browser = await chromium.launch({ channel: "chromium", headless: true });
const p = await browser.newPage({ viewport: null });
const cdp = await p.context().newCDPSession(p);
const shoot = async (html, dpr, clip) => {
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    ...VIEW,
    deviceScaleFactor: dpr,
    mobile: false,
  });
  await p.setContent(html);
  const { data } = await cdp.send("Page.captureScreenshot", {
    format: "jpeg",
    quality: 80,
    ...(clip ? { clip } : {}),
  });
  return Buffer.from(data, "base64");
};
const out = (name, bytes) =>
  writeFileSync(join(import.meta.dirname, name), bytes);

out("crop-good.jpg", await shoot(page("4800480", 0), 1));
out("crop-typed.jpg", await shoot(page("48004800", 0), 1));
out("crop-scrolled.jpg", await shoot(page("4800480", 120), 1));
// The top-left third at 3x, as the window's surface shows it: the page
// drawn at DPR 3 (3840x2400), and exactly 1280x800 device pixels of its
// corner, re-encoded by Chrome's own JPEG encoder. A clip of the fractional
// third came back 1278x798 however it was asked.
const full = await shoot(page("4800480", 0), 3);
const blank = await browser.newPage();
const corner = await blank.evaluate(
  async ({ b64, width, height }) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const img = await createImageBitmap(
      new Blob([bytes], { type: "image/jpeg" }),
    );
    const c = document.createElement("canvas");
    c.width = width;
    c.height = height;
    c.getContext("2d").drawImage(img, 0, 0);
    return c.toDataURL("image/jpeg", 0.8).split(",")[1];
  },
  { b64: full.toString("base64"), ...VIEW },
);
out("crop-surface.jpg", Buffer.from(corner, "base64"));
await browser.close();

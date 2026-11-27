// Capture probe (2026-11-24): after a page capture, does Chrome's
// screencast send frames of the page's top-left corner at the emulated DPR
// (3), magnified, at the SAME size as a good frame on a 1x display?
//   node apps/runner/compare/probe-capture-stray-crop.mjs [rounds=20] [scale=1]
// A run films a 1280x800 viewport emulated at DPR 3 (`desktopMetrics`), its
// screencast on a headless display at `scale` (`displayArgs`): CI's ubuntu
// is 1, a Mac 2. Each round takes the walk's page capture
// (`Page.captureScreenshot`, clip at scale 1/dpr) and classifies every
// screencast frame for 600 ms after it returns: "good" (the page), "crop"
// (its top-left third, magnified 3x), or "other". A red bar at CSS x
// 400-440 tells them apart: a good frame has it at 400-440 of 1280 CSS
// columns, a 3x crop at 1200-1320.
// The last lines answer: "crop frames: N in M rounds, at the good size: K"
// and the latest one after its capture returned, in ms.
import { createServer } from "node:http";
import { chromium } from "playwright";

const ROUNDS = Number(process.argv[2] ?? 20);
const SCALE = Number(process.argv[3] ?? 1);
// "clip": the walk's held-capture shot (walk.ts, clip at scale 1/dpr);
// "full": its real-time still (`Page.captureScreenshot` with no clip).
const MODE = process.argv[4] ?? "full";
// A main thread blocked this long from the next frame, as unhurried-beats'
// page does after its last key (0: none).
const BUSY_MS = Number(process.argv[5] ?? 0);
const VIEW = { width: 1280, height: 800 };
const DPR = 3;
const AFTER_MS = 600;

const server = createServer((_req, res) => {
  res.writeHead(200, { "content-type": "text/html" });
  // The bar, and a spinner far from it so the screencast keeps sending.
  res.end(`<!doctype html><style>
    html,body{margin:0;background:#fff;height:100%}
    #bar{position:fixed;left:400px;top:0;width:40px;height:100%;background:#f00}
    #spin{position:fixed;right:40px;bottom:40px;width:40px;height:40px;background:#00f;animation:s 1s linear infinite}
    @keyframes s{to{transform:rotate(360deg)}}
  </style><div id=bar></div><div id=spin></div>`);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));

const w = Math.round(VIEW.width * SCALE);
const h = Math.round(VIEW.height * SCALE);
// Playwright's full Chromium in new headless, as the runner launches it.
const browser = await chromium.launch({
  channel: "chromium",
  headless: true,
  args: [
    `--screen-info={${w}x${h} devicePixelRatio=${SCALE}}`,
    `--window-size=${VIEW.width},${VIEW.height}`,
  ],
});
const context = await browser.newContext({ viewport: null });
const page = await context.newPage();
const cdp = await context.newCDPSession(page);
await cdp.send("Emulation.setDeviceMetricsOverride", {
  ...VIEW,
  deviceScaleFactor: DPR,
  mobile: false,
});
await page.goto(`http://127.0.0.1:${server.address().port}/`);

// A frame's size, and which it is, decoded in a page of its own.
const decoder = await context.newPage();
const read = (b64) =>
  decoder.evaluate(
    async ({ b64, viewWidth }) => {
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const img = await createImageBitmap(
        new Blob([bytes], { type: "image/jpeg" }),
      );
      const c = new OffscreenCanvas(img.width, img.height);
      const g = c.getContext("2d");
      g.drawImage(img, 0, 0);
      const red = (cssX) => {
        const x = Math.round((cssX / viewWidth) * img.width);
        const [r, gg, b] = g.getImageData(
          x,
          Math.round(img.height / 3),
          1,
          1,
        ).data;
        return r > 200 && gg < 80 && b < 80;
      };
      // Good: red at CSS 420, not at 1260. A 3x corner: red at 1260, not 420.
      const kind =
        red(420) && !red(1260)
          ? "good"
          : !red(420) && red(1260)
            ? "crop"
            : "other";
      return { width: img.width, height: img.height, kind };
    },
    { b64, viewWidth: VIEW.width },
  );

const frames = [];
cdp.on("Page.screencastFrame", (p) => {
  frames.push({ at: performance.now(), data: p.data });
  cdp
    .send("Page.screencastFrameAck", { sessionId: p.sessionId })
    .catch(() => {});
});
await cdp.send("Page.startScreencast", {
  format: "jpeg",
  quality: 80,
  everyNthFrame: 1,
});
await new Promise((r) => setTimeout(r, 500));

let crops = 0;
let cropRounds = 0;
let cropGoodSize = 0;
let latest = -1;
let goodSize = null;
for (let round = 0; round < ROUNDS; round++) {
  frames.length = 0;
  await new Promise((r) => setTimeout(r, 200));
  const before = await Promise.all(frames.map((f) => read(f.data)));
  goodSize ??= before.find((f) => f.kind === "good");
  frames.length = 0;
  const askedAt = performance.now();
  const dpr = await page.evaluate(() => devicePixelRatio);
  if (BUSY_MS > 0) {
    // unhurried-beats' page: the next frame blocks the main thread.
    await page.evaluate((ms) => {
      requestAnimationFrame(() => {
        const t = performance.now();
        while (performance.now() - t < ms) {}
      });
    }, BUSY_MS);
  }
  if (MODE === "metrics") {
    // The walk's re-assertion (`applyMetrics`), sent on a mismatch.
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      ...VIEW,
      deviceScaleFactor: DPR,
      mobile: false,
    });
  } else if (MODE === "resize") {
    // The window's surface changing under the override, and back.
    const { windowId } = await cdp.send("Browser.getWindowForTarget", {});
    await cdp.send("Browser.setWindowBounds", {
      windowId,
      bounds: { width: VIEW.width + 1, height: VIEW.height },
    });
    await cdp.send("Browser.setWindowBounds", {
      windowId,
      bounds: { width: VIEW.width, height: VIEW.height },
    });
  } else {
    await cdp.send(
      "Page.captureScreenshot",
      MODE === "full"
        ? { format: "jpeg", quality: 90 }
        : { format: "png", clip: { x: 0, y: 0, ...VIEW, scale: 1 / dpr } },
    );
  }
  const returnedAt = performance.now();
  await new Promise((r) => setTimeout(r, AFTER_MS));
  const after = await Promise.all(
    frames.map(async (f) => ({
      ...(await read(f.data)),
      ms: f.at - returnedAt,
    })),
  );
  const bad = after.filter((f) => f.kind === "crop");
  if (bad.length > 0) cropRounds++;
  crops += bad.length;
  for (const f of bad) {
    latest = Math.max(latest, f.ms);
    if (goodSize && f.width === goodSize.width && f.height === goodSize.height)
      cropGoodSize++;
  }
  console.log(
    `round ${round + 1}: capture ${(returnedAt - askedAt).toFixed(0)} ms; after it: ` +
      after
        .map((f) => `${f.kind}@${f.ms.toFixed(0)}(${f.width}x${f.height})`)
        .join(" "),
  );
}
console.log(
  `good frames: ${goodSize ? `${goodSize.width}x${goodSize.height}` : "none seen"} (display scale ${SCALE})`,
);
console.log(
  `crop frames: ${crops} in ${cropRounds} of ${ROUNDS} rounds, at the good size: ${cropGoodSize}`,
);
console.log(
  `latest crop after its capture returned: ${latest < 0 ? "none" : `${latest.toFixed(0)} ms`}`,
);
await browser.close();
server.close();

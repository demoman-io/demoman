// Held-clock probe (2026-11-17, DEM-204): why a video stops on a held clock
// once its download is not server time. A muted autoplaying 10 s video,
// served at about 80 KB/s (as compare/held-push.sh video), on a held page
// played a frame at a time with a capture each and no real-time pacing, as
// the clock does in designed time. Prints the video's state every 10 frames.
// Measured 2026-11-17: it plays, so the recorder is what stops it (DEM-207).
//   node apps/runner/compare/held-probe-video.mjs   (needs ffmpeg)
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";

const PIN = Date.parse("2026-01-01T00:00:00Z");
const FRAME = 1000 / 30;
const FRAMES = 180;
/** A call to the browser sometimes never answers while the video loads (3
 *  of 6 runs on 2026-11-17, not traced: DEM-207), so the run is bounded. */
const RUN_MS = 60_000;
setTimeout(() => {
  console.log(
    `stopped: no end within ${RUN_MS / 1000} s (a browser call hung)`,
  );
  process.exit(1);
}, RUN_MS).unref();
const file = join(mkdtempSync(join(tmpdir(), "held-video-")), "clip.webm");
execFileSync("ffmpeg", [
  ...["-loglevel", "error", "-f", "lavfi"],
  ...["-i", "testsrc=size=640x360:rate=30", "-t", "10"],
  ...["-c:v", "libvpx", "-b:v", "2M", file],
]);
const clip = readFileSync(file);
const server = createServer((req, res) => {
  if (req.url === "/clip.webm") {
    res.writeHead(200, {
      "content-type": "video/webm",
      "content-length": clip.length,
    });
    let at = 0;
    let timer;
    const send = () => {
      res.write(clip.subarray(at, at + 25_000));
      at += 25_000;
      if (at >= clip.length) res.end();
      else timer = setTimeout(send, 300);
    };
    send();
    req.on("close", () => clearTimeout(timer));
    return;
  }
  res.writeHead(200, { "content-type": "text/html" });
  res.end(`<!doctype html><video id=v muted autoplay src="/clip.webm" style="width:320px"></video>
<script>window.seen=[];for(const e of ["waiting","stalled","playing","pause","suspend","canplay","canplaythrough","ended","error"])v.addEventListener(e,()=>seen.push(e+"@"+v.currentTime.toFixed(2)))</script>`);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));

const STATE = `(() => { const v = document.getElementById("v"); const b = v.buffered;
  return { t: +v.currentTime.toFixed(2), paused: v.paused, ready: v.readyState,
    buffered: b.length ? +b.end(b.length - 1).toFixed(2) : 0, events: seen.splice(0) }; })()`;

async function run() {
  const browser = await chromium.launch({
    headless: true,
    executablePath: chromium.executablePath(),
  });
  const page = await browser.newPage();
  const s = await page.context().newCDPSession(page);
  let held = 0;
  const grant = (to) =>
    new Promise((resolve) => {
      const budget = to - held;
      s.once("Emulation.virtualTimeBudgetExpired", async () => {
        held = to;
        await s.send("Emulation.setVirtualTimePolicy", {
          policy: "pause",
          initialVirtualTime: (PIN + held) / 1000,
        });
        resolve();
      });
      s.send("Emulation.setVirtualTimePolicy", { policy: "advance", budget });
    });
  await s.send("Emulation.setVirtualTimePolicy", {
    policy: "pause",
    initialVirtualTime: PIN / 1000,
  });
  const t0 = Date.now();
  await s.send("Page.navigate", {
    url: `http://127.0.0.1:${server.address().port}/`,
  });
  for (let k = 1; k <= FRAMES; k++) {
    await grant(k * FRAME);
    await s.send("Page.captureScreenshot", { format: "jpeg", quality: 80 });
    if (k % 10 === 0 || k === 1) {
      const v = (
        await s.send("Runtime.evaluate", {
          expression: STATE,
          returnByValue: true,
        })
      ).result.value;
      console.log(
        JSON.stringify({
          frame: k,
          heldS: +(held / 1000).toFixed(2),
          realS: +((Date.now() - t0) / 1000).toFixed(2),
          ...v,
        }),
      );
    }
  }
  // Bounded: the close, or the clip's open connection, has held the
  // process at the end.
  await Promise.race([
    browser.close(),
    new Promise((r) => setTimeout(r, 5000)),
  ]);
}

await run();
process.exit(0);

// Held-clock probe (2026-11-17): why a video stops on a held clock
// once its download is not server time. A muted autoplaying 10 s video,
// served at about 80 KB/s (as compare/held-push.sh video), on a held page
// played a frame at a time with a capture each and no real-time pacing, as
// the clock does in designed time. Prints the video's state every 10 frames.
// Measured 2026-11-17: it plays, so the recorder is what stops it.
// Added 2026-11-19: what the recorder adds, one switch each, so the
// probe can bisect it: FLAGS=1 launches with the held recording's Chromium
// switches (HELD_FLAGS), FLAGS=<one switch> with that one alone; PIN=1
// installs the held frame script and runs the animation pin every frame, as
// the clock does; CLICK=1 adds the video 30 frames in, as held-push.sh's
// page does, not at load; PACE=1 lets no frame run ahead of real time.
// Prints how many frames' pictures changed, last.
// Measured 2026-11-19: --run-all-compositor-stages-before-draw alone stops
// it. Without it Chrome slows held time to real time while the video loads;
// with it held time ran 2x real, the video sat paused at readyState 3
// (autoplay waits for 4) and the picture changed on 2 of 180 frames. With
// PACE=1 as well it played: 132 of 180. So the clock paces a video
// (held-clock.ts `grant`). PIN and CLICK hit the hang below each time.
//   node apps/runner/compare/held-probe-video.mjs   (needs ffmpeg; build first)
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import {
  HELD_FRAMES_SCRIPT,
  PIN_ANIMATIONS,
} from "../../../packages/replay-engine/dist/index.js";
import { HELD_FLAGS } from "../dist/executor/held.js";

const on = (name) => process.env[name] === "1";
console.log(
  `switches: FLAGS=${process.env.FLAGS ?? ""} PIN=${on("PIN")} CLICK=${on("CLICK")} PACE=${on("PACE")}`,
);

const PIN = Date.parse("2026-01-01T00:00:00Z");
const FRAME = 1000 / 30;
const FRAMES = 180;
/** A call to the browser sometimes never answers while the video loads (3
 *  of 6 runs on 2026-11-17, not traced), so the run is bounded. */
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
  const video = `<video id=v muted autoplay src="/clip.webm" style="width:320px"></video>`;
  res.end(`<!doctype html>
<script>window.seen=[];window.addVideo=()=>{document.body.insertAdjacentHTML("beforeend",${JSON.stringify(video)});const v=document.getElementById("v");for(const e of ["waiting","stalled","playing","pause","suspend","canplay","canplaythrough","ended","error"])v.addEventListener(e,()=>seen.push(e+"@"+v.currentTime.toFixed(2)))};${on("CLICK") ? "" : "addVideo()"}</script>`);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));

const STATE = `(() => { const v = document.getElementById("v"); if (!v) return { none: true }; const b = v.buffered;
  return { t: +v.currentTime.toFixed(2), paused: v.paused, ready: v.readyState,
    buffered: b.length ? +b.end(b.length - 1).toFixed(2) : 0, events: seen.splice(0) }; })()`;

async function run() {
  const args = on("FLAGS")
    ? HELD_FLAGS
    : HELD_FLAGS.filter((f) => f === process.env.FLAGS);
  // A name that matches no switch would launch with none, unsaid.
  if (process.env.FLAGS && args.length === 0) {
    console.log(
      `FLAGS=${process.env.FLAGS} is none of ${HELD_FLAGS.join(" ")}`,
    );
    process.exit(2);
  }
  console.log(`launched with: ${args.join(" ") || "no switches"}`);
  const browser = await chromium.launch({
    headless: true,
    executablePath: chromium.executablePath(),
    args,
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
  if (on("PIN")) {
    await s.send("Page.addScriptToEvaluateOnNewDocument", {
      source: HELD_FRAMES_SCRIPT,
    });
  }
  const said = [];
  const pictures = [];
  let lastPicture = "";
  const t0 = Date.now();
  await s.send("Page.navigate", {
    url: `http://127.0.0.1:${server.address().port}/`,
  });
  for (let k = 1; k <= FRAMES; k++) {
    // PACE: no frame ahead of real time, as a recording paced at 1x would be.
    if (on("PACE")) {
      const ahead = k * FRAME - (Date.now() - t0);
      if (ahead > 0) await new Promise((r) => setTimeout(r, ahead));
    }
    await grant(k * FRAME);
    if (on("PIN")) {
      const r = await s.send("Runtime.evaluate", {
        expression: `(${PIN_ANIMATIONS})(${held}, false)`,
        returnByValue: true,
      });
      for (const w of r.result.value?.said ?? []) said.push(`${k}: ${w}`);
    }
    if (k === 30) {
      await s.send("Runtime.evaluate", {
        expression:
          "window.addVideo && !document.getElementById('v') && addVideo()",
      });
    }
    // The picture, not currentTime: an earlier run saw one stand still while the
    // other moved. PNG, so a repeat is byte for byte.
    const shot = await s.send("Page.captureScreenshot", { format: "png" });
    const h = createHash("md5").update(shot.data).digest("hex");
    if (h !== lastPicture) pictures.push(k);
    lastPicture = h;
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
  console.log(`pin said: ${JSON.stringify(said)}`);
  console.log(
    `picture changed on ${pictures.length} of ${FRAMES} frames, last at ${pictures.at(-1)}: ${pictures.join(",")}`,
  );
  // Bounded: the close, or the clip's open connection, has held the
  // process at the end.
  await Promise.race([
    browser.close(),
    new Promise((r) => setTimeout(r, 5000)),
  ]);
}

await run();
process.exit(0);

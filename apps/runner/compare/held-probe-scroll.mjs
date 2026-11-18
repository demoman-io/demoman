// Probe 4: smooth scrolling and requestAnimationFrame under a held clock.
import { createServer } from "node:http";
import { chromium } from "playwright";

const PIN = Date.parse("2026-01-01T00:00:00Z");
const FRAME = 1000 / 30;
const server = createServer((_req, res) => {
  res.writeHead(200, { "content-type": "text/html" });
  res.end(
    `<style>html{scroll-behavior:smooth}</style><div style="height:5000px"></div><button id=b>far</button>`,
  );
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const browser = await chromium.launch({
  headless: true,
  ...(process.env.FULL === "1"
    ? { executablePath: chromium.executablePath() }
    : {}),
  args: [
    "--disable-threaded-animation",
    "--disable-threaded-scrolling",
    "--run-all-compositor-stages-before-draw",
    ...(process.env.EXTRA ? [process.env.EXTRA] : []),
  ],
});
const page = await browser.newPage();
const s = await page.context().newCDPSession(page);
const ev = async (expression) =>
  (await s.send("Runtime.evaluate", { expression, returnByValue: true })).result
    .value;
const realSleep = (ms) => new Promise((r) => setTimeout(r, ms));
let held = 0;
const hold = (ms) =>
  s.send("Emulation.setVirtualTimePolicy", {
    policy: "pause",
    initialVirtualTime: (PIN + ms) / 1000,
  });
const grant = (budget) =>
  new Promise((resolve, reject) => {
    s.once("Emulation.virtualTimeBudgetExpired", async () => {
      held += budget;
      await hold(held);
      resolve();
    });
    s.send("Emulation.setVirtualTimePolicy", {
      policy: "advance",
      budget,
    }).catch(reject);
  });
await hold(0);
await s.send("Page.navigate", {
  url: `http://127.0.0.1:${server.address().port}/`,
});
await realSleep(200);
await grant(FRAME);
console.log("loaded", await ev("document.readyState"));
// rAF while paused, real time.
await ev(
  "window.rafs = []; (function f(t) { window.rafs.push([t, Date.now()]); if (window.rafs.length < 1000) requestAnimationFrame(f); })(performance.now()); 1",
);
await realSleep(500);
const r1 = await ev("window.rafs.length");
const last = await ev("window.rafs.slice(-2)");
console.log(
  "rAF callbacks in 500 ms real, paused:",
  r1,
  "last two [rafTime, Date.now-pin]:",
  last.map(([t, d]) => [Math.round(t), d - PIN]),
);
await grant(FRAME);
await realSleep(30);
console.log(
  "after one grant + 30 ms:",
  await ev("window.rafs.length"),
  (await ev("window.rafs.slice(-1)")).map(([t, d]) => [Math.round(t), d - PIN]),
);
await ev("window.rafs.length = 1000; 1");
// Smooth scroll while paused.
await ev("window.scrollTo({ top: 3000 }); 1");
await realSleep(500);
console.log(
  "smooth scrollTo while paused, after 500 ms real: scrollY",
  await ev("scrollY"),
);
const ys = [];
for (let i = 0; i < 40; i++) {
  await grant(FRAME);
  await realSleep(10);
  ys.push(Math.round(await ev("scrollY")));
}
console.log("scrollY per granted frame:", ys.join(","));
// scrollIntoView smooth, and instant
await ev(
  'document.getElementById("b").scrollIntoView({ behavior: "smooth", block: "center" }); 1',
);
await realSleep(300);
console.log(
  "scrollIntoView smooth while paused, 300 ms real:",
  await ev("scrollY"),
);
const ys2 = [];
for (let i = 0; i < 40; i++) {
  await grant(FRAME);
  ys2.push(Math.round(await ev("scrollY")));
}
console.log("scrollY per granted frame (no real gap):", ys2.join(","));
await ev('scrollTo({ top: 0, behavior: "instant" }); 1');
console.log("instant scroll while paused:", await ev("scrollY"));
// Mouse wheel while paused.
await s.send("Input.dispatchMouseEvent", {
  type: "mouseWheel",
  x: 100,
  y: 100,
  deltaX: 0,
  deltaY: 600,
});
await realSleep(300);
console.log("wheel 600 while paused, 300 ms real:", await ev("scrollY"));
const ys3 = [];
for (let i = 0; i < 20; i++) {
  await grant(FRAME);
  ys3.push(Math.round(await ev("scrollY")));
}
console.log("scrollY per granted frame after wheel:", ys3.join(","));
await browser.close();
server.close();

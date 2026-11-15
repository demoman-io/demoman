// Probe 5: performance.now and rAF timestamps under a held clock; SSE with
// real gaps between grants; whether a cross-origin iframe is its own target.
import { createServer } from "node:http";
import { chromium } from "playwright";

const PIN = Date.parse("2026-01-01T00:00:00Z");
const FRAME = 1000 / 30;
const other = createServer((_req, res) => {
  res.writeHead(200, { "content-type": "text/html" });
  res.end(
    `<style>@keyframes s{to{transform:rotate(360deg)}}div{width:20px;height:20px;background:red;animation:s 1s linear infinite}</style><div></div>`,
  );
});
await new Promise((r) => other.listen(0, "127.0.0.1", r));
const main = createServer((req, res) => {
  if (req.url === "/sse") {
    res.writeHead(200, { "content-type": "text/event-stream" });
    let i = 0;
    const t = setInterval(() => {
      res.write(`data: e${i}\n\n`);
      if (++i === 3) {
        clearInterval(t);
        res.end();
      }
    }, 100);
    return;
  }
  res.writeHead(200, { "content-type": "text/html" });
  res.end(
    `<p>main</p><iframe src="http://localhost:${other.address().port}/"></iframe>`,
  );
});
await new Promise((r) => main.listen(0, "127.0.0.1", r));
const browser = await chromium.launch({
  headless: true,
  ...(process.env.FULL === "1"
    ? { executablePath: chromium.executablePath() }
    : {}),
  args: [
    "--disable-threaded-animation",
    "--disable-threaded-scrolling",
    "--run-all-compositor-stages-before-draw",
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
const contexts = [];
s.on("Runtime.executionContextCreated", (e) => contexts.push(e.context.origin));
const attached = [];
s.on("Target.attachedToTarget", (e) =>
  attached.push(`${e.targetInfo.type} ${e.targetInfo.url}`),
);
await s.send("Runtime.enable");
await s.send("Target.setAutoAttach", {
  autoAttach: true,
  waitForDebuggerOnStart: false,
  flatten: true,
});
await hold(0);
await s.send("Page.navigate", {
  url: `http://127.0.0.1:${main.address().port}/`,
});
for (let i = 0; i < 10; i++) {
  await grant(FRAME);
  await realSleep(30);
}
const p0 = await ev("performance.now()");
await realSleep(300);
const p1 = await ev("performance.now()");
console.log("performance.now moved in 300 ms real while paused by", p1 - p0);
await grant(FRAME);
console.log(
  "performance.now moved over one grant by",
  (await ev("performance.now()")) - p1,
);
console.log("execution context origins on the page session:", contexts);
console.log("auto-attached targets:", attached);
console.log(
  "top document getAnimations:",
  await ev("document.getAnimations().length"),
);
// SSE with real gaps.
await ev(
  `window.sse = []; const es = new EventSource("/sse"); es.onmessage = (e) => { window.sse.push(e.data); if (window.sse.length === 3) es.close(); }; 1`,
);
let n = 0;
for (; n < 60; n++) {
  if ((await ev("window.sse.length")) === 3) break;
  await grant(FRAME);
  await realSleep(30);
}
console.log("SSE: 3 events read after frames", n, await ev("window.sse"));
await browser.close();
main.close();
other.close();

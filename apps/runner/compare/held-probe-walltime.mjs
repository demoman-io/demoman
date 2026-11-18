// Probe: is Network.requestWillBeSent's wallTime real time or the page's
// held (virtual) time? A held page pinned hours away from now makes a fetch
// of its own and then follows a link to another site. Prints, per request,
// wallTime minus the machine's Date.now() when the event arrived.
// Run: FULL=1 node apps/runner/compare/held-probe-walltime.mjs
import { createServer } from "node:http";
import { chromium } from "playwright";

const PIN = Date.now() - 10 * 3600 * 1000; // ten hours ago
const FRAME = 1000 / 30;
const listen = (handler) =>
  new Promise((r) => {
    const s = createServer(handler);
    s.listen(0, "127.0.0.1", () => r(s.address().port));
  });
const b = await listen((_req, res) => {
  setTimeout(() => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end("<link rel=icon href='data:,'><p id=there>there</p>");
  }, 200);
});
const a = await listen((req, res) => {
  if (req.url === "/answer") {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("x");
    return;
  }
  res.writeHead(200, { "content-type": "text/html" });
  res.end(
    `<link rel=icon href='data:,'><a id=go href="http://localhost:${b}/there">go</a><script>window.fetchIt = () => fetch("/answer")</script>`,
  );
});
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
await s.send("Network.enable");
const seen = [];
s.on("Network.requestWillBeSent", (p) => {
  const now = Date.now();
  seen.push({
    url: new URL(p.request.url).pathname,
    type: p.type,
    wallMinusNow: Math.round(p.wallTime * 1000 - now),
    wallMinusPin: Math.round(p.wallTime * 1000 - PIN),
  });
});
let held = 0;
const pause = (t) =>
  s.send("Emulation.setVirtualTimePolicy", {
    policy: "pause",
    initialVirtualTime: t / 1000,
  });
const grant = (budget) =>
  new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("no expiry")), 5000);
    s.once("Emulation.virtualTimeBudgetExpired", async () => {
      clearTimeout(t);
      held += budget;
      await pause(PIN + held);
      resolve();
    });
    s.send("Emulation.setVirtualTimePolicy", {
      policy: "advance",
      budget,
    }).catch(reject);
  });
const frames = async (n) => {
  for (let i = 0; i < n; i++) {
    await grant(FRAME);
    await new Promise((r) => setTimeout(r, 30));
  }
};
await pause(PIN);
await page.goto(`http://127.0.0.1:${a}/`, { waitUntil: "commit" });
await frames(10);
// The page's own fetch, sent by its script inside a grant.
s.send("Runtime.evaluate", { expression: "window.fetchIt()" }).catch(() => {});
await frames(10);
// A click to another site: a navigation request, from the browser.
s.send("Runtime.evaluate", {
  expression: "document.getElementById('go').click()",
}).catch(() => {});
await frames(30);
console.log(
  JSON.stringify({
    pin: new Date(PIN).toISOString(),
    browser: process.env.FULL === "1" ? "full" : "shell",
    requests: seen,
  }),
);
await browser.close();
process.exit(0);

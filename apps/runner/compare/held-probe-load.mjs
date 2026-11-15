// Probe 2: page load under a held clock, granting frames with real gaps.
import { createServer } from "node:http";
import { chromium } from "playwright";

const PIN = Date.parse("2026-01-01T00:00:00Z");
const FRAME = 1000 / 30;
const POLICY = process.env.POLICY ?? "advance";
const GAP = Number(process.env.GAP ?? 30);
const server = createServer((req, res) => {
  if (req.url === "/slow.js") {
    setTimeout(() => {
      res.writeHead(200, { "content-type": "text/javascript" });
      res.end("window.slowRan = Date.now()");
    }, 300);
    return;
  }
  res.writeHead(200, { "content-type": "text/html" });
  res.end(
    `<p id=t></p><script src="/slow.js"></script><script>window.t0 = Date.now(); addEventListener("load", () => { window.loaded = Date.now(); });</script>`,
  );
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;
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
const log = [];
const t00 = Date.now();
const mark = (w) => log.push(`${Date.now() - t00} ${w}`);
await s.send("Network.enable");
for (const e of [
  "requestWillBeSent",
  "responseReceived",
  "dataReceived",
  "loadingFinished",
])
  s.on(`Network.${e}`, (p) =>
    mark(`${e} ${p.request?.url?.replace(/http:\/\/[^/]+/, "") ?? ""}`),
  );
s.on("Emulation.virtualTimeBudgetExpired", () => mark("expired"));
await s.send("Emulation.setVirtualTimePolicy", {
  policy: "pause",
  initialVirtualTime: PIN / 1000,
});
await s.send("Page.navigate", { url: `http://127.0.0.1:${port}/` });
let held = 0;
const grant = (budget) =>
  new Promise((resolve, reject) => {
    const t = setTimeout(
      () => reject(new Error(`grant at ${held} no answer in 3 s`)),
      3000,
    );
    s.once("Emulation.virtualTimeBudgetExpired", () => {
      clearTimeout(t);
      held += budget;
      resolve();
    });
    mark(`grant ${Math.round(held)}`);
    s.send("Emulation.setVirtualTimePolicy", { policy: POLICY, budget }).catch(
      reject,
    );
  });
let result;
try {
  for (let n = 0; n < 60; n++) {
    const v = (
      await s.send("Runtime.evaluate", {
        expression: `({r: document.readyState, t0: window.t0 && window.t0 - ${PIN}, slow: window.slowRan && window.slowRan - ${PIN}, loaded: window.loaded && window.loaded - ${PIN}})`,
        returnByValue: true,
      })
    ).result.value;
    if (v.r === "complete") {
      result = { n, ...v };
      break;
    }
    await grant(FRAME);
    await new Promise((r) => setTimeout(r, GAP));
  }
} catch (e) {
  result = e.message;
}
console.log(JSON.stringify({ POLICY, GAP, result, held: Math.round(held) }));
console.log(
  log.filter((l) => !/grant|expired/.test(l) || process.env.ALL).join("\n"),
);
await browser.close();
server.close();

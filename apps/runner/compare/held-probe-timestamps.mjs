// Held-clock probe (2026-11-15): is performance.now() the same in two runs
// at the same held time? Chrome clamps it to 100 µs with a per-process
// jitter, so a held time off that grid may read either side of it.
//   GRID=1 node apps/runner/compare/held-probe-timestamps.mjs
// GRID=1 lands every grant on the 0.1 ms grid.
import { createServer } from "node:http";
import { chromium } from "playwright";

const PIN = Date.parse("2026-01-01T00:00:00Z");
const FRAME = 1000 / 30;
const server = createServer((_req, res) => {
  res.writeHead(200, { "content-type": "text/html" });
  res.end("<p>t</p>");
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const snap = (ms) => (process.env.GRID === "1" ? Math.round(ms * 10) / 10 : ms);
async function run() {
  const browser = await chromium.launch({
    headless: true,
    executablePath: chromium.executablePath(),
  });
  const page = await browser.newPage();
  const s = await page.context().newCDPSession(page);
  let chrome = 0;
  const grant = (to) =>
    new Promise((resolve) => {
      const budget = snap(to) - chrome;
      s.once("Emulation.virtualTimeBudgetExpired", async () => {
        chrome += budget;
        await s.send("Emulation.setVirtualTimePolicy", {
          policy: "pause",
          initialVirtualTime: (PIN + chrome) / 1000,
        });
        resolve();
      });
      s.send("Emulation.setVirtualTimePolicy", { policy: "advance", budget });
    });
  await s.send("Emulation.setVirtualTimePolicy", {
    policy: "pause",
    initialVirtualTime: PIN / 1000,
  });
  await s.send("Page.navigate", {
    url: `http://127.0.0.1:${server.address().port}/`,
  });
  await new Promise((r) => setTimeout(r, 200));
  const seen = [];
  for (let k = 1; k <= 60; k++) {
    await grant(k * FRAME);
    seen.push(
      (await s.send("Runtime.evaluate", { expression: "performance.now()" }))
        .result.value,
    );
  }
  await browser.close();
  return seen;
}
const a = await run();
const b = await run();
const differ = a.flatMap((x, i) =>
  x === b[i] ? [] : [`${i}: ${x} vs ${b[i]}`],
);
console.log(
  JSON.stringify({
    grid: process.env.GRID === "1",
    differ: differ.length,
    of: a.length,
    first: differ.slice(0, 5),
    sample: a.slice(0, 4),
  }),
);
server.close();

// Held-clock probe (2026-11-19, DEM-237): what the held clock's second read
// can tell once a frame's read went unanswered.
//   node apps/runner/compare/held-probe-unanswered.mjs
// One line per case. The clock's sentence leans on these answers: a page
// whose script is running answers no read (so the loop sentence is true),
// one held on a paused clock answers at once (so a hung read there is not
// its script), and the browser says the page's address either way.
import { chromium } from "playwright";

const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto("data:text/html,<p>probe</p>");
const cdp = await page.context().newCDPSession(page);
const bound = (p) =>
  Promise.race([
    p.then(
      (v) => v,
      (e) => `refused: ${e.message}`,
    ),
    new Promise((r) => setTimeout(() => r("no answer within 1000 ms"), 1000)),
  ]);
const read = () =>
  bound(
    cdp.send("Runtime.evaluate", {
      expression: "[location.href, document.readyState]",
      returnByValue: true,
    }),
  ).then((a) => (typeof a === "string" ? a : JSON.stringify(a.result.value)));
const where = () =>
  bound(cdp.send("Target.getTargetInfo")).then((a) =>
    typeof a === "string" ? a : a.targetInfo.url,
  );

await cdp.send("Emulation.setVirtualTimePolicy", { policy: "pause" });
console.log(
  `held, idle:    second read ${await read()}; browser ${await where()}`,
);
await cdp.send("Emulation.setVirtualTimePolicy", { policy: "advance" });
void cdp.send("Runtime.evaluate", {
  expression:
    "setTimeout(() => { const t = Date.now(); while (Date.now() - t < 3000) {} }, 0); 1",
});
await new Promise((r) => setTimeout(r, 200));
console.log(
  `looping:       second read ${await read()}; browser ${await where()}`,
);
await new Promise((r) => setTimeout(r, 3000));
await browser.close();

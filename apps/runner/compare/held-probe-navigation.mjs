// Probe 3: the held time across navigations, and how Chrome's virtual time
// tracks the grants. Every grant has a 30 ms real gap after it (a capture).
import { createServer } from "node:http";
import { chromium } from "playwright";

const PIN = Date.parse("2026-01-01T00:00:00Z");
const FRAME = 1000 / 30;
const page0 = `<p id=t></p><script>window.t0 = Date.now(); document.getElementById("t").textContent = window.t0</script>`;
const links = {};
const mk = (name) =>
  new Promise((r) => {
    const s = createServer((req, res) => {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(`${page0}<a id=x href="${links[name + req.url]}">x</a>`);
    });
    s.listen(0, "127.0.0.1", () => r({ s, port: s.address().port }));
  });
const A = await mk("A");
const B = await mk("B");
const urlA = `http://127.0.0.1:${A.port}/`;
const urlB = `http://localhost:${B.port}/`;
links["A/"] = `${urlA}next`;
links["A/next"] = urlB;
links["B/"] = urlA;
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
const gap = () => new Promise((r) => setTimeout(r, 30));
let held = 0;
const _MODE = process.env.MODE ?? "repause"; // repause: pause+initialVirtualTime after each grant
const grant = (budget) =>
  new Promise((resolve, reject) => {
    const t = setTimeout(
      () => reject(new Error(`grant at ${held} no answer in 3 s`)),
      3000,
    );
    s.once("Emulation.virtualTimeBudgetExpired", async () => {
      clearTimeout(t);
      held += budget;
      if (process.env.REPAUSE === "1") await hold(held);
      resolve();
    });
    s.send("Emulation.setVirtualTimePolicy", {
      policy: "advance",
      budget,
    }).catch(reject);
  });
const drift = async (what) => {
  let now;
  try {
    now = await ev("Date.now()");
  } catch (_e) {
    now = NaN;
  }
  console.log(
    `${what}: page Date.now - pin = ${now - PIN}, held = ${held.toFixed(2)}`,
  );
};
const until = async (expr, max = 60) => {
  for (let n = 0; n < max; n++) {
    let v;
    try {
      v = await ev(expr);
    } catch {}
    if (v) return n;
    await grant(FRAME);
    await gap();
  }
  return -1;
};
var hold = (ms) =>
  s.send("Emulation.setVirtualTimePolicy", {
    policy: "pause",
    initialVirtualTime: (PIN + ms) / 1000,
  });
await s.send("Page.enable");
await hold(0);
await s.send("Page.navigate", { url: urlA });
console.log(
  "A loaded after frames",
  await until("window.t0 !== undefined"),
  "t0-pin",
  (await ev("window.t0")) - PIN,
);
for (let i = 0; i < 10; i++) {
  await grant(FRAME);
  await gap();
}
await drift("after 10 frames");
await grant(0.33);
await grant(1);
await drift("after 0.33 + 1");
await grant(500);
await drift("after 500");
// Click-like navigation, same site: rehold at frameRequestedNavigation vs none.
const reheld = [];
s.on("Page.frameRequestedNavigation", async (e) => {
  reheld.push(`requested ${e.url}`);
  if (process.env.REHOLD === "requested") await hold(held);
});
s.on("Page.frameStartedLoading", async () => {
  reheld.push("startedLoading");
  if (process.env.REHOLD === "started") await hold(held);
});
for (const [label, url, expect] of [
  ["same-site link", null, `${urlA}next`],
  ["cross-site link", null, urlB],
  ["cross-site Page.navigate", urlA, urlA],
]) {
  const before = held;
  if (process.env.REHOLD === "before") await hold(held);
  if (url) await s.send("Page.navigate", { url });
  else await ev('document.getElementById("x").click()');
  await gap();
  const n = await until(
    `location.href === "${expect}" && window.t0 !== undefined`,
    60,
  );
  const t0 = await ev("window.t0");
  console.log(
    `${label}: frames ${n}, t0 - pin = ${t0 - PIN}, held before ${before.toFixed(1)}, held now ${held.toFixed(1)} ${location0(await ev("location.href"))}`,
  );
  await drift(`  after ${label}`);
}
console.log(reheld.join(" | "));
function location0(h) {
  return h;
}
await browser.close();
A.s.close();
B.s.close();

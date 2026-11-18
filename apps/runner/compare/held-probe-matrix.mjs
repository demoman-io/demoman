// Held-clock probe (2026-11-15): one browser × flags cell of the "Shell vs
// full Chromium" table in the held-clock Task 6 report.
//   BROWSER=shell|full FLAGS=on|off node apps/runner/compare/held-probe-matrix.mjs
// shell is Playwright's headless shell (what `chromium.launch` starts when
// no executablePath is named); full is `chromium.executablePath()`, what
// production records with. FLAGS=on adds the three held flags. Both get
// `--enable-gpu` on macOS, as the runner's headless launch does. Every grant
// is the held clock's: `advance` with the budget, then `pause` at the held
// time. Prints one JSON line.
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { chromium } from "playwright";

const BROWSER = process.env.BROWSER ?? "full";
const FLAGS = process.env.FLAGS ?? "on";
const PIN = Date.parse("2026-01-01T00:00:00Z");
const FRAME = 1000 / 30;
const realSleep = (ms) => new Promise((r) => setTimeout(r, ms));
const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const sha = (b64) => createHash("sha1").update(b64).digest("hex").slice(0, 10);

const listen = (handler) =>
  new Promise((r) => {
    const s = createServer(handler);
    s.listen(0, "127.0.0.1", () => r(s));
  });
const html = (res, body) => {
  res.writeHead(200, { "content-type": "text/html" });
  res.end(body);
};
const seenByServer = [];
const B = await listen((req, res) => {
  seenByServer.push(`B${req.url}`);
  if (req.url === "/frame")
    return html(
      res,
      `<style>@keyframes s{to{transform:translateX(100px)}}#d{width:20px;height:20px;background:red;animation:s 1s linear infinite}</style><div id=d></div>
<script>window.ticks = 0; setInterval(() => window.ticks++, 50); fetch("/oopif-req");</script>`,
    );
  if (req.url === "/oopif-req") return res.end("x");
  html(
    res,
    `<script>window.t0 = Date.now()</script><a id=x href="${`http://127.0.0.1:${A.address().port}/plain2`}">x</a>`,
  );
});
const A = await listen((req, res) => {
  seenByServer.push(`A${req.url}`);
  const bUrl = `http://localhost:${B.address().port}`;
  if (req.url === "/anim")
    return html(
      res,
      `<div id=box style="position:absolute;left:0;top:0;width:40px;height:40px;background:#c00"></div>
<canvas id=c width=400 height=100 style="position:absolute;left:0;top:60px"></canvas>
<script>
const ctx = document.getElementById("c").getContext("2d");
window.rafCount = 0; window.lastTs = 0;
function f(ts) {
  window.rafCount++; window.lastTs = ts;
  document.getElementById("box").style.left = ((ts % 2000) / 5).toFixed(1) + "px";
  ctx.clearRect(0, 0, 400, 100); ctx.fillStyle = "#00c"; ctx.fillRect((ts % 2000) / 5, 20, 30, 30);
  requestAnimationFrame(f);
}
requestAnimationFrame(f);
</script>`,
    );
  if (req.url === "/scroll")
    return html(
      res,
      `<div style="height:4000px"></div><button id=far>far</button><div style="height:4000px"></div>`,
    );
  if (req.url === "/frame-page")
    return html(
      res,
      `<iframe src="${bUrl}/frame"></iframe><script>new Worker("/worker.js")</script>`,
    );
  if (req.url === "/worker.js") {
    res.writeHead(200, { "content-type": "text/javascript" });
    return res.end(`fetch("/from-worker")`);
  }
  if (req.url === "/from-worker") return res.end("w");
  if (req.url === "/typical")
    return html(
      res,
      `<style>body{font:16px system-ui;margin:0}header{background:#123;color:#fff;padding:16px 24px}main{display:grid;grid-template-columns:repeat(3,1fr);gap:16px;padding:24px}.card{border:1px solid #ccc;border-radius:8px;padding:16px;box-shadow:0 2px 6px #0002}</style>
<header><h1>Invoices</h1></header><main>${Array.from({ length: 12 }, (_, i) => `<div class=card><h3>Invoice ${1000 + i}</h3><p>Acme Corp, due Dec ${i + 1}, 2026. Net 30. Some longer description text to wrap across lines.</p><button>Open</button></div>`).join("")}</main>`,
    );
  if (req.url === "/plain" || req.url === "/plain2")
    return html(
      res,
      `<script>window.t0 = Date.now()</script><a id=x href="${bUrl}/">x</a>`,
    );
  res.end();
});

const browser = await chromium.launch({
  headless: true,
  ...(BROWSER === "full" ? { executablePath: chromium.executablePath() } : {}),
  args: [
    ...(FLAGS === "on"
      ? [
          "--disable-threaded-animation",
          "--disable-threaded-scrolling",
          "--run-all-compositor-stages-before-draw",
        ]
      : []),
    ...(process.platform === "darwin" ? ["--enable-gpu"] : []),
  ],
});
const context = await browser.newContext({
  viewport: { width: 1280, height: 800 },
  deviceScaleFactor: 2,
});

/** A fresh page on the held clock at PIN, loaded at `url` with one grant. */
async function heldPage(url) {
  const page = await context.newPage();
  const s = await context.newCDPSession(page);
  let held = 0;
  const ev = async (expression) =>
    (await s.send("Runtime.evaluate", { expression, returnByValue: true }))
      .result.value;
  const hold = (ms) =>
    s.send("Emulation.setVirtualTimePolicy", {
      policy: "pause",
      initialVirtualTime: (PIN + ms) / 1000,
    });
  const grant = (budget = FRAME) =>
    new Promise((resolve, reject) => {
      const t = setTimeout(
        () => reject(new Error(`grant at ${held} no answer in 5 s`)),
        5000,
      );
      s.once("Emulation.virtualTimeBudgetExpired", async () => {
        clearTimeout(t);
        held += budget;
        await hold(held);
        resolve();
      });
      s.send("Emulation.setVirtualTimePolicy", {
        policy: "advance",
        budget,
      }).catch(reject);
    });
  const shot = async (clip) =>
    (
      await s.send("Page.captureScreenshot", {
        format: "jpeg",
        quality: 95,
        ...(clip ? { clip: { ...clip, scale: 1 } } : {}),
      })
    ).data;
  const until = async (expr, max = 90) => {
    for (let n = 0; n < max; n++) {
      let v;
      try {
        v = await ev(expr);
      } catch {}
      if (v) return n;
      await grant();
      await realSleep(30);
    }
    return -1;
  };
  await s.send("Page.enable");
  await hold(0);
  await s.send("Page.navigate", { url });
  await realSleep(100);
  await until('document.readyState === "complete"');
  return { page, s, ev, grant, shot, until, held: () => held };
}

const out = { browser: BROWSER, flags: FLAGS };
const base = `http://127.0.0.1:${A.address().port}`;

// Rows 1-3: rAF.
{
  const p = await heldPage(`${base}/anim`);
  const c0 = await p.ev("[rafCount, lastTs]");
  await realSleep(500);
  const c1 = await p.ev("[rafCount, lastTs]");
  out.row1 = {
    callbacksPer500msPaused: c1[0] - c0[0],
    tsMovedMs: Math.round(c1[1] - c0[1]),
  };
  const perGrant = [];
  const tsPerGrant = [];
  for (let i = 0; i < 10; i++) {
    const a = await p.ev("[rafCount, lastTs]");
    await p.grant();
    const b = await p.ev("[rafCount, lastTs]");
    perGrant.push(b[0] - a[0]);
    tsPerGrant.push(Math.round(b[1] - a[1]));
    await realSleep(30);
  }
  const noGap = [];
  for (let i = 0; i < 10; i++) {
    const a = await p.ev("rafCount");
    await p.grant();
    noGap.push((await p.ev("rafCount")) - a);
  }
  out.row2 = {
    callbacksInsideEachGrant: perGrant.join(","),
    tsAdvanceInsideEachGrant: tsPerGrant.join(","),
    callbacksPerGrantNoRealGap: noGap.join(","),
  };
  await p.page.close();
}
async function rafRun() {
  const p = await heldPage(`${base}/anim`);
  const lefts = [];
  const hashes = [];
  for (let i = 0; i < 30; i++) {
    await p.grant();
    lefts.push(await p.ev('document.getElementById("box").style.left'));
    hashes.push(sha(await p.shot({ x: 0, y: 0, width: 400, height: 160 })));
  }
  await p.page.close();
  return { lefts, hashes };
}
{
  const r1 = await rafRun();
  const r2 = await rafRun();
  out.row3 = {
    positionsIdentical: r1.lefts.join() === r2.lefts.join(),
    framesIdentical: `${r1.hashes.filter((h, i) => h === r2.hashes[i]).length}/30`,
    distinctPositionsRun1: new Set(r1.lefts).size,
    run1First5: r1.lefts.slice(0, 5).join(" "),
    run2First5: r2.lefts.slice(0, 5).join(" "),
  };
}

// Row 4: smooth scroll.
const SCROLLS = {
  scrollTo: 'scrollTo({ top: 3000, behavior: "smooth" }); 1',
  scrollIntoView:
    'document.getElementById("far").scrollIntoView({ behavior: "smooth", block: "center" }); 1',
};
async function scrollRun(how) {
  const a = await heldPage(`${base}/scroll`);
  await a.ev(SCROLLS[how]);
  await realSleep(500);
  const noGrant500 = Math.round(await a.ev("scrollY"));
  await a.page.close();
  const b = await heldPage(`${base}/scroll`);
  await b.ev(SCROLLS[how]);
  const ys = [];
  for (let i = 0; i < 30; i++) {
    await b.grant();
    await b.shot();
    ys.push(Math.round(await b.ev("scrollY")));
  }
  await b.page.close();
  return { noGrant500, ys };
}
out.row4 = {};
for (const how of Object.keys(SCROLLS)) {
  const r1 = await scrollRun(how);
  const r2 = await scrollRun(how);
  out.row4[how] = {
    noGrant500ms: `${r1.noGrant500} / ${r2.noGrant500}`,
    perGrantRun1: r1.ys.join(","),
    perGrantRun2: r2.ys.join(","),
    identical: r1.ys.join() === r2.ys.join(),
  };
}

// Row 5: cross-origin iframe and a worker.
{
  const page = await context.newPage();
  const s = await context.newCDPSession(page);
  const contexts = [];
  const attached = [];
  const requests = [];
  s.on("Runtime.executionContextCreated", (e) =>
    contexts.push(e.context.origin),
  );
  s.on("Target.attachedToTarget", (e) => attached.push(e.targetInfo.type));
  s.on("Network.requestWillBeSent", (e) =>
    requests.push(new URL(e.request.url).pathname),
  );
  await s.send("Runtime.enable");
  await s.send("Network.enable");
  await s.send("Target.setAutoAttach", {
    autoAttach: true,
    waitForDebuggerOnStart: false,
    flatten: true,
  });
  let held = 0;
  const hold = (ms) =>
    s.send("Emulation.setVirtualTimePolicy", {
      policy: "pause",
      initialVirtualTime: (PIN + ms) / 1000,
    });
  const grant = () =>
    new Promise((resolve) => {
      s.once("Emulation.virtualTimeBudgetExpired", async () => {
        held += FRAME;
        await hold(held);
        resolve();
      });
      s.send("Emulation.setVirtualTimePolicy", {
        policy: "advance",
        budget: FRAME,
      });
    });
  await hold(0);
  await s.send("Page.navigate", { url: `${base}/frame-page` });
  for (let i = 0; i < 20; i++) {
    await grant();
    await realSleep(30);
  }
  const frame = page.frames().find((f) => f.url().includes("localhost"));
  const read = () =>
    frame.evaluate(() => ({
      ticks: window.ticks,
      now: Date.now(),
      anim: document.getAnimations()[0]?.currentTime ?? null,
    }));
  const f0 = await read();
  await realSleep(500);
  const f1 = await read();
  const topNow = (
    await s.send("Runtime.evaluate", {
      expression: "Date.now()",
      returnByValue: true,
    })
  ).result.value;
  out.row5 = {
    iframe: contexts.some((o) => o.includes("localhost"))
      ? "in process"
      : attached.includes("iframe")
        ? "own target"
        : "not found",
    iframeIn500msPaused: {
      ticks: f1.ticks - f0.ticks,
      dateNowMoved: f1.now - f0.now,
      animMovedMs: Math.round((f1.anim ?? 0) - (f0.anim ?? 0)),
    },
    iframeDateNowMinusTop: f1.now - topNow,
    pageSessionSaw: [
      "/frame",
      "/oopif-req",
      "/worker.js",
      "/from-worker",
    ].filter((u) => requests.includes(u)),
    serverSaw: ["B/oopif-req", "A/from-worker"].filter((u) =>
      seenByServer.includes(u),
    ),
  };
  await page.close();
}

// Row 6: cross-site navigation, pause after every grant.
{
  const p = await heldPage(`${base}/plain`);
  for (let i = 0; i < 10; i++) await p.grant();
  const before = p.held();
  await p.ev('document.getElementById("x").click()');
  await realSleep(50);
  await p.until('location.hostname === "localhost" && window.t0 !== undefined');
  const link = (await p.ev("window.t0")) - PIN;
  const linkHeld = before;
  const before2 = p.held();
  await p.s.send("Page.navigate", { url: `${base}/plain2` });
  await realSleep(50);
  await p.until('location.pathname === "/plain2" && window.t0 !== undefined');
  const nav = (await p.ev("window.t0")) - PIN;
  out.row6 = {
    crossSiteLink: `t0 ${link} vs held ${linkHeld.toFixed(1)}`,
    crossSiteNavigate: `t0 ${nav} vs held ${before2.toFixed(1)}`,
  };
  await p.page.close();
}

// Row 7: screenshot cost.
{
  const p = await heldPage(`${base}/typical`);
  const ms = [];
  for (let i = 0; i < 31; i++) {
    const t = performance.now();
    await p.shot();
    if (i > 0) ms.push(performance.now() - t);
  }
  out.row7 = {
    medianMs: Math.round(median(ms) * 10) / 10,
    minMs: Math.round(Math.min(...ms)),
    maxMs: Math.round(Math.max(...ms)),
  };
  await p.page.close();
}

console.log(JSON.stringify(out));
await browser.close();
A.close();
B.close();

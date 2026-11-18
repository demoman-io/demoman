// Held-clock probe (2026-11-15): what real Chrome does under a held clock.
//   FULL=1 node apps/runner/compare/held-probe-basics.mjs (FULL=1: the full Chromium production launches)
// Prints one line per question with what it measured. Grants are
// `advance` with a budget: Chrome refuses a budget on `pause`.
import { createServer } from "node:http";
import { chromium } from "playwright";

const PIN = Date.parse("2026-01-01T00:00:00Z");
const FRAME = 1000 / 30;
const listen = (handler) =>
  new Promise((r) => {
    const s = createServer(handler);
    s.listen(0, "127.0.0.1", () => r({ s, port: s.address().port }));
  });
const html = (res, body) => {
  res.writeHead(200, { "content-type": "text/html" });
  res.end(body);
};
const other = await listen((req, res) => {
  if (req.url.startsWith("/frame"))
    return html(
      res,
      `<style>@keyframes s{to{transform:rotate(360deg)}}div{width:20px;height:20px;background:red;animation:s 1s linear infinite}</style><div></div><script>fetch("/oopif-req")</script>`,
    );
  if (req.url.startsWith("/oopif-req")) return res.end("x");
  html(
    res,
    `<p id=t></p><script>document.getElementById("t").textContent=Date.now()</script>`,
  );
});
const main = await listen((req, res) => {
  if (req.url === "/stream") {
    res.writeHead(200, { "content-type": "text/plain" });
    let i = 0;
    const t = setInterval(() => {
      res.write(`chunk${i}\n`);
      if (++i === 5) {
        clearInterval(t);
        res.end();
      }
    }, 100);
    return;
  }
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
  if (req.url === "/worker.js") {
    res.writeHead(200, { "content-type": "text/javascript" });
    return res.end(`fetch("/from-worker")`);
  }
  if (req.url === "/from-worker") return res.end("w");
  if (req.url === "/slow.js") {
    setTimeout(() => {
      res.writeHead(200, { "content-type": "text/javascript" });
      res.end("window.slowRan = Date.now()");
    }, 300);
    return;
  }
  if (req.url === "/plain")
    return html(res, `<p>plain</p><script>window.t0 = Date.now()</script>`);
  if (req.url === "/busy")
    return html(
      res,
      `<script>window.a = Date.now(); let x = 0; for (let i = 0; i < 3e8; i++) x += i; window.x = x; window.b = Date.now();</script>`,
    );
  if (req.url === "/frame-page")
    return html(
      res,
      `<iframe src="http://localhost:${other.port}/frame"></iframe>`,
    );
  html(
    res,
    `<p id=t></p><script src="/slow.js"></script><script>
window.t0 = Date.now();
window.loaded = false; addEventListener("load", () => { window.loaded = Date.now(); });
window.mc = 0; const ch = new MessageChannel(); ch.port1.onmessage = () => { window.mc++; if (window.mc < 5) ch.port2.postMessage(0) }; ch.port2.postMessage(0);
window.timer = 0; setTimeout(() => { window.timer = Date.now() }, 0);
</script>`,
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
const say = (q, v) => console.log(`${q}: ${JSON.stringify(v)}`);
const realSleep = (ms) => new Promise((r) => setTimeout(r, ms));
const withTimeout = (p, ms, what) =>
  Promise.race([
    p,
    new Promise((_, rej) =>
      setTimeout(() => rej(new Error(`${what}: no answer in ${ms} ms`)), ms),
    ),
  ]);
const ev = async (expression) =>
  (
    await withTimeout(
      s.send("Runtime.evaluate", { expression, returnByValue: true }),
      3000,
      expression,
    )
  ).result.value;
let held = 0;
const grant = (budget) =>
  withTimeout(
    new Promise((resolve, reject) => {
      const t0 = performance.now();
      s.once("Emulation.virtualTimeBudgetExpired", () => {
        held += budget;
        resolve(performance.now() - t0);
      });
      s.send("Emulation.setVirtualTimePolicy", {
        policy: "advance",
        budget,
      }).catch(reject);
    }),
    5000,
    `grant ${budget}`,
  );
/** Grants frames until `expr` is truthy: the frames it took. */
const framesUntil = async (expr, max = 120) => {
  for (let n = 0; n <= max; n++) {
    let v;
    try {
      v = await ev(expr);
    } catch {
      v = undefined;
    }
    if (v) return n;
    await grant(FRAME);
  }
  return `not after ${max} frames`;
};
const net = [];
await s.send("Network.enable");
for (const e of [
  "requestWillBeSent",
  "responseReceived",
  "dataReceived",
  "eventSourceMessageReceived",
  "loadingFinished",
])
  s.on(`Network.${e}`, (p) =>
    net.push(`${e} ${p.request?.url ?? p.requestId}`),
  );

await s.send("Emulation.setVirtualTimePolicy", {
  policy: "pause",
  initialVirtualTime: PIN / 1000,
});

// Q3: load while paused, no grants.
await s.send("Page.navigate", { url: `http://127.0.0.1:${main.port}/plain` });
await realSleep(1500);
say(
  "Q3a plain page, paused, 1.5 s real, no grant",
  await ev(
    "({ready: document.readyState, t0: window.t0, href: location.href})",
  ),
);
say(
  "Q3b ... frames granted until complete",
  await framesUntil('document.readyState === "complete"'),
);
say("Q3b t0 - pin", (await ev("window.t0")) - PIN);

// Q1: budgets.
for (const b of [FRAME, 0.33, 1])
  say(
    `Q1 advance budget ${b} expired after real ms`,
    Math.round((await grant(b)) * 10) / 10,
  );
say("Q1 Date.now - pin vs held", {
  dNow: (await ev("Date.now()")) - PIN,
  held,
});

// Script parse and a parser-blocking slow script.
net.length = 0;
await s.send("Page.navigate", { url: `http://127.0.0.1:${main.port}/` });
await realSleep(1000);
say(
  "Q3c slow.js page, 1 s real, no grant",
  await ev(
    "({ready: document.readyState, t0: window.t0, slowRan: window.slowRan})",
  ),
);
say(
  "Q3c net after 1 s",
  net.map((l) => l.replace(/http:\/\/[^/]+/, "")),
);
const f = await (async () => {
  for (let n = 0; n < 60; n++) {
    if (await ev('document.readyState === "complete"')) return n;
    await grant(FRAME);
    await realSleep(30);
  }
  return "not in 60";
})();
say(
  "Q3c net after frames",
  net.map((l) => l.replace(/http:\/\/[^/]+/, "")),
);
say("Q3c frames until complete (slow.js already arrived)", {
  f,
  page: await ev(
    "({t0: window.t0 - " +
      PIN +
      ", loaded: window.loaded && window.loaded - " +
      PIN +
      ", mc: window.mc, timer: window.timer && window.timer - " +
      PIN +
      "})",
  ),
});

// A long task: does page time move while it runs?
const busy0 = Date.now();
await s.send("Page.navigate", { url: `http://127.0.0.1:${main.port}/busy` });
await realSleep(300);
await framesUntil("window.b !== undefined");
say(
  "long task (3e8 iterations, real ms " +
    (Date.now() - busy0) +
    "): Date.now moved inside it by",
  await ev("window.b - window.a"),
);

// In-page awaits while paused.
for (const [name, fn] of [
  ["rAF", "new Promise(r => requestAnimationFrame(() => r('raf')))"],
  [
    "2 rAFs",
    "new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => r('raf2'))))",
  ],
  ["setTimeout0", "new Promise(r => setTimeout(() => r('t'), 0))"],
  [
    "MessageChannel",
    "new Promise(r => { const c = new MessageChannel(); c.port1.onmessage = () => r('mc'); c.port2.postMessage(0); })",
  ],
  ["queueMicrotask", "new Promise(r => queueMicrotask(() => r('micro')))"],
]) {
  try {
    const v = await withTimeout(
      s.send("Runtime.evaluate", { expression: fn, awaitPromise: true }),
      1500,
      name,
    );
    say(`await ${name} while paused`, v.result.value);
  } catch (e) {
    say(`await ${name} while paused`, e.message);
  }
}
// Each pending one, after one grant.
for (const [name, fn] of [
  [
    "2 rAFs",
    "new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => r(Date.now()))))",
  ],
  [
    "MessageChannel",
    "new Promise(r => { const c = new MessageChannel(); c.port1.onmessage = () => r(Date.now()); c.port2.postMessage(0); })",
  ],
]) {
  const p = s.send("Runtime.evaluate", { expression: fn, awaitPromise: true });
  await grant(FRAME);
  try {
    say(
      `${name} after one grant: Date.now - pin - held`,
      (await withTimeout(p, 1500, name)).result.value - PIN - held,
    );
  } catch (e) {
    say(`${name} after one grant`, e.message);
  }
}

// Q4: streamed fetch and SSE, granting real time as the held clock does while waiting.
net.length = 0;
await s.send("Runtime.evaluate", {
  expression: `window.chunks = []; (async () => { const r = await fetch("/stream"); const rd = r.body.getReader(); for (;;) { const {done, value} = await rd.read(); if (done) break; window.chunks.push(Date.now()); } window.streamDone = true })();
  window.sse = []; const es = new EventSource("/sse"); es.onmessage = (e) => { window.sse.push(e.data); if (window.sse.length === 3) es.close(); };`,
});
await realSleep(1000);
say(
  "Q4 after 1 s real, no grant",
  await ev(
    "({chunks: window.chunks.length, done: !!window.streamDone, sse: window.sse.length})",
  ),
);
const g = await framesUntil("window.streamDone && window.sse.length === 3", 30);
say("Q4 frames granted until the stream and SSE were read", {
  g,
  page: await ev("({chunks: window.chunks.length, sse: window.sse})"),
});
say("Q4 network events", [
  ...new Set(
    net.map((l) =>
      l.replace(/http:\/\/[^/]+/, "").replace(/ [0-9.]+$/, " <id>"),
    ),
  ),
]);

// Q2a: rehold on a new document (same origin).
await grant(500);
await s.send("Emulation.setVirtualTimePolicy", {
  policy: "pause",
  initialVirtualTime: (PIN + held) / 1000,
});
await s.send("Page.navigate", { url: `http://127.0.0.1:${main.port}/plain` });
await realSleep(300);
const fr = await framesUntil("window.t0 !== undefined");
say("Q2a rehold, same origin: t0 - pin vs held at rehold", {
  t0: (await ev("window.t0")) - PIN,
  held,
  frames: fr,
});
// Without rehold.
const heldBefore = held;
await s.send("Page.navigate", { url: `http://127.0.0.1:${main.port}/plain` });
await realSleep(300);
const fr2 = await framesUntil("window.t0 !== undefined");
say("Q2a' no rehold, same origin: t0 - pin vs held", {
  t0: (await ev("window.t0")) - PIN,
  heldBefore,
  held,
  frames: fr2,
});

// Q2b: cross-site navigation (a new renderer), one CdpSession.
const events = [];
s.on("Inspector.detached", (e) => events.push(`detached ${e.reason}`));
s.on("Target.detachedFromTarget", () => events.push("detachedFromTarget"));
s.on(
  "Page.frameNavigated",
  (e) => !e.frame.parentId && events.push(`frameNavigated ${e.frame.url}`),
);
await s.send("Page.enable");
await s.send("Emulation.setVirtualTimePolicy", {
  policy: "pause",
  initialVirtualTime: (PIN + held) / 1000,
});
await s.send("Page.navigate", { url: `http://localhost:${other.port}/` });
await realSleep(500);
const fr3 = await framesUntil('document.getElementById("t")?.textContent');
const printed = Number(await ev('document.getElementById("t").textContent'));
say("Q2b cross-site, rehold before navigate: printed - pin vs held", {
  printed: printed - PIN,
  held,
  frames: fr3,
  events,
});
// Without rehold, cross-site.
await s.send("Page.navigate", { url: `http://127.0.0.1:${main.port}/plain` });
await realSleep(500);
const fr4 = await framesUntil("window.t0 !== undefined");
const held4 = held;
say("Q2b' cross-site back, no rehold: t0 - pin vs held", {
  t0: (await ev("window.t0")) - PIN,
  held: held4,
  frames: fr4,
});
say("Q2b grant after cross-site nav real ms", await grant(FRAME));

// Q4b: OOPIF and worker requests on the page session; OOPIF animations.
net.length = 0;
await s.send("Page.navigate", {
  url: `http://127.0.0.1:${main.port}/frame-page`,
});
await realSleep(500);
await framesUntil('document.readyState === "complete"');
await ev('new Worker("/worker.js"), 1');
await realSleep(300);
for (let i = 0; i < 10; i++) await grant(FRAME);
say(
  "Q4b requests the page session saw",
  net
    .filter((l) => l.startsWith("requestWillBeSent"))
    .map((l) => l.replace(/http:\/\/[^/]+/, "")),
);
const targets = (
  await s.send("Target.getTargets").catch((e) => ({ targetInfos: [e.message] }))
).targetInfos;
say(
  "Q4b targets",
  targets.map((t) => (typeof t === "string" ? t : `${t.type} ${t.url}`)),
);
await browser.close();
main.s.close();
other.s.close();

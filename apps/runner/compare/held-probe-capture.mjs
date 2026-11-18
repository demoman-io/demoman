// Probe: what does one frame's capture cost on a held page, by the way it is
// asked? The page changes before every capture, as a held frame's does.
// Prints one line per way: mean and median ms over 60 captures.
// Run: node apps/runner/compare/held-probe-capture.mjs
import { chromium } from "playwright";

const browser = await chromium.launch({
  headless: true,
  executablePath: chromium.executablePath(),
  args: (process.env.ARGS ?? "").split(";").filter(Boolean),
});
// NOVP: no viewport emulation by Playwright, as a recording with a display.
const first =
  process.env.PAGES === "before" ? await browser.newContext() : null;
if (first) await first.newPage();
const page = await (first ?? browser).newPage(
  process.env.NOVP
    ? { viewport: null }
    : {
        viewport: { width: 1280, height: 800 },
        deviceScaleFactor: Number(process.env.SCALE ?? 1),
      },
);
// RAF: the page's requestAnimationFrame only queues, as HELD_FRAMES_SCRIPT's.
if (process.env.RAF)
  await page.addInitScript(() => {
    const q = [];
    window.requestAnimationFrame = (f) => q.push(f);
    window.__flush = (t) => {
      for (const f of q.splice(0)) f(t);
    };
  });
if (process.env.RAF) await page.goto("about:blank");
// PAGES: other pages in the browser, as an executor's (its launch page, a
// page per call): "before" opens one before the captured page was made is
// not possible here, so "after" opens one after it, "other" in a context of
// its own.
if (process.env.PAGES === "after") await page.context().newPage();
if (process.env.PAGES === "other") await (await browser.newContext()).newPage();
const s = await page.context().newCDPSession(page);
if (process.env.URL) await page.goto(process.env.URL);
else
  await page.setContent(
    "<body style='margin:0;font:16px monospace'><p id=n>0</p><div id=b style='width:80px;height:80px;background:#c00;position:absolute;top:100px'></div>",
  );
// What a recording adds, one env switch each: ANIM (an endless CSS animation
// on the page, pinned before each capture as PIN_ANIMATIONS does), TALL (a
// 3200 px striped page), METRICS (the device metrics override), FOCUS (focus
// emulation and the active lifecycle state).
const on = (k) => Boolean(process.env[k]);
if (on("ANIM"))
  await page.evaluate(() => {
    const st = document.createElement("style");
    st.textContent =
      "@keyframes s{to{transform:rotate(360deg)}}#sp{position:absolute;left:300px;top:300px;width:60px;height:60px;background:linear-gradient(90deg,#c00,#00c);animation:s 1s linear infinite}";
    document.head.append(st);
    const d = document.createElement("div");
    d.id = "sp";
    document.body.append(d);
  });
if (on("TALL"))
  await page.evaluate(() => {
    document.body.style.height = "3200px";
    document.body.style.background =
      "repeating-linear-gradient(#000 0 20px,#fff 20px 37px)";
  });
if (on("METRICS"))
  await s.send("Emulation.setDeviceMetricsOverride", {
    width: 1280,
    height: 800,
    deviceScaleFactor: Number(process.env.SCALE ?? 1),
    mobile: false,
  });
// LOOP: a requestAnimationFrame loop on Chrome's own frames, as a
// heartbeat of the walk's would be.
if (on("LOOP"))
  await page.evaluate(() => {
    const f = () => requestAnimationFrame(f);
    f();
  });
if (on("FOCUS")) {
  await s.send("Page.setWebLifecycleState", { state: "active" });
  await s.send("Emulation.setFocusEmulationEnabled", { enabled: true });
}
// ENABLES: the domains a recording turns on.
if (on("ENABLES")) {
  for (const d of ["Network", "Page", "DOM", "Runtime"])
    await s.send(`${d}.enable`);
  await s.send("Target.setAutoAttach", {
    autoAttach: true,
    waitForDebuggerOnStart: false,
    flatten: true,
  });
  await s.send("Target.setDiscoverTargets", { discover: true });
}
await s.send("Emulation.setVirtualTimePolicy", {
  policy: "pause",
  ...(process.env.INITIAL ? { initialVirtualTime: Date.now() / 1000 } : {}),
});
let n = 0;
// GRANT=1: a frame of page time is granted before each change, as the held
// clock does (advance with a budget, then pause).
const epoch = Date.now();
let held = 0;
const grant = async () => {
  const expired = new Promise((r) =>
    s.once("Emulation.virtualTimeBudgetExpired", r),
  );
  await s.send("Emulation.setVirtualTimePolicy", {
    policy: "advance",
    budget: 1000 / 30,
  });
  await expired;
  // INITIAL: the pause names the page's time, as the held clock's does.
  held += 1000 / 30;
  await s.send("Emulation.setVirtualTimePolicy", {
    policy: "pause",
    ...(process.env.INITIAL
      ? { initialVirtualTime: (epoch + held) / 1000 }
      : {}),
  });
};
const change = async () => {
  if (process.env.GRANT) await grant();
  await s.send("Runtime.evaluate", {
    expression: `n.textContent = ${++n}; b.style.left = '${(n * 7) % 900}px'`,
  });
  if (on("ANIM"))
    await s.send("Runtime.evaluate", {
      expression: `for (const a of document.getAnimations()) { a.pause(); a.currentTime = ${n} * 1000 / 30; }`,
    });
};
const time = async (name, shot, changing = true) => {
  const ms = [];
  for (let i = 0; i < 60; i++) {
    if (changing) await change();
    const t = performance.now();
    await shot();
    ms.push(performance.now() - t);
  }
  ms.sort((a, b) => a - b);
  const mean = ms.reduce((a, b) => a + b, 0) / ms.length;
  console.log(
    `${name}: mean ${mean.toFixed(1)} ms, median ${ms[30].toFixed(1)} ms`,
  );
};
const shot = (extra) => () =>
  s.send("Page.captureScreenshot", {
    format: "jpeg",
    quality: Number(process.env.Q ?? 80),
    ...extra,
  });
await time("jpeg, as the held clock asks", shot({}));
await time("jpeg, page unchanged between captures", shot({}), false);
if (process.env.QUICK) {
  await browser.close();
  process.exit(0);
}
await time("jpeg, optimizeForSpeed", shot({ optimizeForSpeed: true }));
await time("jpeg, fromSurface false", shot({ fromSurface: false }));
await time("png", () => s.send("Page.captureScreenshot", { format: "png" }));
await time(
  "jpeg, a 100x100 clip",
  shot({ clip: { x: 0, y: 0, width: 100, height: 100, scale: 1 } }),
);
// A screencast: Chrome pushes a frame when the page's picture changes.
let got = null;
s.on("Page.screencastFrame", (f) => {
  s.send("Page.screencastFrameAck", { sessionId: f.sessionId }).catch(() => {});
  got?.();
});
await s.send("Page.startScreencast", { format: "jpeg", quality: 80 });
await new Promise((r) => setTimeout(r, 500));
await time("screencast frame after a change", async () => {
  await Promise.race([
    new Promise((r) => {
      got = r;
    }),
    new Promise((r) => setTimeout(r, 2000)),
  ]);
});
await browser.close();

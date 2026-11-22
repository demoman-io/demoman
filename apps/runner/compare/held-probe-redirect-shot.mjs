// Held-clock probe (2026-11-21, DEM-237): a held screenshot just after a
// redirect to a sign-in page, on a page reused from an earlier recording.
//   node apps/runner/compare/held-probe-redirect-shot.mjs [rounds=20]
// CI stopped there with "its screenshot went unanswered, though the page
// answered a second read". Each round does what a held run does on a reused
// page: release it (advance, about:blank), hold it again, open /app (a 302
// to /login), then grant a frame and screenshot, frame by frame. A hung
// screenshot is read again, then given one more frame and shot again: the
// clock's retake. Under CI-like load: `taskpolicy -c background` with six
// `yes` burners (PR #108).
// The last line answers: "hung N of M rounds; retake answered K of N".
import { createServer } from "node:http";
import { chromium } from "playwright";

const ROUNDS = Number(process.argv[2] ?? 20);
const FRAME = 1000 / 30;
const FRAMES = 12;
const SHOT_MS = 5000;

const server = createServer((req, res) => {
  if (req.url === "/app") {
    res.writeHead(302, { location: "/login?return_to=%2Fapp" });
    return res.end();
  }
  res.writeHead(200, { "content-type": "text/html" });
  res.end(
    `<!doctype html><title>Sign in</title><h1>Sign in</h1><form method=post action=/login><input name=email><input name=password type=password><button>Sign in</button></form>`,
  );
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;

const browser = await chromium.launch({
  args: [
    "--disable-threaded-animation",
    "--disable-threaded-scrolling",
    "--run-all-compositor-stages-before-draw",
    "--disable-smooth-scrolling",
  ],
});
const page = await browser.newPage({ viewport: { width: 1024, height: 640 } });
const cdp = await page.context().newCDPSession(page);

const within = (p, ms) =>
  Promise.race([
    p.then(
      (v) => ({ v }),
      (e) => ({ e: e.message }),
    ),
    new Promise((r) => setTimeout(() => r({ silent: true }), ms)),
  ]);
let held = 0;
let epoch = 0;
const grant = async (to) => {
  const expired = new Promise((r) =>
    cdp.once("Emulation.virtualTimeBudgetExpired", r),
  );
  await cdp.send("Emulation.setVirtualTimePolicy", {
    policy: "advance",
    budget: to - held,
  });
  const got = await within(expired, 15_000);
  if (got.silent) throw new Error(`grant to ${to.toFixed(1)} never expired`);
  held = to;
  await cdp.send("Emulation.setVirtualTimePolicy", {
    policy: "pause",
    initialVirtualTime: (epoch + held) / 1000,
  });
};
const shot = () =>
  within(
    cdp.send("Page.captureScreenshot", { format: "jpeg", quality: 80 }),
    SHOT_MS,
  );
const read = () =>
  within(
    cdp.send("Runtime.evaluate", {
      expression: "[location.pathname, document.readyState]",
      returnByValue: true,
    }),
    1000,
  );

let hung = 0;
let retook = 0;
for (let round = 1; round <= ROUNDS; round++) {
  // Released, as the run before left it.
  await cdp.send("Emulation.setVirtualTimePolicy", { policy: "advance" });
  await page.goto("about:blank");
  epoch = Date.now();
  held = 0;
  await cdp.send("Emulation.setVirtualTimePolicy", {
    policy: "pause",
    initialVirtualTime: epoch / 1000,
  });
  void cdp.send("Page.navigate", { url: `${base}/app` }).catch(() => {});
  let line = `round ${round}: ok`;
  for (let f = 1; f <= FRAMES; f++) {
    await grant(f * FRAME);
    const s = await shot();
    if (!s.silent) continue;
    hung++;
    const second = await read();
    const said = second.silent
      ? "no second read"
      : JSON.stringify(second.v?.result?.value ?? second.e);
    await grant((f + 1) * FRAME);
    const again = await shot();
    if (!again.silent) retook++;
    line = `round ${round}: screenshot hung at ${Math.round(f * FRAME)} ms; second read ${said}; retake a frame later ${again.silent ? "hung too" : "answered"}`;
    break;
  }
  console.log(line);
}
console.log(
  `hung ${hung} of ${ROUNDS} rounds; retake answered ${retook} of ${hung}`,
);
await browser.close();
server.close();

// Held-clock probe (2026-11-24): does Chrome's paint holding hang
// a held screenshot after a same-origin navigation?
//   node apps/runner/compare/held-probe-paint-holding.mjs [rounds=10] [holding|noholding]
// Both CI stops came early in a navigation on a page that answered script
// reads with nothing open: 33 ms into a redirect's sign-in page, and 533 ms
// into Nylon's /invoices on a page reused from the flow before it, same
// origin. Paint holding defers a same-origin navigation's first commit
// until the new document paints content, or a timeout. A screenshot waits
// for a commit. Each round: a page on /a, the clock held, a navigation to
// /b whose content appears only after DELAY ms of page time, then a frame
// granted and a screenshot taken, frame by frame, as a held run does.
// "noholding" launches with --disable-features=PaintHolding.
// The last line answers: "hung N of M rounds (holding|noholding)".
import { createServer } from "node:http";
import { chromium } from "playwright";

const ROUNDS = Number(process.argv[2] ?? 10);
const MODE = process.argv[3] ?? "holding";
const FRAME = 1000 / 30;
const DELAY = 1500;
const FRAMES = Math.ceil((DELAY + 500) / FRAME);
// The held clock's own wait before it calls a read unanswered
// (GRANT_EXPIRY_TIMEOUT_MS): a slower answer is not a hang to it.
const SHOT_MS = 15_000;

const server = createServer((req, res) => {
  res.writeHead(200, { "content-type": "text/html" });
  if (req.url?.startsWith("/b")) {
    // Nothing to paint until DELAY ms of page time: no first contentful
    // paint, so paint holding has nothing to release it but its timeout.
    return res.end(
      `<!doctype html><title>B</title><body><script>setTimeout(() => { document.body.innerHTML = "<h1>Invoices</h1><p>loaded</p>"; }, ${DELAY});</script></body>`,
    );
  }
  res.end(`<!doctype html><title>A</title><h1>Filter invoices</h1><p>a</p>`);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;

const browser = await chromium.launch({
  args: [
    "--disable-threaded-animation",
    "--disable-threaded-scrolling",
    "--run-all-compositor-stages-before-draw",
    "--disable-smooth-scrolling",
    ...(MODE === "noholding" ? ["--disable-features=PaintHolding"] : []),
  ],
});
// Each round on a page of its own: a capture left pending by a hung round
// is not queued in front of the next.
let page;
let cdp;

const within = (p, ms) => {
  let timer;
  return Promise.race([
    p.then(
      (v) => ({ v }),
      (e) => ({ e: e.message }),
    ),
    new Promise((r) => {
      timer = setTimeout(() => r({ silent: true }), ms);
    }),
  ]).finally(() => clearTimeout(timer));
};
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
let refused = 0;
let failed = 0;
try {
  for (let round = 1; round <= ROUNDS; round++) {
    await page?.close();
    page = await browser.newPage({ viewport: { width: 1024, height: 640 } });
    cdp = await page.context().newCDPSession(page);
    try {
      // On /a, released, as the flow before left it.
      await cdp.send("Emulation.setVirtualTimePolicy", { policy: "advance" });
      await page.goto(`${base}/a`);
      epoch = Date.now();
      held = 0;
      await cdp.send("Emulation.setVirtualTimePolicy", {
        policy: "pause",
        initialVirtualTime: epoch / 1000,
      });
      // Said if refused: a round that never navigated is not one where
      // paint holding did not hang.
      let navigated = "sent";
      cdp.send("Page.navigate", { url: `${base}/b?r=${round}` }).then(
        (r) => {
          navigated = r?.errorText ? `refused (${r.errorText})` : "answered";
        },
        (e) => {
          navigated = `refused (${e.message})`;
        },
      );
      let line = `round ${round}: every screenshot answered`;
      const sizes = [];
      for (let f = 1; f <= FRAMES; f++) {
        await grant(f * FRAME);
        const s = await shot();
        // A refused capture (the "Unable to capture screenshot" error) is
        // neither an answer nor a hang.
        if (s.e !== undefined) {
          refused++;
          line = `round ${round}: screenshot refused at ${Math.round(f * FRAME)} ms of page time (${s.e})`;
          break;
        }
        if (!s.silent) {
          sizes.push(String(s.v?.data ?? "").length);
          continue;
        }
        hung++;
        const second = await read();
        const said = second.silent
          ? "no second read"
          : JSON.stringify(second.v?.result?.value ?? second.e);
        line = `round ${round}: screenshot hung at ${Math.round(f * FRAME)} ms of page time; second read ${said}`;
        break;
      }
      // What the frames showed: /a's picture held over the navigation (holding
      // engaged) is larger than /b's blank page; /b's content at the end.
      const where = await read();
      console.log(
        `${line}; navigate ${navigated}, ended on ${JSON.stringify(where.v?.result?.value ?? where.e ?? "no answer")}; shot sizes first ${sizes[0]}, frame 6 ${sizes[5]}, last ${sizes.at(-1)}`,
      );
    } catch (e) {
      failed++;
      console.log(`round ${round}: failed (${e.message})`);
    }
  }
} finally {
  console.log(
    `hung ${hung} of ${ROUNDS} rounds (${MODE}); ${refused} refused; ${failed} failed`,
  );
  await browser.close();
  server.close();
}

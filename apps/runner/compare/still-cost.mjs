// What one of the walk's stills costs at each scale: the measurement behind
// `stillsDprFor` in apps/runner/src/launch.ts (DEM-75).
//   node apps/runner/compare/still-cost.mjs --repo <root> [--rounds 3]
// Launches the browser the CLI records with (<root>'s built `launch()` and
// full Chromium, the same flags), opens a page shaped like a shadcn app (a
// long table, with a dialog over a blurred overlay or without it), asserts
// the walk's metrics override (`desktopMetrics`) at 1, 2 and 3, and times the
// full JPEG still the walk takes at each step, with a screencast running as
// the walk keeps one. One line per case. A still makes the browser draw the
// whole page again at the emulated scale, on the CPU where there is no GPU.
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

const say = (line) => console.info(`[still-cost] ${line}`);
const { values } = parseArgs({
  options: {
    repo: { type: "string" },
    rounds: { type: "string", default: "3" },
  },
});
if (!values.repo) {
  say("usage: still-cost.mjs --repo <root> [--rounds 3]");
  process.exit(2);
}
const rounds = Number(values.rounds);
const dist = (p) =>
  import(join(resolve(values.repo), "apps", "runner", "dist", p));
const { launch, HEADLESS_GPU_ARGS, stillsDprFor } = await dist("launch.js");
// The full Chromium the CLI launches, not Playwright's headless shell, which
// a launch picks when it names no executable and which draws differently.
const { fullChromiumPath } = await dist("executor/browser.js");
const { desktopMetrics } = await import(
  join(resolve(values.repo), "packages", "replay-engine", "dist", "index.js")
);

const VIEWPORT = { width: 1710, height: 1107 };
const rows = Array.from(
  { length: 60 },
  (_, i) =>
    `<tr><td>INV-${1048 - i}</td><td>Customer ${i}</td><td>Sent</td><td>$${(i + 1) * 120}.00</td></tr>`,
).join("");
// `?blur=0` leaves the overlay's blur out.
const page = (blur) => `<!doctype html><meta charset="utf-8">
<style>
  body { margin: 0; font: 14px system-ui, sans-serif; }
  table { width: 100%; border-collapse: collapse; } td { padding: 14px; border-bottom: 1px solid #e4e4e7; }
  .overlay { position: fixed; inset: 0; background: rgb(0 0 0 / .1); ${blur ? "backdrop-filter: blur(4px);" : ""} }
  .dialog { position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%); width: 520px; padding: 24px;
    background: #fff; border-radius: 12px; box-shadow: 0 16px 48px rgb(0 0 0 / .18); }
</style>
<table>${rows}</table>
<div class="overlay"></div><div class="dialog">New invoice</div>`;
const server = createServer((req, res) => {
  const blur = new URL(req.url, "http://x").searchParams.get("blur") !== "0";
  res.writeHead(200, { "content-type": "text/html" });
  res.end(page(blur));
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}/`;

const median = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
const executablePath = fullChromiumPath();
say(
  `platform ${process.platform}, browser ${executablePath}, launch args [${HEADLESS_GPU_ARGS.join(" ")}], stillsDprFor answers ${stillsDprFor(process.platform, true)} headless`,
);
const { browser } = await launch({ executablePath });
let failed = false;
try {
  for (const dpr of [1, 2, 3]) {
    for (const blur of [true, false]) {
      const context = await browser.newContext({ viewport: VIEWPORT });
      const tab = await context.newPage();
      const cdp = await context.newCDPSession(tab);
      cdp.on("Page.screencastFrame", (f) => {
        cdp
          .send("Page.screencastFrameAck", { sessionId: f.sessionId })
          .catch(() => {});
      });
      await cdp.send(
        "Emulation.setDeviceMetricsOverride",
        desktopMetrics(VIEWPORT, dpr),
      );
      await tab.goto(base + (blur ? "" : "?blur=0"), { waitUntil: "load" });
      await cdp.send("Page.startScreencast", {
        format: "jpeg",
        quality: 80,
        everyNthFrame: 1,
      });
      await tab.waitForTimeout(500);
      // Premise: the override took, so the time below is at this scale.
      const seen = await tab.evaluate(() => devicePixelRatio);
      if (seen !== dpr) failed = true;
      const times = [];
      for (let i = 0; i < rounds; i++) {
        const t = performance.now();
        await cdp.send("Page.captureScreenshot", {
          format: "jpeg",
          quality: 90,
        });
        times.push(performance.now() - t);
      }
      say(
        `${dpr}x, ${blur ? "blurred overlay" : "overlay without blur"}: still median ${Math.round(median(times))} ms (max ${Math.round(Math.max(...times))}); devicePixelRatio ${seen}`,
      );
      await context.close();
    }
  }
} finally {
  await browser.close();
  server.close();
}
if (failed) {
  say(
    "a page did not take the scale it was emulated at: the probe's own premise failed",
  );
  process.exit(1);
}

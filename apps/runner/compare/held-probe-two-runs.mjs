// Probe: does a second call on the same browser stall after a held
// recording left its page paused? Records one script three times on one
// executor (as a refresh of several flows does) and prints each call's
// real seconds and what the executor logged.
// Run: DEMOMAN_HELD_CLOCK=1 node apps/runner/compare/held-probe-two-runs.mjs
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

const here = import.meta.dirname;
const dist = (p) => import(join(here, "..", "dist", p));
const { createLocalExecutor } = await dist("executor/executor.js");
const { fullChromiumPath } = await dist("executor/browser.js");

const server = createServer((_q, res) => {
  res.writeHead(200, { "content-type": "text/html" });
  res.end(
    '<!doctype html><link rel=icon href="data:,"><button id=go style="position:absolute;left:40px;top:40px;width:160px;height:40px">Go</button>',
  );
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const target = `http://127.0.0.1:${server.address().port}/`;
const home = mkdtempSync(join(tmpdir(), "held-two-runs-"));
const lines = [];
const executor = createLocalExecutor({
  home,
  env: { ...process.env, DEMOMAN_DISPLAY: "1280x800@1" },
  outDir: join(home, "out"),
  headless: true,
  standInDisplay: true,
  executablePath: fullChromiumPath(),
  wallpapersDir: join(
    here,
    "..",
    "..",
    "studio",
    "pages",
    "public",
    "wallpapers",
  ),
  log: (l) => lines.push(l),
});
try {
  for (let i = 1; i <= 3; i++) {
    const t = Date.now();
    const from = lines.length;
    const run = await executor
      .request("run", {
        script: {
          scriptVersion: 8,
          name: `two-${i}`,
          target,
          viewport: { width: 1280, height: 800 },
          steps: [
            { do: "click", on: { stableId: "go" }, zoom: false },
            { do: "pause", ms: 500 },
          ],
        },
        video: { new: `two-${i}`, confirmedNew: true },
        callId: `two-runs-${i}`,
      })
      .catch((error) => ({ ok: false, threw: String(error) }));
    const value = run.ok ? run.value : run;
    console.log(
      `call ${i}: ${((Date.now() - t) / 1000).toFixed(1)} s, ${value.outcome ?? JSON.stringify(value).slice(0, 200)}, clock ${value.run?.recording?.clock ?? "?"}`,
    );
    for (const l of lines.slice(from)) console.log(`  log: ${l.slice(0, 200)}`);
    console.log(`  still: ${JSON.stringify(value.still).slice(0, 160)}`);
  }
} finally {
  await executor.close().catch(() => {});
  rmSync(home, { recursive: true, force: true });
  server.close();
}

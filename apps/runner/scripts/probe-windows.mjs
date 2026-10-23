// apps/runner/scripts/probe-windows.mjs
// `node apps/runner/scripts/probe-windows.mjs` (after `pnpm -r build`).
// The checked-in answer to two questions about the CLI's headed window
// (CLI executor plan 2, Task 5): does each call's stage window fill the
// screen (parked R12), and which work-window mode renders an export fastest?
// One line per fact:
//   window: call N WxH STATE  (screen AWxAH)
//   work: MODE export N.N s (R.RRx the tab)
//   pick: MODE — <the rule's reason>
// Headed: it opens Chrome windows on this display, and runs a short local
// page three times. Run it attended.

import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBrowserSession } from "../dist/executor/browser.js";
import { createLocalExecutor } from "../dist/index.js";

const page = `<!doctype html><title>probe</title><body style="font:20px system-ui">
<button id="go" onclick="this.textContent='Done'">Go</button>
<p id="p" style="margin-top:900px">Below</p></body>`;
const http = createServer((_q, res) => {
  res.setHeader("content-type", "text/html");
  res.end(page);
});
await new Promise((r) => http.listen(0, "127.0.0.1", r));
const url = `http://127.0.0.1:${http.address().port}/`;
const log = (l) => console.info(`  (${l})`);

// R12: three calls, three stage pages.
const session = createBrowserSession({ headless: false, log });
for (let i = 1; i <= 3; i++) {
  const s = await session.stage();
  if (!s.ok) {
    console.info(`window: call ${i} failed — ${s.detail}`);
    continue;
  }
  const { bounds } = await s.stage.cdp.send("Browser.getWindowForTarget", {});
  const screen = await s.stage.page.evaluate(() => [
    screen.availWidth,
    screen.availHeight,
  ]);
  console.info(
    `window: call ${i} ${bounds.width}x${bounds.height} ${bounds.windowState}  (screen ${screen[0]}x${screen[1]})`,
  );
}
await session.close();

// Work window: the same run + export per mode, timed.
const script = {
  scriptVersion: 1,
  name: "window probe",
  target: url,
  steps: [
    { do: "waitForLoad" },
    { do: "click", on: { stableId: "go" } },
    { do: "scrollTo", on: { stableId: "p" } },
  ],
};
const times = {};
for (const mode of ["tab", "background", "minimized"]) {
  const home = mkdtempSync(join(tmpdir(), "probe-windows-"));
  const ex = createLocalExecutor({
    home,
    headless: false,
    log,
    workWindow: mode,
    outDir: join(home, "out"),
  });
  try {
    const run = await ex.request("run", { script, callId: `r-${mode}` });
    const takeId = run.ok ? run.value?.provenance?.takeId : null;
    if (!takeId) {
      console.info(
        `work: ${mode} run failed — ${JSON.stringify(run).slice(0, 300)}`,
      );
      continue;
    }
    const t0 = Date.now();
    const exp = await ex.request("export", { takeId, callId: `e-${mode}` });
    const s = (Date.now() - t0) / 1000;
    if (!exp.ok || exp.value.outcome !== "saved") {
      console.info(
        `work: ${mode} export failed — ${JSON.stringify(exp).slice(0, 300)}`,
      );
      continue;
    }
    times[mode] = s;
  } finally {
    await ex.close();
    rmSync(home, { recursive: true, force: true });
  }
}
for (const [mode, s] of Object.entries(times)) {
  console.info(
    `work: ${mode} export ${s.toFixed(1)} s (${(s / times.tab).toFixed(2)}x the tab)`,
  );
}
const within = (m) =>
  times[m] !== undefined &&
  times.tab !== undefined &&
  times[m] <= times.tab * 1.5;
const pick = within("minimized")
  ? "minimized"
  : within("background")
    ? "background"
    : "tab";
console.info(
  `pick: ${pick} — ${pick === "tab" ? "no window mode rendered within 1.5x of a tab" : `renders within 1.5x of a tab and keeps the author's view`}`,
);
http.close();

#!/usr/bin/env node
// held-clock.sh's two halves (README, "Held clock on a house app").
//
//   node held-clock.mjs record --app <checkout> --out <dir> [flow…]
//     records each kept flow of <checkout>/.demoman/flows once with this
//     checkout's built runner, held or not as DEMOMAN_HELD_CLOCK says,
//     exports it, and writes <dir>/<flow>.json and <dir>/<flow>.mp4.
//   node held-clock.mjs compare <held-1 dir> <held-2 dir> <real dir>
//     prints one table row per flow.
//   node held-clock.mjs trial --app <checkout> --out <dir> [--rounds 3] [flow…]
//     a refresh trial that writes nothing in the checkout (house-trial.sh
//     commits a baseline there): a baseline and <rounds> recordings per
//     flow, each judged against the baseline's page screens by refresh's
//     own `sameScreens`; one verdict line each, then the count unchanged.
//     BASELINE=real records the baseline in real time whatever the rounds are.
//
// Each recording gets a throwaway home and is a refresh's own run (`project`
// the checkout, `leaveKept`): nothing in the checkout is written. The app's
// `reset` (app.json, or RESET) runs before each flow. The app must already
// be serving.
import { execFileSync, spawnSync } from "node:child_process";
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { parseArgs } from "node:util";

const say = (line) => console.error(`[held-clock] ${line}`);
const here = import.meta.dirname;
const dist = (p) => import(join(here, "..", "dist", p));
/** One video frame of page time (`HELD_FRAME_MS`). */
const FRAME_MS = 1000 / 30;
/** Grey levels a decoded frame may differ by and be the same frame: the
 *  spans are GPU-encoded (`NOISE`, test/held-record.ts). */
const NOISE = 8;

const [mode, ...rest] = process.argv.slice(2);
if (mode === "record") await record(rest);
else if (mode === "compare") compare(rest);
else if (mode === "trial") await trial(rest);
else {
  say("usage: held-clock.mjs record --app <checkout> --out <dir> [flow…]");
  say(
    "       held-clock.mjs trial --app <checkout> --out <dir> [--rounds 3] [flow…]",
  );
  say("       held-clock.mjs compare <held-1 dir> <held-2 dir> <real dir>");
  process.exit(2);
}

/** The app, its flows and the runner's pieces both modes use. */
async function setUp(args, extra = {}) {
  const { values, positionals } = parseArgs({
    args,
    options: { app: { type: "string" }, out: { type: "string" }, ...extra },
    allowPositionals: true,
  });
  if (!values.app || !values.out) {
    say("needs --app <checkout> and --out <dir>");
    process.exit(2);
  }
  const app = resolve(values.app);
  const out = resolve(values.out);
  mkdirSync(out, { recursive: true });
  const { createLocalExecutor } = await dist("executor/executor.js");
  const { fullChromiumPath } = await dist("executor/browser.js");
  const appJson = JSON.parse(
    readFileSync(join(app, ".demoman", "app.json"), "utf8"),
  );
  const reset = process.env.RESET ?? appJson.reset ?? null;
  const flowsDir = join(app, ".demoman", "flows");
  const names = positionals.length
    ? positionals
    : readdirSync(flowsDir).map((f) => basename(f, ".json"));
  const keptOf = (name) =>
    JSON.parse(readFileSync(join(flowsDir, `${name}.json`), "utf8"));
  /** Resets the app, then runs the flow as refresh does, in a throwaway
   *  home; the caller closes the executor and removes the home. */
  async function runFlow(name, kept, logFile) {
    if (reset !== null) {
      const r = spawnSync("sh", ["-c", reset], { cwd: app, encoding: "utf8" });
      if (r.status !== 0)
        throw new Error(`reset failed: ${r.stderr || r.stdout}`);
    }
    // A device recording names no viewport: the display a test stands in.
    const { width, height } = kept.script.viewport ?? {
      width: 1440,
      height: 900,
    };
    const home = mkdtempSync(join(tmpdir(), "held-clock-home-"));
    const lines = [];
    writeFileSync(logFile, "");
    const started = Date.now();
    const executor = createLocalExecutor({
      home,
      env: {
        ...process.env,
        DEMOMAN_DISPLAY: `${width}x${height}@${kept.scale}`,
      },
      projectDir: app,
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
      log: (l) => {
        lines.push(l);
        appendFileSync(
          logFile,
          `${((Date.now() - started) / 1000).toFixed(1)} ${l}\n`,
        );
      },
    });
    const t0 = Date.now();
    const run = await executor
      .request("run", {
        script: kept.script,
        // The kept flow by its id, as refresh runs it: the throwaway library
        // adopts it. A fixture's flow (no id) is a new one.
        video: kept.flow
          ? { id: kept.flow }
          : { new: name, confirmedNew: true },
        project: app,
        leaveKept: true,
        readDates: true,
        callId: `held-clock-run-${name}`,
      })
      .catch((error) => ({ ok: false, threw: String(error) }));
    const value = run.ok ? run.value : run;
    return {
      executor,
      home,
      lines,
      value,
      takeId: value.provenance?.takeId,
      recordMs: Date.now() - t0,
    };
  }
  return { values, app, out, names, keptOf, runFlow };
}

async function record(args) {
  const { out, names, keptOf, runFlow } = await setUp(args);
  const { createLibrary } = await dist("executor/library.js");
  if (Number(process.env.LAG_MS) > 0) await lagCdp(Number(process.env.LAG_MS));
  let failed = false;
  for (const name of names) {
    const kept = keptOf(name);
    let ran = null;
    try {
      ran = await runFlow(name, kept, join(out, `${name}.log`));
      const { executor, lines, value, takeId, recordMs } = ran;
      if (value.outcome !== "complete" || typeof takeId !== "string") {
        // Said, not hidden: a flow that could not be recorded is a result.
        writeFileSync(
          join(out, `${name}.json`),
          JSON.stringify(
            { name, recordMs, failed: value, log: lines.slice(-40) },
            null,
            1,
          ),
        );
        say(
          `${name}: ${value.outcome}: ${JSON.stringify(value.stopped ?? value).slice(0, 400)}`,
        );
        failed = true;
        continue;
      }
      const o = kept.outputs[0];
      const exp = await executor.request("export", {
        takeId,
        fileType: "mp4",
        aspect: o.aspect,
        quality: o.quality,
        unlisted: true,
        callId: `held-clock-export-${name}`,
      });
      const saved = exp.ok ? exp.value : exp;
      let mp4 = null;
      if (saved.outcome === "saved") {
        mp4 = join(out, `${name}.mp4`);
        copyFileSync(saved.file.path, mp4);
      } else
        say(
          `${name}: export ${saved.outcome}: ${JSON.stringify(saved).slice(0, 400)}`,
        );
      const library = createLibrary(ran.home);
      const report = JSON.parse(
        readFileSync(join(library.takeDir(takeId), "report.json"), "utf8"),
      );
      const store = library.frameStore(takeId);
      const bundle = await store.getBundle(takeId);
      const held = report.run?.recording?.clock === "held";
      // The page's frames as grey, for compare's frame-by-frame check of
      // two held runs (pixels on one machine only).
      const frames = held ? await framesOf(bundle, store) : null;
      if (frames !== null)
        writeFileSync(
          join(out, `${name}.grey`),
          Buffer.concat(frames.map((f) => f.grey)),
        );
      writeFileSync(
        join(out, `${name}.json`),
        JSON.stringify(
          {
            name,
            recordMs,
            videoMs: mp4 === null ? null : durationMs(mp4),
            mp4,
            recording: report.run?.recording ?? null,
            degradations: bundle.degradations,
            networkMs: report.video?.networkMs ?? null,
            connectionsIgnored: report.video?.connectionsIgnored ?? null,
            network: (bundle.networkSpans ?? []).map((s) => ({
              label: s.label,
              ms: Math.round(s.endMs - s.startMs),
              startMs: s.startMs,
              endMs: s.endMs,
            })),
            timing: frames === null ? null : timingOf(bundle, frames),
          },
          null,
          1,
        ),
      );
      say(`${name}: recorded in ${recordMs} ms (${held ? "held" : "real"})`);
    } catch (error) {
      failed = true;
      say(
        `${name} threw: ${error instanceof Error ? error.stack : String(error)}`,
      );
    } finally {
      await ran?.executor.close().catch((e) => say(`close failed (${e})`));
      if (ran) rmSync(ran.home, { recursive: true, force: true });
    }
  }
  process.exit(failed ? 1 : 0);
}

/** Refresh's verdict without its delivery: per flow a baseline, then
 *  `--rounds` recordings, each judged against the baseline's page screens
 *  by refresh's own `sameScreens`. */
async function trial(args) {
  const { values, out, names, keptOf, runFlow } = await setUp(args, {
    rounds: { type: "string" },
  });
  const rounds = Number(values.rounds ?? 3);
  const { createBrowserSession, fullChromiumPath } = await dist(
    "executor/browser.js",
  );
  const { sameScreens } = await dist("executor/same-picture.js");
  // Decodes the screens to compare them, as refresh's own session does.
  const session = createBrowserSession({
    headless: true,
    executablePath: fullChromiumPath(),
    log: () => {},
  });
  let unchanged = 0;
  let judged = 0;
  try {
    for (const name of names) {
      const kept = keptOf(name);
      let base = null;
      for (let r = 0; r <= rounds; r++) {
        const tag = r === 0 ? "baseline" : `round ${r}`;
        const dir = join(out, name, r === 0 ? "baseline" : `round-${r}`);
        mkdirSync(dir, { recursive: true });
        let ran = null;
        try {
          // BASELINE=real: the baseline in real time, the rounds as the
          // environment says: the first refresh after held capture goes on.
          const asked = process.env.DEMOMAN_HELD_CLOCK;
          if (r === 0 && process.env.BASELINE === "real")
            delete process.env.DEMOMAN_HELD_CLOCK;
          try {
            ran = await runFlow(name, kept, join(dir, "run.log"));
          } finally {
            if (asked !== undefined) process.env.DEMOMAN_HELD_CLOCK = asked;
          }
          if (
            ran.value.outcome !== "complete" ||
            typeof ran.takeId !== "string"
          ) {
            console.log(
              `${tag}: ${name}: failed: ${JSON.stringify(ran.value.stopped ?? ran.value).slice(0, 300)}`,
            );
            continue;
          }
          const o = kept.outputs[0];
          const exp = await ran.executor.request("export", {
            takeId: ran.takeId,
            fileType: o.fileType,
            aspect: o.aspect,
            quality: o.quality,
            unlisted: true,
            screensOnly: true,
            callId: `held-clock-screens-${name}-${r}`,
          });
          const shot = exp.ok ? exp.value : exp;
          if (shot.outcome !== "saved") {
            console.log(
              `${tag}: ${name}: no screens: ${JSON.stringify(shot).slice(0, 300)}`,
            );
            continue;
          }
          // Kept beside the verdict: the home goes away.
          for (const f of readdirSync(shot.folder.path))
            copyFileSync(join(shot.folder.path, f), join(dir, f));
          const side = { dir, screens: shot.screens };
          const clock = JSON.stringify(ran.value.run?.recording ?? "real");
          if (base === null) {
            base = side;
            console.log(`${tag}: ${name}: recorded (${clock})`);
            continue;
          }
          const cmp = await sameScreens(base, side, {
            session,
            steps: kept.script.steps,
            log: say,
          });
          judged++;
          if (cmp.same === true) unchanged++;
          console.log(
            `${tag}: ${name}: ${"uncomparable" in cmp ? `uncompared: ${cmp.uncomparable}` : `${cmp.same ? "unchanged" : "changed"}: ${cmp.detail}`} (${clock})`,
          );
        } catch (error) {
          console.log(
            `${tag}: ${name}: threw: ${error instanceof Error ? error.message : String(error)}`,
          );
        } finally {
          await ran?.executor.close().catch((e) => say(`close failed (${e})`));
          if (ran) rmSync(ran.home, { recursive: true, force: true });
        }
      }
    }
  } finally {
    await session.close();
  }
  console.log(`trial: ${unchanged} of ${judged} unchanged`);
}

function durationMs(mp4) {
  const s = execFileSync(
    "ffprobe",
    ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", mp4],
    {
      encoding: "utf8",
    },
  );
  return Math.round(1000 * Number(s.trim()));
}

/** Every motion span's frames as 96x60 grey at their source time. */
async function framesOf(bundle, store) {
  const tmp = mkdtempSync(join(tmpdir(), "held-clock-span-"));
  const out = [];
  try {
    for (const [i, span] of bundle.motionSpans.entries()) {
      const file = join(tmp, `${i}.mp4`);
      writeFileSync(file, await store.load(span.ref));
      const times = execFileSync(
        "ffprobe",
        [
          "-v",
          "error",
          "-select_streams",
          "v",
          "-show_entries",
          "frame=pts_time",
          "-of",
          "csv=p=0",
          file,
        ],
        { encoding: "utf8" },
      )
        .split("\n")
        .filter(Boolean)
        // A span's first frame prints as "0.000000," (an empty side-data
        // column); Number() made it NaN and every frame number null.
        .map((l) => Number.parseFloat(l));
      if (times.some(Number.isNaN))
        throw new Error(`${file}: ffprobe gave a frame no time`);
      const raw = execFileSync(
        "ffmpeg",
        [
          "-v",
          "error",
          "-i",
          file,
          "-fps_mode",
          "passthrough",
          "-vf",
          "scale=96:60,format=gray",
          "-f",
          "rawvideo",
          "-",
        ],
        { maxBuffer: 1 << 30 },
      );
      const size = 96 * 60;
      for (let f = 0; f * size < raw.length; f++)
        out.push({
          ms: span.startMs + (times[f] ?? Number.NaN) * 1000,
          grey: raw.subarray(f * size, (f + 1) * size),
        });
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  return out;
}

function greyDiff(p, q) {
  let most = 0;
  for (let i = 0; i < Math.max(p.length, q.length); i++)
    most = Math.max(most, Math.abs((p[i] ?? 0) - (q[i] ?? 0)));
  return most;
}

/** The recording's timing in held frames from its first frame, network
 *  stretches left out: held-two-machines.slow.test.ts's `timingOf`. */
function timingOf(bundle, frames) {
  const stills = bundle.keyframes.map((k) => k.sourceTimeMs);
  const originMs = Math.min(...stills, ...frames.map((f) => f.ms));
  const spans = bundle.networkSpans ?? [];
  const at = (ms) => {
    let network = 0;
    for (const s of spans)
      network += Math.max(
        0,
        Math.min(s.endMs, ms) - Math.max(s.startMs, originMs),
      );
    return Math.round((ms - originMs - network) / FRAME_MS);
  };
  const waiting = (ms) => spans.some((s) => ms > s.startMs && ms <= s.endMs);
  const changed = frames.filter(
    (f, i) => i === 0 || greyDiff(f.grey, frames[i - 1].grey) > NOISE,
  );
  return {
    frames:
      at(Math.max(...stills, ...bundle.motionSpans.map((s) => s.endMs))) + 1,
    stepFrames: bundle.markers.map((m) =>
      [
        m.sourceTimeMs,
        m.approachSourceTimeMs,
        m.actEndSourceTimeMs,
        m.scrollEndSourceTimeMs,
      ].map((ms) => (ms === undefined ? null : at(ms))),
    ),
    changeFrames: [
      ...new Set(
        [...changed.map((f) => f.ms), ...stills]
          .filter((ms) => !waiting(ms))
          .map(at),
      ),
    ].sort((x, y) => x - y),
  };
}

/** Frames further apart than the encoder's noise, of the shorter run. */
function framesApart(x, y) {
  const size = 96 * 60;
  const [p, q] = [readFileSync(x), readFileSync(y)];
  let apart = 0;
  for (let i = 0; i * size < Math.min(p.length, q.length); i++)
    if (
      greyDiff(
        p.subarray(i * size, (i + 1) * size),
        q.subarray(i * size, (i + 1) * size),
      ) > NOISE
    )
      apart++;
  const n = (b) => b.length / size;
  return `${apart} of ${Math.min(n(p), n(q))}${n(p) === n(q) ? "" : ` (${n(p)} frames against ${n(q)})`}`;
}

function compare([one, two, real]) {
  const read = (dir, f) => {
    const p = join(dir, f);
    return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : null;
  };
  const s = (ms) =>
    ms === null || ms === undefined ? "-" : `${(ms / 1000).toFixed(1)} s`;
  const net = (r) =>
    r?.network?.length
      ? r.network.map((n) => `${n.label} ${n.ms}`).join("; ")
      : "none";
  const flows = readdirSync(one).filter((f) => f.endsWith(".json"));
  for (const f of flows) {
    const [a, b, c] = [read(one, f), read(two, f), real && read(real, f)];
    const name = basename(f, ".json");
    if (a?.failed || b?.failed || a?.timing == null || b?.timing == null) {
      console.log(
        `${name}: not recorded held twice (${JSON.stringify(a?.failed ?? b?.failed ?? a?.recording ?? null).slice(0, 300)})`,
      );
      continue;
    }
    const firstApart = (x, y) => {
      for (let i = 0; i < Math.max(x.length, y.length); i++)
        if (JSON.stringify(x[i]) !== JSON.stringify(y[i]))
          return `#${i}: ${JSON.stringify(x[i])} vs ${JSON.stringify(y[i])}`;
      return null;
    };
    const same = JSON.stringify(a.timing) === JSON.stringify(b.timing);
    console.log(`${name}:`);
    console.log(
      `  held frames ${a.timing.frames} / ${b.timing.frames}; steps ${a.timing.stepFrames.length}; change frames ${a.timing.changeFrames.length} / ${b.timing.changeFrames.length}`,
    );
    console.log(`  step frames run 1 ${JSON.stringify(a.timing.stepFrames)}`);
    if (!same) {
      console.log(`  step frames run 2 ${JSON.stringify(b.timing.stepFrames)}`);
      const st = firstApart(a.timing.stepFrames, b.timing.stepFrames);
      const ch = firstApart(a.timing.changeFrames, b.timing.changeFrames);
      if (st) console.log(`  first step apart ${st}`);
      if (ch) console.log(`  first change frame apart ${ch}`);
    }
    console.log(`  network run 1: ${net(a)}`);
    console.log(`  network run 2: ${net(b)}`);
    console.log(
      `  same timing outside network stretches: ${same ? "yes" : "no"}`,
    );
    console.log(
      `  page frames apart between the two held runs: ${framesApart(join(one, `${name}.grey`), join(two, `${name}.grey`))}`,
    );
    console.log(
      `  held: record ${s(a.recordMs)} / ${s(b.recordMs)}, video ${s(a.videoMs)} / ${s(b.videoMs)}`,
    );
    if (c)
      console.log(
        `  real: ${c.failed ? `failed: ${JSON.stringify(c.failed).slice(0, 200)}` : `record ${s(c.recordMs)}, video ${s(c.videoMs)}`}`,
      );
    for (const r of [a, b, c].filter(Boolean))
      if (r.degradations?.length)
        console.log(`  said: ${JSON.stringify(r.degradations).slice(0, 400)}`);
  }
}

/** A slow machine on this one: every CDP command held `ms` (test/lag.ts).
 *  Playwright's CDPSession prototype is the process's, so the executor's
 *  sessions are slowed too. */
async function lagCdp(ms) {
  const { chromium } = await import("playwright");
  const { fullChromiumPath } = await dist("executor/browser.js");
  const browser = await chromium.launch({ executablePath: fullChromiumPath() });
  const page = await browser.newPage();
  const proto = Object.getPrototypeOf(await page.context().newCDPSession(page));
  await browser.close();
  const send = proto.send;
  // Emulation's CPU throttle cannot stand in for a slow page: under it
  // Chrome never answers setVirtualTimePolicy (tried for DEM-205).
  proto.send = async function (...a) {
    await new Promise((r) => setTimeout(r, ms));
    return send.apply(this, a);
  };
  say(`every CDP command held ${ms} ms`);
}

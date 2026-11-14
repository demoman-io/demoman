#!/usr/bin/env node
// One recording and export per script, headless, with a checkout's built
// runner: the old/new pairs of the pacing fit (README, "Pacing pairs").
//
//   node apps/runner/compare/pacing-pairs.mjs --repo <checkout> --out <dir> [--sample <index.html>] <script.json>...
//
// Run it once per checkout (`main` is today's pacing, a branch with
// `scene.pacing` is the planned one) into different --out folders. `{sample}`
// in a script is the sample app's index.html served on loopback, `{fixture}`
// is `pacing-fixture.html`. Every run uses a temporary DEMOMAN_HOME, so no
// library is touched, and DEMOMAN_DISPLAY=1440x900@2. Prints one JSON line per
// script; exits 1, with the reason, if a run or an export does not succeed.
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { parseArgs } from "node:util";

const say = (line) => console.error(`[pacing-pairs] ${line}`);
const { values, positionals } = parseArgs({
  options: {
    repo: { type: "string" },
    out: { type: "string" },
    sample: { type: "string" },
    side: { type: "string" },
  },
  allowPositionals: true,
});
if (!values.repo || !values.out || positionals.length === 0) {
  say(
    "usage: pacing-pairs.mjs --repo <checkout> --out <dir> [--sample <index.html>] <script.json>...",
  );
  process.exit(2);
}
process.env.DEMOMAN_DISPLAY = "1440x900@2";
const repo = resolve(values.repo);
const here = import.meta.dirname;
const dist = (p) => import(join(repo, "apps", "runner", "dist", p));
const { createLocalExecutor } = await dist("executor/executor.js");
const { createLibrary } = await dist("executor/library.js");

const serve = async (file) => {
  const html = readFileSync(file);
  const server = createServer((req, res) => {
    if (req.url !== "/index.html") return void res.writeHead(404).end();
    res
      .writeHead(200, { "content-type": "text/html; charset=utf-8" })
      .end(html);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { server, url: `http://127.0.0.1:${server.address().port}` };
};
const sampleFile = resolve(
  values.sample ??
    join(repo, "internal", "docs", "store-assets", "sample-app", "index.html"),
);
// Served only when a script names it: a worktree has no internal/ checkout.
let sample = null;
const fixture = await serve(join(here, "pacing-fixture.html"));
const out = resolve(values.out);
mkdirSync(out, { recursive: true });
const side = values.side ?? "run";

let failed = false;
for (const scriptPath of positionals) {
  const name = basename(scriptPath, ".json");
  const home = mkdtempSync(join(tmpdir(), "pacing-pairs-home-"));
  const executor = createLocalExecutor({
    home,
    wallpapersDir: join(
      here,
      "..",
      "..",
      "studio",
      "pages",
      "public",
      "wallpapers",
    ),
    headless: true,
    outDir: join(home, "out"),
    log: () => {},
  });
  try {
    const text = readFileSync(resolve(scriptPath), "utf8");
    if (text.includes("{sample}")) sample ??= await serve(sampleFile);
    const script = JSON.parse(
      text
        .replaceAll("{sample}", sample?.url ?? "")
        .replaceAll("{fixture}", fixture.url),
    );
    const t0 = Date.now();
    const run = await executor.request("run", {
      script,
      video: { new: name, confirmedNew: true },
      callId: `pacing-pairs-run-${name}`,
    });
    const wallMs = Date.now() - t0;
    if (!run.ok || run.value.outcome === "refused") {
      throw new Error(`run refused: ${JSON.stringify(run).slice(0, 500)}`);
    }
    const takeId = run.value.provenance?.takeId;
    if (typeof takeId !== "string") {
      throw new Error(
        `the run made no take: ${JSON.stringify(run.value).slice(0, 500)}`,
      );
    }
    const exp = await executor.request("export", {
      takeId,
      callId: `pacing-pairs-export-${name}`,
    });
    const answer = exp.ok ? exp.value : exp;
    if (answer.outcome !== "saved") {
      throw new Error(
        `export ${answer.outcome ?? "refused"}: ${JSON.stringify(answer).slice(0, 500)}`,
      );
    }
    const mp4 = join(out, `${name}-${side}.mp4`);
    copyFileSync(answer.file.path, mp4);

    const library = createLibrary(home);
    const scene = await library.getScene(takeId);
    const takeDir = library.takeDir(takeId);
    const report = JSON.parse(
      readFileSync(join(takeDir, "report.json"), "utf8"),
    );
    if (process.env.PACING_PAIRS_DUMP)
      say(
        `report keys: ${Object.keys(report)}; video: ${JSON.stringify(report.video ?? null).slice(0, 600)}; film keys: ${Object.keys(report.film ?? {})}; opening: ${JSON.stringify(report.opening ?? null)}`,
      );
    const bundleDir = join(takeDir, "frames", "bundles");
    const bundleFile = readdirSyncSafe(bundleDir);
    const bundle = JSON.parse(
      readFileSync(join(bundleDir, bundleFile), "utf8"),
    );
    const order = [...bundle.markers]
      .sort((a, b) => a.sourceTimeMs - b.sourceTimeMs)
      .map((m) => m.actionId);
    const zooms = (scene?.camera ?? [])
      .filter((c) => c.kind === "zoom")
      .map((c) => ({
        step: order.indexOf(c.marker?.actionId),
        scale: c.scale,
        arrives: c.arrives ?? null,
      }));
    const film = report.video;
    console.info(
      JSON.stringify({
        name,
        side,
        mp4,
        videoMs: mp4DurationMs(mp4),
        wallMs,
        pacing: film?.pacing ?? null,
        plannedMs: film?.plannedMs ?? null,
        recordedMs: film?.recordedMs ?? null,
        sourceMs: Math.max(...bundle.markers.map((m) => m.sourceTimeMs)),
        zooms,
        trim: trimOf(scene?.edits?.trim, film),
        markers: bundle.markers.map((m) => m.sourceTimeMs),
      }),
    );
  } catch (error) {
    failed = true;
    say(
      `${name} failed: ${error instanceof Error ? error.stack : String(error)}`,
    );
  } finally {
    await executor.close().catch((e) => say(`close failed (${e})`));
    rmSync(home, { recursive: true, force: true });
  }
}
sample?.server.close();
fixture.server.close();
process.exit(failed ? 1 : 0);

function readdirSyncSafe(dir) {
  const f = readdirSync(dir).find((x) => x.endsWith(".json"));
  if (f === undefined) throw new Error(`no bundle in ${dir}`);
  return f;
}

// The container's own duration (mvhd), so the length is the file's, not a plan's.
function mp4DurationMs(file) {
  const b = readFileSync(file);
  const i = b.indexOf("mvhd");
  if (i < 0) throw new Error(`${file} has no mvhd box`);
  const wide = b[i + 4] === 1;
  const scale = b.readUInt32BE(i + 8 + (wide ? 16 : 8));
  const dur = wide ? Number(b.readBigUInt64BE(i + 28)) : b.readUInt32BE(i + 20);
  return Math.round((dur / scale) * 1000);
}

// The script's trim as positions in the untrimmed video: each side is its
// step's output time (the film check's `outputMs`) plus the written offset.
// Null when the take has no trim; a side whose step the film does not list is
// null, never a guess.
function trimOf(trim, film) {
  if (trim === undefined) return null;
  const at = (side) => {
    const step = film?.steps?.find((s) => s.actionId === side?.actionId);
    return typeof step?.outputMs === "number"
      ? Math.round(step.outputMs + side.offsetMs)
      : null;
  };
  return { startMs: at(trim.head), endMs: at(trim.tail) };
}

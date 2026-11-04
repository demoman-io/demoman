// What a headless Chrome's launch flags do to an export: one take, exported
// once per flag set, in rounds.
//   node apps/runner/compare/gpu-args.mjs --repo <root> --script <file> --sample <index.html> [--rounds 2] [--sets all|"<name>;<name>"] [--browsers full|shell|"full;shell"]
// Records the script once with <root>'s built runner, then for each round and
// each flag set (`SETS`) sets `HEADLESS_GPU_ARGS` to it, exports the same take
// from a fresh browser on the full Chromium the CLI launches, and prints the
// export's `timing export` line and what WebGL says it draws with. The render
// time is the evidence; the WebGL line only says which backend came up
// (`chrome://gpu` says "Hardware accelerated" either way, README).
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

const say = (line) => console.info(`[gpu-args] ${line}`);
const { values } = parseArgs({
  options: {
    repo: { type: "string" },
    script: { type: "string" },
    sample: { type: "string" },
    rounds: { type: "string", default: "2" },
    // Names from SETS separated by ";" (some names hold commas), or "all".
    sets: { type: "string", default: "all" },
    // "full" (the Chromium the CLI launches), "shell" (Playwright's headless
    // shell, what a headless launch picks when it names no executable), or
    // both separated by ";".
    browsers: { type: "string", default: "full" },
  },
});
if (!values.repo || !values.script || !values.sample) {
  say(
    "usage: gpu-args.mjs --repo <root> --script <file> --sample <index.html> [--rounds 2]",
  );
  process.exit(2);
}
const repo = resolve(values.repo);
const dist = (p) => import(join(repo, "apps", "runner", "dist", p));
const { createLocalExecutor } = await dist("executor/executor.js");
const { createLibrary } = await dist("executor/library.js");
const { fullChromiumPath } = await dist("executor/browser.js");
const { HEADLESS_GPU_ARGS, launch } = await dist("launch.js");

// Linux candidates. Chrome's switches: --enable-gpu is the macOS entry;
// headless Linux may blocklist the GPU, want ANGLE on Vulkan, or fall back to
// SwiftShader, which draws on the CPU but off the renderer's main thread.
const SETS = {
  none: [],
  "enable-gpu": ["--enable-gpu"],
  "enable-gpu, ignore blocklist": ["--enable-gpu", "--ignore-gpu-blocklist"],
  "enable-gpu, ANGLE on Vulkan": [
    "--enable-gpu",
    "--ignore-gpu-blocklist",
    "--use-angle=vulkan",
    "--enable-features=Vulkan",
  ],
  "enable-gpu, SwiftShader": ["--enable-gpu", "--enable-unsafe-swiftshader"],
  // Without a GPU, two thirds of an export is "copying frames to the
  // encoder" (DEM-43): maybe SwiftShader handing each frame back. These draw
  // the canvas on the CPU from the start.
  "disable-gpu": ["--disable-gpu"],
  "no accelerated canvas": [
    "--disable-accelerated-2d-canvas",
    "--disable-gpu-compositing",
  ],
};
const chosen =
  values.sets === "all" ? Object.keys(SETS) : values.sets.split(";");
const unknown = chosen.filter((name) => !(name in SETS));
if (unknown.length > 0) {
  say(
    `no flag set named ${unknown.map((n) => `"${n}"`).join(", ")}; sets: ${Object.keys(SETS).join(", ")}`,
  );
  process.exit(2);
}
const filmedArgs = [...HEADLESS_GPU_ARGS];
// launch() spreads this array at each launch; every launch below reads it.
const useArgs = (args) => HEADLESS_GPU_ARGS.splice(0, Infinity, ...args);

const html = readFileSync(resolve(values.sample));
const server = createServer((req, res) => {
  if (req.url !== "/index.html") return void res.writeHead(404).end();
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(html);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const sample = `http://127.0.0.1:${server.address().port}`;

// The headless shell Playwright installs beside the full Chromium, at the
// same revision: <cache>/chromium-<rev>/… and <cache>/chromium_headless_shell-<rev>/….
function headlessShellPath(full) {
  const m = /^(.*)[\\/]chromium-(\d+)[\\/]/.exec(full);
  if (m === null) throw new Error(`no chromium-<rev> folder in ${full}`);
  const dir = join(m[1], `chromium_headless_shell-${m[2]}`);
  const sub = readdirSync(dir).find((d) =>
    d.startsWith("chrome-headless-shell"),
  );
  if (sub === undefined) throw new Error(`no headless shell in ${dir}`);
  return join(dir, sub, "chrome-headless-shell");
}
const full = fullChromiumPath();
const BROWSERS = { full: () => full, shell: () => headlessShellPath(full) };
const chosenBrowsers = values.browsers.split(";");
const unknownBrowsers = chosenBrowsers.filter((b) => !(b in BROWSERS));
if (unknownBrowsers.length > 0) {
  say(`no browser named ${unknownBrowsers.join(", ")}; browsers: full, shell`);
  process.exit(2);
}
const paths = Object.fromEntries(chosenBrowsers.map((b) => [b, BROWSERS[b]()]));
for (const b of chosenBrowsers) say(`${b}: ${paths[b]}`);
// The take is recorded on the full Chromium, as the CLI records.
let executablePath = full;
const home = mkdtempSync(join(tmpdir(), "gpu-args-home-"));
let lastTiming = null;
const executorFor = () =>
  createLocalExecutor({
    home,
    wallpapersDir: join(
      import.meta.dirname,
      "..",
      "..",
      "studio",
      "pages",
      "public",
      "wallpapers",
    ),
    headless: true,
    executablePath,
    outDir: join(home, "out"),
    log: (m) => {
      const line = typeof m === "string" ? m : JSON.stringify(m);
      if (line.startsWith("timing export")) lastTiming = line;
    },
  });

async function webglRenderer() {
  const launched = await launch({ headless: true, executablePath });
  try {
    return await launched.page.evaluate(() => {
      const gl = document.createElement("canvas").getContext("webgl");
      if (gl === null) return "no WebGL context";
      const info = gl.getExtension("WEBGL_debug_renderer_info");
      return info === null
        ? gl.getParameter(gl.RENDERER)
        : gl.getParameter(info.UNMASKED_RENDERER_WEBGL);
    });
  } finally {
    await launched.close();
  }
}

let failed = false;
const results = [];
try {
  let executor = executorFor();
  const script = JSON.parse(
    readFileSync(resolve(values.script), "utf8").replaceAll("{sample}", sample),
  );
  const run = await executor
    .request("run", {
      script,
      video: { new: "gpu-args", confirmedNew: true },
      callId: "gpu-args-run",
    })
    .finally(() => executor.close());
  const takeId = run.ok ? run.value.provenance?.takeId : undefined;
  if (typeof takeId !== "string") {
    throw new Error(
      `the run made no take: ${JSON.stringify(run).slice(0, 400)}`,
    );
  }
  const scene = await createLibrary(home).getScene(takeId);
  if (scene === null) throw new Error(`take ${takeId} has no scene`);
  say(
    `take ${takeId} recorded with [${filmedArgs.join(" ")}]: padding ${scene.branding.padding}, background ${scene.branding.background.kind}, ${scene.camera.length} camera events`,
  );
  const runs = chosenBrowsers.flatMap((browser) =>
    chosen.map((set) => ({
      browser,
      set,
      name: chosenBrowsers.length > 1 ? `${browser}, ${set}` : set,
    })),
  );
  for (let round = 1; round <= Number(values.rounds); round++) {
    for (const { browser, set, name } of runs) {
      executablePath = paths[browser];
      useArgs(SETS[set]);
      const renderer = await webglRenderer().catch(
        (e) => `WebGL read failed: ${e instanceof Error ? e.message : e}`,
      );
      lastTiming = null;
      executor = executorFor();
      const exp = await executor
        .request("export", { takeId, callId: `gpu-args-${round}-${name}` })
        .finally(() => executor.close());
      const answer = exp.ok ? exp.value : exp;
      if (answer.outcome !== "saved" || lastTiming === null) {
        failed = true;
        say(
          `round ${round} ${name}: export ${answer.outcome ?? "refused"}${lastTiming === null ? ", and no timing line was logged" : ""} — ${JSON.stringify(answer).slice(0, 300)}`,
        );
        continue;
      }
      const render = /render (\d+\.\d+)s,/.exec(lastTiming)?.[1] ?? "?";
      results.push({ round, name, render, renderer });
      say(`round ${round} ${name.padEnd(30)} render ${render} s · ${renderer}`);
      say(`  ${lastTiming}`);
    }
  }
} catch (error) {
  failed = true;
  say(`failed: ${error instanceof Error ? error.stack : String(error)}`);
} finally {
  server.close();
  rmSync(home, { recursive: true, force: true });
}
say("summary (render seconds by round):");
for (const name of [...new Set(results.map((r) => r.name))]) {
  const times = results.filter((r) => r.name === name).map((r) => r.render);
  say(`  ${name.padEnd(30)} ${times.join(" / ") || "no export"}`);
}
process.exit(failed ? 1 : 0);

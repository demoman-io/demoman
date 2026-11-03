// What a headless Chrome's launch flags do to an export: one take, exported
// once per flag set, in rounds.
//   node apps/runner/compare/gpu-args.mjs --repo <root> --script <file> --sample <index.html> [--rounds 2]
// Records the script once with <root>'s built runner, then for each round and
// each flag set (`SETS`) sets `HEADLESS_GPU_ARGS` to it, exports the same take
// from a fresh browser on the full Chromium the CLI launches, and prints the
// export's `timing export` line and what WebGL says it draws with. The render
// time is the evidence; the WebGL line only says which backend came up
// (`chrome://gpu` says "Hardware accelerated" either way, README).
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
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
};
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

const executablePath = fullChromiumPath();
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
  for (let round = 1; round <= Number(values.rounds); round++) {
    for (const [name, args] of Object.entries(SETS)) {
      useArgs(args);
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
for (const name of Object.keys(SETS)) {
  const times = results.filter((r) => r.name === name).map((r) => r.render);
  say(`  ${name.padEnd(30)} ${times.join(" / ") || "no export"}`);
}
process.exit(failed ? 1 : 0);

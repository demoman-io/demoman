// What each look costs an export: one take, exported under scene variants.
//   node apps/runner/compare/export-variants.mjs --repo <root> --script <file> [--sample <index.html>]
// Films the script once, headless, with <root>'s built runner, then exports
// the take once per variant (each written over the take's scene.json from
// the filmed original) and prints each export's `timing export` line. Needs
// a runner built with perf/stage-timings' log line.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

const say = (line) => console.info(`[export-variants] ${line}`);
const { values } = parseArgs({
  options: {
    repo: { type: "string" },
    script: { type: "string" },
    sample: { type: "string" },
  },
});
if (!values.repo || !values.script) {
  say(
    "usage: export-variants.mjs --repo <root> --script <file> [--sample <index.html>]",
  );
  process.exit(2);
}
const repo = resolve(values.repo);
const dist = (p) => import(join(repo, "apps", "runner", "dist", p));
const { createLocalExecutor } = await dist("executor/executor.js");
const { createLibrary } = await dist("executor/library.js");

const VARIANTS = {
  "as filmed": (s) => s,
  "no camera blur": (s) => ({ ...s, motion: { ...motionOf(s), blur: 0 } }),
  "no padding (no frame shadows)": (s) => ({
    ...s,
    branding: { ...s.branding, padding: 0 },
  }),
  "solid background": (s) => ({
    ...s,
    branding: {
      ...s.branding,
      background: { kind: "solid", color: "#ffffff" },
    },
  }),
  "no zooms": (s) => ({ ...s, camera: [] }),
  "no camera blur, no padding": (s) => ({
    ...s,
    motion: { ...motionOf(s), blur: 0 },
    branding: { ...s.branding, padding: 0 },
  }),
};
const motionOf = (s) =>
  s.motion ?? { smoothness: 0.5, blur: 0.5, follow: true };

const html = readFileSync(
  values.sample ??
    join(repo, "docs", "store-assets", "sample-app", "index.html"),
);
const server = createServer((req, res) => {
  if (req.url !== "/index.html") return void res.writeHead(404).end();
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(html);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const sample = `http://127.0.0.1:${server.address().port}`;

const home = mkdtempSync(join(tmpdir(), "export-variants-home-"));
let lastTiming = null;
const executor = createLocalExecutor({
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
  outDir: join(home, "out"),
  log: (m) => {
    const line = typeof m === "string" ? m : JSON.stringify(m);
    if (line.startsWith("timing export")) lastTiming = line;
  },
});
let failed = false;
try {
  const script = JSON.parse(
    readFileSync(resolve(values.script), "utf8").replaceAll("{sample}", sample),
  );
  const run = await executor.request("run", {
    script,
    video: { new: "variants", confirmedNew: true },
    callId: "export-variants-run",
  });
  const takeId = run.ok ? run.value.provenance?.takeId : undefined;
  if (typeof takeId !== "string") {
    throw new Error(
      `the run made no take: ${JSON.stringify(run).slice(0, 400)}`,
    );
  }
  const library = createLibrary(home);
  const filmed = await library.getScene(takeId);
  if (filmed === null) throw new Error(`take ${takeId} has no scene`);
  say(
    `take ${takeId}: padding ${filmed.branding.padding}, background ${filmed.branding.background.kind}, blur ${motionOf(filmed).blur}, ${filmed.camera.length} camera events`,
  );
  for (const [name, change] of Object.entries(VARIANTS)) {
    await library.putScene(change(structuredClone(filmed)));
    lastTiming = null;
    const exp = await executor.request("export", {
      takeId,
      callId: `export-variants-${name}`,
    });
    const answer = exp.ok ? exp.value : exp;
    if (answer.outcome !== "saved" || lastTiming === null) {
      failed = true;
      say(
        `${name}: export ${answer.outcome ?? "refused"}${lastTiming === null ? ", and no timing line was logged" : ""} — ${JSON.stringify(answer).slice(0, 300)}`,
      );
      continue;
    }
    const render = /render (\d+\.\d+)s,/.exec(lastTiming)?.[1] ?? "?";
    say(`${name.padEnd(32)} render ${render} s`);
  }
} catch (error) {
  failed = true;
  say(`failed: ${error instanceof Error ? error.stack : String(error)}`);
} finally {
  await executor.close().catch((e) => say(`close failed (${e})`));
  server.close();
  rmSync(home, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);

// Where a real export's render time goes, by function, headless.
//   node apps/runner/compare/export-profile.mjs --repo <root> --script <file> [--sample <index.html>] [--out <trace.json>]
// Films the script once with <root>'s built runner, then exports it under a
// V8 CPU-profiler trace of the browser (started when the export opens its
// render page, stopped when the export answers), and prints the functions
// with the most self time on the render page's main thread. The trace is
// kept at --out for chrome://tracing or Perfetto.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

const say = (line) => console.info(`[export-profile] ${line}`);
const { values } = parseArgs({
  options: {
    repo: { type: "string" },
    script: { type: "string" },
    sample: { type: "string" },
    out: { type: "string" },
  },
});
if (!values.repo || !values.script) {
  say(
    "usage: export-profile.mjs --repo <root> --script <file> [--sample <index.html>] [--out <trace.json>]",
  );
  process.exit(2);
}
const repo = resolve(values.repo);
const dist = (p) => import(join(repo, "apps", "runner", "dist", p));
const { createLocalExecutor } = await dist("executor/executor.js");

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

const home = mkdtempSync(join(tmpdir(), "export-profile-home-"));
let tracing = null;
let exporting = false;
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
  log: (m) => say(typeof m === "string" ? m : JSON.stringify(m)),
  onWorkPage: (page) => {
    // Every work page is offered; only the export's is traced (the run's mux
    // page opens first and is not what this measures).
    if (!exporting || tracing !== null) return;
    const browser = page.context().browser();
    tracing = browser
      .startTracing(undefined, {
        categories: ["disabled-by-default-v8.cpu_profiler", "v8"],
      })
      .then(() => browser);
  },
});
let failed = false;
try {
  const script = JSON.parse(
    readFileSync(resolve(values.script), "utf8").replaceAll("{sample}", sample),
  );
  const run = await executor.request("run", {
    script,
    video: { new: "profile", confirmedNew: true },
    callId: "export-profile-run",
  });
  const takeId = run.ok ? run.value.provenance?.takeId : undefined;
  if (typeof takeId !== "string") {
    throw new Error(
      `the run made no take: ${JSON.stringify(run).slice(0, 400)}`,
    );
  }
  exporting = true;
  const exp = await executor.request("export", {
    takeId,
    callId: "export-profile-export",
  });
  const answer = exp.ok ? exp.value : exp;
  say(`export: ${answer.outcome ?? JSON.stringify(answer).slice(0, 300)}`);
  if (tracing === null)
    throw new Error("the export opened no work page to trace");
  const browser = await tracing;
  const trace = JSON.parse((await browser.stopTracing()).toString("utf8"));
  if (values.out) writeFileSync(resolve(values.out), JSON.stringify(trace));
  report(trace);
} catch (error) {
  failed = true;
  say(`failed: ${error instanceof Error ? error.stack : String(error)}`);
} finally {
  await executor.close().catch((e) => say(`close failed (${e})`));
  server.close();
  rmSync(home, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);

/** Self time per function, from the trace's ProfileChunk samples, for the
 *  profile with the most samples (the render page's main thread). */
function report(trace) {
  const events = trace.traceEvents ?? trace;
  const profiles = new Map();
  for (const e of events) {
    if (e.name !== "ProfileChunk") continue;
    const key = `${e.pid}:${e.id}`;
    let p = profiles.get(key);
    if (!p) {
      p = { nodes: new Map(), samples: [], deltas: [] };
      profiles.set(key, p);
    }
    const data = e.args?.data ?? {};
    for (const n of data.cpuProfile?.nodes ?? []) p.nodes.set(n.id, n);
    p.samples.push(...(data.cpuProfile?.samples ?? []));
    p.deltas.push(...(data.timeDeltas ?? []));
  }
  if (profiles.size === 0) {
    say("the trace holds no CPU profile samples");
    failed = true;
    return;
  }
  const [key, p] = [...profiles].sort(
    (a, b) => b[1].samples.length - a[1].samples.length,
  )[0];
  const self = new Map();
  let totalUs = 0;
  for (let i = 0; i < p.samples.length; i++) {
    const node = p.nodes.get(p.samples[i]);
    // A sample's time is the delta to the NEXT sample.
    const us = p.deltas[i + 1] ?? 0;
    totalUs += us;
    const f = node?.callFrame ?? {};
    const url = (f.url ?? "").split("/").pop();
    const name = `${f.functionName || "(anonymous)"} ${url}:${(f.lineNumber ?? -1) + 1}`;
    self.set(name, (self.get(name) ?? 0) + us);
  }
  say(
    `profile ${key}: ${p.samples.length} samples over ${(totalUs / 1e6).toFixed(1)} s (${profiles.size} profiles in the trace)`,
  );
  const top = [...self].sort((a, b) => b[1] - a[1]).slice(0, 30);
  for (const [name, us] of top) {
    say(
      `  ${(us / 1e6).toFixed(2).padStart(7)} s ${((100 * us) / totalUs).toFixed(1).padStart(5)}%  ${name}`,
    );
  }
}

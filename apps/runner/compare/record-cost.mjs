// What one recording costs with a checkout's runner: run time, take size.
//   node apps/runner/compare/record-cost.mjs --repo <root> --script <file> --out <mp4> [--project <app checkout>] [--home <dir>]
// Records the script headless with <root>'s built runner in a throwaway home
// (signed in by the project's demo account, as the MCP does), exports the
// take at high quality to --out, and prints:
//   outcome: <the run report's summary>
//   cost: run <s> s, take <MB> MB on disk, <spans> spans, <keyframes> keyframes
// Any outcome but a complete run exits 1, saying what it was. --home records
// into <dir> and keeps it, and prints `take: <id>`, for camera-motion's
// `--plan` with DEMOMAN_HOME=<dir>.
import {
  cpSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

const say = (line) => console.info(`[record-cost] ${line}`);
const { values } = parseArgs({
  options: {
    repo: { type: "string" },
    script: { type: "string" },
    out: { type: "string" },
    project: { type: "string" },
    home: { type: "string" },
  },
});
if (!values.repo || !values.script || !values.out) {
  say(
    "usage: record-cost.mjs --repo <root> --script <file> --out <mp4> [--project <app checkout>] [--home <dir>]",
  );
  process.exit(2);
}
const repo = resolve(values.repo);
const { createLocalExecutor } = await import(
  join(repo, "apps", "runner", "dist", "executor", "executor.js")
);
const script = JSON.parse(readFileSync(resolve(values.script), "utf8"));

/** Bytes under a folder. */
const sizeOf = (dir) =>
  readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((e) => e.isFile())
    .reduce((n, e) => n + statSync(join(e.parentPath, e.name)).size, 0);

const home = values.home
  ? resolve(values.home)
  : mkdtempSync(join(tmpdir(), "record-cost-home-"));
const executor = createLocalExecutor({
  home,
  wallpapersDir: join(repo, "apps", "studio", "pages", "public", "wallpapers"),
  headless: true,
  outDir: join(home, "out"),
  log: () => {},
});
let failed = false;
try {
  const started = Date.now();
  const answer = await executor.request("run", {
    script,
    video: { new: `record-cost ${Date.now()}`, confirmedNew: true },
    ...(values.project ? { project: resolve(values.project) } : {}),
    callId: "record-cost-run",
  });
  const seconds = (Date.now() - started) / 1000;
  const report = answer.ok ? answer.value : answer;
  say(`outcome: ${report.summary ?? JSON.stringify(report).slice(0, 400)}`);
  const takeId = report.provenance?.videoId ?? report.provenance?.takeId;
  if (report.outcome !== "complete" || typeof takeId !== "string") {
    failed = true;
  } else {
    const take = join(home, "takes", takeId);
    if (values.home) say(`take: ${takeId}`);
    say(
      `cost: run ${seconds.toFixed(1)} s, take ${(sizeOf(take) / 1e6).toFixed(1)} MB on disk, ${report.frames?.spans} spans, ${report.frames?.keyframes} keyframes`,
    );
    const exp = await executor.request("export", {
      takeId,
      quality: "high",
      callId: "record-cost-export",
    });
    const saved = exp.ok ? exp.value : exp;
    if (saved.outcome !== "saved") {
      failed = true;
      say(
        `export ${saved.outcome ?? "refused"}: ${JSON.stringify(saved).slice(0, 400)}`,
      );
    } else {
      cpSync(saved.file.path, resolve(values.out));
      say(`exported to ${resolve(values.out)}`);
    }
  }
} catch (error) {
  failed = true;
  say(`failed: ${error instanceof Error ? error.stack : String(error)}`);
} finally {
  await executor.close().catch((e) => say(`close failed (${e})`));
  if (!values.home) rmSync(home, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);

#!/usr/bin/env node
// What the step settle costs: `<demoman> refresh` in a throwaway git worktree
// of each app, then each flow's recording time (the `timing run … walk N s`
// line) and, when the build records them, each screen's `pageScreens` entry
// from the take's bundle. Nothing is delivered (no --deliver), and the app's
// own checkout is untouched.
//
//   node apps/runner/compare/settle-cost.mjs --demoman "<command>" [--out <json>] <appDir>...
//
// Run it once per build and compare the two outputs (README, "Settle cost").
// The refresh deletes its throwaway home when a flow ends, so the bundles are
// copied out while the flow runs: TMPDIR is pointed at a private folder and
// polled for `takes/*/frames/bundles/*.json`.
import { spawn, spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { parseArgs } from "node:util";

const { values, positionals } = parseArgs({
  options: { demoman: { type: "string" }, out: { type: "string" } },
  allowPositionals: true,
});
if (!values.demoman || positionals.length === 0) {
  console.error(
    'usage: settle-cost.mjs --demoman "<command>" [--out <json>] <appDir>...',
  );
  process.exit(2);
}
const sh = (cmd, args, cwd) => spawnSync(cmd, args, { cwd, encoding: "utf8" });
const secs = (re, text) => {
  const m = re.exec(text);
  return m ? Number(m[1]) : null;
};

/** Bundles seen under `tmp` so far, copied to `keep` (the home goes away). */
function harvest(tmp, keep, sizes) {
  for (const home of readdirSync(tmp).filter((d) =>
    d.startsWith("demoman-refresh-home-"),
  )) {
    const takes = join(tmp, home, "takes");
    for (const id of existsSync(takes) ? readdirSync(takes) : []) {
      const shots = join(takes, id, "frames", "page-screens");
      if (existsSync(shots))
        for (const f of readdirSync(shots))
          try {
            sizes[f] = statSync(join(shots, f)).size;
          } catch {
            // gone with its home: the last poll's size stands
          }
    }
    if (!existsSync(takes)) continue;
    for (const id of readdirSync(takes)) {
      const dir = join(takes, id, "frames", "bundles");
      if (!existsSync(dir)) continue;
      for (const f of readdirSync(dir).filter((n) => n.endsWith(".json"))) {
        const to = join(keep, `${id}-${f}`);
        if (!existsSync(to))
          try {
            cpSync(join(dir, f), to);
          } catch {
            // half-written: the next poll takes it
          }
      }
    }
  }
}

const results = [];
for (const appDir of positionals.map((p) => resolve(p))) {
  const app = basename(appDir);
  const work = mkdtempSync(join(tmpdir(), `settle-cost-${app}-`));
  const tree = join(work, "tree");
  const tmp = mkdtempSync("/private/tmp/sc-"); // short: nitro's socket path must fit sun_path
  const keep = join(work, "bundles");
  mkdirSync(keep);
  const sizes = {};
  const add = sh("git", ["worktree", "add", "--detach", tree, "HEAD"], appDir);
  if (add.status !== 0) {
    console.error(`${app}: no worktree (${add.stderr.trim()})`);
    results.push({ app, error: "no worktree" });
    continue;
  }
  // A sample kept outside git (the chatbot's patch, .demoman, .env.local) is
  // what the checkout has beyond HEAD: carry it over.
  const dirty = sh("git", ["status", "--porcelain", "-uall"], appDir)
    .stdout.split("\n")
    .filter(Boolean)
    .map((l) => l.slice(3));
  for (const f of dirty)
    cpSync(join(appDir, f), join(tree, f), { recursive: true });
  // Ignored files a checkout keeps for its demo accounts, copied here only.
  for (const f of [".env.local", ".demoman/secrets.env"])
    if (existsSync(join(appDir, f))) cpSync(join(appDir, f), join(tree, f));

  let stderr = "";
  const child = spawn(`${values.demoman} refresh`, {
    cwd: tree,
    shell: true,
    env: { ...process.env, TMPDIR: tmp },
  });
  child.stderr.on("data", (d) => {
    stderr += d;
    process.stderr.write(d);
  });
  child.stdout.on("data", (d) => {
    process.stdout.write(d);
  });
  const poll = setInterval(() => harvest(tmp, keep, sizes), 400);
  const code = await new Promise((r) => child.on("close", r));
  clearInterval(poll);
  harvest(tmp, keep, sizes);

  // Each `timing run` line belongs to the flow named by the last
  // `refresh: running "<flow>"` before it; a flow filmed again after a
  // problem has several (attempts), the first is the comparable one.
  const flows = [];
  let flow = "?";
  for (const l of stderr.split("\n")) {
    const named = /refresh: running "(.*)" at /.exec(l);
    if (named) flow = named[1];
    const walk = l.includes("timing run") ? secs(/walk ([\d.]+)s/, l) : null;
    if (walk !== null)
      flows.push({
        flow,
        walk,
        scene: /timing run (\S+):/.exec(l)?.[1],
        line: l,
      });
  }
  const bundles = readdirSync(keep).map((f) =>
    JSON.parse(readFileSync(join(keep, f), "utf8")),
  );
  results.push({ app, exit: code, flows, bundles, pngBytes: sizes });
  sh("git", ["worktree", "remove", "--force", tree], appDir);
  rmSync(work, { recursive: true, force: true });
  rmSync(tmp, { recursive: true, force: true });
  console.log(`${app}: exit ${code}, ${flows.length} walk lines`);
}
if (values.out) writeFileSync(values.out, JSON.stringify(results, null, 1));
console.log("app\tflow\twalk s");
for (const r of results)
  for (const f of r.flows ?? []) console.log(`${r.app}\t${f.flow}\t${f.walk}`);

#!/usr/bin/env node
// `pnpm test:times`: where the last test runs spent their time, read from
// the per-file durations vitest caches in each package
// (`node_modules/.vite/vitest/<hash>/results.json`). A readout, not a gate:
// it always exits 0.
//
// The caches hold what the last run of each lane wrote, so a package tested
// on its own an hour ago and one tested now sit side by side; each cache's
// age is printed for that reason. Files a cache still lists but the tree no
// longer has are counted as stale and left out.

import { existsSync, globSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

/** A file at or over this, not named `*.slow.test.ts`, is listed as one
 *  the fast tier probably should skip. */
export const UNMARKED_SLOW_MS = 90_000;

const TOP = 25;

/**
 * @param {Array<{ pkg: string, mtimeMs: number, results: Array<[string, { duration?: number, failed?: boolean }]> }>} caches
 * @param {(pkg: string, file: string) => boolean} exists
 */
export function summarize(caches, exists) {
  const lanes = new Map();
  const files = [];
  let stale = 0;
  for (const { pkg, results } of caches) {
    for (const [key, result] of results) {
      const at = key.indexOf(":");
      const lane = at < 0 ? "" : key.slice(0, at);
      const file = at < 0 ? key : key.slice(at + 1);
      if (!exists(pkg, file)) {
        stale++;
        continue;
      }
      const ms = result.duration ?? 0;
      const name = lane === "" ? pkg : `${pkg} ${lane}`;
      const sum = lanes.get(name) ?? { lane: name, files: 0, ms: 0 };
      sum.files++;
      sum.ms += ms;
      lanes.set(name, sum);
      files.push({ pkg, lane, file, ms, slow: file.includes(".slow.test.") });
    }
  }
  files.sort((a, b) => b.ms - a.ms);
  return {
    lanes: [...lanes.values()].sort((a, b) => b.ms - a.ms),
    top: files.slice(0, TOP),
    unmarked: files.filter((f) => !f.slow && f.ms >= UNMARKED_SLOW_MS),
    stale,
  };
}

/**
 * Each cache parsed, or named with why it could not be: a cache a vitest
 * run is rewriting, or one a killed run left half-written, must not take
 * the rest of the readout down with it.
 *
 * @param {string[]} paths repo-relative `<pkg>/node_modules/.vite/vitest/<hash>/results.json`
 * @param {(path: string) => { text: string, mtimeMs: number }} read
 */
export function loadCaches(paths, read) {
  const caches = [];
  const unreadable = [];
  for (const path of paths) {
    const pkg = path.split("/node_modules/")[0];
    try {
      const { text, mtimeMs } = read(path);
      const { results } = JSON.parse(text);
      caches.push({
        pkg,
        mtimeMs,
        results: Array.isArray(results) ? results : Object.entries(results),
      });
    } catch (error) {
      unreadable.push({ path, reason: String(error) });
    }
  }
  return { caches, unreadable };
}

const seconds = (ms) => `${(ms / 1000).toFixed(1)} s`;

function main() {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const paths = ["apps", "packages"].flatMap((dir) =>
    globSync(`${dir}/*/node_modules/.vite/vitest/*/results.json`, {
      cwd: root,
    }),
  );
  if (paths.length === 0) {
    console.log("no vitest results cached; run pnpm test first");
    return;
  }
  const now = Date.now();
  const { caches, unreadable } = loadCaches(paths, (path) => {
    const full = join(root, path);
    return { text: readFileSync(full, "utf8"), mtimeMs: statSync(full).mtimeMs };
  });
  const out = summarize(caches, (pkg, file) =>
    existsSync(join(root, pkg, file)),
  );

  console.log("caches (age):");
  for (const c of caches.sort((a, b) => b.mtimeMs - a.mtimeMs)) {
    const mins = Math.round((now - c.mtimeMs) / 60_000);
    console.log(`  ${c.pkg.padEnd(26)} ${mins} min ago`);
  }
  console.log("\nper lane (sum of file durations; files run in parallel):");
  for (const l of out.lanes) {
    console.log(
      `  ${l.lane.padEnd(40)} ${String(l.files).padStart(4)} files ${seconds(l.ms).padStart(9)}`,
    );
  }
  console.log(`\nlongest ${TOP} files:`);
  for (const f of out.top) {
    const where = relative(root, join(root, f.pkg, f.file));
    console.log(
      `  ${seconds(f.ms).padStart(9)}  ${f.slow ? "slow" : "    "}  ${where}`,
    );
  }
  if (out.unmarked.length > 0) {
    console.log(
      `\nnot marked slow, at or over ${seconds(UNMARKED_SLOW_MS)} (pnpm test:fast runs these):`,
    );
    for (const f of out.unmarked) {
      console.log(`  ${seconds(f.ms).padStart(9)}  ${f.pkg}/${f.file}`);
    }
  }
  for (const { path, reason } of unreadable) {
    console.log(`\nleft out ${path}: ${reason}`);
  }
  if (out.stale > 0) {
    console.log(`\n${out.stale} cached file(s) no longer exist; left out`);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();

#!/usr/bin/env node
// `pnpm test:changed`: the check before a push. The fast tier of the
// packages this branch changed since it left origin/main, and of every
// package that depends on them. CI runs the full tier of everything and is
// the merge gate; this is the quick local look before it.
//
// Some package tests read files outside any package: the cli's docs guards
// read apps/docs, the README and scripts/changelog.mjs. A change to one of
// those tests the packages that read it (READERS).
//
// It never runs every package: on 2026-11-18 a run that selected
// every package took the 16 GB Mac down. A change to what every package's
// tests run under (the lockfile, the tier script) is left to CI, which runs
// every package anyway, and a selection reaching half the workspace or more
// runs one test file at a time. Only CI runs every package; nothing in CI
// calls this script. The first line names the packages that ran, or says
// that none did, and says what was left to CI and why: a run that tested
// nothing must not read as one that passed, nor a narrowed one as a full one.

import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

/** The root project: its own `test` script is the full suite of every
 *  package, so no selection here may include it. */
export const ROOT = "demoman-monorepo";

/**
 * Files outside any package, and the packages whose tests read them. `*` is
 * every package, which this script leaves to CI and names in its first
 * line. `test-changed.test.mjs` fails when a package test reads a
 * file outside the packages that no entry here names for it.
 *
 * @type {Array<[RegExp, "*" | string[]]>}
 */
export const READERS = [
  [/^(pnpm-lock\.yaml|pnpm-workspace\.yaml|tsconfig\.base\.json)$/, "*"],
  [/^scripts\/test-tier\.mjs$/, "*"],
  [/^brand\//, ["@demoman/cli", "@demoman/studio"]],
  [
    /^(apps\/docs\/|README\.md$|LICENSE$|scripts\/(changelog|docs-studio-stills)\.mjs$)/,
    ["@demoman/cli"],
  ],
];

/**
 * The pnpm `--filter` arguments for a branch's changed files, and why;
 * `filters` is null when no package is selected. `shared` lists the changed
 * files every package's tests read, which select nothing here.
 *
 * @param {string[]} changed repo-relative paths changed since the merge-base
 * @param {Array<{ name: string, dir: string }>} packages the workspace's
 *   packages, each `dir` repo-relative
 */
export function selection(changed, packages) {
  const owned = new Set();
  const readers = new Set();
  /** @type {string[]} */
  const shared = [];
  for (const file of changed) {
    const pkg = packages.find((p) => file.startsWith(`${p.dir}/`));
    if (pkg) {
      owned.add(pkg.name);
      continue;
    }
    for (const [pattern, who] of READERS) {
      if (!pattern.test(file)) continue;
      if (who === "*") shared.push(file);
      else for (const name of who) readers.add(name);
    }
  }
  if (owned.size === 0 && readers.size === 0) {
    return {
      filters: null,
      why: "no package changed, and no file a package's tests read",
      shared,
    };
  }
  return {
    filters: [
      ...[...owned].flatMap((name) => ["--filter", `...${name}`]),
      ...[...readers].flatMap((name) => ["--filter", name]),
      "--filter",
      `!${ROOT}`,
    ],
    why: "the packages changed, those that depend on them, and those whose tests read a changed file outside the packages",
    shared,
  };
}

/**
 * Whether a selection is wide enough to run one test file at a time. Half the
 * workspace is where it nears "every package": a base package like
 * scene-schema reaches 10 of 11. It counts packages in the dependency graph,
 * not a measured time, so the same branch always lands on the same side.
 *
 * @param {number} selectedCount
 * @param {number} workspaceCount
 */
export function oneWorker(selectedCount, workspaceCount) {
  return selectedCount * 2 >= workspaceCount;
}

/**
 * The environment the package tests run under: the fast tier, and one file
 * at a time when `single` (`testWorkers()` in scripts/test-tier.mjs reads it).
 *
 * @param {boolean} single
 * @param {NodeJS.ProcessEnv} env
 */
export function runEnv(single, env) {
  return {
    ...env,
    DEMOMAN_TEST_TIER: "fast",
    ...(single ? { DEMOMAN_TEST_WORKERS: "1" } : {}),
  };
}

/**
 * The first line of the run: the packages it tests, or that it tests none,
 * and what it left to CI.
 *
 * @param {string[]} names the packages pnpm selected
 * @param {string} why
 * @param {{ shared?: string[], single?: boolean }} [width]
 */
export function heading(names, why, { shared = [], single = false } = {}) {
  const notes = [
    shared.length > 0 &&
      `every package's tests read ${shared.join(", ")}, and every package at once took the Mac down on 2026-11-18, so that run is CI's`,
    single &&
      "one test file at a time: this selection is half the workspace or more (a run of all took the Mac down on 2026-11-18)",
  ].filter(Boolean);
  const tail = notes.map((n) => `; ${n}`).join("");
  if (names.length === 0) {
    return `demoman test:changed: no package tests ran: ${why}${tail} (the root scripts' own tests still run)`;
  }
  return `demoman test:changed: fast tier of ${names.join(", ")}: ${why}${tail}`;
}

/** The packages pnpm selects for these filters, the root left out.
 *  @param {string[]} filters */
export function selected(filters) {
  const out = execFileSync(
    "pnpm",
    ["ls", "-r", "--depth", "-1", "--json", ...filters],
    { encoding: "utf8" },
  );
  return JSON.parse(out)
    .filter((/** @type {{ name: string, path: string }} */ p) => p.name !== ROOT);
}

function main() {
  const git = (...args) =>
    execFileSync("git", args, { encoding: "utf8" }).trim();
  const top = git("rev-parse", "--show-toplevel");
  const base = git("merge-base", "origin/main", "HEAD");
  // Against the working tree, untracked files too: what is about to be
  // committed is what is about to be pushed.
  const changed = [
    ...git("diff", "--name-only", base).split("\n"),
    ...git("ls-files", "--others", "--exclude-standard").split("\n"),
  ].filter(Boolean);
  const packages = selected([]).map((p) => ({
    name: p.name,
    dir: p.path.slice(top.length + 1),
  }));
  const { filters, why, shared } = selection(changed, packages);
  const names = filters === null ? [] : selected(filters).map((p) => p.name);
  const single = names.length > 0 && oneWorker(names.length, packages.length);
  console.log(heading(names, why, { shared, single }));
  if (filters === null || names.length === 0) return;
  // One package at a time, the heavy packages' own limit (test:heavy): the
  // light ones together take seconds, so nothing is lost running them in line.
  const run = spawnSync(
    "pnpm",
    ["-r", "--workspace-concurrency=1", ...filters, "test"],
    {
      stdio: "inherit",
      env: runEnv(single, process.env),
    },
  );
  if (run.error) throw run.error;
  process.exit(run.status ?? 1);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();

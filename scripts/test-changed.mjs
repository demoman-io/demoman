#!/usr/bin/env node
// `pnpm test:changed`: the check before a push. The fast tier of the
// packages this branch changed since it left origin/main, and of every
// package that depends on them. CI runs the full tier of everything and is
// the merge gate; this is the quick local look before it (DEM-149).
//
// Some package tests read files outside any package: the cli's docs guards
// read apps/docs, the README and scripts/changelog.mjs. A change to one of
// those tests the packages that read it (READERS), and a change to what
// every package's tests run under (the lockfile, the tier script) tests all
// of them. The output names the packages that ran, or says that none did:
// a run that tested nothing must not read as one that passed.

import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

/** The root project: its own `test` script is the full suite of every
 *  package, so no selection here may include it. */
export const ROOT = "demoman-monorepo";

/**
 * Files outside any package, and the packages whose tests read them. `*` is
 * every package. `test-changed.test.mjs` fails when a package test reads a
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
 * `filters` is null when no package is selected.
 *
 * @param {string[]} changed repo-relative paths changed since the merge-base
 * @param {Array<{ name: string, dir: string }>} packages the workspace's
 *   packages, each `dir` repo-relative
 */
export function selection(changed, packages) {
  const owned = new Set();
  const readers = new Set();
  const everything = [];
  for (const file of changed) {
    const pkg = packages.find((p) => file.startsWith(`${p.dir}/`));
    if (pkg) {
      owned.add(pkg.name);
      continue;
    }
    for (const [pattern, who] of READERS) {
      if (!pattern.test(file)) continue;
      if (who === "*") everything.push(file);
      else for (const name of who) readers.add(name);
    }
  }
  if (everything.length > 0) {
    return {
      filters: ["--filter", `!${ROOT}`],
      why: `every package: ${everything.join(", ")} changed, and every package's tests read it`,
    };
  }
  if (owned.size === 0 && readers.size === 0) {
    return { filters: null, why: "no package changed, and no file a package's tests read" };
  }
  return {
    filters: [
      ...[...owned].flatMap((name) => ["--filter", `...${name}`]),
      ...[...readers].flatMap((name) => ["--filter", name]),
      "--filter",
      `!${ROOT}`,
    ],
    why: "the packages changed, those that depend on them, and those whose tests read a changed file outside the packages",
  };
}

/**
 * The first line of the run: the packages it tests, or that it tests none.
 *
 * @param {string[]} names the packages pnpm selected
 * @param {string} why
 */
export function heading(names, why) {
  if (names.length === 0) {
    return `demoman test:changed: no package tests ran: ${why} (the root scripts' own tests still run)`;
  }
  return `demoman test:changed: fast tier of ${names.join(", ")}: ${why}`;
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
  const { filters, why } = selection(changed, packages);
  const names = filters === null ? [] : selected(filters).map((p) => p.name);
  console.log(heading(names, why));
  if (filters === null || names.length === 0) return;
  // One package at a time, the heavy packages' own limit (test:heavy): the
  // light ones together take seconds, so nothing is lost running them in line.
  const run = spawnSync(
    "pnpm",
    ["-r", "--workspace-concurrency=1", ...filters, "test"],
    {
      stdio: "inherit",
      env: { ...process.env, DEMOMAN_TEST_TIER: "fast" },
    },
  );
  if (run.error) throw run.error;
  process.exit(run.status ?? 1);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();

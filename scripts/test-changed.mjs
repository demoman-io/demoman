#!/usr/bin/env node
// `pnpm test:changed`: the check before a push. The fast tier of the
// packages this branch changed since it left origin/main, and of every
// package that depends on them. CI runs the full tier of everything and is
// the merge gate; this is the quick local look before it (DEM-149).
//
// A change outside the packages that every package's tests still read (the
// lockfile, the workspace list, the base tsconfig, the tier script each
// vitest config imports) selects no package by path, so it tests all of
// them. The first line says which set ran and why: a run that tested
// nothing must not read as one that passed.

import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

/** Files outside any package that every package's tests depend on. */
const SHARED =
  /^(pnpm-lock\.yaml|pnpm-workspace\.yaml|tsconfig\.base\.json|scripts\/test-tier\.mjs|brand\/.*)$/;

/**
 * The pnpm `--filter` arguments for a branch, and the line that says why.
 *
 * @param {string} base the merge-base commit with origin/main
 * @param {string[]} changed repo-relative paths changed since `base`
 */
export function selection(base, changed) {
  const shared = changed.filter((f) => SHARED.test(f));
  if (shared.length > 0) {
    return {
      filters: [],
      why: `every package: ${shared.join(", ")} changed, and every package's tests read it`,
    };
  }
  return {
    // Not the root project: the filter selects it when a root file changed,
    // and its own `test` script is the full suite of every package.
    filters: ["--filter", `...[${base}]`, "--filter", "!demoman-monorepo"],
    why: `the packages changed since ${base.slice(0, 8)} (merge-base with origin/main) and their dependents`,
  };
}

function main() {
  const git = (...args) =>
    execFileSync("git", args, { encoding: "utf8" }).trim();
  const base = git("merge-base", "origin/main", "HEAD");
  // Against the working tree, as pnpm's own `[<commit>]` filter compares.
  const changed = [
    ...git("diff", "--name-only", base).split("\n"),
    ...git("ls-files", "--others", "--exclude-standard").split("\n"),
  ].filter(Boolean);
  const { filters, why } = selection(base, changed);
  console.log(`demoman test:changed: fast tier of ${why}`);
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

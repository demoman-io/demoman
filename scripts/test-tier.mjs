// The test tier a vitest config runs in, from DEMOMAN_TEST_TIER.
//
// `full` (the default, and what `pnpm test` and CI pin) runs every file.
// `fast` (`pnpm test:fast`, the development loop) skips files named
// `*.slow.test.ts`, the ones that render video in software, and says so: a
// fast run must never read as a full one.

import { globSync } from "node:fs";
import { basename } from "node:path";

/** @param {Record<string, string | undefined>} env */
export function testTier(env = process.env) {
  const tier = env.DEMOMAN_TEST_TIER;
  if (tier === undefined || tier === "" || tier === "full") return "full";
  if (tier === "fast") return "fast";
  throw new Error(`DEMOMAN_TEST_TIER must be "fast" or "full", got "${tier}"`);
}

/**
 * The globs a package's config adds to `exclude`: none in the full tier,
 * the slow files in the fast one, named in one `info` line.
 *
 * @param {string} pkgDir the package's directory; its `test/` is counted
 * @param {Record<string, string | undefined>} env
 * @param {(line: string) => void} say
 */
export function slowExcludes(
  pkgDir,
  env = process.env,
  say = (line) => console.info(line),
) {
  if (testTier(env) === "full") return [];
  const n = globSync("test/**/*.slow.test.ts", { cwd: pkgDir }).length;
  say(
    `demoman fast tier: ${basename(pkgDir)} skips ${n} slow test files (pnpm test runs them)`,
  );
  return ["**/*.slow.test.ts"];
}

/**
 * How many test files a package's vitest runs at once, as `{ minWorkers,
 * maxWorkers }` to spread into its `test` block.
 *
 * Off CI, vitest's default is one file per core but one, and the root
 * scripts used to test four packages at once: dozens of files together,
 * many of them launching a Chromium, some rendering 4K in software. That
 * took a 16 GB MacBook down more than once (2026-10-18). So off CI a
 * package runs `heavy` (it launches browsers) 2 files at once, otherwise 4,
 * and the root scripts test heavy packages one at a time (`test:heavy`) and
 * the others two at a time (`test:light`). `DEMOMAN_TEST_WORKERS`
 * overrides both numbers. CI keeps vitest's default: its jobs are sized
 * for it, and they do not go through the root scripts.
 *
 * @param {"heavy" | "light"} weight
 * @param {Record<string, string | undefined>} env
 * @returns {{ minWorkers?: number, maxWorkers?: number }}
 */
export function testWorkers(weight, env = process.env) {
  const given = env.DEMOMAN_TEST_WORKERS;
  if (given !== undefined && given !== "") {
    const n = Number(given);
    if (!Number.isInteger(n) || n < 1) {
      throw new Error(
        `DEMOMAN_TEST_WORKERS must be a whole number of 1 or more, got "${given}"`,
      );
    }
    return { minWorkers: 1, maxWorkers: n };
  }
  if (env.CI) return {};
  return { minWorkers: 1, maxWorkers: weight === "heavy" ? 2 : 4 };
}

/**
 * On CI, a test that fails once runs once more, as `{ retry, reporters }`
 * to spread into a heavy package's `test` block. CI's machines are ~5x
 * slower than a developer's Mac and shared: five red runs in two days
 * (2026-10-27..29) failed seven different timing and pixel-threshold tests,
 * none of them on a product bug.
 *
 * The retry forgives the run, not the reason. A test that passed on its
 * retry, or skipped itself with a note (a premise the machine was too slow
 * to set up), is one `::warning` annotation on the run's page. A real race
 * still shows: `unhurried-beats`' late last key failed 1 in 5, and a
 * retry fails twice in a row about 1 in 25.
 *
 * Off CI nothing changes: a local failure is the one to look at.
 *
 * @param {Record<string, string | undefined>} env
 * @param {(line: string) => void} say
 */
export function ciRetry(env = process.env, say = (line) => console.log(line)) {
  if (!env.CI) return {};
  /** @param {any} test vitest's TestCase */
  const onTestCaseResult = (test) => {
    const name = `${test.module.moduleId} > ${test.fullName}`;
    const result = test.result();
    if (test.diagnostic()?.flaky) {
      say(`::warning title=Passed on retry::${name}`);
    } else if (result.state === "skipped" && result.note) {
      say(`::warning title=Skipped::${name}: ${result.note}`);
    }
  };
  return {
    retry: 1,
    // Naming any reporter drops the github-actions one vitest adds itself.
    reporters: [
      "default",
      ...(env.GITHUB_ACTIONS === "true" ? ["github-actions"] : []),
      { onTestCaseResult },
    ],
  };
}

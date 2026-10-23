import assert from "node:assert/strict";
import {
  existsSync,
  globSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { slowExcludes, testTier, testWorkers } from "./test-tier.mjs";

test("an unset tier is the full one, and skips nothing", () => {
  assert.equal(testTier({}), "full");
  assert.deepEqual(
    slowExcludes("/nowhere", {}, () => assert.fail("logged")),
    [],
  );
});

test("the fast tier skips *.slow.test.ts and says how many", () => {
  const dir = mkdtempSync(join(tmpdir(), "demoman-tier-"));
  try {
    mkdirSync(join(dir, "test", "deep"), { recursive: true });
    for (const f of ["a.slow.test.ts", "deep/b.slow.test.ts", "c.test.ts"])
      writeFileSync(join(dir, "test", f), "");
    const said = [];
    const env = { DEMOMAN_TEST_TIER: "fast" };
    assert.deepEqual(
      slowExcludes(dir, env, (line) => said.push(line)),
      ["**/*.slow.test.ts"],
    );
    assert.equal(said.length, 1);
    assert.match(said[0], /skips 2 slow test files \(pnpm test runs them\)/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a tier it does not know is refused, not guessed", () => {
  assert.throws(
    () => testTier({ DEMOMAN_TEST_TIER: "quick" }),
    /DEMOMAN_TEST_TIER must be "fast" or "full", got "quick"/,
  );
});

test("off CI, a package runs 2 files at once if it launches browsers, else 4", () => {
  assert.deepEqual(testWorkers("heavy", {}), { minWorkers: 1, maxWorkers: 2 });
  assert.deepEqual(testWorkers("light", {}), { minWorkers: 1, maxWorkers: 4 });
});

test("CI keeps vitest's own default", () => {
  assert.deepEqual(testWorkers("heavy", { CI: "true" }), {});
});

test("DEMOMAN_TEST_WORKERS overrides both, and a bad one is refused", () => {
  const env = { DEMOMAN_TEST_WORKERS: "1", CI: "true" };
  assert.deepEqual(testWorkers("light", env), { minWorkers: 1, maxWorkers: 1 });
  assert.throws(
    () => testWorkers("heavy", { DEMOMAN_TEST_WORKERS: "0" }),
    /DEMOMAN_TEST_WORKERS must be a whole number of 1 or more, got "0"/,
  );
});

// Red when a package's vitest.config.ts says one weight and the root
// scripts run it as the other, or when a package with tests is in neither
// script (it would never run) or in both (it would run twice).
test("the root scripts run each package at the weight its config says", () => {
  const root = new URL("..", import.meta.url);
  const scripts = JSON.parse(
    readFileSync(new URL("package.json", root), "utf8"),
  ).scripts;
  const names = (script, pattern) =>
    new Set([...script.matchAll(pattern)].map((m) => m[1]));
  const heavyRun = names(scripts["test:heavy"], /--filter (@demoman\/\S+)/g);
  const lightSkips = names(scripts["test:light"], /--filter '!(@demoman\/\S+)'/g);
  // The workspace's own list, not every folder under apps/ and packages/:
  // a folder pnpm does not run (as apps/extension was between its
  // pages' move and its removal, 2026-10-20) has no weight to agree on.
  const workspace = readFileSync(new URL("pnpm-workspace.yaml", root), "utf8");
  const globs = [...workspace.matchAll(/^\s+-\s+"([^"]+)"/gm)].map((m) => m[1]);
  assert.ok(globs.length >= 2, `pnpm-workspace.yaml lists ${globs.join(", ")}`);
  const dirs = globs.flatMap((g) =>
    globSync(`${g}/package.json`, { cwd: root }),
  );
  const heavy = new Set();
  let tested = 0;
  for (const file of dirs) {
    const pkg = JSON.parse(readFileSync(new URL(file, root), "utf8"));
    if (!pkg.scripts?.test || !pkg.name?.startsWith("@demoman/")) continue;
    tested++;
    const config = new URL(file.replace("package.json", "vitest.config.ts"), root);
    if (
      existsSync(config) &&
      readFileSync(config, "utf8").includes('testWorkers("heavy")')
    ) {
      heavy.add(pkg.name);
    }
  }
  // Premise: the walk found the workspace, and some of it is heavy.
  assert.ok(tested >= 10, `found ${tested} packages with tests`);
  assert.ok(heavy.size >= 1, "no config says heavy");
  assert.deepEqual([...heavyRun].sort(), [...heavy].sort());
  assert.deepEqual([...lightSkips].sort(), [...heavy].sort());
});

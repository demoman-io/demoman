import assert from "node:assert/strict";
import { globSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  heading,
  oneWorker,
  READERS,
  ROOT,
  runEnv,
  selected,
  selection,
} from "./test-changed.mjs";

const packages = [
  { name: "@demoman/cli", dir: "apps/cli" },
  { name: "@demoman/runner", dir: "apps/runner" },
  { name: "@demoman/studio", dir: "apps/studio" },
];
const notRoot = ["--filter", `!${ROOT}`];

test("a change inside a package tests it and what depends on it", () => {
  const out = selection(["apps/runner/src/run.ts"], packages);
  assert.deepEqual(out.filters, ["--filter", "...@demoman/runner", ...notRoot]);
});

test("a change every package's tests read selects no extra package, and the heading leaves it to CI", () => {
  for (const shared of [
    "pnpm-lock.yaml",
    "pnpm-workspace.yaml",
    "tsconfig.base.json",
    "scripts/test-tier.mjs",
  ]) {
    const out = selection(["apps/cli/src/cli.ts", shared], packages);
    assert.deepEqual(out.filters, ["--filter", "...@demoman/cli", ...notRoot], shared);
    assert.deepEqual(out.shared, [shared]);
    assert.match(
      heading(["@demoman/cli"], out.why, out),
      new RegExp(`fast tier of @demoman/cli: .*every package's tests read ${shared}, .*so that run is CI's`),
    );
  }
  const alone = selection(["pnpm-lock.yaml"], packages);
  assert.equal(alone.filters, null);
  assert.match(
    heading([], alone.why, alone),
    /^demoman test:changed: no package tests ran: .*so that run is CI's/,
  );
});

test("a selection of half the workspace or more runs one file at a time, and says so", () => {
  assert.equal(oneWorker(10, 11), true);
  assert.equal(oneWorker(6, 12), true);
  assert.equal(oneWorker(5, 12), false);
  assert.equal(runEnv(true, {}).DEMOMAN_TEST_WORKERS, "1");
  assert.equal(runEnv(false, {}).DEMOMAN_TEST_WORKERS, undefined);
  assert.equal(runEnv(false, {}).DEMOMAN_TEST_TIER, "fast");
  assert.match(heading(["a"], "why", { single: true }), /one test file at a time/);
  assert.doesNotMatch(heading(["a"], "why"), /one test file at a time|CI's/);
});

test("a file outside the packages tests the packages that read it", () => {
  const cases = [
    ["apps/docs/guides/x.mdx", ["@demoman/cli"]],
    ["README.md", ["@demoman/cli"]],
    ["scripts/changelog.mjs", ["@demoman/cli"]],
    ["brand/logo.svg", ["@demoman/cli", "@demoman/studio"]],
  ];
  for (const [file, readers] of cases) {
    const out = selection([file], packages);
    assert.deepEqual(
      out.filters,
      [...readers.flatMap((r) => ["--filter", r]), ...notRoot],
      file,
    );
  }
});

test("a branch that changes no package and nothing one reads selects none, and says so", () => {
  const out = selection(
    [".github/workflows/ci-ts.yml", "scripts/release.mjs", "package.json"],
    packages,
  );
  assert.equal(out.filters, null);
  const line = heading([], out.why);
  assert.match(line, /no package tests ran/);
  assert.doesNotMatch(line, /fast tier of/);
});

test("the heading names the packages that ran", () => {
  assert.match(
    heading(["@demoman/runner", "@demoman/cli"], "why"),
    /fast tier of @demoman\/runner, @demoman\/cli: why/,
  );
});

// Against the real workspace and the pnpm it runs: the "every package"
// filter must not reach the root project (its `test` is the full suite),
// and a `...name` filter must bring the package's dependents.
test("pnpm resolves the filters as the script relies on", () => {
  const all = selected(notRoot).map((p) => p.name);
  assert.ok(all.includes("@demoman/runner"), all.join(" "));
  assert.ok(all.length >= 10, all.join(" "));
  assert.ok(!all.includes(ROOT), all.join(" "));
  const runCore = selected(["--filter", "...@demoman/run-core", ...notRoot]).map(
    (p) => p.name,
  );
  assert.ok(runCore.includes("@demoman/run-core"), runCore.join(" "));
  assert.ok(runCore.includes("@demoman/runner"), runCore.join(" "));
  assert.ok(!runCore.includes("@demoman/scene-schema"), runCore.join(" "));
  // The one-worker line on the real graph: a base package is wide, a leaf
  // app is not. Red if the graph or the threshold stops telling them apart.
  const wide = selected(["--filter", "...@demoman/scene-schema", ...notRoot]);
  assert.equal(oneWorker(wide.length, all.length), true, `${wide.length}/${all.length}`);
  const leaf = selected(["--filter", "...@demoman/studio", ...notRoot]);
  assert.equal(oneWorker(leaf.length, all.length), false, `${leaf.length}/${all.length}`);
});

// Red when a package test reads a file outside the packages by a relative
// path that READERS does not name for that package: a change to that file
// would leave the test that guards it unrun.
test("READERS names every file outside the packages a package test reads", () => {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const pkgs = selected([]).map((p) => ({
    name: p.name,
    dir: p.path.slice(root.length).replace(/\/$/, ""),
  }));
  const reads = [];
  for (const pkg of pkgs) {
    for (const file of globSync(`${pkg.dir}/test/**/*.{ts,mjs}`, {
      cwd: root,
    })) {
      if (!statSync(join(root, file)).isFile()) continue;
      const text = readFileSync(join(root, file), "utf8");
      for (const m of text.matchAll(/["'`]((?:\.\.\/)+[^"'`$\s]*)/g)) {
        const target = join(dirname(file), m[1]).replace(/\/$/, "");
        if (target.startsWith("..")) continue;
        // The repo root or a folder of packages, held to join package paths
        // onto (the cli's docs guards walk apps/*/src): those are package
        // changes, which select their dependents. A root file reached by such
        // a join is not seen here; name it with its own `../` path.
        if ([".", "apps", "packages"].includes(target)) continue;
        if (pkgs.some((p) => `${target}/`.startsWith(`${p.dir}/`))) continue;
        reads.push({ pkg: pkg.name, file, target });
      }
    }
  }
  // Premise: the scan finds the reads this list exists for.
  assert.ok(
    reads.some(
      (r) => r.pkg === "@demoman/cli" && r.target === "scripts/changelog.mjs",
    ),
    JSON.stringify(reads),
  );
  const uncovered = reads.filter(
    ({ pkg, target }) =>
      !READERS.some(
        ([pattern, who]) =>
          (pattern.test(target) || pattern.test(`${target}/`)) &&
          (who === "*" || who.includes(pkg)),
      ),
  );
  assert.deepEqual(uncovered, []);
});

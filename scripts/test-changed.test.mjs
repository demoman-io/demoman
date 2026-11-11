import assert from "node:assert/strict";
import { globSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  heading,
  READERS,
  ROOT,
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

test("a change every package's tests read tests every package, and names it", () => {
  for (const shared of [
    "pnpm-lock.yaml",
    "pnpm-workspace.yaml",
    "tsconfig.base.json",
    "scripts/test-tier.mjs",
  ]) {
    const out = selection(["apps/cli/src/cli.ts", shared], packages);
    assert.deepEqual(out.filters, notRoot, shared);
    assert.match(out.why, new RegExp(`every package: ${shared}`));
  }
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

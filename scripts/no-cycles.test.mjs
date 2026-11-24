import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { check, cycles, runtimeSpecifiers } from "./no-cycles.mjs";

/** A throwaway repo with these files, checked with these floors (none by
 *  default), under `under` if given; removed after. */
function repo(files, { min = 0, minImports = 0, under = "" } = {}) {
  const base = mkdtempSync(join(tmpdir(), "no-cycles-"));
  const root = join(base, under);
  try {
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), text);
    }
    return check({ root, min, minImports });
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

test("keeps only the imports that survive compilation", () => {
  const specs = runtimeSpecifiers(
    `import type { A } from "./a.js";
import { B } from "./b.js";
import { C } from "./c.js";
export { D } from "./d.js";
export type { E } from "./e.js";
const lazy = () => import("./f.js");
const x: C = B;`,
    "x.ts",
  );
  // ./c is used only as a type and ./f loads late: neither is a load-time edge.
  assert.deepEqual(specs, ["./b.js", "./d.js"]);
});

test("finds a two-file cycle and a file importing itself, and nothing else", () => {
  const g = new Map([
    ["a", new Set(["b"])],
    ["b", new Set(["a"])],
    ["c", new Set(["c"])],
    ["d", new Set(["a"])],
  ]);
  assert.deepEqual(cycles(g), [["a", "b"], ["c"]]);
});

test("a runtime cycle fails the check, naming both files", () => {
  const r = repo({
    "apps/x/src/a.ts": `import { b } from "./b.js";\nexport const a = () => b();`,
    "apps/x/src/b.ts": `import { a } from "./a.js";\nexport const b = () => a();`,
  });
  assert.deepEqual(r.problems, ["runtime cycle: apps/x/src/a.ts ↔ apps/x/src/b.ts"]);
});

test("a cycle of types alone passes", () => {
  const r = repo({
    "apps/x/src/a.ts": `import type { B } from "./b.js";\nexport type A = { b?: B };`,
    "apps/x/src/b.ts": `import type { A } from "./a.js";\nexport type B = { a?: A };`,
  });
  assert.deepEqual(r.problems, []);
  assert.equal(r.modules, 2);
});

test("a package importing an app fails, by name or by path", () => {
  const r = repo({
    "packages/p/src/x.ts": `import { run } from "@demoman/runner";\nimport { y } from "../../../apps/a/src/y.js";\nexport const x = () => [run, y];`,
    "apps/a/src/y.ts": "export const y = 1;",
  });
  assert.equal(r.problems.length, 2, r.problems.join("\n"));
  assert.ok(r.problems.every((p) => p.includes("a package never imports an app")));
});

test("a relative import that resolves to no file fails, an asset does not", () => {
  const r = repo({
    "apps/x/src/a.ts": `import { gone } from "./gone.js";\nimport css from "./a.css?raw";\nexport const a = [gone, css];`,
  });
  assert.deepEqual(r.problems, ["apps/x/src/a.ts: ./gone.js resolves to no file"]);
});

test("a walk that read too little fails rather than reading as no cycles", () => {
  const r = repo({ "apps/x/src/a.ts": "export const a = 1;" }, { min: 10 });
  assert.equal(r.problems.length, 1);
  assert.match(r.problems[0], /read only 1 modules, under 10/);
});

test("a walk that followed too few imports fails too", () => {
  const r = repo({ "apps/x/src/a.ts": "export const a = 1;" }, { minImports: 1 });
  assert.equal(r.problems.length, 1);
  assert.match(r.problems[0], /found only 0 runtime imports, under 1/);
});

// The bug the import floor caught on its first run: a checkout under a
// folder the walk skips (a worktree in .claude/worktrees) read every
// relative import as pointing into a skipped folder, and followed none.
test("a checkout under a skipped folder name still follows its imports", () => {
  const r = repo(
    {
      "apps/x/src/a.ts": `import { b } from "./b.js";\nexport const a = () => b();`,
      "apps/x/src/b.ts": `import { a } from "./a.js";\nexport const b = () => a();`,
    },
    { under: ".claude/worktrees/w" },
  );
  assert.deepEqual(r.problems, ["runtime cycle: apps/x/src/a.ts ↔ apps/x/src/b.ts"]);
  assert.equal(r.edges, 2);
});

test("a cycle through plain JavaScript modules is a cycle", () => {
  const r = repo({
    "apps/x/src/a.ts": `import { b } from "./b.mjs";\nexport const a = () => b();`,
    "apps/x/src/b.mjs": `import { a } from "./a.js";\nexport const b = () => a();`,
  });
  assert.deepEqual(r.problems, ["runtime cycle: apps/x/src/a.ts ↔ apps/x/src/b.mjs"]);
});

test("two packages that import each other by name are a package cycle", () => {
  const r = repo({
    "packages/p/package.json": JSON.stringify({ name: "@demoman/p" }),
    "packages/p/src/a.ts": `import { q } from "@demoman/q";\nexport const p = () => q();`,
    "packages/q/package.json": JSON.stringify({ name: "@demoman/q" }),
    "packages/q/src/b.ts": `import { p } from "@demoman/p/sub";\nexport const q = () => p();`,
  });
  assert.deepEqual(r.problems, ["package cycle: @demoman/p ↔ @demoman/q"]);
});

test("an import into a skipped folder (a build's dist/) is neither an edge nor a missing file", () => {
  const r = repo({ "apps/x/scripts/s.mjs": `import { run } from "../dist/index.js";\nrun();` });
  assert.deepEqual(r.problems, []);
  assert.equal(r.edges, 0);
});

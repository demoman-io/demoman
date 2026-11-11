import assert from "node:assert/strict";
import { test } from "node:test";
import { selection } from "./test-changed.mjs";

const base = "0123456789abcdef";

test("a branch inside the packages tests what changed and what depends on it", () => {
  const out = selection(base, [
    "apps/cli/src/cli.ts",
    "scripts/release.mjs",
    "apps/docs/index.mdx",
  ]);
  assert.deepEqual(out.filters, ["--filter", `...[${base}]`, "--filter", "!demoman-monorepo"]);
  assert.match(out.why, /changed since 01234567/);
});

test("a change every package's tests read tests every package, and names it", () => {
  for (const shared of [
    "pnpm-lock.yaml",
    "tsconfig.base.json",
    "scripts/test-tier.mjs",
    "brand/logo.svg",
  ]) {
    const out = selection(base, ["apps/cli/src/cli.ts", shared]);
    assert.deepEqual(out.filters, [], shared);
    assert.match(out.why, new RegExp(`every package: ${shared}`));
  }
});

test("the root package.json alone is not a change every package reads", () => {
  const out = selection(base, ["package.json", "apps/cli/package.json"]);
  assert.deepEqual(out.filters, ["--filter", `...[${base}]`, "--filter", "!demoman-monorepo"]);
});

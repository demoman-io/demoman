// scripts/no-tracker-ids.test.mjs
//
// The codebase names no tracker issue: no `DEM-<n>` id and no link to the
// tracker. The reason a line exists is written in the line; the history
// is in git. This lists every hit as path:line, so a cleanup has a meter.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BANNED = [/\bDEM-\d+\b/, /linear\.app\//];
const BINARY = /\.(png|jpe?g|gif|webp|mp4|webm|woff2?|ico|pdf)$/i;

const list = (cwd, prefix) =>
  execFileSync("git", ["ls-files", "-z"], { cwd, maxBuffer: 1 << 28 })
    .toString()
    .split("\0")
    .filter(Boolean)
    .map((f) => prefix + f)
    .filter(
      (f) =>
        !BINARY.test(f) &&
        !f.includes("/fixtures/") &&
        // Both are dated records kept as written.
        !f.startsWith("internal/docs/superpowers/") &&
        !f.startsWith("internal/docs/research/"),
    );

const product = list(ROOT, "");
// CI checks out the public repo alone: say so, never pass as if scanned.
const hasInternal = existsSync(join(ROOT, "internal"));
const internal = hasInternal ? list(join(ROOT, "internal"), "internal/") : [];
if (!hasInternal) console.log("no-tracker-ids: internal/ absent, skipped");
console.log(
  `no-tracker-ids: scanned ${product.length + internal.length} files (product ${product.length}, internal ${internal.length})`,
);

test("the codebase names no tracker issue", () => {
  const hits = [];
  for (const file of [...product, ...internal]) {
    const path = join(ROOT, file);
    if (!existsSync(path)) continue; // listed but deleted in the working tree
    for (const [i, line] of readFileSync(path, "utf8").split("\n").entries()) {
      if (BANNED.some((re) => re.test(line))) {
        hits.push(`${file}:${i + 1}: ${line.trim().slice(0, 160)}`);
      }
    }
  }
  assert.deepEqual(hits, [], `\n${hits.length} hits\n${hits.join("\n")}`);
});

test("it scanned the files it says it did", () => {
  assert.ok(product.length >= 1200, `product: ${product.length} files, expected 1200 or more`);
  if (hasInternal) {
    assert.ok(internal.length >= 200, `internal: ${internal.length} files, expected 200 or more`);
  }
});

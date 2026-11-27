// scripts/no-tracker-ids.test.mjs
//
// The codebase names no tracker issue: no `DEM-<n>` id and no link to the
// tracker. The reason a line exists is written in the line; the history
// is in git. This lists every hit as path:line, so a cleanup has a meter.
// It scans this repo only: internal/ is another repo with a guard of its
// own (internal/tools/no-tracker-ids.test.mjs).
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BANNED = [/\bDEM-\d+\b/, /linear\.app\//];
const BINARY = /\.(png|jpe?g|gif|webp|mp4|webm|woff2?|ico|pdf)$/i;

const listed = execFileSync("git", ["ls-files", "-z"], { cwd: ROOT, maxBuffer: 1 << 28 })
  .toString()
  .split("\0")
  .filter((f) => f && !BINARY.test(f));
// Listed but deleted in the working tree: named, never skipped in silence.
const missing = listed.filter((f) => !existsSync(join(ROOT, f)));
const scanned = listed.filter((f) => !missing.includes(f));
console.log(`no-tracker-ids: scanned ${scanned.length} files`);
if (missing.length > 0) {
  console.log(`no-tracker-ids: ${missing.length} listed files not on disk, unscanned: ${missing.join(", ")}`);
}

test("the codebase names no tracker issue", () => {
  const hits = [];
  for (const file of scanned) {
    for (const [i, line] of readFileSync(join(ROOT, file), "utf8").split("\n").entries()) {
      if (BANNED.some((re) => re.test(line))) {
        hits.push(`${file}:${i + 1}: ${line.trim().slice(0, 160)}`);
      }
    }
  }
  assert.deepEqual(hits, [], `\n${hits.length} hits\n${hits.join("\n")}`);
});

test("it scanned the files it says it did", () => {
  assert.ok(scanned.length >= 1200, `${scanned.length} files, expected 1200 or more`);
  // This file spells the patterns out: scanned, it must not match itself.
  assert.ok(scanned.includes("scripts/no-tracker-ids.test.mjs"), "this file was not scanned");
});

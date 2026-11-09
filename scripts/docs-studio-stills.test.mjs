// node --test scripts/docs-studio-stills.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";
import { staleShots, MAX_AGE_MS } from "./docs-studio-stills.mjs";

test("a shot older than the last lane run is refused, a fresh one passes", () => {
  const now = 1_000_000_000_000;
  const shots = [
    { name: "fresh.png", mtimeMs: now - 60_000 },
    { name: "weeks-old.png", mtimeMs: now - 21 * 24 * 3600_000 },
  ];
  // Premise: the window is shorter than three weeks and longer than a minute.
  assert.ok(MAX_AGE_MS > 60_000 && MAX_AGE_MS < 21 * 24 * 3600_000);
  assert.deepEqual(staleShots(shots, now), ["weeks-old.png"]);
});

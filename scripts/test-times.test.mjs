import assert from "node:assert/strict";
import { test } from "node:test";
import { loadCaches, summarize } from "./test-times.mjs";

const cache = (pkg, results) => ({ pkg, mtimeMs: 0, results });
const all = () => true;

test("sums each lane's files", () => {
  const out = summarize(
    [
      cache("apps/runner", [
        ["runner:test/a.test.ts", { duration: 1000 }],
        ["runner:test/b.test.ts", { duration: 2500 }],
      ]),
      cache("apps/studio", [
        ["node:test/node/c.test.ts", { duration: 400 }],
      ]),
    ],
    all,
  );
  assert.deepEqual(out.lanes, [
    { lane: "apps/runner runner", files: 2, ms: 3500 },
    { lane: "apps/studio node", files: 1, ms: 400 },
  ]);
});

test("drops and counts a file that no longer exists", () => {
  const out = summarize(
    [
      cache("apps/runner", [
        ["runner:test/kept.test.ts", { duration: 10 }],
        ["runner:test/gone.test.ts", { duration: 99_000 }],
      ]),
    ],
    (_pkg, file) => file !== "test/gone.test.ts",
  );
  assert.equal(out.stale, 1);
  assert.deepEqual(
    out.top.map((t) => t.file),
    ["test/kept.test.ts"],
  );
});

test("flags a 120 s file not marked slow, and not one that is", () => {
  const out = summarize(
    [
      cache("apps/runner", [
        ["runner:test/heavy.test.ts", { duration: 120_000 }],
        ["runner:test/heavy.slow.test.ts", { duration: 120_000 }],
        ["runner:test/light.test.ts", { duration: 5_000 }],
      ]),
    ],
    all,
  );
  assert.deepEqual(
    out.unmarked.map((t) => t.file),
    ["test/heavy.test.ts"],
  );
  assert.equal(out.top.find((t) => t.file.includes(".slow."))?.slow, true);
});

test("sorts the top files longest first", () => {
  const out = summarize(
    [
      cache("packages/compositor", [
        ["node:test/x.test.ts", { duration: 5 }],
        ["browser (chromium):test/y.test.ts", { duration: 50 }],
        [":test/z.test.ts", { duration: 20 }],
      ]),
    ],
    all,
  );
  assert.deepEqual(
    out.top.map((t) => [t.lane, t.ms]),
    [
      ["browser (chromium)", 50],
      ["", 20],
      ["node", 5],
    ],
  );
});

test("skips a cache it cannot parse, and names it", () => {
  const files = {
    "apps/runner/node_modules/.vite/vitest/a/results.json": JSON.stringify({
      results: [["runner:test/a.test.ts", { duration: 5 }]],
    }),
    "apps/cli/node_modules/.vite/vitest/b/results.json": "{\"results\": [[",
  };
  const out = loadCaches(Object.keys(files), (path) => ({
    text: files[path],
    mtimeMs: 0,
  }));
  assert.deepEqual(
    out.caches.map((c) => c.pkg),
    ["apps/runner"],
  );
  assert.equal(out.unreadable.length, 1);
  assert.equal(out.unreadable[0].path, "apps/cli/node_modules/.vite/vitest/b/results.json");
  assert.match(out.unreadable[0].reason, /JSON/);
});

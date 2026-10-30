import { globSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { configDefaults, defineConfig } from "vitest/config";
import {
  ciRetry,
  slowExcludes,
  testTier,
  testWorkers,
} from "../../scripts/test-tier.mjs";

/**
 * The node lane is deliberately NOT aliased to the other packages' `src`
 * the way `apps/extension`'s is. Its whole subject is what `dist` does under
 * node — an alias would make every assertion here vacuous.
 *
 * `server.deps.external` matters just as much and for the same reason.
 * Without it, Vitest's own module runner (vite-node) transforms every
 * non-external module through Vite's resolver, which tries appending
 * extensions and fully interops CJS — exactly the two things a real `node
 * --input-type=module -e "import(...)"` does NOT do. Left at Vitest's
 * default (only `node_modules` is external), this suite's five tests all
 * passed against a `dist` with 208 unresolvable extensionless specifiers and
 * against the unfixed `gifenc` CJS-interop failure alike — verified by
 * running it against both bugs before this option was added. Marking the
 * packages' own `dist/` external forces genuine native `import()` for
 * exactly the files this test exists to check, so a regression in either
 * hazard is observed here the same way `apps/runner` would hit it.
 */
const here = fileURLToPath(new URL(".", import.meta.url));
const fast = testTier() === "fast";
if (fast) {
  const n = globSync("test/integration/**/*.test.ts", { cwd: here }).length;
  console.info(
    `demoman fast tier: replay-engine skips the integration lane (${n} files; pnpm test runs them)`,
  );
}

// Real Chromium, driven from node over CDP (moved from apps/extension's
// integration lane, 2026-10-20): the only place the engine's protocol call
// sequence meets a real browser. The in-page browser lane cannot hold a
// debugger session, so it cannot cover this. Each file launches a Chromium
// of its own, so the fast tier skips the lane whole, as it did there.
// On CI a failed test here runs once more, and a pass on the retry is an
// annotation on the run (`ciRetry`); the other lanes are not retried.
const { retry, reporters } = ciRetry();
const integration = {
  test: {
    name: "integration",
    environment: "node" as const,
    include: ["test/integration/**/*.test.ts"],
    exclude: [...configDefaults.exclude, ...slowExcludes(here)],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    ...(retry && { retry }),
  },
};

export default defineConfig({
  test: {
    ...testWorkers("heavy"),
    ...(reporters && { reporters }),
    root: here,
    projects: [
      {
        test: {
          name: "node",
          environment: "node",
          include: ["test/node/**/*.test.ts"],
          server: {
            deps: {
              external: [/\/packages\/[^/]+\/dist\//],
            },
          },
        },
      },
      {
        // Moved from apps/extension's browser lane (2026-10-20): the
        // engine's in-page half, where an assertion depends on real layout,
        // scrolling or frames.
        test: {
          name: "browser",
          include: ["test/browser/**/*.test.ts"],
          browser: {
            enabled: true,
            provider: "playwright",
            headless: true,
            instances: [{ browser: "chromium" }],
          },
        },
      },
      ...(fast ? [] : [integration]),
    ],
  },
});

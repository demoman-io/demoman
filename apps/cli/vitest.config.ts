import { configDefaults, defineConfig } from "vitest/config";
import { testWorkers } from "../../scripts/test-tier.mjs";

/**
 * Reads the built package (`pkg/`, `build-meta/`, `plugin-out/`), so — like
 * apps/runner's lane — `pnpm -r test` alone is meaningless on a stale tree;
 * `pnpm test` builds first. `test-package/` is the by-hand lane
 * (`vitest.package.config.ts`).
 */
export default defineConfig({
  test: {
    ...testWorkers("heavy"),
    name: "cli",
    environment: "node",
    include: ["test/**/*.test.ts"],
    exclude: [...configDefaults.exclude, "test-package/**"],
    testTimeout: 30_000,
  },
});

import { defineConfig } from "vitest/config";
import { suiteLock } from "../../scripts/test-tier.mjs";

/** By hand before a release on a Mac (`pnpm test:package`), and in CI on
 *  Linux (.github/workflows/linux.yml) under xvfb-run, since signin and the
 *  Studio open visible windows. The runs and renders come from the packed
 *  install. */
export default defineConfig({
  test: {
    ...suiteLock(),
    name: "cli-package",
    environment: "node",
    include: ["test-package/**/*.test.ts"],
    testTimeout: 900_000,
    hookTimeout: 300_000,
  },
});

import { defineConfig } from "vitest/config";

/** By hand before a release (`pnpm test:package`), never CI: signin opens a
 *  visible window, and the runs and renders come from the packed install. */
export default defineConfig({
  test: {
    name: "cli-package",
    environment: "node",
    include: ["test-package/**/*.test.ts"],
    testTimeout: 900_000,
    hookTimeout: 300_000,
  },
});

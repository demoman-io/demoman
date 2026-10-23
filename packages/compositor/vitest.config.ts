import { defineConfig } from "vitest/config";
import { testWorkers } from "../../scripts/test-tier.mjs";

// A fixture belongs in the browser lane iff its assertion depends on
// rasterization or a real encoder. Everything else — geometry, timing,
// planning — is pure and runs in node.
export default defineConfig({
  test: {
    ...testWorkers("heavy"),
    projects: [
      {
        test: {
          name: "node",
          environment: "node",
          include: ["test/node/**/*.test.ts"],
        },
      },
      {
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
    ],
  },
});

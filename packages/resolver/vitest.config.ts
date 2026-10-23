import { defineConfig } from "vitest/config";
import { testWorkers } from "../../scripts/test-tier.mjs";

// Two lanes, deliberately. jsdom is fast and fictional about layout, real
// frames, and closed shadow roots; Chromium is honest and slow. A fixture
// belongs in the browser lane iff its assertion depends on layout, pixels,
// or a real frame/shadow boundary.
export default defineConfig({
  test: {
    ...testWorkers("heavy"),
    projects: [
      {
        test: {
          name: "node",
          environment: "jsdom",
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

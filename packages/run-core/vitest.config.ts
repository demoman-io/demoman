import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import { testWorkers } from "../../scripts/test-tier.mjs";

// The moved unit tests ran in the extension's node lane, which is jsdom; they
// keep that environment here. `server.deps.external` makes the dist-loads test
// import `dist` the way raw node does — without it vite-node forgives an
// extensionless specifier and the test is green against a dist node rejects
// (CLAUDE.md, the `dist` note).
export default defineConfig({
  test: {
    ...testWorkers("heavy"),
    root: fileURLToPath(new URL(".", import.meta.url)),
    projects: [
      {
        test: {
          name: "node",
          include: ["test/node/**/*.test.ts"],
          environment: "jsdom",
          server: { deps: { external: [/\/packages\/[^/]+\/dist\//] } },
        },
      },
      {
        // Moved from apps/extension's browser lane (2026-10-20):
        // `snapshotTargets` against real layout, shadow roots and frames.
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

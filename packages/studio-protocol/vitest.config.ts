import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import { testWorkers } from "../../scripts/test-tier.mjs";

/**
 * `server.deps.external` forces native `import()` for the packages' own
 * `dist/`, so `dist-loads.test.ts` loads the emit the way `apps/mcp` will
 * under node. Without it vite-node's resolver forgives an extensionless
 * relative import and the test passes against a `dist` node rejects.
 */
export default defineConfig({
  test: {
    ...testWorkers("light"),
    name: "node",
    environment: "node",
    include: ["test/node/**/*.test.ts"],
    root: fileURLToPath(new URL(".", import.meta.url)),
    server: {
      deps: {
        external: [/\/packages\/[^/]+\/dist\//],
      },
    },
  },
});

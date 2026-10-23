import { defineConfig } from "vitest/config";
import { testWorkers } from "../../scripts/test-tier.mjs";

/**
 * Runs against `@demoman/agent-bridge`'s `dist`, as the bin does under node.
 * `server.deps.external` keeps vite-node from forgiving what node would not
 * (CLAUDE.md, the `dist` section). `pnpm -r test` does not build: run
 * `pnpm test`, or build first.
 */
export default defineConfig({
  test: {
    ...testWorkers("light"),
    name: "mcp",
    environment: "node",
    include: ["test/**/*.test.ts"],
    testTimeout: 20_000,
    server: {
      deps: {
        external: [/\/packages\/[^/]+\/dist\//],
      },
    },
  },
});

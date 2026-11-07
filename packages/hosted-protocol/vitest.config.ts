import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import { testWorkers } from "../../scripts/test-tier.mjs";

export default defineConfig({
  test: {
    ...testWorkers("light"),
    environment: "node",
    include: ["test/**/*.test.ts"],
    root: fileURLToPath(new URL(".", import.meta.url)),
  },
});

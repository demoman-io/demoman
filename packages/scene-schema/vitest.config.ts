import { defineConfig } from "vitest/config";
import { testWorkers } from "../../scripts/test-tier.mjs";

export default defineConfig({
  test: { ...testWorkers("light") },
});

import { mergeConfig } from "vitest/config";
import base, { BENCH } from "./vitest.config";

/**
 * The runner's benches: the lane's own config (`dist`-only resolution, the
 * `server.deps.external` line, the timeouts) with only the file set swapped.
 * `mergeConfig` concatenates arrays, so `include` and `exclude` are replaced
 * outright below rather than merged — merged, the base's exclude would
 * remove every file this config exists to run.
 */
const merged = mergeConfig(base, { test: { name: "runner-bench" } });
merged.test = { ...merged.test, include: [BENCH], exclude: [] };

export default merged;

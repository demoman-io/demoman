import { fileURLToPath } from "node:url";
import { EXPORT_QUALITY_VALUES, PULL_REQUESTS_VALUES } from "@demoman/run-core";
import { describe, expect, it } from "vitest";
import { realSetupDeps, SETUP_HINTS } from "../src/setup-deps.js";

const dist = fileURLToPath(new URL("../pkg/dist", import.meta.url));
const io = (stdinTTY: boolean, stdoutTTY: boolean, env = {}) => ({
  stdinTTY,
  stdoutTTY,
  env,
});

describe("setup's questions, for real", () => {
  // An agent's shell, a pipe or CI: nobody can answer, so nothing is asked.
  it("asks nothing when stdin, stdout or CI says there is no one to answer", () => {
    expect(realSetupDeps("0.0.0", dist, io(false, true)).ask).toBeNull();
    expect(realSetupDeps("0.0.0", dist, io(true, false)).ask).toBeNull();
    expect(
      realSetupDeps("0.0.0", dist, io(true, true, { CI: "true" })).ask,
    ).toBeNull();
  });

  it("asks in a terminal", () => {
    expect(typeof realSetupDeps("0.0.0", dist, io(true, true)).ask).toBe(
      "function",
    );
  });

  it("has a one-line hint for every quality and every pull-request value", () => {
    for (const v of [...EXPORT_QUALITY_VALUES, ...PULL_REQUESTS_VALUES]) {
      const hint = (SETUP_HINTS as Record<string, string>)[v];
      expect(hint, v).toMatch(/^\S.*\.$/);
      expect(hint, v).not.toContain("\n");
    }
  });
});

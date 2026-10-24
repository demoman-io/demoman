import { readFileSync } from "node:fs";
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

describe("the setup command Demoman hands an agent", () => {
  // Read as text: main.ts runs the CLI on import.
  const main = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");
  // And --prefix ~/: the agent runs it in the repo it opened, whose
  // node_modules and .npmrc must not choose what runs (audit run 1).
  it("says --yes, so a run in an agent's pseudo-terminal never waits on a menu", () => {
    for (const key of ["installCommand", "updateCommand"]) {
      const line = new RegExp(
        `${key}: \`npx --prefix ~/ \\$\\{PACKAGE_NAME\\}@[^\`]* setup([^\`]*)\``,
      ).exec(main);
      expect(line, key).not.toBeNull();
      expect(line?.[1], key).toBe(" --yes");
    }
  });

  it("hands out no npx command without the prefix", () => {
    // Sign-in and reinstall commands too: the agent or the person runs them
    // in the repo too. Red with any `npx demoman…` left bare.
    const commands = main.match(/`npx [^`]*/g) ?? [];
    expect(commands.length).toBeGreaterThanOrEqual(6);
    for (const c of commands) expect(c).toMatch(/^`npx --prefix ~\/ /);
  });
});

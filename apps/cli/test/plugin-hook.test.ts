import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

// The built hook wrapper, run as Claude Code runs it, with
// DEMOMAN_HOOK_COMMAND pointing at a stub that logs being started.
const script = fileURLToPath(
  new URL("../plugin-out/hooks/post-tool-use.sh", import.meta.url),
);

const made: string[] = [];
afterEach(() => {
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
});

const STUB_ANSWER =
  '{"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":"stub"}}';

/** A stub CLI that appends its stdin to a log, waits `sleep` seconds, then
 *  prints `out` and exits `code`. */
function stub(out: string, code = 0, sleep = 0) {
  const dir = mkdtempSync(join(tmpdir(), "demoman-hook-"));
  made.push(dir);
  const log = join(dir, "log");
  writeFileSync(log, "");
  const bin = join(dir, "stub");
  writeFileSync(
    bin,
    `#!/bin/sh\ncat >> "${log}"\nsleep ${sleep}\nprintf '%s' '${out}'\nexit ${code}\n`,
  );
  chmodSync(bin, 0o755);
  return { bin, log };
}

function run(
  bin: string,
  command: string,
  stdout = "https://github.com/o/r/pull/1",
  env: Record<string, string> = {},
) {
  const r = spawnSync("sh", [script, "0.0.0"], {
    input: JSON.stringify({
      cwd: "/nowhere",
      tool_name: "Bash",
      tool_input: { command },
      tool_response: { stdout },
    }),
    env: { ...process.env, DEMOMAN_HOOK_COMMAND: bin, ...env },
    encoding: "utf8",
  });
  expect(r.status).toBe(0);
  return r.stdout;
}

describe("the plugin's PostToolUse wrapper", () => {
  it("a call that cannot have opened a PR never starts the CLI", () => {
    const s = stub(STUB_ANSWER);
    expect(run(s.bin, "ls -la")).toBe("");
    expect(readFileSync(s.log, "utf8")).toBe("");
  });

  it("gh pr create reaches the CLI, and its answer is printed", () => {
    const s = stub(STUB_ANSWER);
    expect(run(s.bin, "cd x && gh pr create --fill").trim()).toBe(STUB_ANSWER);
    expect(readFileSync(s.log, "utf8")).toContain("gh pr create");
  });

  it("a CLI with nothing to say (an off repo) leaves the agent nothing", () => {
    const s = stub("");
    expect(run(s.bin, "gh pr create --fill")).toBe("");
    expect(readFileSync(s.log, "utf8")).toContain("gh pr create");
  });

  it("a CLI that fails is answered as could-not-check, never silence", () => {
    const s = stub("", 1);
    const out = JSON.parse(run(s.bin, "gh pr create --fill"));
    expect(out.hookSpecificOutput.hookEventName).toBe("PostToolUse");
    expect(out.hookSpecificOutput.additionalContext).toContain(
      "did not answer",
    );
  });

  // Final review I-1: a pattern with two parts rescanned the input at every
  // "gh", 45 s on a megabyte of prose. Red if the filter is quadratic again.
  it("drops a large output full of gh without scanning it over and over", () => {
    const s = stub(STUB_ANSWER);
    const prose = "the right thing through the night, high and high. ".repeat(
      8000,
    );
    // Premise: the output is large and full of "gh", with no "pr create".
    expect(prose.length).toBeGreaterThan(300_000);
    expect(prose.split("gh").length).toBeGreaterThan(30_000);
    expect(prose).not.toContain("pr create");
    const started = Date.now();
    expect(run(s.bin, "cat notes.txt", prose)).toBe("");
    expect(Date.now() - started).toBeLessThan(1500);
    expect(readFileSync(s.log, "utf8")).toBe("");
  });

  // Final review I-2: a hook Claude Code kills at its timeout says nothing.
  it("a CLI still running at the wrapper's deadline is said as could-not-check", () => {
    const s = stub(STUB_ANSWER, 0, 10);
    const started = Date.now();
    const out = JSON.parse(
      run(s.bin, "gh pr create --fill", undefined, {
        DEMOMAN_HOOK_DEADLINE: "1",
      }),
    );
    expect(Date.now() - started).toBeLessThan(5000);
    expect(out.hookSpecificOutput.additionalContext).toContain(
      "did not answer within 1 s",
    );
  }, 15_000);
});

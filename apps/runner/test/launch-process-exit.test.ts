import { spawn } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const FIXTURE = join(import.meta.dirname, "fixtures", "launch-crash-close.mjs");

// Measured (post-fix, this machine, three runs): the fixture itself takes
// 3.9-7.5s from spawn to a natural exit (Chromium launch, an 80-copy base64
// crash and its own crash-recovery relaunch cost, then close()). Against the
// unfixed code the child does not exit at all — reproduced 3/3 by the
// reviewer, and reproduced again for this fix (see the report's "before"
// run: the bound was hit every time, with close() already resolved and
// nothing left printed). So this bound is not a tight timing budget, it is
// "did the process end on its own, ever" — and it has to stay well clear of
// a false failure on a slow box: this project's own vitest.config.ts
// measures CI at ~5x this machine for browser work, and 5 * the slowest
// local run (7.5s) is ~37.5s. 60s clears that with real headroom left,
// matching the project's own testTimeout floor (60_000, set in
// vitest.config.ts) rather than inventing a smaller number that only
// reflects this one machine.
const BOUND_MS = 60_000;

/**
 * The property under test cannot be observed from inside this test's own
 * process: `close()` resolving is not the claim, the whole NODE PROCESS
 * exiting afterward is. So this spawns `launch-crash-close.mjs` as a real
 * child, which does launch() -> crash the browser (Task 6's ~70-large-frame
 * page.evaluate boundary) -> close() -> nothing else, and asserts the child
 * exits on its own within a bounded time. A test that only asserted
 * `close()` resolves would pass on the unfixed code too (measured: it does,
 * in 1-2ms) and would prove nothing about the hang — exactly the vacuous
 * shape this plan has already produced six of.
 */
describe("launch's process-exit property", () => {
  it(
    "a node process that launches, crashes the browser, and calls close() exits on its own with no more work to do",
    async () => {
      const child = spawn(process.execPath, [FIXTURE], {
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout?.on("data", (chunk: Buffer) => {
        stdout += chunk.toString();
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });

      const result = await new Promise<{
        code: number | null;
        timedOut: boolean;
      }>((resolve) => {
        const timer = setTimeout(() => {
          child.kill("SIGKILL");
          resolve({ code: null, timedOut: true });
        }, BOUND_MS);
        child.on("exit", (code) => {
          clearTimeout(timer);
          resolve({ code, timedOut: false });
        });
      });

      if (result.timedOut) {
        throw new Error(
          `child did not exit within ${BOUND_MS}ms after launch()/crash/close() ` +
            `— it is hanging on a live handle rather than exiting. ` +
            `stdout:\n${stdout}\nstderr:\n${stderr}`,
        );
      }
      // Not just "it exited" — it exited having actually reached and finished
      // close(), and cleanly (code 0), not via some unrelated early failure.
      expect(stdout).toContain("CRASHED_AND_CLOSED_OK");
      expect(result.code).toBe(0);
      // vitest's own timeout for this test, kept comfortably above BOUND_MS
      // so a genuine timeout is reported as "child hung" (this test's own
      // thrown Error, with stdout/stderr attached) rather than as a vitest
      // timeout with none of that context.
    },
    BOUND_MS + 15_000,
  );
});

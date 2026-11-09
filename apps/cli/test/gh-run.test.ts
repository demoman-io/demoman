import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { realGh } from "../src/gh-run.js";

const made: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("realGh", () => {
  // DEM-90. Red while realGh starts gh with the plain environment: the git
  // gh runs in the repo then runs the program the repo's config names.
  it("starts gh so the git it runs carries the fsmonitor guard", async () => {
    const repo = mkdtempSync(join(tmpdir(), "gh-run-repo-"));
    const bin = mkdtempSync(join(tmpdir(), "gh-run-bin-"));
    made.push(repo, bin);
    const git = (...a: string[]) =>
      execFileSync("git", a, { cwd: repo, stdio: "pipe" });
    git("init", "-q");
    const marker = join(repo, "fsmonitor-ran");
    const hook = join(repo, "hook.sh");
    writeFileSync(hook, `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o755 });
    git("config", "core.fsmonitor", hook);
    // Premise: git does run it while reading the index here.
    git("status", "--short");
    expect(existsSync(marker)).toBe(true);
    rmSync(marker);
    // A gh that does what `gh pr create` does first: asks git for status.
    writeFileSync(
      join(bin, "gh"),
      "#!/bin/sh\ngit status --short >/dev/null && echo asked\n",
      { mode: 0o755 },
    );
    vi.stubEnv("PATH", `${bin}:${process.env.PATH}`);
    const r = await realGh(repo)(["pr", "create"]);
    expect(r).toMatchObject({ code: 0, stdout: "asked\n" });
    expect(existsSync(marker)).toBe(false);
  });
});

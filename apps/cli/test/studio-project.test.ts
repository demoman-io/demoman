import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execGit, type GitRunner, readRepo } from "@demoman/runner/package";
import { afterAll, describe, expect, it } from "vitest";
import { callerProject } from "../src/studio-project";

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "demoman-proj-")));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

describe("callerProject", () => {
  it("studio in a repo opens on that repo's project", async () => {
    const dir = join(scratch, "repo");
    execFileSync("git", ["init", "-q", "-b", "main", dir]);
    const read = await readRepo(dir, execGit);
    // The premise: the fixture is a repo with a key.
    expect(read.ok).toBe(true);
    // Red: answer undefined for a repo.
    expect(await callerProject(dir)).toEqual({
      key: read.ok ? read.repo.key : "?",
    });
  });

  it("outside a repo there is no project", async () => {
    // Red: report "not a git checkout" as a reason.
    expect(await callerProject(scratch)).toEqual({});
  });

  it("a repo git cannot read says why, and has no key", async () => {
    let n = 0;
    const git: GitRunner = async () =>
      n++ === 0
        ? { code: 0, stdout: "/x\n", stderr: "" }
        : { code: 1, stdout: "", stderr: "boom" };
    // Red: fold every failure into {}.
    expect(await callerProject(scratch, git)).toEqual({
      why: "git could not find the repository: boom",
    });
  });
});

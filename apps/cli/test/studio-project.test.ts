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
    // The premise: git itself says this folder is not a repository.
    const read = await readRepo(scratch, execGit);
    expect(read.ok ? "" : read.none).toContain("not a git repository");
    // Red: report "not a git checkout" as a reason.
    expect(await callerProject(scratch)).toEqual({});
  });

  it("a refusal at the first git step (dubious ownership) says why", async () => {
    const git: GitRunner = async () => ({
      code: 128,
      stdout: "",
      stderr: "fatal: detected dubious ownership in repository at '/x'",
    });
    const got = await callerProject(scratch, git);
    // Red: treat every first-step failure as "not a repository".
    expect(got.key).toBeUndefined();
    expect(got.why).toContain("dubious ownership");
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

  // Red when a server whose folder was deleted throws uv_cwd instead of
  // opening the Studio without a project (DEM-51).
  it("a working folder that no longer exists opens without a project, saying why", async () => {
    const gone = () => {
      throw new Error("ENOENT: no such file or directory, uv_cwd");
    };
    const got = await callerProject(gone);
    expect(got.key).toBeUndefined();
    expect(got.why).toContain("no longer exists");
  });
});

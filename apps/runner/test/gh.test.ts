import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createGh, defaultGhRun, type GhRun } from "../src/executor/gh.js";

type Answer = {
  code?: number;
  stdout?: string;
  stderr?: string;
  hang?: true;
};

let dir: string;
let bin: string;
let logPath: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "demoman-gh-"));
  bin = join(dir, "bin");
  logPath = join(dir, "calls.log");
  await writeFile(logPath, "");
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

// Installs the fake as `gh` in a folder of its own and answers the env that
// puts only that folder on PATH. Real gh is never reachable from it.
async function fakeGh(
  script: Record<string, Answer>,
  checkTimeoutMs?: number,
  uploadTimeoutMs?: number,
  run: GhRun = defaultGhRun,
) {
  const { mkdir } = await import("node:fs/promises");
  await mkdir(bin, { recursive: true });
  const scriptPath = join(dir, "script.json");
  await writeFile(scriptPath, JSON.stringify(script));
  const fake = join(process.cwd(), "test", "fake-gh.mjs");
  const shim = join(bin, "gh");
  await writeFile(
    shim,
    `#!/bin/sh\nexec "${process.execPath}" "${fake}" "$@"\n`,
  );
  await chmod(shim, 0o755);
  const env: NodeJS.ProcessEnv = {
    PATH: bin,
    FAKE_GH_SCRIPT: scriptPath,
    FAKE_GH_LOG: logPath,
  };
  return {
    gh: createGh(run, dir, env, checkTimeoutMs, uploadTimeoutMs),
    env,
  };
}
async function calls(): Promise<string[][]> {
  return (await readFile(logPath, "utf8"))
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as string[]);
}
const signedIn: Answer = { code: 0, stderr: "Logged in to github.com\n" };
const v = (n: string): Answer => ({
  code: 0,
  stdout: `gh version ${n} (2026-09-30)\nhttps://github.com/cli/cli/releases/tag/v${n}\n`,
});

describe("gh adapter", () => {
  it("ENOENT is ghMissing and names PATH", async () => {
    const emptyPath = join(dir, "nothing-here");
    const gh = createGh(defaultGhRun, dir, { PATH: emptyPath });
    const out = await gh.ready();
    expect(out?.reason).toBe("ghMissing");
    expect(out?.detail).toContain(emptyPath);
    expect(out?.detail).toContain("brew install gh");
  });

  it("2.98.0 is ghOutdated and names the version", async () => {
    const { gh } = await fakeGh({ "--version": v("2.98.0") });
    const out = await gh.ready();
    expect(out?.reason).toBe("ghOutdated");
    expect(out?.detail).toContain("2.98.0");
  });

  it("2.102.0 passes", async () => {
    const { gh } = await fakeGh({
      "--version": v("2.102.0"),
      "auth status --hostname github.com": signedIn,
    });
    expect(await gh.ready()).toBeNull();
    expect((await calls()).map((c) => c[0])).toEqual(["--version", "auth"]);
  });

  it("not signed in is ghSignedOut and names gh auth login", async () => {
    const { gh } = await fakeGh({
      "--version": v("2.102.0"),
      "auth status": {
        code: 1,
        stderr: "You are not logged into any GitHub hosts.\n",
      },
    });
    const out = await gh.ready();
    expect(out?.reason).toBe("ghSignedOut");
    expect(out?.detail).toContain("gh auth login");
    expect(out?.detail).toContain("not logged into");
  });

  it("no PR for the branch is prNotFound", async () => {
    const line = 'no pull requests found for branch "x"';
    const { gh } = await fakeGh({
      "pr view": { code: 1, stderr: `${line}\n` },
    });
    const out = await gh.pr();
    expect(out).toMatchObject({ reason: "prNotFound" });
    expect((out as { detail: string }).detail).toContain(line);
  });

  // gh 2.102.0's own words, run in a checkout whose only remote is
  // gitlab.com (and the same for an unknown GitHub Enterprise host).
  const NOT_GITHUB_LINE =
    "none of the git remotes configured for this repository point to a known GitHub host. To tell gh about a new GitHub host, please use `gh auth login`";

  it("a checkout with no github.com remote is notGitHub, saying what gh said", async () => {
    const { gh } = await fakeGh({
      "pr view": { code: 1, stderr: `${NOT_GITHUB_LINE}\n` },
    });
    const out = await gh.pr();
    expect(out).toMatchObject({ reason: "notGitHub" });
    const detail = (out as { detail: string }).detail;
    expect(detail).toContain("github.com");
    expect(detail).toContain(NOT_GITHUB_LINE);
  });

  it("a checkout with no remote at all stays prNotFound: no pull request can exist", async () => {
    const { gh } = await fakeGh({
      "pr view": { code: 1, stderr: "no git remotes found\n" },
    });
    const out = await gh.pr();
    expect(out).toMatchObject({ reason: "prNotFound" });
    expect((out as { detail: string }).detail).toContain(
      "no git remotes found",
    );
  });

  it("a PR answers number, url and host, and an explicit number is passed", async () => {
    const { gh } = await fakeGh({
      "pr view": {
        code: 0,
        stdout: JSON.stringify({
          number: 7,
          url: "https://github.com/o/r/pull/7",
        }),
      },
    });
    expect(await gh.pr(7)).toEqual({
      number: 7,
      url: "https://github.com/o/r/pull/7",
      host: "github.com",
    });
    expect((await calls())[0]).toEqual([
      "pr",
      "view",
      "7",
      "--json",
      "number,url",
    ]);
  });

  it("a GHES URL is notGitHub", async () => {
    const { gh } = await fakeGh({
      "pr view": {
        code: 0,
        stdout: JSON.stringify({
          number: 3,
          url: "https://git.corp.example/o/r/pull/3",
        }),
      },
    });
    const out = await gh.pr();
    expect(out).toMatchObject({ reason: "notGitHub" });
    expect((out as { detail: string }).detail).toContain("git.corp.example");
  });

  it("description and comment argv", async () => {
    const { gh } = await fakeGh({
      "pr edit": { code: 0, stdout: "ok" },
      "pr comment": { code: 1, stderr: "boom" },
    });
    expect(await gh.attachToDescription(7, "/t/a.mp4")).toEqual({
      code: 0,
      stdout: "ok",
      stderr: "",
    });
    expect(await gh.attachToComment(7, "/t/a.mp4", "hello")).toMatchObject({
      code: 1,
      stderr: "boom",
    });
    expect(await calls()).toEqual([
      ["pr", "edit", "7", "--attach", "/t/a.mp4"],
      ["pr", "comment", "7", "--body", "hello", "--attach", "/t/a.mp4"],
    ]);
  });

  it("readBack answers body and comments, and says why when gh fails", async () => {
    const { gh } = await fakeGh({
      "pr view": {
        code: 0,
        stdout: JSON.stringify({
          body: "b",
          comments: [{ body: "c", createdAt: "2026-10-18T00:00:00Z", x: 1 }],
        }),
      },
    });
    expect(await gh.readBack(7)).toEqual({
      body: "b",
      comments: [{ body: "c", createdAt: "2026-10-18T00:00:00Z" }],
    });
    const failing = await fakeGh({ "pr view": { code: 1, stderr: "nope" } });
    expect(await failing.gh.readBack(7)).toEqual({
      unreadable: "gh pr view 7 --json body,comments failed (exit 1): nope",
    });
  });

  // Red without the check timeout: a `gh auth status` waiting on a keychain
  // prompt holds attach, and the slot, until someone notices.
  it("a check gh never answers is a named refusal that says it timed out", async () => {
    // The 300 ms ceiling is for the hang alone: a node process start under a
    // loaded runner can outlast it, so `--version` is answered in-process
    // and only `auth status` runs the fake, which hangs.
    const seen: string[] = [];
    const run: GhRun = (args, opts) => {
      seen.push(args.join(" "));
      if (args[0] === "--version") {
        return Promise.resolve({
          code: 0,
          stdout: "gh version 2.102.0 (2026-09-30)\n",
          stderr: "",
        });
      }
      return defaultGhRun(args, opts);
    };
    const { gh } = await fakeGh(
      { "auth status": { hang: true } },
      300,
      undefined,
      run,
    );
    const out = await gh.ready();
    expect(out?.reason, JSON.stringify(out)).toBe("ghSignedOut");
    expect(out?.detail, JSON.stringify(out)).toContain(
      "gh auth status --hostname github.com timed out",
    );
    expect(out?.detail, JSON.stringify(out)).toContain(
      "did not answer within 300 ms",
    );
    // Premise: the hang was reached, not refused earlier.
    expect(seen.map((c) => c.split(" ")[0])).toEqual(["--version", "auth"]);
    expect((await calls()).map((c) => c[0])).toEqual(["auth"]);
  });

  // Red without the upload ceiling: a stalled `gh pr edit --attach` holds the
  // slot for ever, and nothing says why.
  it("an upload gh never finishes is stopped and said as a failed exit that names the limit", async () => {
    const { gh } = await fakeGh({ "pr edit": { hang: true } }, undefined, 300);
    const out = await gh.attachToDescription(7, "/t/a.mp4");
    expect(out, JSON.stringify(out)).toMatchObject({ code: 124 });
    expect(out.stderr, JSON.stringify(out)).toContain(
      "did not finish within 300 ms",
    );
    // Premise: the upload was reached.
    expect((await calls()).map((c) => c.slice(0, 2).join(" "))).toEqual([
      "pr edit",
    ]);
  });

  it("a pr view or a read-back gh never answers says it timed out", async () => {
    const { gh } = await fakeGh({ "pr view": { hang: true } }, 300);
    const out = await gh.pr(7);
    expect(out).toMatchObject({ reason: "prNotFound" });
    expect((out as { detail: string }).detail).toContain(
      "gh pr view 7 --json number,url timed out",
    );
    expect(await gh.readBack(7)).toEqual({
      unreadable: expect.stringContaining(
        "gh pr view 7 --json body,comments timed out",
      ),
    });
  });

  it("a gh --version that never answers is ghMissing, timed out", async () => {
    const { gh } = await fakeGh({ "--version": { hang: true } }, 300);
    const out = await gh.ready();
    expect(out?.reason).toBe("ghMissing");
    expect(out?.detail).toContain("gh --version timed out");
  });
});

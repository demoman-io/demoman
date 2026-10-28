import { execFile, execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execGit, type RefreshResult } from "@demoman/runner/package";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { deliver } from "../src/deliver.js";

const FAKE_GH = join(__dirname, "../../runner/test/fake-gh.mjs");
const PERSON = ["-c", "user.name=Pat", "-c", "user.email=pat@example.com"];

let dir: string;
let repo: string;
let remote: string;
let script: Record<string, unknown>;
let logPath: string;

const git = (cwd: string, ...a: string[]) =>
  execFileSync("git", a, { cwd, encoding: "utf8" }).trim();
const count = () => Number(git(repo, "rev-list", "--count", "HEAD"));
const calls = (): string[][] =>
  readFileSync(logPath, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));

const SENTENCE =
  /Commits that were on `demoman\/refresh` before this run were replaced/;
const bodyOf = (c: string[] | undefined): string =>
  c?.[(c?.indexOf("--body") ?? -2) + 1] ?? "";

const gh = (args: string[]) =>
  new Promise<{ code: number; stdout: string; stderr: string }>((done) => {
    writeFileSync(join(dir, "script.json"), JSON.stringify(script));
    execFile(
      "node",
      [FAKE_GH, ...args],
      {
        cwd: repo,
        env: {
          ...process.env,
          FAKE_GH_SCRIPT: join(dir, "script.json"),
          FAKE_GH_LOG: logPath,
        },
      },
      (err, stdout, stderr) =>
        done({
          code: err ? (typeof err.code === "number" ? err.code : 1) : 0,
          stdout,
          stderr,
        }),
    );
  });

const result = (
  extra: Partial<RefreshResult["videos"][number]>[] = [],
): RefreshResult => ({
  videos: [
    {
      name: "Add a task",
      file: ".demoman/videos/add-task.json",
      outcome: "replaced",
      detail: "",
      outputs: ["docs/add-task.mp4"],
      line: "Demo: `Add a task` · 4.5 s · matches",
      notes: [],
    },
    ...extra.map((e) => ({
      name: "x",
      file: ".demoman/videos/x.json",
      outcome: "unchanged" as const,
      detail: "",
      outputs: [],
      line: null,
      notes: [],
      ...e,
    })),
  ],
});

const run = (route: "pr" | "main", r: RefreshResult, named = false) =>
  deliver(
    {
      route,
      repoRoot: repo,
      result: r,
      named,
      runUrl: "https://github.com/o/r/actions/runs/9",
    },
    { git: execGit, gh },
  );

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "deliver-"));
  repo = join(dir, "repo");
  remote = join(dir, "remote.git");
  logPath = join(dir, "gh.log");
  writeFileSync(logPath, "");
  script = {};
  mkdirSync(repo);
  execFileSync("git", ["init", "--bare", "-b", "main", remote]);
  git(repo, "init", "-b", "main");
  git(repo, "remote", "add", "origin", remote);
  mkdirSync(join(repo, "docs"));
  writeFileSync(join(repo, "docs/add-task.mp4"), "old");
  git(repo, "add", ".");
  git(repo, ...PERSON, "commit", "-m", "start");
  git(repo, "push", "origin", "main");
  // The refresh's work: a replaced output, plus an unrelated change that must not ship.
  writeFileSync(join(repo, "docs/add-task.mp4"), "new");
  writeFileSync(join(repo, "unrelated.txt"), "mine");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("deliver", () => {
  const unchanged = () => {
    const r = result();
    r.videos = r.videos.map((v) => ({
      ...v,
      outcome: "unchanged" as const,
      outputs: [],
      line: null,
    }));
    expect(r.videos.map((v) => v.outcome)).toEqual(["unchanged"]);
    return r;
  };

  it("delivers nothing when nothing was replaced: no commit; pr only looks for an open PR", async () => {
    const before = count();
    script = { "pr list": { stdout: "[]" } };
    const a = await run("pr", unchanged());
    expect(calls().map((c) => c.slice(0, 2))).toEqual([["pr", "list"]]);
    writeFileSync(logPath, "");
    const b = await run("main", unchanged());
    expect(a).toEqual({
      delivered: "nothing",
      ok: true,
      detail: "no video was replaced",
    });
    expect(b).toEqual({
      delivered: "nothing",
      ok: true,
      detail: "no video was replaced",
    });
    expect(count()).toBe(before);
    expect(calls()).toEqual([]);
  });

  it("pr with nothing replaced closes the open refresh PR, whose videos are now wrong", async () => {
    script = {
      "pr list": { stdout: '[{"number":12}]' },
      "pr close": { stdout: "closed" },
    };
    const a = await run("pr", unchanged());
    const close = calls().filter((c) => c[0] === "pr" && c[1] === "close");
    expect(close).toHaveLength(1);
    expect(close[0]?.[2]).toBe("12");
    expect(close[0]).toContain("--comment");
    expect(a.ok).toBe(true);
    expect(a.delivered).toBe("nothing");
    expect(a.detail).toContain("no video was replaced");
    expect(a.detail).toContain("closed pull request #12");
  });

  it("pr with nothing replaced but a video failed leaves the open refresh PR alone", async () => {
    const r = unchanged();
    r.videos = [
      ...r.videos,
      { ...r.videos[0], name: "Broken", outcome: "failed", detail: "x" },
    ] as typeof r.videos;
    // Premise: nothing was replaced, and one video failed.
    expect(r.videos.map((v) => v.outcome)).toEqual(["unchanged", "failed"]);
    script = { "pr list": { stdout: '[{"number":12}]' } };
    const a = await run("pr", r);
    expect(calls().filter((c) => c[1] === "close")).toEqual([]);
    expect(a).toEqual({
      delivered: "nothing",
      ok: true,
      detail:
        "no video was replaced; the open refresh pull request stays, because a video failed",
    });
  });

  it("pr with nothing replaced in a refresh of named videos leaves the open refresh PR alone", async () => {
    script = { "pr list": { stdout: '[{"number":12}]' } };
    const a = await run("pr", unchanged(), true);
    expect(calls().filter((c) => c[1] === "close")).toEqual([]);
    expect(a).toEqual({
      delivered: "nothing",
      ok: true,
      detail:
        "no video was replaced; the open refresh pull request stays, because only the named videos were filmed",
    });
  });

  it("pr with nothing replaced reports a gh failure while listing or closing", async () => {
    script = { "pr list": { code: 1, stderr: "HTTP 502 bad gateway" } };
    const a = await run("pr", unchanged());
    expect(a.ok).toBe(false);
    expect(a.detail).toContain("gh pr list");
    expect(a.detail).toContain("HTTP 502 bad gateway");
    script = {
      "pr list": { stdout: '[{"number":12}]' },
      "pr close": { code: 1, stderr: "HTTP 403 forbidden" },
    };
    const b = await run("pr", unchanged());
    expect(b.ok).toBe(false);
    expect(b.detail).toContain("#12");
    expect(b.detail).toContain("HTTP 403 forbidden");
  });

  it("main: one commit with [skip demoman], only the outputs, pushed", async () => {
    const before = count();
    const a = await run("main", result());
    expect(a).toMatchObject({ delivered: "main", ok: true });
    expect(count()).toBe(before + 1);
    expect(git(repo, "log", "-1", "--format=%s")).toBe("Refresh demo videos");
    expect(git(repo, "log", "-1", "--format=%b")).toContain("[skip demoman]");
    expect(git(repo, "log", "-1", "--format=%b")).toContain("Add a task");
    expect(git(repo, "show", "--name-only", "--format=", "HEAD")).toBe(
      "docs/add-task.mp4",
    );
    expect(git(repo, "status", "--porcelain")).toContain("unrelated.txt");
    expect(git(remote, "rev-parse", "main")).toBe(
      git(repo, "rev-parse", "HEAD"),
    );
  });

  it("main: a failed push is reported, not delivered", async () => {
    git(repo, "remote", "set-url", "origin", join(dir, "nowhere.git"));
    const a = await run("main", result());
    expect(a.ok).toBe(false);
    expect(a.delivered).toBe("nothing");
    expect(a.detail).toMatch(/push/);
  });

  it("pr with no open PR: pushes demoman/refresh and creates it", async () => {
    script = {
      "pr list": { stdout: "[]" },
      "pr create": { stdout: "https://github.com/o/r/pull/5\n" },
    };
    const a = await run(
      "pr",
      result([
        { name: "Broken", outcome: "failed", detail: "a step did not match" },
      ]),
    );
    expect(a).toMatchObject({ delivered: "pr", ok: true });
    expect(git(remote, "log", "-1", "--format=%s", "demoman/refresh")).toBe(
      "Refresh demo videos",
    );
    expect(
      git(remote, "show", "--name-only", "--format=", "demoman/refresh"),
    ).toBe("docs/add-task.mp4");
    const create = calls().filter((c) => c[0] === "pr" && c[1] === "create");
    expect(create).toHaveLength(1);
    expect(
      git(remote, "log", "-1", "--format=%b", "demoman/refresh"),
    ).toContain("[skip demoman]");
    expect(create[0]).toContain("demoman/refresh");
    const body = bodyOf(create[0]);
    expect(body).toContain("Demo: `Add a task` · 4.5 s · matches");
    expect(body).toContain("docs/add-task.mp4");
    expect(body).toContain("https://github.com/o/r/actions/runs/9");
    expect(body).toContain("Broken");
    expect(body).toContain("a step did not match");
    expect(body).not.toMatch(/replaced by/);
    expect(calls().some((c) => c.includes("--attach"))).toBe(false);
  });

  it("pr with an open PR: edits its body, creates no second", async () => {
    script = {
      "pr list": { stdout: '[{"number":7}]' },
      "pr edit": { stdout: "ok" },
    };
    const a = await run("pr", result());
    expect(a).toMatchObject({ delivered: "pr", ok: true });
    expect(calls().filter((c) => c[1] === "create")).toHaveLength(0);
    const edit = calls().filter((c) => c[1] === "edit");
    expect(edit).toHaveLength(1);
    expect(edit[0]).toContain("7");
  });

  it("pr after a person's commit on the branch: force-pushed, and the body says so", async () => {
    // Premise: the remote branch holds a commit by a person.
    git(repo, "checkout", "-b", "demoman/refresh");
    writeFileSync(join(repo, "mine.txt"), "x");
    git(repo, "add", "mine.txt");
    git(repo, ...PERSON, "commit", "-m", "Tweak the PR by hand");
    git(repo, "push", "origin", "demoman/refresh");
    git(repo, "checkout", "main");
    expect(git(remote, "log", "-1", "--format=%an", "demoman/refresh")).toBe(
      "Pat",
    );
    script = { "pr list": { stdout: "[]" }, "pr create": { stdout: "u" } };
    const a = await run("pr", result());
    expect(a.ok).toBe(true);
    expect(git(remote, "log", "-1", "--format=%an", "demoman/refresh")).toBe(
      "github-actions[bot]",
    );
    expect(git(remote, "rev-list", "--count", "demoman/refresh")).toBe("2");
    const create = calls().find((c) => c[1] === "create");
    expect(bodyOf(create)).toMatch(SENTENCE);
  });

  it("pr after only the bot's own earlier commit: the body does not claim a replacement", async () => {
    script = { "pr list": { stdout: "[]" }, "pr create": { stdout: "u" } };
    await run("pr", result());
    git(repo, "checkout", "main");
    writeFileSync(join(repo, "docs/add-task.mp4"), "newer");
    script = {
      "pr list": { stdout: '[{"number":3}]' },
      "pr edit": { stdout: "ok" },
    };
    writeFileSync(logPath, "");
    await run("pr", result());
    const edit = calls().find((c) => c[1] === "edit");
    expect(bodyOf(edit)).not.toMatch(SENTENCE);
  });

  it("pr: gh refusing to create names the repository setting and is not delivered", async () => {
    script = {
      "pr list": { stdout: "[]" },
      "pr create": {
        code: 1,
        stderr:
          "GraphQL: GitHub Actions is not permitted to create or approve pull requests (createPullRequest)",
      },
    };
    const a = await run("pr", result());
    expect(a.ok).toBe(false);
    expect(a.delivered).toBe("nothing");
    expect(a.detail).toContain(
      "Allow GitHub Actions to create and approve pull requests",
    );
  });

  it("pr: any other gh failure passes its stderr through", async () => {
    script = { "pr list": { code: 1, stderr: "HTTP 502 bad gateway" } };
    const a = await run("pr", result());
    expect(a.ok).toBe(false);
    expect(a.detail).toContain("HTTP 502 bad gateway");
  });
});

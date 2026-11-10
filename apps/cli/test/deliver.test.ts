import { execFile, execFileSync } from "node:child_process";
import {
  existsSync,
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
import { deliver, offBase } from "../src/deliver.js";

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

type Video = RefreshResult["videos"][number];
const filmed = {
  flow: null,
  deliver: "commit",
  video: null,
  filmedCode: null,
  sameAs: null,
  files: [] as Video["files"],
  screens: null,
  report: null,
} as const;
const result = (extra: Partial<Video>[] = []): RefreshResult => ({
  videos: [
    {
      ...filmed,
      name: "Add a task",
      file: ".demoman/videos/add-task.json",
      outcome: "changed",
      detail: "",
      outputs: ["docs/add-task.mp4"],
      line: "Demo: `Add a task` · 4.5 s · matches",
      notes: [],
    },
    ...extra.map((e) => ({
      ...filmed,
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

  it("delivers nothing when nothing changed: no commit; pr only looks for an open PR", async () => {
    const before = count();
    script = { "pr list": { stdout: "[]" } };
    const a = await run("pr", unchanged());
    expect(calls().map((c) => c.slice(0, 2))).toEqual([["pr", "list"]]);
    writeFileSync(logPath, "");
    const b = await run("main", unchanged());
    expect(a).toEqual({
      delivered: "nothing",
      ok: true,
      detail: "no video changed",
    });
    expect(b).toEqual({
      delivered: "nothing",
      ok: true,
      detail: "no video changed",
    });
    expect(count()).toBe(before);
    expect(calls()).toEqual([]);
  });

  it("pr with nothing changed closes the open refresh PR, whose videos are now wrong", async () => {
    script = {
      "pr list": { stdout: '[{"number":12}]' },
      "pr close": { stdout: "closed" },
    };
    const a = await run("pr", unchanged());
    const close = calls().filter((c) => c[0] === "pr" && c[1] === "close");
    expect(close).toHaveLength(1);
    expect(close[0]?.[2]).toBe("12");
    expect(close[0]).toContain("--comment");
    expect(close[0]?.join(" ")).toContain("changed no video");
    expect(a.ok).toBe(true);
    expect(a.delivered).toBe("nothing");
    expect(a.detail).toContain("no video changed");
    expect(a.detail).toContain("closed pull request #12");
  });

  it("pr with nothing changed but a video failed leaves the open refresh PR alone", async () => {
    const r = unchanged();
    r.videos = [
      ...r.videos,
      { ...r.videos[0], name: "Broken", outcome: "failed", detail: "x" },
    ] as typeof r.videos;
    // Premise: nothing changed, and one video failed.
    expect(r.videos.map((v) => v.outcome)).toEqual(["unchanged", "failed"]);
    script = { "pr list": { stdout: '[{"number":12}]' } };
    const a = await run("pr", r);
    expect(calls().filter((c) => c[1] === "close")).toEqual([]);
    expect(a).toEqual({
      delivered: "nothing",
      ok: true,
      detail:
        "no video changed; the open refresh pull request stays, because a flow failed",
    });
  });

  it("pr with nothing changed in a refresh of named videos leaves the open refresh PR alone", async () => {
    script = { "pr list": { stdout: '[{"number":12}]' } };
    const a = await run("pr", unchanged(), true);
    expect(calls().filter((c) => c[1] === "close")).toEqual([]);
    expect(a).toEqual({
      delivered: "nothing",
      ok: true,
      detail:
        "no video changed; the open refresh pull request stays, because only the named flows were recorded",
    });
  });

  it("pr with nothing changed reports a gh failure while listing or closing", async () => {
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

  it("an unchanged or failed video is not staged; a files video is never staged", async () => {
    for (const p of ["docs/a.mp4", "docs/b.mp4", "docs/f.mp4", "docs/n.mp4"])
      writeFileSync(join(repo, p), "written");
    const r = result([
      { name: "Added", outcome: "added", outputs: ["docs/a.mp4"] },
      {
        name: "New",
        outcome: "uncompared",
        outputs: ["docs/n.mp4", ".demoman/receipts/n.json"],
      },
      // A failure that wrote some files partway, and a files flow that
      // changed: neither belongs in the commit.
      { name: "Broken", outcome: "failed", outputs: ["docs/b.mp4"] },
      {
        name: "Files",
        deliver: "files",
        outcome: "changed",
        outputs: ["docs/f.mp4"],
      },
      { name: "Same", outcome: "unchanged", outputs: ["docs/b.mp4"] },
    ]);
    mkdirSync(join(repo, ".demoman/receipts"), { recursive: true });
    writeFileSync(join(repo, ".demoman/receipts/n.json"), "{}");
    const a = await run("main", r);
    expect(a).toMatchObject({ delivered: "main", ok: true });
    expect(
      git(repo, "show", "--name-only", "--format=", "HEAD").split("\n").sort(),
    ).toEqual(
      [
        ".demoman/receipts/n.json",
        "docs/a.mp4",
        "docs/add-task.mp4",
        "docs/n.mp4",
      ].sort(),
    );
    expect(a.detail).toBe("committed 3 video(s) on main");
  });

  // A version 1 receipt refreshed the same is `added`: its receipt is
  // written again with a folder of screen images, and both are committed,
  // or every later refresh decodes the full export again.
  it("an added video whose outputs are its receipt and images folder gets them staged", async () => {
    const images = ".demoman/receipts/x.screens";
    mkdirSync(join(repo, images), { recursive: true });
    writeFileSync(join(repo, images, "step-0.png"), "png");
    writeFileSync(join(repo, images, "final.png"), "png");
    writeFileSync(join(repo, ".demoman/receipts/x.json"), "{}");
    const a = await run(
      "main",
      result([
        {
          outcome: "added",
          outputs: [images, ".demoman/receipts/x.json"],
        },
      ]),
    );
    expect(a).toMatchObject({ delivered: "main", ok: true });
    expect(
      git(repo, "show", "--name-only", "--format=", "HEAD").split("\n").sort(),
    ).toEqual(
      [
        `${images}/final.png`,
        `${images}/step-0.png`,
        ".demoman/receipts/x.json",
        "docs/add-task.mp4",
      ].sort(),
    );
  });

  it("main: a failed push is reported, not delivered", async () => {
    git(repo, "remote", "set-url", "origin", join(dir, "nowhere.git"));
    const a = await run("main", result());
    expect(a.ok).toBe(false);
    expect(a.delivered).toBe("nothing");
    expect(a.detail).toMatch(/push/);
    expect(a.detail).toMatch(/fetch/);
  });

  const moveMain = (file: string, content: string, subject: string) => {
    const other = join(dir, "other");
    execFileSync("git", ["clone", "-q", remote, other]);
    mkdirSync(join(other, file, ".."), { recursive: true });
    writeFileSync(join(other, file), content);
    git(other, "add", file);
    git(other, ...PERSON, "commit", "-q", "-m", subject);
    git(other, "push", "-q", "origin", "main");
  };

  it("main: a branch that moved during the run still delivers, rebased onto it", async () => {
    moveMain("NOTES.md", "merged while recording\n", "a merge during the run");
    const a = await run("main", result());
    expect(a).toMatchObject({ delivered: "main", ok: true });
    expect(a.detail).toMatch(
      /rebased onto a commit that landed during the run/,
    );
    const subjects = git(remote, "log", "--format=%s", "main").split("\n");
    expect(subjects[0]).toMatch(/^Refresh demo videos/); // ours, on top
    expect(subjects[1]).toBe("a merge during the run"); // theirs, kept
  });

  it("main: a moved branch that changed the same video stops with its reason, not mid-rebase", async () => {
    moveMain(
      "docs/add-task.mp4",
      "someone else's video\n",
      "another refresh got there first",
    );
    const a = await run("main", result());
    expect(a).toMatchObject({ delivered: "nothing", ok: false });
    expect(a.detail).toMatch(/changed the same files/);
    expect(existsSync(join(repo, ".git/rebase-merge"))).toBe(false);
    expect(existsSync(join(repo, ".git/rebase-apply"))).toBe(false);
  });

  it("main: an uncommitted leftover does not stop the rebase", async () => {
    // The fixture tracks only the video, so track a README first.
    writeFileSync(join(repo, "README.md"), "committed\n");
    git(repo, "add", "README.md");
    git(repo, ...PERSON, "commit", "-q", "-m", "readme", "--", "README.md");
    git(repo, "push", "-q", "origin", "main");
    moveMain("NOTES.md", "merged while recording\n", "a merge during the run");
    writeFileSync(join(repo, "README.md"), "edited, not committed\n");
    expect(git(repo, "ls-files", "README.md")).toBe("README.md");
    const a = await run("main", result());
    expect(a).toMatchObject({ delivered: "main", ok: true });
    expect(readFileSync(join(repo, "README.md"), "utf8")).toBe(
      "edited, not committed\n",
    );
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
    expect(body).toContain(
      "Demoman recorded the repo's flows again and updated 1.",
    );
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

  // A deployment or release trigger checks out a sha or tag: HEAD is
  // detached, and the PR goes to the default branch (DEM-123).
  describe("from a detached HEAD", () => {
    const detachOnFeature = () => {
      git(repo, "checkout", "-q", "-b", "feature");
      writeFileSync(join(repo, "feature.txt"), "wip");
      git(repo, "add", "feature.txt");
      git(repo, ...PERSON, "commit", "-q", "-m", "Feature work");
      git(repo, "push", "-q", "origin", "feature");
      git(repo, "checkout", "-q", "--detach", "feature");
      // Premise: detached, at a commit main does not have.
      expect(git(repo, "rev-parse", "--abbrev-ref", "HEAD")).toBe("HEAD");
      expect(git(remote, "log", "--format=%s", "main")).not.toContain(
        "Feature work",
      );
    };

    it("refuses to open a PR into main from a commit that is not on it", async () => {
      detachOnFeature();
      script = {
        "repo view": { stdout: "main\n" },
        "pr list": { stdout: "[]" },
        "pr create": { stdout: "https://github.com/o/r/pull/5\n" },
      };
      const a = await run("pr", result());
      expect(a.ok).toBe(false);
      expect(a.delivered).toBe("nothing");
      expect(a.detail).toContain("not on main");
      expect(calls().filter((c) => c[1] === "create")).toEqual([]);
      expect(() =>
        git(remote, "rev-parse", "--verify", "-q", "demoman/refresh"),
      ).toThrow();
    });

    it("leaves main's open refresh PR alone when nothing changed there", async () => {
      detachOnFeature();
      script = {
        "repo view": { stdout: "main\n" },
        "pr list": { stdout: '[{"number":12}]' },
        "pr close": { stdout: "closed" },
      };
      const a = await run("pr", unchanged());
      expect(a.ok).toBe(false);
      expect(calls().filter((c) => c[1] === "close")).toEqual([]);
    });

    it("delivers from a commit on main, as a release tag on main checks out", async () => {
      git(repo, "checkout", "-q", "--detach", "main");
      expect(git(repo, "rev-parse", "--abbrev-ref", "HEAD")).toBe("HEAD");
      script = {
        "repo view": { stdout: "main\n" },
        "pr list": { stdout: "[]" },
        "pr create": { stdout: "https://github.com/o/r/pull/5\n" },
      };
      const a = await run("pr", result());
      expect(a).toMatchObject({ delivered: "pr", ok: true });
      expect(git(remote, "log", "--format=%s", "demoman/refresh")).toBe(
        "Refresh demo videos\nstart",
      );
      // The PR goes where the check looked, named, not gh's own default.
      const create = calls().find((c) => c[1] === "create") ?? [];
      expect(create[create.indexOf("--base") + 1]).toBe("main");
    });

    // Decide once: the workflow names the branch it checked, and refresh
    // hands deliver the answer it got before recording.
    it("takes a named default branch without asking gh, and a given answer without checking again", async () => {
      git(repo, "checkout", "-q", "--detach", "main");
      expect(await offBase(repo, { git: execGit, gh }, "main")).toEqual({
        base: "main",
      });
      expect(calls()).toEqual([]);
      script = {
        "pr list": { stdout: "[]" },
        "pr create": { stdout: "https://github.com/o/r/pull/5\n" },
      };
      const a = await deliver(
        {
          route: "pr",
          repoRoot: repo,
          result: result(),
          runUrl: null,
          target: { base: "main" },
        },
        { git: execGit, gh },
      );
      expect(a).toMatchObject({ delivered: "pr", ok: true });
      expect(calls().map((c) => c.slice(0, 2))).toEqual([
        ["pr", "list"],
        ["pr", "create"],
      ]);
    });

    it("says so when the default branch cannot be read", async () => {
      detachOnFeature();
      script = { "repo view": { code: 1, stderr: "HTTP 401" } };
      const a = await run("pr", result());
      expect(a.ok).toBe(false);
      expect(a.detail).toContain("HTTP 401");
    });
  });
});

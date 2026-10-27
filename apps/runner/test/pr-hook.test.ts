import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { postToolUseAnswer } from "../src/executor/pr-hook.js";
import { resolvePullRequests } from "../src/executor/pull-requests.js";

const made: string[] = [];
const temp = async () => {
  const d = await mkdtemp(join(tmpdir(), "demoman-pr-hook-"));
  made.push(d);
  return d;
};
afterEach(async () => {
  for (const d of made.splice(0)) await rm(d, { recursive: true, force: true });
});

const URL7 = "https://github.com/o/r/pull/7";

/** A repo (with .git) whose `.demoman/config.json` holds `config`, and a home. */
async function setup(config?: string) {
  const repo = await temp();
  await mkdir(join(repo, ".git"));
  if (config !== undefined) {
    await mkdir(join(repo, ".demoman"));
    await writeFile(join(repo, ".demoman", "config.json"), config);
  }
  return { repo, home: await temp() };
}

const bash = (cwd: string, command: string, stdout = `${URL7}\n`) =>
  JSON.stringify({
    cwd,
    tool_name: "Bash",
    tool_input: { command },
    tool_response: { stdout, stderr: "", interrupted: false, isImage: false },
  });

function context(answer: string | null): string {
  expect(answer).not.toBeNull();
  const parsed = JSON.parse(answer as string);
  expect(parsed.hookSpecificOutput.hookEventName).toBe("PostToolUse");
  return parsed.hookSpecificOutput.additionalContext;
}

describe("postToolUseAnswer", () => {
  it("attach reminds, naming the PR and the setting", async () => {
    const { repo, home } = await setup('{"pullRequests":"attach"}');
    expect(await resolvePullRequests(repo, home)).toMatchObject({
      value: "attach",
    });
    const text = context(
      await postToolUseAnswer(bash(repo, "gh pr create --fill"), home),
    );
    expect(text).toContain('"attach"');
    expect(text).toContain(URL7);
    expect(text).toContain("Pull requests section");
  });

  it("ask reminds", async () => {
    const { repo, home } = await setup('{"pullRequests":"ask"}');
    expect(await resolvePullRequests(repo, home)).toMatchObject({
      value: "ask",
    });
    const text = context(
      await postToolUseAnswer(bash(repo, "gh pr create --fill"), home),
    );
    expect(text).toContain('"ask"');
  });

  it("off says nothing", async () => {
    const { repo, home } = await setup('{"pullRequests":"off"}');
    expect(await resolvePullRequests(repo, home)).toMatchObject({
      value: "off",
    });
    expect(
      await postToolUseAnswer(bash(repo, "gh pr create --fill"), home),
    ).toBeNull();
  });

  it("an unreadable setting says so, and that it is not off", async () => {
    const { repo, home } = await setup('{"pullRequests": 5}');
    expect(await resolvePullRequests(repo, home)).toHaveProperty("unreadable");
    const text = context(
      await postToolUseAnswer(bash(repo, "gh pr create --fill"), home),
    );
    expect(text).toContain("could not be read");
    expect(text).toContain('not "off"');
    expect(text).toContain(URL7);
  });

  it("matches gh pr create inside a chained command", async () => {
    const { repo, home } = await setup('{"pullRequests":"attach"}');
    expect(
      await postToolUseAnswer(
        bash(repo, "cd sub && gh pr create --fill"),
        home,
      ),
    ).not.toBeNull();
  });

  it("no PR URL in the output (--web) is no reminder", async () => {
    const { repo, home } = await setup('{"pullRequests":"attach"}');
    expect(await resolvePullRequests(repo, home)).toMatchObject({
      value: "attach",
    });
    expect(
      await postToolUseAnswer(
        bash(
          repo,
          "gh pr create --web",
          "Opening github.com/o/r/compare in your browser.\n",
        ),
        home,
      ),
    ).toBeNull();
  });

  // Final review (code-review high): a create that fails because the PR
  // already exists prints that PR's URL, so the URL proves only that a PR
  // was named, and the reminder must not say one was just opened.
  it("a PR that already existed is not called just opened", async () => {
    const { repo, home } = await setup('{"pullRequests":"attach"}');
    const text = context(
      await postToolUseAnswer(
        bash(
          repo,
          "gh pr create --fill",
          `a pull request for branch "x" into branch "main" already exists:\n${URL7}\n`,
        ),
        home,
      ),
    );
    expect(text).toContain(URL7);
    expect(text).not.toContain("was just opened");
    expect(text).toContain("If that pull request was opened now");
  });

  it("other calls say nothing", async () => {
    const { repo, home } = await setup('{"pullRequests":"attach"}');
    expect(await postToolUseAnswer(bash(repo, "gh pr list"), home)).toBeNull();
    expect(
      await postToolUseAnswer(
        JSON.stringify({
          cwd: repo,
          tool_name: "Read",
          tool_input: { file_path: "x" },
          tool_response: { text: URL7 },
        }),
        home,
      ),
    ).toBeNull();
  });

  it("a GitHub MCP create_pull_request reminds", async () => {
    const { repo, home } = await setup('{"pullRequests":"attach"}');
    const text = context(
      await postToolUseAnswer(
        JSON.stringify({
          cwd: repo,
          tool_name: "mcp__github__create_pull_request",
          tool_input: { title: "t" },
          tool_response: { html_url: "https://github.com/o/r/pull/9" },
        }),
        home,
      ),
    );
    expect(text).toContain("/pull/9");
  });

  it("unreadable stdin asks for status instead of staying quiet", async () => {
    const { home } = await setup();
    const text = context(await postToolUseAnswer("not json", home));
    expect(text).toContain("could not check");
    expect(text).toContain("status");
  });
});

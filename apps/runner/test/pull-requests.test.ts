import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolvePullRequests } from "../src/executor/pull-requests.js";
import { readUserSettings } from "../src/executor/user-settings.js";

const made: string[] = [];
const temp = async () => {
  const d = await mkdtemp(join(tmpdir(), "demoman-pr-"));
  made.push(d);
  return d;
};
afterEach(async () => {
  for (const d of made.splice(0)) await rm(d, { recursive: true, force: true });
});

/** A repo folder (with .git) and a home, each empty. */
async function setup() {
  const repo = await temp();
  await mkdir(join(repo, ".git"));
  const home = await temp();
  return { repo, home };
}
const repoFile = (repo: string) => join(repo, ".demoman", "config.json");
async function writeRepo(repo: string, text: string) {
  await mkdir(join(repo, ".demoman"), { recursive: true });
  await writeFile(repoFile(repo), text);
}
const userFile = (home: string) => join(home, "settings.json");

describe("resolvePullRequests", () => {
  it("nothing set is ask from default", async () => {
    const { repo, home } = await setup();
    expect(await resolvePullRequests(repo, home)).toEqual({
      value: "ask",
      from: "default",
    });
  });

  it("user alone", async () => {
    const { repo, home } = await setup();
    await writeFile(userFile(home), JSON.stringify({ pullRequests: "attach" }));
    expect(await resolvePullRequests(repo, home)).toEqual({
      value: "attach",
      from: "user",
      file: userFile(home),
    });
  });

  it("repo wins over user", async () => {
    const { repo, home } = await setup();
    await writeRepo(repo, JSON.stringify({ pullRequests: "ask" }));
    await writeFile(userFile(home), JSON.stringify({ pullRequests: "attach" }));
    expect(await resolvePullRequests(repo, home)).toEqual({
      value: "ask",
      from: "repo",
      file: repoFile(repo),
    });
  });

  it("a repo file without the key leaves the user's value", async () => {
    const { repo, home } = await setup();
    await writeRepo(repo, JSON.stringify({ other: 1 }));
    await writeFile(userFile(home), JSON.stringify({ pullRequests: "attach" }));
    expect(await resolvePullRequests(repo, home)).toMatchObject({
      value: "attach",
      from: "user",
    });
  });

  it("found from a subfolder up to the git root; a file above it is not", async () => {
    const { repo, home } = await setup();
    await writeRepo(repo, JSON.stringify({ pullRequests: "attach" }));
    const deep = join(repo, "a", "b");
    await mkdir(deep, { recursive: true });
    expect(await resolvePullRequests(deep, home)).toMatchObject({
      value: "attach",
      from: "repo",
    });
    // Above the .git folder: an outer folder holds a file, the repo does not.
    const outer = await temp();
    await writeRepo(outer, JSON.stringify({ pullRequests: "attach" }));
    const inner = join(outer, "inner");
    await mkdir(join(inner, ".git"), { recursive: true });
    expect(await resolvePullRequests(inner, home)).toEqual({
      value: "ask",
      from: "default",
    });
  });

  it("a wrong value is unreadable, not off", async () => {
    const { repo, home } = await setup();
    await writeRepo(repo, JSON.stringify({ pullRequests: true }));
    const out = await resolvePullRequests(repo, home);
    expect(out).toMatchObject({ file: repoFile(repo) });
    const unreadable = (out as { unreadable: string }).unreadable;
    expect(unreadable).toContain("pullRequests");
    expect(unreadable).toContain("off, ask or attach");
    expect(unreadable).toContain(repoFile(repo));
  });

  it("invalid repo JSON does not fall back to the user", async () => {
    const { repo, home } = await setup();
    await writeRepo(repo, "{");
    await writeFile(userFile(home), JSON.stringify({ pullRequests: "attach" }));
    const out = await resolvePullRequests(repo, home);
    expect(out).toMatchObject({ file: repoFile(repo) });
    expect((out as { unreadable: string }).unreadable).toContain(
      repoFile(repo),
    );
    expect(out).not.toHaveProperty("value");
  });

  it("an unreadable user file is unreadable, not off", async () => {
    const { repo, home } = await setup();
    await writeFile(userFile(home), "not json");
    const out = await resolvePullRequests(repo, home);
    expect(out).toMatchObject({ file: userFile(home) });
    expect((out as { unreadable: string }).unreadable).toContain(
      userFile(home),
    );
    expect(out).not.toHaveProperty("value");
  });

  // Root reads a mode-000 file, so the premise cannot hold there: say skipped.
  it.skipIf(process.getuid?.() === 0)(
    "a repo file that cannot be read is unreadable, not none",
    async () => {
      const { repo, home } = await setup();
      await writeRepo(repo, JSON.stringify({ pullRequests: "ask" }));
      await chmod(repoFile(repo), 0o000);
      try {
        // Premise: this process really cannot read it.
        const readable = await readFile(repoFile(repo)).then(
          () => true,
          () => false,
        );
        expect(readable).toBe(false);
        const out = await resolvePullRequests(repo, home);
        expect(out).toMatchObject({ file: repoFile(repo) });
        expect(out).not.toHaveProperty("value");
      } finally {
        await chmod(repoFile(repo), 0o600);
      }
    },
  );

  it.each(["[]", "null", "5", '"x"'])(
    "a repo file holding %s is unreadable and does not fall to the user",
    async (text) => {
      const { repo, home } = await setup();
      await writeRepo(repo, text);
      await writeFile(
        userFile(home),
        JSON.stringify({ pullRequests: "attach" }),
      );
      const out = await resolvePullRequests(repo, home);
      expect(out).toMatchObject({ file: repoFile(repo) });
      expect((out as { unreadable: string }).unreadable).toContain(
        repoFile(repo),
      );
      expect(out).not.toHaveProperty("value");
    },
  );
});

describe("readUserSettings", () => {
  it("a missing file or key is not set, without a complaint", async () => {
    const home = await temp();
    expect(await readUserSettings(home)).toEqual({
      exportQuality: "share",
      pullRequests: null,
    });
    await writeFile(userFile(home), JSON.stringify({ theme: "dark" }));
    expect(await readUserSettings(home)).toEqual({
      exportQuality: "share",
      pullRequests: null,
    });
  });
  it.each(["[]", "null", "5", '"x"'])(
    "a settings file holding %s is unreadable, not unset",
    async (text) => {
      const home = await temp();
      await writeFile(userFile(home), text);
      const out = await readUserSettings(home);
      expect(out.pullRequests).toBeNull();
      expect(out.unreadable).toContain(userFile(home));
    },
  );
  it("a bad value names the file, the key and the choices", async () => {
    const home = await temp();
    await writeFile(userFile(home), JSON.stringify({ pullRequests: "yes" }));
    const out = await readUserSettings(home);
    expect(out.pullRequests).toBeNull();
    expect(out.unreadable).toContain(userFile(home));
    expect(out.unreadable).toContain("pullRequests");
    expect(out.unreadable).toContain("off, ask or attach");
  });
});

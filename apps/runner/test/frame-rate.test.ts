import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveRecordingFrameRate } from "../src/executor/frame-rate.js";

const made: string[] = [];
const temp = async () => {
  const d = await mkdtemp(join(tmpdir(), "demoman-fr-"));
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
const said = (out: unknown) => (out as { unreadable: string }).unreadable;

describe("resolveRecordingFrameRate", () => {
  it("repo sets 60", async () => {
    const { repo, home } = await setup();
    await writeRepo(repo, JSON.stringify({ recordingFrameRate: 60 }));
    expect(await resolveRecordingFrameRate(repo, home)).toEqual({
      value: 60,
      from: "repo",
      file: repoFile(repo),
    });
  });

  it("a repo file without the key is 30 from default", async () => {
    const { repo, home } = await setup();
    await writeRepo(repo, JSON.stringify({ pullRequests: "ask" }));
    expect(await resolveRecordingFrameRate(repo, home)).toEqual({
      value: 30,
      from: "default",
    });
  });

  it("user alone", async () => {
    const { repo, home } = await setup();
    await writeFile(userFile(home), JSON.stringify({ recordingFrameRate: 60 }));
    expect(await resolveRecordingFrameRate(repo, home)).toEqual({
      value: 60,
      from: "user",
      file: userFile(home),
    });
  });

  it("a bad repo value is unreadable, never the user's", async () => {
    const { repo, home } = await setup();
    await writeRepo(repo, JSON.stringify({ recordingFrameRate: 45 }));
    await writeFile(userFile(home), JSON.stringify({ recordingFrameRate: 60 }));
    const out = await resolveRecordingFrameRate(repo, home);
    expect(out).toMatchObject({ file: repoFile(repo) });
    expect(said(out)).toContain(repoFile(repo));
    expect(said(out)).toContain("45");
  });

  it("a string 60 is unreadable", async () => {
    const { repo, home } = await setup();
    await writeRepo(repo, JSON.stringify({ recordingFrameRate: "60" }));
    expect(said(await resolveRecordingFrameRate(repo, home))).toContain('"60"');
  });

  it("a repo file that is not JSON is unreadable, naming it", async () => {
    const { repo, home } = await setup();
    await writeRepo(repo, "not json");
    expect(said(await resolveRecordingFrameRate(repo, home))).toContain(
      repoFile(repo),
    );
  });

  it("a user file that is an array is unreadable, naming it", async () => {
    const { repo, home } = await setup();
    await writeFile(userFile(home), "[]");
    const out = await resolveRecordingFrameRate(repo, home);
    expect(out).toMatchObject({ file: userFile(home) });
    expect(said(out)).toContain(userFile(home));
  });
});

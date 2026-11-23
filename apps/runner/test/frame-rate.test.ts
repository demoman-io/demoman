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

/** A repo folder (with .git), empty. */
async function setup() {
  const repo = await temp();
  await mkdir(join(repo, ".git"));
  return repo;
}
const repoFile = (repo: string) => join(repo, ".demoman", "config.json");
async function writeRepo(repo: string, text: string) {
  await mkdir(join(repo, ".demoman"), { recursive: true });
  await writeFile(repoFile(repo), text);
}
const said = (out: unknown) => (out as { unreadable: string }).unreadable;

describe("resolveRecordingFrameRate", () => {
  it("repo sets 60", async () => {
    const repo = await setup();
    await writeRepo(repo, JSON.stringify({ recordingFrameRate: 60 }));
    expect(await resolveRecordingFrameRate(repo)).toEqual({
      value: 60,
      from: "repo",
      file: repoFile(repo),
    });
  });

  it("a repo file without the key is 30 from default", async () => {
    const repo = await setup();
    await writeRepo(repo, JSON.stringify({ pullRequests: "ask" }));
    expect(await resolveRecordingFrameRate(repo)).toEqual({
      value: 30,
      from: "default",
    });
  });

  it("a bad repo value is unreadable, naming the file and the value", async () => {
    const repo = await setup();
    await writeRepo(repo, JSON.stringify({ recordingFrameRate: 45 }));
    const out = await resolveRecordingFrameRate(repo);
    expect(out).toMatchObject({ file: repoFile(repo) });
    expect(said(out)).toContain(repoFile(repo));
    expect(said(out)).toContain("45");
  });

  it("a string 60 is unreadable", async () => {
    const repo = await setup();
    await writeRepo(repo, JSON.stringify({ recordingFrameRate: "60" }));
    expect(said(await resolveRecordingFrameRate(repo))).toContain('"60"');
  });

  // Ruling A (2026-11-23): only a bad value refuses. A file that will not
  // parse is 30, and `unread` says why, naming the file.
  it.each(["not json", "[]"])(
    "a repo file holding %s is unread: 30, naming the file",
    async (text) => {
      const repo = await setup();
      await writeRepo(repo, text);
      const out = await resolveRecordingFrameRate(repo);
      expect(out).toEqual({
        value: 30,
        from: "default",
        unread: expect.stringContaining(repoFile(repo)),
        file: repoFile(repo),
      });
      expect(out).not.toHaveProperty("unreadable");
    },
  );
});

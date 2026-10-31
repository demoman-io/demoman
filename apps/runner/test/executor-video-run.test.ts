import { execFileSync } from "node:child_process";
import {
  chmod,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import type { RunReport } from "@demoman/run-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLocalExecutor } from "../src/executor/executor.js";
import { createLibrary } from "../src/executor/library.js";
import type { LocalExecutor } from "../src/executor/types.js";
import { createVideoStore, type TakeVideo } from "../src/executor/videos.js";
import type { VideoSummary } from "../src/executor/videos-op.js";
import { launch } from "../src/launch.js";
import { serveFixtureApp, WALLPAPERS_DIR } from "./fixture.js";

// A run here: about 3 s locally (headless), x5 for CI as executor.test.ts.
const RUN_MS = 31_000;
const REPO_KEY = "github.com/acme/shop";

let app: { url: string; close(): void };
let home: string;
let project: string;
let executor: LocalExecutor;
let launches = 0;
let commit: string;

beforeAll(async () => {
  app = await serveFixtureApp();
  home = await mkdtemp(join(tmpdir(), "demoman-video-run-"));
  // A checkout of its own, so made.repo.key is this remote and no other.
  project = await mkdtemp(join(tmpdir(), "demoman-video-repo-"));
  execFileSync("git", ["init", "-q"], { cwd: project });
  execFileSync(
    "git",
    ["remote", "add", "origin", "git@github.com:acme/shop.git"],
    { cwd: project },
  );
  execFileSync(
    "git",
    [
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@t",
      "commit",
      "-q",
      "--allow-empty",
      "-m",
      "x",
    ],
    { cwd: project },
  );
  commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: project })
    .toString()
    .trim();
  executor = createLocalExecutor({
    wallpapersDir: WALLPAPERS_DIR,
    home,
    headless: true,
    outDir: join(home, "out"),
    log: () => undefined,
    launchFn: (o) => {
      launches++;
      return launch(o);
    },
  });
}, 30_000);
afterAll(async () => {
  await executor.close();
  app.close();
  await rm(home, { recursive: true, force: true });
  await rm(project, { recursive: true, force: true });
});

type Answer = RunReport & {
  outcome: string;
  reason?: string;
  field?: string | null;
  detail?: string;
  matches?: VideoSummary[];
  holder?: VideoSummary;
  summary?: string;
};
const AGENT = { name: "test-agent", title: "Test Agent" };
const script = (name: string) => ({
  scriptVersion: 1,
  name,
  target: app.url,
  viewport: { width: 1280, height: 800 },
  steps: [{ do: "waitForLoad" }, { do: "click", on: { text: "Place order" } }],
});
const run = async (args: Record<string, unknown>) => {
  const out = await executor.request("run", { project, ...args });
  if (!out.ok) throw new Error(JSON.stringify(out));
  return out.value as Answer;
};
const takeDirs = async () =>
  (await readdir(join(home, "takes")).catch(() => [])).filter((d) =>
    d.startsWith("scene-"),
  );
const store = () => createVideoStore(home, createLibrary(home));
const memberOf = async (takeId: string) =>
  JSON.parse(
    await readFile(join(home, "takes", takeId, "video.json"), "utf8"),
  ) as TakeVideo;

describe("run records into a video", () => {
  it("refuses a run that names no video, before the browser", async () => {
    const out = await run({ script: script("Anything"), agent: AGENT });
    expect(out).toMatchObject({
      outcome: "refusedBeforeRun",
      reason: "videoRequired",
      field: "video",
    });
    expect(launches).toBe(0);
  });

  it("answers videoNotFound for an id no video has", async () => {
    expect(
      await run({ script: script("x"), video: { id: "nope" } }),
    ).toMatchObject({
      outcome: "refusedBeforeRun",
      reason: "videoNotFound",
      field: "video",
    });
    expect(launches).toBe(0);
  });

  it("refuses a probable duplicate with its matches, spending no run", async () => {
    const seeded = await store().create({
      name: "Create a new invoice",
      repo: { key: REPO_KEY },
      startPage: app.url,
    });
    // Premise: the seeded video is in this repo, under that name.
    if (!seeded.ok) throw new Error(JSON.stringify(seeded));
    const takesBefore = await takeDirs();
    const out = await run({
      script: script("Create an invoice"),
      video: { new: "Create an invoice" },
    });
    expect(out).toMatchObject({
      outcome: "refusedBeforeRun",
      reason: "possibleDuplicate",
      field: "video",
    });
    expect(out.matches?.[0]?.name, JSON.stringify(out)).toBe(
      "Create a new invoice",
    );
    expect(out.matches?.[0]?.id).toBe(seeded.video.id);
    expect(out.detail).toContain("confirmedNew");
    expect(launches).toBe(0);
    expect(await takeDirs()).toEqual(takesBefore);
    // No video was started for the refused name.
    const names = (await store().list()).map((v) =>
      "name" in v ? v.name : v.id,
    );
    expect(names).toEqual(["Create a new invoice"]);
  });

  let videoId: string;
  let v1Take: string;
  it(
    "records a confirmed new video as its first version, and says who made it",
    async () => {
      const out = await run({
        script: script("Create an invoice"),
        video: { new: "Create an invoice", confirmedNew: true },
        agent: AGENT,
      });
      expect(out.outcome, JSON.stringify(out.stopped ?? out)).toBe("complete");
      expect(out.videoVersion).toMatchObject({
        name: "Create an invoice",
        version: 1,
        created: true,
      });
      const take = out.provenance.takeId;
      if (take === null || out.videoVersion === undefined)
        throw new Error(JSON.stringify(out));
      videoId = out.videoVersion.id;
      v1Take = take;
      const member = await memberOf(take);
      expect(member.videoId).toBe(videoId);
      expect(member.made).toMatchObject({
        agent: AGENT,
        repo: { key: REPO_KEY },
        by: userInfo().username,
        door: "mcp",
      });
      expect(await store().get(videoId)).toMatchObject({
        repo: { key: REPO_KEY },
        startPage: `${new URL(app.url).origin}/`,
      });
      // Red (final review 12): leave buildSha null — the take cannot say
      // which commit it filmed.
      expect(member.made.repo).toMatchObject({ commit });
      expect(
        (await createLibrary(home).getScene(take))?.meta.capture,
      ).toMatchObject({
        buildSha: commit,
        buildShaSource: "git rev-parse HEAD",
      });
      // The tree it filmed, recorded in the report and in report.json.
      const filmed = {
        commit,
        tree: execFileSync("git", ["rev-parse", "HEAD^{tree}"], {
          cwd: project,
        })
          .toString()
          .trim(),
        dirty: false,
      };
      expect(out.filmedCode).toEqual(filmed);
      expect(
        JSON.parse(
          await readFile(join(home, "takes", take, "report.json"), "utf8"),
        ).filmedCode,
      ).toEqual(filmed);
    },
    RUN_MS,
  );

  it("refuses an equal name even when confirmed new", async () => {
    const out = await run({
      script: script("x"),
      video: { new: "create AN invoice!", confirmedNew: true },
    });
    expect(out).toMatchObject({ reason: "nameTaken", field: "video" });
    expect(out.holder?.id).toBe(videoId);
  });

  let v2Take: string;
  it(
    "adds a version to a named video, recording a missing agent as absent with why",
    async () => {
      const out = await run({
        script: script("Create an invoice"),
        video: { id: videoId },
      });
      expect(out.videoVersion).toEqual({
        id: videoId,
        name: "Create an invoice",
        version: 2,
        created: false,
      });
      const take = out.provenance.takeId;
      if (take === null) throw new Error(JSON.stringify(out));
      v2Take = take;
      expect((await memberOf(take)).made.agent).toEqual({
        none: "the MCP client sent no name (no args.agent)",
      });
      expect((await store().versions(videoId)).map((v) => v.takeId)).toEqual([
        v1Take,
        v2Take,
      ]);
    },
    RUN_MS,
  );

  it(
    "re-records the video's current version when no script is passed",
    async () => {
      // Premise: version 2 is the current one (the newest complete).
      expect((await store().current(videoId))?.takeId).toBe(v2Take);
      const out = await run({ video: { id: videoId } });
      expect(out.outcome, JSON.stringify(out.stopped ?? out)).toBe("complete");
      expect(out.rerecord?.from).toBe(v2Take);
      expect(out.videoVersion).toMatchObject({ id: videoId, version: 3 });
    },
    RUN_MS,
  );

  it(
    "says a take whose new video could not be written is in no video, and starts none",
    async () => {
      const videosDir = join(home, "videos");
      const before = (await store().list()).length;
      await chmod(videosDir, 0o500);
      let out: Answer;
      try {
        out = await run({
          script: script("Refund an order"),
          video: { new: "Refund an order", confirmedNew: true },
        });
      } finally {
        await chmod(videosDir, 0o700);
      }
      expect(out.provenance.takeId, JSON.stringify(out)).not.toBeNull();
      expect(out.videoVersion).toBeUndefined();
      const entry = out.notStored?.find((n) => n.what === "video");
      expect(entry?.error, JSON.stringify(out.notStored)).toMatch(
        /^the video is not in any flow: /,
      );
      expect(out.summary).toContain("video (the video is not in any flow");
      expect((await store().list()).length).toBe(before);
    },
    RUN_MS,
  );

  it("runs past a take whose video.json will not read", async () => {
    // Red (final review 4): read memberships unguarded — the migration
    // throws, and every run is refused videoUnreadable.
    const library = createLibrary(home);
    const scene = await library.getScene(v1Take);
    if (scene === null) throw new Error("setup: no v1 scene");
    const bad = structuredClone(scene);
    bad.meta.id = "scene-bad-member";
    bad.meta.createdAt = "2026-01-01T00:00:00.000Z";
    await library.putScene(bad);
    await writeFile(join(library.takeDir(bad.meta.id), "video.json"), "{nope");
    try {
      const out = await run({
        script: script("x"),
        video: { new: "create AN invoice!", confirmedNew: true },
      });
      // Past the migration and the duplicate check, to the name refusal.
      expect(out, JSON.stringify(out)).toMatchObject({ reason: "nameTaken" });
    } finally {
      await rm(library.takeDir(bad.meta.id), { recursive: true });
    }
  });

  it("runs past a version whose status.json will not read", async () => {
    // Red (second review 3): read a member's files unguarded — versions()
    // throws in the duplicate check, and every similar run({ new }) is
    // refused videoUnreadable.
    const library = createLibrary(home);
    const scene = await library.getScene(v1Take);
    if (scene === null) throw new Error("setup: no v1 scene");
    const bad = structuredClone(scene);
    bad.meta.id = "scene-bad-status";
    await library.putScene(bad);
    await store().join(bad.meta.id, {
      videoId,
      made: (await memberOf(v1Take)).made,
      recordedRevision: null,
    });
    await writeFile(join(library.takeDir(bad.meta.id), "status.json"), "{nope");
    try {
      const out = await run({
        script: script("x"),
        video: { new: "create AN invoice!", confirmedNew: true },
      });
      expect(out, JSON.stringify(out)).toMatchObject({ reason: "nameTaken" });
    } finally {
      await rm(library.takeDir(bad.meta.id), { recursive: true });
    }
  });

  it(
    "says a take whose video was deleted while the run played is in no video",
    async () => {
      // Red (second review 5): join ignores a missing record — the report
      // carries a videoVersion for a video that no longer exists.
      const made = await store().create({
        name: "Deleted mid-run",
        repo: { key: REPO_KEY },
        startPage: app.url,
      });
      if (!made.ok) throw new Error(JSON.stringify(made));
      const record = join(home, "videos", `${made.video.id}.json`);
      // The browser starts after the video was looked up and before the
      // take joins it: the record goes in between.
      let deleted = false;
      const deleting = createLocalExecutor({
        wallpapersDir: WALLPAPERS_DIR,
        home,
        headless: true,
        outDir: join(home, "out"),
        log: () => undefined,
        launchFn: async (o) => {
          await rm(record);
          deleted = true;
          return launch(o);
        },
      });
      try {
        const out = await deleting.request("run", {
          project,
          script: script("Deleted mid-run"),
          video: { id: made.video.id },
        });
        if (!out.ok) throw new Error(JSON.stringify(out));
        const answer = out.value as Answer;
        // Premise: the record went while the run played.
        expect(deleted).toBe(true);
        const take = answer.provenance.takeId;
        expect(take, JSON.stringify(answer)).not.toBeNull();
        expect(answer.videoVersion).toBeUndefined();
        const entry = answer.notStored?.find((n) => n.what === "video");
        expect(entry?.error, JSON.stringify(answer.notStored)).toMatch(
          /^the video is not in any flow: .*was deleted/,
        );
        await expect(
          readFile(join(home, "takes", take as string, "video.json")),
        ).rejects.toMatchObject({ code: "ENOENT" });
      } finally {
        await deleting.close();
      }
    },
    RUN_MS,
  );

  it("answers threw, and report(id) says so, when the run throws before filming", async () => {
    // Red (final review 11): no catch around runJob — the call rejects and
    // report(id) answers "running" for good.
    const boom = new Proxy(
      {},
      {
        get() {
          throw new Error("boom");
        },
        has() {
          throw new Error("boom");
        },
        ownKeys() {
          throw new Error("boom");
        },
      },
    );
    const out = await executor.request("run", {
      project,
      callId: "c-throw",
      script: boom,
      video: { new: "Something else entirely", confirmedNew: true },
    });
    expect(out).toEqual({
      ok: true,
      value: { outcome: "threw", error: expect.stringContaining("boom") },
    });
    expect(await executor.request("report", { id: "c-throw" })).toEqual(out);
  });
});

import { spawnSync } from "node:child_process";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExportAnswer } from "@demoman/run-core";
import {
  CURRENT_SCHEMA_VERSION,
  type SceneDocument,
} from "@demoman/scene-schema";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createLocalExecutor } from "../src/executor/executor.js";
import {
  EXPIRE_AFTER_MS,
  expireOld,
  expiryStatus,
} from "../src/executor/expiry.js";
import { exportTake } from "../src/executor/export.js";
import { createLibrary, type Library } from "../src/executor/library.js";
import { createVideoStore, type VideoStore } from "../src/executor/videos.js";
import { WALLPAPERS_DIR } from "./fixture.js";
import { readOnlySceneJson } from "./fixtures/scene.js";

const DAY = 86_400_000;
const NOW = new Date("2026-12-01T00:00:00.000Z");
const ago = (days: number, from = NOW) =>
  new Date(from.getTime() - days * DAY).toISOString();
const MADE = {
  repo: { none: "test" },
  agent: { none: "test" },
  by: "test",
  door: "mcp" as const,
};

let home: string;
let outDir: string;
let lib: Library;
let store: VideoStore;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "demoman-expiry-"));
  outDir = await mkdtemp(join(tmpdir(), "demoman-expiry-out-"));
  lib = createLibrary(home);
  store = createVideoStore(home, lib);
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
  await rm(outDir, { recursive: true, force: true });
});

async function newVideo(name: string): Promise<string> {
  const made = await store.create({
    name,
    repo: { none: "test" },
    startPage: "https://app.example.com/",
  });
  if (!made.ok) throw new Error(JSON.stringify(made));
  return made.video.id;
}

/** A take on disk in `videoId`, with `frames` and `thumbs` bytes of files. */
async function take(
  videoId: string,
  id: string,
  createdAt: string,
  o: {
    complete?: boolean;
    edited?: boolean;
    /** Joined by the migration: no recorded revision, and no studio edit. */
    migrated?: boolean;
    script?: boolean;
    exportedAt?: string;
    leasePid?: number;
    frames?: number;
    thumbs?: number;
  } = {},
): Promise<{ dir: string; bytes: number; exported: string | null }> {
  const doc = structuredClone(readOnlySceneJson()) as SceneDocument;
  doc.meta.id = id;
  doc.meta.createdAt = createdAt;
  if (o.migrated === true) {
    doc.edits = { masks: [], holds: [], gaps: [], splits: [], removed: [] };
  }
  await lib.putScene(doc);
  const dir = lib.takeDir(id);
  const frames = o.frames ?? 1000;
  const thumbs = o.thumbs ?? 100;
  await mkdir(join(dir, "frames", "spans"), { recursive: true });
  await writeFile(join(dir, "frames", "k0.jpg"), Buffer.alloc(frames - 10));
  await writeFile(join(dir, "frames", "spans", "s.mp4"), Buffer.alloc(10));
  await mkdir(join(dir, "thumbs"), { recursive: true });
  await writeFile(join(dir, "thumbs", "t.jpg"), Buffer.alloc(thumbs));
  await lib.putJson(id, "status.json", {
    outcome: o.complete === false ? "failed" : "complete",
  });
  await lib.putJson(id, "report.json", { outcome: "complete" });
  if (o.script !== false) await lib.putJson(id, "script.json", { steps: [] });
  let exported: string | null = null;
  if (o.exportedAt !== undefined) {
    exported = join(outDir, `${id}.mp4`);
    await writeFile(exported, "an exported video");
    await writeFile(
      join(dir, "outputs.json"),
      JSON.stringify([
        { path: exported, fileType: "mp4", renderedAt: o.exportedAt },
      ]),
    );
  }
  if (o.leasePid !== undefined) {
    await mkdir(join(dir, ".busy"), { recursive: true });
    await writeFile(
      join(dir, ".busy", `${o.leasePid}-job.json`),
      JSON.stringify({ pid: o.leasePid, op: "export", door: "agent" }),
    );
  }
  const read = await lib.getSceneRead(id);
  await store.join(id, {
    videoId,
    made: MADE,
    recordedRevision: o.migrated
      ? null
      : o.edited
        ? "edited-since"
        : (read?.revision ?? null),
  });
  return { dir, bytes: frames + thumbs, exported };
}

const exists = (path: string) =>
  stat(path).then(
    () => true,
    () => false,
  );

/** A pid that is certainly not running: a child that has already exited. */
const deadPid = () => spawnSync("true").pid as number;

describe("expireOld", () => {
  it("removes only the frames and thumbs of versions not kept, and says what it freed", async () => {
    const one = await newVideo("Checkout");
    const a = await take(one, "scene-a", ago(40), { exportedAt: ago(20) });
    const b = await take(one, "scene-b", ago(39), { edited: true });
    const c = await take(one, "scene-c", ago(38), { exportedAt: ago(5) });
    const d = await take(one, "scene-d", ago(37), { script: false });
    const e = await take(one, "scene-e", ago(36));
    const two = await newVideo("Sign up");
    const leased = await take(two, "scene-f", ago(45), {
      leasePid: process.pid,
    });
    const dead = await take(two, "scene-g", ago(44), {
      leasePid: deadPid(),
      frames: 2000,
      thumbs: 0,
    });
    const young = await take(two, "scene-h", ago(29));
    const current2 = await take(two, "scene-i", ago(10));

    // Premises: what each version of "Checkout" is, as the store reads it.
    const before = await store.versions(one);
    expect(
      before.map((v) => [v.takeId, v.edited, v.hasScript, v.expired]),
    ).toEqual([
      ["scene-a", false, true, null],
      ["scene-b", true, true, null],
      ["scene-c", false, true, null],
      ["scene-d", false, false, null],
      ["scene-e", false, true, null],
    ]);
    expect(
      before.every(
        (v) => NOW.getTime() - Date.parse(v.createdAt) > EXPIRE_AFTER_MS,
      ),
    ).toBe(true);
    expect((await store.current(one))?.takeId).toBe("scene-e");
    expect((await store.current(two))?.takeId).toBe("scene-i");
    const exportedBefore = await readFile(a.exported as string, "utf8");

    const result = await expireOld(store, lib, NOW);
    expect(result).toEqual({
      ranAt: NOW.toISOString(),
      expired: 2,
      freedBytes: a.bytes + dead.bytes,
      skippedLeased: 1,
    });

    for (const gone of [a, dead]) {
      expect(await exists(join(gone.dir, "frames"))).toBe(false);
      expect(await exists(join(gone.dir, "thumbs"))).toBe(false);
    }
    // The records stay.
    for (const f of [
      "scene.json",
      "script.json",
      "report.json",
      "status.json",
      "outputs.json",
      "video.json",
    ]) {
      expect(await exists(join(a.dir, f)), f).toBe(true);
    }
    expect(await readFile(a.exported as string, "utf8")).toBe(exportedBefore);
    expect((await store.videoOf("scene-a"))?.expired).toEqual({
      at: NOW.toISOString(),
      freedBytes: a.bytes,
    });
    for (const kept of [b, c, d, e, leased, young, current2]) {
      expect(await exists(join(kept.dir, "frames", "k0.jpg")), kept.dir).toBe(
        true,
      );
      expect(await exists(join(kept.dir, "thumbs", "t.jpg")), kept.dir).toBe(
        true,
      );
    }
    expect((await store.videoOf("scene-f"))?.expired).toBeUndefined();
    // The state file beside the records is not a video.
    expect((await store.list()).map((v) => v.id).sort()).toEqual(
      [one, two].sort(),
    );
    expect(await expiryStatus(lib)).toEqual(result);
  });

  it("expires an old migrated version that was never edited, exported or current", async () => {
    // Red: read a migrated take (recordedRevision null) as edited — it is
    // kept, and nothing expires.
    const video = await newVideo("Migrated");
    const old = await take(video, "m-old", ago(40), { migrated: true });
    await take(video, "m-new", ago(1), { migrated: true });
    const result = await expireOld(store, lib, NOW);
    expect(result).toMatchObject({ expired: 1 });
    expect(await exists(join(old.dir, "frames"))).toBe(false);
    expect((await store.videoOf("m-old"))?.expired).toBeTruthy();
  });

  it("keeps an old migrated version edited outside scene.edits (its scene saved after its run)", async () => {
    // Red (final review 1, ruling 18): read a migrated take as edited only
    // from scene.edits — a branding-only edit leaves every list empty, and
    // the version's frames go.
    const video = await newVideo("Branded");
    const old = await take(video, "m-old", ago(40), { migrated: true });
    await take(video, "m-new", ago(1), { migrated: true });
    const doc = (await lib.getScene("m-old")) as SceneDocument;
    doc.branding = { ...doc.branding, padding: 0.12 };
    await lib.putScene(doc);
    const ranAt = new Date(ago(40));
    await utimes(join(old.dir, "status.json"), ranAt, ranAt);
    const savedAt = new Date(ranAt.getTime() + 2 * 60_000);
    await utimes(join(old.dir, "scene.json"), savedAt, savedAt);
    // Premise: no edit list is in use, so only the later save says it.
    expect(
      Object.values(doc.edits).every(
        (e) => !Array.isArray(e) || e.length === 0,
      ),
    ).toBe(true);
    expect((await store.versions(video))[0]).toMatchObject({
      takeId: "m-old",
      edited: true,
    });
    expect(await expireOld(store, lib, NOW)).toMatchObject({ expired: 0 });
    expect(await exists(join(old.dir, "frames", "k0.jpg"))).toBe(true);
  });

  it("works past a corrupt video.json, and never expires that take", async () => {
    // Red (final review 4): let versions throw over one take's video.json —
    // the pass fails and nothing of any video expires.
    const video = await newVideo("Checkout");
    const a = await take(video, "scene-a", ago(40));
    await take(video, "scene-b", ago(1));
    const bad = await take(video, "scene-bad", ago(45));
    await writeFile(join(bad.dir, "video.json"), "{nope");
    const result = await expireOld(store, lib, NOW);
    expect(result).toMatchObject({ expired: 1 });
    expect(await exists(join(a.dir, "frames"))).toBe(false);
    expect(await exists(join(bad.dir, "frames", "k0.jpg"))).toBe(true);
  });

  it("works past a version whose status.json or scene will not read, and never expires those", async () => {
    // Red (second review 3): read a member's files unguarded — versions()
    // throws and the pass fails for every video.
    const video = await newVideo("Checkout");
    const a = await take(video, "scene-a", ago(40));
    await take(video, "scene-b", ago(1));
    const status = await take(video, "scene-status", ago(45));
    const tooNew = await take(video, "scene-new", ago(45));
    await writeFile(join(status.dir, "status.json"), "{nope");
    await writeFile(
      join(tooNew.dir, "scene.json"),
      JSON.stringify({ schemaVersion: CURRENT_SCHEMA_VERSION + 1 }),
    );
    const result = await expireOld(store, lib, NOW);
    expect(result).toMatchObject({ expired: 1 });
    expect(await exists(join(a.dir, "frames"))).toBe(false);
    // Premise and result: their frames were there, and stay.
    expect(await exists(join(status.dir, "frames", "k0.jpg"))).toBe(true);
    expect(await exists(join(tooNew.dir, "frames", "k0.jpg"))).toBe(true);
  });

  it("runs at most once an hour", async () => {
    const one = await newVideo("Checkout");
    await take(one, "scene-a", ago(40));
    await take(one, "scene-b", ago(1));
    expect(await expiryStatus(lib)).toEqual({ never: true });
    const first = await expireOld(store, lib, NOW);
    expect(first).toMatchObject({ expired: 1 });
    const soon = new Date(NOW.getTime() + 10 * 60_000);
    expect(await expireOld(store, lib, soon)).toEqual({
      skipped: "ranRecently",
      lastRanAt: NOW.toISOString(),
    });
    // The skip is not a result: status still says the run that happened.
    expect(await expiryStatus(lib)).toEqual(first);
  });

  it("marks the take before removing, so frames/ that will not go answers failed with the path and the mark stands", async () => {
    const one = await newVideo("Checkout");
    const a = await take(one, "scene-a", ago(40));
    await take(one, "scene-b", ago(1));
    // A removal that fails part-way: frames/k0.jpg can go, frames/spans/s.mp4 cannot.
    const spans = join(a.dir, "frames", "spans");
    await chmod(spans, 0o500);
    try {
      const result = await expireOld(store, lib, NOW);
      expect(result).toMatchObject({ ranAt: NOW.toISOString() });
      expect("failed" in result && result.failed).toContain(
        join(a.dir, "frames"),
      );
      expect(await expiryStatus(lib)).toEqual(result);
      expect((await store.videoOf("scene-a"))?.expired).toEqual({
        at: NOW.toISOString(),
        freedBytes: a.bytes,
      });
      // Premise: the removal did stop part-way.
      expect(await exists(join(spans, "s.mp4"))).toBe(true);
    } finally {
      await chmod(spans, 0o700);
    }
  });

  it("removes nothing of a take whose mark will not write, and says so", async () => {
    const one = await newVideo("Checkout");
    const a = await take(one, "scene-a", ago(40));
    await take(one, "scene-b", ago(1));
    // video.json is written beside itself, so a take folder that takes no
    // new file refuses the mark.
    await chmod(a.dir, 0o500);
    try {
      const result = await expireOld(store, lib, NOW);
      expect("failed" in result && result.failed).toContain(
        join(a.dir, "video.json"),
      );
      expect(await exists(join(a.dir, "frames", "k0.jpg"))).toBe(true);
      expect(await exists(join(a.dir, "thumbs", "t.jpg"))).toBe(true);
      expect((await store.videoOf("scene-a"))?.expired).toBeUndefined();
    } finally {
      await chmod(a.dir, 0o700);
    }
  });

  it("counts a linked frames/ as the link, and leaves what it names", async () => {
    const one = await newVideo("Checkout");
    const a = await take(one, "scene-a", ago(40), { thumbs: 100 });
    await take(one, "scene-b", ago(1));
    const elsewhere = join(outDir, "elsewhere");
    await mkdir(elsewhere);
    await writeFile(join(elsewhere, "big.bin"), Buffer.alloc(50_000));
    await rm(join(a.dir, "frames"), { recursive: true });
    await symlink(elsewhere, join(a.dir, "frames"));
    const link = (await lstat(join(a.dir, "frames"))).size;
    // Premise: the link is far smaller than what it names.
    expect(link).toBeLessThan(50_000);
    expect(await expireOld(store, lib, NOW)).toMatchObject({
      expired: 1,
      freedBytes: link + 100,
    });
    expect(await exists(join(a.dir, "frames"))).toBe(false);
    expect(await exists(join(elsewhere, "big.bin"))).toBe(true);
  });

  it("says a state file it cannot read, rather than never", async () => {
    await mkdir(join(home, "videos"), { recursive: true });
    await writeFile(join(home, "videos", ".expiry.json"), "{nope");
    const said = await expiryStatus(lib);
    expect(said).toMatchObject({
      unreadable: expect.stringContaining(".expiry.json"),
    });
  });
});

describe("export of an expired version", () => {
  const exportOf = (takeId: string) => {
    const progress: unknown[] = [];
    return exportTake(
      { takeId },
      {
        wallpapersDir: WALLPAPERS_DIR,
        library: lib,
        session: {
          openWorkPage: () => {
            throw new Error("an expired version must not reach the render");
          },
          headless: true,
        },
        door: "agent",
        home,
        outDir,
        log: () => undefined,
        videos: store,
      },
      (p) => void progress.push(p),
    ).then((answer) => ({ answer, progress }));
  };
  const expectExpired = (answer: ExportAnswer, videoId: string) => {
    expect(answer).toMatchObject({
      outcome: "refusedBeforeExport",
      reason: "versionExpired",
    });
    if (answer.outcome !== "refusedBeforeExport") return;
    expect(answer.detail).toContain(`run({ video: { id: "${videoId}" } })`);
    expect(answer.summary).toMatch(/^Not exported: /);
  };

  it("answers versionExpired for a version listed before it expired", async () => {
    const one = await newVideo("Checkout");
    await take(one, "scene-a", ago(40));
    await take(one, "scene-b", ago(1));
    // The listing an agent holds, from before expiry.
    const listed = await store.versions(one);
    expect(listed[0]).toMatchObject({ takeId: "scene-a", expired: null });
    expect(await expireOld(store, lib, NOW)).toMatchObject({ expired: 1 });
    const { answer, progress } = await exportOf("scene-a");
    expectExpired(answer, one);
    // Read from the mark, not only from the missing folder.
    expect(JSON.stringify(answer)).toContain(`expired on ${NOW.toISOString()}`);
    expect((answer as { detail: string }).detail).toContain(
      `the video "Checkout" (${one})`,
    );
    expect(progress).toEqual([]);
  });

  it("answers noFrames, not versionExpired, for an unmarked take with no frames/", async () => {
    // A run that stopped before its first frame still joins its video, and
    // the frame store makes frames/ only when a frame is written.
    const one = await newVideo("Checkout");
    const a = await take(one, "scene-a", ago(40));
    await rm(join(a.dir, "frames"), { recursive: true });
    expect((await store.videoOf("scene-a"))?.videoId).toBe(one);
    expect((await exportOf("scene-a")).answer).toMatchObject({
      outcome: "refusedBeforeExport",
      reason: "noFrames",
    });
  });

  it("says a video.json it cannot read in the noFrames refusal", async () => {
    const one = await newVideo("Checkout");
    const a = await take(one, "scene-a", ago(40));
    await rm(join(a.dir, "frames"), { recursive: true });
    await writeFile(join(a.dir, "video.json"), "{nope");
    const { answer } = await exportOf("scene-a");
    expect(answer).toMatchObject({ reason: "noFrames" });
    expect(JSON.stringify(answer)).toContain(join(a.dir, "video.json"));
  });
});

describe("the executor", () => {
  it("expires at the start of a run, even one refused, and status says it", async () => {
    const executor = createLocalExecutor({
      wallpapersDir: WALLPAPERS_DIR,
      home,
      headless: true,
      outDir,
      log: () => undefined,
    });
    try {
      const now = new Date();
      const one = await newVideo("Checkout");
      const a = await take(one, "scene-a", ago(40, now));
      await take(one, "scene-b", ago(1, now));
      const status = async () =>
        (
          (await executor.request("status", {})) as {
            value: { expiry: unknown };
          }
        ).value.expiry;
      expect(await status()).toEqual({ never: true });
      const out = await executor.request("run", {
        project: home,
        video: { id: "nope" },
        script: {},
      });
      expect(out).toMatchObject({ value: { reason: "videoNotFound" } });
      expect(await status()).toMatchObject({
        expired: 1,
        freedBytes: a.bytes,
        skippedLeased: 0,
      });
      expect(await readdir(join(a.dir))).not.toContain("frames");
    } finally {
      await executor.close();
    }
  });
});

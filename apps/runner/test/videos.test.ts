import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CURRENT_SCHEMA_VERSION,
  type SceneDocument,
} from "@demoman/scene-schema";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createLibrary } from "../src/executor/library.js";
import {
  createVideoStore,
  EDIT_GAP_MS,
  type Made,
  type TakeVideo,
  VideoError,
  type VideoRepo,
} from "../src/executor/videos.js";
import { readOnlySceneJson } from "./fixtures/scene.js";

let home: string;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "demoman-videos-"));
});
afterEach(() => rm(home, { recursive: true, force: true }));

const repoA: VideoRepo = { key: "github.com/acme/a" };
const repoB: VideoRepo = { key: "github.com/acme/b" };
const made = (repo: Made["repo"]): Made => ({
  repo,
  agent: { none: "test" },
  by: { none: "test" },
  door: "mcp",
});
const refOf = (key: string) => ({
  key,
  root: "/r",
  remote: null,
  branch: null,
  commit: null,
});

async function takeAt(
  lib: ReturnType<typeof createLibrary>,
  id: string,
  createdAt: string,
  outcome = "complete",
): Promise<string> {
  const doc = structuredClone(readOnlySceneJson()) as SceneDocument;
  doc.meta.id = id;
  doc.meta.createdAt = createdAt;
  await lib.putScene(doc);
  await writeFile(
    join(lib.takeDir(id), "status.json"),
    JSON.stringify({ outcome }),
  );
  await writeFile(join(lib.takeDir(id), "script.json"), "{}");
  return id;
}

describe("video store", () => {
  it("creates a record and reads it back", async () => {
    const s = createVideoStore(home, createLibrary(home));
    const r = await s.create({
      name: "Checkout",
      repo: repoA,
      startPage: "https://a.test/",
    });
    if (!r.ok) throw new Error("create refused");
    expect(await s.get(r.video.id)).toEqual(r.video);
    expect(await s.get("absent")).toBeNull();
  });

  it("refuses a same name in the same repo, naming the holder; another repo is fine", async () => {
    const s = createVideoStore(home, createLibrary(home));
    const first = await s.create({
      name: "Check out",
      repo: repoA,
      startPage: "x",
    });
    if (!first.ok) throw new Error("setup");
    const again = await s.create({
      name: "check-out",
      repo: repoA,
      startPage: "x",
    });
    expect(again).toEqual({
      ok: false,
      reason: "nameTaken",
      holder: first.video,
    });
    expect(
      (await s.create({ name: "Check out", repo: repoB, startPage: "x" })).ok,
    ).toBe(true);
  });

  it("rename onto a taken name answers nameTaken; a free name renames", async () => {
    const s = createVideoStore(home, createLibrary(home));
    const a = await s.create({ name: "Alpha", repo: repoA, startPage: "x" });
    const b = await s.create({ name: "Beta", repo: repoA, startPage: "x" });
    if (!a.ok || !b.ok) throw new Error("setup");
    expect(await s.rename(b.video.id, "alpha")).toMatchObject({
      ok: false,
      reason: "nameTaken",
    });
    expect(await s.rename(b.video.id, "Gamma")).toEqual({ ok: true });
    expect((await s.get(b.video.id))?.name).toBe("Gamma");
    expect(await s.rename("absent", "Z")).toEqual({
      ok: false,
      reason: "videoNotFound",
    });
  });

  it("numbers versions by createdAt; current skips a stopped take", async () => {
    const lib = createLibrary(home);
    const s = createVideoStore(home, lib);
    const v = await s.create({ name: "Flow", repo: repoA, startPage: "x" });
    if (!v.ok) throw new Error("setup");
    // Joined out of order, so numbering must come from createdAt, not join order.
    for (const [id, at, outcome] of [
      ["t2", "2026-10-02T00:00:00.000Z", "complete"],
      ["t3", "2026-10-03T00:00:00.000Z", "stopped"],
      ["t1", "2026-10-01T00:00:00.000Z", "complete"],
    ] as const) {
      await takeAt(lib, id, at, outcome);
      await s.join(id, {
        videoId: v.video.id,
        made: made(refOf("github.com/acme/a")),
        recordedRevision: null,
      });
    }
    const vs = await s.versions(v.video.id);
    expect(vs.map((x) => [x.takeId, x.number, x.complete])).toEqual([
      ["t1", 1, true],
      ["t2", 2, true],
      ["t3", 3, false],
    ]);
    // No recorded revision and no studio edit in the scene: unedited (ruling 15).
    expect(vs.every((x) => !x.edited)).toBe(true);
    expect((await s.current(v.video.id))?.takeId).toBe("t2");
  });

  it("an unknown-repo video adopts the first known repo joined", async () => {
    const lib = createLibrary(home);
    const s = createVideoStore(home, lib);
    const v = await s.create({
      name: "Old",
      repo: { unknown: true },
      startPage: "x",
    });
    if (!v.ok) throw new Error("setup");
    await takeAt(lib, "t1", "2026-10-01T00:00:00.000Z");
    await s.join("t1", {
      videoId: v.video.id,
      made: made({ none: "not a checkout" }),
      recordedRevision: null,
    });
    expect((await s.get(v.video.id))?.repo).toEqual({ unknown: true });
    await s.join("t1", {
      videoId: v.video.id,
      made: made(refOf("github.com/acme/a")),
      recordedRevision: null,
    });
    expect((await s.get(v.video.id))?.repo).toEqual(repoA);
  });

  // Red: `mkdir`/`writeFile` with default modes in `write` or `writeMember`.
  // A take's video.json names the OS user and the repo, as private as its
  // frames (main's audit run 1 made take files 0600).
  it("writes records and memberships owner-only", async () => {
    const modeOf = async (path: string) => (await stat(path)).mode & 0o777;
    const lib = createLibrary(home);
    const s = createVideoStore(home, lib);
    const v = await s.create({ name: "Private", repo: repoA, startPage: "x" });
    if (!v.ok) throw new Error("setup");
    await takeAt(lib, "t1", "2026-10-01T00:00:00.000Z");
    await s.join("t1", {
      videoId: v.video.id,
      made: made(refOf("github.com/acme/a")),
      recordedRevision: null,
    });
    expect(await modeOf(join(home, "videos"))).toBe(0o700);
    expect(await modeOf(join(home, "videos", `${v.video.id}.json`))).toBe(
      0o600,
    );
    expect(await modeOf(join(lib.takeDir("t1"), "video.json"))).toBe(0o600);
  });

  it("marks a version expired and lists it so", async () => {
    const lib = createLibrary(home);
    const s = createVideoStore(home, lib);
    const v = await s.create({ name: "Flow", repo: repoA, startPage: "x" });
    if (!v.ok) throw new Error("setup");
    await takeAt(lib, "t1", "2026-10-01T00:00:00.000Z");
    await s.join("t1", {
      videoId: v.video.id,
      made: made({ none: "n" }),
      recordedRevision: null,
    });
    await s.markExpired("t1", "2026-11-01T00:00:00.000Z", 42);
    expect((await s.versions(v.video.id))[0]?.expired).toEqual({
      at: "2026-11-01T00:00:00.000Z",
      freedBytes: 42,
    });
  });

  it("lists a corrupt record as unreadable with its path; get throws", async () => {
    const s = createVideoStore(home, createLibrary(home));
    await mkdir(join(home, "videos"), { recursive: true });
    const bad = "0b5d2a6e-1c3f-4e8a-9b7d-2f4c6a8e0b1d";
    const path = join(home, "videos", `${bad}.json`);
    await writeFile(path, "{nope");
    const listed = await s.list();
    expect(listed).toEqual([
      { id: bad, unreadable: expect.stringContaining(path) },
    ]);
    await expect(s.get(bad)).rejects.toMatchObject({
      reason: "videoUnreadable",
    });
  });

  it("a corrupt video.json throws from videoOf, naming the file; versions leaves that take out", async () => {
    // Red: let versions throw over one take's video.json — every video's
    // listing, and every run, fails over one bad file (final review 4).
    const lib = createLibrary(home);
    const s = createVideoStore(home, lib);
    const v = await s.create({ name: "Flow", repo: repoA, startPage: "x" });
    if (!v.ok) throw new Error("setup");
    await takeAt(lib, "t1", "2026-10-01T00:00:00.000Z");
    await takeAt(lib, "t2", "2026-10-02T00:00:00.000Z");
    await s.join("t2", {
      videoId: v.video.id,
      made: made({ none: "n" }),
      recordedRevision: null,
    });
    const path = join(lib.takeDir("t1"), "video.json");
    await writeFile(path, "[oops");
    const err = await s.videoOf("t1").catch((e) => e);
    expect(err).toBeInstanceOf(VideoError);
    expect(err).toMatchObject({ reason: "videoUnreadable" });
    expect(err.message).toContain(path);
    expect((await s.versions(v.video.id)).map((x) => x.takeId)).toEqual(["t2"]);
  });

  it("remove deletes the record only", async () => {
    const lib = createLibrary(home);
    const s = createVideoStore(home, lib);
    const v = await s.create({ name: "Flow", repo: repoA, startPage: "x" });
    if (!v.ok) throw new Error("setup");
    await takeAt(lib, "t1", "2026-10-01T00:00:00.000Z");
    await s.join("t1", {
      videoId: v.video.id,
      made: made({ none: "n" }),
      recordedRevision: null,
    });
    await s.remove(v.video.id);
    expect(await s.get(v.video.id)).toBeNull();
    expect((await s.videoOf("t1"))?.videoId).toBe(v.video.id);
  });

  it("versions ignores stray entries in takes/ (.trash-*, .DS_Store)", async () => {
    const lib = createLibrary(home);
    const s = createVideoStore(home, lib);
    const v = await s.create({ name: "Flow", repo: repoA, startPage: "x" });
    if (!v.ok) throw new Error("setup");
    await takeAt(lib, "t1", "2026-10-01T00:00:00.000Z");
    await s.join("t1", {
      videoId: v.video.id,
      made: made({ none: "n" }),
      recordedRevision: null,
    });
    await mkdir(join(home, "takes", ".trash-x"));
    await writeFile(join(home, "takes", ".DS_Store"), "");
    await writeFile(join(home, "takes", "stray.txt"), "");
    expect((await s.versions(v.video.id)).map((x) => x.takeId)).toEqual(["t1"]);
  });

  it("edited is false at the recorded revision and true once the scene changes", async () => {
    const lib = createLibrary(home);
    const s = createVideoStore(home, lib);
    const v = await s.create({ name: "Flow", repo: repoA, startPage: "x" });
    if (!v.ok) throw new Error("setup");
    await takeAt(lib, "t1", "2026-10-01T00:00:00.000Z");
    const read = await lib.getSceneRead("t1");
    await s.join("t1", {
      videoId: v.video.id,
      made: made({ none: "n" }),
      recordedRevision: read?.revision ?? "missing",
    });
    expect(read?.revision).toBeTruthy();
    expect((await s.versions(v.video.id))[0]?.edited).toBe(false);
    const doc = structuredClone(read?.scene) as SceneDocument;
    doc.meta.name = "renamed in the studio";
    await lib.putScene(doc);
    expect((await s.versions(v.video.id))[0]?.edited).toBe(true);
  });

  it("an id that is not a video id is never joined into a path", async () => {
    // Red: drop the id guard from get — `../x` reads `<home>/x.json`.
    const s = createVideoStore(home, createLibrary(home));
    await mkdir(join(home, "videos"), { recursive: true });
    const outside = join(home, "x.json");
    await writeFile(
      outside,
      JSON.stringify({ id: "../x", name: "Outside", repo: repoA }),
    );
    expect(await s.get("../x")).toBeNull();
    expect(await s.rename("../x", "Inside")).toEqual({
      ok: false,
      reason: "videoNotFound",
    });
    expect(await s.versions("../x")).toEqual([]);
    expect(await s.current("../x")).toBeNull();
    await expect(s.remove("../x")).rejects.toMatchObject({
      reason: "videoUnwritable",
    });
    // Untouched: neither renamed nor removed.
    expect(JSON.parse(await readFile(outside, "utf8")).name).toBe("Outside");
  });

  it("only <uuid>.json in videos/ is a record; anything else is not listed", async () => {
    // Red (second review 7a): list a file not named for an id as unreadable
    // — its "Couldn't read" row's Delete answers videoNotFound forever.
    const s = createVideoStore(home, createLibrary(home));
    const v = await s.create({ name: "Flow", repo: repoA, startPage: "x" });
    if (!v.ok) throw new Error("setup");
    for (const f of ["notes.json", ".expiry.json", ".DS_Store", "x.txt"])
      await writeFile(join(home, "videos", f), "{}");
    await mkdir(join(home, "videos", ".lock"));
    expect(await s.list()).toEqual([v.video]);
  });

  it("a migrated take (no recorded revision) is edited when it carries an edit, its scene was written later, or it has no status", async () => {
    // Red (ruling 18): read edited from scene.edits alone — "branded",
    // whose edit is a top-level field, and "statusless" read unedited, and
    // expiry takes their frames.
    const lib = createLibrary(home);
    const s = createVideoStore(home, lib);
    const v = await s.create({ name: "Flow", repo: repoA, startPage: "x" });
    if (!v.ok) throw new Error("setup");
    const none = { masks: [], holds: [], gaps: [], splits: [], removed: [] };
    const mask = { id: "m1", rect: { x: 0, y: 0, width: 10, height: 10 } };
    const t0 = new Date("2026-10-01T00:00:00.000Z");
    const later = new Date(t0.getTime() + EDIT_GAP_MS + 5_000);
    const soon = new Date(t0.getTime() + EDIT_GAP_MS - 5_000);
    const cases = [
      ["plain", none, t0, true],
      ["masked", { ...none, masks: [mask] }, t0, true],
      ["branded", none, later, true],
      ["resaved", none, soon, true],
      ["statusless", none, t0, false],
    ] as const;
    for (const [id, edits, sceneAt, status] of cases) {
      const doc = structuredClone(readOnlySceneJson()) as SceneDocument;
      doc.meta.id = id;
      doc.edits = structuredClone(edits) as unknown as SceneDocument["edits"];
      if (id === "branded") doc.branding = { ...doc.branding, padding: 0.12 };
      await lib.putScene(doc);
      const dir = lib.takeDir(id);
      if (status) {
        await writeFile(join(dir, "status.json"), "{}");
        await utimes(join(dir, "status.json"), t0, t0);
      }
      await utimes(join(dir, "scene.json"), sceneAt, sceneAt);
      await s.join(id, {
        videoId: v.video.id,
        made: made({ none: "n" }),
        recordedRevision: null,
      });
    }
    // Premise: "branded" carries no edit list, so only its mtime can say.
    const branded = await lib.getScene("branded");
    expect(
      Object.values(branded?.edits ?? {}).every(
        (e) => !Array.isArray(e) || e.length === 0,
      ),
    ).toBe(true);
    const byId = Object.fromEntries(
      (await s.versions(v.video.id)).map((x) => [x.takeId, x.edited]),
    );
    expect(byId).toEqual({
      plain: false,
      masked: true,
      branded: true,
      resaved: false,
      statusless: true,
    });
  });
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("the library's lock", () => {
  it("a holder whose lock was taken over leaves the new owner's lock, and says so", async () => {
    // Red (second review 2): release with an unconditional rm — the slow
    // holder deletes the lock the new owner holds.
    const lib = createLibrary(home);
    const lines: string[] = [];
    // The slow holder never refreshes, so it goes stale at once.
    const slow = createVideoStore(home, lib, {
      log: (l) => lines.push(l),
      lockStaleMs: 50,
      lockRefreshMs: 60_000,
    });
    const next = createVideoStore(home, lib, { lockStaleMs: 50 });
    const lock = join(home, "videos", ".lock");
    let letNextGo = () => {};
    const nextHolds = new Promise<void>((r) => {
      letNextGo = r;
    });
    let nextIn = false;
    let nextDone: Promise<unknown> = Promise.resolve();
    const slowDone = await slow.exclusive(async () => {
      await sleep(120);
      nextDone = next.exclusive(async () => {
        nextIn = true;
        await nextHolds;
        return "next";
      });
      while (!nextIn) await sleep(10);
      return "slow";
    });
    // Its answer stands; the lock is the new owner's and still there.
    expect(slowDone).toEqual({ ok: true, value: "slow" });
    expect((await stat(lock)).isDirectory()).toBe(true);
    expect(lines.join("\n")).toMatch(
      /left .*\.lock in place: another process took it over/,
    );
    letNextGo();
    expect(await nextDone).toEqual({ ok: true, value: "next" });
    await expect(stat(lock)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refreshes the lock's mtime while held, and names its owner", async () => {
    // Red (second review 2): no refresh — a holder slower than
    // LOCK_STALE_MS reads as dead and is taken over.
    const lib = createLibrary(home);
    const s = createVideoStore(home, lib, { lockRefreshMs: 20 });
    const lock = join(home, "videos", ".lock");
    const old = new Date(Date.now() - 3_600_000);
    const r = await s.exclusive(async () => {
      const owner = JSON.parse(await readFile(join(lock, "owner"), "utf8"));
      expect(owner).toMatchObject({ pid: process.pid });
      expect(typeof owner.token).toBe("string");
      await utimes(lock, old, old);
      // Premise: the mtime now reads an hour old.
      expect((await stat(lock)).mtimeMs).toBeLessThan(Date.now() - 3_000_000);
      await sleep(150);
      return (await stat(lock)).mtimeMs;
    });
    if (!r.ok) throw new Error(r.held);
    expect(r.value).toBeGreaterThan(Date.now() - 10_000);
  });
});

describe("join", () => {
  it("waits for the lock, so a rename cannot land between its read and write", async () => {
    // Red (second review 4): join outside the lock — it finishes while
    // another process holds it.
    const lib = createLibrary(home);
    const s = createVideoStore(home, lib);
    const v = await s.create({
      name: "Old",
      repo: { unknown: true },
      startPage: "x",
    });
    if (!v.ok) throw new Error("setup");
    await takeAt(lib, "t1", "2026-10-01T00:00:00.000Z");
    const lock = join(home, "videos", ".lock");
    await mkdir(lock);
    let done = false;
    const joining = s
      .join("t1", {
        videoId: v.video.id,
        made: made(refOf("github.com/acme/a")),
        recordedRevision: null,
      })
      .then(() => {
        done = true;
      });
    await sleep(300);
    expect(done).toBe(false);
    expect(await s.videoOf("t1")).toBeNull();
    await rm(lock, { recursive: true });
    await joining;
    expect((await s.get(v.video.id))?.repo).toEqual(repoA);
  });

  it("into a deleted video throws videoNotFound and writes no membership", async () => {
    // Red (second review 5): ignore get() returning null — the take joins
    // a video that no longer exists.
    const lib = createLibrary(home);
    const s = createVideoStore(home, lib);
    const v = await s.create({ name: "Flow", repo: repoA, startPage: "x" });
    if (!v.ok) throw new Error("setup");
    await takeAt(lib, "t1", "2026-10-01T00:00:00.000Z");
    await s.remove(v.video.id);
    const err = await s
      .join("t1", {
        videoId: v.video.id,
        made: made({ none: "n" }),
        recordedRevision: null,
      })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(VideoError);
    expect(err).toMatchObject({ reason: "videoNotFound" });
    expect((err as Error).message).toContain(v.video.id);
    expect(await s.videoOf("t1")).toBeNull();
  });
});

describe("versions past one take that will not read", () => {
  it("leaves out a take whose status.json, script.json or scene will not read, and leftOut names the file", async () => {
    // Red (second review 3): read a member's files unguarded — one bad
    // file throws versions() for the whole video.
    const lib = createLibrary(home);
    const s = createVideoStore(home, lib);
    const v = await s.create({ name: "Flow", repo: repoA, startPage: "x" });
    if (!v.ok) throw new Error("setup");
    const ids = ["good", "status", "script", "tooNew", "noScene"];
    for (const [i, id] of ids.entries()) {
      await takeAt(lib, id, `2026-10-0${i + 1}T00:00:00.000Z`);
      await s.join(id, {
        videoId: v.video.id,
        made: made({ none: "n" }),
        recordedRevision: null,
      });
    }
    // Premise: every take is a version before the files go bad.
    expect(await s.versions(v.video.id)).toHaveLength(ids.length);
    const bad = {
      status: join(lib.takeDir("status"), "status.json"),
      script: join(lib.takeDir("script"), "script.json"),
      tooNew: join(lib.takeDir("tooNew"), "scene.json"),
      noScene: join(lib.takeDir("noScene"), "scene.json"),
    };
    await writeFile(bad.status, "{nope");
    await writeFile(bad.script, "{nope");
    await writeFile(
      bad.tooNew,
      JSON.stringify({ schemaVersion: CURRENT_SCHEMA_VERSION + 1 }),
    );
    await rm(bad.noScene);
    expect((await s.versions(v.video.id)).map((x) => x.takeId)).toEqual([
      "good",
    ]);
    expect((await s.current(v.video.id))?.takeId).toBe("good");
    for (const [id, path] of Object.entries(bad)) {
      const member = await s.videoOf(id);
      if (member === null) throw new Error(`setup: ${id} has no membership`);
      expect(await s.leftOut(id, member), id).toContain(path);
    }
    const good = await s.videoOf("good");
    expect(await s.leftOut("good", good as TakeVideo)).toBeNull();
  });
});

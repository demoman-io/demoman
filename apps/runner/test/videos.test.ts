import { spawnSync } from "node:child_process";
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
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

// Another process acting between two of this one's calls, on demand: each
// watch fires once, on the next read (readFile or stat) of its path; the
// read resolves, then `after` runs before the reader gets its answer. With
// no watch, both are the real ones.
type Watch = { path: string; after: () => Promise<void> };
const seen = vi.hoisted(() => ({ watches: [] as Watch[] }));
const onRead = (path: string, after: () => Promise<void>) =>
  seen.watches.push({ path, after });
vi.mock("node:fs/promises", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs/promises")>();
  const watch =
    <A extends unknown[], R>(real: (...a: A) => Promise<R>) =>
    async (...a: A): Promise<R> => {
      const answer = await real(...a);
      const at = seen.watches.findIndex((w) => w.path === String(a[0]));
      if (at >= 0) await seen.watches.splice(at, 1)[0]?.after();
      return answer;
    };
  const readFile = watch(fs.readFile) as typeof fs.readFile;
  const stat = watch(fs.stat) as typeof fs.stat;
  return { ...fs, default: { ...fs, readFile, stat }, readFile, stat };
});
const deadPid = () => spawnSync("true").pid as number;

let home: string;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "demoman-videos-"));
});
afterEach(() => {
  seen.watches.length = 0;
  return rm(home, { recursive: true, force: true });
});

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

  // Red (DEM-88): markExpired outside the lock. Its read of video.json
  // names the source flow; the merge lands; its write puts that flow back.
  it("an expiry that read before a merge does not write the merged flow back", async () => {
    const lib = createLibrary(home);
    const s = createVideoStore(home, lib);
    const from = await s.create({ name: "F", repo: repoA, startPage: "x" });
    const into = await s.create({ name: "I", repo: repoA, startPage: "x" });
    if (!from.ok || !into.ok) throw new Error("setup");
    await takeAt(lib, "t1", "2026-10-01T00:00:00.000Z");
    await s.join("t1", {
      videoId: from.video.id,
      made: made({ none: "n" }),
      recordedRevision: null,
    });
    const lock = join(home, "videos", ".lock");
    const member = join(lib.takeDir("t1"), "video.json");
    let merging: Promise<unknown> = Promise.resolve();
    let first = "";
    onRead(member, async () => {
      merging = s.merge(from.video.id, into.video.id);
      // The merge's first read of the lock: it found the lock held, or (when
      // it has already moved t1) it is releasing its own. Either lets the
      // expiry go on.
      const lockRead = new Promise<string>((r) =>
        onRead(lock, async () => {
          const now = JSON.parse(await readFile(member, "utf8"));
          r(now.videoId === into.video.id ? "merged" : "waited");
        }),
      );
      first = await Promise.race([merging.then(() => "merged"), lockRead]);
    });
    await s.markExpired("t1", "2026-11-01T00:00:00.000Z", 42);
    // Premise: the merge started while the expiry held its read, and had to
    // wait for the lock (unlocked, it finishes first and this goes red).
    expect(first).toBe("waited");
    expect(await merging).toEqual({ ok: true, moved: 1 });
    expect(await s.videoOf("t1")).toMatchObject({
      videoId: into.video.id,
      expired: { at: "2026-11-01T00:00:00.000Z", freedBytes: 42 },
    });
    expect(await s.get(from.video.id)).toBeNull();
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
  // Red (DEM-91): the rename-aside lock. The waiter judged the lock dead,
  // another process took it over in between, and the waiter then moved that
  // live lock aside and held it too.
  it("a waiter that judged the lock dead does not take it after another process has", async () => {
    const lib = createLibrary(home);
    const lock = join(home, "videos", ".lock");
    await mkdir(join(home, "videos"), { recursive: true });
    const dead = `${deadPid()} old-token\n`;
    await writeFile(lock, dead);
    const old = new Date(Date.now() - 3_600_000);
    await utimes(lock, old, old);
    // Premise: its holder is gone, and it has not been touched for an hour.
    expect(() => process.kill(Number.parseInt(dead, 10), 0)).toThrow();
    expect((await stat(lock)).mtimeMs).toBeLessThan(Date.now() - 3_000_000);
    const waiter = createVideoStore(home, lib);
    const other = createVideoStore(home, lib);
    let active = 0;
    let most = 0;
    const hold = async (ms: number) => {
      active++;
      most = Math.max(most, active);
      await sleep(ms);
      active--;
    };
    let otherIn = false;
    let otherDone: Promise<unknown> = Promise.resolve();
    onRead(lock, async () => {
      otherDone = other.exclusive(async () => {
        otherIn = true;
        // Past exclusive's own short wait, so the waiter answers `held`.
        await hold(1000);
        return "other";
      });
      const inside = (async () => {
        while (!otherIn) await sleep(5);
      })();
      await Promise.race([otherDone, inside]);
    });
    const mine = await waiter.exclusive(async () => {
      await hold(0);
      return "waiter";
    });
    // Premise: the other process took the lock between the waiter's read
    // and its next step.
    expect(otherIn).toBe(true);
    expect(await otherDone).toEqual({ ok: true, value: "other" });
    expect(most).toBe(1);
    expect(mine).toEqual({
      ok: false,
      held: `this process holds ${lock}`,
    });
  });

  // Red (review): exclusive with no wait at all — a dead lock another
  // waiter was breaking at that moment answered an error, not `held`.
  it("exclusive on a dead lock someone is breaking right now takes it once they are done", async () => {
    const lock = join(home, "videos", ".lock");
    await mkdir(join(home, "videos"), { recursive: true });
    await writeFile(lock, `${deadPid()} old-token\n`);
    await writeFile(`${lock}.break`, "");
    setTimeout(() => void rm(`${lock}.break`, { force: true }), 100);
    const r = await createVideoStore(home, createLibrary(home)).exclusive(
      async () => "mine",
    );
    expect(r).toEqual({ ok: true, value: "mine" });
  });

  it("a holder whose lock was replaced leaves the new one, and says so", async () => {
    // Red (second review 2): release with an unconditional rm — the holder
    // deletes the lock another process holds now.
    const lines: string[] = [];
    const s = createVideoStore(home, createLibrary(home), {
      log: (l) => lines.push(l),
    });
    const lock = join(home, "videos", ".lock");
    const r = await s.exclusive(async () => {
      // Premise: the lock names this process while it holds it.
      expect(await readFile(lock, "utf8")).toMatch(
        new RegExp(`^${process.pid} `),
      );
      await writeFile(lock, "1 someone-else\n");
      return "mine";
    });
    // Its answer stands; the lock is the other's and still there.
    expect(r).toEqual({ ok: true, value: "mine" });
    expect(await readFile(lock, "utf8")).toBe("1 someone-else\n");
    expect(lines.join("\n")).toMatch(
      /\.lock was no longer this process's lock .*it named 1 someone-else/,
    );
  });

  // Red (review): refuse every call on a folder lock — an older Demoman
  // running beside this one, or one that died holding it, refused every run.
  it("an older Demoman's folder lock is held while fresh, and cleared once stale", async () => {
    const s = createVideoStore(home, createLibrary(home));
    const lock = join(home, "videos", ".lock");
    await mkdir(lock, { recursive: true });
    await writeFile(join(lock, "owner"), '{"token":"t","pid":1}');
    // Red (second review): clear only `owner` — a folder holding anything
    // else never empties, and every call spun on it forever.
    await writeFile(join(lock, ".DS_Store"), "");
    expect(await s.exclusive(async () => "mine")).toEqual({
      ok: false,
      held: `an older Demoman holds ${lock}`,
    });
    const old = new Date(Date.now() - 3 * 60_000);
    await utimes(lock, old, old);
    const made = await s.create({ name: "Flow", repo: repoA, startPage: "x" });
    expect(made.ok).toBe(true);
    // Cleared, and this call's own lock released after.
    await expect(stat(lock)).rejects.toMatchObject({ code: "ENOENT" });
  }, 10_000);

  // Red (second review): a breaker outlasting exclusive's short wait (one a
  // killed process left, cleared at 10 s) answered an error, not `held`.
  it("exclusive on a dead lock whose breaker stays answers held", async () => {
    const lock = join(home, "videos", ".lock");
    await mkdir(join(home, "videos"), { recursive: true });
    await writeFile(lock, `${deadPid()} old-token\n`);
    await writeFile(`${lock}.break`, "");
    expect(
      await createVideoStore(home, createLibrary(home)).exclusive(
        async () => "mine",
      ),
    ).toEqual({
      ok: false,
      held: `another process is clearing ${lock}, left by one that died`,
    });
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
    await writeFile(lock, `${process.pid} another-holder\n`);
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

describe("adopt", () => {
  const U1 = "11111111-1111-4111-8111-111111111111";
  const U2 = "22222222-2222-4222-8222-222222222222";
  const kept = { root: "/r", file: ".demoman/checkout.json" };

  it("adopt writes a record with the given id", async () => {
    const s = createVideoStore(home, createLibrary(home));
    const a = { id: U1, name: "Checkout", repo: repoA, startPage: "x", kept };
    const first = await s.adopt(a);
    if (!first.ok) throw new Error("adopt refused");
    expect(first.created).toBe(true);
    expect(first.video.id).toBe(U1);
    const second = await s.adopt({ ...a, name: "Checkout 2" });
    if (!second.ok) throw new Error("second adopt refused");
    expect(second.created).toBe(false);
    expect(second.video.id).toBe(U1);
    expect(second.video.name).toBe("Checkout 2");
    expect(second.video.kept).toEqual(kept);
    expect(await s.list()).toHaveLength(1);
  });

  it("adopt refuses a name another flow holds in the repo", async () => {
    const s = createVideoStore(home, createLibrary(home));
    const made1 = await s.create({
      name: "Checkout",
      repo: repoA,
      startPage: "x",
    });
    if (!made1.ok) throw new Error("setup");
    const r = await s.adopt({
      id: U2,
      name: "Checkout",
      repo: repoA,
      startPage: "x",
      kept,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("repoFlowNameTaken");
    expect(r.holder.id).toBe(made1.video.id);
    expect(await s.list()).toHaveLength(1);
    expect(await s.get(U2)).toBeNull();
  });

  it("adopt throws on an id that is not a flow id", async () => {
    const s = createVideoStore(home, createLibrary(home));
    await expect(
      s.adopt({ id: "../x", name: "N", repo: repoA, startPage: "x", kept }),
    ).rejects.toMatchObject({ reason: "videoUnwritable" });
  });

  it("setKept sets, clears and names a missing flow", async () => {
    const s = createVideoStore(home, createLibrary(home));
    await s.adopt({ id: U1, name: "N", repo: repoA, startPage: "x", kept });
    expect(await s.setKept(U1, null)).toEqual({ ok: true });
    expect((await s.get(U1))?.kept).toBeUndefined();
    expect(await s.setKept(U1, kept)).toEqual({ ok: true });
    expect((await s.get(U1))?.kept).toEqual(kept);
    expect(await s.setKept(U2, kept)).toEqual({
      ok: false,
      reason: "videoNotFound",
    });
  });

  it("merge moves every take and removes the source", async () => {
    const lib = createLibrary(home);
    const s = createVideoStore(home, lib);
    const a = await s.create({ name: "A", repo: repoA, startPage: "x" });
    const b = await s.create({ name: "B", repo: repoA, startPage: "x" });
    if (!a.ok || !b.ok) throw new Error("setup");
    for (const [id, at, rev] of [
      ["t1", "2026-10-01T00:00:00.000Z", null],
      ["t2", "2026-10-02T00:00:00.000Z", "rev-2"],
    ] as const) {
      await takeAt(lib, id, at);
      await s.join(id, {
        videoId: a.video.id,
        made: made(refOf("github.com/acme/a")),
        recordedRevision: rev,
      });
    }
    // Premise: both takes belong to A before the merge.
    expect(await s.versions(a.video.id)).toHaveLength(2);
    expect(await s.merge(a.video.id, b.video.id)).toEqual({
      ok: true,
      moved: 2,
    });
    expect((await s.versions(b.video.id)).map((v) => v.takeId)).toEqual([
      "t1",
      "t2",
    ]);
    expect((await s.videoOf("t2"))?.recordedRevision).toBe("rev-2");
    expect((await s.videoOf("t1"))?.made).toEqual(
      made(refOf("github.com/acme/a")),
    );
    expect(await s.get(a.video.id)).toBeNull();
  });

  it("merge of a missing flow names it", async () => {
    const s = createVideoStore(home, createLibrary(home));
    const b = await s.create({ name: "B", repo: repoA, startPage: "x" });
    if (!b.ok) throw new Error("setup");
    expect(await s.merge(U1, b.video.id)).toEqual({
      ok: false,
      reason: "videoNotFound",
      id: U1,
    });
    expect(await s.merge(b.video.id, U2)).toEqual({
      ok: false,
      reason: "videoNotFound",
      id: U2,
    });
    expect(await s.get(b.video.id)).not.toBeNull();
  });

  it("merge of a flow into itself is refused and removes nothing", async () => {
    const s = createVideoStore(home, createLibrary(home));
    const a = await s.create({ name: "A", repo: repoA, startPage: "x" });
    if (!a.ok) throw new Error("setup");
    expect(await s.merge(a.video.id, a.video.id)).toEqual({
      ok: false,
      reason: "sameFlow",
      id: a.video.id,
    });
    expect(await s.get(a.video.id)).not.toBeNull();
  });

  it("adopt of an existing id onto a name another flow holds refuses", async () => {
    const s = createVideoStore(home, createLibrary(home));
    const other = await s.create({
      name: "Taken",
      repo: repoA,
      startPage: "x",
    });
    if (!other.ok) throw new Error("setup");
    await s.adopt({ id: U1, name: "Mine", repo: repoA, startPage: "x", kept });
    const r = await s.adopt({
      id: U1,
      name: "Taken",
      repo: repoA,
      startPage: "x",
      kept: { root: "/r", file: "other.json" },
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.holder.id).toBe(other.video.id);
    const stored = await s.get(U1);
    expect(stored?.name).toBe("Mine");
    expect(stored?.kept).toEqual(kept);
  });

  it("a merge that stops partway says how many videos moved and keeps the source", async () => {
    const lib = createLibrary(home);
    const s = createVideoStore(home, lib);
    const a = await s.create({ name: "A", repo: repoA, startPage: "x" });
    const b = await s.create({ name: "B", repo: repoA, startPage: "x" });
    if (!a.ok || !b.ok) throw new Error("setup");
    for (const [id, at] of [
      ["t1", "2026-10-01T00:00:00.000Z"],
      ["t2", "2026-10-02T00:00:00.000Z"],
    ] as const) {
      await takeAt(lib, id, at);
      await s.join(id, {
        videoId: a.video.id,
        made: made(refOf("github.com/acme/a")),
        recordedRevision: null,
      });
    }
    // Premise: t2 is a member of A before its video.json goes bad.
    expect((await s.videoOf("t2"))?.videoId).toBe(a.video.id);
    await writeFile(join(lib.takeDir("t2"), "video.json"), "{nope");
    const err = await s.merge(a.video.id, b.video.id).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(VideoError);
    expect((err as VideoError).message).toContain("after moving 1 video into");
    expect((err as VideoError).message).toContain(b.video.id);
    expect((err as VideoError).message).toContain("video.json");
    expect(await s.get(a.video.id)).not.toBeNull();
    expect((await s.videoOf("t1"))?.videoId).toBe(b.video.id);
  });
});

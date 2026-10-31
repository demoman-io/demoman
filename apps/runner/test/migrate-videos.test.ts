import { mkdir, mkdtemp, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CURRENT_SCHEMA_VERSION,
  type SceneDocument,
} from "@demoman/scene-schema";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createLibrary } from "../src/executor/library.js";
import {
  ensureVideos,
  hostOf,
  startPage,
} from "../src/executor/migrate-videos.js";
import {
  createVideoStore,
  LOCK_STALE_MS,
  VideoError,
} from "../src/executor/videos.js";
import names from "./fixtures/library-names.json";
import { readOnlySceneJson } from "./fixtures/scene.js";

let home: string;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "demoman-migrate-"));
});
afterEach(() => rm(home, { recursive: true, force: true }));

async function put(
  lib: ReturnType<typeof createLibrary>,
  id: string,
  name: string,
  originUrl: string,
  createdAt: string,
) {
  const doc = structuredClone(readOnlySceneJson()) as SceneDocument;
  doc.meta.id = id;
  doc.meta.name = name;
  doc.meta.createdAt = createdAt;
  doc.meta.capture.originUrl = originUrl;
  await lib.putScene(doc);
}

describe("ensureVideos on the author's library", () => {
  it("groups takes by name and start page, once, and catches up", async () => {
    const lib = createLibrary(home);
    const store = createVideoStore(home, lib);
    for (const [i, e] of names.entries())
      await put(lib, `t${i}`, e.name, e.originUrl, e.createdAt);
    await mkdir(join(home, "takes", "broken"), { recursive: true });
    await writeFile(join(home, "takes", "broken", "scene.json"), "{nope");

    const sample = names
      .map((e, i) => ({ ...e, id: `t${i}` }))
      .filter(
        (e) =>
          e.name === "Create an invoice" &&
          e.originUrl === "https://demoman.io/sample/",
      );
    // Premise the grouping assertions rest on.
    expect(sample).toHaveLength(10);

    const first = await ensureVideos(store, lib);
    expect(first.fromTakes).toBe(names.length);
    expect(first.unreadable).toBe(1);

    const memberOf = async (id: string) => (await store.videoOf(id))?.videoId;
    const sampleIds = new Set(
      await Promise.all(sample.map((e) => memberOf(e.id))),
    );
    expect(sampleIds.size).toBe(1);
    const sampleVideo = [...sampleIds][0] as string;
    expect(await store.versions(sampleVideo)).toHaveLength(10);

    const local = names.findIndex(
      (e) => e.name === "Create an invoice" && e.originUrl.includes("8766"),
    );
    const localVideo = await store.get((await memberOf(`t${local}`)) as string);
    const sampleRecord = await store.get(sampleVideo);
    // Ruling 6: the group whose earliest take is newer carries its host; the other keeps the plain name.
    const earliest = (pred: (u: string) => boolean) =>
      names
        .filter((e) => e.name === "Create an invoice" && pred(e.originUrl))
        .map((e) => e.createdAt)
        .sort()[0] as string;
    const sampleFirst = earliest((u) => u.includes("demoman.io"));
    const localFirst = earliest((u) => u.includes("8766"));
    expect(sampleFirst).not.toBe(localFirst);
    const [sampleWant, localWant] =
      sampleFirst < localFirst
        ? ["Create an invoice", "Create an invoice (localhost:8766)"]
        : ["Create an invoice (demoman.io)", "Create an invoice"];
    expect(sampleRecord?.name).toBe(sampleWant);
    expect(localVideo?.name).toBe(localWant);
    expect(localVideo?.id).not.toBe(sampleVideo);
    expect(localVideo?.repo).toEqual({ unknown: true });

    const excal = new Set(
      await Promise.all(
        names
          .map((e, i) => ({ ...e, id: `t${i}` }))
          .filter((e) => e.name.startsWith("Excalidraw"))
          .map((e) => memberOf(e.id)),
      ),
    );
    expect(excal.size).toBe(2);
    expect(await store.videoOf("broken")).toBeNull();

    const brokenRow = {
      takeId: "broken",
      reason: expect.stringContaining(join(home, "takes", "broken")),
    };
    expect(await ensureVideos(store, lib)).toEqual({
      made: 0,
      fromTakes: 0,
      unreadable: 1,
      skipped: [brokenRow],
      deferred: null,
    });

    await put(
      lib,
      "late",
      "Create an invoice",
      "https://demoman.io/sample/",
      "2026-10-22T00:00:00.000Z",
    );
    expect(await ensureVideos(store, lib)).toEqual({
      made: 0,
      fromTakes: 1,
      unreadable: 1,
      skipped: [brokenRow],
      deferred: null,
    });
    expect((await store.videoOf("late"))?.videoId).toBe(sampleVideo);
    expect((await store.videoOf("late"))?.made.door).toBe("migration");
  }, 60_000);
});

describe("ruling 7 helpers", () => {
  it("never throw over a missing or garbage URL", () => {
    expect(startPage(undefined)).toBe("");
    expect(startPage("")).toBe("");
    expect(startPage("not a url")).toBe("not a url");
    expect(hostOf("")).toBe("");
    expect(hostOf("not a url")).toBe("not a url");
    expect(startPage("https://a.test/x?q=1")).toBe("https://a.test/x");
  });
});

describe("ensureVideos skips what it cannot place", () => {
  it("counts a take whose scene vanished between list and read", async () => {
    const lib = createLibrary(home);
    const store = createVideoStore(home, lib);
    await put(
      lib,
      "gone",
      "Gone",
      "https://a.test/",
      "2026-10-01T00:00:00.000Z",
    );
    await put(
      lib,
      "kept",
      "Kept",
      "https://a.test/",
      "2026-10-02T00:00:00.000Z",
    );
    const racing = {
      ...lib,
      getScene: async (id: string) => (id === "gone" ? null : lib.getScene(id)),
    };
    const r = await ensureVideos(store, racing);
    expect(r.fromTakes).toBe(1);
    expect(r.skipped.map((s) => s.takeId)).toEqual(["gone"]);
    expect(r.unreadable).toBe(1);
    expect(await store.videoOf("gone")).toBeNull();
  });
});

describe("ensureVideos leaves a take that may still be joining", () => {
  // Ruling 12: a run writes scene.json before it joins its video, so another
  // process's migration must not take a fresh take into a video by name.
  it("migrates an unjoined take only once it is older than JOIN_GRACE_MS", async () => {
    const lib = createLibrary(home);
    const store = createVideoStore(home, lib);
    const made = Date.parse("2026-10-23T12:00:00.000Z");
    await put(
      lib,
      "fresh",
      "Fresh",
      "https://a.test/",
      new Date(made).toISOString(),
    );
    const early = await ensureVideos(store, lib, made + 60_000);
    expect(early).toMatchObject({ made: 0, fromTakes: 0, skipped: [] });
    expect(await store.videoOf("fresh")).toBeNull();
    const later = await ensureVideos(store, lib, made + 11 * 60_000);
    expect(later).toMatchObject({ made: 1, fromTakes: 1 });
    expect(await store.videoOf("fresh")).not.toBeNull();
  });
});

describe("ensureVideos re-joins, skips and keeps apart", () => {
  const OLD = "2026-10-01T00:00:00.000Z";

  it("joins again a take whose video record was deleted, keeping what it recorded", async () => {
    // Red (final review 3): skip every take with a video.json — the takes
    // of a deleted record are in no video for good.
    const lib = createLibrary(home);
    const store = createVideoStore(home, lib);
    await put(lib, "a", "Flow", "https://a.test/", OLD);
    await put(lib, "b", "Flow", "https://a.test/", OLD);
    await ensureVideos(store, lib);
    const was = await store.videoOf("a");
    if (was === null) throw new Error("setup: a did not join");
    await store.markExpired("a", OLD, 7);
    await rm(join(home, "videos", `${was.videoId}.json`));
    // Premise: the membership is there and names a record that is not.
    expect((await store.videoOf("a"))?.videoId).toBe(was.videoId);
    expect(await store.get(was.videoId)).toBeNull();

    const r = await ensureVideos(store, lib);
    expect(r).toMatchObject({ made: 1, fromTakes: 2, skipped: [] });
    const now = await store.videoOf("a");
    expect(now?.videoId).not.toBe(was.videoId);
    expect(await store.get(now?.videoId as string)).not.toBeNull();
    expect((await store.videoOf("b"))?.videoId).toBe(now?.videoId);
    expect(now?.expired).toEqual({ at: OLD, freedBytes: 7 });
  });

  it("leaves a take alone whose video record will not read", async () => {
    const lib = createLibrary(home);
    const store = createVideoStore(home, lib);
    await put(lib, "a", "Flow", "https://a.test/", OLD);
    await ensureVideos(store, lib);
    const was = (await store.videoOf("a"))?.videoId as string;
    await writeFile(join(home, "videos", `${was}.json`), "{nope");
    expect(await ensureVideos(store, lib)).toMatchObject({
      made: 0,
      fromTakes: 0,
      skipped: [],
    });
    expect((await store.videoOf("a"))?.videoId).toBe(was);
  });

  it("skips a take whose video.json will not read, saying so, and joins the rest", async () => {
    // Red (final review 4): read memberships unguarded — one bad file
    // throws the whole migration, so every run is refused.
    const lib = createLibrary(home);
    const store = createVideoStore(home, lib);
    await put(lib, "bad", "Bad", "https://a.test/", OLD);
    await writeFile(join(lib.takeDir("bad"), "video.json"), "{nope");
    await put(lib, "good", "Good", "https://a.test/", OLD);
    const r = await ensureVideos(store, lib);
    expect(r.fromTakes).toBe(1);
    expect(r.skipped).toEqual([
      {
        takeId: "bad",
        reason: expect.stringContaining(join(lib.takeDir("bad"), "video.json")),
      },
    ]);
    expect((await store.videoOf("good"))?.videoId).toBeTruthy();
  });

  it("never groups unnamed takes: each gets a video named by its page", async () => {
    // Red (final review 10): group by sameName — "" equals "", so every
    // unnamed take on a page is one video.
    const lib = createLibrary(home);
    const store = createVideoStore(home, lib);
    await put(lib, "u1", "", "https://a.test/inbox", OLD);
    await put(lib, "u2", "", "https://a.test/inbox", OLD);
    await put(lib, "u3", "The", "https://a.test/inbox", OLD);
    const r = await ensureVideos(store, lib);
    expect(r).toMatchObject({ made: 3, fromTakes: 3, skipped: [] });
    const ids = await Promise.all(
      ["u1", "u2", "u3"].map(async (t) => (await store.videoOf(t))?.videoId),
    );
    expect(new Set(ids).size).toBe(3);
    const names = await Promise.all(
      ids.map(async (id) => (await store.get(id as string))?.name),
    );
    expect(names).toEqual(["a.test/inbox", "a.test/inbox 2", "a.test/inbox 3"]);
  });

  it("defers, saying so, while another process holds the lock; takes over a stale one", async () => {
    // Red (final review 8): migrate without the lock — the take joins while
    // another process is joining it too. Red (second review 1): list the
    // waiting takes in `skipped` — the studio offers to delete healthy takes.
    const lib = createLibrary(home);
    const store = createVideoStore(home, lib);
    await put(lib, "a", "Flow", "https://a.test/", OLD);
    const lock = join(home, "videos", ".lock");
    await mkdir(lock, { recursive: true });
    const held = await ensureVideos(store, lib);
    expect(held).toMatchObject({ made: 0, fromTakes: 0, unreadable: 0 });
    expect(held.skipped).toEqual([]);
    expect(held.deferred).toContain(lock);
    expect(await store.videoOf("a")).toBeNull();
    // A lock left by a process that died: older than LOCK_STALE_MS.
    const old = new Date(Date.now() - LOCK_STALE_MS - 10_000);
    await utimes(lock, old, old);
    expect(await ensureVideos(store, lib)).toMatchObject({
      made: 1,
      fromTakes: 1,
      skipped: [],
    });
    // Released after.
    await expect(stat(lock)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("create waits for the lock rather than writing past it", async () => {
    const lib = createLibrary(home);
    const store = createVideoStore(home, lib);
    const lock = join(home, "videos", ".lock");
    await mkdir(lock, { recursive: true });
    let done = false;
    const creating = store
      .create({ name: "Flow", repo: { none: "x" }, startPage: "" })
      .then((r) => {
        done = true;
        return r;
      });
    await new Promise((r) => setTimeout(r, 300));
    expect(done).toBe(false);
    await rm(lock, { recursive: true });
    expect((await creating).ok).toBe(true);
  });

  it("a join landing after the take was deleted says so and makes no folder", async () => {
    // Red (final review 9): make the member's folder on write — the
    // deleted take's folder comes back holding only video.json.
    const lib = createLibrary(home);
    const store = createVideoStore(home, lib);
    await put(lib, "a", "Flow", "https://a.test/", OLD);
    const video = await store.create({
      name: "Flow",
      repo: { none: "x" },
      startPage: "",
    });
    if (!video.ok) throw new Error("setup: no video");
    await rm(lib.takeDir("a"), { recursive: true });
    const err = await store
      .join("a", {
        videoId: video.video.id,
        made: {
          repo: { none: "x" },
          agent: { none: "x" },
          by: "x",
          door: "mcp",
        },
        recordedRevision: null,
      })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(VideoError);
    expect(err).toMatchObject({ reason: "videoUnwritable" });
    expect((err as Error).message).toContain("video a is gone");
    await expect(stat(lib.takeDir("a"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});

describe("ensureVideos names a member its video leaves out", () => {
  const OLD = "2026-10-01T00:00:00.000Z";

  it("a corrupt status.json or a scene from a newer Demoman, beside good versions", async () => {
    // Red (second review 3): skip the leftOut check — the bad takes are in
    // no video's versions and nothing names them.
    const lib = createLibrary(home);
    const store = createVideoStore(home, lib);
    for (const id of ["good", "badStatus", "tooNew"]) {
      await put(lib, id, "Flow", "https://a.test/", OLD);
    }
    await ensureVideos(store, lib);
    const videoId = (await store.videoOf("good"))?.videoId as string;
    // Premise: all three joined one video.
    expect((await store.versions(videoId)).map((v) => v.takeId).sort()).toEqual(
      ["badStatus", "good", "tooNew"],
    );
    const status = join(lib.takeDir("badStatus"), "status.json");
    await writeFile(status, "{nope");
    const scene = join(lib.takeDir("tooNew"), "scene.json");
    await writeFile(
      scene,
      JSON.stringify({ schemaVersion: CURRENT_SCHEMA_VERSION + 1 }),
    );
    expect((await store.versions(videoId)).map((v) => v.takeId)).toEqual([
      "good",
    ]);
    const r = await ensureVideos(store, lib);
    expect(r).toMatchObject({ made: 0, fromTakes: 0, deferred: null });
    expect(r.skipped).toEqual(
      expect.arrayContaining([
        {
          takeId: "badStatus",
          reason: expect.stringContaining(status),
          videoId,
        },
        { takeId: "tooNew", reason: expect.stringContaining(scene), videoId },
      ]),
    );
    expect(r.skipped).toHaveLength(2);
    expect(r.skipped.find((s) => s.takeId === "badStatus")?.reason).toContain(
      videoId,
    );
  });
});

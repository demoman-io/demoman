import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Outcome } from "@demoman/agent-bridge";
import {
  CURRENT_SCHEMA_VERSION,
  type SceneDocument,
} from "@demoman/scene-schema";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { tagBytes } from "../src/executor/export-tag.js";
import { createLibrary } from "../src/executor/library.js";
import { createVideoStore, type VideoRepo } from "../src/executor/videos.js";
import { type VideoSummary, videosOp } from "../src/executor/videos-op.js";
import { readOnlySceneJson } from "./fixtures/scene.js";

let home: string;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "demoman-videos-op-"));
});
afterEach(() => rm(home, { recursive: true, force: true }));

const enc = new TextEncoder();
const be32 = (n: number) => Uint8Array.of(n >>> 24, n >>> 16, n >>> 8, n);
const cat = (...p: Uint8Array[]) => Uint8Array.from(p.flatMap((x) => [...x]));
const chunk = (type: string, data: Uint8Array) =>
  cat(be32(data.length), enc.encode(type), data, be32(0));
const png = cat(
  Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a),
  chunk("IHDR", new Uint8Array(13)),
  chunk("IDAT", Uint8Array.of(1, 2, 3)),
  chunk("IEND", new Uint8Array(0)),
);

const made = {
  repo: { none: "test" },
  agent: { none: "test" },
  by: { none: "test" },
  door: "mcp" as const,
};

/** One video with one complete version recorded at `at`. */
async function video(name: string, at: string, repo: VideoRepo, id = name) {
  const lib = createLibrary(home);
  const store = createVideoStore(home, lib);
  const doc = structuredClone(readOnlySceneJson()) as SceneDocument;
  doc.meta.id = `take-${id}`;
  doc.meta.createdAt = at;
  await lib.putScene(doc);
  await writeFile(
    join(lib.takeDir(doc.meta.id), "status.json"),
    JSON.stringify({ outcome: "complete" }),
  );
  await writeFile(join(lib.takeDir(doc.meta.id), "script.json"), "{}");
  const r = await store.create({ name, repo, startPage: "https://x.test/" });
  if (!r.ok) throw new Error("fixture name taken");
  await store.join(doc.meta.id, {
    videoId: r.video.id,
    made,
    recordedRevision: null,
  });
  return r.video;
}

const ask = async (args: { file?: unknown; query?: unknown } = {}) => {
  const lib = createLibrary(home);
  // `home` is no git checkout, so "this repo" is { none }.
  return videosOp(
    { store: createVideoStore(home, lib), library: lib, dir: home },
    args,
  );
};
const value = (o: Outcome) => {
  if (!o.ok) throw new Error(`refused: ${o.reason}: ${o.detail}`);
  return o.value as {
    videos: { name: string }[];
    unreadable: { id: string; unreadable: string }[];
    deferred: string | null;
  };
};

describe("videosOp", () => {
  it("lists this repo's and unknown-repo videos newest first, not another repo's", async () => {
    await video("Older", "2026-10-01T00:00:00.000Z", { none: "x" });
    await video("Newer", "2026-10-02T00:00:00.000Z", { unknown: true });
    await video("Elsewhere", "2026-10-03T00:00:00.000Z", { key: "h/o/r" });
    const got = value(await ask());
    expect(got.videos.map((v) => v.name)).toEqual(["Newer", "Older"]);
    expect(got.unreadable).toEqual([]);
  });

  it("orders a query by phrase hits and leaves out videos with none", async () => {
    // The create flow is newer, so only the hit count can put search first.
    await video("Search invoices", "2026-10-01T00:00:00.000Z", {
      unknown: true,
    });
    await video("Create invoice", "2026-10-02T00:00:00.000Z", {
      unknown: true,
    });
    const got = value(await ask({ query: "invoice search" }));
    expect(got.videos.map((v) => v.name)).toEqual([
      "Search invoices",
      "Create invoice",
    ]);
    expect(value(await ask({ query: "rocket" })).videos).toEqual([]);
  });

  it("finds exactly the video an exported file was tagged with", async () => {
    const a = await video("Alpha", "2026-10-01T00:00:00.000Z", {
      unknown: true,
    });
    await video("Beta", "2026-10-02T00:00:00.000Z", { unknown: true });
    const tagged = tagBytes("png", png, { video: a.id, take: "take-Alpha" });
    if (!tagged.ok) throw new Error(tagged.error);
    const file = join(home, "alpha.png");
    await writeFile(file, tagged.bytes);
    const got = value(await ask({ file }));
    expect(got.videos.map((v) => v.name)).toEqual(["Alpha"]);
  });

  it("answers noTag for a copy with the tag stripped", async () => {
    await video("Alpha", "2026-10-01T00:00:00.000Z", { unknown: true });
    const file = join(home, "plain.png");
    await writeFile(file, png);
    const got = await ask({ file });
    expect(got).toMatchObject({ ok: false, reason: "noTag" });
  });

  it("answers unknownVideo, naming the id, for another machine's video", async () => {
    const tagged = tagBytes("png", png, { video: "other-machine", take: "t" });
    if (!tagged.ok) throw new Error(tagged.error);
    const file = join(home, "theirs.png");
    await writeFile(file, tagged.bytes);
    const got = await ask({ file });
    expect(got).toMatchObject({ ok: false, reason: "unknownVideo" });
    expect(got.ok ? "" : got.detail).toContain("other-machine");
  });

  it("names a missing file, and refuses file with query or a relative file", async () => {
    const file = join(home, "nope.mp4");
    const missing = await ask({ file });
    expect(missing).toMatchObject({ ok: false, reason: "fileNotFound" });
    expect(missing.ok ? "" : missing.detail).toContain(file);
    expect(await ask({ file, query: "q" })).toMatchObject({
      ok: false,
      reason: "invalidArgs",
    });
    expect(await ask({ file: "a.mp4" })).toMatchObject({
      ok: false,
      reason: "invalidArgs",
    });
  });

  it("lists a corrupt record under unreadable instead of dropping it", async () => {
    await video("Alpha", "2026-10-01T00:00:00.000Z", { unknown: true });
    await mkdir(join(home, "videos"), { recursive: true });
    const bad = "0b5d2a6e-1c3f-4e8a-9b7d-2f4c6a8e0b1d";
    await writeFile(join(home, "videos", `${bad}.json`), "{nope");
    const got = value(await ask());
    expect(got.videos.map((v) => v.name)).toEqual(["Alpha"]);
    expect(got.unreadable).toEqual([
      { id: bad, unreadable: expect.stringContaining(`${bad}.json`) },
    ]);
  });

  it("lists every version's exports, each with its take", async () => {
    // Red (final review 15): list only the current version's exports — the
    // first version's file is not in the answer.
    const a = await video("Alpha", "2026-10-01T00:00:00.000Z", {
      unknown: true,
    });
    const lib = createLibrary(home);
    const store = createVideoStore(home, lib);
    const doc = structuredClone(readOnlySceneJson()) as SceneDocument;
    doc.meta.id = "take-Alpha-2";
    doc.meta.createdAt = "2026-10-02T00:00:00.000Z";
    await lib.putScene(doc);
    await writeFile(
      join(lib.takeDir(doc.meta.id), "status.json"),
      JSON.stringify({ outcome: "complete" }),
    );
    await store.join(doc.meta.id, {
      videoId: a.id,
      made,
      recordedRevision: null,
    });
    for (const [take, file] of [
      ["take-Alpha", "v1.mp4"],
      ["take-Alpha-2", "v2.gif"],
    ] as const) {
      await writeFile(join(home, file), "x");
      await writeFile(
        join(lib.takeDir(take), "outputs.json"),
        JSON.stringify([
          {
            path: join(home, file),
            fileType: file.slice(-3),
            renderedAt: "2026-10-03T00:00:00.000Z",
          },
        ]),
      );
    }
    const got = (await ask()) as {
      ok: true;
      value: { videos: VideoSummary[] };
    };
    // Premise: v2 is the current version, so v1's file is the one at stake.
    expect(got.value.videos[0]?.current?.takeId).toBe("take-Alpha-2");
    expect(got.value.videos[0]?.exports).toEqual([
      {
        takeId: "take-Alpha",
        path: join(home, "v1.mp4"),
        fileType: "mp4",
        exists: true,
      },
      {
        takeId: "take-Alpha-2",
        path: join(home, "v2.gif"),
        fileType: "gif",
        exists: true,
      },
    ]);
  });

  it("matches a query against every step, listing only the first twelve", async () => {
    // Red (final review 16): match against the listed steps only — the
    // thirteenth step's word finds nothing.
    await video("Alpha", "2026-10-01T00:00:00.000Z", { unknown: true });
    const lib = createLibrary(home);
    const doc = structuredClone(readOnlySceneJson()) as SceneDocument;
    const anchor = (id: string, name: string) =>
      ({
        id,
        fingerprint: { accessibleName: name, textContent: null },
      }) as unknown as SceneDocument["anchors"][number];
    doc.anchors = [anchor("plain", "Next"), anchor("late", "Rocket")];
    doc.actions = Array.from(
      { length: 13 },
      (_, i) =>
        ({
          id: `ac-${i}`,
          kind: "click",
          anchorId: i === 12 ? "late" : "plain",
        }) as unknown as SceneDocument["actions"][number],
    );
    const library = {
      ...lib,
      getScene: async (id: string) =>
        id === "take-Alpha" ? doc : lib.getScene(id),
    };
    const got = value(
      await videosOp(
        { store: createVideoStore(home, lib), library, dir: home },
        { query: "rocket" },
      ),
    ) as unknown as { videos: VideoSummary[] };
    expect(got.videos.map((v) => v.name)).toEqual(["Alpha"]);
    expect(got.videos[0]?.steps).toHaveLength(12);
    // Premise: the word is only past the listed steps.
    expect(got.videos[0]?.steps.join(" ")).not.toMatch(/rocket/i);
  });

  it("says which version an exported file came from", async () => {
    // Red (final review 6): drop the tag's take — the answer cannot say
    // which version the file is of.
    const a = await video("Alpha", "2026-10-01T00:00:00.000Z", {
      unknown: true,
    });
    const tagged = tagBytes("png", png, { video: a.id, take: "take-Alpha" });
    if (!tagged.ok) throw new Error(tagged.error);
    const file = join(home, "alpha.png");
    await writeFile(file, tagged.bytes);
    expect((await ask({ file })) as unknown).toMatchObject({
      ok: true,
      value: {
        file: {
          takeId: "take-Alpha",
          version: 1,
          current: true,
          expired: false,
        },
      },
    });
    const gone = tagBytes("png", png, { video: a.id, take: "take-deleted" });
    if (!gone.ok) throw new Error(gone.error);
    await writeFile(file, gone.bytes);
    expect((await ask({ file })) as unknown).toMatchObject({
      ok: true,
      value: {
        file: {
          takeId: "take-deleted",
          notInVideo: expect.stringContaining("no longer a version"),
        },
      },
    });
  });

  it("answers past a corrupt video.json, listing that take as unreadable", async () => {
    // Red (final review 4): read memberships unguarded — one bad file
    // refuses every videos call.
    await video("Alpha", "2026-10-01T00:00:00.000Z", { unknown: true });
    const lib = createLibrary(home);
    const doc = structuredClone(readOnlySceneJson()) as SceneDocument;
    doc.meta.id = "take-bad";
    doc.meta.createdAt = "2026-10-01T00:00:00.000Z";
    await lib.putScene(doc);
    const path = join(lib.takeDir("take-bad"), "video.json");
    await writeFile(path, "{nope");
    const got = value(await ask());
    expect(got.videos.map((v) => v.name)).toEqual(["Alpha"]);
    expect(got.unreadable).toEqual([
      { id: "take-bad", unreadable: expect.stringContaining(path) },
    ]);
  });

  it("answers past a version whose status.json or scene will not read, naming each", async () => {
    // Red (second review 3): read a member's files unguarded — versions()
    // throws and every videos call is refused videoUnreadable.
    const alpha = await video("Alpha", "2026-10-01T00:00:00.000Z", {
      unknown: true,
    });
    const lib = createLibrary(home);
    const store = createVideoStore(home, lib);
    for (const id of ["take-status", "take-new"]) {
      const doc = structuredClone(readOnlySceneJson()) as SceneDocument;
      doc.meta.id = id;
      doc.meta.createdAt = "2026-10-02T00:00:00.000Z";
      await lib.putScene(doc);
      await store.join(id, { videoId: alpha.id, made, recordedRevision: null });
    }
    // Premise: both are versions before their files go bad.
    expect(await store.versions(alpha.id)).toHaveLength(3);
    const status = join(lib.takeDir("take-status"), "status.json");
    await writeFile(status, "{nope");
    const scene = join(lib.takeDir("take-new"), "scene.json");
    await writeFile(
      scene,
      JSON.stringify({ schemaVersion: CURRENT_SCHEMA_VERSION + 1 }),
    );
    const got = value(await ask());
    expect(got.videos).toMatchObject([{ name: "Alpha", versions: 1 }]);
    expect(got.unreadable).toEqual(
      expect.arrayContaining([
        { id: "take-status", unreadable: expect.stringContaining(status) },
        { id: "take-new", unreadable: expect.stringContaining(scene) },
      ]),
    );
    expect(got.unreadable).toHaveLength(2);
  });

  it("says a lock another process holds as deferred, never as unreadable takes", async () => {
    // Red (second review 1): list waiting takes as unreadable — a healthy
    // take reads as broken while another process migrates.
    await video("Alpha", "2026-10-01T00:00:00.000Z", { unknown: true });
    const lib = createLibrary(home);
    const doc = structuredClone(readOnlySceneJson()) as SceneDocument;
    doc.meta.id = "take-loose";
    doc.meta.createdAt = "2026-10-01T00:00:00.000Z";
    await lib.putScene(doc);
    const lock = join(home, "videos", ".lock");
    await mkdir(lock);
    const got = value(await ask());
    expect(got.unreadable).toEqual([]);
    expect(got.deferred).toContain(lock);
    expect(got.videos.map((v) => v.name)).toEqual(["Alpha"]);
  });
});

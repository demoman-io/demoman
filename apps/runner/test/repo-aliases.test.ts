import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SceneDocument } from "@demoman/scene-schema";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLibrary, type Library } from "../src/executor/library.js";
import { execGit, type RepoRead, readRepo } from "../src/executor/repo.js";
import { followCheckouts, resolveKey } from "../src/executor/repo-aliases.js";
import {
  createVideoStore,
  VideoError,
  type VideoRecord,
  type VideoStore,
} from "../src/executor/videos.js";
import { matchesFor, videosOp } from "../src/executor/videos-op.js";
import { readOnlySceneJson } from "./fixtures/scene.js";

let home: string;
let one: string;
let two: string;
let lib: Library;
let store: VideoStore;
let said: string[];
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "demoman-aliases-"));
  one = await mkdtemp(join(tmpdir(), "demoman-clone-one-"));
  two = await mkdtemp(join(tmpdir(), "demoman-clone-two-"));
  lib = createLibrary(home);
  said = [];
  store = createVideoStore(home, lib, { log: (l) => said.push(l) });
});
afterEach(async () => {
  for (const d of [home, one, two])
    await rm(d, { recursive: true, force: true });
});

const aliasPath = () => join(home, "videos", ".aliases.json");
/** The record as it is on disk, before any alias resolves it. */
const onDisk = async (id: string): Promise<VideoRecord> =>
  JSON.parse(await readFile(join(home, "videos", `${id}.json`), "utf8"));

let takes = 0;
/** A flow named `name`, with one take recorded in `root` while it read `key`. */
async function recorded(name: string, key: string, root: string) {
  const made = await store.create({ name, repo: { key }, startPage: "/" });
  if (!made.ok) throw new Error(`could not make "${name}"`);
  await take(made.video.id, key, root);
  return made.video.id;
}
async function take(videoId: string, key: string, root: string) {
  const id = `t${++takes}`;
  const doc = structuredClone(readOnlySceneJson()) as SceneDocument;
  doc.meta.id = id;
  await lib.putScene(doc);
  await store.join(id, {
    videoId,
    made: {
      repo: { key, root, remote: null, branch: null, commit: null },
      agent: { none: "a test" },
      by: { none: "a test" },
      door: "mcp",
    },
    recordedRevision: null,
  });
}

/** git, as each checkout answers it now. */
const reads =
  (now: Record<string, string>) =>
  async (dir: string): Promise<RepoRead> => {
    const key = now[dir];
    if (key === undefined) throw new Error(`the test reads no repo at ${dir}`);
    return {
      ok: true,
      repo: { key, root: dir, remote: null, branch: null, commit: null },
    };
  };

describe("resolveKey", () => {
  it("follows a chain to its end, and leaves an unaliased key as it is", () => {
    const table = { a: "b", b: "c" };
    expect(resolveKey(table, "a")).toBe("c");
    expect(resolveKey(table, "b")).toBe("c");
    expect(resolveKey(table, "c")).toBe("c");
    expect(resolveKey(table, "x")).toBe("x");
  });

  it("a cycle ends, and every key in it resolves to the same one", () => {
    const table = { a: "b", b: "a", z: "a" };
    expect(resolveKey(table, "a")).toBe("a");
    expect(resolveKey(table, "b")).toBe("a");
    expect(resolveKey(table, "z")).toBe("a");
  });

  it("an inherited property is no alias", () => {
    expect(resolveKey({}, "constructor")).toBe("constructor");
  });
});

describe("followCheckouts", () => {
  it("an unpushed repo pushed later: local: becomes the remote's key, recorded once", async () => {
    const local = `local:${one}/.git`;
    const f = await recorded("Checkout", local, one);
    // Premise: the flow was recorded under the local key, and no table exists.
    expect((await onDisk(f)).repo).toEqual({ key: local });
    await expect(readFile(aliasPath(), "utf8")).rejects.toThrow(/ENOENT/);
    expect(await store.aliases()).toEqual({});

    const r = await followCheckouts(
      store,
      lib,
      reads({ [one]: "github.com/o/r" }),
    );
    expect(r).toEqual({ moved: 1, failed: [] });
    expect(JSON.parse(await readFile(aliasPath(), "utf8"))).toEqual({
      [local]: "github.com/o/r",
    });
    expect((await onDisk(f)).repo).toEqual({ key: "github.com/o/r" });

    // Run again: nothing more to do, and the table is unchanged.
    expect(
      await followCheckouts(store, lib, reads({ [one]: "github.com/o/r" })),
    ).toEqual({ moved: 0, failed: [] });
    expect(await store.aliases()).toEqual({ [local]: "github.com/o/r" });
  });

  it("a repo renamed on its host: the flow and its kept mark move to the new key", async () => {
    const f = await recorded("Checkout", "github.com/a/r", one);
    await store.setKept(f, {
      root: one,
      file: ".demoman/flows/checkout.json",
      key: "github.com/a/r",
    });
    // Premise: both the record and the mark carry the old key.
    expect((await onDisk(f)).repo).toEqual({ key: "github.com/a/r" });
    expect((await onDisk(f)).kept?.key).toBe("github.com/a/r");

    const r = await followCheckouts(
      store,
      lib,
      reads({ [one]: "github.com/b/r" }),
    );
    expect(r).toEqual({ moved: 1, failed: [] });
    expect(await store.aliases()).toEqual({
      "github.com/a/r": "github.com/b/r",
    });
    const rec = await onDisk(f);
    expect(rec.repo).toEqual({ key: "github.com/b/r" });
    expect(rec.kept).toEqual({
      root: one,
      file: ".demoman/flows/checkout.json",
      key: "github.com/b/r",
    });
  });

  it("a second clone's flows follow through the alias, and stay one repo for names", async () => {
    const f = await recorded("Checkout", "github.com/a/r", one);
    // The second clone still points at the old remote (the host redirects).
    const g = await recorded("Sign up", "github.com/a/r", two);
    const now = reads({ [one]: "github.com/b/r", [two]: "github.com/a/r" });
    // Premise: both flows carry the old key.
    for (const id of [f, g])
      expect((await onDisk(id)).repo).toEqual({ key: "github.com/a/r" });

    expect(await followCheckouts(store, lib, now)).toEqual({
      moved: 2,
      failed: [],
    });
    expect((await onDisk(g)).repo).toEqual({ key: "github.com/b/r" });

    // A flow recorded later in the second clone keeps the key it read...
    const h = await recorded("Invite", "github.com/a/r", two);
    expect((await onDisk(h)).repo).toEqual({ key: "github.com/a/r" });
    // ...and is listed under the repo's key through the alias.
    expect((await store.get(h))?.repo).toEqual({ key: "github.com/b/r" });
    expect(
      (await store.list()).find((v) => v.id === h && "repo" in v),
    ).toMatchObject({ repo: { key: "github.com/b/r" } });
    // The second clone's name check sees the renamed repo's flows as its own.
    const dup = await store.create({
      name: "Checkout",
      repo: { key: "github.com/a/r" },
      startPage: "/",
    });
    expect(dup).toMatchObject({ ok: false, reason: "nameTaken" });
    expect(
      (await matchesFor(store, lib, "Checkout", { key: "github.com/a/r" })).map(
        (m) => m.id,
      ),
    ).toEqual([f]);
    // And the second clone, still reading the old key, adds no alias back.
    expect(await followCheckouts(store, lib, now)).toEqual({
      moved: 1, // h, re-keyed now an alias pass ran
      failed: [],
    });
    expect(await store.aliases()).toEqual({
      "github.com/a/r": "github.com/b/r",
    });
  });

  // Red: drop videos-op.ts's `store.resolve` of `here`.
  it("the flows answer in a clone on the old remote lists the repo's flows under its new key", async () => {
    expect((await execGit(["init", "-q"], two)).code).toBe(0);
    expect(
      (
        await execGit(
          ["remote", "add", "origin", "git@github.com:a/r.git"],
          two,
        )
      ).code,
    ).toBe(0);
    const f = await recorded("Checkout", "github.com/b/r", one);
    await store.follow([{ from: "github.com/a/r", to: "github.com/b/r" }]);
    // Premise: the clone reads the old key, and the flow carries the new.
    const read = await readRepo(two);
    expect(read.ok && read.repo.key).toBe("github.com/a/r");
    expect((await onDisk(f)).repo).toEqual({ key: "github.com/b/r" });
    const r = await videosOp({ store, library: lib, dir: two }, {});
    if (!r.ok) throw new Error(JSON.stringify(r));
    const listed = (r.value as { videos: { id: string; repo: unknown }[] })
      .videos;
    expect(listed.map((v) => [v.id, v.repo])).toEqual([
      [f, { key: "github.com/b/r" }],
    ]);
  });

  it("aliases chain: a → b, then b → c, resolves a's flows to c", async () => {
    const f = await recorded("Checkout", "github.com/a/r", one);
    // Premise: recorded under a.
    expect((await onDisk(f)).repo).toEqual({ key: "github.com/a/r" });
    await followCheckouts(store, lib, reads({ [one]: "github.com/b/r" }));
    // Premise: the first move happened, so the record carries b now.
    expect((await onDisk(f)).repo).toEqual({ key: "github.com/b/r" });

    const r = await followCheckouts(
      store,
      lib,
      reads({ [one]: "github.com/c/r" }),
    );
    expect(r).toEqual({ moved: 1, failed: [] });
    const table = await store.aliases();
    expect(table).toEqual({
      "github.com/a/r": "github.com/b/r",
      "github.com/b/r": "github.com/c/r",
    });
    expect(resolveKey(table, "github.com/a/r")).toBe("github.com/c/r");
    expect((await onDisk(f)).repo).toEqual({ key: "github.com/c/r" });
    expect((await store.get(f))?.repo).toEqual({ key: "github.com/c/r" });
  });

  it("a checkout that is gone leaves its flows and says nothing", async () => {
    const f = await recorded("Checkout", "github.com/a/r", one);
    expect((await onDisk(f)).repo).toEqual({ key: "github.com/a/r" });
    await rm(one, { recursive: true });
    const read = vi.fn(reads({}));
    expect(await followCheckouts(store, lib, read)).toEqual({
      moved: 0,
      failed: [],
    });
    expect(read).not.toHaveBeenCalled();
    expect((await onDisk(f)).repo).toEqual({ key: "github.com/a/r" });
  });

  it("a checkout git cannot read leaves its flows and is named, with why", async () => {
    const f = await recorded("Checkout", "github.com/a/r", one);
    expect((await onDisk(f)).repo).toEqual({ key: "github.com/a/r" });
    const r = await followCheckouts(store, lib, async () => ({
      ok: false,
      none: "not a git checkout: fatal: bad object",
    }));
    expect(r).toEqual({
      moved: 0,
      failed: [
        {
          flow: f,
          name: "Checkout",
          root: one,
          why: "not a git checkout: fatal: bad object",
        },
      ],
    });
    expect((await onDisk(f)).repo).toEqual({ key: "github.com/a/r" });
  });

  it("a flow changed while git was read keeps the change and still moves", async () => {
    const f = await recorded("Checkout", "github.com/a/r", one);
    expect((await onDisk(f)).repo).toEqual({ key: "github.com/a/r" });
    const r = await followCheckouts(store, lib, async (dir) => {
      expect((await store.rename(f, "Pay")).ok).toBe(true);
      return reads({ [one]: "github.com/b/r" })(dir);
    });
    expect(r).toEqual({ moved: 1, failed: [] });
    expect(await onDisk(f)).toMatchObject({
      name: "Pay",
      repo: { key: "github.com/b/r" },
    });
  });

  it("a table that will not read is refused by name, and the listing says so and still lists", async () => {
    const f = await recorded("Checkout", "github.com/a/r", one);
    await writeFile(aliasPath(), "{nope");
    await expect(
      followCheckouts(store, lib, reads({ [one]: "github.com/b/r" })),
    ).rejects.toThrow(VideoError);
    await expect(
      followCheckouts(store, lib, reads({ [one]: "github.com/b/r" })),
    ).rejects.toThrow(aliasPath());
    // Nothing moved on the way.
    expect((await onDisk(f)).repo).toEqual({ key: "github.com/a/r" });
    said.length = 0;
    expect((await store.get(f))?.repo).toEqual({ key: "github.com/a/r" });
    expect(said.join("\n")).toContain(aliasPath());
  });

  it("a table that is JSON but not a table of keys is refused too", async () => {
    await recorded("Checkout", "github.com/a/r", one);
    await writeFile(aliasPath(), JSON.stringify({ "github.com/a/r": 3 }));
    await expect(store.aliases()).rejects.toThrow(/not a table/);
  });
});

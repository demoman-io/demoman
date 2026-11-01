import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { keyKeptMarks } from "../src/executor/kept-keys.js";
import { createLibrary } from "../src/executor/library.js";
import type { RepoRead } from "../src/executor/repo.js";
import { createVideoStore, type VideoStore } from "../src/executor/videos.js";

const ID = "11111111-1111-4111-8111-111111111111";
let home: string;
let root: string;
let store: VideoStore;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "demoman-kept-keys-"));
  root = await mkdtemp(join(tmpdir(), "demoman-kept-root-"));
  store = createVideoStore(home, createLibrary(home));
  await store.adopt({
    id: ID,
    name: "Flow",
    repo: { unknown: true },
    startPage: "/",
    kept: { root, file: "a.demoman.json" },
  });
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
  await rm(root, { recursive: true, force: true });
});

const found = (key: string): RepoRead => ({
  ok: true,
  repo: { key, root, remote: null, branch: null, commit: null },
});

describe("keyKeptMarks", () => {
  it("keys a mark that has none, from its root", async () => {
    // Premise: the mark has no key.
    expect((await store.get(ID))?.kept?.key).toBeUndefined();
    const read = vi.fn(async () => found("github.com/a/b"));
    const r = await keyKeptMarks(store, read);
    expect(r).toEqual({ keyed: 1, failed: [] });
    expect(read).toHaveBeenCalledWith(root);
    expect((await store.get(ID))?.kept).toEqual({
      root,
      file: "a.demoman.json",
      key: "github.com/a/b",
    });
  });

  it("leaves a keyed mark alone and calls no git", async () => {
    await store.setKept(ID, { root, file: "a.demoman.json", key: "k" });
    const read = vi.fn(async () => found("other"));
    expect(await keyKeptMarks(store, read)).toEqual({ keyed: 0, failed: [] });
    expect(read).not.toHaveBeenCalled();
    expect((await store.get(ID))?.kept?.key).toBe("k");
  });

  it("a root that will not read is named in failed, and the mark keeps no key", async () => {
    const r = await keyKeptMarks(store, async () => ({
      ok: false,
      none: "not a git checkout",
    }));
    expect(r.keyed).toBe(0);
    expect(r.failed).toHaveLength(1);
    expect(r.failed[0]).toMatchObject({ flow: ID, root });
    expect(r.failed[0]?.why).toContain("not a git checkout");
    expect((await store.get(ID))?.kept?.key).toBeUndefined();
  });

  it("a root that is gone is skipped, not failed", async () => {
    await rm(root, { recursive: true });
    const read = vi.fn(async () => found("x"));
    expect(await keyKeptMarks(store, read)).toEqual({ keyed: 0, failed: [] });
    expect(read).not.toHaveBeenCalled();
  });

  it("a mark moved since it was read is not overwritten", async () => {
    const moved = { root, file: "b.demoman.json" };
    const r = await keyKeptMarks(store, async () => {
      await store.setKept(ID, moved);
      return found("github.com/a/b");
    });
    expect(r.keyed).toBe(0);
    expect(r.failed).toHaveLength(1);
    expect(r.failed[0]?.flow).toBe(ID);
    expect(r.failed[0]?.why).toContain("markMoved");
    expect((await store.get(ID))?.kept).toEqual(moved);
  });
});

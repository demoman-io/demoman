import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SceneDocument } from "@demoman/scene-schema";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLocalExecutor } from "../src/executor/executor.js";
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
import { WALLPAPERS_DIR } from "./fixture.js";
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
async function take(
  videoId: string,
  key: string,
  root: string,
  commit: string | null = COMMIT,
) {
  const id = `t${++takes}`;
  const doc = structuredClone(readOnlySceneJson()) as SceneDocument;
  doc.meta.id = id;
  await lib.putScene(doc);
  await store.join(id, {
    videoId,
    made: {
      repo: { key, root, remote: null, branch: null, commit },
      agent: { none: "a test" },
      by: { none: "a test" },
      door: "mcp",
    },
    recordedRevision: null,
  });
}

/** The commit every take records unless told otherwise. */
const COMMIT = "c0ffee0000000000000000000000000000000000";
/** git's answer to "is this commit in that checkout": only COMMIT is. */
const proves = async (_dir: string, sha: string) => sha === COMMIT;
const follow = (
  read: (dir: string) => Promise<RepoRead>,
  has: (dir: string, sha: string) => Promise<boolean> = proves,
) => followCheckouts(store, lib, read, has);

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

    const r = await follow(reads({ [one]: "github.com/o/r" }));
    expect(r).toEqual({ moved: 1, failed: [], collisions: [] });
    expect(JSON.parse(await readFile(aliasPath(), "utf8"))).toEqual({
      [local]: "github.com/o/r",
    });
    expect((await onDisk(f)).repo).toEqual({ key: "github.com/o/r" });

    // Run again: nothing more to do, and the table is unchanged.
    expect(await follow(reads({ [one]: "github.com/o/r" }))).toEqual({
      moved: 0,
      failed: [],
      collisions: [],
    });
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

    const r = await follow(reads({ [one]: "github.com/b/r" }));
    expect(r).toEqual({ moved: 1, failed: [], collisions: [] });
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

    expect(await follow(now)).toEqual({
      moved: 2,
      failed: [],
      collisions: [],
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
      (
        await matchesFor(store, lib, "Checkout", { key: "github.com/a/r" }, "/")
      ).map((m) => m.id),
    ).toEqual([f]);
    // And the second clone, still reading the old key, adds no alias back.
    expect(await follow(now)).toEqual({
      moved: 1, // h, re-keyed now an alias pass ran
      failed: [],
      collisions: [],
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
    await follow(reads({ [one]: "github.com/b/r" }));
    // Premise: the first move happened, so the record carries b now.
    expect((await onDisk(f)).repo).toEqual({ key: "github.com/b/r" });

    const r = await follow(reads({ [one]: "github.com/c/r" }));
    expect(r).toEqual({ moved: 1, failed: [], collisions: [] });
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
    expect(await follow(read)).toEqual({
      moved: 0,
      failed: [],
      collisions: [],
    });
    expect(read).not.toHaveBeenCalled();
    expect((await onDisk(f)).repo).toEqual({ key: "github.com/a/r" });
  });

  it("a checkout git cannot read leaves its flows and is named, with why", async () => {
    const f = await recorded("Checkout", "github.com/a/r", one);
    expect((await onDisk(f)).repo).toEqual({ key: "github.com/a/r" });
    const r = await follow(async () => ({
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
      collisions: [],
    });
    expect((await onDisk(f)).repo).toEqual({ key: "github.com/a/r" });
  });

  it("a flow changed while git was read keeps the change and still moves", async () => {
    const f = await recorded("Checkout", "github.com/a/r", one);
    expect((await onDisk(f)).repo).toEqual({ key: "github.com/a/r" });
    const r = await follow(async (dir) => {
      expect((await store.rename(f, "Pay")).ok).toBe(true);
      return reads({ [one]: "github.com/b/r" })(dir);
    });
    expect(r).toEqual({ moved: 1, failed: [], collisions: [] });
    expect(await onDisk(f)).toMatchObject({
      name: "Pay",
      repo: { key: "github.com/b/r" },
    });
  });

  // Red: drop the commit check in followCheckouts — the other repo's key
  // is aliased onto this one.
  it("another repo cloned where a checkout was: no recorded commit is in it, so no alias, and it says why", async () => {
    const f = await recorded("Checkout", "github.com/a/r", one);
    // Premise: the take recorded a commit, which the new clone lacks.
    expect((await store.videoOf(`t${takes}`))?.made.repo).toMatchObject({
      commit: COMMIT,
    });
    const r = await follow(
      reads({ [one]: "github.com/x/other" }),
      async () => false,
    );
    expect(r.moved).toBe(0);
    expect(r.failed).toHaveLength(1);
    expect(r.failed[0]).toMatchObject({ flow: f, name: "Checkout", root: one });
    expect(r.failed[0]?.why).toContain("github.com/x/other");
    expect(r.failed[0]?.why).toContain("c0ffee0");
    expect(r.failed[0]?.why).toContain("may be another repo");
    expect(await store.aliases()).toEqual({});
    expect((await onDisk(f)).repo).toEqual({ key: "github.com/a/r" });
  });

  it("a checkout whose takes recorded no commit is not aliased, and says no commit proves it", async () => {
    const made = await store.create({
      name: "Checkout",
      repo: { key: "github.com/a/r" },
      startPage: "/",
    });
    if (!made.ok) throw new Error("no flow");
    await take(made.video.id, "github.com/a/r", one, null);
    // Premise: nothing recorded a commit.
    expect((await store.videoOf(`t${takes}`))?.made.repo).toMatchObject({
      commit: null,
    });
    const has = vi.fn(proves);
    const r = await follow(reads({ [one]: "github.com/b/r" }), has);
    expect(has).not.toHaveBeenCalled();
    expect(r.failed[0]?.why).toContain(
      "no recorded commit proves it is the same repo",
    );
    expect(await store.aliases()).toEqual({});
  });

  it("a kept mark's root is proved by the commits its flow's takes recorded elsewhere", async () => {
    const f = await recorded("Checkout", "github.com/a/r", two);
    await store.setKept(f, {
      root: one,
      file: "k.json",
      key: "github.com/a/r",
    });
    // Premise: no take was recorded in the mark's root.
    expect((await store.videoOf(`t${takes}`))?.made.repo).toMatchObject({
      root: two,
    });
    const seen: string[] = [];
    const r = await follow(
      reads({ [one]: "github.com/b/r", [two]: "github.com/a/r" }),
      async (dir, sha) => {
        seen.push(dir);
        return proves(dir, sha);
      },
    );
    expect(seen).toEqual([one]);
    expect(r).toEqual({ moved: 1, failed: [], collisions: [] });
    expect(await store.aliases()).toEqual({
      "github.com/a/r": "github.com/b/r",
    });
  });

  // Red: drop the isLocalKey check — the hosted key is aliased to local:.
  it("a checkout that lost its remote has not moved: no alias, its flows stay, nothing said", async () => {
    const f = await recorded("Checkout", "github.com/a/r", one);
    expect((await onDisk(f)).repo).toEqual({ key: "github.com/a/r" });
    const r = await follow(reads({ [one]: `local:${one}/.git` }));
    expect(r).toEqual({ moved: 0, failed: [], collisions: [] });
    expect(await store.aliases()).toEqual({});
    expect((await onDisk(f)).repo).toEqual({ key: "github.com/a/r" });
  });

  // Red: drop the collisions from follow's answer.
  it("two same-named flows brought into one repo are answered as a collision", async () => {
    const f = await recorded("Checkout", "github.com/a/r", one);
    const g = await recorded("Checkout", "github.com/b/r", two);
    // Premise: one name, two repos, so the name check let both be.
    expect((await onDisk(f)).name).toBe((await onDisk(g)).name);
    const r = await follow(
      reads({ [one]: "github.com/b/r", [two]: "github.com/b/r" }),
    );
    expect(r.moved).toBe(1);
    expect(r.collisions).toEqual([{ name: "Checkout", ids: [f, g].sort() }]);
  });

  it("a table that will not read is refused by name, and the listing says so and still lists", async () => {
    const f = await recorded("Checkout", "github.com/a/r", one);
    await writeFile(aliasPath(), "{nope");
    await expect(follow(reads({ [one]: "github.com/b/r" }))).rejects.toThrow(
      VideoError,
    );
    await expect(follow(reads({ [one]: "github.com/b/r" }))).rejects.toThrow(
      aliasPath(),
    );
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

// Ruling R14: an agent in a checkout whose key moved before the Studio
// opened still finds its old flows, since the query and the run follow the
// checkout they are in first, by the same proof as the Studio's pass.
describe("the checkout an agent is in follows first", () => {
  const git = async (dir: string, ...args: string[]) => {
    const r = await execGit(args, dir);
    if (r.code !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
    return r.stdout.trim();
  };
  /** `one` as a checkout of a/r with a commit; a flow "Checkout" recorded
   *  there at it, and another recorded in `two` (no checkout) under x/y. */
  async function movedCheckout() {
    await git(one, "init", "-q");
    await git(one, "remote", "add", "origin", "git@github.com:a/r.git");
    await git(
      one,
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@t",
      "commit",
      "-q",
      "--allow-empty",
      "-m",
      "x",
    );
    const head = await git(one, "rev-parse", "HEAD");
    const read = await readRepo(one);
    if (!read.ok) throw new Error(read.none);
    const { root } = read.repo;
    const made = await store.create({
      name: "Checkout",
      repo: { key: "github.com/a/r" },
      startPage: "/",
    });
    if (!made.ok) throw new Error("could not make the flow");
    await take(made.video.id, "github.com/a/r", root, head);
    const elsewhere = await recorded("Elsewhere", "github.com/x/y", two);
    await git(one, "remote", "set-url", "origin", "git@github.com:b/r.git");
    // Premise: recorded under a/r; the checkout reads b/r now.
    expect((await onDisk(made.video.id)).repo).toEqual({
      key: "github.com/a/r",
    });
    const now = await readRepo(one);
    expect(now.ok && now.repo.key).toBe("github.com/b/r");
    return { flow: made.video.id, elsewhere, root };
  }

  // Red: drop videos-op.ts's followHere — the query lists nothing; or
  // drop followCheckouts' `only` — `two`'s flow is read as this checkout,
  // and its commit not being there is said.
  it("flows({ query }) in the moved checkout finds the old flow, and follows no other", async () => {
    const { flow, elsewhere } = await movedCheckout();
    const r = await videosOp(
      { store, library: lib, dir: one },
      { query: "checkout" },
    );
    if (!r.ok) throw new Error(JSON.stringify(r));
    const v = r.value as {
      videos: { id: string; repo: unknown }[];
      unreadable: unknown[];
    };
    expect(
      v.videos.map((x) => [x.id, x.repo]),
      JSON.stringify(v),
    ).toEqual([[flow, { key: "github.com/b/r" }]]);
    expect(v.unreadable).toEqual([]);
    expect((await onDisk(elsewhere)).repo).toEqual({ key: "github.com/x/y" });
  });

  // Red: drop followHere's `failed` from the answer — the query lists
  // nothing, and nothing says why.
  it("a moved checkout whose commit does not prove it is said in the answer", async () => {
    await git(one, "init", "-q");
    await git(one, "remote", "add", "origin", "git@github.com:b/r.git");
    const read = await readRepo(one);
    if (!read.ok) throw new Error(read.none);
    // Recorded there under a/r at COMMIT, which this checkout lacks.
    const f = await recorded("Checkout", "github.com/a/r", read.repo.root);
    const r = await videosOp(
      { store, library: lib, dir: one },
      { query: "checkout" },
    );
    if (!r.ok) throw new Error(JSON.stringify(r));
    const v = r.value as {
      videos: unknown[];
      unreadable: { id: string; unreadable: string }[];
    };
    expect(v.videos).toEqual([]);
    expect(v.unreadable.map((u) => u.id)).toEqual([f]);
    expect(v.unreadable[0]?.unreadable).toContain("may be another repo");
  });

  // Red: drop executor.ts's followHere — the old flow stays under a/r and
  // { new: "Checkout" } is refused as nothing, or starts a second flow.
  it("a run into { new } with the old flow's name is refused as taken", async () => {
    const { flow } = await movedCheckout();
    const lines: string[] = [];
    const executor = createLocalExecutor({
      wallpapersDir: WALLPAPERS_DIR,
      home,
      headless: true,
      log: (l) => void lines.push(l),
    });
    try {
      const out = await executor.request("run", {
        project: one,
        script: {
          scriptVersion: 1,
          name: "Checkout",
          target: "http://127.0.0.1:1/",
          viewport: { width: 1280, height: 800 },
          steps: [{ do: "waitForLoad" }],
        },
        video: { new: "Checkout" },
      });
      if (!out.ok) throw new Error(JSON.stringify(out));
      expect(out.value, JSON.stringify(out.value)).toMatchObject({
        outcome: "refusedBeforeRun",
        reason: "nameTaken",
        holder: { id: flow },
      });
      expect((await store.list()).length).toBe(2);
    } finally {
      await executor.close();
    }
  });
});

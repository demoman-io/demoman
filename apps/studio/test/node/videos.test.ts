import { execFileSync } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FLOWS_DIR,
  LEGACY_FLOWS_DIR as KEPT_DIR,
  type KeptVideo,
  keptFileName,
  RECEIPT_DIR,
  serializeKept,
  serializeReceipt,
} from "@demoman/run-core";
import {
  createLibrary,
  createVideoStore,
  readRepo,
} from "@demoman/runner/studio";
import { CURRENT_SCHEMA_VERSION } from "@demoman/scene-schema";
import { pathFor, type TakesAnswer } from "@demoman/studio-protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TAKE_BUSY } from "../../src/routes.js";
import { type Harness, startStudio } from "./harness.js";
import { seedOutput, seedTake } from "./seed.js";

// The library's videos (local video library spec §6): the takes listing
// answers the videos and which take is which version, joins loose takes and
// expires old recordings on the way, and a video renames and deletes whole.

const exists = (path: string) =>
  stat(path).then(
    () => true,
    () => false,
  );

const MADE = {
  repo: { none: "a test" },
  agent: { none: "a test" },
  by: { none: "a test" },
  door: "mcp",
} as const;

let home: string;
let h: Harness;

/** A video of `takes`, each a take joined as made, with its own day and
 *  outcome. A version with `script` has a script.json, so expiry may take
 *  its frames when it is old and not kept. */
async function seedVideo(
  name: string,
  takes: {
    id: string;
    createdAt: string;
    complete: boolean;
    script?: boolean;
  }[],
): Promise<string> {
  const library = createLibrary(home);
  const store = createVideoStore(home, library);
  const made = await store.create({
    name,
    repo: { key: "github.com/acme/app" },
    startPage: "https://app.example.com/orders",
  });
  if (!made.ok) throw new Error(`could not make the video "${name}"`);
  for (const t of takes) {
    const { scene } = await seedTake(home, {
      id: t.id,
      status: { outcome: t.complete ? "complete" : "failed" },
    });
    await library.putScene({
      ...scene,
      meta: { ...scene.meta, name, createdAt: t.createdAt },
    });
    if (t.script === true) await library.putJson(t.id, "script.json", {});
    const read = await library.getSceneRead(t.id);
    await store.join(t.id, {
      videoId: made.video.id,
      made: MADE,
      // Recorded as it is: not edited, so expiry does not keep it for that.
      recordedRevision: read?.revision ?? null,
    });
  }
  return made.video.id;
}

const daysAgo = (n: number) =>
  new Date(Date.now() - n * 86_400_000).toISOString();

async function listing(): Promise<TakesAnswer> {
  const r = await h.call(pathFor("takes"));
  expect(r.status, r.text).toBe(200);
  return r.json() as TakesAnswer;
}

let invoice: string;
let signup: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "studio-videos-"));
  invoice = await seedVideo("Create an invoice", [
    { id: "inv-1", createdAt: daysAgo(40), complete: true },
    { id: "inv-2", createdAt: daysAgo(20), complete: true },
    // The newest failed: the current version is the newest complete one.
    { id: "inv-3", createdAt: daysAgo(1), complete: false },
  ]);
  signup = await seedVideo("Sign up", [
    { id: "sign-1", createdAt: daysAgo(2), complete: true },
  ]);
  h = await startStudio(home);
});
afterEach(async () => {
  await h.close();
  await rm(home, { recursive: true, force: true });
});

describe("the takes listing's videos", () => {
  it("answers each video and which take is which version", async () => {
    // Red: drop `videoListing` from the takes answer — videos is undefined.
    const body = await listing();
    const byName = Object.fromEntries(body.videos.map((v) => [v.name, v]));
    expect(Object.keys(byName).sort()).toEqual([
      "Create an invoice",
      "Sign up",
    ]);
    expect(byName["Create an invoice"]?.versions).toBe(3);
    expect(byName["Sign up"]?.versions).toBe(1);
    // The newest complete, not the newest (inv-3 failed).
    expect(byName["Create an invoice"]?.current?.takeId).toBe("inv-2");
    const none = { exports: [], filmedCode: null };
    expect(body.videoOf).toEqual({
      "inv-1": { videoId: invoice, version: 1, expired: false, ...none },
      "inv-2": { videoId: invoice, version: 2, expired: false, ...none },
      "inv-3": { videoId: invoice, version: 3, expired: false, ...none },
      "sign-1": { videoId: signup, version: 1, expired: false, ...none },
    });
    expect(body.scenes.map((s) => s.meta.id).sort()).toEqual(
      ["inv-1", "inv-2", "inv-3", "sign-1"].sort(),
    );
    expect(body.unreadable).toEqual([]);
  });

  it("videoOf carries the report's filmed commit", async () => {
    const code = { commit: "abc1234", tree: "def5678", dirty: false };
    const library = createLibrary(home);
    await library.putJson("inv-1", "report.json", { filmedCode: code });
    await library.putJson("inv-2", "report.json", {
      filmedCode: { none: "no git" },
    });
    await writeFile(
      join(library.takeDir("sign-1"), "report.json"),
      "{not json",
    );
    const body = await listing();
    expect(body.videoOf["inv-1"]?.filmedCode).toEqual(code);
    expect(body.videoOf["inv-2"]?.filmedCode).toEqual({ none: "no git" });
    // Missing report: null, quietly. Unreadable: null, and the log says why.
    expect(body.videoOf["inv-3"]?.filmedCode).toBeNull();
    expect(body.videoOf["sign-1"]?.filmedCode).toBeNull();
    expect(h.logs.join("\n")).toMatch(/sign-1.*report\.json/);
    expect(h.logs.join("\n")).not.toMatch(/inv-3/);
  });

  it("a report without filmedCode is quiet; a malformed one is said", async () => {
    const library = createLibrary(home);
    await library.putJson("inv-1", "report.json", { outcome: "complete" });
    await library.putJson("inv-2", "report.json", { filmedCode: { x: 1 } });
    await library.putJson("inv-3", "report.json", []);
    await library.putJson("sign-1", "report.json", { filmedCode: null });
    const body = await listing();
    expect(body.videoOf["inv-1"]?.filmedCode).toBeNull();
    expect(body.videoOf["inv-2"]?.filmedCode).toBeNull();
    const said = h.logs.join("\n");
    expect(said).not.toMatch(/inv-1/);
    for (const id of ["inv-2", "inv-3", "sign-1"])
      expect(said, id).toMatch(new RegExp(`${id}.*no usable filmedCode`));
  });

  it("joins a loose take to a video of its own as it lists", async () => {
    // Red: drop ensureVideos from the listing's upkeep — the take has no
    // videoOf entry and no video.
    await seedTake(home, { id: "loose" });
    // Premise: the take is loose, and old enough to be joined.
    expect(
      await createVideoStore(home, createLibrary(home)).videoOf("loose"),
    ).toBeNull();
    const body = await listing();
    const joined = body.videoOf.loose;
    expect(joined?.version).toBe(1);
    expect(body.videos.find((v) => v.id === joined?.videoId)?.name).toBe(
      "Orders walkthrough (read-only)",
    );
  });

  it("expires an old version's recording as it lists, and says it expired", async () => {
    // Red: drop expireOld from the listing's upkeep — inv-1 keeps its
    // frames and lists expired: false.
    await createLibrary(home).putJson("inv-1", "script.json", {});
    const frames = join(home, "takes", "inv-1", "frames");
    // Premise: there are frames to remove.
    expect(await exists(frames)).toBe(true);
    const body = await listing();
    expect(body.videoOf["inv-1"]?.expired).toBe(true);
    expect(await exists(frames)).toBe(false);
    // The current version (inv-2) is kept, whatever its age.
    expect(body.videoOf["inv-2"]?.expired).toBe(false);
  });

  it.skipIf(process.getuid?.() === 0)(
    "a migration that fails still answers the listing, with a row saying why",
    async () => {
      // Red: let ensureVideos' throw out of the upkeep — the listing is a
      // 500 and no take is listed.
      await seedTake(home, { id: "loose" });
      const dir = join(home, "videos");
      await chmod(dir, 0o500);
      try {
        const body = await listing();
        expect(body.scenes.map((s) => s.meta.id)).toContain("loose");
        const rows = body.unreadable.filter((u) => u.kind === "upkeep");
        const said = JSON.stringify(body.unreadable);
        // Both the join and the expiry failed (neither can write videos/),
        // each its own row under its own name: no Delete, no shared key.
        expect(rows.map((r) => r.folder).sort(), said).toEqual([
          "expiring old videos",
          "joining videos to flows",
        ]);
        expect(
          rows.find((r) => r.folder === "joining videos to flows")?.reason,
          said,
        ).toMatch(/could not be grouped into flows/);
        expect(h.logs.join("\n")).toContain("could not be grouped into flows");
      } finally {
        await chmod(dir, 0o755);
      }
    },
  );

  it("an upkeep that cannot key a mark says which", async () => {
    // Red: drop the keyKeptMarks pass (or its row) from the upkeep — no row
    // names the flow and its root; or name the flow by its id alone.
    const root = await mkdtemp(join(tmpdir(), "studio-unkeyed-root-"));
    try {
      const store = createVideoStore(home, createLibrary(home));
      await store.setKept(invoice, { root, file: "a.demoman.json" });
      // Premise: the mark has no key, and its root is a folder that is no
      // git checkout.
      expect((await store.get(invoice))?.kept?.key).toBeUndefined();
      const body = await listing();
      const said = JSON.stringify(body.unreadable);
      const row = body.unreadable.find(
        (u) => u.folder === "telling kept flows' projects",
      );
      expect(row?.kind, said).toBe("upkeep");
      expect(row?.reason, said).toContain(
        `flow "Create an invoice" (${invoice}) at ${root}`,
      );
      expect(row?.reason, said).toContain("not a git checkout");
      expect((await store.get(invoice))?.kept?.key).toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  describe("a project follows its checkout", () => {
    const git = (cwd: string, ...args: string[]) =>
      execFileSync("git", args, { cwd, stdio: "pipe" }).toString().trim();
    /** A checkout with one commit and `origin` at `remote`; its HEAD. */
    const checkout = async (prefix: string, remote: string) => {
      const root = await mkdtemp(join(tmpdir(), prefix));
      git(root, "init", "-q");
      git(root, "remote", "add", "origin", remote);
      git(
        root,
        "-c",
        "user.name=t",
        "-c",
        "user.email=t@t",
        "commit",
        "-q",
        "--allow-empty",
        "-m",
        // Its own message: two empty commits made in one second by one
        // author are otherwise one commit.
        `commit in ${root}`,
      );
      return { root, head: git(root, "rev-parse", "HEAD") };
    };
    let takeNo = 0;
    /** A flow recorded in `root` at `commit` while its repo read `key`,
     *  with its kept mark carrying the same key. */
    async function recordedIn(
      root: string,
      key: string,
      commit: string | null,
      name = "Pay a bill",
    ): Promise<string> {
      const library = createLibrary(home);
      const store = createVideoStore(home, library);
      const made = await store.create({
        name,
        repo: { key },
        startPage: "https://app.example.com/bills",
      });
      if (!made.ok) throw new Error("could not make the flow");
      const takeId = `pay-${++takeNo}`;
      await seedTake(home, { id: takeId, status: { outcome: "complete" } });
      await store.join(takeId, {
        videoId: made.video.id,
        made: {
          ...MADE,
          repo: { key, root, remote: null, branch: null, commit },
        },
        recordedRevision: null,
      });
      await store.setKept(made.video.id, {
        root,
        file: ".demoman/flows/pay-a-bill.json",
        key,
      });
      return made.video.id;
    }
    const onDisk = async (id: string) =>
      JSON.parse(await readFile(join(home, "videos", `${id}.json`), "utf8"));

    // Red: drop the followCheckouts pass from the upkeep — the listing
    // still says github.com/a/r, and no alias is written.
    it("after `git remote set-url`, the listing serves the flow and its mark under the new key", async () => {
      const { root, head } = await checkout(
        "studio-set-url-",
        "git@github.com:a/r.git",
      );
      try {
        const id = await recordedIn(root, "github.com/a/r", head);
        git(root, "remote", "set-url", "origin", "git@github.com:b/r.git");
        // Premise: recorded under the old key; the checkout reads the new.
        expect((await onDisk(id)).repo).toEqual({ key: "github.com/a/r" });
        expect((await onDisk(id)).kept.key).toBe("github.com/a/r");
        const read = await readRepo(root);
        expect(read.ok && read.repo.key).toBe("github.com/b/r");

        const body = await listing();
        const said = JSON.stringify(body.unreadable);
        const v = body.videos.find((x) => x.id === id);
        expect(v?.repo, said).toEqual({ key: "github.com/b/r" });
        expect(v?.addedTo, said).toBe("github.com/b/r");
        expect(
          body.unreadable.filter((u) => u.folder.includes("checkouts")),
        ).toEqual([]);
        expect(
          JSON.parse(
            await readFile(join(home, "videos", ".aliases.json"), "utf8"),
          ),
        ).toEqual({ "github.com/a/r": "github.com/b/r" });
        expect((await onDisk(id)).repo).toEqual({ key: "github.com/b/r" });
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });

    it("a checkout git cannot read is a row naming the flow, and the flow stays", async () => {
      const root = await mkdtemp(join(tmpdir(), "studio-not-git-"));
      try {
        const id = await recordedIn(root, "github.com/a/r", null);
        // Premise: the folder exists and is no git checkout.
        expect((await readRepo(root)).ok).toBe(false);
        const body = await listing();
        const said = JSON.stringify(body.unreadable);
        const row = body.unreadable.find(
          (u) => u.folder === "following projects' checkouts",
        );
        expect(row?.kind, said).toBe("upkeep");
        expect(row?.reason, said).toContain(
          `flow "Pay a bill" (${id}) at ${root}`,
        );
        expect(row?.reason, said).toContain("not a git checkout");
        expect(body.videos.find((x) => x.id === id)?.repo).toEqual({
          key: "github.com/a/r",
        });
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });

    // Red: drop the commit check — github.com/x/other's flows would take
    // in a/r's, an alias of two different repos.
    it("another repo cloned at a checkout's path is not aliased, and the row says why", async () => {
      const other = await checkout(
        "studio-reclone-",
        "git@github.com:x/other.git",
      );
      const gone = await checkout("studio-gone-", "git@github.com:a/r.git");
      try {
        // Recorded in a/r at a commit the new clone at that path lacks.
        const id = await recordedIn(other.root, "github.com/a/r", gone.head);
        // Premise: the commits differ and the new clone reads another key.
        expect(other.head).not.toBe(gone.head);
        const read = await readRepo(other.root);
        expect(read.ok && read.repo.key).toBe("github.com/x/other");
        const body = await listing();
        const said = JSON.stringify(body.unreadable);
        const row = body.unreadable.find(
          (u) => u.folder === "following projects' checkouts",
        );
        expect(row?.reason, said).toContain(
          `flow "Pay a bill" (${id}) at ${other.root}`,
        );
        expect(row?.reason, said).toContain("may be another repo");
        expect(body.videos.find((v) => v.id === id)?.repo).toEqual({
          key: "github.com/a/r",
        });
        await expect(
          readFile(join(home, "videos", ".aliases.json"), "utf8"),
        ).rejects.toThrow(/ENOENT/);
      } finally {
        await rm(other.root, { recursive: true, force: true });
        await rm(gone.root, { recursive: true, force: true });
      }
    });

    // Red: drop the isLocalKey check — a/r's flows move to local:<root>.
    it("after `git remote remove origin`, no alias and the flow stays, with no row", async () => {
      const { root, head } = await checkout(
        "studio-no-remote-",
        "git@github.com:a/r.git",
      );
      try {
        const id = await recordedIn(root, "github.com/a/r", head);
        git(root, "remote", "remove", "origin");
        // Premise: the checkout reads a local key now.
        const read = await readRepo(root);
        expect(read.ok && read.repo.key.startsWith("local:")).toBe(true);
        const body = await listing();
        const said = JSON.stringify(body.unreadable);
        expect(body.videos.find((v) => v.id === id)?.repo, said).toEqual({
          key: "github.com/a/r",
        });
        expect(
          body.unreadable.filter((u) => u.folder.includes("checkouts")),
        ).toEqual([]);
        await expect(
          readFile(join(home, "videos", ".aliases.json"), "utf8"),
        ).rejects.toThrow(/ENOENT/);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });

    // Red: drop the collisions from the upkeep's row.
    it("two flows of one name brought into one project are named in the row", async () => {
      const old = await checkout("studio-old-clone-", "git@github.com:a/r.git");
      const fresh = await checkout(
        "studio-new-clone-",
        "git@github.com:b/r.git",
      );
      try {
        const first = await recordedIn(old.root, "github.com/a/r", old.head);
        const second = await recordedIn(
          fresh.root,
          "github.com/b/r",
          fresh.head,
        );
        git(old.root, "remote", "set-url", "origin", "git@github.com:b/r.git");
        // Premise: one name in two repos, until the old clone moves.
        expect((await onDisk(first)).name).toBe((await onDisk(second)).name);
        expect((await onDisk(first)).repo).not.toEqual(
          (await onDisk(second)).repo,
        );
        const body = await listing();
        const said = JSON.stringify(body.unreadable);
        const row = body.unreadable.find(
          (u) => u.folder === "following projects' checkouts",
        );
        const [a, b] = [first, second].sort();
        expect(row?.reason, said).toContain(
          `flows "Pay a bill" (${a}) and (${b}) are now in one project`,
        );
      } finally {
        await rm(old.root, { recursive: true, force: true });
        await rm(fresh.root, { recursive: true, force: true });
      }
    });

    // Red: drop the throttle — the second listing follows c/r to d/r too;
    // or answer a skipped pass with no rows — its row flickers out.
    it("listings inside the interval follow once and repeat its row; after it, they follow again", async () => {
      let clock = 1_000_000;
      await h.close();
      h = await startStudio(home, { followEveryMs: 60_000, now: () => clock });
      const notGit = await mkdtemp(join(tmpdir(), "studio-throttle-not-git-"));
      const { root, head } = await checkout(
        "studio-throttle-",
        "git@github.com:a/r.git",
      );
      try {
        const stuck = await recordedIn(notGit, "github.com/n/r", null);
        const moving = await recordedIn(
          root,
          "github.com/a/r",
          head,
          "Send a bill",
        );
        const rowOf = (body: TakesAnswer) =>
          body.unreadable.find(
            (u) => u.folder === "following projects' checkouts",
          )?.reason;
        const keyOf = (body: TakesAnswer) =>
          body.videos.find((v) => v.id === moving)?.repo;
        git(root, "remote", "set-url", "origin", "git@github.com:b/r.git");
        const first = await listing();
        expect(keyOf(first), JSON.stringify(first.unreadable)).toEqual({
          key: "github.com/b/r",
        });
        expect(rowOf(first)).toContain(`flow "Pay a bill" (${stuck})`);

        git(root, "remote", "set-url", "origin", "git@github.com:c/r.git");
        // Premise: a pass now would move the flow to c/r.
        const read = await readRepo(root);
        expect(read.ok && read.repo.key).toBe("github.com/c/r");
        clock += 59_999;
        const second = await listing();
        expect(keyOf(second)).toEqual({ key: "github.com/b/r" });
        expect(rowOf(second)).toBe(rowOf(first));

        clock += 1;
        const third = await listing();
        expect(keyOf(third), JSON.stringify(third.unreadable)).toEqual({
          key: "github.com/c/r",
        });
        expect(rowOf(third)).toContain(`flow "Pay a bill" (${stuck})`);
      } finally {
        await rm(notGit, { recursive: true, force: true });
        await rm(root, { recursive: true, force: true });
      }
    });

    // Red: let followCheckouts throw from videos.follow — the row says only
    // that it could not follow, and the checkout that would not read is lost.
    it.skipIf(process.getuid?.() === 0)(
      "a re-keying that fails is said beside the checkouts that would not read",
      async () => {
        const notGit = await mkdtemp(join(tmpdir(), "studio-fail-not-git-"));
        const { root, head } = await checkout(
          "studio-fail-",
          "git@github.com:a/r.git",
        );
        const dir = join(home, "videos");
        try {
          const stuck = await recordedIn(notGit, "github.com/n/r", null);
          await recordedIn(root, "github.com/a/r", head, "Send a bill");
          git(root, "remote", "set-url", "origin", "git@github.com:b/r.git");
          // The lock and the table cannot be written: re-keying fails.
          await chmod(dir, 0o500);
          const body = await listing();
          const said = JSON.stringify(body.unreadable);
          const rows = body.unreadable.filter(
            (u) => u.folder === "following projects' checkouts",
          );
          expect(rows, said).toHaveLength(1);
          expect(rows[0]?.reason, said).toContain(
            "projects could not follow their checkouts (",
          );
          expect(rows[0]?.reason, said).toContain(
            `flow "Pay a bill" (${stuck}) at ${notGit}: not a git checkout`,
          );
        } finally {
          await chmod(dir, 0o755);
          await rm(notGit, { recursive: true, force: true });
          await rm(root, { recursive: true, force: true });
        }
      },
    );

    it("an alias table that will not read is a row naming it, and every flow still lists", async () => {
      const path = join(home, "videos", ".aliases.json");
      await writeFile(path, "{nope");
      const body = await listing();
      const said = JSON.stringify(body.unreadable);
      const row = body.unreadable.find(
        (u) => u.folder === "following projects' checkouts",
      );
      expect(row?.kind, said).toBe("upkeep");
      expect(row?.reason, said).toContain(path);
      expect(body.videos.map((v) => v.id).sort()).toEqual(
        [invoice, signup].sort(),
      );
    });
  });

  it("a take whose video.json will not read is a row, and every video still lists", async () => {
    // Red (final review 4): read memberships unguarded — the migration
    // fails, versions() throws for every video, and no video lists.
    const path = join(home, "takes", "inv-1", "video.json");
    await writeFile(path, "{ not json");
    const body = await listing();
    const said = JSON.stringify(body.unreadable);
    expect(body.videos.map((v) => v.name).sort(), said).toEqual([
      "Create an invoice",
      "Sign up",
    ]);
    // Left out of its video, so never expired either.
    expect(body.videoOf["inv-1"], said).toBeUndefined();
    expect(body.videoOf["inv-2"]?.videoId).toBe(invoice);
    expect(
      body.unreadable.map((u) => [u.folder, u.kind]),
      said,
    ).toEqual([["inv-1", "take"]]);
    expect(body.unreadable[0]?.reason).toContain(path);
  });

  it("while another process holds the lock, healthy loose takes are no rows; one upkeep row says why", async () => {
    // Red (second review 1): list each waiting take in `skipped` — every
    // healthy loose take reads "Couldn't read" with a Delete that deletes it.
    await seedTake(home, { id: "loose" });
    await seedTake(home, { id: "loose-2" });
    const lock = join(home, "videos", ".lock");
    await mkdir(lock);
    // Premise: both takes are loose, so a migration would want them.
    const store = createVideoStore(home, createLibrary(home));
    expect(await store.videoOf("loose")).toBeNull();
    expect(await store.videoOf("loose-2")).toBeNull();
    const body = await listing();
    const said = JSON.stringify(body.unreadable);
    expect(
      body.unreadable.map((u) => [u.folder, u.kind]),
      said,
    ).toEqual([["joining videos to flows", "upkeep"]]);
    expect(body.unreadable[0]?.reason).toContain(lock);
    expect(body.scenes.map((x) => x.meta.id)).toEqual(
      expect.arrayContaining(["loose", "loose-2"]),
    );
  });

  it("a version whose status.json or scene will not read is a row, once, and every video still lists", async () => {
    // Red (second review 3): read a member's files unguarded — versions()
    // throws, and "Create an invoice" lists as a "Couldn't read" video.
    const status = join(home, "takes", "inv-2", "status.json");
    await writeFile(status, "{ not json");
    const scene = join(home, "takes", "inv-3", "scene.json");
    await writeFile(
      scene,
      JSON.stringify({ schemaVersion: CURRENT_SCHEMA_VERSION + 1 }),
    );
    const body = await listing();
    const said = JSON.stringify(body.unreadable);
    expect(body.videos.map((v) => v.name).sort(), said).toEqual([
      "Create an invoice",
      "Sign up",
    ]);
    expect(body.videoOf["inv-1"]?.videoId).toBe(invoice);
    expect(body.videoOf["inv-2"], said).toBeUndefined();
    expect(body.videoOf["inv-3"], said).toBeUndefined();
    expect(body.unreadable.map((u) => [u.folder, u.kind]).sort(), said).toEqual(
      [
        ["inv-2", "take"],
        ["inv-3", "take"],
      ],
    );
    expect(body.unreadable.find((u) => u.folder === "inv-2")?.reason).toContain(
      status,
    );
    expect(body.unreadable.find((u) => u.folder === "inv-3")?.reason).toContain(
      scene,
    );
  });

  it("a video record that will not read is a row, and the other video still lists", async () => {
    // Red: skip unreadable records silently — no row names the file.
    await writeFile(join(home, "videos", `${signup}.json`), "{ not json");
    const body = await listing();
    expect(body.videos.map((v) => v.name)).toEqual(["Create an invoice"]);
    expect(body.unreadable.map((u) => [u.folder, u.kind])).toEqual([
      [signup, "video"],
    ]);
    expect(body.unreadable[0]?.reason).toMatch(/not JSON/);
  });

  it("lists each version's exports, a moved file as not there, and an outputs.json that will not read as itself", async () => {
    // Red: answer `exports: []` for every version — inv-2's two files are
    // not listed.
    const kept = join(home, "kept.mp4");
    await writeFile(kept, "bytes");
    await seedOutput(home, "inv-2", kept);
    await seedOutput(home, "inv-2", join(home, "moved.mp4"));
    await writeFile(join(home, "takes", "inv-3", "outputs.json"), "{ nope");
    const body = await listing();
    expect(body.videoOf["inv-2"]?.exports).toEqual([
      { path: kept, fileType: "mp4", exists: true },
      { path: join(home, "moved.mp4"), fileType: "mp4", exists: false },
    ]);
    expect(body.videoOf["inv-3"]?.exports).toEqual({
      unreadable: expect.stringContaining("outputs.json"),
    });
    expect(body.videoOf["inv-1"]?.exports).toEqual([]);
  });

  it("a take whose video.json will not read answers why in the scene answer", async () => {
    // Red (second review 6): log the error and answer videoId null alone —
    // the editor says "in no video" with nothing saying anything failed.
    const path = join(home, "takes", "inv-2", "video.json");
    await writeFile(path, "{ not json");
    const r = await h.call(pathFor("sceneGet", { id: "inv-2" }));
    expect(r.status, r.text).toBe(200);
    const got = r.json() as { videoId: string | null; videoError: string };
    expect(got.videoId).toBeNull();
    expect(got.videoError).toContain(path);
    const fine = await h.call(pathFor("sceneGet", { id: "inv-1" }));
    expect((fine.json() as { videoError: unknown }).videoError).toBeNull();
  });

  it("a take's scene answer names its video", async () => {
    // Red: drop videoId from sceneGet — the editor cannot name the video
    // in its re-record line.
    const r = await h.call(pathFor("sceneGet", { id: "inv-2" }));
    expect((r.json() as { videoId: string | null }).videoId).toBe(invoice);
    await seedTake(home, { id: "loose" });
    const loose = await h.call(pathFor("sceneGet", { id: "loose" }));
    expect((loose.json() as { videoId: string | null }).videoId).toBeNull();
  });
});

describe("renaming a video", () => {
  const rename = (id: string, body: unknown) =>
    h.call(pathFor("videoRename", { id }), {
      method: "PUT",
      body: JSON.stringify(body),
    });

  it("renames the video record, not its takes", async () => {
    const r = await rename(invoice, { name: "  Send an invoice " });
    expect(r.status, r.text).toBe(200);
    const body = await listing();
    expect(body.videos.find((v) => v.id === invoice)?.name).toBe(
      "Send an invoice",
    );
    // The take's own name is the take's.
    expect(body.scenes.find((s) => s.meta.id === "inv-2")?.meta.name).toBe(
      "Create an invoice",
    );
  });

  it("onto another video's name answers nameTaken naming it, and renames nothing", async () => {
    // Red: answer 200 on store.rename's refusal — the record keeps its name
    // and the page is told it was renamed.
    const r = await rename(invoice, { name: "sign up" });
    expect(r.status).toBe(409);
    expect(r.json()).toEqual({
      reason: "nameTaken",
      detail: 'Another flow is already called "Sign up".',
    });
    const body = await listing();
    expect(body.videos.find((v) => v.id === invoice)?.name).toBe(
      "Create an invoice",
    );
  });

  it("a blank name is videoNameInvalid; an unknown or hostile id is videoNotFound", async () => {
    expect((await rename(invoice, { name: "  " })).status).toBe(400);
    expect(
      ((await rename(invoice, { name: "  " })).json() as { reason: string })
        .reason,
    ).toBe("videoNameInvalid");
    const unknown = await rename("00000000-0000-4000-8000-000000000000", {
      name: "x",
    });
    expect(unknown.status).toBe(404);
    expect((unknown.json() as { reason: string }).reason).toBe("videoNotFound");
    // Red: drop the id check — the store reads `videos/../kits.json`.
    await writeFile(join(home, "kits.json"), JSON.stringify({ name: "kits" }));
    const hostile = await rename("../kits", { name: "x" });
    expect(hostile.status).toBe(404);
    expect((hostile.json() as { reason: string }).reason).toBe("videoNotFound");
  });
});

describe("renaming a kept flow", () => {
  const rename = (id: string, body: unknown) =>
    h.call(pathFor("videoRename", { id }), {
      method: "PUT",
      body: JSON.stringify(body),
    });
  const OLD = keptFileName("Create an invoice");
  const NEW = keptFileName("Send an invoice");
  const KEY = "github.com/acme/app";
  let checkout: string;
  const recipe = (): KeptVideo => ({
    keptVersion: 2,
    flow: invoice,
    deliver: "commit",
    name: "Create an invoice",
    script: {
      scriptVersion: 1,
      name: "Create an invoice",
      target: "https://app.example.com/orders",
      viewport: { width: 1280, height: 800 },
      steps: [{ do: "waitForLoad" }],
    } as KeptVideo["script"],
    scale: 1,
    logo: null,
    wallpaper: null,
    outputs: [
      { path: "docs/o.mp4", fileType: "mp4", aspect: "16:9", quality: "share" },
    ],
    report: null,
  });
  const receiptText = () =>
    serializeReceipt({
      receiptVersion: 1,
      flow: invoice,
      video: "inv-2",
      filmedAt: null,
      filmedCode: { none: "a test" },
      screens: { steps: 1, moments: [{ step: null, ms: 0 }] },
      recordedRevision: null,
    });
  /** `invoice` kept in `checkout`: its recipe and receipt written, and its
   *  record pointing at the recipe, as `keep` leaves them. */
  async function keepInvoice(root: string): Promise<void> {
    await mkdir(join(root, KEPT_DIR), { recursive: true });
    await mkdir(join(root, RECEIPT_DIR), { recursive: true });
    await writeFile(join(root, KEPT_DIR, OLD), serializeKept(recipe()));
    await writeFile(join(root, RECEIPT_DIR, OLD), receiptText());
    const store = createVideoStore(home, createLibrary(home));
    const marked = await store.setKept(invoice, {
      root,
      file: `${KEPT_DIR}/${OLD}`,
      key: KEY,
    });
    if (!marked.ok) throw new Error("the fixture's flow was not marked kept");
  }
  beforeEach(async () => {
    checkout = await mkdtemp(join(tmpdir(), "studio-kept-"));
  });
  afterEach(async () => {
    await chmod(join(checkout, RECEIPT_DIR), 0o755).catch(() => undefined);
    await rm(checkout, { recursive: true, force: true });
  });

  it("renaming a kept flow rewrites the recipe and moves its receipt", async () => {
    await keepInvoice(checkout);
    // Premise: the listing reads the flow as kept in its recipe, and the
    // new name is another file.
    expect(
      (await listing()).videos.find((v) => v.id === invoice)?.kept,
    ).toEqual({
      root: checkout,
      file: `${KEPT_DIR}/${OLD}`,
      deliver: "commit",
      key: KEY,
    });
    expect(NEW).not.toBe(OLD);
    // Red: call videos.rename alone for a kept flow — the recipe keeps the
    // old name and file, and the receipt does not move.
    const r = await rename(invoice, { name: "Send an invoice" });
    expect(r.status, r.text).toBe(200);
    expect(await readFile(join(checkout, FLOWS_DIR, NEW), "utf8")).toBe(
      serializeKept({ ...recipe(), name: "Send an invoice" }),
    );
    expect(await exists(join(checkout, KEPT_DIR, OLD))).toBe(false);
    expect(await readFile(join(checkout, RECEIPT_DIR, NEW), "utf8")).toBe(
      receiptText(),
    );
    expect(await exists(join(checkout, RECEIPT_DIR, OLD))).toBe(false);
    const after = (await listing()).videos.find((v) => v.id === invoice);
    expect(after?.name).toBe("Send an invoice");
    expect(after?.kept).toEqual({
      root: checkout,
      file: `${FLOWS_DIR}/${NEW}`,
      deliver: "commit",
      key: KEY,
    });
  });

  it("renaming a flow in .demoman/videos/ to a name with the same file moves it", async () => {
    await keepInvoice(checkout);
    // Premise: the new name makes the old file name, in the old folder.
    expect(keptFileName("Create an invoice!")).toBe(OLD);
    const r = await rename(invoice, { name: "Create an invoice!" });
    expect(r.status, r.text).toBe(200);
    expect(await readFile(join(checkout, FLOWS_DIR, OLD), "utf8")).toBe(
      serializeKept({ ...recipe(), name: "Create an invoice!" }),
    );
    expect(await exists(join(checkout, KEPT_DIR, OLD))).toBe(false);
    expect(await readFile(join(checkout, RECEIPT_DIR, OLD), "utf8")).toBe(
      receiptText(),
    );
  });

  it("renaming to a name whose file is in .demoman/videos/ refuses and renames nothing", async () => {
    await keepInvoice(checkout);
    const theirs = serializeKept({
      ...recipe(),
      flow: "1a2b3c4d-0000-4000-8000-0000000000aa",
      name: "Send an invoice",
    });
    await writeFile(join(checkout, KEPT_DIR, NEW), theirs);
    // Premise: the new name's file is free in .demoman/flows/.
    expect(await exists(join(checkout, FLOWS_DIR, NEW))).toBe(false);
    // Red: check .demoman/flows/ alone — two recipes then hold the name.
    const r = await rename(invoice, { name: "Send an invoice" });
    expect(r.status, r.text).toBe(409);
    expect(refusal(r).reason).toBe("nameTaken");
    expect(refusal(r).detail).toContain(`${KEPT_DIR}/${NEW} already exists`);
    expect(await state()).toEqual(untouched());
    expect(await readFile(join(checkout, KEPT_DIR, NEW), "utf8")).toBe(theirs);
  });

  it("renaming a kept flow whose checkout is gone renames it and clears the mark", async () => {
    await keepInvoice(checkout);
    // Premise: the record is marked kept in a checkout that is then deleted.
    const store = createVideoStore(home, createLibrary(home));
    expect((await store.get(invoice))?.kept?.root).toBe(checkout);
    await rm(checkout, { recursive: true, force: true });
    // The listing files it by date, not In repo: keptOf decides, once.
    const before = (await listing()).videos.find((v) => v.id === invoice);
    expect(before?.kept).toBeNull();
    // Red: refuse while the record is marked — a deleted worktree leaves
    // the flow unrenameable for good.
    const r = await rename(invoice, { name: "Send an invoice" });
    expect(r.status, r.text).toBe(200);
    const after = (await listing()).videos.find((v) => v.id === invoice);
    expect(after?.name).toBe("Send an invoice");
    expect((await store.get(invoice))?.kept).toBeUndefined();
    // Red: clear the mark without a word.
    expect(h.logs).toContain(
      `studio: flow ${invoice}'s recipe is no longer in ${checkout}; its mark was cleared`,
    );
  });

  it("renaming a kept flow whose recipe no file in the checkout keeps renames it and clears the mark", async () => {
    await keepInvoice(checkout);
    await rm(join(checkout, KEPT_DIR, OLD));
    // Premise: the checkout is still there.
    expect(await exists(checkout)).toBe(true);
    const r = await rename(invoice, { name: "Send an invoice" });
    expect(r.status, r.text).toBe(200);
    const store = createVideoStore(home, createLibrary(home));
    expect((await store.get(invoice))?.name).toBe("Send an invoice");
    expect((await store.get(invoice))?.kept).toBeUndefined();
    // Nothing was written into the checkout for a flow it no longer keeps.
    expect(await exists(join(checkout, FLOWS_DIR))).toBe(false);
  });

  it("renaming a kept flow whose recipe will not read refuses and renames nothing", async () => {
    await keepInvoice(checkout);
    await chmod(join(checkout, KEPT_DIR, OLD), 0o000);
    try {
      const r = await rename(invoice, { name: "Send an invoice" });
      expect(r.status, r.text).toBe(409);
      const refused = r.json() as { reason: string; detail: string };
      expect(refused.reason).toBe("repoCheckoutMissing");
      expect(refused.detail).toContain(`${KEPT_DIR}/${OLD}`);
      expect(refused.detail).toMatch(/keeps its name\.$/);
      const store = createVideoStore(home, createLibrary(home));
      expect((await store.get(invoice))?.name).toBe("Create an invoice");
      expect((await store.get(invoice))?.kept?.root).toBe(checkout);
    } finally {
      await chmod(join(checkout, KEPT_DIR, OLD), 0o644);
    }
  });

  /** What the checkout and the library hold of the flow: whether each
   *  recipe file is there, the record's name and its kept pointer. */
  const state = async () => {
    const v = (await listing()).videos.find((x) => x.id === invoice);
    return {
      oldRecipe: await exists(join(checkout, KEPT_DIR, OLD)),
      newRecipe: await exists(join(checkout, FLOWS_DIR, NEW)),
      oldReceipt: await exists(join(checkout, RECEIPT_DIR, OLD)),
      newReceipt: await exists(join(checkout, RECEIPT_DIR, NEW)),
      name: v?.name,
      kept: v?.kept,
    };
  };
  const untouched = () => ({
    oldRecipe: true,
    newRecipe: false,
    oldReceipt: true,
    newReceipt: false,
    name: "Create an invoice",
    kept: {
      root: checkout,
      file: `${KEPT_DIR}/${OLD}`,
      deliver: "commit",
      key: KEY,
    },
  });
  const refusal = (r: { json: () => unknown }) =>
    r.json() as { reason: string; detail: string };

  it("a receipt that will not move undoes the recipe, and the same rename then succeeds", async () => {
    await keepInvoice(checkout);
    // The receipt cannot move: its folder takes no new file.
    await chmod(join(checkout, RECEIPT_DIR), 0o555);
    const r = await rename(invoice, { name: "Send an invoice" });
    expect(r.status, r.text).toBe(500);
    expect(refusal(r).reason).toBe("repoFlowUnwritable");
    expect(refusal(r).detail).toContain(`could not move ${RECEIPT_DIR}/${OLD}`);
    expect(refusal(r).detail).toContain("the old name stands everywhere");
    // Red: drop the undo — the new recipe is left beside the old one.
    expect(await state()).toEqual(untouched());
    await chmod(join(checkout, RECEIPT_DIR), 0o755);
    const retry = await rename(invoice, { name: "Send an invoice" });
    expect(retry.status, retry.text).toBe(200);
    expect(await state()).toEqual({
      oldRecipe: false,
      newRecipe: true,
      oldReceipt: false,
      newReceipt: true,
      name: "Send an invoice",
      kept: {
        root: checkout,
        file: `${FLOWS_DIR}/${NEW}`,
        deliver: "commit",
        key: KEY,
      },
    });
  });

  it("a library that will not rename puts both files back at the old name", async () => {
    await keepInvoice(checkout);
    // The record's folder takes no lock: videos.rename fails after the
    // recipe and receipt have moved.
    const records = join(home, "videos");
    await chmod(records, 0o555);
    let r: Awaited<ReturnType<typeof rename>>;
    try {
      r = await rename(invoice, { name: "Send an invoice" });
    } finally {
      await chmod(records, 0o755);
    }
    expect(r.status, r.text).toBe(500);
    expect(refusal(r).reason).toBe("repoFlowUnwritable");
    expect(refusal(r).detail).toContain("could not rename the library's flow");
    // Red: remove the old recipe before the library's rename, or drop the
    // undo — the files are left at the new slug while the library says old.
    expect(await state()).toEqual(untouched());
  });

  it("a path that leaves the repo refuses repoFlowUnwritable and writes nothing", async () => {
    await keepInvoice(checkout);
    // The receipts folder is a link to a folder outside the checkout.
    const outside = await mkdtemp(join(tmpdir(), "studio-outside-"));
    try {
      await rm(join(checkout, RECEIPT_DIR), { recursive: true });
      await symlink(outside, join(checkout, RECEIPT_DIR));
      const r = await rename(invoice, { name: "Send an invoice" });
      expect(r.status, r.text).toBe(500);
      expect(refusal(r).reason).toBe("repoFlowUnwritable");
      expect(refusal(r).detail).toMatch(/nothing was renamed\.$/);
      const now = await state();
      expect(now).toMatchObject({
        oldRecipe: true,
        newRecipe: false,
        name: "Create an invoice",
      });
      expect(await readdir(outside)).toEqual([]);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("a name another flow or file holds refuses nameTaken and writes nothing", async () => {
    await keepInvoice(checkout);
    const flow = await rename(invoice, { name: "Sign up" });
    expect(flow.status, flow.text).toBe(409);
    expect(refusal(flow)).toEqual({
      reason: "nameTaken",
      detail: 'Another flow is already called "Sign up".',
    });
    expect(await state()).toEqual(untouched());
    // A file already at the new name's slug, keeping something else.
    await mkdir(join(checkout, FLOWS_DIR), { recursive: true });
    await writeFile(join(checkout, FLOWS_DIR, NEW), "someone else's");
    const file = await rename(invoice, { name: "Send an invoice" });
    expect(file.status, file.text).toBe(409);
    expect(refusal(file).reason).toBe("nameTaken");
    expect(refusal(file).detail).toContain(
      `${FLOWS_DIR}/${NEW} already exists`,
    );
    expect(await readFile(join(checkout, FLOWS_DIR, NEW), "utf8")).toBe(
      "someone else's",
    );
    expect({ ...(await state()), newRecipe: false }).toEqual(untouched());
  });
});

describe("deleting", () => {
  const del = (id: string) =>
    h.call(pathFor("videoDelete", { id }), { method: "DELETE" });

  it("a video goes with every version and its record", async () => {
    const r = await del(invoice);
    expect(r.status, r.text).toBe(200);
    expect(r.json()).toEqual({ note: null });
    for (const id of ["inv-1", "inv-2", "inv-3"]) {
      expect(await exists(join(home, "takes", id)), id).toBe(false);
    }
    expect(await exists(join(home, "videos", `${invoice}.json`))).toBe(false);
    const body = await listing();
    expect(body.videos.map((v) => v.name)).toEqual(["Sign up"]);
  });

  it("is refused while any version is under an export lease, naming the holder, and nothing goes", async () => {
    // Red: delete the versions one by one without checking first — inv-1
    // is gone before inv-2's lease refuses.
    const lease = await createLibrary(home).lease("inv-2", {
      op: "export",
      door: "agent",
      jobId: "job-1",
    });
    try {
      const r = await del(invoice);
      expect(r.status).toBe(409);
      expect(r.json()).toEqual({ reason: "takeBusy", detail: TAKE_BUSY.agent });
      for (const id of ["inv-1", "inv-2", "inv-3"]) {
        expect(await exists(join(home, "takes", id, "scene.json")), id).toBe(
          true,
        );
      }
      expect(await exists(join(home, "videos", `${invoice}.json`))).toBe(true);
    } finally {
      await lease.release();
    }
  });

  it("one version is the take's own delete, and the current version moves to the next newest complete", async () => {
    // Premise: inv-2 is current.
    expect(
      (await listing()).videos.find((v) => v.id === invoice)?.current?.takeId,
    ).toBe("inv-2");
    const r = await h.call(pathFor("takeDelete", { id: "inv-2" }), {
      method: "DELETE",
    });
    expect(r.status, r.text).toBe(200);
    const body = await listing();
    const video = body.videos.find((v) => v.id === invoice);
    expect(video?.versions).toBe(2);
    expect(video?.current?.takeId).toBe("inv-1");
  });

  it("a video's last version deleted takes the video with it", async () => {
    // Red: drop the empty-video removal from takeDelete — "Sign up" lists
    // with no versions and keeps its name from every other video.
    const r = await h.call(pathFor("takeDelete", { id: "sign-1" }), {
      method: "DELETE",
    });
    expect(r.status, r.text).toBe(200);
    expect(r.json()).toEqual({ note: null });
    expect(await exists(join(home, "videos", `${signup}.json`))).toBe(false);
    expect((await listing()).videos.map((v) => v.name)).toEqual([
      "Create an invoice",
    ]);
  });

  it("an unreadable video record's delete removes the record alone, and its recordings stay", async () => {
    // Red: refuse it (500 videoUnreadable) — the row's Delete can never work.
    await writeFile(join(home, "videos", `${signup}.json`), "{ not json");
    const r = await del(signup);
    expect(r.status, r.text).toBe(200);
    expect((r.json() as { note: string }).note).toMatch(/videos stay/);
    expect(await exists(join(home, "videos", `${signup}.json`))).toBe(false);
    expect(await exists(join(home, "takes", "sign-1", "scene.json"))).toBe(
      true,
    );
  });

  it.skipIf(process.getuid?.() === 0)(
    "a record that will not go after every version did says it partly deleted",
    async () => {
      // Red: let the record's removal throw — a 500 over a video whose
      // recordings are already gone, read by the page as "Not deleted".
      const dir = join(home, "videos");
      await chmod(dir, 0o500);
      try {
        const r = await del(signup);
        expect(r.status, r.text).toBe(200);
        const body = r.json() as { note: null; partly: string };
        expect(body.partly).toMatch(
          /its video went, but its record could not be removed/,
        );
        expect(await exists(join(home, "takes", "sign-1"))).toBe(false);
      } finally {
        await chmod(dir, 0o755);
      }
    },
  );

  it.skipIf(process.getuid?.() === 0)(
    "a video whose takes cannot be listed answers why, and deletes nothing",
    async () => {
      // Red (second review 7b): let the store's error reach the door — a
      // bare 500 internalError the page cannot explain.
      const takes = join(home, "takes");
      await chmod(takes, 0o300);
      let r: Awaited<ReturnType<typeof del>>;
      try {
        r = await del(invoice);
      } finally {
        await chmod(takes, 0o755);
      }
      expect(r.status, r.text).toBe(500);
      const body = r.json() as { reason: string; detail: string };
      expect(body.reason).toBe("videoUnreadable");
      expect(body.detail).toContain(takes);
      expect(await exists(join(takes, "inv-1", "scene.json"))).toBe(true);
      expect(await exists(join(home, "videos", `${invoice}.json`))).toBe(true);
    },
  );

  it("an unknown video is videoNotFound", async () => {
    const r = await del("00000000-0000-4000-8000-000000000000");
    expect(r.status).toBe(404);
    expect((r.json() as { reason: string }).reason).toBe("videoNotFound");
  });
});

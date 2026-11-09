import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { notCarriedOf, videoSlug } from "@demoman/run-core";
import type { SceneDocument } from "@demoman/scene-schema";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readonlyScene } from "../../../packages/compositor/test/fixtures/scene.js";
import { checkAddable, notInRepo } from "../src/executor/addable.js";
import {
  type BrowserSession,
  createBrowserSession,
} from "../src/executor/browser.js";
import { type KeepDeps, keepVideo } from "../src/executor/keep.js";
import { createLibrary, type Library } from "../src/executor/library.js";
import { execGit, type RepoRef, readRepo } from "../src/executor/repo.js";
import { createSessionStore } from "../src/executor/sessions.js";
import {
  createVideoStore,
  type VideoRecord,
  type VideoStore,
} from "../src/executor/videos.js";
import { makeDiskTake, putTake } from "./disk-take.js";
import { WALLPAPERS_DIR } from "./fixture.js";

const SETUP_MS = 120_000;
const KEEP_MS = 240_000;

let home: string;
let repo: string;
let gone: string;
let library: Library;
let videos: VideoStore;
let session: BrowserSession;
let repoRef: RepoRef;
let goneRef: RepoRef;
let cases = 0;

const deps = (): KeepDeps => ({
  home,
  library,
  videos,
  git: execGit,
  log: () => {},
  export: {
    wallpapersDir: WALLPAPERS_DIR,
    library,
    videos,
    session,
    door: "agent",
    home,
    outDir: join(home, "unused-out"),
    log: () => {},
  },
});

const initRepo = async (): Promise<RepoRef> => {
  const dir = await mkdtemp(join(tmpdir(), "demoman-addable-repo-"));
  expect((await execGit(["init", "-q"], dir)).code).toBe(0);
  const read = await readRepo(dir);
  if (!read.ok) throw new Error(read.none);
  return read.repo;
};

/** A video of its own, made in `made` (a repo, or none), on a new scene. */
async function video(
  name: string,
  made: RepoRef | { none: string },
  edit: (d: SceneDocument) => SceneDocument = (d) => d,
  takeId = `scene-addable-${++cases}`,
): Promise<{ record: VideoRecord; scene: SceneDocument }> {
  const base = readonlyScene();
  const scene = edit({ ...base, meta: { ...base.meta, id: takeId } });
  await library.putScene(scene);
  const created = await videos.create({
    name,
    repo: "key" in made ? { key: made.key } : { none: made.none },
    startPage: scene.meta.capture.originUrl,
  });
  if (!created.ok) throw new Error(JSON.stringify(created));
  const read = await library.getSceneRead(takeId);
  if (read === null) throw new Error("no scene");
  await videos.join(takeId, {
    videoId: created.video.id,
    made: {
      repo: made,
      agent: { none: "test" },
      by: { none: "test" },
      door: "mcp",
    },
    recordedRevision: read.revision,
  });
  return { record: created.video, scene };
}

const addable = (record: VideoRecord) =>
  checkAddable({ video: record }, { videos, library, home, git: execGit });

/** What `keepVideo` says to the same video: the command and the button agree. */
async function keepSays(name: string) {
  return keepVideo(
    {
      video: name,
      to: [
        {
          path: `docs/agree-${++cases}.mp4`,
          fileType: "mp4",
          aspect: "16:9",
          quality: "share",
        },
      ],
      repoRoot: repoRef.root,
    },
    deps(),
  );
}

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), "demoman-addable-home-"));
  repoRef = await initRepo();
  repo = repoRef.root;
  goneRef = await initRepo();
  gone = goneRef.root;
  library = createLibrary(home);
  videos = createVideoStore(home, library, { log: () => {} });
  session = createBrowserSession({ headless: true, log: () => {} });
}, SETUP_MS);

afterAll(async () => {
  await session?.close();
  for (const dir of [home, repo, gone])
    if (dir) await rm(dir, { recursive: true, force: true });
});

describe("checkAddable", () => {
  // Red if checkAddable stops answering ok for a clean video, or its default path changes.
  it(
    "a clean video is addable to its checkout, and the command adds it",
    async () => {
      const { takeId, original, bundle } = await makeDiskTake(home);
      const still = { sourceTimeMs: 0, x: 900, y: 600 };
      await putTake(home, takeId, original, {
        ...bundle,
        cursorSamples: [still, { ...still, sourceTimeMs: 9000 }],
      });
      const { record, scene } = await video(
        "Create an invoice",
        repoRef,
        () => original,
        takeId,
      );
      expect(notCarriedOf(scene)).toEqual([]);
      expect(await addable(record)).toEqual({
        ok: true,
        root: repo,
        defaultPath: "docs/demos/create-an-invoice.mp4",
      });
      expect((await keepSays("Create an invoice")).ok).toBe(true);
    },
    KEEP_MS,
  );

  // Red if the leftBehind check leaves checkAddable: both trim cases go ok.
  it("a trim is named by one label, the detail names every edit", async () => {
    const trim = { tail: { actionId: "act-3", offsetMs: 0 } };
    const mask = [
      { id: "mask-1", rect: { x: 0, y: 0, width: 10, height: 10 } },
    ];
    const { record, scene } = await video("Trimmed", repoRef, (d) => ({
      ...d,
      edits: { ...d.edits, trim },
    }));
    expect(notCarriedOf(scene)).toEqual([{ kind: "trim", id: "tail" }]);
    expect(await addable(record)).toMatchObject({
      ok: false,
      reason: "notCarried",
      label: "has a trim",
    });
    expect((await keepSays("Trimmed")).ok).toBe(false);

    const both = await video("Trimmed and masked", repoRef, (d) => ({
      ...d,
      edits: { ...d.edits, trim, masks: mask },
    }));
    expect(
      notCarriedOf(both.scene)
        .map((n) => n.kind)
        .sort(),
    ).toEqual(["mask", "trim"]);
    const out = await addable(both.record);
    if (out.ok) throw new Error("addable");
    expect(out.reason).toBe("notCarried");
    expect(["has a trim", "has a mask"]).toContain(out.label);
    expect(out.detail).toContain("trim tail");
    expect(out.detail).toContain("mask mask-1");
    const kept = await keepSays("Trimmed and masked");
    expect(kept).toMatchObject({ ok: false, reason: "notCarried" });
  });

  // Red if the unfilledHoles label or reason is lost from vetForAdd.
  it("a script hole says it has typed text the video never read", async () => {
    const { record } = await video("Redacted", repoRef, (d) => ({
      ...d,
      actions: d.actions.map((a) =>
        a.id === "act-1"
          ? ({ ...a, text: null, redacted: true } as typeof a)
          : a,
      ),
    }));
    expect(await addable(record)).toMatchObject({
      ok: false,
      reason: "unfilledHoles",
      label: "has typed text the video never read",
    });
    expect(await keepSays("Redacted")).toMatchObject({
      reason: "unfilledHoles",
    });
  });

  // Red if the saved-session check leaves vetForAdd.
  it("a site signed in to by hand", async () => {
    const url = "https://signed.example.org/inbox";
    const { record, scene } = await video("Handsigned", repoRef, (d) => ({
      ...d,
      meta: { ...d.meta, capture: { ...d.meta.capture, originUrl: url } },
    }));
    await createSessionStore(home).save({
      sessionVersion: 1,
      site: "example.org",
      savedAt: new Date().toISOString(),
      refreshedAt: null,
      startUrl: url,
      signInUrl: null,
      state: { cookies: [], origins: [] },
    });
    expect(notCarriedOf(scene)).toEqual([]);
    expect(await addable(record)).toMatchObject({
      ok: false,
      reason: "handSignIn",
      label: "signed in by hand",
    });
    expect(await keepSays("Handsigned")).toMatchObject({
      reason: "handSignIn",
    });
  });

  // Red if keep.ts's otherApp check goes: every loopback port shares the
  // `localhost` file, so another local app's sign-in blocked this one.
  it("a localhost sign-in to another port is another app's (DEM-46)", async () => {
    const handAt = (startUrl: string) =>
      createSessionStore(home).save({
        sessionVersion: 1,
        site: "localhost",
        savedAt: new Date().toISOString(),
        refreshedAt: null,
        startUrl,
        signInUrl: null,
        state: { cookies: [], origins: [] },
      });
    const { record, scene } = await video("Counter", repoRef, (d) => ({
      ...d,
      meta: {
        ...d.meta,
        capture: { ...d.meta.capture, originUrl: "http://localhost:3000/" },
      },
    }));
    expect(notCarriedOf(scene)).toEqual([]);
    await handAt("http://localhost:4000/login");
    expect(await addable(record)).toMatchObject({ ok: true });
    // The same port is this app's own sign-in, and still refused.
    await handAt("http://127.0.0.1:3000/login");
    expect(await addable(record)).toMatchObject({
      ok: false,
      reason: "handSignIn",
    });
  });

  // Red if checkoutOf stops testing that the folder exists.
  it("a removed checkout is noCheckout, naming the path", async () => {
    const { record } = await video("Orphaned", goneRef);
    expect((await addable(record)).ok).toBe(true);
    await rm(gone, { recursive: true, force: true });
    const out = await addable(record);
    expect(out).toMatchObject({
      ok: false,
      reason: "noCheckout",
      label: "no checkout found",
    });
    if (!out.ok) {
      expect(out.detail).toContain(gone);
      // The escape hatch: the command that adds it from a checkout of its own.
      expect(out.detail).toContain("npx demoman add 'Orphaned' --to <path>");
    }
  });

  // Red if checkoutOf goes back to asking only the newest version's folder.
  it("an older version's checkout answers when the newest was recorded in another repo", async () => {
    const other = await initRepo();
    try {
      const first = "scene-addable-two-a";
      const later = "scene-addable-two-b";
      const { record } = await video("Two checkouts", repoRef, (d) => d, first);
      const base = readonlyScene();
      await library.putScene({ ...base, meta: { ...base.meta, id: later } });
      const read = await library.getSceneRead(later);
      if (read === null) throw new Error("no scene");
      await videos.join(later, {
        videoId: record.id,
        made: {
          repo: other,
          agent: { none: "test" },
          by: { none: "test" },
          door: "mcp",
        },
        recordedRevision: read.revision,
      });
      // The premise: the newest version was recorded in the other repo.
      // Both incomplete: complete-first ordering must not decide it instead.
      const versions = await videos.versions(record.id);
      expect(versions.map((v) => v.takeId)).toEqual([first, later]);
      expect(versions.map((v) => v.complete)).toEqual([false, false]);
      expect(other.key).not.toBe(repoRef.key);
      expect((await videos.videoOf(later))?.made.repo).toMatchObject({
        root: other.root,
      });
      expect(await addable(record)).toMatchObject({ ok: true, root: repo });
    } finally {
      await rm(other.root, { recursive: true, force: true });
    }
  });

  // Red if checkoutOf drops readRepo's reason, skips a gone kept folder in
  // silence, or stops quoting the name in its command.
  it("says why each checkout failed, and quotes the name for the shell", async () => {
    const broken = await initRepo();
    try {
      const { record } = await video("Bob's flow", broken);
      // The premise: the folder stays, but is no git checkout any more.
      await rm(join(broken.root, ".git"), { recursive: true, force: true });
      const keptAt = join(home, "kept-checkout-removed");
      const out = await addable({
        ...record,
        kept: { root: keptAt, file: "x" },
      });
      expect(out).toMatchObject({ ok: false, reason: "noCheckout" });
      if (out.ok) return;
      expect(out.detail).toContain(
        `${keptAt}, where it was last added, is gone`,
      );
      expect(out.detail).toContain(
        `${broken.root} could not be read (not a git checkout`,
      );
      expect(out.detail).toContain(
        `npx demoman add 'Bob'\\''s flow' --to <path>`,
      );
    } finally {
      await rm(broken.root, { recursive: true, force: true });
    }
  });

  // Red if the default name goes back through normaliseName (DEM-50: "filter-invoice").
  it("videoSlug keeps the words as written", () => {
    expect(videoSlug("Filter invoices")).toBe("filter-invoices");
    expect(videoSlug("Create an invoice")).toBe("create-an-invoice");
    expect(videoSlug("Search — results!")).toBe("search-results");
    expect(videoSlug("!!!")).toBe("video");
  });

  // Red if notInRepo answers for a flow that has a repo key, or stops answering for one without.
  it("notInRepo answers for a keyless flow only", async () => {
    const { record } = await video("Keyless", { none: "not a git checkout" });
    expect(notInRepo(record)).toMatchObject({
      ok: false,
      reason: "noCheckout",
      label: "not in a repo",
      detail:
        '"Keyless" has no checkout to add to: it was recorded outside a git repo',
    });
    expect(
      notInRepo({ ...record, repo: { key: "github.com/a/b" } }),
    ).toBeNull();
  });

  // Red if a video with no repo is answered as a missing checkout.
  it("a video recorded with no repo is not in a repo", async () => {
    const { record } = await video("Loose", { none: "not a git checkout" });
    expect(await addable(record)).toMatchObject({
      ok: false,
      reason: "noCheckout",
      label: "not in a repo",
    });
  });

  it("reads each cache once for a listing", async () => {
    const accounts = new Map();
    const sessions: never[] = [];
    const { record } = await video("Cached", repoRef);
    await checkAddable(
      { video: record },
      { videos, library, home, git: execGit, accounts, sessions },
    );
    expect([...accounts.keys()]).toEqual([repo]);
  });

  // Red if checkAddable stops reading through deps.repos: git runs once per flow.
  it("flows in one checkout share one readRepo through deps.repos", async () => {
    const a = await video("Memo A", repoRef);
    const b = await video("Memo B", repoRef);
    let runs = 0;
    const git: typeof execGit = (args, cwd, env) => {
      runs++;
      return execGit(args, cwd, env);
    };
    await checkAddable({ video: a.record }, { videos, library, home, git });
    const alone = runs;
    expect(alone).toBeGreaterThan(0);
    runs = 0;
    const repos = new Map();
    const deps = { videos, library, home, git, repos };
    await checkAddable({ video: a.record }, deps);
    await checkAddable({ video: b.record }, deps);
    expect(runs).toBe(alone);
  });
});

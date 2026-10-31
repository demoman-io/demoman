import { chmod, mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLibrary, createVideoStore } from "@demoman/runner/studio";
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
    const none = { exports: [] };
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

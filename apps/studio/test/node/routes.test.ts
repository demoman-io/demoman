import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLibrary } from "@demoman/runner/studio";
import { pathFor } from "@demoman/studio-protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createEventHub } from "../../src/events.js";
import { ABSENT_REVISION, KITS_CHANGED_ELSEWHERE } from "../../src/kits.js";
import {
  CHANGED_ELSEWHERE,
  createRoutes,
  FRAME_CACHE,
  TAKE_BUSY,
} from "../../src/routes.js";
import { folderBytes } from "../../src/sizes.js";
import { createThumbs } from "../../src/thumbs.js";
import { type Harness, startStudio } from "./harness.js";
import { keyframeBytes, seedOutput, seedTake } from "./seed.js";

const sha256 = (bytes: string | Buffer) =>
  createHash("sha256").update(bytes).digest("hex");

const exists = (path: string) =>
  stat(path).then(
    () => true,
    () => false,
  );

/** A pid that was alive a moment ago and is not now. */
async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  const pid = child.pid as number;
  await new Promise((r) => child.on("exit", r));
  return pid;
}

let home: string;
let h: Harness;
let takeId: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "studio-routes-"));
  ({ takeId } = await seedTake(home, { status: { phase: "done", ok: true } }));
  h = await startStudio(home);
});
afterEach(async () => {
  await h.close();
  await rm(home, { recursive: true, force: true });
});

const scenePath = () => join(home, "takes", takeId, "scene.json");
const kitsPath = () => join(home, "kits.json");

describe("takes and scenes", () => {
  it("takes lists scenes, each folder's size, and each unreadable folder with its reason", async () => {
    // Red: restore the old log-and-continue for an unreadable entry; the
    // folder goes missing from `unreadable` and `sizes`.
    const second = await seedTake(home, { id: "second-take" });
    await mkdir(join(home, "takes", "broken"), { recursive: true });
    await writeFile(join(home, "takes", "broken", "scene.json"), '{"trunc');
    const r = await h.call(pathFor("takes"));
    expect(r.status).toBe(200);
    const body = r.json() as {
      scenes: { meta: { id: string } }[];
      sizes: Record<string, number>;
      unreadable: { folder: string; reason: string }[];
      unwatched: string | null;
    };
    expect(body.scenes.length).toBe(2);
    expect(body.unreadable.map((u) => u.folder)).toEqual(["broken"]);
    expect(body.unreadable[0]?.reason).toContain("remove");
    const ids = [takeId, second.takeId, "broken"];
    expect(Object.keys(body.sizes).sort()).toEqual([...ids].sort());
    for (const id of ids) {
      const expected = await folderBytes(join(home, "takes", id));
      expect(expected, `${id} measured empty`).toBeGreaterThan(0);
      expect(body.sizes[id], `size of ${id}`).toBe(expected);
    }
    expect(body.unwatched).toBeNull();
  });

  // A folder made by another user (a `sudo` run's `.busy/`) cannot be
  // opened by this one; root opens anything, so the case would measure.
  it.skipIf(process.getuid?.() === 0)(
    "a folder that cannot be measured leaves its size out, and every other take is still listed with its size",
    async () => {
      const second = await seedTake(home, { id: "second-take" });
      const locked = join(home, "takes", takeId, ".busy");
      await mkdir(locked, { recursive: true });
      await writeFile(join(locked, "lease"), "x");
      await chmod(locked, 0o000);
      try {
        // Without a live watcher. Linux's recursive fs.watch scans every
        // folder and is refused this one (EACCES), so the takes feed goes
        // down and says so — the studio's reported watchFailed, which the
        // watch tests cover. macOS's does not scan, so this case passed here
        // and failed on CI (PR #1, 2026-10-18). It is about sizes.
        await h.close();
        h = await startStudio(home, {
          watch: () => ({ on: () => undefined, close: () => undefined }),
        });
        // The premise: this folder really will not measure.
        await expect(folderBytes(join(home, "takes", takeId))).rejects.toThrow(
          /could not measure/,
        );
        const r = await h.call(pathFor("takes"));
        // Red: call folderBytes bare in the takes handler (no per-folder
        // catch) — 500 libraryUnreadable, and no take is listed at all.
        expect(r.status, r.text).toBe(200);
        const body = r.json() as {
          scenes: { meta: { id: string } }[];
          sizes: Record<string, number>;
        };
        expect(body.scenes.map((s) => s.meta.id).sort()).toEqual(
          [takeId, second.takeId].sort(),
        );
        expect(Object.keys(body.sizes)).toEqual([second.takeId]);
        expect(body.sizes[second.takeId]).toBe(
          await folderBytes(join(home, "takes", second.takeId)),
        );
        const said = h.logs.filter((l) => l.includes(locked));
        expect(said, h.logs.join("\n")).toEqual([
          expect.stringContaining(`take ${takeId}'s size is left out`),
        ]);
      } finally {
        await chmod(locked, 0o755);
      }
    },
  );

  it("a take folder with no scene.json yet is neither a scene nor unreadable", async () => {
    // Red: list such a folder as unreadable (or give it a size) and it
    // flashes as a "Couldn't read" row while a run is still writing it.
    const frames = join(home, "takes", "new", "frames");
    await mkdir(frames, { recursive: true });
    await writeFile(join(frames, "k0.jpg"), "pixels");
    const r = await h.call(pathFor("takes"));
    const body = r.json() as {
      scenes: { meta: { id: string } }[];
      sizes: Record<string, number>;
      unreadable: { folder: string }[];
    };
    expect(body.scenes.map((s) => s.meta.id)).toEqual([takeId]);
    expect(body.unreadable).toEqual([]);
    expect(Object.keys(body.sizes)).toEqual([takeId]);
  });

  it("sceneGet answers the scene and the sha256 of scene.json's bytes", async () => {
    const r = await h.call(pathFor("sceneGet", { id: takeId }));
    expect(r.status).toBe(200);
    const body = r.json() as {
      scene: { meta: { id: string } };
      revision: string;
    };
    expect(body.scene.meta.id).toBe(takeId);
    expect(body.revision).toBe(sha256(await readFile(scenePath())));
  });

  it("Review Focus 1: two PUTs with the same If-Match — 200, then 409 changedElsewhere, and the first stays on disk", async () => {
    // Red: drop the If-Match check (call putScene) — the second PUT is 200
    // and its name is on disk.
    const read = (await h
      .call(pathFor("sceneGet", { id: takeId }))
      .then((r) => r.json())) as {
      scene: { meta: { name: string } };
      revision: string;
    };
    const put = (name: string) =>
      h.call(pathFor("scenePut", { id: takeId }), {
        method: "PUT",
        headers: {
          "If-Match": read.revision,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          ...read.scene,
          meta: { ...read.scene.meta, name },
        }),
      });
    const first = await put("first window");
    expect(first.status).toBe(200);
    const firstRevision = (first.json() as { revision: string }).revision;
    expect(firstRevision).toBe(sha256(await readFile(scenePath())));
    const second = await put("second window");
    expect(second.status).toBe(409);
    expect(second.json()).toEqual({
      reason: "changedElsewhere",
      detail: CHANGED_ELSEWHERE,
    });
    expect(CHANGED_ELSEWHERE).toBe(
      "This take changed in another window. Reopen it to keep editing.",
    );
    const onDisk = JSON.parse(await readFile(scenePath(), "utf8")) as {
      meta: { name: string };
    };
    expect(onDisk.meta.name).toBe("first window");
  });

  it("two PUTs sent at once with the same If-Match: exactly one wins", async () => {
    // Red: drop the per-take chain — both read the old hash before either
    // renames, and both answer 200.
    const read = (await h
      .call(pathFor("sceneGet", { id: takeId }))
      .then((r) => r.json())) as {
      scene: { meta: { name: string } };
      revision: string;
    };
    const put = (name: string) =>
      h.call(pathFor("scenePut", { id: takeId }), {
        method: "PUT",
        headers: { "If-Match": read.revision },
        body: JSON.stringify({
          ...read.scene,
          meta: { ...read.scene.meta, name },
        }),
      });
    const answers = await Promise.all([put("a"), put("b"), put("c"), put("d")]);
    expect(answers.map((a) => a.status).sort()).toEqual([200, 409, 409, 409]);
  });

  it("a PUT with no If-Match is 428 changedElsewhere and writes nothing", async () => {
    const before = await readFile(scenePath());
    const read = (await h
      .call(pathFor("sceneGet", { id: takeId }))
      .then((r) => r.json())) as { scene: unknown };
    const r = await h.call(pathFor("scenePut", { id: takeId }), {
      method: "PUT",
      body: JSON.stringify(read.scene),
    });
    expect(r.status).toBe(428);
    expect((r.json() as { reason: string }).reason).toBe("changedElsewhere");
    expect(await readFile(scenePath())).toEqual(before);
  });

  it("a scene migrateToCurrent refuses is 400 sceneInvalid and writes nothing", async () => {
    const before = await readFile(scenePath());
    const revision = sha256(before);
    const r = await h.call(pathFor("scenePut", { id: takeId }), {
      method: "PUT",
      headers: { "If-Match": revision },
      body: JSON.stringify({ schemaVersion: 10, meta: {} }),
    });
    expect(r.status).toBe(400);
    const body = r.json() as { reason: string; detail: string };
    expect(body.reason).toBe("sceneInvalid");
    expect(body.detail).toMatch(/^The scene was not saved: /);
    expect(await readFile(scenePath())).toEqual(before);
  });

  it("a scene for another take is 400 sceneInvalid", async () => {
    const read = (await h
      .call(pathFor("sceneGet", { id: takeId }))
      .then((r) => r.json())) as { scene: { meta: object }; revision: string };
    const r = await h.call(pathFor("scenePut", { id: takeId }), {
      method: "PUT",
      headers: { "If-Match": read.revision },
      body: JSON.stringify({
        ...read.scene,
        meta: { ...read.scene.meta, id: "other" },
      }),
    });
    expect(r.status).toBe(400);
    expect((r.json() as { detail: string }).detail).toContain('"other"');
  });

  it("a PUT to a deleted take is 404 takeNotFound, not a 409", async () => {
    const read = (await h
      .call(pathFor("sceneGet", { id: takeId }))
      .then((r) => r.json())) as { scene: unknown; revision: string };
    await rm(scenePath());
    const r = await h.call(pathFor("scenePut", { id: takeId }), {
      method: "PUT",
      headers: { "If-Match": read.revision },
      body: JSON.stringify(read.scene),
    });
    expect(r.status).toBe(404);
    expect((r.json() as { reason: string }).reason).toBe("takeNotFound");
  });
});

describe("Review Focus 5: hostile paths are refused with their reason", () => {
  beforeEach(async () => {
    // What a naive join would reach from each route: the home's kits file,
    // and a file two levels above the take's frames folder.
    await writeFile(kitsPath(), '{"kits":[],"default":"SECRET-HOME"}');
    await writeFile(join(home, "takes", "kits.json"), "SECRET-TAKES");
    expect(
      await exists(
        join(home, "takes", takeId, "frames", "..", "..", "kits.json"),
      ),
    ).toBe(true);
  });

  it("a take id of ../../kits.json is 404 takeNotFound", async () => {
    // Red: drop the isTakeId check — the library throws libraryUnreadable
    // (500), not takeNotFound.
    const r = await h.call("/api/takes/..%2F..%2Fkits.json/scene");
    expect(r.status).toBe(404);
    expect((r.json() as { reason: string }).reason).toBe("takeNotFound");
    expect(r.text).not.toContain("SECRET");
  });

  it("a take id of .. is 404 takeNotFound on every take route", async () => {
    for (const path of [
      "/api/takes/%2E%2E%2F/scene",
      "/api/takes/..%2F/bundle",
      "/api/takes/..%2F/outputs",
    ]) {
      const r = await h.call(path);
      expect(r.status, path).toBe(404);
      expect((r.json() as { reason: string }).reason, path).toBe(
        "takeNotFound",
      );
    }
    const del = await h.call("/api/takes/..%2F..%2Ftakes", {
      method: "DELETE",
    });
    expect(del.status).toBe(404);
    expect(await exists(join(home, "takes", takeId))).toBe(true);
  });

  it("a take id of .. itself is takeNotFound at every take handler", async () => {
    // Through HTTP a bare `..` segment never arrives: URL parsing collapses
    // `/api/takes/../scene` (and `%2E%2E`) before the router sees it. So the
    // handlers are asked directly, as a second door would.
    const library = createLibrary(home);
    const routes = createRoutes({
      home,
      library,
      thumbs: createThumbs({ library, make: async () => {} }),
      events: createEventHub({ log: () => {} }),
      log: () => {},
      version: "0",
      queued: () => 0,
      feeds: {
        unwatched: () => ({ takes: null, kits: null }),
        kitsWritten: async () => {},
        close: () => {},
      },
      reveal: async () => {},
    });
    const req = (params: Record<string, string>) => ({
      method: "GET",
      params,
      query: new URLSearchParams(),
      headers: {},
      body: async () => Buffer.from("{}"),
      raw: undefined as never,
    });
    for (const id of ["..", ".", "", ".trash-x"]) {
      for (const route of [
        "sceneGet",
        "scenePut",
        "takeDelete",
        "bundle",
        "frame",
        "thumb",
        "outputs",
      ] as const) {
        const r = await routes[route](req({ id, ref: `kf:${takeId}:0` }));
        const body = "json" in r ? (r.json as { reason?: string }) : null;
        // scenePut answers 404 before it reads If-Match or the body.
        expect(body?.reason, `${route} "${id}"`).toBe("takeNotFound");
      }
    }
    expect(await exists(join(home, "takes", takeId))).toBe(true);
  });

  it("a frame ref of ../../kits.json is 404 frameNotFound", async () => {
    // Red: serve `readFile(join(store.root, ref))` instead of the refs()
    // allow-list — the answer is 200 SECRET-TAKES.
    const r = await h.call(`/api/takes/${takeId}/frames/..%2F..%2Fkits.json`);
    expect(r.status).toBe(404);
    expect((r.json() as { reason: string }).reason).toBe("frameNotFound");
    expect(r.text).not.toContain("SECRET");
  });

  it("reveal of /etc/hosts is 403 revealRefused, and nothing is opened", async () => {
    // Red: reveal any path (skip listedOutput) — 200 and /etc/hosts opened.
    await seedOutput(home, takeId, join(home, "listed.mp4"));
    const r = await h.call(pathFor("reveal"), {
      method: "POST",
      body: JSON.stringify({ path: "/etc/hosts" }),
    });
    expect(r.status).toBe(403);
    expect((r.json() as { reason: string }).reason).toBe("revealRefused");
    expect(h.revealed).toEqual([]);
  });
});

describe("delete", () => {
  it("a save racing a delete never answers 200 over a take the delete removed", async () => {
    // Red: take the delete out of the per-take chain — a PUT renames
    // scene.json into a re-created `takes/<id>/` after the folder moved to
    // .trash-*, answers 200, and leaves a frameless ghost take.
    const ROUNDS = 40;
    const outcomes: string[] = [];
    const ghosts: string[] = [];
    for (let i = 0; i < ROUNDS; i++) {
      const { takeId: id } = await seedTake(home, { id: `race-${i}` });
      const read = (await h
        .call(pathFor("sceneGet", { id }))
        .then((r) => r.json())) as {
        scene: { meta: object };
        revision: string;
      };
      const sendPut = () =>
        h.call(pathFor("scenePut", { id }), {
          method: "PUT",
          headers: { "If-Match": read.revision },
          body: JSON.stringify({
            ...read.scene,
            meta: { ...read.scene.meta, name: "racing save" },
          }),
        });
      const sendDelete = () =>
        h.call(pathFor("takeDelete", { id }), { method: "DELETE" });
      // Alternate which is sent first, so each order gets its rounds.
      const [put, del] =
        i % 2 === 0
          ? await Promise.all([sendPut(), sendDelete()])
          : await Promise.all([sendDelete(), sendPut()]).then(
              ([d, p]) => [p, d] as const,
            );
      // Premise: the delete itself went through every round.
      expect(del.status, `round ${i}: ${del.text}`).toBe(200);
      outcomes.push(`${put.status}`);
      if (await exists(join(home, "takes", id))) {
        ghosts.push(`round ${i}: PUT ${put.status} ${put.text}`);
      }
      // Either order is fine: PUT first (200, then deleted) or delete
      // first (404). Nothing else.
      expect([200, 404], `round ${i}: ${put.text}`).toContain(put.status);
    }
    expect(
      ghosts,
      `ghost takes after a 200 delete:\n${ghosts.join("\n")}`,
    ).toEqual([]);
    // Premise: the two requests really were in flight together, so both
    // orders occurred across the rounds rather than one order every time.
    expect(new Set(outcomes).size, `PUT outcomes: ${outcomes.join(",")}`).toBe(
      2,
    );
  });

  it("a live export lease is 409 takeBusy, naming the agent", async () => {
    const lease = await createLibrary(home).lease(takeId, {
      op: "export",
      door: "agent",
      jobId: "job-1",
    });
    try {
      const r = await h.call(pathFor("takeDelete", { id: takeId }), {
        method: "DELETE",
      });
      expect(r.status).toBe(409);
      expect(r.json()).toEqual({ reason: "takeBusy", detail: TAKE_BUSY.agent });
      expect(TAKE_BUSY.agent).toBe("This take is being exported by an agent.");
      expect(await exists(scenePath())).toBe(true);
    } finally {
      await lease.release();
    }
  });

  it("…and the studio, by the first live holder's door", async () => {
    const lease = await createLibrary(home).lease(takeId, {
      op: "export",
      door: "studio",
      jobId: "job-2",
    });
    try {
      const r = await h.call(pathFor("takeDelete", { id: takeId }), {
        method: "DELETE",
      });
      expect(r.json()).toEqual({
        reason: "takeBusy",
        detail: TAKE_BUSY.studio,
      });
      expect(TAKE_BUSY.studio).toBe(
        "This take is being exported by the studio.",
      );
    } finally {
      await lease.release();
    }
  });

  it("a take that is not there is 404 takeNotFound", async () => {
    const r = await h.call(pathFor("takeDelete", { id: "nope" }), {
      method: "DELETE",
    });
    expect(r.status).toBe(404);
    expect((r.json() as { reason: string }).reason).toBe("takeNotFound");
  });

  it("a delete answers note null and the take is gone", async () => {
    const r = await h.call(pathFor("takeDelete", { id: takeId }), {
      method: "DELETE",
    });
    expect(r.status).toBe(200);
    expect(r.json()).toEqual({ note: null });
    expect(await exists(join(home, "takes", takeId))).toBe(false);
  });

  it("a dead lease is cleared and the note names its process", async () => {
    // Red: drop clearedLeases from the note — `note` is null.
    const pid = await deadPid();
    const busy = join(home, "takes", takeId, ".busy");
    await mkdir(busy, { recursive: true });
    await writeFile(
      join(busy, `${pid}-job-x.json`),
      JSON.stringify({
        pid,
        op: "export",
        door: "studio",
        jobId: "job-x",
        startedAt: "2026-10-16T00:00:00.000Z",
      }),
    );
    const r = await h.call(pathFor("takeDelete", { id: takeId }), {
      method: "DELETE",
    });
    expect(r.status).toBe(200);
    expect(r.json()).toEqual({
      note: `Cleared a stale export lock left by process ${pid}.`,
    });
    expect(await exists(join(home, "takes", takeId))).toBe(false);
  });
});

describe("bundle, frames, outputs", () => {
  it("bundle answers the stored bundle, status.json as replay, capture null", async () => {
    const { bundle } = await seedTake(home, {
      status: { phase: "done", ok: true },
    });
    const r = await h.call(pathFor("bundle", { id: takeId }));
    expect(r.status).toBe(200);
    expect(r.json()).toEqual({
      bundle,
      replay: { phase: "done", ok: true },
      capture: null,
    });
  });

  it("a take with no bundle is bundle: null, not a 404", async () => {
    await createLibrary(home).frameStore(takeId).deleteBundle(takeId);
    const r = await h.call(pathFor("bundle", { id: takeId }));
    expect(r.status).toBe(200);
    expect((r.json() as { bundle: unknown }).bundle).toBeNull();
  });

  it("an unknown take's bundle is 404 takeNotFound, never bundle: null", async () => {
    // Red: drop takeExists — the answer is 200 { bundle: null } ("no frames yet").
    const r = await h.call(pathFor("bundle", { id: "nope" }));
    expect(r.status).toBe(404);
    expect((r.json() as { reason: string }).reason).toBe("takeNotFound");
  });

  it("frame serves a listed ref's bytes, immutable, as octet-stream", async () => {
    const r = await h.call(
      pathFor("frame", { id: takeId, ref: `kf:${takeId}:1` }),
    );
    expect(r.status).toBe(200);
    expect(r.headers["content-type"]).toBe("application/octet-stream");
    expect(r.headers["cache-control"]).toBe(FRAME_CACHE);
    expect(FRAME_CACHE).toBe("private, max-age=31536000, immutable");
    expect(new Uint8Array(r.bytes)).toEqual(keyframeBytes(1));
  });

  it("a ref the take does not hold is 404 frameNotFound", async () => {
    const r = await h.call(pathFor("frame", { id: takeId, ref: "kf:x:9" }));
    expect(r.status).toBe(404);
    expect((r.json() as { reason: string }).reason).toBe("frameNotFound");
  });

  it("outputs lists outputs.json's rows with exists checked now", async () => {
    const kept = join(home, "kept.mp4");
    await writeFile(kept, "x");
    await seedOutput(home, takeId, kept);
    await seedOutput(home, takeId, join(home, "gone.mp4"));
    const r = await h.call(pathFor("outputs", { id: takeId }));
    expect(r.status).toBe(200);
    const { outputs } = r.json() as {
      outputs: { path: string; exists: boolean }[];
    };
    expect(outputs.map((o) => [o.path, o.exists])).toEqual([
      [kept, true],
      [join(home, "gone.mp4"), false],
    ]);
  });

  it("an unreadable outputs.json is 500 libraryUnreadable naming the file, never []", async () => {
    const file = join(home, "takes", takeId, "outputs.json");
    await writeFile(file, "{");
    const r = await h.call(pathFor("outputs", { id: takeId }));
    expect(r.status).toBe(500);
    const body = r.json() as { reason: string; detail: string };
    expect(body.reason).toBe("libraryUnreadable");
    expect(body.detail).toContain(file);
  });
});

describe("kits", () => {
  it("no kits.json reads as the empty list at revision absent", async () => {
    const r = await h.call(pathFor("kitsGet"));
    expect(r.status).toBe(200);
    expect(r.json()).toEqual({
      stored: { kits: [], default: null },
      revision: ABSENT_REVISION,
      unwatched: null,
    });
  });

  it("kits.json reads as stored, at the sha256 of its bytes", async () => {
    const text = JSON.stringify({
      kits: [{ id: "k1", name: "Acme", branding: {} }],
      default: "k1",
    });
    await writeFile(kitsPath(), text);
    const r = await h.call(pathFor("kitsGet"));
    expect(r.json()).toEqual({
      stored: {
        kits: [{ id: "k1", name: "Acme", branding: {} }],
        default: "k1",
      },
      revision: sha256(text),
      unwatched: null,
    });
  });

  it("a file coerceBrandKits calls invalid answers 200 { invalid: { reason } }", async () => {
    await writeFile(kitsPath(), JSON.stringify({ kits: [{ name: "no id" }] }));
    const r = await h.call(pathFor("kitsGet"));
    expect(r.status).toBe(200);
    const body = r.json() as { invalid: { reason: string }; stored?: unknown };
    expect(body.invalid.reason).toContain("kit 1: it has no id");
    expect(body.stored).toBeUndefined();
  });

  it("PUT with the current revision writes the file, answers its revision and sends kits", async () => {
    const events = await h.stream();
    try {
      const body = {
        kits: [{ id: "k1", name: "Acme", branding: {} }],
        default: "k1",
      };
      const r = await h.call(pathFor("kitsPut"), {
        method: "PUT",
        headers: { "If-Match": ABSENT_REVISION },
        body: JSON.stringify(body),
      });
      expect(r.status).toBe(200);
      const onDisk = await readFile(kitsPath());
      expect(JSON.parse(onDisk.toString("utf8"))).toEqual(body);
      expect(r.json()).toEqual({ revision: sha256(onDisk) });
      await events.waitFor((t) =>
        t.includes('event: kits\ndata: {"type":"kits"}\n\n'),
      );
    } finally {
      events.close();
    }
  });

  it("PUT with a stale revision is 409 changedElsewhere and leaves the file", async () => {
    // Red: drop the revision compare — 200, and the file is replaced.
    const text = JSON.stringify({ kits: [], default: null });
    await writeFile(kitsPath(), text);
    const r = await h.call(pathFor("kitsPut"), {
      method: "PUT",
      headers: { "If-Match": "stale" },
      body: JSON.stringify({
        kits: [{ id: "k", name: "K", branding: {} }],
        default: "k",
      }),
    });
    expect(r.status).toBe(409);
    expect(r.json()).toEqual({
      reason: "changedElsewhere",
      detail: KITS_CHANGED_ELSEWHERE,
    });
    expect(await readFile(kitsPath(), "utf8")).toBe(text);
  });

  it("PUT of a list coerceBrandKits refuses is 400 kitsInvalid", async () => {
    const r = await h.call(pathFor("kitsPut"), {
      method: "PUT",
      headers: { "If-Match": ABSENT_REVISION },
      body: JSON.stringify({ kits: "nope", default: null }),
    });
    expect(r.status).toBe(400);
    const body = r.json() as { reason: string; detail: string };
    expect(body.reason).toBe("kitsInvalid");
    expect(body.detail).toContain("the kit list is not a list");
    expect(await exists(kitsPath())).toBe(false);
  });

  it("PUT with no If-Match is 428 changedElsewhere", async () => {
    const r = await h.call(pathFor("kitsPut"), {
      method: "PUT",
      body: JSON.stringify({ kits: [], default: null }),
    });
    expect(r.status).toBe(428);
    expect((r.json() as { reason: string }).reason).toBe("changedElsewhere");
  });

  it("reset keeps the old file as kits.json.bak-<n>, writes the empty list and names the backup", async () => {
    const old = "{ not json";
    await writeFile(kitsPath(), old);
    const r = await h.call(pathFor("kitsReset"), { method: "POST" });
    expect(r.status).toBe(200);
    const { backup } = r.json() as { backup: string };
    expect(backup).toMatch(/kits\.json\.bak-\d+$/);
    expect(await readFile(backup, "utf8")).toBe(old);
    expect(JSON.parse(await readFile(kitsPath(), "utf8"))).toEqual({
      kits: [],
      default: null,
    });
    expect(
      (await readdir(home)).filter((n) => n.startsWith("kits.json.bak-")),
    ).toHaveLength(1);
  });
});

describe("logos", () => {
  const PNG = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2,
  ]);

  it("assetPut writes assets/<uuid>.png and logo?ref= serves it back", async () => {
    const r = await h.call(pathFor("assetPut"), {
      method: "POST",
      headers: {
        "X-File-Name": encodeURIComponent("logo ü.png"),
        "Content-Type": "image/png",
      },
      body: PNG,
    });
    expect(r.status).toBe(200);
    const { ref } = r.json() as { ref: string };
    expect(ref).toMatch(/^assets\/[0-9a-f-]{36}\.png$/);
    expect(await readFile(join(home, ref))).toEqual(PNG);
    const back = await h.call(
      `${pathFor("logo")}?ref=${encodeURIComponent(ref)}`,
    );
    expect(back.status).toBe(200);
    expect(back.headers["content-type"]).toBe("image/png");
    expect(back.bytes).toEqual(PNG);
  });

  it("an upload checkLogoFile refuses is 400 logoRefused with its reason, and nothing is written", async () => {
    const r = await h.call(pathFor("assetPut"), {
      method: "POST",
      headers: { "X-File-Name": "notes.txt", "Content-Type": "text/plain" },
      body: "hello",
    });
    expect(r.status).toBe(400);
    expect(r.json()).toEqual({
      reason: "logoRefused",
      detail:
        'The logo "notes.txt" is a text/plain file — use SVG, PNG, WebP or JPEG',
    });
    expect(await exists(join(home, "assets"))).toBe(false);
  });

  it("a logo readLogo refuses is 422 logoRefused with readLogo's sentence", async () => {
    const r = await h.call(
      `${pathFor("logo")}?ref=${encodeURIComponent("logo:abc")}`,
    );
    expect(r.status).toBe(422);
    const body = r.json() as { reason: string; detail: string };
    expect(body.reason).toBe("logoRefused");
    expect(body.detail).toContain(
      `its ref "logo:abc" names a logo in the extension's own storage`,
    );
  });
});

describe("no theme in the studio", () => {
  // Dark only (spec 2026-10-19 §6): the route and the setting are gone, so
  // nothing answers "saved" to a theme that would change nothing. Red: put
  // themeGet/themePut back in the route table.
  it("GET and PUT /api/settings/theme answer as any unknown route does", async () => {
    const unknown = await h.call("/api/settings/no-such-setting");
    expect(unknown.status).toBe(404);
    const get = await h.call("/api/settings/theme");
    const put = await h.call("/api/settings/theme", {
      method: "PUT",
      body: JSON.stringify({ theme: "light" }),
    });
    for (const r of [get, put]) {
      expect(r.status).toBe(404);
      expect(r.json()).toEqual(unknown.json());
    }
  });

  it("a theme key an older studio left in settings.json is kept by other saves", async () => {
    await writeFile(
      join(home, "settings.json"),
      JSON.stringify({ theme: "light" }),
    );
    const put = await h.call(pathFor("pullRequestsPut"), {
      method: "PUT",
      body: JSON.stringify({ value: "ask" }),
    });
    expect(put.status, put.text).toBe(200);
    expect(
      JSON.parse(await readFile(join(home, "settings.json"), "utf8")),
    ).toEqual({ theme: "light", pullRequests: "ask" });
  });
});

describe("settings writes", () => {
  // Red without the serialising chain: both PUTs read the file before either
  // writes, and the later write drops the earlier one's key.
  it("an Export quality PUT and a Pull requests PUT fired together both survive", async () => {
    await writeFile(
      join(home, "settings.json"),
      JSON.stringify({ theme: "dark" }),
    );
    for (let round = 0; round < 10; round++) {
      const quality = round % 2 === 0 ? "full" : "share";
      const choice = round % 2 === 0 ? "attach" : "ask";
      const [a, b] = await Promise.all([
        h.call(pathFor("exportQualityPut"), {
          method: "PUT",
          body: JSON.stringify({ exportQuality: quality }),
        }),
        h.call(pathFor("pullRequestsPut"), {
          method: "PUT",
          body: JSON.stringify({ value: choice }),
        }),
      ]);
      expect([a.status, b.status], `round ${round}`).toEqual([200, 200]);
      expect(
        JSON.parse(await readFile(join(home, "settings.json"), "utf8")),
        `round ${round}`,
      ).toEqual({
        theme: "dark",
        exportQuality: quality,
        pullRequests: choice,
      });
    }
  });
});

describe("pullRequests", () => {
  it("no settings.json reads null, and an unreadable one says why", async () => {
    expect((await h.call(pathFor("pullRequestsGet"))).json()).toEqual({
      value: null,
    });
    await writeFile(join(home, "settings.json"), "{");
    const body = (await h.call(pathFor("pullRequestsGet"))).json() as {
      value: unknown;
      unreadable: string;
    };
    expect(body.value).toBeNull();
    expect(body.unreadable).toContain("settings.json is not valid JSON");
  });

  it("a PUT keeps theme and the other keys of the file", async () => {
    await writeFile(
      join(home, "settings.json"),
      JSON.stringify({ theme: "dark", exportQuality: "high" }),
    );
    const r = await h.call(pathFor("pullRequestsPut"), {
      method: "PUT",
      body: JSON.stringify({ value: "attach" }),
    });
    expect(r.status, r.text).toBe(200);
    expect(r.json()).toEqual({ value: "attach" });
    expect(
      JSON.parse(await readFile(join(home, "settings.json"), "utf8")),
    ).toEqual({ theme: "dark", exportQuality: "high", pullRequests: "attach" });
    expect((await h.call(pathFor("pullRequestsGet"))).json()).toEqual({
      value: "attach",
    });
  });

  it("a bad value is refused as pullRequestsInvalid and writes nothing", async () => {
    const r = await h.call(pathFor("pullRequestsPut"), {
      method: "PUT",
      body: JSON.stringify({ value: "always" }),
    });
    expect(r.status).toBe(400);
    expect((r.json() as { reason: string }).reason).toBe("pullRequestsInvalid");
    expect(await exists(join(home, "settings.json"))).toBe(false);
  });

  it("a PUT over a file that is not JSON replaces it and says its other settings were not kept", async () => {
    await writeFile(join(home, "settings.json"), "{");
    const r = await h.call(pathFor("pullRequestsPut"), {
      method: "PUT",
      body: JSON.stringify({ value: "ask" }),
    });
    expect(r.status, r.text).toBe(200);
    const answer = r.json() as { value: string; replaced?: string };
    expect(answer.value).toBe("ask");
    expect(answer.replaced).toContain("settings.json");
    expect(answer.replaced).toContain("not valid JSON");
    expect(answer.replaced).toContain("other settings were not kept");
    expect(
      JSON.parse(await readFile(join(home, "settings.json"), "utf8")),
    ).toEqual({ pullRequests: "ask" });
  });

  it("a PUT over a readable file does not claim to have replaced anything", async () => {
    await writeFile(join(home, "settings.json"), '{"theme":"dark"}');
    const r = await h.call(pathFor("pullRequestsPut"), {
      method: "PUT",
      body: JSON.stringify({ value: "ask" }),
    });
    expect(r.json()).toEqual({ value: "ask" });
  });

  it.skipIf(process.getuid?.() === 0)(
    "a PUT over a file that cannot be read is studioUnwritable and leaves it alone",
    async () => {
      const file = join(home, "settings.json");
      await writeFile(file, '{"theme":"dark"}');
      await chmod(file, 0o000);
      try {
        const r = await h.call(pathFor("pullRequestsPut"), {
          method: "PUT",
          body: JSON.stringify({ value: "ask" }),
        });
        expect(r.status).toBe(500);
        const refusal = r.json() as { reason: string; detail: string };
        expect(refusal.reason).toBe("studioUnwritable");
        expect(refusal.detail).toContain("settings.json");
        await chmod(file, 0o644);
        expect(await readFile(file, "utf8")).toBe('{"theme":"dark"}');
      } finally {
        await chmod(file, 0o644);
      }
    },
  );

  it("a body that is not JSON is refused as pullRequestsInvalid", async () => {
    const r = await h.call(pathFor("pullRequestsPut"), {
      method: "PUT",
      body: "{",
    });
    expect(r.status).toBe(400);
    expect((r.json() as { reason: string }).reason).toBe("pullRequestsInvalid");
  });
});

describe("exportQuality", () => {
  it("no settings.json reads share, and an unreadable one says why (still share)", async () => {
    expect((await h.call(pathFor("exportQualityGet"))).json()).toEqual({
      exportQuality: "share",
    });
    await writeFile(join(home, "settings.json"), "{");
    const body = (await h.call(pathFor("exportQualityGet"))).json() as {
      exportQuality: string;
      unreadable: string;
    };
    expect(body.exportQuality).toBe("share");
    expect(body.unreadable).toContain("settings.json is not valid JSON");
  });

  it("a bad stored value reads share and names the key and the choices", async () => {
    await writeFile(join(home, "settings.json"), '{"exportQuality":"high"}');
    const body = (await h.call(pathFor("exportQualityGet"))).json() as {
      exportQuality: string;
      unreadable: string;
    };
    expect(body.exportQuality).toBe("share");
    expect(body.unreadable).toContain("share or full");
  });

  it("a PUT keeps the other keys of the file, and a GET reads it back", async () => {
    await writeFile(
      join(home, "settings.json"),
      JSON.stringify({ theme: "dark", pullRequests: "ask" }),
    );
    const r = await h.call(pathFor("exportQualityPut"), {
      method: "PUT",
      body: JSON.stringify({ exportQuality: "full" }),
    });
    expect(r.status, r.text).toBe(200);
    expect(r.json()).toEqual({ exportQuality: "full" });
    expect(
      JSON.parse(await readFile(join(home, "settings.json"), "utf8")),
    ).toEqual({ theme: "dark", pullRequests: "ask", exportQuality: "full" });
    expect((await h.call(pathFor("exportQualityGet"))).json()).toEqual({
      exportQuality: "full",
    });
  });

  it("a bad value is refused as exportQualityInvalid and writes nothing", async () => {
    const r = await h.call(pathFor("exportQualityPut"), {
      method: "PUT",
      body: JSON.stringify({ exportQuality: "high" }),
    });
    expect(r.status).toBe(400);
    expect((r.json() as { reason: string }).reason).toBe(
      "exportQualityInvalid",
    );
    expect(await exists(join(home, "settings.json"))).toBe(false);
  });

  it("a PUT over a file that is not JSON replaces it and says so", async () => {
    await writeFile(join(home, "settings.json"), "{");
    const r = await h.call(pathFor("exportQualityPut"), {
      method: "PUT",
      body: JSON.stringify({ exportQuality: "share" }),
    });
    expect(r.status, r.text).toBe(200);
    const answer = r.json() as { exportQuality: string; replaced?: string };
    expect(answer.exportQuality).toBe("share");
    expect(answer.replaced).toContain("other settings were not kept");
  });

  it("a body that is not JSON is refused as exportQualityInvalid", async () => {
    const r = await h.call(pathFor("exportQualityPut"), {
      method: "PUT",
      body: "{",
    });
    expect(r.status).toBe(400);
    expect((r.json() as { reason: string }).reason).toBe(
      "exportQualityInvalid",
    );
  });
});

describe("reveal", () => {
  it("a path an outputs.json lists is shown", async () => {
    const file = join(home, "out.mp4");
    await writeFile(file, "x");
    await seedOutput(home, takeId, file);
    const r = await h.call(pathFor("reveal"), {
      method: "POST",
      body: JSON.stringify({ path: file }),
    });
    expect(r.status).toBe(200);
    expect(h.revealed).toEqual([file]);
  });

  it("a listed path whose file is gone is 404 revealRefused, moved or deleted", async () => {
    const file = join(home, "gone.mp4");
    await seedOutput(home, takeId, file);
    const r = await h.call(pathFor("reveal"), {
      method: "POST",
      body: JSON.stringify({ path: file }),
    });
    expect(r.status).toBe(404);
    expect((r.json() as { detail: string }).detail).toContain(
      "moved or deleted",
    );
    expect(h.revealed).toEqual([]);
  });

  it("open failing is 500 revealRefused with its words, not a 200", async () => {
    await h.close();
    h = await startStudio(home, { revealFails: "Finder said no" });
    const file = join(home, "out.mp4");
    await writeFile(file, "x");
    await seedOutput(home, takeId, file);
    const r = await h.call(pathFor("reveal"), {
      method: "POST",
      body: JSON.stringify({ path: file }),
    });
    expect(r.status).toBe(500);
    const body = r.json() as { reason: string; detail: string };
    expect(body.reason).toBe("revealRefused");
    expect(body.detail).toContain("Finder said no");
  });
});

describe("events", () => {
  it("a stream opens as text/event-stream and leaves the hub when the page goes", async () => {
    expect(h.hub.size()).toBe(0);
    const events = await h.stream();
    await events.waitFor((t) => t.startsWith(": connected\n\n"));
    expect(h.hub.size()).toBe(1);
    events.close();
    await expect.poll(() => h.hub.size(), { timeout: 5_000 }).toBe(0);
  });

  it("every connected page hears each event", async () => {
    const a = await h.stream();
    const b = await h.stream();
    try {
      h.hub.send({ type: "server:stopping" });
      const frame =
        'event: server:stopping\ndata: {"type":"server:stopping"}\n\n';
      await a.waitFor((t) => t.includes(frame));
      await b.waitFor((t) => t.includes(frame));
    } finally {
      a.close();
      b.close();
    }
  });
});

describe("ping", () => {
  it("answers version, pid and the queue's size", async () => {
    const r = await h.call(pathFor("ping"));
    expect(r.json()).toEqual({
      version: "0.0.0-test",
      pid: process.pid,
      queued: 0,
    });
  });
});

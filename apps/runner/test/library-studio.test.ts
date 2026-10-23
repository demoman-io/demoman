import { spawn } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExportAnswer, OutputRecord } from "@demoman/run-core";
import type { SceneDocument } from "@demoman/scene-schema";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createLibrary, LibraryError } from "../src/executor/library.js";
import { readOnlySceneJson } from "./fixtures/scene.js";

let home: string;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "demoman-lib-studio-"));
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

const scene = () => structuredClone(readOnlySceneJson()) as SceneDocument;

const row = (path: string, n = 0): OutputRecord => ({
  path,
  fileType: "mp4",
  aspect: "16:9",
  byteLength: n,
  renderedAt: new Date(0).toISOString(),
  sceneDigest: `digest-${n}`,
  report: { outcome: "saved", summary: "saved" } as unknown as ExportAnswer,
});

const exists = (path: string) =>
  stat(path).then(
    () => true,
    () => false,
  );

describe("library: revisions, leases, delete, outputs", () => {
  it("getSceneRead's revision follows scene.json, and a timestamp name reads untitled", async () => {
    const lib = createLibrary(home);
    const doc = scene();
    doc.meta.name = new Date(doc.meta.createdAt).toLocaleString();
    await lib.putScene(doc);
    const file = join(lib.takeDir(doc.meta.id), "scene.json");
    // The premise: the name on disk is the timestamp the take was given.
    expect(JSON.parse(await readFile(file, "utf8")).meta.name).toBe(
      doc.meta.name,
    );
    expect(doc.meta.name).not.toBe("");

    const first = await lib.getSceneRead(doc.meta.id);
    expect(first?.scene.meta.name).toBe("");
    expect((await lib.getScene(doc.meta.id))?.meta.name).toBe("");

    await lib.putScene({ ...doc, meta: { ...doc.meta, name: "Renamed" } });
    const second = await lib.getSceneRead(doc.meta.id);
    expect(second?.revision).toMatch(/^[0-9a-f]{64}$/);
    expect(second?.revision).not.toBe(first?.revision);
    expect(await lib.getSceneRead("nope")).toBeNull();
  });

  it("putSceneIf with a stale revision answers current and leaves the file alone", async () => {
    const lib = createLibrary(home);
    const doc = scene();
    await lib.putScene(doc);
    const file = join(lib.takeDir(doc.meta.id), "scene.json");
    const before = await readFile(file);
    const read = await lib.getSceneRead(doc.meta.id);
    const edited = { ...doc, meta: { ...doc.meta, name: "Edited" } };

    const stale = await lib.putSceneIf(edited, "0".repeat(64));
    expect(stale).toEqual({ ok: false, current: read?.revision });
    expect((await readFile(file)).equals(before)).toBe(true);

    const fresh = await lib.putSceneIf(edited, read?.revision ?? "");
    expect(fresh.ok).toBe(true);
    expect((await lib.getScene(doc.meta.id))?.meta.name).toBe("Edited");
    if (fresh.ok) {
      expect((await lib.getSceneRead(doc.meta.id))?.revision).toBe(
        fresh.revision,
      );
    }
  });

  it("a live lease makes deleteTake answer holders and keeps the folder", async () => {
    const lib = createLibrary(home);
    const doc = scene();
    await lib.putScene(doc);
    const lease = await lib.lease(doc.meta.id, {
      op: "export",
      door: "studio",
      jobId: "j1",
    });
    const answer = await lib.deleteTake(doc.meta.id);
    expect(answer).toMatchObject({
      ok: false,
      holders: [{ door: "studio", pid: process.pid, jobId: "j1" }],
    });
    expect(await exists(lib.takeDir(doc.meta.id))).toBe(true);

    await lease.release();
    expect(await lib.deleteTake(doc.meta.id)).toMatchObject({ ok: true });
  });

  it("a lease whose pid is dead is cleared and the take is deleted", async () => {
    const lib = createLibrary(home);
    const doc = scene();
    await lib.putScene(doc);
    const child = spawn(process.execPath, ["-e", ""]);
    const dead = child.pid ?? 0;
    await new Promise((r) => child.on("exit", r));
    expect(dead).toBeGreaterThan(0);
    const dir = join(lib.takeDir(doc.meta.id), ".busy");
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, `${dead}-j0.json`),
      JSON.stringify({
        pid: dead,
        op: "export",
        door: "agent",
        jobId: "j0",
        startedAt: new Date().toISOString(),
      }),
    );
    const answer = await lib.deleteTake(doc.meta.id);
    expect(answer).toMatchObject({ ok: true, leftBehind: null });
    if (answer.ok) expect(answer.clearedLeases).toHaveLength(1);
    expect(await exists(lib.takeDir(doc.meta.id))).toBe(false);
    expect(await lib.deleteTake(doc.meta.id)).toEqual({
      ok: false,
      missing: true,
    });
  });

  it("list() does not show a .trash folder, and no dot name is a take id", async () => {
    const lib = createLibrary(home);
    const doc = scene();
    await lib.putScene(doc);
    const trash = join(lib.root, ".trash-x-1");
    await mkdir(trash, { recursive: true });
    await writeFile(join(trash, "scene.json"), JSON.stringify(doc));
    // The premise: the trash folder is a readable take in every way but its name.
    expect(await exists(join(trash, "scene.json"))).toBe(true);
    const listed = await lib.list();
    expect(listed.map((e) => e.id)).toEqual([doc.meta.id]);
    expect(lib.isTakeId(".trash-x-1")).toBe(false);
  });

  it("forty appendOutput calls from two processes keep forty rows", async () => {
    const lib = createLibrary(home);
    const doc = scene();
    await lib.putScene(doc);
    const id = doc.meta.id;
    const here = dirname(fileURLToPath(import.meta.url));
    const libraryJs = resolve(here, "../dist/executor/library.js");
    const script = `
      const { createLibrary } = await import(${JSON.stringify(libraryJs)});
      const lib = createLibrary(${JSON.stringify(home)});
      const row = (n) => ({ path: "/child/" + n, fileType: "mp4", aspect: "16:9", byteLength: n, renderedAt: "x", sceneDigest: "c", report: {} });
      console.log("ready");
      await Promise.all(Array.from({ length: 20 }, (_, n) => lib.appendOutput(${JSON.stringify(id)}, row(n))));
    `;
    const child = spawn(process.execPath, [
      "--input-type=module",
      "-e",
      script,
    ]);
    let stderr = "";
    child.stderr.on("data", (d) => {
      stderr += d;
    });
    const ready = new Promise<void>((resolveReady) => {
      child.stdout.on("data", (d) => {
        if (String(d).includes("ready")) resolveReady();
      });
    });
    const childDone = new Promise<number | null>((r) => child.on("exit", r));
    // Start only once the child has imported the library, so the two
    // processes' appends overlap rather than run back to back.
    await Promise.race([
      ready,
      childDone.then((code) => {
        throw new Error(`child exited ${code} before ready: ${stderr}`);
      }),
    ]);
    await Promise.all(
      Array.from({ length: 20 }, (_, n) =>
        lib.appendOutput(id, row(`/me/${n}`, n)),
      ),
    );
    expect(await childDone, `child stderr: ${stderr}`).toBe(0);
    const rows = JSON.parse(
      await readFile(join(lib.takeDir(id), "outputs.json"), "utf8"),
    ) as OutputRecord[];
    expect(rows.filter((r) => r.path.startsWith("/child/"))).toHaveLength(20);
    expect(rows.filter((r) => r.path.startsWith("/me/"))).toHaveLength(20);
    expect(rows).toHaveLength(40);
    // The premise: the writers interleaved. A child row lands before the
    // last parent row, so neither process simply ran after the other.
    const firstChild = rows.findIndex((r) => r.path.startsWith("/child/"));
    const lastMine = rows
      .map((r) => r.path.startsWith("/me/"))
      .lastIndexOf(true);
    expect(firstChild).toBeGreaterThanOrEqual(0);
    expect(firstChild).toBeLessThan(lastMine);
    expect(await exists(join(lib.takeDir(id), "outputs.json.lock"))).toBe(
      false,
    );
  }, 30_000);

  it("outputs() marks a deleted file, and an unparsable list throws", async () => {
    const lib = createLibrary(home);
    const doc = scene();
    await lib.putScene(doc);
    const id = doc.meta.id;
    expect(await lib.outputs(id)).toEqual([]);
    const kept = join(home, "kept.mp4");
    await writeFile(kept, "x");
    await lib.appendOutput(id, row(kept, 1));
    await lib.appendOutput(id, row(join(home, "gone.mp4"), 2));
    const listed = await lib.outputs(id);
    expect(listed.map((l) => l.exists)).toEqual([true, false]);

    await writeFile(join(lib.takeDir(id), "outputs.json"), "{");
    const failure = await lib.outputs(id).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(LibraryError);
    expect((failure as LibraryError).reason).toBe("libraryUnreadable");
    expect((failure as LibraryError).message).toContain("outputs.json");
  });
});

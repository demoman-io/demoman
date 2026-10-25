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
import {
  CURRENT_SCHEMA_VERSION,
  type SceneDocument,
} from "@demoman/scene-schema";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createLibrary,
  LibraryError,
  ownHome,
} from "../src/executor/library.js";
import { readOnlySceneJson } from "./fixtures/scene.js";

let home: string;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "demoman-lib-"));
});
afterEach(async () => {
  await chmod(home, 0o700).catch(() => undefined);
  await rm(home, { recursive: true, force: true });
});

const scene = () => structuredClone(readOnlySceneJson()) as SceneDocument;

/** The permission bits of `path`. */
const modeOf = async (path: string): Promise<number> =>
  (await stat(path)).mode & 0o777;

describe("the library, owner-only (audit run 1)", () => {
  // Red: `mkdir` and `writeFile` with default modes in `write` — a take of a
  // signed-in page, readable by every local user.
  it("writes a take into a fresh home as 0700 folders and 0600 files", async () => {
    // Premise: a folder made with no mode here is open to others (umask 022).
    await mkdir(join(home, "probe"));
    expect((await modeOf(join(home, "probe"))) & 0o077).not.toBe(0);
    const fresh = join(home, "fresh-home");
    const doc = scene();
    await createLibrary(fresh).putScene(doc);
    expect(await modeOf(fresh)).toBe(0o700);
    expect(await modeOf(join(fresh, "takes"))).toBe(0o700);
    expect(await modeOf(join(fresh, "takes", doc.meta.id))).toBe(0o700);
    expect(await modeOf(join(fresh, "takes", doc.meta.id, "scene.json"))).toBe(
      0o600,
    );
  });

  // Red: drop ownHome's chmod — a recursive mkdir's mode does not reach a
  // folder that is already there.
  it("closes a home that is already there and open to others", async () => {
    const open = join(home, "open-home");
    await mkdir(open, { mode: 0o755 });
    await chmod(open, 0o755);
    expect(await modeOf(open)).toBe(0o755);
    await ownHome(open);
    expect(await modeOf(open)).toBe(0o700);
  });
});

describe("createLibrary", () => {
  it("creates <home>/takes on first write and reads the take back", async () => {
    const lib = createLibrary(home);
    const doc = scene();
    await lib.putScene(doc);
    // The premise: the folder did not exist before the write made it.
    expect((await stat(join(home, "takes", doc.meta.id))).isDirectory()).toBe(
      true,
    );
    expect(await lib.getScene(doc.meta.id)).toEqual(doc);
  });

  it("answers null for a take that is not there", async () => {
    expect(await createLibrary(home).getScene("scene-nope")).toBeNull();
  });

  it("lists takes the way the extension's takes op does", async () => {
    const lib = createLibrary(home);
    const doc = scene();
    await lib.putScene(doc);
    expect(await lib.list()).toEqual([
      {
        id: doc.meta.id,
        name: doc.meta.name,
        createdAt: doc.meta.createdAt,
        mode: doc.meta.capture.mode,
        actions: doc.actions.length,
      },
    ]);
  });

  // Final review 2026-10-12, Important 5. Red while list() orders by folder
  // name, or by whatever order the folders were written: the older take
  // below has the id that sorts first AND was written first, so either of
  // those orders is oldest first here.
  it("lists takes newest first, by createdAt, not by folder name", async () => {
    const lib = createLibrary(home);
    const older = scene();
    older.meta.id = "scene-aaa-older";
    older.meta.createdAt = "2026-10-01T09:00:00.000Z";
    const newer = scene();
    newer.meta.id = "scene-zzz-newer";
    newer.meta.createdAt = "2026-10-12T09:00:00.000Z";
    await lib.putScene(older);
    await lib.putScene(newer);
    // The premise: folder-name order is oldest first.
    expect([newer.meta.id, older.meta.id].sort()).toEqual([
      older.meta.id,
      newer.meta.id,
    ]);
    expect((await lib.list()).map((e) => e.id)).toEqual([
      newer.meta.id,
      older.meta.id,
    ]);
  });

  it("lists nothing, not a failure, when no take was ever made", async () => {
    expect(await createLibrary(home).list()).toEqual([]);
  });

  it("says libraryUnwritable with the path when the home is read-only", async () => {
    await chmod(home, 0o500);
    const error = await createLibrary(home)
      .putScene(scene())
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(LibraryError);
    expect((error as LibraryError).reason).toBe("libraryUnwritable");
    expect((error as LibraryError).message).toContain(join(home, "takes"));
  });

  it("says libraryUnreadable for a scene.json that is not JSON", async () => {
    const lib = createLibrary(home);
    const doc = scene();
    await lib.putScene(doc);
    await import("node:fs/promises").then((fs) =>
      fs.writeFile(join(home, "takes", doc.meta.id, "scene.json"), "{nope"),
    );
    const error = await lib.getScene(doc.meta.id).catch((e: unknown) => e);
    expect((error as LibraryError).reason).toBe("libraryUnreadable");
    expect((error as LibraryError).message).toContain(
      join(home, "takes", doc.meta.id, "scene.json"),
    );
  });

  // Review 2026-10-13, #2: one take that will not read cost every other
  // take — `takes` refused outright, naming no folder. Red if list() lets
  // the read's throw escape, or drops the folder without saying so.
  // Launch B: a take written by a newer Demoman names the update command.
  it("names the update command for a take a newer Demoman wrote", async () => {
    await mkdir(join(home, "takes", "take-new"), { recursive: true });
    await writeFile(
      join(home, "takes", "take-new", "scene.json"),
      JSON.stringify({ schemaVersion: CURRENT_SCHEMA_VERSION + 1 }),
    );
    const told = createLibrary(home, {
      updateCommand: "npx demoman@latest setup",
    });
    const [entry] = await told.list();
    expect(entry).toMatchObject({ id: "take-new" });
    expect((entry as { unreadable: string }).unreadable).toContain(
      "written by a newer Demoman; run `npx demoman@latest setup`",
    );
    // Without a command nothing is invented.
    const [bare] = await createLibrary(home).list();
    expect((bare as { unreadable: string }).unreadable).not.toContain(
      "newer Demoman",
    );
  });

  it("does not call a broken take newer", async () => {
    // The control for the case above: unreadable, but not from the future.
    await mkdir(join(home, "takes", "take-bad"), { recursive: true });
    await writeFile(join(home, "takes", "take-bad", "scene.json"), "{nope");
    const [entry] = await createLibrary(home, {
      updateCommand: "npx demoman@latest setup",
    }).list();
    expect((entry as { unreadable: string }).unreadable).toMatch(
      /is not a take/,
    );
    expect((entry as { unreadable: string }).unreadable).not.toContain(
      "newer Demoman",
    );
  });

  it("lists the takes that read, and names the folder that does not", async () => {
    const lib = createLibrary(home);
    const good = scene();
    const bad = { ...scene(), meta: { ...scene().meta, id: "take-bad" } };
    await lib.putScene(good);
    await lib.putScene(bad);
    await writeFile(join(home, "takes", "take-bad", "scene.json"), "{nope");
    const listed = await lib.list();
    expect(listed).toHaveLength(2);
    expect(listed[0]).toMatchObject({ id: good.meta.id });
    expect(listed[1]).toEqual({
      id: "take-bad",
      unreadable: expect.stringContaining(join(home, "takes", "take-bad")),
    });
    expect((listed[1] as { unreadable: string }).unreadable).toMatch(
      /is not a take/,
    );
  });

  // Found in the D3 check: every reader goes to `takes/<meta.id>/`, so a
  // folder copied in Finder listed as a second card under the original's
  // id — and Delete on it removed the ORIGINAL — while a renamed folder
  // listed a card that open and Delete could not find. Red if the folder
  // name is not checked against meta.id: the copy lists as a take, and its
  // delete below takes the original with it.
  it("lists a copied take folder as unreadable, and deleting it keeps the original", async () => {
    const lib = createLibrary(home);
    const doc = scene();
    await lib.putScene(doc);
    const original = join(home, "takes", doc.meta.id);
    const copy = join(home, "takes", `${doc.meta.id} copy`);
    await mkdir(copy);
    await writeFile(
      join(copy, "scene.json"),
      await readFile(join(original, "scene.json"), "utf8"),
    );
    const listed = await lib.list();
    expect(listed).toHaveLength(2);
    expect(listed[0]).toMatchObject({ id: doc.meta.id, name: doc.meta.name });
    expect(listed[1]).toEqual({
      id: `${doc.meta.id} copy`,
      unreadable: expect.stringContaining(copy),
    });
    expect((listed[1] as { unreadable: string }).unreadable).toContain(
      `holds the take ${doc.meta.id}`,
    );
    // Read by its own folder name, the copy refuses rather than answering
    // as the original.
    await expect(lib.getScene(`${doc.meta.id} copy`)).rejects.toThrow(
      LibraryError,
    );
    const done = await lib.deleteTake(`${doc.meta.id} copy`);
    expect(done).toMatchObject({ ok: true });
    expect((await readdir(join(home, "takes"))).sort()).toEqual([doc.meta.id]);
    expect(await lib.getScene(doc.meta.id)).toEqual(doc);
  });

  it("lists a renamed take folder as unreadable, under its new name", async () => {
    const lib = createLibrary(home);
    const doc = scene();
    await lib.putScene(doc);
    const renamed = join(home, "takes", "my-demo");
    await mkdir(renamed);
    await writeFile(
      join(renamed, "scene.json"),
      await readFile(join(home, "takes", doc.meta.id, "scene.json"), "utf8"),
    );
    await rm(join(home, "takes", doc.meta.id), { recursive: true });
    expect(await lib.list()).toEqual([
      {
        id: "my-demo",
        unreadable: expect.stringContaining(`holds the take ${doc.meta.id}`),
      },
    ]);
  });

  // Review 2026-10-13, #2: scene.json was written in place, so a reader —
  // or a process killed mid-write — could find half a file. Red if the write
  // goes straight to the path. A reader polls the file while large writes
  // go on; written in place, it reads a truncated file on most runs here.
  it("never lets a reader see half a file while it is rewritten", async () => {
    const lib = createLibrary(home);
    const doc = scene();
    await lib.putScene(doc);
    const path = join(home, "takes", doc.meta.id, "status.json");
    const big = { pad: "x".repeat(8_000_000) };
    await lib.putJson(doc.meta.id, "status.json", big);
    let writing = true;
    let reads = 0;
    const torn: string[] = [];
    const reader = (async () => {
      while (writing) {
        const text = await readFile(path, "utf8");
        reads++;
        try {
          JSON.parse(text);
        } catch {
          torn.push(`${text.length} bytes`);
        }
      }
    })();
    for (let i = 0; i < 10; i++) {
      await lib.putJson(doc.meta.id, "status.json", big);
    }
    writing = false;
    await reader;
    // The premise: the reader really did read while the writes went on.
    expect(reads).toBeGreaterThan(5);
    expect(torn).toEqual([]);
    // And a write leaves no temp file behind.
    expect(
      (await readdir(join(home, "takes", doc.meta.id))).filter((f) =>
        f.endsWith(".tmp"),
      ),
    ).toEqual([]);
  }, 60_000);

  it("writes report.json beside the take", async () => {
    const lib = createLibrary(home);
    const doc = scene();
    await lib.putScene(doc);
    await lib.putJson(doc.meta.id, "report.json", { outcome: "complete" });
    expect(
      JSON.parse(
        await readFile(join(home, "takes", doc.meta.id, "report.json"), "utf8"),
      ),
    ).toEqual({ outcome: "complete" });
  });

  it("reads report.json back: missing, unreadable and the value told apart", async () => {
    const lib = createLibrary(home);
    const doc = scene();
    await lib.putScene(doc);
    expect(await lib.getJson(doc.meta.id, "report.json")).toEqual({
      missing: true,
    });
    const path = join(home, "takes", doc.meta.id, "report.json");
    await writeFile(path, "{ not json");
    expect(await lib.getJson(doc.meta.id, "report.json")).toEqual({
      unreadable: expect.stringContaining(path),
    });
    await lib.putJson(doc.meta.id, "report.json", { outcome: "complete" });
    expect(await lib.getJson(doc.meta.id, "report.json")).toEqual({
      value: { outcome: "complete" },
    });
  });

  it("refuses ids that would leave the library", async () => {
    const lib = createLibrary(home);
    await writeFile(join(home, "kits.json"), "{}");
    for (const id of ["", ".", "..", "../x", "a/b", "a\\b"]) {
      const read = await lib.getScene(id).catch((e: unknown) => e);
      expect(read, id).toBeInstanceOf(LibraryError);
      expect((read as LibraryError).reason).toBe("libraryUnreadable");
      expect((read as LibraryError).message).toContain(
        `"${id}" is not a take id`,
      );
      const removed = await lib.removeTake(id).catch((e: unknown) => e);
      expect(removed, id).toBeInstanceOf(LibraryError);
      expect((removed as LibraryError).reason).toBe("libraryUnwritable");
    }
    // The premise: what removeTake("..") would have deleted is still there.
    expect((await stat(join(home, "kits.json"))).isFile()).toBe(true);
  });

  it("lists a take beside a stray file, and skips a folder with no scene.json", async () => {
    const lib = createLibrary(home);
    const doc = scene();
    await lib.putScene(doc);
    await writeFile(join(home, "takes", ".DS_Store"), "x");
    await mkdir(join(home, "takes", "frames-only"));
    expect((await lib.list()).map((e) => e.id)).toEqual([doc.meta.id]);
  });
});

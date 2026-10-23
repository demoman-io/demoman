import {
  chmod,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  MAX_UNIQUIFY,
  saveExport,
  saveStillsFolder,
} from "../src/executor/save.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "demoman-save-"));
});
afterEach(async () => {
  await chmod(dir, 0o700).catch(() => undefined);
  await rm(dir, { recursive: true, force: true });
});
const bytes = new Uint8Array([1, 2, 3]);

describe("saveExport", () => {
  it("writes the file under its name and answers its absolute path", async () => {
    const out = await saveExport(dir, "Checkout.mp4", bytes);
    expect(out).toEqual({
      kind: "saved",
      downloadId: null,
      savedAs: "Checkout.mp4",
      path: join(dir, "Checkout.mp4"),
    });
    expect([...(await readFile(join(dir, "Checkout.mp4")))]).toEqual([1, 2, 3]);
  });

  // Review Focus 1, Chrome's `conflictAction: "uniquify"`: never overwrite.
  it("uniquifies like Chrome: name (1).mp4, then name (2).mp4", async () => {
    await writeFile(join(dir, "Checkout.mp4"), "first");
    const a = await saveExport(dir, "Checkout.mp4", bytes);
    const b = await saveExport(dir, "Checkout.mp4", bytes);
    expect(a).toMatchObject({ kind: "saved", savedAs: "Checkout (1).mp4" });
    expect(b).toMatchObject({ kind: "saved", savedAs: "Checkout (2).mp4" });
    expect(await readFile(join(dir, "Checkout.mp4"), "utf8")).toBe("first");
  });

  it("puts the number before the extension of a vertical name", async () => {
    await writeFile(join(dir, "Checkout (vertical).mp4"), "first");
    expect(
      await saveExport(dir, "Checkout (vertical).mp4", bytes),
    ).toMatchObject({
      savedAs: "Checkout (vertical) (1).mp4",
    });
  });

  // Review Focus 4: a folder that is not there yet is made, as Chrome makes
  // its downloads folder.
  it("creates a missing folder", async () => {
    const nested = join(dir, "a", "b");
    expect(await saveExport(nested, "x.mp4", bytes)).toMatchObject({
      kind: "saved",
      path: join(nested, "x.mp4"),
    });
  });

  it("answers failed, naming the folder, when it cannot be created", async () => {
    await writeFile(join(dir, "file"), "not a folder");
    const out = await saveExport(join(dir, "file", "sub"), "x.mp4", bytes);
    expect(out).toMatchObject({ kind: "failed" });
    // Node's ENOTDIR text also names the folder, so `toContain` would stay
    // green without our `${dir}`. `startsWith` pins our line.
    if (out.kind === "failed")
      expect(
        out.error.startsWith(
          `could not create the export folder ${join(dir, "file", "sub")}`,
        ),
      ).toBe(true);
  });

  it("answers failed with the path and the OS error when the folder is read-only, and leaves no file", async () => {
    // The premise: a read-only folder refuses this process. Root ignores
    // the mode, and this case would then assert nothing.
    expect(process.getuid?.(), "running as root: chmod cannot refuse").not.toBe(
      0,
    );
    await chmod(dir, 0o500);
    const out = await saveExport(dir, "x.mp4", bytes);
    expect(out).toMatchObject({ kind: "failed" });
    if (out.kind === "failed") {
      expect(out.error).toContain(join(dir, "x.mp4"));
      expect(out.error).toMatch(/EACCES|EPERM/);
    }
    await chmod(dir, 0o700);
    expect(await readdir(dir)).toEqual([]);
  });

  it("gives up after MAX_UNIQUIFY numbered copies and says so", async () => {
    await writeFile(join(dir, "x.mp4"), "");
    for (let n = 1; n <= MAX_UNIQUIFY; n++)
      await writeFile(join(dir, `x (${n}).mp4`), "");
    const out = await saveExport(dir, "x.mp4", bytes);
    expect(out).toMatchObject({ kind: "failed" });
    if (out.kind === "failed")
      expect(out.error).toContain(`${MAX_UNIQUIFY} numbered copies`);
  });
});

describe("saveStillsFolder", () => {
  const files = [
    { name: "act-1.png", bytes: new Uint8Array([1]) },
    { name: "act-2.png", bytes: new Uint8Array([2]) },
    { name: "act-3.png", bytes: new Uint8Array([3]) },
  ];

  it("writes every still into a new folder named for the take", async () => {
    const saved = await saveStillsFolder(dir, "Order stills", files);
    expect(saved).toEqual({
      kind: "saved",
      path: join(dir, "Order stills"),
      files: files.map((f) => ({ name: f.name, byteLength: 1 })),
    });
    expect((await readdir(join(dir, "Order stills"))).sort()).toEqual([
      "act-1.png",
      "act-2.png",
      "act-3.png",
    ]);
  });

  // Red if a name with a path in it is joined unchecked.
  it("refuses a still whose name is not a plain file name, before creating the folder", async () => {
    for (const name of ["../escape.png", "sub/x.png", "..", "."]) {
      const saved = await saveStillsFolder(dir, "S", [
        { name: "ok.png", bytes: new Uint8Array([1]) },
        { name, bytes: new Uint8Array([2]) },
      ]);
      expect(saved, name).toMatchObject({ kind: "failed" });
      if (saved.kind === "failed")
        expect(saved.error, name).toContain(JSON.stringify(name));
      expect(await readdir(dir), name).toEqual([]);
    }
  });

  // Review Focus 2. Red if a second export writes into the first folder.
  it("puts a second export in 'name (1)', leaving the first untouched", async () => {
    await saveStillsFolder(dir, "Order stills", files);
    const again = await saveStillsFolder(dir, "Order stills", [
      { name: "act-1.png", bytes: new Uint8Array([9]) },
    ]);
    expect(again).toMatchObject({
      kind: "saved",
      path: join(dir, "Order stills (1)"),
    });
    expect([
      ...(await readFile(join(dir, "Order stills", "act-1.png"))),
    ]).toEqual([1]);
  });

  // Red if a folder that stopped partway answers saved.
  it("stops at the first refused still and names what is on disk", async () => {
    let n = 0;
    const saved = await saveStillsFolder(
      dir,
      "S",
      files,
      async (path, bytes) => {
        if (++n === 2)
          throw Object.assign(new Error("no space left"), { code: "ENOSPC" });
        await writeFile(path, bytes, { flag: "wx" });
      },
    );
    expect(saved).toEqual({
      kind: "failed",
      error: `could not write ${join(dir, "S", "act-2.png")} (no space left)`,
      partial: {
        folder: join(dir, "S"),
        written: ["act-1.png"],
        notWritten: ["act-2.png", "act-3.png"],
      },
    });
    expect(await readdir(join(dir, "S"))).toEqual(["act-1.png"]);
  });

  // Red if the refusal removes the file that holds the name: the first still,
  // which `partial.written` still lists.
  it("keeps the first still when two share a name, and says the name was taken", async () => {
    const same = [
      { name: "a.png", bytes: new Uint8Array([1]) },
      { name: "a.png", bytes: new Uint8Array([2]) },
    ];
    const saved = await saveStillsFolder(dir, "S", same);
    expect(saved).toMatchObject({
      kind: "failed",
      error: `could not write ${join(dir, "S", "a.png")} (the name was already taken in this folder)`,
      partial: { written: ["a.png"], notWritten: ["a.png"] },
    });
    expect([...(await readFile(join(dir, "S", "a.png")))]).toEqual([1]);
  });

  // A write that died midway can leave half a PNG under its name.
  it("removes the partial file the refused still left behind", async () => {
    const saved = await saveStillsFolder(
      dir,
      "S",
      files.slice(0, 1),
      async (path) => {
        await writeFile(path, "half");
        throw Object.assign(new Error("no space left"), { code: "ENOSPC" });
      },
    );
    expect(saved).toMatchObject({ kind: "failed" });
    expect(await readdir(join(dir, "S"))).toEqual([]);
  });
});

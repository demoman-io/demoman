import {
  access,
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FLOWS_DIR,
  LEGACY_FLOWS_DIR as KEPT_DIR,
  type KeptReceipt,
  type KeptVideo,
  keptFileName,
  parseReceipt,
  screensDirOf,
  serializeKept,
  serializeReceipt,
} from "@demoman/run-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { removeRepoFlow, renameKept } from "../src/executor/keep.js";
import {
  adoptKept,
  findKept,
  readKeptFlows,
  repoFlowFiles,
} from "../src/executor/kept-flows.js";
import { createLibrary } from "../src/executor/library.js";
import { createVideoStore, type VideoStore } from "../src/executor/videos.js";

const FLOW_ID = "0b6e1c52-7d3a-4f0e-9a41-2c8d5e6f7a90";
const NAME = "Place an order";
const FILE = `${KEPT_DIR}/${keptFileName(NAME)}`;
const kept: KeptVideo = {
  keptVersion: 2,
  flow: FLOW_ID,
  deliver: "commit",
  name: NAME,
  script: {
    scriptVersion: 1,
    name: NAME,
    target: "http://localhost:1/app",
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
};

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "demoman-kept-flows-"));
  await mkdir(join(root, KEPT_DIR), { recursive: true });
  await writeFile(join(root, FILE), serializeKept(kept));
});
afterEach(() => rm(root, { recursive: true, force: true }));

describe("repo flows in .demoman/flows and the old .demoman/videos", () => {
  // The beforeEach fixture is one recipe in the old folder only.
  it("reads a repo that has only .demoman/videos/", async () => {
    expect(KEPT_DIR).toBe(".demoman/videos");
    expect(await repoFlowFiles(root)).toEqual([FILE]);
    const { entries } = await readKeptFlows(root);
    expect(entries.map((e) => e.file)).toEqual([FILE]);
  });

  it("reads both folders, flows first", async () => {
    expect(FLOWS_DIR).toBe(".demoman/flows");
    const other = `${FLOWS_DIR}/b.json`;
    await mkdir(join(root, FLOWS_DIR), { recursive: true });
    await writeFile(
      join(root, other),
      serializeKept({
        ...kept,
        flow: "1c7f2d63-8e4b-4a1f-8b52-3d9e6f7a8b01",
        name: "B",
      }),
    );
    expect(await repoFlowFiles(root)).toEqual([other, FILE]);
    const { entries, duplicates } = await readKeptFlows(root);
    // Premise: both parsed, as two different flows.
    expect(entries.filter((e) => "kept" in e).map((e) => e.file)).toEqual([
      other,
      FILE,
    ]);
    expect(duplicates).toEqual([]);
  });

  it("a name in both folders is a duplicate naming both files", async () => {
    const twin = `${FLOWS_DIR}/${keptFileName(NAME)}`;
    await mkdir(join(root, FLOWS_DIR), { recursive: true });
    await copyFile(join(root, FILE), join(root, twin));
    const { duplicates } = await readKeptFlows(root);
    expect(duplicates).toEqual([{ flow: FLOW_ID, files: [twin, FILE] }]);
  });

  it("a name in both folders is a duplicate even when the ids differ", async () => {
    const twin = `${FLOWS_DIR}/${keptFileName(NAME)}`;
    await mkdir(join(root, FLOWS_DIR), { recursive: true });
    const otherId = "2d8a3e74-9f5c-4b20-9c63-4eaf7a8b9c12";
    await writeFile(
      join(root, twin),
      serializeKept({ ...kept, flow: otherId }),
    );
    const { entries, duplicates } = await readKeptFlows(root);
    // Premise: both parsed, as two different flows.
    expect(entries.flatMap((e) => ("kept" in e ? [e.kept.flow] : []))).toEqual([
      otherId,
      FLOW_ID,
    ]);
    // Neither id may resolve to one of the two files.
    expect(duplicates).toEqual([
      { flow: otherId, files: [twin, FILE], sameName: true },
      { flow: FLOW_ID, files: [twin, FILE], sameName: true },
    ]);
    expect(await findKept(root, FLOW_ID)).toEqual({ duplicate: [twin, FILE] });
    expect(await findKept(root, otherId)).toEqual({ duplicate: [twin, FILE] });
  });
});

describe("readKeptFlows", () => {
  it("two files naming one flow are a duplicate", async () => {
    const copy = `${KEPT_DIR}/copy-of-it.json`;
    await copyFile(join(root, FILE), join(root, copy));
    const { entries, duplicates } = await readKeptFlows(root);
    // Premise: both copies parsed as recipes of the same flow.
    expect(entries.filter((e) => "kept" in e)).toHaveLength(2);
    expect(duplicates).toHaveLength(1);
    expect(duplicates[0]?.flow).toBe(FLOW_ID);
    expect(duplicates[0]?.files).toEqual([copy, FILE].sort());
    expect(await findKept(root, FLOW_ID)).toEqual({
      duplicate: [copy, FILE].sort(),
    });
  });

  it("an unreadable file is listed, not skipped", async () => {
    const bad = `${KEPT_DIR}/broken.json`;
    await writeFile(join(root, bad), "{ not json");
    const { entries, duplicates } = await readKeptFlows(root);
    const entry = entries.find((e) => e.file === bad);
    expect(entry && "unreadable" in entry ? entry.unreadable : "").toContain(
      "not valid JSON",
    );
    expect(duplicates).toEqual([]);
    // The good file still reads beside it.
    expect(await findKept(root, FLOW_ID)).toMatchObject({ file: FILE });
  });

  it("a checkout with no kept folder has no flows", async () => {
    await rm(join(root, KEPT_DIR), { recursive: true });
    expect(await readKeptFlows(root)).toEqual({ entries: [], duplicates: [] });
    expect(await findKept(root, FLOW_ID)).toBeNull();
  });
});

describe("renameKept", () => {
  it("refuses a record's file outside the repo before reading it", async () => {
    const outside = `../${keptFileName("Elsewhere")}`;
    const out = await renameKept(
      { root, file: outside, name: "Anything" },
      { videos: {} as VideoStore },
    );
    expect(out).toEqual({
      ok: false,
      reason: "repoFlowUnwritable",
      detail: expect.stringContaining(`${outside} is not inside the repo`),
    });
  });
});

const receiptV2 = (file: string): KeptReceipt => ({
  receiptVersion: 3,
  screensDir: screensDirOf(file),
  flow: FLOW_ID,
  video: "take-1",
  filmedAt: null,
  filmedCode: { none: "test" },
  screens: { steps: 1, screens: [{ step: 0 }] },
  recordedRevision: null,
});
const hasAt = (p: string) =>
  access(join(root, p)).then(
    () => true,
    () => false,
  );

describe("renameKept moves the screens folder with the receipt", () => {
  const NEW = "Place a big order";
  const oldReceipt = `.demoman/receipts/${keptFileName(NAME)}`;
  const newReceipt = `.demoman/receipts/${keptFileName(NEW)}`;
  const oldDir = `.demoman/receipts/${screensDirOf(oldReceipt)}`;
  const newDir = `.demoman/receipts/${screensDirOf(newReceipt)}`;
  const fake = (setKeptOk: boolean) =>
    ({
      list: async () => [{ id: FLOW_ID, name: NAME, repo: undefined }],
      rename: async () => ({ ok: true as const }),
      setKept: async () =>
        setKeptOk ? { ok: true as const } : { ok: false as const, reason: "x" },
    }) as unknown as VideoStore;
  beforeEach(async () => {
    await mkdir(join(root, oldDir), { recursive: true });
    await writeFile(join(root, oldDir, "step-1.png"), "png");
    await writeFile(
      join(root, oldReceipt),
      serializeReceipt(receiptV2(oldReceipt)),
    );
  });

  it("moves the folder and points the receipt at it", async () => {
    // Premise: the folder and receipt start under the old name.
    expect([await hasAt(oldDir), await hasAt(newDir)]).toEqual([true, false]);
    const out = await renameKept(
      { root, file: FILE, name: NEW },
      { videos: fake(true) },
    );
    expect(out, JSON.stringify(out)).toMatchObject({ ok: true });
    expect([await hasAt(oldDir), await hasAt(newDir)]).toEqual([false, true]);
    expect(await hasAt(`${newDir}/step-1.png`)).toBe(true);
    const parsed = parseReceipt(
      await readFile(join(root, newReceipt), "utf8"),
      newReceipt,
    );
    expect(parsed.ok && parsed.receipt.screensDir).toBe(
      screensDirOf(newReceipt),
    );
  });

  it("a later step failing puts the folder and receipt back", async () => {
    const before = await readFile(join(root, oldReceipt), "utf8");
    const out = await renameKept(
      { root, file: FILE, name: NEW },
      { videos: fake(false) },
    );
    expect(out).toMatchObject({ ok: false, reason: "repoFlowUnwritable" });
    expect(!out.ok && out.detail).toContain("every step before it was undone");
    expect([await hasAt(oldDir), await hasAt(newDir)]).toEqual([true, false]);
    expect(await readFile(join(root, oldReceipt), "utf8")).toBe(before);
  });
});

describe("removeRepoFlow", () => {
  const RECEIPT = `.demoman/receipts/${keptFileName(NAME)}`;
  const has = hasAt;

  it("deletes the screens folder too and lists it", async () => {
    const dir = `.demoman/receipts/${screensDirOf(RECEIPT)}`;
    await mkdir(join(root, dir), { recursive: true });
    await writeFile(join(root, dir, "step-1.png"), "png");
    await writeFile(join(root, RECEIPT), "{}");
    expect(await has(dir)).toBe(true);
    const out = await removeRepoFlow({ root, flow: NAME });
    expect(out).toMatchObject({ ok: true, removed: [FILE, RECEIPT, dir] });
    expect(await has(dir)).toBe(false);
  });

  it("deletes the recipe and receipt and leaves the exports", async () => {
    await mkdir(join(root, ".demoman/receipts"), { recursive: true });
    await writeFile(join(root, RECEIPT), "{}");
    await mkdir(join(root, "docs"), { recursive: true });
    await writeFile(join(root, "docs/o.mp4"), "video");
    // Premise: all three are there.
    expect([
      await has(FILE),
      await has(RECEIPT),
      await has("docs/o.mp4"),
    ]).toEqual([true, true, true]);
    expect(await removeRepoFlow({ root, flow: NAME })).toEqual({
      ok: true,
      name: NAME,
      removed: [FILE, RECEIPT],
      exportsLeft: ["docs/o.mp4"],
    });
    expect([
      await has(FILE),
      await has(RECEIPT),
      await has("docs/o.mp4"),
    ]).toEqual([false, false, true]);
  });

  it("removes a files flow's recipe alone, found by its id", async () => {
    await writeFile(
      join(root, FILE),
      serializeKept({
        ...kept,
        deliver: "files",
        outputs: [
          { path: "o.gif", fileType: "gif", aspect: "16:9", quality: "share" },
        ],
      }),
    );
    expect(await removeRepoFlow({ root, flow: FLOW_ID })).toEqual({
      ok: true,
      name: NAME,
      removed: [FILE],
      exportsLeft: [],
    });
    expect(await has(FILE)).toBe(false);
  });

  it("a flow not in the repo is notInRepo, naming the repo's flows", async () => {
    const out = await removeRepoFlow({ root, flow: "Nope" });
    expect(out).toMatchObject({ ok: false, reason: "notInRepo" });
    expect(!out.ok && out.detail).toContain(`"${NAME}"`);
    expect(await has(FILE)).toBe(true);
  });

  it("a duplicated flow is duplicateFlow naming both files, and nothing goes", async () => {
    const twin = `${FLOWS_DIR}/${keptFileName(NAME)}`;
    await mkdir(join(root, FLOWS_DIR), { recursive: true });
    await copyFile(join(root, FILE), join(root, twin));
    const out = await removeRepoFlow({ root, flow: NAME });
    expect(out).toMatchObject({ ok: false, reason: "duplicateFlow" });
    expect(!out.ok && out.detail).toContain(`${twin} and ${FILE}`);
    expect([await has(FILE), await has(twin)]).toEqual([true, true]);
  });

  it("a receipt that cannot be removed after the recipe is gone says so", async () => {
    await mkdir(join(root, ".demoman/receipts"), { recursive: true });
    await writeFile(join(root, RECEIPT), "{}");
    await chmod(join(root, ".demoman/receipts"), 0o555);
    try {
      const out = await removeRepoFlow({ root, flow: NAME });
      expect(out).toMatchObject({ ok: false, reason: "repoFlowUnwritable" });
      expect(!out.ok && out.detail).toContain(`removed ${FILE}`);
      expect(!out.ok && out.detail).toContain(`delete ${RECEIPT}`);
      expect(await has(FILE)).toBe(false);
    } finally {
      await chmod(join(root, ".demoman/receipts"), 0o755);
    }
  });

  // Red: drop `key` from adoptKept's mark and the record has none.
  it("adoptKept writes the repo's key into the kept mark", async () => {
    const home = await mkdtemp(join(tmpdir(), "demoman-kept-home-"));
    try {
      const store = createVideoStore(home, createLibrary(home));
      const found = await findKept(root, FLOW_ID);
      if (found === null || !("kept" in found)) throw new Error("fixture");
      const adopted = await adoptKept(store, root, found, {
        key: "github.com/acme/shop",
      });
      if (!adopted.ok) throw new Error("not adopted");
      expect((await store.get(FLOW_ID))?.kept).toEqual({
        root,
        file: FILE,
        key: "github.com/acme/shop",
      });
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("clears the library's mark when it names the removed recipe", async () => {
    const marks = new Map<string, { root: string; file: string } | null>([
      [FLOW_ID, { root, file: FILE }],
    ]);
    const videos = {
      get: async (id: string) => ({ id, kept: marks.get(id) ?? undefined }),
      setKept: async (id: string, k: { root: string; file: string } | null) => {
        marks.set(id, k);
        return { ok: true as const };
      },
    } as unknown as VideoStore;
    const out = await removeRepoFlow({ root, flow: NAME }, { videos });
    expect(out).toMatchObject({ ok: true, removed: [FILE] });
    expect(marks.get(FLOW_ID)).toBeNull();
  });

  it("a mark that cannot be cleared is said, not forgiven", async () => {
    const videos = {
      get: async (id: string) => ({ id, kept: { root, file: FILE } }),
      setKept: async () => ({ ok: false as const, reason: "locked" }),
    } as unknown as VideoStore;
    const out = await removeRepoFlow({ root, flow: NAME }, { videos });
    expect(out).toMatchObject({
      ok: true,
      markNote: `the library still marks "${NAME}" as in the repo (locked); the Studio shows it In repo until it is cleared`,
    });
  });

  it("a receipt whose presence cannot be told removes nothing", async () => {
    await mkdir(join(root, ".demoman/receipts"), { recursive: true });
    await writeFile(join(root, RECEIPT), "{}");
    await chmod(join(root, ".demoman/receipts"), 0o000);
    try {
      const out = await removeRepoFlow({ root, flow: NAME });
      expect(out).toMatchObject({ ok: false, reason: "repoFlowUnwritable" });
      expect(!out.ok && out.detail).toContain(`whether ${RECEIPT} is there`);
      expect(!out.ok && out.detail).toContain("nothing was removed");
      expect(await has(FILE)).toBe(true);
    } finally {
      await chmod(join(root, ".demoman/receipts"), 0o755);
    }
  });
});

import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FLOWS_DIR,
  LEGACY_FLOWS_DIR as KEPT_DIR,
  type KeptVideo,
  keptFileName,
  serializeKept,
} from "@demoman/run-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { renameKept } from "../src/executor/keep.js";
import {
  findKept,
  readKeptFlows,
  repoFlowFiles,
} from "../src/executor/kept-flows.js";
import type { VideoStore } from "../src/executor/videos.js";

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

import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KEPT_DIR, keptFileName } from "@demoman/run-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { findKept, readKeptFlows } from "../src/executor/kept-flows.js";
import { FLOW_ID, type V1Kept, writeV1 } from "./kept-v1.js";

const NAME = "Place an order";
const FILE = `${KEPT_DIR}/${keptFileName(NAME)}`;
const kept: V1Kept = {
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
  } as V1Kept["script"],
  scale: 1,
  logo: null,
  wallpaper: null,
  outputs: [
    { path: "docs/o.mp4", fileType: "mp4", aspect: "16:9", quality: "share" },
  ],
  screens: { steps: 1, moments: [{ step: null, ms: 500 }] },
  report: null,
  from: { videoId: FLOW_ID, takeId: "t1", recordedRevision: "r1" },
};

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "demoman-kept-flows-"));
  await mkdir(join(root, KEPT_DIR), { recursive: true });
  await writeFile(join(root, FILE), writeV1(kept));
});
afterEach(() => rm(root, { recursive: true, force: true }));

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

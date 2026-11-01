// apps/studio/test/pages/node/library-length-cache.test.ts
//
// The list's Length cache: measured once per scene digest (list spec §2.1).
import { sceneDigest } from "@demoman/run-core";
import type { SceneDocument } from "@demoman/scene-schema";
import { describe, expect, it, vi } from "vitest";
import { readonlyScene } from "../../../../../packages/replay-engine/test/helpers/scenes";
import { formatLength } from "../../../pages/src/library/length";
import {
  createLengthCache,
  paintLength,
} from "../../../pages/src/library/length-cache";

// Counts the cache's digests; still the real one.
vi.mock("@demoman/run-core", async (importOriginal) => {
  const real = await importOriginal<typeof import("@demoman/run-core")>();
  return { ...real, sceneDigest: vi.fn(real.sceneDigest) };
});

const base = readonlyScene();
const cutScene: SceneDocument = {
  ...base,
  edits: {
    ...base.edits,
    removed: [
      {
        id: "c",
        start: { actionId: "act-2", sourceOffsetMs: 0 },
        end: { actionId: "act-3", sourceOffsetMs: 0 },
      },
    ],
  },
};
const renamed: SceneDocument = {
  ...base,
  meta: { ...base.meta, name: "another name" },
};
const measured = { kind: "measured", ms: 5000 } as const;

describe("createLengthCache", () => {
  it("a second measure of an unchanged scene does not run again", async () => {
    const cache = createLengthCache();
    const run = vi.fn(async () => measured);
    await cache.measure(base, run);
    await cache.measure(base, run);
    expect(run).toHaveBeenCalledTimes(1);
    expect(cache.get(base)).toEqual(measured);
  });

  it("an edit measures again; a rename does not", async () => {
    // Premises: the digests are what the two cases rest on.
    expect(sceneDigest(cutScene)).not.toBe(sceneDigest(base));
    expect(sceneDigest(renamed)).toBe(sceneDigest(base));
    const cache = createLengthCache();
    const run = vi.fn(async () => measured);
    await cache.measure(base, run);
    await cache.measure(renamed, run);
    expect(run).toHaveBeenCalledTimes(1);
    await cache.measure(cutScene, run);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("two measures in flight share one run", async () => {
    const cache = createLengthCache();
    const run = vi.fn(async () => measured);
    const [a, b] = await Promise.all([
      cache.measure(base, run),
      cache.measure(base, run),
    ]);
    expect(run).toHaveBeenCalledTimes(1);
    expect(a).toBe(b);
  });

  // Red: a throw kept under the digest, so a one-off failure said `—`
  // for the rest of the session.
  it("a run that throws is not kept: the next measure runs again", async () => {
    const cache = createLengthCache();
    const run = vi
      .fn<() => Promise<typeof measured>>()
      .mockRejectedValueOnce(new Error("no frames"))
      .mockResolvedValueOnce(measured);
    await expect(cache.measure(base, run)).rejects.toThrow("no frames");
    expect(cache.get(base)).toBeUndefined();
    await expect(cache.measure(base, run)).resolves.toEqual(measured);
    expect(run).toHaveBeenCalledTimes(2);
    // The measured result is kept.
    expect(cache.get(base)).toEqual(measured);
    await cache.measure(base, run);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("a nothing result is kept until an edit", async () => {
    const cache = createLengthCache();
    const nothing = {
      kind: "nothing",
      reason: "its trim leaves no frames",
    } as const;
    const run = vi.fn(async () => nothing);
    await cache.measure(base, run);
    await cache.measure(base, run);
    expect(run).toHaveBeenCalledTimes(1);
    expect(cache.get(base)).toEqual(nothing);
  });

  // Red: `keyOf` digesting the whole document on every get and measure.
  it("digests a document once, and a new document again", async () => {
    const digest = vi.mocked(sceneDigest);
    const cache = createLengthCache();
    const doc = structuredClone(base);
    digest.mockClear();
    cache.get(doc);
    cache.get(doc);
    await cache.measure(doc, async () => measured);
    expect(digest).toHaveBeenCalledTimes(1);
    // A listing replaces every document: the copy is digested afresh, and
    // keeps the length, its digest being the same.
    const copy = structuredClone(doc);
    expect(cache.get(copy)).toEqual(measured);
    expect(digest).toHaveBeenCalledTimes(2);
  });
});

describe("paintLength", () => {
  const cell = () => document.createElement("div");
  it("a throw paints — with the message as title", () => {
    const c = cell();
    paintLength(c, new Error("no frames"));
    expect([c.textContent, c.title]).toEqual(["—", "no frames"]);
  });
  it("nothing paints — with its reason", () => {
    const c = cell();
    paintLength(c, { kind: "nothing", reason: "its trim leaves no frames" });
    expect([c.textContent, c.title]).toEqual([
      "—",
      "its trim leaves no frames",
    ]);
  });
  it("measured paints formatLength", () => {
    const c = cell();
    paintLength(c, measured);
    expect(formatLength(5000)).toBe("0:05");
    expect(c.textContent).toBe("0:05");
  });
  it("undefined leaves the cell empty", () => {
    const c = cell();
    paintLength(c, undefined);
    expect([c.textContent, c.title]).toEqual(["", ""]);
  });
});

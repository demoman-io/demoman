import { describe, expect, it } from "vitest";
import { readonlyScene } from "../../../../../packages/replay-engine/test/helpers/scenes";
import { createMemoryPlatform } from "../helpers/memory-platform";

// The in-memory `Platform` the page tests boot the editor, library and
// Settings against (2026-10-20, when they left apps/extension and its
// faked `chrome.runtime`). These pin the answers it gives in the shapes
// `pages/src/platform/http.ts` gives them, so a page test reads the
// studio's behaviour rather than the fake's own idea of it.

describe("the memory platform", () => {
  it("reads back a seeded scene, with a revision", async () => {
    const scene = readonlyScene();
    const memory = createMemoryPlatform({ scenes: [scene] });
    const got = await memory.scenes.get(scene.meta.id);
    expect(got?.scene).toEqual(scene);
    expect(typeof got?.revision).toBe("string");
  });

  it("records a put, and the next get answers the put scene", async () => {
    const scene = readonlyScene();
    const memory = createMemoryPlatform({ scenes: [scene] });
    const before = await memory.scenes.get(scene.meta.id);
    const renamed = { ...scene, meta: { ...scene.meta, name: "Renamed" } };
    const done = await memory.scenes.put(renamed, before?.revision ?? null);
    expect(memory.puts()).toEqual([renamed]);
    expect(memory.calls.at(-1)).toEqual({
      member: "scenes",
      method: "put",
      args: [renamed, before?.revision ?? null],
    });
    expect(done.revision).not.toBe(before?.revision);
    expect((await memory.scenes.get(scene.meta.id))?.scene.meta.name).toBe(
      "Renamed",
    );
  });

  // `http.ts` answers a `takeNotFound` from the studio with null, and
  // rejects for anything else; the editor's "could not open" path reads
  // that null.
  it("answers null for a scene it does not hold, as http.ts does", async () => {
    const memory = createMemoryPlatform();
    expect(await memory.scenes.get("no-such-take")).toBeNull();
  });

  it("answers a member the test overrides, and still records the call", async () => {
    const memory = createMemoryPlatform();
    memory.answer("scenes.get", async () => {
      throw new Error("the Studio did not answer");
    });
    await expect(memory.scenes.get("t")).rejects.toThrow(
      "the Studio did not answer",
    );
    expect(memory.calls).toEqual([
      { member: "scenes", method: "get", args: ["t"] },
    ]);
  });

  it("hands this page's export events to its listeners, and no other window's", async () => {
    const memory = createMemoryPlatform();
    const seen: unknown[] = [];
    memory.exports.onEvent((e) => seen.push(e));
    const { jobId } = await memory.exports.start("t", {
      fileType: "mp4",
      aspect: "16:9",
      revision: "r1",
    });
    memory.emitExport({ kind: "saving", jobId });
    memory.emitExport({ kind: "saving", jobId: "another-windows-job" });
    memory.emitExport({ kind: "outputsChanged" });
    expect(seen).toEqual([
      { kind: "saving", jobId },
      { kind: "outputsChanged" },
    ]);
  });

  it("answers the active bundle it was seeded with, and null without one", async () => {
    const memory = createMemoryPlatform({ bundles: { a: null } });
    expect(await memory.bundles.active("a")).toEqual({
      bundle: null,
      replay: null,
      capture: null,
    });
  });
});

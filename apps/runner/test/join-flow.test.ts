import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FLOWS_DIR,
  type KeptVideo,
  keptFileName,
  serializeKept,
} from "@demoman/run-core";
import type { SceneDocument } from "@demoman/scene-schema";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createLibrary } from "../src/executor/library.js";
import { createVideoStore, type VideoRecord } from "../src/executor/videos.js";
import { joinFlow } from "../src/join-flow.js";
import { readOnlySceneJson } from "./fixtures/scene.js";

const INTO = "1a2b3c4d-0000-4000-8000-000000000002";
const NAME = "Refund an order";
const repo = { key: "github.com/acme/shop" };

let home: string;
let checkout: string;
const locked: string[] = [];
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "demoman-join-"));
  checkout = await mkdtemp(join(tmpdir(), "demoman-join-repo-"));
  await mkdir(join(checkout, FLOWS_DIR), { recursive: true });
  await writeFile(
    join(checkout, FLOWS_DIR, keptFileName(NAME)),
    serializeKept({
      keptVersion: 2,
      flow: INTO,
      deliver: "commit",
      name: NAME,
      script: {
        scriptVersion: 1,
        name: NAME,
        target: "http://localhost:1/app",
        steps: [{ do: "waitForLoad" }],
      } as KeptVideo["script"],
      scale: 1,
      logo: null,
      wallpaper: null,
      outputs: [
        {
          path: "docs/o.mp4",
          fileType: "mp4",
          aspect: "16:9",
          quality: "share",
        },
      ],
      report: null,
    }),
  );
});
afterEach(async () => {
  for (const dir of locked.splice(0)) await chmod(dir, 0o755);
  await rm(home, { recursive: true, force: true });
  await rm(checkout, { recursive: true, force: true });
});

/** A local flow under the kept name, holding one take per id. */
async function localFlow(takes: string[]) {
  const lib = createLibrary(home);
  const store = createVideoStore(home, lib);
  const local = await store.create({ name: NAME, repo, startPage: "x" });
  if (!local.ok) throw new Error("setup");
  for (const [i, id] of takes.entries()) {
    const doc = structuredClone(readOnlySceneJson()) as SceneDocument;
    doc.meta.id = id;
    doc.meta.createdAt = `2026-10-0${i + 1}T00:00:00.000Z`;
    await lib.putScene(doc);
    await writeFile(
      join(lib.takeDir(id), "status.json"),
      JSON.stringify({ outcome: "complete" }),
    );
    await writeFile(join(lib.takeDir(id), "script.json"), "{}");
    await store.join(id, {
      videoId: local.video.id,
      made: {
        repo: { ...repo, root: "/r", remote: null, branch: null, commit: null },
        agent: { none: "test" },
        by: { none: "test" },
        door: "mcp",
      },
      recordedRevision: null,
    });
  }
  return { lib, store, from: local.video.id };
}
/** The take's folder takes no new file: its membership cannot be rewritten. */
const lockTake = async (lib: ReturnType<typeof createLibrary>, id: string) => {
  await chmod(lib.takeDir(id), 0o555);
  locked.push(lib.takeDir(id));
};
const named = async (store: ReturnType<typeof createVideoStore>) =>
  (await store.list())
    .filter((v): v is VideoRecord => "name" in v && v.name === NAME)
    .map((v) => v.id);

describe("join-flow into a repo flow this library lacks", () => {
  it("a merge that fails on its first write takes the adopted record back out", async () => {
    const { lib, store, from } = await localFlow(["t1"]);
    await lockTake(lib, "t1");
    // Premise: only the local flow has the name, and the repo flow is not here.
    expect(await named(store)).toEqual([from]);
    expect(await store.get(INTO)).toBeNull();
    const err = await joinFlow(store, from, INTO, {
      root: checkout,
      repo,
    }).then(
      () => null,
      (e: unknown) => e as Error,
    );
    expect(err?.message).toContain("after moving 0 videos");
    expect(err?.message).toContain(
      `no video moved, and flow ${INTO} was taken back out`,
    );
    // Red: drop the undo — INTO stays beside `from`, two flows with one name.
    expect(await store.get(INTO)).toBeNull();
    expect(await named(store)).toEqual([from]);
    expect((await store.videoOf("t1"))?.videoId).toBe(from);
  });

  it("a merge that fails after moving a video keeps the record and names both ids and the name", async () => {
    const { lib, store, from } = await localFlow(["t1", "t2"]);
    await lockTake(lib, "t2");
    const err = await joinFlow(store, from, INTO, {
      root: checkout,
      repo,
    }).then(
      () => null,
      (e: unknown) => e as Error,
    );
    expect(err?.message).toContain("after moving 1 video into");
    // Premise: t1 moved, so the adopted record holds a video.
    expect((await store.videoOf("t1"))?.videoId).toBe(INTO);
    expect(await store.get(INTO)).not.toBeNull();
    expect(err?.message).toContain(
      `flow ${INTO} and flow ${from} now share the name "${NAME}" — run demoman join-flow ${from} ${INTO} again to finish`,
    );
  });
});

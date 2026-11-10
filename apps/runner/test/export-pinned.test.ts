import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type ExportDeps, exportTake } from "../src/executor/export.js";
import { createLibrary } from "../src/executor/library.js";
import { makeDiskTake } from "./disk-take.js";

// `deps.pinned` (DEM-100): the studio's queue hands exportTake the scene it
// read when the export was queued. What renders it is the studio lane's
// (`studio-export-revision.test.ts`); these are the two ways a pin is wrong.

const homes: string[] = [];
afterEach(async () => {
  for (const home of homes.splice(0))
    await rm(home, { recursive: true, force: true });
});

async function pinnedTake() {
  const home = await mkdtemp(join(tmpdir(), "export-pinned-"));
  homes.push(home);
  const { takeId, original } = await makeDiskTake(home);
  const library = createLibrary(home);
  const deps: ExportDeps = {
    library,
    // Neither case gets as far as a page.
    session: {} as never,
    door: "studio",
    home,
    wallpapersDir: join(home, "wallpapers"),
    outDir: join(home, "out"),
    log: () => undefined,
    videos: { videoOf: async () => null, get: async () => null },
    pinned: { scene: original, notes: [] },
  };
  return { home, takeId, original, library, deps };
}

describe("an export with a pinned scene", () => {
  it("says a take deleted since it was asked for is gone", async () => {
    const { home, takeId, library, deps } = await pinnedTake();
    expect(
      await library.getSceneRead(takeId),
      "the premise: the take is on disk until the case deletes it",
    ).not.toBeNull();
    await rm(join(home, "takes", takeId), { recursive: true });

    // Red: render the pin without asking whether the take is still there —
    // the answer is noFrames, "run its script again".
    const answer = await exportTake({ takeId }, deps, () => undefined);
    expect(answer).toMatchObject({
      outcome: "refusedBeforeExport",
      reason: "takeNotFound",
    });
    expect(answer.summary).toMatch(/deleted after its export was asked for/);
  });

  it("refuses to draw another take's scene over this one's frames", async () => {
    const { takeId, original, deps } = await pinnedTake();
    const other = {
      ...original,
      meta: { ...original.meta, id: "scene-other" },
    };
    await expect(
      exportTake(
        { takeId },
        { ...deps, pinned: { scene: other, notes: [] } },
        () => undefined,
      ),
    ).rejects.toThrow(
      `export of ${takeId} was handed the scene of scene-other`,
    );
  });
});

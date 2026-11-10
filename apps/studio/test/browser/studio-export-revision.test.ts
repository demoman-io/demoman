import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLibrary, exportTake } from "@demoman/runner/studio";
import type { StudioEvent } from "@demoman/studio-protocol";
import { afterEach, describe, expect, it } from "vitest";
import { launch } from "../../../runner/src/launch.js";
import { DISK_TAKE_RED, makeDiskTake } from "../../../runner/test/disk-take.js";
import { sampleImage, sampleMp4 } from "../../../runner/test/mp4-probe.js";
import { createExportQueue } from "../../src/queue.js";
import { createRunExport } from "../../src/run-export.js";

// DEM-100: an export renders the scene it was queued with. Two exports are
// queued behind a held turn, the take is switched to 9:16 on disk, and only
// then does the queue move. Both outputs must decode in the queued shape.
//
// Measured locally (2026-11-09, M-series Mac, headless): 5.6 s, two runs,
// with the MP4 at "share". At the default quality it was 7.3 s here, 33 s
// on CI's first run (4.5x) and over 60 s on its second, a loaded runner
// (job 129553558493). 150 s is 25x the local time.
const LANE_MS = 150_000;

const homes: string[] = [];
afterEach(async () => {
  for (const home of homes.splice(0))
    await rm(home, { recursive: true, force: true });
});

describe("a Studio export renders the scene it was queued with", () => {
  it(
    "keeps the queued aspect when the take is switched to 9:16 before its turn",
    async () => {
      const home = await mkdtemp(join(tmpdir(), "studio-revision-"));
      homes.push(home);
      const { takeId } = await makeDiskTake(home);
      const library = createLibrary(home);
      const before = await library.getSceneRead(takeId);
      if (before === null) throw new Error("the disk take did not land");
      expect(
        before.scene.canvas.aspect,
        "the premise: the take is not portrait when queued",
      ).not.toBe("9:16");

      const events: StudioEvent[] = [];
      const launched = await launch({ headless: true });
      try {
        const run = createRunExport({
          exportTake,
          deps: {
            library,
            videos: { videoOf: async () => null, get: async () => null },
            session: {
              headless: true,
              openWorkPage: async () => ({
                ok: true as const,
                page: await launched.context.newPage(),
              }),
            },
            home,
            wallpapersDir: join(
              import.meta.dirname,
              "..",
              "..",
              "pages",
              "public",
              "wallpapers",
            ),
            outDir: join(home, "out"),
            log: () => undefined,
            door: "studio",
          },
        });
        const queue = createExportQueue({
          library,
          events: { send: (e) => void events.push(e) },
          run,
          log: () => undefined,
        });

        // A turn ahead of both exports holds the queue until the edit lands.
        let release = () => {};
        const held = queue.serial(
          () => new Promise<void>((r) => (release = r)),
        );
        for (const fileType of ["mp4", "gif"] as const) {
          const answer = await queue.start(takeId, {
            fileType,
            revision: before.revision,
            // The smallest MP4: the shape is the question, not the quality.
            ...(fileType === "mp4" ? { quality: "share" as const } : {}),
          });
          expect(answer, JSON.stringify(answer)).toHaveProperty("jobId");
        }

        const put = await library.putSceneIf(
          {
            ...before.scene,
            canvas: { ...before.scene.canvas, aspect: "9:16" },
          },
          before.revision,
        );
        expect(put, "the edit was written").toMatchObject({ ok: true });
        const after = await library.getSceneRead(takeId);
        expect(
          [after?.scene.canvas.aspect, after?.revision !== before.revision],
          "the premise: the edit is on disk before either export renders",
        ).toEqual(["9:16", true]);
        expect(
          events.filter((e) => e.type === "export").map((e) => e.phase),
          "the premise: nothing has rendered yet",
        ).toEqual(["queued", "queued"]);

        release();
        await held;
        await queue.drained();

        const ends = events.filter(
          (e): e is Extract<StudioEvent, { type: "export" }> =>
            e.type === "export" &&
            (e.phase === "saved" || e.phase === "failed"),
        );
        const saved = ends.map((e) =>
          e.phase === "saved" ? e.report : undefined,
        );
        expect(
          ends.map((e) => e.phase),
          JSON.stringify(ends),
        ).toEqual(["saved", "saved"]);

        const [mp4, gif] = saved;
        if (mp4?.outcome !== "saved" || gif?.outcome !== "saved")
          throw new Error(JSON.stringify(ends));
        if (!("file" in mp4) || !("file" in gif))
          throw new Error(JSON.stringify(ends));
        const mp4Read = await sampleMp4(await readFile(mp4.file.path), {
          colors: [DISK_TAKE_RED],
        });
        const gifRead = await sampleImage(
          await readFile(gif.file.path),
          "image/gif",
          { colors: [DISK_TAKE_RED] },
        );
        const shapes = [
          [mp4.aspect, mp4Read.width > mp4Read.height],
          [gif.aspect, gifRead.width > gifRead.height],
        ];
        expect(
          shapes,
          `decoded mp4 ${mp4Read.width}x${mp4Read.height}, gif ${gifRead.width}x${gifRead.height}`,
        ).toEqual([
          [before.scene.canvas.aspect, true],
          [before.scene.canvas.aspect, true],
        ]);
      } finally {
        await launched.close();
      }
    },
    LANE_MS,
  );
});

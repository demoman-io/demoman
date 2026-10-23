// Slow tier: exports three mp4s in software. `pnpm test:fast` skips it; `pnpm test` and CI run it.
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FrameBundle } from "@demoman/compositor";
import type { ExportAnswer } from "@demoman/run-core";
import type { SceneDocument } from "@demoman/scene-schema";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLocalExecutor } from "../src/executor/executor.js";
import type { LocalExecutor } from "../src/executor/types.js";
import {
  DISK_TAKE_INK,
  DISK_TAKE_RED,
  editedScene,
  makeDiskTake,
  putTake,
} from "./disk-take.js";
import { sampleMp4 } from "./mp4-probe.js";

// Text overlays left with schema 12 (spec 2026-10-22 split-tool): the
// export shows a typed step as it was filmed, and says when scene.json has
// other text for it or when the migration took an overlay away.
//
// The take is built on disk rather than run: frames painted in a page show
// the typed text "northwind" in pure red inside the search field (the rect
// `readonlyScene` and its bundle both record for `a-search`), so the
// original is a colour the picture can count, and the overlay ink an old
// export drew (`#111827`) is another.

// Measured locally (2026-10-14, M-series Mac, headless): one export of this
// take 17–18 s. x5 for CI (fff4505) is about 90 s.
const EXPORT_MS = 120_000;

let home: string;
let executor: LocalExecutor;
let bundle: FrameBundle;
const lines: string[] = [];
let original: SceneDocument;
let takeId: string;

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), "demoman-retext-"));
  executor = createLocalExecutor({
    home,
    headless: true,
    outDir: join(home, "out"),
    log: (l) => void lines.push(l),
  });
  ({ takeId, original, bundle } = await makeDiskTake(home));
}, EXPORT_MS);

afterAll(async () => {
  await executor.close();
  await rm(home, { recursive: true, force: true });
});

/** Every case puts the scene AND the bundle it reads (see `putTake`). */
function put(scene: SceneDocument, frames: FrameBundle) {
  return putTake(home, takeId, scene, frames);
}

let calls = 0;
async function exportTake(): Promise<ExportAnswer> {
  const out = await executor.request("export", {
    takeId,
    callId: `retext-${++calls}`,
  });
  if (!out.ok) throw new Error(JSON.stringify(out));
  return out.value as ExportAnswer;
}

/** Red (the frames' own typed text) and ink (what an overlay drew) at the
 *  video's last reading. */
async function lastPicture(answer: ExportAnswer) {
  if (answer.outcome !== "saved" || answer.fileType === "stills")
    throw new Error(JSON.stringify(answer));
  const read = await sampleMp4(await readFile(answer.file.path), {
    colors: [DISK_TAKE_RED, DISK_TAKE_INK],
  });
  const last = read.readings[read.readings.length - 1];
  if (last === undefined) throw new Error("the video has no readings");
  return {
    red: last.colorCounts[0] ?? 0,
    ink: last.colorCounts[1] ?? 0,
    readings: read.readings.length,
  };
}

describe("a CLI take's typed-text edit, on the picture", () => {
  let unedited: { red: number; ink: number };

  it(
    "unedited: the frames' own typed text shows",
    async () => {
      await put(original, bundle);
      const answer = await exportTake();
      expect(answer.outcome, JSON.stringify(answer)).toBe("saved");
      unedited = await lastPicture(answer);
      // The fixture's premise: the original text is on screen to be counted.
      expect(unedited.red, JSON.stringify(unedited)).toBeGreaterThan(60);
    },
    EXPORT_MS,
  );

  it(
    "retyped: the export shows the filmed text, and says the video still shows it",
    async () => {
      await put(editedScene(original, "WWWWWWWWWWWWWW"), bundle);
      const answer = await exportTake();
      expect(answer.outcome, JSON.stringify(answer)).toBe("saved");
      const edited = await lastPicture(answer);
      const evidence = JSON.stringify({ unedited, edited, lines });
      // Nothing covers the old text, and no ink is drawn over it.
      expect(edited.red, evidence).toBeGreaterThan(unedited.red * 0.9);
      expect(edited.ink - unedited.ink, evidence).toBeLessThan(10);
      expect(answer.summary).toContain("the video still shows the old text");
    },
    EXPORT_MS,
  );

  it(
    "a take with an overlay from before schema 12 says it was removed",
    async () => {
      await put(original, bundle);
      const path = join(home, "takes", takeId, "scene.json");
      const v11 = JSON.parse(await readFile(path, "utf8"));
      v11.schemaVersion = 11;
      delete v11.edits.splits;
      delete v11.edits.removed;
      v11.edits.replacements = [
        { id: "rep", targetAnchorId: "a-search", find: null, replace: "x" },
      ];
      await writeFile(path, JSON.stringify(v11));
      const answer = await exportTake();
      expect(answer.outcome, JSON.stringify(answer)).toBe("saved");
      const shown = await lastPicture(answer);
      expect(shown.red, JSON.stringify({ unedited, shown })).toBeGreaterThan(
        unedited.red * 0.9,
      );
      if (answer.outcome !== "saved") throw new Error("not saved");
      expect(answer.warnings.migration).toEqual([
        "1 text overlay was removed from this take: the video shows the text that was recorded.",
      ]);
      expect(answer.summary).toContain("1 text overlay was removed");
    },
    EXPORT_MS,
  );
});

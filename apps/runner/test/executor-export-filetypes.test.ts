import { chmod, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  composeForTarget,
  type FrameBundle,
  planScene,
} from "@demoman/compositor";
import { type ExportAnswer, frameOf, targetFor } from "@demoman/run-core";
import type { SceneDocument } from "@demoman/scene-schema";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Rgb } from "../src/decode-probe-entry.js";
import { createLocalExecutor } from "../src/executor/executor.js";
import type { LocalExecutor } from "../src/executor/types.js";
import {
  DISK_TAKE_INK,
  DISK_TAKE_RED,
  editedScene,
  makeDiskTake,
  putTake,
} from "./disk-take.js";
import { sampleImage } from "./mp4-probe.js";

// Measured locally (2026-10-15, M-series Mac, headless): a GIF export 2.2-2.7 s,
// stills 1.3 s, the default MP4 15.8 s. x5 for CI (fff4505) is about 80 s for
// the MP4, the slowest.
const EXPORT_MS = 120_000;

let home: string;
let outDir: string;
let executor: LocalExecutor;
let take: { takeId: string; original: SceneDocument; bundle: FrameBundle };
let calls = 0;

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), "demoman-filetypes-"));
  outDir = join(home, "out");
  executor = createLocalExecutor({
    home,
    headless: true,
    outDir,
    log: () => undefined,
  });
  take = await makeDiskTake(home);
}, EXPORT_MS);

afterAll(async () => {
  await executor.close();
  await chmod(outDir, 0o700).catch(() => undefined);
  await rm(home, { recursive: true, force: true });
});

async function exportAs(
  fileType?: string,
  more: Record<string, unknown> = {},
): Promise<ExportAnswer> {
  const out = await executor.request("export", {
    takeId: take.takeId,
    callId: `ft-${++calls}`,
    ...(fileType === undefined ? {} : { fileType }),
    ...more,
  });
  if (!out.ok) throw new Error(JSON.stringify(out));
  return out.value as ExportAnswer;
}
const RED_FAMILY: Rgb[] = [
  DISK_TAKE_RED,
  [240, 50, 50],
  [225, 90, 90],
  [210, 130, 130],
];
const lastCounts = async (
  bytes: Uint8Array,
  type: "image/gif" | "image/png",
) => {
  const read = await sampleImage(bytes, type, {
    colors: [DISK_TAKE_RED, DISK_TAKE_INK],
  });
  const last = read.readings.at(-1);
  if (last === undefined) throw new Error("no readings");
  return { read, red: last.colorCounts[0] ?? 0, ink: last.colorCounts[1] ?? 0 };
};

describe("export({ fileType: 'gif' }), on the picture", () => {
  let unedited: { red: number; ink: number } | undefined;

  it(
    "saves a GIF at the GIF target, showing the frames' own typed text",
    async () => {
      await putTake(home, take.takeId, take.original, take.bundle);
      const answer = await exportAs("gif");
      expect(answer, JSON.stringify(answer)).toMatchObject({
        outcome: "saved",
        fileType: "gif",
      });
      if (answer.outcome !== "saved" || answer.fileType === "stills") return;
      // The scene is named, so the file is named for it (sceneLabel).
      expect(answer.file.path).toBe(
        join(outDir, `${take.original.meta.name}.gif`),
      );
      const counts = await lastCounts(
        await readFile(answer.file.path),
        "image/gif",
      );
      expect([counts.read.width, counts.read.height]).toEqual([
        answer.width,
        answer.height,
      ]);
      // Twice the GIF target's width, sharp on a Retina screen: this take
      // fits the budget there, and its recording backs that width. Red if
      // the CLI renders the target itself, the 800 px GIF that looked soft.
      const gifTarget = targetFor(
        "gif",
        take.original.canvas.aspect,
        take.bundle,
        frameOf(take.original),
      );
      expect(answer.width).toBe(gifTarget.width * 2);
      expect(
        answer.warnings.gifSize,
        JSON.stringify(answer.warnings),
      ).toMatchObject({ maxBytes: 10_000_000, refused: [] });
      // The premise: at that width the window is still drawn no wider
      // than the recording, so nothing is stretched and no width was
      // refused for detail. Measured as the ladder measures it.
      const composed = composeForTarget({
        plan: planScene(take.original),
        bundle: take.bundle,
        scene: take.original,
        target: { ...gifTarget, width: answer.width, height: answer.height },
      });
      const windowWidth = composed.presentation.frameRect.width;
      const recorded = take.bundle.keyframes[0]?.width ?? 0;
      expect(
        windowWidth,
        JSON.stringify({ windowWidth, recorded }),
      ).toBeLessThanOrEqual(recorded);
      // And twice the target's window is more than the target's own: the
      // wider GIF really does draw more of the recording's pixels.
      expect(windowWidth).toBeGreaterThan(recorded / 2);
      expect(
        counts.read.frameCount,
        "the GIF is animated: more than one frame",
      ).toBeGreaterThan(1);
      // The premise: the original red text is on screen for the edit below to cover.
      expect(counts.red, JSON.stringify(counts)).toBeGreaterThan(20);
      unedited = counts;
    },
    EXPORT_MS,
  );

  // Text overlays left with schema 12: a GIF shows a retyped step as filmed.
  it(
    "shows the filmed text in the GIF for a retyped step",
    async () => {
      await putTake(
        home,
        take.takeId,
        editedScene(take.original, "WWWWWWWWWWWWWW"),
        take.bundle,
      );
      const answer = await exportAs("gif");
      if (answer.outcome !== "saved" || answer.fileType === "stills")
        throw new Error(JSON.stringify(answer));
      if (unedited === undefined)
        throw new Error(
          "the previous case did not leave its unedited counts, so there is nothing to compare the edit against",
        );
      const edited = await lastCounts(
        await readFile(answer.file.path),
        "image/gif",
      );
      const evidence = JSON.stringify({ unedited, edited });
      expect(edited.red, evidence).toBeGreaterThan(unedited.red * 0.75);
      expect(edited.ink - unedited.ink, evidence).toBeLessThan(10);
      expect(answer.summary).toContain("the video still shows the old text");
    },
    EXPORT_MS,
  );

  // Spec section 9: the picture must show the zoom the scene authored.
  it(
    "magnifies the typed text in the GIF when the scene zooms on its field",
    async () => {
      const zoomed: SceneDocument = {
        ...take.original,
        camera: [
          {
            id: "cam-search",
            kind: "zoom",
            anchorId: "a-search",
            marker: { actionId: "act-1", offsetMs: -300 },
            scale: 2.2,
          },
        ],
      };
      // The premises: the unzoomed take has no camera, the zoomed one holds
      // exactly the zoom on the field the red text sits in.
      expect(take.original.camera, "the disk take authors no zoom").toEqual([]);
      expect(
        zoomed.camera.map((c) => [c.kind, c.anchorId, c.scale]),
        "the scene holds the zoom",
      ).toEqual([["zoom", "a-search", 2.2]]);
      // The pointer rests on the field, so the camera's follow keeps the zoom
      // on the typed text instead of drifting to the cursor's later target.
      const resting: FrameBundle = {
        ...take.bundle,
        cursorSamples: [
          { sourceTimeMs: 0, x: 200, y: 42 },
          { sourceTimeMs: 9000, x: 210, y: 42 },
        ],
      };
      const peakRed = async (scene: SceneDocument) => {
        await putTake(home, take.takeId, scene, resting);
        const answer = await exportAs("gif");
        if (answer.outcome !== "saved" || answer.fileType === "stills")
          throw new Error(JSON.stringify(answer));
        // The camera's pan blurs the glyphs while it moves, so pure red alone
        // reads 0 mid-zoom; count the red family (pure red and its washed-out
        // shades), which the blur spreads the glyphs' pixels across.
        const read = await sampleImage(
          await readFile(answer.file.path),
          "image/gif",
          { colors: RED_FAMILY },
        );
        const perReading = read.readings.map((r) =>
          r.colorCounts.reduce((a, b) => a + b, 0),
        );
        return { peak: Math.max(...perReading), perReading };
      };
      const plain = await peakRed(take.original);
      const zoom = await peakRed(zoomed);
      const evidence = JSON.stringify({ plain, zoom });
      expect(
        plain.peak,
        `the unzoomed GIF shows red text: ${evidence}`,
      ).toBeGreaterThan(20);
      expect(zoom.peak, evidence).toBeGreaterThan(plain.peak * 1.5);
    },
    EXPORT_MS,
  );

  // Review Focus 3.
  it(
    "saves a 9:16 GIF in portrait, at the size the answer names",
    async () => {
      await putTake(
        home,
        take.takeId,
        { ...take.original, canvas: { aspect: "9:16" } },
        take.bundle,
      );
      const answer = await exportAs("gif");
      if (answer.outcome !== "saved" || answer.fileType === "stills")
        throw new Error(JSON.stringify(answer));
      expect(answer.height).toBeGreaterThan(answer.width);
      const { read } = await lastCounts(
        await readFile(answer.file.path),
        "image/gif",
      );
      expect([read.width, read.height]).toEqual([answer.width, answer.height]);
    },
    EXPORT_MS,
  );
});

describe("export({ fileType: 'stills' }), on the picture", () => {
  it(
    "saves one PNG per step in a folder, each at the stills target",
    async () => {
      await putTake(home, take.takeId, take.original, take.bundle);
      const answer = await exportAs("stills");
      expect(answer, JSON.stringify(answer)).toMatchObject({
        outcome: "saved",
        fileType: "stills",
      });
      if (answer.outcome !== "saved" || answer.fileType !== "stills") return;
      expect(answer.folder.path).toBe(
        join(outDir, `${take.original.meta.name} stills`),
      );
      // The premise: the disk take has three steps, each with a marker.
      expect(take.bundle.markers.map((m) => m.actionId)).toEqual([
        "act-1",
        "act-2",
        "act-3",
      ]);
      const names = ["act-1.png", "act-2.png", "act-3.png"];
      expect((await readdir(answer.folder.path)).sort()).toEqual(names);
      expect(answer.folder.files.map((f) => f.name).sort()).toEqual(names);
      const bytes = await Promise.all(
        names.map((n) => readFile(join(answer.folder.path, n))),
      );
      for (const png of bytes) {
        const counts = await lastCounts(png, "image/png");
        expect([counts.read.width, counts.read.height]).toEqual([
          answer.width,
          answer.height,
        ]);
      }
      const first = await lastCounts(bytes[0] as Buffer, "image/png");
      expect(first.red, JSON.stringify(first)).toBeGreaterThan(20);
      // Each still is its own step's frame: a bug serving the first file's
      // bytes for every still would leave these equal.
      expect(
        (bytes[0] as Buffer).equals(bytes[2] as Buffer),
        "act-1.png and act-3.png are byte-identical",
      ).toBe(false);
      expect(answer.summary).toMatch(/^Saved 3 stills in /);
    },
    EXPORT_MS,
  );

  // Review Focus 1. Red if a take with no step left answers saved, or fails silently.
  it(
    "says a take with every step cut has no stills, and saves nothing",
    async () => {
      const cut: SceneDocument = {
        ...take.original,
        edits: {
          ...take.original.edits,
          removed: [{ id: "all", start: null, end: null }],
        },
      };
      expect(
        cut.edits.removed,
        "the premise: one piece, the whole take, is removed",
      ).toEqual([{ id: "all", start: null, end: null }]);
      await putTake(home, take.takeId, cut, take.bundle);
      const before = await readdir(outDir).catch(() => [] as string[]);
      const answer = await exportAs("stills");
      expect(answer).toMatchObject({ outcome: "renderFailed" });
      if (answer.outcome === "renderFailed")
        expect(answer.error).toMatch(/nothing left to render/);
      expect(await readdir(outDir).catch(() => [] as string[])).toEqual(before);
    },
    EXPORT_MS,
  );

  // A step with no still must be said, not just missing from the folder.
  // Removing act-2's stretch would not do: it runs on to the take's end, so
  // act-3 gets no frame either (compositor stillBeats) and only one PNG is
  // left. Removing act-1's stretch leaves act-2's frame, which does land.
  it(
    "names the step that got no still, and writes only the other two",
    async () => {
      const cutOne: SceneDocument = {
        ...take.original,
        edits: {
          ...take.original.edits,
          removed: [
            {
              id: "cut-act-1",
              start: { actionId: "act-1", sourceOffsetMs: 0 },
              end: { actionId: "act-2", sourceOffsetMs: 0 },
            },
          ],
        },
      };
      expect(
        take.original.actions.map((x) => x.id),
        "the premise: the take has exactly three steps",
      ).toEqual(["act-1", "act-2", "act-3"]);
      expect(
        cutOne.edits.removed.map((r) => r.start?.actionId),
        "the premise: act-1's stretch is the only piece removed",
      ).toEqual(["act-1"]);
      await putTake(home, take.takeId, cutOne, take.bundle);
      const answer = await exportAs("stills");
      expect(answer, JSON.stringify(answer)).toMatchObject({
        outcome: "saved",
        fileType: "stills",
      });
      if (answer.outcome !== "saved" || answer.fileType !== "stills")
        throw new Error(JSON.stringify(answer));
      expect(answer.warnings.unplacedStills?.map((u) => u.actionId)).toEqual([
        "act-1",
      ]);
      expect(answer.summary).toMatch(/1 step got no still \(act-1: /);
      expect(await readdir(answer.folder.path)).toHaveLength(2);
    },
    EXPORT_MS,
  );

  // Review Focus 4.
  it(
    "refuses before rendering when the export folder cannot be written",
    async () => {
      await putTake(home, take.takeId, take.original, take.bundle);
      await chmod(outDir, 0o500);
      try {
        const answer = await exportAs("stills");
        expect(answer).toMatchObject({
          outcome: "saveFailed",
          beforeRender: true,
          fileType: "stills",
        });
        // Red if the sentence speaks of a video nobody asked for.
        expect(answer.summary).toMatch(
          /^Nothing was rendered, because the stills could not be saved there: /,
        );
      } finally {
        await chmod(outDir, 0o700);
      }
    },
    EXPORT_MS,
  );
});

describe("export's file type argument", () => {
  it("refuses a file type it does not make, naming the three it does", async () => {
    const answer = await exportAs("webm");
    expect(answer).toMatchObject({
      outcome: "refusedBeforeExport",
      reason: "invalidFileType",
    });
    if (answer.outcome === "refusedBeforeExport")
      expect(answer.detail).toMatch(/mp4, gif or stills/);
  });

  // `null` and objects are not "no argument": each is refused, by type.
  it("refuses a file type that is not a string, naming what it is", async () => {
    for (const [value, named] of [
      [null, /not null/],
      [{ a: 1 }, /not object/],
      [7, /not number/],
    ] as const) {
      const out = await executor.request("export", {
        takeId: take.takeId,
        callId: `ft-${++calls}`,
        fileType: value,
      });
      if (!out.ok) throw new Error(JSON.stringify(out));
      const answer = out.value as ExportAnswer;
      expect(answer, JSON.stringify(answer)).toMatchObject({
        outcome: "refusedBeforeExport",
        reason: "invalidFileType",
      });
      if (answer.outcome === "refusedBeforeExport")
        expect(answer.detail).toMatch(named);
    }
  });

  it(
    "exports MP4 when no file type is given",
    async () => {
      await putTake(home, take.takeId, take.original, take.bundle);
      const answer = await exportAs();
      expect(answer).toMatchObject({ outcome: "saved", fileType: "mp4" });
    },
    EXPORT_MS,
  );
});

describe("export({ fileType: 'stills', stills }), size and zoom", () => {
  const stillsTarget = () =>
    targetFor(
      "stills",
      take.original.canvas.aspect,
      take.bundle,
      frameOf(take.original),
    );
  const windowAt = (width: number, height: number) =>
    composeForTarget({
      plan: planScene(take.original),
      bundle: take.bundle,
      scene: take.original,
      target: { ...stillsTarget(), width, height },
    }).presentation.frameRect.width;
  const savedStills = async (stills?: Record<string, unknown>) => {
    const answer = await exportAs(
      "stills",
      stills === undefined ? {} : { stills },
    );
    if (answer.outcome !== "saved" || answer.fileType !== "stills") {
      throw new Error(JSON.stringify(answer));
    }
    return answer;
  };
  const pngSize = async (path: string) => {
    const read = await sampleImage(await readFile(path), "image/png", {
      colors: [DISK_TAKE_RED],
    });
    return [read.width, read.height];
  };

  // Red if the default stretches this 1280 px, DPR 1 recording to fill the
  // 2560 px stills target.
  it(
    "by default draws the window no wider than the recording",
    async () => {
      await putTake(home, take.takeId, take.original, take.bundle);
      const recorded = take.bundle.keyframes[0]?.width ?? 0;
      // The premise: at the stills target the window is wider than this
      // recording, so the default has something to narrow.
      const target = stillsTarget();
      expect(windowAt(target.width, target.height)).toBeGreaterThan(recorded);

      const answer = await savedStills({});
      expect(answer.width).toBeLessThan(target.width);
      // Within a pixel of the recording: the target is scaled whole.
      expect(
        Math.abs(windowAt(answer.width, answer.height) - recorded),
      ).toBeLessThanOrEqual(2);
      expect(await pngSize(join(answer.folder.path, "act-1.png"))).toEqual([
        answer.width,
        answer.height,
      ]);
    },
    EXPORT_MS,
  );

  it(
    "draws each still at the width asked for",
    async () => {
      await putTake(home, take.takeId, take.original, take.bundle);
      const answer = await savedStills({ width: 1000 });
      expect(answer.width).toBe(1000);
      expect(await pngSize(join(answer.folder.path, "act-1.png"))).toEqual([
        answer.width,
        answer.height,
      ]);
    },
    EXPORT_MS,
  );

  // Red if `zoom: "step"` is ignored, or the default zooms.
  it(
    "shows the whole window by default and the step's zoom when asked",
    async () => {
      const zoomed: SceneDocument = {
        ...take.original,
        camera: [
          {
            id: "cam-search",
            kind: "zoom",
            anchorId: "a-search",
            marker: { actionId: "act-1", offsetMs: -300 },
            scale: 2.2,
          },
        ],
      };
      await putTake(home, take.takeId, zoomed, take.bundle);
      const redOf = async (stills: Record<string, unknown>) => {
        const answer = await savedStills({ width: 1000, ...stills });
        const read = await sampleImage(
          await readFile(join(answer.folder.path, "act-1.png")),
          "image/png",
          { colors: RED_FAMILY },
        );
        return (read.readings.at(-1)?.colorCounts ?? []).reduce(
          (a, b) => a + b,
          0,
        );
      };
      const whole = await redOf({});
      const step = await redOf({ zoom: "step" });
      // The premise: the red text is on screen in the whole window.
      expect(whole).toBeGreaterThan(20);
      // Zoomed in on its field, the text covers far more of the still.
      expect(step, JSON.stringify({ whole, step })).toBeGreaterThan(whole * 2);
    },
    EXPORT_MS,
  );

  it(
    "refuses stills options it cannot follow, naming what it takes",
    async () => {
      await putTake(home, take.takeId, take.original, take.bundle);
      for (const [fileType, stills, said] of [
        ["gif", { width: 1000 }, /only to stills/],
        ["stills", { width: 100 }, /320 to 3840/],
        ["stills", { width: 1000.5 }, /320 to 3840/],
        ["stills", { width: "huge" }, /native/],
        ["stills", { zoom: "video" }, /"none" .* or "step"/],
        ["stills", "big", /an object/],
        ["stills", { widht: 1920 }, /width and zoom, not widht/],
      ] as const) {
        const answer = await exportAs(fileType, { stills });
        expect(answer, JSON.stringify(answer)).toMatchObject({
          outcome: "refusedBeforeExport",
          reason: "invalidStillsOptions",
        });
        if (answer.outcome === "refusedBeforeExport") {
          expect(answer.detail).toMatch(said);
        }
      }
    },
    EXPORT_MS,
  );
});

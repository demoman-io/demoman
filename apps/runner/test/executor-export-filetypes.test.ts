import {
  chmod,
  copyFile,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  composeForTarget,
  type FrameBundle,
  planScene,
} from "@demoman/compositor";
import { type ExportAnswer, frameOf, targetFor } from "@demoman/run-core";
import type { SceneDocument } from "@demoman/scene-schema";
import { ALL_FORMATS, BufferSource, Input } from "mediabunny";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Rgb } from "../src/decode-probe-entry.js";
import { createLocalExecutor } from "../src/executor/executor.js";
import { readTag, tagBytes } from "../src/executor/export-tag.js";
import { createLibrary } from "../src/executor/library.js";
import type { LocalExecutor } from "../src/executor/types.js";
import { createVideoStore } from "../src/executor/videos.js";
import {
  DISK_TAKE_INK,
  DISK_TAKE_RED,
  editedScene,
  makeDiskTake,
  putTake,
} from "./disk-take.js";
import { WALLPAPERS_DIR } from "./fixture.js";
import { sampleImage, sampleMp4 } from "./mp4-probe.js";

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
    wallpapersDir: WALLPAPERS_DIR,
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

/** Top-level box types of an MP4, in file order. */
function topBoxes(b: Uint8Array): string[] {
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const out: string[] = [];
  for (let at = 0; at + 8 <= b.length; at += view.getUint32(at)) {
    out.push(String.fromCharCode(...b.subarray(at + 4, at + 8)));
    if (view.getUint32(at) < 8) break;
  }
  return out;
}

/** The mdat box, header included. */
function mdatOf(b: Uint8Array): Uint8Array {
  const at = Buffer.from(b).indexOf("mdat") - 4;
  const size = new DataView(b.buffer, b.byteOffset).getUint32(at);
  return b.slice(at, at + size);
}

/** Every stco/co64 chunk offset in the file, in order. */
function chunkOffsets(b: Uint8Array): number[] {
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const text = Buffer.from(b);
  const out: number[] = [];
  for (const [kind, width] of [
    ["stco", 4],
    ["co64", 8],
  ] as const) {
    for (let i = text.indexOf(kind); i >= 0; i = text.indexOf(kind, i + 4)) {
      const count = view.getUint32(i + 8);
      for (let n = 0; n < count; n++) {
        const at = i + 12 + n * width;
        out.push(
          width === 4 ? view.getUint32(at) : Number(view.getBigUint64(at)),
        );
      }
    }
  }
  return out;
}

let untaggedMp4 = "";

describe("exports carry their video and version", () => {
  const videoJson = () => join(home, "takes", take.takeId, "video.json");
  // Written as a join writes it: the tag reads the membership, and a join
  // proper refuses a video with no record.
  const join1 = () =>
    writeFile(
      videoJson(),
      JSON.stringify({
        videoId: "video-under-test",
        made: {
          repo: { none: "test" },
          agent: { none: "test" },
          by: { none: "test" },
          door: "mcp",
        },
        recordedRevision: null,
      }),
    );

  it(
    "leaves a take in no video untagged, with no warning",
    async () => {
      await putTake(home, take.takeId, take.original, take.bundle);
      await rm(videoJson(), { force: true });
      const answer = await exportAs("mp4");
      if (answer.outcome !== "saved" || answer.fileType === "stills")
        throw new Error(JSON.stringify(answer));
      expect(readTag(await readFile(answer.file.path))).toHaveProperty("none");
      expect(answer.warnings.untagged).toBeUndefined();
      // Kept: the tagged export below is compared against these bytes.
      untaggedMp4 = join(home, "untagged.mp4");
      await copyFile(answer.file.path, untaggedMp4);
    },
    EXPORT_MS,
  );

  it(
    "tags the MP4, GIF and every still, and the MP4 still decodes",
    async () => {
      await putTake(home, take.takeId, take.original, take.bundle);
      await join1();
      const want = { found: { video: "video-under-test", take: take.takeId } };

      const mp4 = await exportAs("mp4");
      if (mp4.outcome !== "saved" || mp4.fileType === "stills")
        throw new Error(JSON.stringify(mp4));
      const bytes = new Uint8Array(await readFile(mp4.file.path));
      // The tag's byte invariants are shown on the untagged export's own
      // bytes, tagged here: two encodes of one take are not byte-identical
      // on CI (mdat 432,737 vs 436,861 bytes on 2026-10-25), so comparing
      // this export with that one tested the encoder, not the tag.
      const plain = new Uint8Array(await readFile(untaggedMp4));
      // The premise the chunk-offset shift is for: the real sink writes moov
      // before mdat. If it stops, the shift is untested here; say so.
      expect(topBoxes(plain), "the real sink's box order").toEqual([
        "ftyp",
        "moov",
        "mdat",
      ]);
      const tagged = tagBytes("mp4", plain, want.found);
      if (!tagged.ok) throw new Error(tagged.error);
      // Tagging moved nothing but moov's own size: mdat is byte-identical,
      // and each chunk offset moved by the tag's size. Compared as one
      // boolean: a failed toEqual on ~430 KB printed a per-byte diff for
      // 44 minutes.
      expect(
        Buffer.from(mdatOf(tagged.bytes)).equals(mdatOf(plain)),
        "mdat is byte-identical after tagging",
      ).toBe(true);
      const delta = tagged.bytes.length - plain.length;
      expect(delta, "the tag grew the file").toBeGreaterThan(0);
      const offsets = chunkOffsets(tagged.bytes);
      expect(offsets.length, "the fixture has chunks to move").toBeGreaterThan(
        0,
      );
      expect(offsets).toEqual(chunkOffsets(plain).map((o) => o + delta));
      // The picture: the tagged file decodes to the untagged file's frames.
      // Metadata and offsets can look right while the samples are read from
      // the wrong bytes; only decoding says they are not.
      const probe = { colors: [DISK_TAKE_RED, DISK_TAKE_INK] };
      const before = await sampleMp4(plain, probe);
      const after = await sampleMp4(tagged.bytes, probe);
      expect(before.readings.length, "the probe read frames").toBeGreaterThan(
        1,
      );
      expect(
        before.readings.some((r) => (r.colorCounts[0] ?? 0) > 0),
        "the untagged picture shows the take's red text",
      ).toBe(true);
      expect(after, "tagged decodes as untagged").toEqual(before);
      // The export itself went through the tagger: its tag reads back, and
      // its samples decode to the take's picture.
      expect(readTag(bytes)).toEqual(want);
      expect(
        (await sampleMp4(bytes, probe)).readings.some(
          (r) => (r.colorCounts[0] ?? 0) > 0,
        ),
        "the tagged export shows the take's red text",
      ).toBe(true);
      expect(mp4.warnings.untagged).toBeUndefined();
      const duration = await new Input({
        source: new BufferSource(bytes),
        formats: ALL_FORMATS,
      }).computeDuration();
      expect(duration).toBeGreaterThan(0);
      expect(mp4.file.byteLength).toBe(bytes.length);

      const gif = await exportAs("gif");
      if (gif.outcome !== "saved" || gif.fileType === "stills")
        throw new Error(JSON.stringify(gif));
      expect(readTag(await readFile(gif.file.path))).toEqual(want);
      // Still a GIF the picture reader decodes, with its frames.
      const counts = await lastCounts(
        await readFile(gif.file.path),
        "image/gif",
      );
      expect(counts.read.frameCount).toBeGreaterThan(1);

      const stills = await exportAs("stills");
      if (stills.outcome !== "saved" || stills.fileType !== "stills")
        throw new Error(JSON.stringify(stills));
      expect(stills.folder.files.length).toBeGreaterThan(0);
      for (const f of stills.folder.files) {
        const png = await readFile(join(stills.folder.path, f.name));
        expect(readTag(png), f.name).toEqual(want);
        expect((await lastCounts(png, "image/png")).read.width).toBe(
          stills.width,
        );
      }
    },
    EXPORT_MS * 2,
  );

  // Red: `exportBaseName(sceneLabel(scene.meta))` alone names the file
  // after the take, whatever its video is called.
  it(
    "names the file after the take's video",
    async () => {
      await putTake(home, take.takeId, take.original, take.bundle);
      const store = createVideoStore(home, createLibrary(home));
      const made = await store.create({
        name: "Video name under test",
        repo: { unknown: true },
        startPage: "x",
      });
      if (!made.ok) throw new Error(JSON.stringify(made));
      // Premise: the take's own label is not the video's name.
      expect(take.original.meta.name).not.toBe("Video name under test");
      await store.join(take.takeId, {
        videoId: made.video.id,
        made: {
          repo: { none: "test" },
          agent: { none: "test" },
          by: { none: "test" },
          door: "mcp",
        },
        recordedRevision: null,
      });
      const answer = await exportAs("gif");
      if (answer.outcome !== "saved" || answer.fileType === "stills")
        throw new Error(JSON.stringify(answer));
      expect(answer.file.path).toBe(join(outDir, "Video name under test.gif"));
      await rm(videoJson(), { force: true });
    },
    EXPORT_MS,
  );

  it(
    "saves and says why when the take's video.json cannot be read",
    async () => {
      await putTake(home, take.takeId, take.original, take.bundle);
      await writeFile(videoJson(), "{not json");
      const answer = await exportAs("gif");
      if (answer.outcome !== "saved" || answer.fileType === "stills")
        throw new Error(JSON.stringify(answer));
      expect(answer.warnings.untagged?.error).toContain("video");
      expect(answer.summary).toContain("not tagged");
      expect(readTag(await readFile(answer.file.path))).toHaveProperty("none");
    },
    EXPORT_MS,
  );
});

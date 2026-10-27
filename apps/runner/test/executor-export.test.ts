import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LANDSCAPE_1080P } from "@demoman/compositor";
import {
  DEFAULT_EXPORT_QUALITY,
  type ExportAnswer,
  fileSize,
  frameOf,
  targetFor,
} from "@demoman/run-core";
import type { SceneDocument } from "@demoman/scene-schema";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLocalExecutor } from "../src/executor/executor.js";
import { createLibrary } from "../src/executor/library.js";
import type { LocalExecutor } from "../src/executor/types.js";
import { createVideoStore } from "../src/executor/videos.js";
import {
  LOGO_SVG,
  makeFixtureTake,
  serveFixtureApp,
  videoOfTake,
} from "./fixture.js";
import { sampleMp4 } from "./mp4-probe.js";

// Measured locally (2026-10-17, M-series Mac, headless), beside
// executor-export-4k.slow.test.ts, x5 for CI (fff4505) with margin. A run
// of the fixture take: about 6 s. Landscape is capped at 1080p
// (`mp4MaxTier`, below): 16:9 26 s, Auto 36 s; uncapped they took the 4K
// tier and 128 s and 107 s. A 9:16 export (1080x1920): 18 s at the slowest.
const RUN_MS = 31_000;
const LANDSCAPE_EXPORT_MS = 300_000;
const VERTICAL_EXPORT_MS = 120_000;

const MAGENTA: [number, number, number] = [255, 0, 255];
const GREEN: [number, number, number] = [0, 200, 83];

let app: { url: string; close(): void };
let home: string;
let outDir: string;
let executor: LocalExecutor;
let takeId: string;
/** The take's video's name, which its exports are named after. */
let videoName: string;
const lines: string[] = [];

beforeAll(async () => {
  app = await serveFixtureApp();
  home = await mkdtemp(join(tmpdir(), "demoman-export-"));
  outDir = join(home, "out");
  executor = createLocalExecutor({
    home,
    headless: true,
    outDir,
    log: (l) => void lines.push(l),
    // Landscape at 1080p, not the 4K these keyframes back: 4K costs ~4x the
    // pixels in SwiftShader (128 s an export). executor-export-4k.slow.test.ts
    // is the one export that takes the uncapped tier.
    mp4MaxTier: LANDSCAPE_1080P,
  });
  takeId = await makeFixtureTake(executor, { home, url: app.url });
  const video = await createVideoStore(home, createLibrary(home)).get(
    (await videoOfTake(home, takeId)).id,
  );
  if (video === null) throw new Error(`take ${takeId}'s video has no record`);
  videoName = video.name;
}, RUN_MS);

afterAll(async () => {
  await executor.close();
  app.close();
  await chmod(outDir, 0o700).catch(() => undefined);
  await rm(home, { recursive: true, force: true });
});

const library = () => createLibrary(home);
async function setAspect(aspect: "auto" | "16:9" | "9:16"): Promise<void> {
  const lib = library();
  const doc = (await lib.getScene(takeId)) as SceneDocument;
  await lib.putScene({ ...doc, canvas: { aspect } });
}
// `quality: "full"` unless a case says otherwise: the cases that assert the
// tier's own geometry (1080p, 1080x1920) are about that tier, and the default
// export is share-sized since launch F1. The share cases ask for it by
// leaving `quality` out, through `exportWith`.
const exportNow = async (
  callId: string,
  extra: Record<string, unknown> = { quality: "full" },
) => {
  const out = await executor.request("export", { takeId, callId, ...extra });
  if (!out.ok) throw new Error(JSON.stringify(out));
  return out.value as ExportAnswer;
};

describe("the fixture take", () => {
  // The premises every picture below samples: a click the camera zoomed on,
  // and a cursor that moved. Without them a frame is a still of a page, and
  // "the export looks right" asserts nothing about the camera or cursor.
  it("zoomed on its click and moved its cursor", async () => {
    const lib = library();
    const doc = (await lib.getScene(takeId)) as SceneDocument;
    expect(doc.camera.length, JSON.stringify(doc.camera)).toBeGreaterThan(0);
    // And it carries the kit the pictures below sample: a logo to count and
    // a green to read in the margin.
    expect(doc.branding.logo?.ref).toBe("acme.svg");
    expect(doc.branding.background).toMatchObject({ color: "#00c853" });
    const bundle = await lib.frameStore(takeId).getBundle(takeId);
    // The names below would pass on the take's name too if the two matched.
    expect(videoName).not.toBe(doc.meta.name);
    const xs = (bundle?.cursorSamples ?? []).map((s) => s.x);
    expect(
      Math.max(...xs) - Math.min(...xs),
      JSON.stringify(xs.slice(0, 20)),
    ).toBeGreaterThan(50);
  });
});

describe("export, on the picture", () => {
  it(
    "saves 16:9 at the capped 1080p tier, named after its video, with the logo and the kit's background",
    async () => {
      await setAspect("16:9");
      const answer = await exportNow("e-169");
      expect(answer).toMatchObject({
        outcome: "saved",
        aspect: "16:9",
        file: { downloadId: null },
      });
      if (answer.outcome !== "saved" || answer.fileType === "stills") return;
      expect(answer.file.path).toBe(join(outDir, `${videoName}.mp4`));
      expect([answer.width, answer.height]).toEqual([1920, 1080]);
      expect(lines, "the cap says what it changed").toContainEqual(
        expect.stringContaining("export capped at 1920x1080, not 3840x2160"),
      );
      expect(answer.summary).toMatch(/^Saved /);
      const read = await sampleMp4(await readFile(answer.file.path), {
        colors: [MAGENTA, GREEN],
        blockPoints: [[0.01, 0.5]],
      });
      expect([read.width, read.height]).toEqual([answer.width, answer.height]);
      const most = (i: number) =>
        Math.max(...read.readings.map((r) => r.colorCounts[i] ?? 0));
      expect(most(0), "logo (magenta) pixels").toBeGreaterThan(50);
      const margin = read.readings[0]?.blocks[0] as [number, number, number];
      expect(
        Math.max(...margin.map((c, k) => Math.abs(c - (GREEN[k] as number)))),
        JSON.stringify(margin),
      ).toBeLessThan(24);
    },
    LANDSCAPE_EXPORT_MS,
  );

  // Red before plan 2: the runner rendered every aspect landscape.
  it(
    "saves 9:16 at 1080x1920 as '<name> (vertical).mp4'",
    async () => {
      await setAspect("9:16");
      const from = lines.length;
      const answer = await exportNow("e-916");
      // The cap does not touch 9:16, so it says nothing here.
      expect(lines.slice(from).filter((l) => l.includes("capped"))).toEqual([]);
      expect(answer).toMatchObject({
        outcome: "saved",
        aspect: "9:16",
        width: 1080,
        height: 1920,
      });
      if (answer.outcome !== "saved" || answer.fileType === "stills") return;
      expect(answer.file.path).toBe(
        join(outDir, `${videoName} (vertical).mp4`),
      );
      const read = await sampleMp4(await readFile(answer.file.path), {
        colors: [MAGENTA],
      });
      expect([read.width, read.height]).toEqual([1080, 1920]);
      // The control for the missing-logo case's zero: in this frame, with
      // the logo, magenta is there to count.
      expect(
        Math.max(...read.readings.map((r) => r.colorCounts[0] ?? 0)),
        JSON.stringify(read.readings.map((r) => r.colorCounts)),
      ).toBeGreaterThan(50);
    },
    VERTICAL_EXPORT_MS,
  );

  // Auto is the recording (1280x800, 16:10) plus an even margin: not 16:9.
  // Shape only: its file name is "<video> (k).mp4" for whichever k
  // the 16:9 case left free, which the uniquify case below pins.
  it(
    "saves Auto in the recording's shape, not 16:9",
    async () => {
      await setAspect("auto");
      const answer = await exportNow("e-auto");
      expect(answer).toMatchObject({ outcome: "saved", aspect: "auto" });
      if (answer.outcome !== "saved" || answer.fileType === "stills") return;
      expect(Math.abs(answer.width / answer.height - 16 / 9)).toBeGreaterThan(
        0.05,
      );
      const read = await sampleMp4(await readFile(answer.file.path), {
        colors: [],
      });
      expect([read.width, read.height]).toEqual([answer.width, answer.height]);
    },
    LANDSCAPE_EXPORT_MS,
  );

  // Review Focus 1. Earlier cases in this file already took the plain name
  // (and the Auto case a numbered one), so the expected name is computed from
  // what the folder holds right before the export, as Chrome's uniquify
  // computes it.
  it(
    "names a second export of the same take '(k)' for the first free k, never overwriting",
    async () => {
      // At 9:16, the cheaper render: the naming rule is the same for both.
      await setAspect("9:16");
      const plain = join(outDir, `${videoName} (vertical).mp4`);
      const before = await readdir(outDir);
      // The premise: a first export of this take is there to collide with.
      expect(before).toContain(`${videoName} (vertical).mp4`);
      const firstBytes = await readFile(plain);
      let k = 1;
      while (before.includes(`${videoName} (vertical) (${k}).mp4`)) k++;
      const answer = await exportNow("e-again");
      expect(answer).toMatchObject({ outcome: "saved" });
      if (answer.outcome !== "saved" || answer.fileType === "stills") return;
      expect(answer.file.path).toBe(
        join(outDir, `${videoName} (vertical) (${k}).mp4`),
      );
      expect((await readFile(plain)).equals(firstBytes)).toBe(true);
    },
    VERTICAL_EXPORT_MS,
  );

  // What `keep` and `refresh` ask for: an output's own aspect, whatever the
  // take's is. Red if `aspect` is not read: the take's 16:9 renders.
  it(
    "an asked aspect overrides the take's: a 16:9 take saves portrait",
    async () => {
      await setAspect("16:9");
      const answer = await exportNow("e-aspect", {
        aspect: "9:16",
        quality: "share",
      });
      expect(answer).toMatchObject({ outcome: "saved", aspect: "9:16" });
      if (answer.outcome !== "saved" || answer.fileType === "stills") return;
      const read = await sampleMp4(await readFile(answer.file.path), {
        colors: [],
      });
      // The premise of the picture: frames were decoded to measure.
      expect(read.readings.length).toBeGreaterThan(0);
      expect(read.height, `${read.width}x${read.height}`).toBeGreaterThan(
        read.width,
      );
      // The take keeps its own aspect: the override is the export's alone.
      expect((await library().getScene(takeId))?.canvas.aspect).toBe("16:9");
    },
    VERTICAL_EXPORT_MS,
  );
});

describe("export, high by default", () => {
  const scene9x16 = async () => {
    await setAspect("9:16");
    const lib = library();
    const doc = (await lib.getScene(takeId)) as SceneDocument;
    const bundle = await lib.frameStore(takeId).getBundle(takeId);
    return { doc, bundle };
  };

  it(
    "default export is high and says its size",
    async () => {
      const { doc, bundle } = await scene9x16();
      const high = targetFor("mp4", "9:16", bundle, frameOf(doc), {
        quality: "high",
      });
      const share = targetFor("mp4", "9:16", bundle, frameOf(doc), {
        quality: "share",
      });
      // The premise: the two targets differ, so a default that quietly
      // stayed share would be told apart from high.
      expect([high.width, high.height, high.fps]).not.toEqual([
        share.width,
        share.height,
        share.fps,
      ]);
      const answer = await exportNow("e-high", {});
      expect(answer).toMatchObject({ outcome: "saved", fileType: "mp4" });
      if (answer.outcome !== "saved" || answer.fileType !== "mp4") return;
      expect(answer.warnings.videoSize?.quality).toBe("high");
      expect(answer.warnings.videoSize?.byteLength).toBe(
        answer.file.byteLength,
      );
      expect(answer.file.byteLength).toBe(
        (await readFile(answer.file.path)).byteLength,
      );
      expect([answer.width, answer.height, answer.fps]).toEqual([
        high.width,
        high.height,
        high.fps,
      ]);
      // The size the summary names is the saved file's, in the one helper's
      // words (KB under 1 MB, as this short fixture is).
      expect(answer.summary).toContain(
        `, ${fileSize(answer.file.byteLength)})`,
      );
    },
    VERTICAL_EXPORT_MS,
  );

  // Red if an export with no quality stops reading Settings, or reads a
  // file it could not parse as a choice and says nothing.
  it(
    "no quality follows the Export quality setting, and says when it could not read it",
    async () => {
      await scene9x16();
      const settings = join(home, "settings.json");
      try {
        await writeFile(settings, JSON.stringify({ exportQuality: "share" }));
        const followed = await exportNow("e-setting", {});
        expect(followed).toMatchObject({ outcome: "saved", fileType: "mp4" });
        if (followed.outcome !== "saved" || followed.fileType !== "mp4") return;
        expect(followed.warnings.videoSize?.quality).toBe("share");
        expect(followed.warnings.videoSize?.settingUnreadable).toBeUndefined();
        // Premise: share is not the default, so following it is told apart.
        expect(DEFAULT_EXPORT_QUALITY).not.toBe("share");

        await writeFile(settings, "{");
        const unread = await exportNow("e-unread", {});
        expect(unread).toMatchObject({ outcome: "saved", fileType: "mp4" });
        if (unread.outcome !== "saved" || unread.fileType !== "mp4") return;
        expect(unread.warnings.videoSize?.quality).toBe(DEFAULT_EXPORT_QUALITY);
        expect(unread.warnings.videoSize?.settingUnreadable).toContain(
          settings,
        );
        expect(unread.summary).toContain(
          "not your Export quality setting, which could not be read",
        );

        // A failed export says it as well: it is not only a saved MP4's.
        const failed = await exportNow("e-unread-missing", {
          takeId: "no-such-take",
        });
        expect(failed).toMatchObject({
          outcome: "refusedBeforeExport",
          reason: "takeNotFound",
        });
        expect(failed.settingUnreadable).toContain(settings);
        expect(failed.summary).toContain(
          "Your Export quality setting could not be read either",
        );
      } finally {
        await rm(settings, { force: true });
      }
    },
    2 * VERTICAL_EXPORT_MS,
  );

  it(
    "a size cap with no quality starts at share, GitHub's size",
    async () => {
      const { doc, bundle } = await scene9x16();
      const share = targetFor("mp4", "9:16", bundle, frameOf(doc), {
        quality: "share",
      });
      // A cap this loose is met at once, so the answer is the first render.
      const answer = await exportNow("e-capq", { maxMB: 1000 });
      expect(answer).toMatchObject({ outcome: "saved", fileType: "mp4" });
      if (answer.outcome !== "saved" || answer.fileType !== "mp4") return;
      expect(answer.warnings.videoSize?.quality).toBe("share");
      expect(answer.warnings.videoSize?.cap).toMatchObject({ met: true });
      expect([answer.width, answer.height, answer.fps]).toEqual([
        share.width,
        share.height,
        share.fps,
      ]);
    },
    VERTICAL_EXPORT_MS,
  );

  it(
    "quality full gives today's target",
    async () => {
      const { doc, bundle } = await scene9x16();
      const full = targetFor("mp4", "9:16", bundle, frameOf(doc), {
        quality: "full",
      });
      const answer = await exportNow("e-full", { quality: "full" });
      expect(answer).toMatchObject({ outcome: "saved", fileType: "mp4" });
      if (answer.outcome !== "saved" || answer.fileType !== "mp4") return;
      expect([answer.width, answer.height, answer.fps]).toEqual([
        full.width,
        full.height,
        full.fps,
      ]);
      expect(answer.warnings.videoSize?.quality).toBe("full");
    },
    VERTICAL_EXPORT_MS,
  );

  it("a bad quality is refused, naming every quality", async () => {
    const answer = await exportNow("e-badq", { quality: "best" });
    expect(answer).toMatchObject({
      outcome: "refusedBeforeExport",
      reason: "invalidQuality",
      detail: expect.stringMatching(/high.*share.*full/),
    });
    expect(answer.summary).toMatch(/^Not exported: /);
  });

  it("quality on a GIF is refused rather than ignored", async () => {
    const answer = await exportNow("e-gifq", {
      fileType: "gif",
      quality: "full",
    });
    expect(answer).toMatchObject({
      outcome: "refusedBeforeExport",
      reason: "invalidQuality",
    });
  });
});

describe("export, under a size cap", () => {
  // Four 9:16 renders: 1080x1920 at 60 then 30 fps, then 720x1280 twice.
  const CAPPED_EXPORT_MS = 4 * VERTICAL_EXPORT_MS;

  // Red if maxMB is read as anything but maxMB x 1,000,000 bytes, if a step
  // is skipped or reordered, or if a cap that cannot be met fails the
  // export or reads as met.
  it(
    "maxMB is maxMB × 1,000,000 bytes; one it cannot meet takes every step and still saves",
    async () => {
      await setAspect("9:16");
      const said: string[] = [];
      const out = await executor.request(
        "export",
        { takeId, callId: "e-cap", quality: "full", maxMB: 0.05 },
        (p) => void said.push((p as { summary: string }).summary),
      );
      if (!out.ok) throw new Error(JSON.stringify(out));
      const answer = out.value as ExportAnswer;
      expect(answer).toMatchObject({ outcome: "saved", fileType: "mp4" });
      // Progress names each render, across the render page's binding: the
      // fps step keeps the width, so without it render 2 would read as
      // render 1 starting over.
      for (const render of [1, 2, 3, 4]) {
        expect(
          said.some((line) =>
            line.startsWith(`Exporting — render ${render} of up to 4 `),
          ),
          said
            .filter((l) => l.includes("render"))
            .slice(-8)
            .join("\n"),
        ).toBe(true);
      }
      if (answer.outcome !== "saved" || answer.fileType !== "mp4") return;
      const cap = answer.warnings.videoSize?.cap;
      expect(cap?.maxBytes).toBe(50_000);
      // The premise of met: false: the kept file really is over the cap.
      expect(answer.file.byteLength).toBeGreaterThan(50_000);
      expect(cap?.met).toBe(false);
      expect(cap?.steps).toEqual([
        { kind: "fps", from: 60, to: 30 },
        {
          kind: "share",
          from: { width: 1080, height: 1920 },
          to: { width: 720, height: 1280 },
          quality: 0.5,
        },
        { kind: "quality", from: 0.5, to: 0.35 },
      ]);
      expect([answer.width, answer.height, answer.fps]).toEqual([
        720, 1280, 30,
      ]);
      // The picture, not the report: the saved file decodes at the share
      // frame the report names.
      const bytes = await readFile(answer.file.path);
      expect(bytes.byteLength).toBe(answer.file.byteLength);
      const read = await sampleMp4(bytes, { colors: [MAGENTA] });
      expect([read.width, read.height]).toEqual([720, 1280]);
      expect(answer.summary).toMatch(
        /^Saved .*\(720×1280, 30 fps\), [\d.]+ [KM]B: over the 0\.05 MB asked for even at the smallest it goes \(30 fps, 720×1280, quality 0\.(35|5)\)[.,]/,
      );
    },
    CAPPED_EXPORT_MS,
  );

  // Red if a cap that fits re-renders, or names a cost it did not have.
  it(
    "a cap the first render fits costs nothing and says nothing more",
    async () => {
      await setAspect("9:16");
      const answer = await exportNow("e-cap-fits", { maxMB: 1000 });
      expect(answer).toMatchObject({ outcome: "saved", fileType: "mp4" });
      if (answer.outcome !== "saved" || answer.fileType !== "mp4") return;
      expect(answer.warnings.videoSize?.cap).toEqual({
        maxBytes: 1_000_000_000,
        met: true,
        steps: [],
        keptQuality: 0.5,
      });
      expect(answer.summary).toContain(
        `(720×1280, 30 fps, ${fileSize(answer.file.byteLength)})`,
      );
      expect(answer.summary).not.toMatch(/lowered|asked for/);
    },
    VERTICAL_EXPORT_MS,
  );

  it("a bad maxMB is refused, naming the field", async () => {
    for (const maxMB of [0, -1, "9.5", 1e-7, Number.NaN]) {
      const answer = await exportNow(`e-badcap-${String(maxMB)}`, { maxMB });
      expect(answer, JSON.stringify(maxMB)).toMatchObject({
        outcome: "refusedBeforeExport",
        reason: "invalidMaxMB",
        detail: expect.stringMatching(/^maxMB /),
      });
      expect(answer.summary).toMatch(/^Not exported: maxMB /);
    }
  });

  // Red if NaN or Infinity is named as JSON's null.
  it("names NaN and Infinity as themselves", async () => {
    for (const maxMB of [Number.NaN, Number.POSITIVE_INFINITY]) {
      const answer = await exportNow(`e-cap-${maxMB}`, { maxMB });
      expect(answer).toMatchObject({ reason: "invalidMaxMB" });
      if (answer.outcome !== "refusedBeforeExport") return;
      expect(answer.detail).toContain(`not ${String(maxMB)}`);
      expect(answer.detail).not.toContain("null");
    }
  });

  it("maxMB on a GIF is refused rather than ignored", async () => {
    const answer = await exportNow("e-gifcap", { fileType: "gif", maxMB: 9.5 });
    expect(answer).toMatchObject({
      outcome: "refusedBeforeExport",
      reason: "invalidMaxMB",
      detail: expect.stringMatching(/only to an MP4/),
    });
  });
});

describe("export, when something is wrong", () => {
  // Review Focus 2. At 9:16, the frame the 9:16 case counts the logo in.
  it(
    "saves without a logo that went away, and the summary says the logo is missing",
    async () => {
      await setAspect("9:16");
      await rm(join(home, "acme.svg"));
      try {
        const answer = await exportNow("e-nologo");
        expect(answer).toMatchObject({ outcome: "saved" });
        if (answer.outcome !== "saved" || answer.fileType === "stills") return;
        expect(answer.warnings.logo).toContain(join(home, "acme.svg"));
        expect(answer.summary).toContain("the logo is missing");
        // LOGO_SVG's claim (fixture.ts): nothing but the logo is magenta, so
        // the logo's count above means the logo. Without it, none.
        const read = await sampleMp4(await readFile(answer.file.path), {
          colors: [MAGENTA],
        });
        expect(read.readings.length).toBeGreaterThan(0);
        expect(
          Math.max(...read.readings.map((r) => r.colorCounts[0] ?? 0)),
          JSON.stringify(read.readings.map((r) => r.colorCounts)),
        ).toBe(0);
      } finally {
        await writeFile(join(home, "acme.svg"), LOGO_SVG);
      }
    },
    VERTICAL_EXPORT_MS,
  );

  // Review Focus 4, and M3 of the final review: the folder is checked before
  // the render, so a bad --out-dir costs no render and says nothing rendered.
  it("answers saveFailed with the path when the folder is read-only, before rendering anything, and leaves nothing", async () => {
    expect(process.getuid?.(), "running as root: chmod cannot refuse").not.toBe(
      0,
    );
    const workPages: unknown[] = [];
    const watched = createLocalExecutor({
      home,
      headless: true,
      outDir,
      log: (l) => void lines.push(l),
      onWorkPage: (page) => void workPages.push(page),
    });
    await setAspect("9:16");
    await mkdir(outDir, { recursive: true });
    const before = await readdir(outDir);
    await chmod(outDir, 0o500);
    try {
      const out = await watched.request("export", { takeId, callId: "e-ro" });
      if (!out.ok) throw new Error(JSON.stringify(out));
      const answer = out.value as ExportAnswer;
      expect(answer).toMatchObject({ outcome: "saveFailed", takeId });
      if (answer.outcome === "saveFailed") {
        expect(answer.error).toContain(outDir);
        // The OS's words, not a paraphrase.
        expect(answer.error).toMatch(/EACCES|permission denied/i);
      }
      expect(answer.summary).toMatch(/^Nothing was rendered/);
      // No render: the work page was never opened.
      expect(workPages).toHaveLength(0);
    } finally {
      await chmod(outDir, 0o700);
      await watched.close();
    }
    expect(await readdir(outDir)).toEqual(before);
  });

  it("refuses a take with no frames as noFrames, with a summary", async () => {
    const lib = library();
    const doc = (await lib.getScene(takeId)) as SceneDocument;
    const bare = { ...doc, meta: { ...doc.meta, id: "scene-bare" } };
    await lib.putScene(bare);
    const out = await executor.request("export", {
      takeId: "scene-bare",
      callId: "e-bare",
    });
    expect(out).toMatchObject({
      ok: true,
      value: { outcome: "refusedBeforeExport", reason: "noFrames" },
    });
    expect((out as { value: { summary: string } }).value.summary).toMatch(
      /^Not exported: /,
    );
  });

  it("refuses an expired version as versionExpired, naming its video and the run that records it again", async () => {
    const lib = library();
    const doc = (await lib.getScene(takeId)) as SceneDocument;
    const id = "scene-expired";
    await lib.putScene({ ...doc, meta: { ...doc.meta, id } });
    const videoId = "11111111-1111-4111-8111-111111111111";
    await writeFile(
      join(lib.takeDir(id), "video.json"),
      JSON.stringify({
        videoId,
        made: {
          repo: { none: "t" },
          agent: { none: "t" },
          by: "t",
          door: "mcp",
        },
        recordedRevision: null,
        expired: { at: "2026-10-01T00:00:00.000Z", freedBytes: 1 },
      }),
    );
    const out = await executor.request("export", {
      takeId: id,
      callId: "e-expired",
    });
    expect(out).toMatchObject({
      ok: true,
      value: { outcome: "refusedBeforeExport", reason: "versionExpired" },
    });
    const value = (out as { value: { detail: string; summary: string } }).value;
    expect(value.detail).toContain(`run({ video: { id: "${videoId}" } })`);
    expect(value.summary).toMatch(/^Not exported: /);
  });

  it("refuses an empty id and a missing take with summaries, as the extension does", async () => {
    for (const [id, reason] of [
      ["  ", "noTakeId"],
      ["scene-nope", "takeNotFound"],
      ["../etc", "takeNotFound"],
    ] as const) {
      const out = await executor.request("export", {
        takeId: id,
        callId: `e-${reason}-${id.length}`,
      });
      expect(out).toMatchObject({
        ok: true,
        value: { outcome: "refusedBeforeExport", reason },
      });
      expect((out as { value: { summary?: string } }).value.summary).toMatch(
        /^Not exported: /,
      );
    }
  });

  it("refuses a take whose scene cannot be read as takeUnreadable, naming the file", async () => {
    const lib = library();
    const doc = (await lib.getScene(takeId)) as SceneDocument;
    const id = "scene-garbled";
    await lib.putScene({ ...doc, meta: { ...doc.meta, id } });
    const path = join(lib.takeDir(id), "scene.json");
    await writeFile(path, "{nope");
    const out = await executor.request("export", {
      takeId: id,
      callId: "e-gb",
    });
    expect(out).toMatchObject({
      ok: true,
      value: { outcome: "refusedBeforeExport", reason: "takeUnreadable" },
    });
    expect(JSON.stringify(out)).toContain(path);
  });
});

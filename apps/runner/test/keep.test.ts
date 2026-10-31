import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type FrameBundle, wallpaperShape } from "@demoman/compositor";
import {
  frameOf,
  keptFileName,
  notCarriedOf,
  parseKept,
  serializeKept,
  targetFor,
} from "@demoman/run-core";
import type { SceneDocument } from "@demoman/scene-schema";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readonlyScene } from "../../../packages/compositor/test/fixtures/scene.js";
import {
  type BrowserSession,
  createBrowserSession,
} from "../src/executor/browser.js";
import { exportTake } from "../src/executor/export.js";
import { type KeepDeps, keepVideo, rewriteKept } from "../src/executor/keep.js";
import { createLibrary, type Library } from "../src/executor/library.js";
import { execGit, readRepo } from "../src/executor/repo.js";
import { createSessionStore } from "../src/executor/sessions.js";
import { createVideoStore, type VideoStore } from "../src/executor/videos.js";
import { makeDiskTake, putTake } from "./disk-take.js";
import { LOGO_SVG, WALLPAPERS_DIR } from "./fixture.js";
import { sampleMp4 } from "./mp4-probe.js";

// Measured locally (2026-10-27, M-series Mac, headless): the disk take
// about 2 s; the clean keep (a share MP4 and a GIF) about 15 s. x5 for CI
// (fff4505) with margin.
const SETUP_MS = 120_000;
const KEEP_MS = 240_000;
const MAGENTA: [number, number, number] = [255, 0, 255];

let home: string;
let repo: string;
let outside: string;
let library: Library;
let videos: VideoStore;
let session: BrowserSession;
let repoKey: string;
let cleanTakeId: string;
/** The disk take's own pointer, which glides for the whole take: no still screen. */
let movingCursor: NonNullable<FrameBundle["cursorSamples"]>;
const lines: string[] = [];

const deps = (): KeepDeps => ({
  home,
  library,
  videos,
  git: execGit,
  log: (l) => void lines.push(l),
  export: {
    wallpapersDir: WALLPAPERS_DIR,
    library,
    videos,
    session,
    door: "agent",
    home,
    outDir: join(home, "unused-out"),
    log: (l) => void lines.push(l),
  },
});

/** Every file and folder under the repo but `.git`: what a refusal must
 *  leave as it found it. */
const repoFiles = async (): Promise<string[]> =>
  (await readdir(repo, { recursive: true }))
    .filter((p) => p !== ".git" && !p.startsWith(".git/"))
    .sort();

/** A take of its own in the library, joined to a new video in this repo. */
async function videoOf(
  takeId: string,
  name: string,
  edit: (doc: SceneDocument) => SceneDocument = (d) => d,
): Promise<{ videoId: string; scene: SceneDocument }> {
  const base = readonlyScene();
  const scene = edit({ ...base, meta: { ...base.meta, id: takeId } });
  await library.putScene(scene);
  return { videoId: await joinVideo(takeId, name, scene), scene };
}

/** The clean take's frames under another take, so an export of it would
 *  save: a refusal case then refuses for its own reason, not for want of
 *  frames, and a check removed shows up as files written. */
async function copyFrames(
  takeId: string,
  motionSpans?: FrameBundle["motionSpans"],
): Promise<void> {
  const from = library.frameStore(cleanTakeId);
  const to = library.frameStore(takeId);
  const bundle = await from.getBundle(cleanTakeId);
  if (bundle === null) throw new Error("the clean take has no bundle");
  const keyframes = await Promise.all(
    bundle.keyframes.map(async (k, i) => ({
      ...k,
      ref: await to.putKeyframe(takeId, i, await from.load(k.ref)),
    })),
  );
  // Spans' bytes that will not demux: the render reports each one
  // unavailable and draws the keyframes, and the bundle still says how wide
  // the motion was filmed.
  for (const m of motionSpans ?? []) {
    await to.putSpan(m.ref, new Uint8Array([1, 2, 3]));
  }
  await to.putBundle(takeId, {
    ...bundle,
    sceneId: takeId,
    keyframes,
    ...(motionSpans === undefined ? {} : { motionSpans }),
  });
  // Premise: the copy reads back as a bundle with frames.
  expect((await to.getBundle(takeId))?.keyframes.length).toBe(
    bundle.keyframes.length,
  );
}

async function joinVideo(
  takeId: string,
  name: string,
  scene: SceneDocument,
): Promise<string> {
  const made = await videos.create({
    name,
    repo: { key: repoKey },
    startPage: scene.meta.capture.originUrl,
  });
  if (!made.ok) throw new Error(`video "${name}": ${JSON.stringify(made)}`);
  const read = await library.getSceneRead(takeId);
  if (read === null) throw new Error(`take ${takeId} has no scene`);
  await videos.join(takeId, {
    videoId: made.video.id,
    made: {
      repo: { none: "test" },
      agent: { none: "test" },
      by: { none: "test" },
      door: "mcp",
    },
    recordedRevision: read.revision,
  });
  return made.video.id;
}

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), "demoman-keep-home-"));
  repo = await mkdtemp(join(tmpdir(), "demoman-keep-repo-"));
  outside = await mkdtemp(join(tmpdir(), "demoman-keep-outside-"));
  expect((await execGit(["init", "-q"], repo)).code).toBe(0);
  const read = await readRepo(repo);
  if (!read.ok) throw new Error(read.none);
  repoKey = read.repo.key;
  library = createLibrary(home);
  videos = createVideoStore(home, library, { log: (l) => void lines.push(l) });
  session = createBrowserSession({
    headless: true,
    log: (l) => void lines.push(l),
  });
  // The clean take: frames on disk, and a logo outside the repo (in home).
  const { takeId, original, bundle } = await makeDiskTake(home);
  cleanTakeId = takeId;
  // The pointer holds still, as in executor-export-screens.test.ts: a
  // film that is never still has no screens, and keep refuses one.
  movingCursor = bundle.cursorSamples;
  const still = { sourceTimeMs: 0, x: 900, y: 600 };
  await putTake(home, takeId, original, {
    ...bundle,
    cursorSamples: [still, { ...still, sourceTimeMs: 9000 }],
  });
  await writeFile(join(home, "acme.svg"), LOGO_SVG);
  const withLogo: SceneDocument = {
    ...original,
    branding: {
      ...original.branding,
      logo: { ref: "acme.svg", corner: "top-right", size: 0.06, opacity: 1 },
    },
  };
  await library.putScene(withLogo);
  await joinVideo(takeId, "Add a task", withLogo);
}, SETUP_MS);

afterAll(async () => {
  await session?.close();
  for (const dir of [home, repo, outside])
    if (dir) await rm(dir, { recursive: true, force: true });
});

describe("keep, a clean take", () => {
  it(
    "writes a kept file a re-film can read, pinned to the take's size, and each output; with no motion frames, at 1x and says so",
    async () => {
      const scene = (await library.getScene(cleanTakeId)) as SceneDocument;
      // Premises: nothing a re-film leaves behind, a logo to copy, no
      // motion frames, and a stills dpr that is not 1 (REPLAY_DPR), so a
      // scale read from it is told apart from the 1x keep falls back to.
      expect(notCarriedOf(scene)).toEqual([]);
      expect(scene.branding.logo?.ref).toBe("acme.svg");
      expect(
        (await library.frameStore(cleanTakeId).getBundle(cleanTakeId))
          ?.motionSpans,
      ).toEqual([]);
      expect(scene.meta.capture.dpr).toBe(3);
      expect(scene.meta.capture.displayScale).toBeUndefined();
      expect(scene.canvas.aspect).toBe("16:9");
      // The run report keep copies to --report.
      await library.putJson(cleanTakeId, "report.json", {
        outcome: "complete",
        provenance: { takeId: cleanTakeId, bundleId: null, madeFrom: [] },
      });

      const out = await keepVideo(
        {
          video: "Add a task",
          to: [
            {
              path: "docs/hero.mp4",
              fileType: "mp4",
              aspect: "16:9",
              quality: "share",
            },
            // No aspect: the take's own.
            { path: "docs/hero.gif", fileType: "gif", quality: "share" },
          ],
          report: "docs/hero-report.json",
          repoRoot: repo,
        },
        // Kept off Linux: the answer says the first CI refresh replaces it.
        { ...deps(), platform: "darwin" },
      );
      if (!out.ok) throw new Error(JSON.stringify(out));
      expect(out.platformNote).toBe(
        "kept on macOS: the first refresh in CI films it again on Linux, whose fonts differ, and replaces its outputs once; after that, refresh in CI only",
      );
      const file = join(".demoman/videos", keptFileName("Add a task"));
      expect(out.file).toBe(file);
      const parsed = parseKept(await readFile(join(repo, file), "utf8"), file);
      if (!parsed.ok) throw new Error(parsed.detail);
      const kept = parsed.kept;
      expect(kept).toEqual(out.kept);
      expect(kept.name).toBe("Add a task");
      expect(kept.script.viewport).toEqual(scene.meta.capture.viewport);
      expect(kept.scale).toBe(1);
      // Report before you forgive: a guessed 1 is said on the answer, not
      // left to look like a recorded one.
      expect(out.scaleGuess).toContain(
        `1x is a guess: video ${cleanTakeId} records no filmed scale and has no motion frames to read one from`,
      );
      expect(kept.from.takeId).toBe(cleanTakeId);
      expect(kept.report).toBe("docs/hero-report.json");
      // A file a person reads in their repo: in the words agents are served
      // (spec 2026-10-30 flows-and-bulk-delete §2.1), not the stored ones.
      expect(
        JSON.parse(await readFile(join(repo, "docs/hero-report.json"), "utf8")),
      ).toEqual({
        outcome: "complete",
        provenance: { videoId: cleanTakeId, bundleId: null, madeFrom: [] },
      });
      expect(kept.outputs.map((o) => [o.path, o.fileType, o.aspect])).toEqual([
        ["docs/hero.mp4", "mp4", "16:9"],
        ["docs/hero.gif", "gif", "16:9"],
      ]);
      // The logo, copied into the repo, and the script's branding names it.
      expect(kept.logo).toBe(".demoman/videos/logos/acme.svg");
      expect(kept.script.look?.branding?.logo?.ref).toBe(kept.logo);
      expect(
        await readFile(join(repo, ".demoman/videos/logos/acme.svg"), "utf8"),
      ).toBe(LOGO_SVG);
      expect([...out.written].sort()).toEqual(
        [
          "docs/hero.mp4",
          "docs/hero.gif",
          "docs/hero-report.json",
          ".demoman/videos/logos/acme.svg",
          file,
        ].sort(),
      );

      // The picture: a landscape MP4 of the take, logo and all, and a GIF.
      const read = await sampleMp4(
        await readFile(join(repo, "docs/hero.mp4")),
        { colors: [MAGENTA] },
      );
      expect(read.width).toBeGreaterThan(read.height);
      expect(
        Math.max(...read.readings.map((r) => r.colorCounts[0] ?? 0)),
        "logo (magenta) pixels",
      ).toBeGreaterThan(50);
      const gif = await readFile(join(repo, "docs/hero.gif"));
      expect(gif.subarray(0, 6).toString("latin1")).toMatch(/^GIF8[79]a$/);

      // The kept file records the judged output's (the 16:9 MP4's) screens:
      // what a plain export of that output answers.
      const outDir = await mkdtemp(join(tmpdir(), "demoman-keep-screens-"));
      try {
        const plain = await exportTake(
          {
            takeId: cleanTakeId,
            fileType: "mp4",
            aspect: "16:9",
            quality: "share",
            unlisted: true,
          },
          { ...deps().export, outDir },
          () => undefined,
        );
        if (plain.outcome !== "saved" || plain.fileType === "stills")
          throw new Error(JSON.stringify(plain));
        // Premise: there are screens to carry, or equal empties prove nothing.
        expect(plain.screens.moments.length).toBeGreaterThan(0);
        // ...and each its window, and the look: keep writes all of them.
        expect(plain.screens.look).toBeDefined();
        expect(plain.screens.moments.every((m) => m.window)).toBe(true);
        expect(kept.screens).toEqual(plain.screens);
        expect(out.screensNote).toBe(
          `${plain.screens.moments.length} of ${plain.screens.steps + 1} screens are still`,
        );
      } finally {
        await rm(outDir, { recursive: true, force: true });
      }
    },
    KEEP_MS,
  );
});

describe("keep refuses, writing nothing", () => {
  const mp4 = (path: string) => ({
    path,
    fileType: "mp4" as const,
    aspect: "16:9" as const,
    quality: "share" as const,
  });
  // A path of its own per case: one case's keep never makes the next one's
  // output taken.
  let cases = 0;
  const refused = async (video: string, path = `docs/case-${++cases}.mp4`) => {
    const before = await repoFiles();
    const out = await keepVideo(
      { video, to: [mp4(path)], repoRoot: repo },
      deps(),
    );
    expect(await repoFiles(), "the repo's files").toEqual(before);
    if (out.ok) throw new Error(`kept: ${JSON.stringify(out)}`);
    return out;
  };

  // Red if keep stops checking the judged export's moments: an empty array
  // would be written, and parseKept refuses the file it just wrote.
  it(
    "a take whose film is never still, saying it has no still screen to compare against",
    async () => {
      const { scene } = await videoOf("scene-moving", "Never still");
      await copyFrames(scene.meta.id);
      const frames = library.frameStore(scene.meta.id);
      const bundle = await frames.getBundle(scene.meta.id);
      if (bundle === null) throw new Error("no bundle");
      // Premise: the pointer travels the whole take.
      expect(movingCursor.length).toBeGreaterThan(1);
      expect(movingCursor[0]).not.toEqual(movingCursor[1]);
      await frames.putBundle(scene.meta.id, {
        ...bundle,
        cursorSamples: movingCursor,
      });
      const out = await refused("Never still");
      expect(out.detail).toContain("no still screen to compare against");
    },
    KEEP_MS,
  );

  it("a video this repo has no record of", async () => {
    expect(await refused("No such video")).toMatchObject({
      reason: "unknownVideo",
      detail: expect.stringContaining("No such video"),
    });
  });

  // Red if the mask check goes: a refresh would commit what it hid.
  it("a take with a mask, naming it", async () => {
    const { scene } = await videoOf("scene-masked", "Masked", (d) => ({
      ...d,
      edits: {
        ...d.edits,
        masks: [{ id: "mask-1", rect: { x: 0, y: 0, width: 10, height: 10 } }],
      },
    }));
    // Premise: the mask is the only edit a re-film leaves behind.
    expect(notCarriedOf(scene)).toEqual([{ kind: "mask", id: "mask-1" }]);
    await copyFrames(scene.meta.id);
    const out = await refused("Masked");
    expect(out.reason).toBe("notCarried");
    expect(out.detail).toContain("mask mask-1");
  });

  it("a take with a trim, naming it", async () => {
    const { scene } = await videoOf("scene-trimmed", "Trimmed", (d) => ({
      ...d,
      edits: { ...d.edits, trim: { tail: { actionId: "act-3", offsetMs: 0 } } },
    }));
    expect(notCarriedOf(scene)).toEqual([{ kind: "trim", id: "tail" }]);
    await copyFrames(scene.meta.id);
    const out = await refused("Trimmed");
    expect(out.reason).toBe("notCarried");
    expect(out.detail).toContain("trim tail");
  });

  it("a take a re-film cannot rebuild (a hole), naming it", async () => {
    await videoOf("scene-redacted", "Redacted", (d) => ({
      ...d,
      actions: d.actions.map((a) =>
        a.id === "act-1"
          ? ({ ...a, text: null, redacted: true } as typeof a)
          : a,
      ),
    }));
    const out = await refused("Redacted");
    expect(out.reason).toBe("unfilledHoles");
    // The hole is the typed text of the first step.
    expect(out.detail).toContain("Step 1 typed into a field");
  });

  it("a take filmed on a hand sign-in", async () => {
    const url = "https://signed.example.org/inbox";
    const { scene } = await videoOf("scene-signed", "Handsigned", (d) => ({
      ...d,
      meta: { ...d.meta, capture: { ...d.meta.capture, originUrl: url } },
    }));
    await createSessionStore(home).save({
      sessionVersion: 1,
      site: "example.org",
      savedAt: new Date().toISOString(),
      refreshedAt: null,
      startUrl: url,
      signInUrl: null,
      state: { cookies: [], origins: [] },
    });
    // Premise: nothing else stops this one — it has no edits to leave.
    expect(notCarriedOf(scene)).toEqual([]);
    const out = await refused("Handsigned");
    expect(out.reason).toBe("handSignIn");
    expect(out.detail).toContain("example.org");
  });

  it("an output outside the repo, as a path or through a link", async () => {
    expect(await refused("Add a task", "../x.mp4")).toMatchObject({
      reason: "outsideRepo",
      detail: expect.stringContaining("../x.mp4"),
    });
    await symlink(outside, join(repo, "link"));
    try {
      expect(await refused("Add a task", "link/x.mp4")).toMatchObject({
        reason: "outsideRepo",
        detail: expect.stringContaining("link/x.mp4"),
      });
      expect(await readdir(outside)).toEqual([]);
    } finally {
      await rm(join(repo, "link"));
    }
  });

  it("an output another kept video already writes, naming that video", async () => {
    // Premise: the clean case kept docs/hero.mp4 for "Add a task".
    const first = await readFile(
      join(repo, ".demoman/videos", keptFileName("Add a task")),
      "utf8",
    );
    expect(first).toContain('"docs/hero.mp4"');
    await videoOf("scene-second", "Second");
    const out = await refused("Second", "docs/hero.mp4");
    expect(out.reason).toBe("outputTaken");
    expect(out.detail).toContain("Add a task");
    expect(out.detail).toContain("docs/hero.mp4");
  });
});

// The take's wallpaper, as keep reads it (ruling R13): an upload is copied
// into the repo like the logo, so a refresh in CI films it; one that cannot
// be had is refused, as a logo is; one that is only too small is kept.
describe("keep and the video's wallpaper", () => {
  const mp4 = (path: string) => ({
    path,
    fileType: "mp4" as const,
    aspect: "16:9" as const,
    quality: "share" as const,
  });
  /** A take of the clean frames on an uploaded image at `ref`. */
  const onImage = async (
    takeId: string,
    name: string,
    ref: string,
    blur?: number,
  ) => {
    const { scene } = await videoOf(takeId, name, (d) => ({
      ...d,
      branding: {
        ...d.branding,
        background: {
          kind: "image",
          ref,
          ...(blur === undefined ? {} : { blur }),
        },
      },
    }));
    await copyFrames(scene.meta.id);
    return scene;
  };

  it(
    "copies an uploaded image into the repo and names it in the script, though it is too small for the zoom",
    async () => {
      await mkdir(join(home, "assets"), { recursive: true });
      const thumb = await readFile(join(WALLPAPERS_DIR, "vivid-1-thumb.webp"));
      await writeFile(join(home, "assets", "thumb.webp"), thumb);
      // Blurred: the copy carries the take's blur, or a refresh films it
      // sharp with a clean report.
      const scene = await onImage(
        "scene-upload",
        "On an upload",
        "assets/thumb.webp",
        0.3,
      );
      expect(scene.branding.background).toMatchObject({ blur: 0.3 });
      // Premise: the 320x240 thumb is smaller than the export needs, so its
      // export warns soft, not left out.
      const outDir = await mkdtemp(join(tmpdir(), "demoman-keep-soft-"));
      try {
        const plain = await exportTake(
          {
            takeId: scene.meta.id,
            fileType: "mp4",
            aspect: "16:9",
            quality: "share",
            unlisted: true,
          },
          { ...deps().export, outDir },
          () => undefined,
        );
        if (plain.outcome !== "saved") throw new Error(JSON.stringify(plain));
        expect(plain.warnings.wallpaperWarning?.kind).toBe("soft");
      } finally {
        await rm(outDir, { recursive: true, force: true });
      }
      const out = await keepVideo(
        { video: "On an upload", to: [mp4("docs/upload.mp4")], repoRoot: repo },
        deps(),
      );
      if (!out.ok) throw new Error(JSON.stringify(out));
      const copy = ".demoman/videos/wallpapers/thumb.webp";
      expect(out.kept.wallpaper).toBe(copy);
      expect(out.kept.script.look?.branding?.background).toEqual({
        kind: "image",
        ref: copy,
        blur: 0.3,
      });
      expect((await readFile(join(repo, copy))).equals(thumb)).toBe(true);
      expect(out.written).toContain(copy);
    },
    KEEP_MS,
  );

  // Red if keep stops reading the wallpaper before it renders: the export
  // would leave it out, and the refusal would come after the render with
  // the other detail.
  it("refuses an upload that is gone, before rendering, naming the file", async () => {
    await onImage("scene-gone", "On a gone upload", "assets/gone.webp");
    const before = await repoFiles();
    const out = await keepVideo(
      { video: "On a gone upload", to: [mp4("docs/gone.mp4")], repoRoot: repo },
      deps(),
    );
    expect(await repoFiles()).toEqual(before);
    expect(out).toMatchObject({ ok: false, reason: "wallpaperUnreadable" });
    if (out.ok) return;
    expect(out.detail).toMatch(
      /^the video's wallpaper: .*gone\.webp could not be read/,
    );
  });

  // Red if keep keeps a video an export left on the gradient: the file is
  // there to read, but will not decode.
  it(
    "refuses a video an export left on the gradient, naming the output",
    async () => {
      await mkdir(join(home, "assets"), { recursive: true });
      await writeFile(join(home, "assets", "bad.webp"), "not an image");
      await onImage("scene-bad", "On a bad upload", "assets/bad.webp");
      const before = await repoFiles();
      const out = await keepVideo(
        { video: "On a bad upload", to: [mp4("docs/bad.mp4")], repoRoot: repo },
        deps(),
      );
      expect(await repoFiles()).toEqual(before);
      expect(out).toMatchObject({ ok: false, reason: "wallpaperUnreadable" });
      if (out.ok) return;
      expect(out.detail).toMatch(
        /^docs\/bad\.mp4 was rendered without its wallpaper: The wallpaper was left out: .*bad\.webp/,
      );
    },
    KEEP_MS,
  );
});

// Red if keep decides an output's shape by its aspect rather than its
// target (`wallpaperShape(targetFor(...))`, as the export does): an Auto take
// filmed on a phone is checked as landscape, passes, and the export then
// leaves the portrait file out after rendering, with the other detail.
describe("keep checks an Auto phone take's wallpaper as portrait", () => {
  it(
    "refuses a missing portrait file before rendering, naming it",
    async () => {
      const id = "vivid-1";
      const dir = await mkdtemp(join(tmpdir(), "demoman-keep-shape-"));
      try {
        for (const name of await readdir(WALLPAPERS_DIR)) {
          if (name === `${id}-portrait.webp`) continue;
          await writeFile(
            join(dir, name),
            await readFile(join(WALLPAPERS_DIR, name)),
          );
        }
        const { scene } = await videoOf("scene-phone", "On a phone", (d) => ({
          ...d,
          canvas: { ...d.canvas, aspect: "auto" },
          branding: { ...d.branding, background: { kind: "wallpaper", id } },
        }));
        await copyFrames(scene.meta.id);
        const store = library.frameStore(scene.meta.id);
        const bundle = await store.getBundle(scene.meta.id);
        if (bundle === null) throw new Error("no bundle");
        const phone = { ...bundle, viewport: { width: 390, height: 844 } };
        await store.putBundle(scene.meta.id, phone);
        // Premises: the export draws this output from the portrait master,
        // the landscape one is there, and the portrait one is not.
        const target = targetFor("mp4", "auto", phone, frameOf(scene), {
          quality: "share",
        });
        expect(wallpaperShape(target)).toBe("portrait");
        expect((await readdir(dir)).includes(`${id}-landscape.webp`)).toBe(
          true,
        );
        expect((await readdir(dir)).includes(`${id}-portrait.webp`)).toBe(
          false,
        );
        const before = await repoFiles();
        const base = deps();
        const out = await keepVideo(
          {
            video: "On a phone",
            to: [{ path: "docs/phone.mp4", fileType: "mp4", quality: "share" }],
            repoRoot: repo,
          },
          { ...base, export: { ...base.export, wallpapersDir: dir } },
        );
        expect(await repoFiles()).toEqual(before);
        expect(out).toMatchObject({ ok: false, reason: "wallpaperUnreadable" });
        if (out.ok) return;
        expect(out.detail).toMatch(
          /^the video's wallpaper: .*vivid-1-portrait\.webp/,
        );
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
    KEEP_MS,
  );
});

// Kept apart from the cases above: a symlinked parent folder that does not
// exist yet must still be resolved before the compare.
describe("keep's repo check", () => {
  it("resolves a missing folder under a link that points out", async () => {
    await mkdir(join(outside, "real"), { recursive: true });
    await symlink(join(outside, "real"), join(repo, "out"));
    try {
      const out = await keepVideo(
        {
          video: "Add a task",
          to: [
            {
              path: "out/new/deeper.mp4",
              fileType: "mp4",
              aspect: "16:9",
              quality: "share",
            },
          ],
          repoRoot: repo,
        },
        deps(),
      );
      expect(out).toMatchObject({ ok: false, reason: "outsideRepo" });
    } finally {
      await rm(join(repo, "out"));
    }
  });
});

// Review Focus 2 for keep's own files: the kept JSON and the logo copy go
// through the same check as the outputs, before anything renders.
describe("keep's own files stay in the repo", () => {
  /** Puts a link at `at` (repo-relative) to an empty folder outside, with
   *  whatever was there set aside and put back after. */
  async function linkedOut(at: string, run: (target: string) => Promise<void>) {
    const real = join(repo, at);
    const aside = await mkdtemp(join(tmpdir(), "demoman-keep-aside-"));
    const target = await mkdtemp(join(tmpdir(), "demoman-keep-target-"));
    await rename(real, join(aside, "kept"));
    await symlink(target, real);
    try {
      await run(target);
    } finally {
      await rm(real);
      await rename(join(aside, "kept"), real);
      await rm(aside, { recursive: true, force: true });
      await rm(target, { recursive: true, force: true });
    }
  }
  const keepTo = (path: string) =>
    keepVideo(
      {
        video: "Add a task",
        to: [{ path, fileType: "gif", quality: "share" }],
        repoRoot: repo,
      },
      deps(),
    );

  it(
    "refuses when .demoman links out of the repo, writing nothing either side",
    async () => {
      await linkedOut(".demoman", async (target) => {
        const before = await repoFiles();
        const out = await keepTo("docs/linked-demoman.gif");
        expect(out).toMatchObject({ ok: false, reason: "outsideRepo" });
        if (out.ok) return;
        expect(out.detail).toContain(
          `.demoman/videos/${keptFileName("Add a task")}`,
        );
        expect(await repoFiles(), "the repo's files").toEqual(before);
        expect(await readdir(target), "the outside folder").toEqual([]);
      });
    },
    KEEP_MS,
  );

  it(
    "refuses when the logos folder links out of the repo, writing nothing either side",
    async () => {
      // Premise: the clean case copied the logo there, so there is a folder to
      // put a link in its place, and this video's logo lives outside the repo.
      expect(await readdir(join(repo, ".demoman/videos/logos"))).toEqual([
        "acme.svg",
      ]);
      await linkedOut(".demoman/videos/logos", async (target) => {
        const before = await repoFiles();
        const out = await keepTo("docs/linked-logos.gif");
        expect(out).toMatchObject({ ok: false, reason: "outsideRepo" });
        if (out.ok) return;
        expect(out.detail).toContain(".demoman/videos/logos/acme.svg");
        expect(await repoFiles(), "the repo's files").toEqual(before);
        expect(await readdir(target), "the outside folder").toEqual([]);
      });
    },
    KEEP_MS,
  );
});

// The take's outputs.json lists what was exported where: keep's renders land
// in a temp folder it deletes, so listing them would name files that are gone.
describe("keep's exports are not listed on the take", () => {
  it(
    "adds no outputs.json row, where a plain export adds one",
    async () => {
      const rows = async () => (await library.outputs(cleanTakeId)).length;
      const before = await rows();
      const out = await keepVideo(
        {
          video: "Add a task",
          to: [
            { path: "docs/unlisted.gif", fileType: "gif", quality: "share" },
          ],
          repoRoot: repo,
        },
        deps(),
      );
      expect(out, JSON.stringify(out)).toMatchObject({ ok: true });
      expect(await rows(), "rows after keep").toBe(before);
      // Premise: a plain export of the same take does add a row, so the count
      // above could have moved.
      const outDir = await mkdtemp(join(tmpdir(), "demoman-keep-plain-"));
      try {
        const plain = await exportTake(
          { takeId: cleanTakeId, fileType: "gif" },
          { ...deps().export, outDir },
          () => undefined,
        );
        expect(plain).toMatchObject({ outcome: "saved" });
        expect(await rows(), "rows after a plain export").toBe(before + 1);
      } finally {
        await rm(outDir, { recursive: true, force: true });
      }
    },
    KEEP_MS,
  );
});

// The scale a kept video films at is the one its motion was filmed at:
// screencast frames follow the display's DPR, where `meta.capture.dpr` is
// REPLAY_DPR (3), the stills' scale, on every authored take.
describe("keep's scale, from the motion frames", () => {
  /** A span of the given pixel width over the take's 1280px viewport. */
  const span = (id: string, width: number) => [
    {
      startMs: 400,
      endMs: 3200,
      ref: `span:${id}:0`,
      width,
      height: (width * 800) / 1280,
      fps: 30,
      byteLength: 0,
    },
  ];
  it.each([
    ["Retina", 2560, 2],
    ["Plain", 1280, 1],
    // An encoder's even-pixel rounding is not another display.
    ["Rounded", 2562, 2],
  ])(
    "%s: motion %ipx wide over a 1280px viewport keeps scale %i",
    async (name, width, scale) => {
      const id = `scene-${name.toLowerCase()}`;
      const { scene } = await videoOf(id, name);
      await copyFrames(id, span(id, width));
      // Premises: the viewport the ratio is taken over, a stills dpr that is
      // neither answer, and no recorded scale (a take filmed before it).
      expect(scene.meta.capture.viewport.width).toBe(1280);
      expect(scene.meta.capture.dpr).toBe(3);
      expect(scene.meta.capture.displayScale).toBeUndefined();
      const out = await keepVideo(
        {
          video: name,
          to: [{ path: `docs/${id}.gif`, fileType: "gif", quality: "share" }],
          repoRoot: repo,
        },
        deps(),
      );
      if (!out.ok) throw new Error(JSON.stringify(out));
      expect(out.kept.scale).toBe(scale);
      expect(out.scaleGuess).toBeUndefined();
    },
    KEEP_MS,
  );
});

// Decide once, record it: the run writes the scale it filmed at, and keep
// reads that before anything else — a take whose page never moved has no
// motion frames, but was still filmed at the display's scale.
describe("keep's scale, from the take's record", () => {
  it(
    "keeps the recorded display scale of a take with no motion frames",
    async () => {
      const id = "scene-recorded";
      const { scene } = await videoOf(id, "Recorded", (d) => ({
        ...d,
        meta: { ...d.meta, capture: { ...d.meta.capture, displayScale: 2 } },
      }));
      await copyFrames(id);
      // Premises: the record is there, and there is no motion to read.
      expect(scene.meta.capture.displayScale).toBe(2);
      expect((await library.getScene(id))?.meta.capture.displayScale).toBe(2);
      expect((await library.frameStore(id).getBundle(id))?.motionSpans).toEqual(
        [],
      );
      const out = await keepVideo(
        {
          video: "Recorded",
          to: [{ path: `docs/${id}.gif`, fileType: "gif", quality: "share" }],
          repoRoot: repo,
        },
        // Kept on Linux, as CI films: nothing to replace once.
        { ...deps(), platform: "linux" },
      );
      if (!out.ok) throw new Error(JSON.stringify(out));
      expect(out.kept.scale).toBe(2);
      expect(out.scaleGuess).toBeUndefined();
      expect("platformNote" in out).toBe(false);
    },
    KEEP_MS,
  );
});

describe("a run into a kept video rewrites its file", () => {
  /** A newer take in an existing video, filmed at another page. */
  async function newVersion(
    videoId: string,
    takeId: string,
    edit: (doc: SceneDocument) => SceneDocument = (d) => d,
  ): Promise<SceneDocument> {
    const base = readonlyScene();
    const capture = {
      ...base.meta.capture,
      originUrl: "https://example.test/second",
    };
    const scene = edit({
      ...base,
      meta: { ...base.meta, id: takeId, capture },
    });
    await library.putScene(scene);
    await copyFrames(takeId);
    const read = await library.getSceneRead(takeId);
    if (read === null) throw new Error(`take ${takeId} has no scene`);
    await videos.join(takeId, {
      videoId,
      made: {
        repo: { none: "test" },
        agent: { none: "test" },
        by: { none: "test" },
        door: "mcp",
      },
      recordedRevision: read.revision,
    });
    return scene;
  }
  const keptOf = async (file: string) => {
    const parsed = parseKept(await readFile(join(repo, file), "utf8"), file);
    if (!parsed.ok) throw new Error(parsed.detail);
    return parsed.kept;
  };

  it(
    "follows the new version, keeps the outputs, and touches nothing else",
    async () => {
      const first = await videoOf("scene-rw-1", "Rewrite me");
      await copyFrames("scene-rw-1");
      const out = await keepVideo(
        {
          video: "Rewrite me",
          to: [{ path: "docs/rw.gif", fileType: "gif", quality: "share" }],
          repoRoot: repo,
        },
        deps(),
      );
      if (!out.ok) throw new Error(JSON.stringify(out));
      const before = await keptOf(out.file);
      // The screens describe the committed files, which a rewrite does not
      // replace: give the file screens no render of the new take would give.
      const tampered = {
        ...before,
        screens: {
          steps: before.screens.steps,
          moments: [{ step: null, ms: 1 }],
        },
      };
      expect(tampered.screens).not.toEqual(before.screens);
      await writeFile(join(repo, out.file), serializeKept(tampered));
      const gifBefore = await readFile(join(repo, "docs/rw.gif"));
      const filesBefore = await repoFiles();

      const second = await newVersion(first.videoId, "scene-rw-2");
      // Premise: the new version films another page, so its script differs.
      expect(second.meta.capture.originUrl).not.toBe(
        first.scene.meta.capture.originUrl,
      );
      const answer = await rewriteKept(repo, first.videoId, deps());
      expect(answer).toEqual({ rewritten: out.file });
      const after = await keptOf(out.file);
      expect(after.from.takeId).toBe("scene-rw-2");
      expect(after.script.target).toBe("https://example.test/second");
      expect(after.script).not.toEqual(before.script);
      expect(after.outputs).toEqual(before.outputs);
      expect(JSON.stringify(after.screens)).toBe(
        JSON.stringify(tampered.screens),
      );
      expect(after.report).toBe(before.report);
      expect(await readFile(join(repo, "docs/rw.gif"))).toEqual(gifBefore);
      expect(await repoFiles(), "no stray temp file").toEqual(filesBefore);
    },
    KEEP_MS,
  );

  // Red if the videoId match is skipped: an unkept video would write a file.
  it("a video no file keeps writes nothing and says nothing", async () => {
    const other = await videoOf("scene-rw-unkept", "Never kept");
    await copyFrames("scene-rw-unkept");
    await newVersion(other.videoId, "scene-rw-unkept-2");
    const before = await repoFiles();
    // Premise: the repo has kept files, just none for this video.
    expect(
      before.filter((f) => f.startsWith(".demoman/videos/")).length,
    ).toBeGreaterThan(0);
    expect(await rewriteKept(repo, other.videoId, deps())).toEqual({
      none: true,
    });
    expect(await repoFiles()).toEqual(before);
  });

  it(
    "a new version with a mask is refused, naming it, and the file stays as it was",
    async () => {
      const first = await videoOf("scene-rw-m1", "Rewrite masked");
      await copyFrames("scene-rw-m1");
      const out = await keepVideo(
        {
          video: "Rewrite masked",
          to: [{ path: "docs/rwm.gif", fileType: "gif", quality: "share" }],
          repoRoot: repo,
        },
        deps(),
      );
      if (!out.ok) throw new Error(JSON.stringify(out));
      const bytes = await readFile(join(repo, out.file));
      const scene = await newVersion(first.videoId, "scene-rw-m2", (d) => ({
        ...d,
        edits: {
          ...d.edits,
          masks: [
            { id: "mask-9", rect: { x: 0, y: 0, width: 10, height: 10 } },
          ],
        },
      }));
      expect(notCarriedOf(scene)).toEqual([{ kind: "mask", id: "mask-9" }]);
      const answer = await rewriteKept(repo, first.videoId, deps());
      expect(answer).toEqual({
        refused: expect.stringContaining("mask mask-9"),
      });
      expect(await readFile(join(repo, out.file))).toEqual(bytes);
    },
    KEEP_MS,
  );

  it("a kept file that cannot be read is said, naming the file", async () => {
    await writeFile(join(repo, ".demoman/videos/broken.json"), "{ not json");
    try {
      const other = await videoOf("scene-rw-b", "Unmatched");
      const answer = await rewriteKept(repo, other.videoId, deps());
      expect(answer).toEqual({
        refused: expect.stringContaining(".demoman/videos/broken.json"),
      });
    } finally {
      await rm(join(repo, ".demoman/videos/broken.json"));
    }
  });
});

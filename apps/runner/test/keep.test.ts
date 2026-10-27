import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { keptFileName, notCarriedOf, parseKept } from "@demoman/run-core";
import type { SceneDocument } from "@demoman/scene-schema";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readonlyScene } from "../../../packages/compositor/test/fixtures/scene.js";
import {
  type BrowserSession,
  createBrowserSession,
} from "../src/executor/browser.js";
import { type KeepDeps, keepVideo } from "../src/executor/keep.js";
import { createLibrary, type Library } from "../src/executor/library.js";
import { execGit, readRepo } from "../src/executor/repo.js";
import { createSessionStore } from "../src/executor/sessions.js";
import { createVideoStore, type VideoStore } from "../src/executor/videos.js";
import { makeDiskTake } from "./disk-take.js";
import { LOGO_SVG } from "./fixture.js";
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
const lines: string[] = [];

const deps = (): KeepDeps => ({
  home,
  library,
  videos,
  git: execGit,
  log: (l) => void lines.push(l),
  export: {
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
async function copyFrames(takeId: string): Promise<void> {
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
  await to.putBundle(takeId, { ...bundle, sceneId: takeId, keyframes });
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
  const { takeId, original } = await makeDiskTake(home);
  cleanTakeId = takeId;
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
    "writes a kept file a re-film can read, pinned to the take's size and scale, and each output",
    async () => {
      const scene = (await library.getScene(cleanTakeId)) as SceneDocument;
      // Premises: nothing a re-film leaves behind, a logo to copy, and a
      // scale that is not 1 (so a pinned scale is told apart from a default).
      expect(notCarriedOf(scene)).toEqual([]);
      expect(scene.branding.logo?.ref).toBe("acme.svg");
      expect(scene.meta.capture.dpr).toBe(3);
      expect(scene.canvas.aspect).toBe("16:9");
      // The run report keep copies to --report.
      await library.putJson(cleanTakeId, "report.json", {
        outcome: "complete",
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
        deps(),
      );
      if (!out.ok) throw new Error(JSON.stringify(out));
      const file = join(".demoman/videos", keptFileName("Add a task"));
      expect(out.file).toBe(file);
      const parsed = parseKept(await readFile(join(repo, file), "utf8"), file);
      if (!parsed.ok) throw new Error(parsed.detail);
      const kept = parsed.kept;
      expect(kept).toEqual(out.kept);
      expect(kept.name).toBe("Add a task");
      expect(kept.script.viewport).toEqual(scene.meta.capture.viewport);
      expect(kept.scale).toBe(scene.meta.capture.dpr);
      expect(kept.from.takeId).toBe(cleanTakeId);
      expect(kept.report).toBe("docs/hero-report.json");
      expect(
        JSON.parse(await readFile(join(repo, "docs/hero-report.json"), "utf8")),
      ).toEqual({ outcome: "complete" });
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

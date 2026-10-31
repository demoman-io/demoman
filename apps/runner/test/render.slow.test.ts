// Slow tier: renders seven mp4s in software through renderPhase, and runs and exports one agent take. `pnpm test:fast` skips it; `pnpm test` and CI run it.
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  autoTarget,
  COMPOSITOR_VERSION,
  type FrameBundle,
  LANDSCAPE_1080P,
  pickLandscapeTarget,
  VERTICAL_1080,
} from "@demoman/compositor";
import { type ExportAnswer, frameOf, targetFor } from "@demoman/run-core";
import {
  NEUTRAL_BACKGROUND,
  type SceneAspect,
  type SceneDocument,
  wallpaperFile,
} from "@demoman/scene-schema";
import type { Page } from "playwright";
import { describe, expect, it, onTestFinished } from "vitest";
import { readonlyScene } from "../../../packages/compositor/test/fixtures/scene.js";
import { bundleEntry } from "../src/bundle-js.js";
import type { Rgb } from "../src/decode-probe-entry.js";
import { RENDER_PROBE_GLOBAL } from "../src/entry-globals.js";
import { createLocalExecutor } from "../src/executor/executor.js";
import { createFileFrameStore, type RunnerStore } from "../src/frame-store.js";
import { launch } from "../src/launch.js";
import { listenOnLoopback } from "../src/loopback.js";
import {
  createRenderServer,
  renderPhase,
  renderToFiles,
} from "../src/render.js";
import { ownVideo, WALLPAPERS_DIR } from "./fixture.js";
import { FIXTURE_HEIGHT, FIXTURE_WIDTH, jpeg } from "./fixtures/jpeg.js";
import {
  mp4FrameTimes,
  readMp4Crops,
  sampleImage,
  sampleMp4,
} from "./mp4-probe.js";
import { keyframeOnlyBundle } from "./render-small.js";

// The decode probe (mediabunny's demux side) lives in its own bundle, never
// render.ts's production one — see entry-globals.ts's RENDER_PROBE_GLOBAL
// docblock for the ~654 KB / ~40% the identical mux/mux-probe split found
// this cost the injected script when it lived in the production entry.
const PROBE_ENTRY_PATH = join(
  import.meta.dirname,
  "..",
  "src",
  "render-probe-entry.ts",
);
let probeBundle: Promise<string> | null = null;
function renderProbeBundle(): Promise<string> {
  probeBundle ??= bundleEntry(PROBE_ENTRY_PATH);
  return probeBundle;
}

/**
 * A scratch directory that goes away when the test that made it finishes.
 *
 * Round 2's finding 8: this file made seven `mkdtempSync` directories and
 * removed none of them, and two of the tests below write a real rendered
 * mp4 into one. `onTestFinished` rather than a `finally` for the same reason
 * `encoder.bench.test.ts` uses it — the removal has to run after the
 * assertions, on the failing path too, and several of these are created
 * before a browser this test also has to close.
 */
function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  onTestFinished(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

async function probeInPage(
  page: Page,
  bytes: Uint8Array,
): Promise<{
  hasTrack: boolean;
  displayWidth: number;
  displayHeight: number;
  canDecode: boolean;
}> {
  await page.addScriptTag({ content: await renderProbeBundle() });
  const base64 = Buffer.from(bytes).toString("base64");
  return page.evaluate(
    ([globalName, data]) => {
      const entry = (
        globalThis as unknown as Record<
          string,
          | {
              probeTrack(b: string): Promise<{
                hasTrack: boolean;
                displayWidth: number;
                displayHeight: number;
                canDecode: boolean;
              }>;
            }
          | undefined
        >
      )[globalName as string];
      if (entry === undefined) {
        throw new Error(`${globalName} is not installed on this page`);
      }
      return entry.probeTrack(data as string);
    },
    [RENDER_PROBE_GLOBAL, base64] as const,
  );
}

describe("store.refs() — the render phase's own http server serves from it", () => {
  // The ruling this test discharges (carried from Task 5): refs() had no
  // test of its own, and render.ts's http server is its first real
  // consumer — it builds its allow-list from exactly this call. Written
  // beside that consumer rather than in frame-store.test.ts.
  it("lists exactly the blob refs, excludes the bundles/ directory entry, and every ref it returns loads", async () => {
    const store = createFileFrameStore(tempDir("demoman-refs-"));
    const kfRef = await store.putKeyframe("s1", 0, jpeg());
    await store.putSpan("span:s1:0", new Uint8Array([1, 2, 3]));
    // The blob layout is flat (`<root>/<encoded-ref>`) with bundles in
    // their own `bundles/` subdirectory — a real directory entry render.ts's
    // server could otherwise be asked (and fail) to serve as if it were a
    // blob, which is exactly what this bundle row's presence tests for.
    await store.putBundle("s1", {
      source: "replay",
      keyframes: [{ ref: kfRef }],
      motionSpans: [{ ref: "span:s1:0" }],
      cursorSamples: [],
      degradations: [],
    } as never);

    const refs = await store.refs();
    expect(new Set(refs)).toEqual(new Set([kfRef, "span:s1:0"]));
    expect(refs).not.toContain("bundles");
    for (const ref of refs) {
      await expect(store.load(ref)).resolves.toBeInstanceOf(Uint8Array);
    }
  });
});

describe("the render phase's http server", () => {
  it("answers 404 to a path it cannot decode, rather than throwing inside the request listener", async () => {
    // Runner audit 2026-09-14, low-severity note. `decodeURIComponent` on
    // a malformed percent-escape throws a `URIError`, and an exception
    // thrown synchronously inside an http `request` listener is an uncaught
    // exception — it takes the whole node process down, mid-render, with
    // the mp4 never written and nothing on either stream that names the
    // request. Only the runner's own page reaches this server today, but a
    // server that can be killed by one request shape is a server whose
    // failure path reports nothing.
    const store = createFileFrameStore(tempDir("demoman-render-server-"));
    const ref = await store.putKeyframe("s1", 0, jpeg());
    const server = createRenderServer(store, new Set([ref]));
    const origin = await listenOnLoopback(server);
    onTestFinished(() => new Promise<void>((r) => server.close(() => r())));

    const bad = await fetch(`${origin}%E0%A4%A`);
    expect(bad.status).toBe(404);
    // Still alive and still serving what it holds: the malformed request
    // cost that one response and nothing else.
    const good = await fetch(`${origin}${encodeURIComponent(ref)}`);
    expect(good.status).toBe(200);
    expect(new Uint8Array(await good.arrayBuffer())).toEqual(jpeg());
  });
});

describe("renderPhase stamps COMPOSITOR_VERSION before rendering", () => {
  // A fake `Page` rather than a real browser: this is about what
  // `renderPhase` HANDS to the page, not what the page does with it, so a
  // real Chromium would only cost time without adding a fact this test can
  // see. `evaluate` always rejects — the first (and only, for this
  // fixture) call `renderPhase` makes is `render(manifest)` — so this also
  // reinforces "no truncated file on failure" at zero browser cost.
  it("hands the in-page render the scene with the compositor's real version, not whatever the caller passed", async () => {
    const store = createFileFrameStore(tempDir("demoman-stamp-"));
    const scene = readonlyScene();
    expect(scene.meta.toolchain.compositorVersion).toBeNull();
    const bundle = await keyframeOnlyBundle(store, scene);

    let capturedScene: SceneDocument | undefined;
    const fakePage = {
      goto: async () => undefined,
      addScriptTag: async () => undefined,
      evaluate: async (_fn: unknown, args: unknown) => {
        const [, manifest] = args as [string, { scene: SceneDocument }];
        capturedScene = manifest.scene;
        throw new Error("fake page: no compositor runtime installed here");
      },
    } as unknown as Page;

    const outDir = tempDir("demoman-stamp-out-");
    const outPath = join(outDir, "demo.mp4");

    await expect(
      renderPhase({
        scene,
        bundle,
        store,
        page: fakePage,
        outPath,
        wallpapersDir: WALLPAPERS_DIR,
      }),
    ).rejects.toThrow();

    expect(capturedScene?.meta.toolchain.compositorVersion).toBe(
      COMPOSITOR_VERSION,
    );
    // The invariant this stands beside: a render that never got real bytes
    // back must not leave anything at --out.
    expect(existsSync(outPath)).toBe(false);
  });
});

describe("renderPhase on a wallpaper", () => {
  // `demoman render` reads the built-in file as an export does (review
  // finding 4, 2026-10-28). Red if renderPhase hands the page a reason, or
  // no wallpaper, instead of the file's bytes.
  it("hands the page the wallpaper's own bytes", async () => {
    const store = createFileFrameStore(tempDir("demoman-wallpaper-phase-"));
    const scene: SceneDocument = {
      ...readonlyScene(),
      branding: {
        ...readonlyScene().branding,
        background: { kind: "wallpaper", id: "vivid-1" },
      },
    };
    const bundle = await keyframeOnlyBundle(store, scene);
    let sent: unknown;
    const fakePage = {
      goto: async () => undefined,
      addScriptTag: async () => undefined,
      evaluate: async (_fn: unknown, args: unknown) => {
        sent = (args as [string, { wallpaper: unknown }])[1].wallpaper;
        throw new Error("fake page");
      },
    } as unknown as Page;
    await expect(
      renderPhase({
        scene,
        bundle,
        store,
        page: fakePage,
        outPath: join(tempDir("demoman-wallpaper-phase-out-"), "demo.mp4"),
        wallpapersDir: WALLPAPERS_DIR,
      }),
    ).rejects.toThrow();
    expect(sent).toEqual({
      base64: readFileSync(
        join(WALLPAPERS_DIR, wallpaperFile("vivid-1", "landscape")),
      ).toString("base64"),
      contentType: "image/webp",
      name: "vivid-1",
    });
  });

  // The picture: the margin is vivid-1, not the neutral gradient a left-out
  // wallpaper falls back to, and nothing is said left out.
  it("paints it, and warns of nothing", async () => {
    const store = createFileFrameStore(tempDir("demoman-wallpaper-paint-"));
    const scene: SceneDocument = {
      ...readonlyScene(),
      camera: [],
      branding: {
        ...readonlyScene().branding,
        background: { kind: "wallpaper", id: "vivid-1", blur: 0 },
        padding: 0.15,
      },
    };
    const bundle = await keyframeOnlyBundle(store, scene);
    const out = join(tempDir("demoman-wallpaper-paint-out-"), "demo.mp4");
    const launched = await launch();
    try {
      const rendered = await renderPhase({
        scene,
        bundle,
        store,
        page: launched.page,
        outPath: out,
        wallpapersDir: WALLPAPERS_DIR,
      });
      expect(rendered.wallpaperWarning).toBeNull();
      const [reading] = (
        await sampleMp4(readFileSync(out), {
          colors: [],
          blockPoints: [[0.04, 0.5]],
        })
      ).readings;
      const got = reading?.blocks[0] as Rgb;
      const hex = (h: string) =>
        [1, 3, 5].map((i) => Number.parseInt(h.slice(i, i + 2), 16));
      // Off both of the gradient's stops by more than any shade between them.
      for (const stop of [NEUTRAL_BACKGROUND.from, NEUTRAL_BACKGROUND.to]) {
        const want = hex(stop);
        expect(
          Math.max(
            ...[0, 1, 2].map((c) =>
              Math.abs((got[c] as number) - (want[c] as number)),
            ),
          ),
          JSON.stringify({ got, stop }),
        ).toBeGreaterThan(40);
      }
    } finally {
      await launched.close();
    }
  }, 180_000);
});

describe("renderPhase", () => {
  // Real Chromium, one landscape mp4, decoded back through the test-only
  // probe. `readonlyScene()`'s last action lands at 9000ms and this
  // fixture's widest keyframe (100px, `jpeg()`) is well under every
  // `pickLandscapeTarget` threshold, so this renders at LANDSCAPE_1080P —
  // matching `packages/compositor/test/browser/mp4.test.ts`'s own note that
  // a full-size target (as opposed to that test's deliberately shrunk one)
  // is the slower case, at LANDSCAPE_1080P's real 60fps rather than a
  // smaller custom target. Measured end to end on this machine (Apple
  // silicon, 2026-09-08, `--reporter=verbose`): 21.3s (browser launch,
  // esbuild bundling, the in-page compose-and-encode, and the chunked
  // transport back, all included). CI is ~5x slower at composing frames
  // (CLAUDE.md, `fff4505`), which puts the slowest of this near 107s;
  // 180_000 leaves real margin beyond that without being needlessly loose.
  it("writes an mp4 at the target's dimensions to --out", async () => {
    const store = createFileFrameStore(tempDir("demoman-render-"));
    const scene = readonlyScene();
    const bundle = await keyframeOnlyBundle(store, scene);
    const target = pickLandscapeTarget(bundle);
    expect(target.width).toBe(1920); // LANDSCAPE_1080P — see the docblock above

    const out = join(tempDir("demoman-out-"), "demo.mp4");
    const launched = await launch();
    try {
      await renderPhase({
        scene,
        bundle,
        store,
        page: launched.page,
        outPath: out,
        wallpapersDir: WALLPAPERS_DIR,
      });

      const bytes = readFileSync(out);
      expect(bytes.byteLength).toBeGreaterThan(10_000);

      const probe = await probeInPage(launched.page, bytes);
      expect(probe.hasTrack).toBe(true);
      expect(probe.displayWidth).toBe(target.width);
      expect(probe.displayHeight).toBe(target.height);
      expect(probe.canDecode).toBe(true);
    } finally {
      await launched.close();
    }
  }, 180_000);

  // Red if the runner ignores canvas.aspect: the file comes out 1920x1080.
  it("writes an Auto demo at the Auto frame's dimensions", async () => {
    const store = createFileFrameStore(tempDir("demoman-render-"));
    const scene: SceneDocument = {
      ...readonlyScene(),
      canvas: { aspect: "auto" },
      branding: { ...readonlyScene().branding, padding: 0 },
    };
    const bundle = await keyframeOnlyBundle(store, scene);
    const target = autoTarget(pickLandscapeTarget(bundle), bundle.viewport, 0);
    // Premise: the Auto frame is not the 16:9 preset this test would also
    // satisfy if the runner ignored the aspect.
    expect(target.height).not.toBe(pickLandscapeTarget(bundle).height);
    const out = join(tempDir("demoman-out-"), "demo.mp4");
    const launched = await launch();
    try {
      await renderPhase({
        scene,
        bundle,
        store,
        page: launched.page,
        outPath: out,
        wallpapersDir: WALLPAPERS_DIR,
      });
      const probe = await probeInPage(launched.page, readFileSync(out));
      expect(probe.displayWidth).toBe(target.width);
      expect(probe.displayHeight).toBe(target.height);
      expect(probe.canDecode).toBe(true);
    } finally {
      await launched.close();
    }
  }, 180_000);

  // `createMp4Sink.finish()` throws "mp4 sink finished with no frame added"
  // rather than returning an empty array (sink-mp4.ts) — but that EXACT
  // message is unreachable through this function: `renderScene`'s own
  // frame-count floor (`Math.max(1, …)`) guarantees at least one call to
  // `addFrame` for any bundle with a finite positive target fps, which
  // every `pickLandscapeTarget` result is. Verified empirically (not
  // assumed) with a throwaway probe against a `keyframes: []` bundle: the
  // failure that actually surfaces first is `findKeyframe`'s own
  // "frame bundle has no keyframes" — before the frame-count loop, and
  // before `createMp4Sink` is ever touched — and against a bundle with one
  // keyframe whose loader fails, the loader's own error, again before
  // `finish()`. So this test drives the SAME invariant the sink's own
  // throw exists to protect — a render that fails must not write a
  // truncated `--out` — through a failure this pipeline can actually reach:
  // a bundle naming a keyframe ref the store never received bytes for.
  it("reports the render's own failure rather than writing a truncated file", async () => {
    const store = createFileFrameStore(tempDir("demoman-render-missing-"));
    const scene = readonlyScene();
    const bundle: FrameBundle = {
      bundleVersion: 1,
      sceneId: scene.meta.id,
      source: "replay",
      dpr: 1,
      viewport: { width: 1280, height: 800 },
      keyframes: [
        {
          sourceTimeMs: 0,
          // Never written to `store` — this is the point.
          ref: `kf:${scene.meta.id}:missing`,
          width: FIXTURE_WIDTH,
          height: FIXTURE_HEIGHT,
          actionId: null,
          byteLength: 0,
        },
      ],
      motionSpans: [],
      cursorSamples: [{ sourceTimeMs: 0, x: 0, y: 0 }],
      cursorGaps: [],
      anchorRects: [],
      markers: [],
      degradations: [],
    };

    const out = join(tempDir("demoman-render-missing-out-"), "demo.mp4");
    const launched = await launch();
    try {
      await expect(
        renderPhase({
          scene,
          bundle,
          store,
          page: launched.page,
          outPath: out,
          wallpapersDir: WALLPAPERS_DIR,
        }),
      ).rejects.toThrow(/kf:.*missing|404|answered/);
      expect(existsSync(out)).toBe(false);
    } finally {
      await launched.close();
    }
  }, 60_000);
});

// ---- renderToFiles: the target, the logo and progress -----------------------

// Measured locally (Apple silicon, 2026-10-12, --reporter=verbose): the
// slowest single-render case took 19.9s (the 9:16 one, browser launch
// included); the two-render logo case took 32.9s. CI is ~5x slower at
// composing frames (CLAUDE.md, `fff4505`), so 100s per render (5x 20s) and
// twice that for the two-render case (5x 33s = 165s, under 200s).
const RENDER_TIMEOUT_MS = 100_000;

const MAGENTA: Rgb = [255, 0, 255];
/** A 10x10 SVG that is one flat magenta square: no colour in the fixture
 *  app or the default background is near it, so counting it counts the logo. */
const MAGENTA_SVG = new TextEncoder().encode(
  '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10" fill="#ff00ff"/></svg>',
);
const withLogo = (
  scene: SceneDocument,
  aspect: SceneAspect,
): SceneDocument => ({
  ...scene,
  canvas: { aspect },
  branding: {
    ...scene.branding,
    padding: 0.08,
    logo: { ref: "logo.svg", corner: "bottom-right", size: 0.1, opacity: 1 },
  },
});

/** The one file an mp4 or gif render hands back. */
function first(rendered: { files: { bytes: Buffer }[] }): { bytes: Buffer } {
  const file = rendered.files[0];
  if (file === undefined) throw new Error("the render produced no file");
  return file;
}

function freshStore(): RunnerStore {
  return createFileFrameStore(tempDir("demoman-render-bytes-"));
}

/** A blank page in a headless browser that closes with the test. */
async function blankPage(): Promise<Page> {
  const launched = await launch();
  onTestFinished(async () => {
    await launched.close();
  });
  return launched.page;
}

describe("renderToFiles", () => {
  // Through renderPhase, the path `demoman render` takes: it works the target
  // out itself, so a landscape rule put back there fails this. The file's
  // size also proves the in-page entry obeys the target it was handed.
  it(
    "renders a 9:16 take at VERTICAL_1080 through renderPhase",
    async () => {
      const scene = withLogo(readonlyScene(), "9:16");
      const store = freshStore();
      const bundle = await keyframeOnlyBundle(store, scene);
      // Premise: the extension's target for 9:16 is portrait, so a landscape
      // file cannot be the right answer.
      const target = targetFor("mp4", "9:16", bundle, frameOf(scene));
      expect(target).toMatchObject({
        width: VERTICAL_1080.width,
        height: VERTICAL_1080.height,
      });
      const page = await blankPage();
      const outPath = join(tempDir("demoman-vertical-out-"), "demo.mp4");
      await renderPhase({
        scene,
        bundle,
        store,
        page,
        outPath,
        wallpapersDir: WALLPAPERS_DIR,
      });
      const read = await sampleMp4(readFileSync(outPath), {
        colors: [MAGENTA],
      });
      expect([read.width, read.height]).toEqual([1080, 1920]);
    },
    RENDER_TIMEOUT_MS,
  );

  // The logo is drawn, and only when given: the no-logo render is the
  // control that makes the magenta count mean "the logo" and not "something
  // magenta in the fixture". Red if render-entry stops passing `logo` to
  // renderScene.
  it(
    "draws the logo it is given, and nothing magenta without it",
    async () => {
      const scene = withLogo(readonlyScene(), "16:9");
      const store = freshStore();
      const bundle = await keyframeOnlyBundle(store, scene);
      const target = targetFor("mp4", "16:9", bundle, frameOf(scene));
      const page = await blankPage();
      const drawn = await renderToFiles({
        wallpaper: null,
        scene,
        bundle,
        store,
        page,
        target,
        fileType: "mp4",
        logo: { ok: true, bytes: MAGENTA_SVG, contentType: "image/svg+xml" },
      });
      expect(drawn.logoWarning).toBeNull();
      const withIt = await sampleMp4(first(drawn).bytes, { colors: [MAGENTA] });
      const plain = await renderToFiles({
        wallpaper: null,
        scene,
        bundle,
        store,
        page: await blankPage(),
        target,
        fileType: "mp4",
        logo: null,
      });
      const without = await sampleMp4(first(plain).bytes, {
        colors: [MAGENTA],
      });
      const most = (r: typeof withIt) =>
        Math.max(...r.readings.map((x) => x.colorCounts[0] ?? 0));
      expect(
        most(without),
        JSON.stringify(without.readings.map((x) => x.colorCounts)),
      ).toBe(0);
      expect(
        most(withIt),
        JSON.stringify(withIt.readings.map((x) => x.colorCounts)),
      ).toBeGreaterThan(50);
    },
    RENDER_TIMEOUT_MS * 2,
  );

  // Report before you forgive: a logo that will not decode leaves the file
  // without it and says so; it never fails the render.
  it(
    "renders without a logo that will not decode, and says why",
    async () => {
      const scene = withLogo(readonlyScene(), "16:9");
      const store = freshStore();
      const bundle = await keyframeOnlyBundle(store, scene);
      const target = targetFor("mp4", "16:9", bundle, frameOf(scene));
      const out = await renderToFiles({
        wallpaper: null,
        scene,
        bundle,
        store,
        page: await blankPage(),
        target,
        fileType: "mp4",
        logo: {
          ok: true,
          bytes: new TextEncoder().encode("not an svg"),
          contentType: "image/svg+xml",
        },
      });
      expect(first(out).bytes.byteLength).toBeGreaterThan(0);
      expect(out.logoWarning).toMatch(/^The logo was left out: /);
    },
    RENDER_TIMEOUT_MS,
  );

  it(
    "passes a logo node could not read straight into the warning",
    async () => {
      const scene = withLogo(readonlyScene(), "16:9");
      const store = freshStore();
      const bundle = await keyframeOnlyBundle(store, scene);
      const target = targetFor("mp4", "16:9", bundle, frameOf(scene));
      const out = await renderToFiles({
        wallpaper: null,
        scene,
        bundle,
        store,
        page: await blankPage(),
        target,
        fileType: "mp4",
        logo: { ok: false, error: "/x/logo.svg could not be read (ENOENT)" },
      });
      expect(out.logoWarning).toBe(
        "The logo was left out: /x/logo.svg could not be read (ENOENT)",
      );
    },
    RENDER_TIMEOUT_MS,
  );

  // Progress reaches node, and its last report is the whole: the Export
  // answer's "rendering frame N of M" depends on it.
  it(
    "reports frames as it renders, ending at done === total",
    async () => {
      const scene = withLogo(readonlyScene(), "16:9");
      const store = freshStore();
      const bundle = await keyframeOnlyBundle(store, scene);
      const seen: [number, number][] = [];
      await renderToFiles({
        wallpaper: null,
        scene,
        bundle,
        store,
        page: await blankPage(),
        target: { ...LANDSCAPE_1080P, fps: 30 },
        fileType: "mp4",
        logo: null,
        onFrame: (done, total) => void seen.push([done, total]),
      });
      expect(seen.length).toBeGreaterThan(1);
      const last = seen.at(-1) as [number, number];
      expect(last[0]).toBe(last[1]);
    },
    RENDER_TIMEOUT_MS,
  );

  // Red until render-entry renders through renderOutput: it made MP4 only.
  it(
    "renders a gif when asked for one",
    async () => {
      const scene = withLogo(readonlyScene(), "16:9");
      const store = freshStore();
      const bundle = await keyframeOnlyBundle(store, scene);
      const target = targetFor("gif", "16:9", bundle, frameOf(scene));
      const rendered = await renderToFiles({
        wallpaper: null,
        scene,
        bundle,
        store,
        page: await blankPage(),
        target,
        fileType: "gif",
        logo: null,
      });
      expect(rendered.files).toHaveLength(1);
      const read = await sampleImage(first(rendered).bytes, "image/gif", {
        colors: [],
      });
      expect([read.width, read.height]).toEqual([target.width, target.height]);
      expect(read.frameCount).toBeGreaterThan(1);
    },
    RENDER_TIMEOUT_MS,
  );

  // The gif case above cannot tell fileType from target.format (the gif sink
  // follows the target), so this one pins the plumbing: only `fileType`
  // makes a render hand back a named png per step instead of one film.
  it(
    "renders a named png per step when asked for stills",
    async () => {
      const scene = withLogo(readonlyScene(), "16:9");
      const store = freshStore();
      const bundle = await keyframeOnlyBundle(store, scene);
      const target = targetFor("stills", "16:9", bundle, frameOf(scene));
      const rendered = await renderToFiles({
        wallpaper: null,
        scene,
        bundle,
        store,
        page: await blankPage(),
        target,
        fileType: "stills",
        logo: null,
      });
      expect(rendered.files.length).toBeGreaterThan(1);
      for (const file of rendered.files) {
        expect(file.name, "a still is named by renderStills").toMatch(/\.png$/);
      }
      const read = await sampleImage(first(rendered).bytes, "image/png", {
        colors: [],
      });
      expect([read.width, read.height]).toEqual([target.width, target.height]);
    },
    RENDER_TIMEOUT_MS,
  );
});

/**
 * Spec 2026-10-30 F: Haiku's Excalidraw take ended mid-pan, blurred. The
 * last zoom's pull-out is clamped to the film's end, and the film ran a
 * second past the last click, so it stopped part-way out. A button small
 * enough to zoom to, on a page striped edge to edge so any camera move
 * changes most of the picture; widths and positions explicit, so no glyph
 * advance moves a rect (CLAUDE.md, "The runner's fonts are not your fonts").
 */
const ENDING_APP = `<!doctype html><meta charset=utf-8><title>Ending</title>
<style>
  html, body { margin: 0; height: 100%; }
  body { background: repeating-linear-gradient(45deg,
    #ffffff 0 24px, #9aa8c4 24px 48px); }
  button { position: absolute; left: 580px; top: 380px; width: 120px;
    height: 48px; border: 0; padding: 0; background: #1e40af; color: #fff;
    font: 16px sans-serif; }
</style>
<button>Go</button>`;

/** Each consecutive pair's share of pixels whose grey level moved by more
 *  than `ENDING_LEVELS` — the encoder's grain stays under it. */
const ENDING_LEVELS = 12;
function changedShares(greys: string[]): number[] {
  const frames = greys.map((g) => Buffer.from(g, "base64"));
  return frames.slice(1).map((b, i) => {
    const a = frames[i] as Buffer;
    let moved = 0;
    for (let k = 0; k < b.length; k++) {
      if (Math.abs((b[k] as number) - (a[k] as number)) > ENDING_LEVELS)
        moved++;
    }
    return moved / b.length;
  });
}

describe("an agent take that ends on a click", () => {
  // A run of one click and a default export, through the CLI executor as an
  // agent's take is made. Measured locally at ~20 s; x5 for CI.
  it("the last 200 ms of an agent take that ends on a click are still", async () => {
    const server = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(ENDING_APP);
    });
    const url = await listenOnLoopback(server);
    const home = mkdtempSync(join(tmpdir(), "demoman-ending-"));
    const executor = createLocalExecutor({
      wallpapersDir: WALLPAPERS_DIR,
      home,
      headless: true,
      outDir: join(home, "out"),
      log: () => undefined,
    });
    onTestFinished(async () => {
      await executor.close();
      server.close();
      rmSync(home, { recursive: true, force: true });
    });
    const run = await executor.request("run", {
      video: ownVideo(),
      callId: "make-ending-take",
      script: {
        scriptVersion: 1,
        name: "Ending",
        target: url,
        viewport: { width: 1280, height: 800 },
        steps: [{ do: "waitForLoad" }, { do: "click", on: { text: "Go" } }],
      },
    });
    const report = run.ok
      ? (run.value as {
          provenance?: { takeId?: unknown };
          video?: {
            steps?: { kind: string; outputMs: number | null }[];
            finalFrame?: { settled: boolean };
          };
        })
      : null;
    const takeId = report?.provenance?.takeId;
    const clickMs = report?.video?.steps?.find(
      (s) => s.kind === "click",
    )?.outputMs;
    if (typeof takeId !== "string" || typeof clickMs !== "number") {
      throw new Error(`the ending take was not made: ${JSON.stringify(run)}`);
    }
    const out = await executor.request("export", {
      takeId,
      callId: "e-ending",
    });
    if (!out.ok) throw new Error(JSON.stringify(out));
    const answer = out.value as ExportAnswer;
    if (answer.outcome !== "saved" || answer.fileType === "stills") {
      throw new Error(JSON.stringify(answer));
    }
    const bytes = await readFile(answer.file.path);
    const { timesSec } = await mp4FrameTimes(bytes);
    const endSec = timesSec.at(-1) ?? 0;
    const between = (fromSec: number, toSec: number) =>
      timesSec.filter((t) => t >= fromSec && t <= toSec);
    const last = between(endSec - 0.2, endSec);
    // The positive control: a second after the click the camera is on its
    // way back out of the zoom (held 1.2 s from its arrival 350 ms before
    // the click), and the picture moves.
    const moving = between(clickMs / 1000 + 1, clickMs / 1000 + 1.2);
    const evidence = JSON.stringify({ clickMs, endSec, last, moving });
    // The premises: each window holds a run of decoded frames, and the
    // film runs past the moving one.
    expect(last.length, evidence).toBeGreaterThanOrEqual(5);
    expect(moving.length, evidence).toBeGreaterThanOrEqual(5);
    expect(endSec, evidence).toBeGreaterThan(clickMs / 1000 + 1.2);

    const read = async (atSecs: number[]) => {
      const crops = await readMp4Crops(
        bytes,
        atSecs,
        [0, 0, 1, 1],
        { width: 320, height: 180 },
        true,
      );
      // Each a frame of its own, not one decoded twice.
      expect(
        new Set(crops.map((c) => c.frameSec)).size,
        JSON.stringify(crops.map((c) => c.frameSec)),
      ).toBe(atSecs.length);
      return changedShares(crops.map((c) => c.grey as string));
    };
    const moved = await read(moving);
    const settled = await read(last);
    const said = JSON.stringify({ ...JSON.parse(evidence), moved, settled });
    expect(Math.min(...moved), said).toBeGreaterThan(0.01);
    expect(Math.max(...settled), said).toBeLessThan(0.01);
    // And the run's report says so.
    expect(report?.video?.finalFrame, JSON.stringify(report?.video)).toEqual({
      settled: true,
    });
  }, 300_000);
});

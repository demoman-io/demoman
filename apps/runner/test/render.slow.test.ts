// Slow tier: renders seven mp4s in software through renderPhase. `pnpm test:fast` skips it; `pnpm test` and CI run it.
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
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
import { frameOf, targetFor } from "@demoman/run-core";
import type { SceneAspect, SceneDocument } from "@demoman/scene-schema";
import type { Page } from "playwright";
import { describe, expect, it, onTestFinished } from "vitest";
import { readonlyScene } from "../../../packages/compositor/test/fixtures/scene.js";
import { bundleEntry } from "../src/bundle-js.js";
import type { Rgb } from "../src/decode-probe-entry.js";
import { RENDER_PROBE_GLOBAL } from "../src/entry-globals.js";
import { createFileFrameStore, type RunnerStore } from "../src/frame-store.js";
import { launch } from "../src/launch.js";
import { listenOnLoopback } from "../src/loopback.js";
import {
  createRenderServer,
  renderPhase,
  renderToFiles,
} from "../src/render.js";
import { FIXTURE_HEIGHT, FIXTURE_WIDTH, jpeg } from "./fixtures/jpeg.js";
import { sampleImage, sampleMp4 } from "./mp4-probe.js";
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
      renderPhase({ scene, bundle, store, page: fakePage, outPath }),
    ).rejects.toThrow();

    expect(capturedScene?.meta.toolchain.compositorVersion).toBe(
      COMPOSITOR_VERSION,
    );
    // The invariant this stands beside: a render that never got real bytes
    // back must not leave anything at --out.
    expect(existsSync(outPath)).toBe(false);
  });
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
      await renderPhase({ scene, bundle, store, page, outPath });
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

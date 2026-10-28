/**
 * The in-page half of the render phase (Task 12) — see `render.ts`'s header
 * docblock for the transport this reuses from `packages/compositor/scripts
 * /render-fixture.ts`.
 *
 * **This mirrors `apps/extension/entrypoints/offscreen/main.ts`'s
 * `framesFor`, not `render-fixture.ts`'s own `render-entry.ts`.** Both are
 * headless render harnesses and the resemblance is a trap:
 * `render-fixture.ts` serves a directory of numbered JPEGs because a
 * *harvest* is what it renders, and its own comment says a directory of
 * numbered JPEGs is a harvest artefact, not a shape the compositor ships.
 * Production's motion spans arrive as encoded video and go through
 * `createVideoFrameSource`; keyframes go through `createImageFrameSource`.
 * That split is the whole reason phase (a) — Task 11's mux — exists at all:
 * without it every motion span would have to render frozen.
 *
 * It renders MP4, GIF or stills through `renderOutput`
 * (`@demoman/run-core/render`), the function the extension's offscreen
 * document renders through too, at the target node decided (`targetFor`,
 * shared with the extension's export), with the take's logo. The point above
 * still holds, and `framesFor` is now literally the same function.
 */
import type {
  FrameBundle,
  FrameImage,
  RenderTarget,
} from "@demoman/compositor";
import type { CapRender, FileType, StillsOptions } from "@demoman/run-core";
import { decodeLogo } from "@demoman/run-core/logo";
import {
  framesFor,
  type LogoLoad,
  type RenderFacts,
  renderOutput,
  type WallpaperLoad,
  wholePercent,
} from "@demoman/run-core/render";
import { decodeWallpaper } from "@demoman/run-core/wallpaper";
import type { SceneDocument } from "@demoman/scene-schema";
import {
  RENDER_ENTRY_GLOBAL,
  RENDER_PROGRESS_BINDING,
} from "./entry-globals.js";

export interface RenderManifest {
  /** Stamped with `COMPOSITOR_VERSION` by `render.ts` before this ever
   *  sees it — this file does not stamp it itself, so it never has to know
   *  the compositor's own version number. */
  scene: SceneDocument;
  bundle: FrameBundle;
  /** Decided in node by `targetFor`, the function the extension's export
   *  resolves its target through — so the two doors cannot disagree about a
   *  9:16 or an Auto frame. */
  target: RenderTarget;
  /** Which output to make: one mp4, one gif, or a still per step. */
  fileType: FileType;
  /** The logo's bytes as node read them, or null for no logo. */
  logo: { base64: string; contentType: string } | null;
  /** The wallpaper's bytes as node read them, or why node could not; null
   *  for a solid or gradient background. */
  wallpaper:
    | { base64: string; contentType: string; name: string }
    | { error: string }
    | null;
  /** GIF only: how many bytes the GIF may grow to before a narrower width
   *  is tried (`renderOutput`'s `gifBudget`). Absent: the target's width. */
  gifBudget?: { maxBytes: number };
  /** MP4 only: the size cap and the share target its ladder stops at
   *  (`renderOutput`'s `mp4Cap`). Absent: one render at the target. */
  mp4Cap?: { maxBytes: number; share: RenderTarget };
  /** Stills only: their size and framing (`renderOutput`'s `stills`).
   *  Absent: the target, framed as the video. */
  stills?: StillsOptions;
}

export interface RenderedFacts extends RenderFacts {
  /** What is held in the page, by index: `readChunk` reads these. `name` is
   *  null for mp4 and gif (the caller names them), set for each still. */
  files: { name: string | null; byteLength: number }[];
  /** Where the page's time went (`stage-times.ts`): all of `renderOutput`,
   *  and the part of it spent waiting on source frames (fetch and decode). */
  timing: { renderMs: number; framesMs: number; frameReads: number };
}

export interface RenderEntry {
  render(manifest: RenderManifest): Promise<RenderedFacts>;
  /** `render-fixture.ts`'s `readChunk` transport, reused: a finished file
   *  can be tens of megabytes, so node pulls output `index` back in bounded
   *  base64 slices instead of risking the same crossing as one
   *  `page.evaluate` return value. */
  readChunk(index: number, offset: number, length: number): string;
}

// Its own copy, not `./report.js`'s: this file is bundled into the render
// page, and run-core's index (which that re-exports) is not page code.
const messageOf = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

function bytesOf(base64: string): Uint8Array {
  const binary = atob(base64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/**
 * Fetches one blob off `render.ts`'s own http server and routes on the ref
 * prefix exactly as `apps/extension/src/adapters/bundle-source.ts`'s `load`
 * does: `span:` is encoded video for the demuxer, anything else becomes an
 * `ImageBitmap`. Getting that backwards is a caller bug both frame sources
 * are written to name (`createVideoFrameSource` throws on a keyframe that
 * loads as bytes, `createImageFrameSource` on a span) — it should stay that
 * way here, so this does not try to be clever about telling them apart
 * itself.
 */
async function load(ref: string): Promise<Uint8Array | FrameImage> {
  const response = await fetch(`/${encodeURIComponent(ref)}`);
  if (!response.ok) {
    throw new Error(
      `render-entry: fetching frame "${ref}" from the render phase's own ` +
        `server answered ${response.status} — the bundle names a ref the ` +
        "store does not hold",
    );
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (ref.startsWith("span:")) return bytes;
  const blob = new Blob([bytes], { type: "image/jpeg" });
  const bitmap = await createImageBitmap(blob);
  // Stamped over by both frame sources' own callers before it reaches a
  // renderer — see bundle-source.ts's identical comment on its `load`.
  return {
    image: bitmap,
    width: bitmap.width,
    height: bitmap.height,
    sourceTimeMs: 0,
  };
}

// One render per page load: `render.ts` drives this page once per export,
// so the outputs are overwritten rather than accumulated.
let outputs: Uint8Array[] = [];

/**
 * The software encoder unless a target names one (`share-measure` does).
 * Which encoder Chromium offers depends on whether its GPU is on — headless
 * on macOS gets VideoToolbox only with `HEADLESS_GPU_ARGS` — and the encoders
 * size files differently: on 2026-10-25 one take's export went from 9.0 to
 * 12.9 Mbps on VideoToolbox, and the share target opened quantizer mode its
 * thresholds were not measured under. Pinned, the file is the same whatever
 * the GPU, the window or the platform. Every cap step spreads `target` or
 * `share`, so pinning both reaches them all.
 */
function softwareEncoded(target: RenderTarget): RenderTarget {
  return {
    ...target,
    encoder: {
      ...target.encoder,
      hardwareAcceleration:
        target.encoder?.hardwareAcceleration ?? "prefer-software",
    },
  };
}

async function render(manifest: RenderManifest): Promise<RenderedFacts> {
  const { scene, bundle, target, fileType } = manifest;
  // The logo is decoration: one that will not decode leaves the file
  // without it and says so (`renderOutput`'s logoWarning).
  let logo: LogoLoad | null = null;
  if (manifest.logo !== null) {
    try {
      logo = {
        ok: true,
        source: await decodeLogo(
          bytesOf(manifest.logo.base64),
          manifest.logo.contentType,
        ),
      };
    } catch (error) {
      logo = { ok: false, error: messageOf(error) };
    }
  }
  // Decoration too: decoded at its own size here, and rasterised per
  // output by `renderOutput`; one that will not decode is its
  // wallpaperWarning, and the frame shows the gradient.
  let wallpaper: WallpaperLoad | null = null;
  const sent = manifest.wallpaper;
  if (sent !== null && "error" in sent) {
    wallpaper = { ok: false, error: sent.error };
  } else if (sent !== null) {
    try {
      wallpaper = {
        ok: true,
        name: sent.name,
        image: await decodeWallpaper(bytesOf(sent.base64), sent.contentType),
      };
    } catch (error) {
      wallpaper = { ok: false, error: `${sent.name}: ${messageOf(error)}` };
    }
  }
  const report = (globalThis as unknown as Record<string, unknown>)[
    RENDER_PROGRESS_BINDING
  ] as
    | ((done: number, total: number, width?: number, pass?: CapRender) => void)
    | undefined;
  const started = performance.now();
  const source = await framesFor(bundle, load);
  let framesMs = 0;
  let frameReads = 0;
  // Every member forwarded by name: the source can be a class instance, whose
  // methods a spread would not copy.
  const frames: typeof source = {
    at: async (ms) => {
      const t = performance.now();
      try {
        return await source.at(ms);
      } finally {
        framesMs += performance.now() - t;
        frameReads++;
      }
    },
    describe: () => source.describe(),
    ...(source.close === undefined ? {} : { close: () => source.close?.() }),
    ...(source.warm === undefined
      ? {}
      : { warm: (from, to) => source.warm?.(from, to) }),
    ...(source.unavailable === undefined
      ? {}
      : { unavailable: () => source.unavailable?.() ?? [] }),
  };
  // Bytes or a reason, never an empty list: the sinks refuse a zero-frame
  // render and renderStills a take with no step left, and both throws
  // propagate out of this function unchanged.
  const { files, facts } = await renderOutput({
    fileType,
    target: softwareEncoded(target),
    scene,
    bundle,
    frames,
    logo,
    wallpaper,
    ...(manifest.gifBudget === undefined
      ? {}
      : { gifBudget: manifest.gifBudget }),
    ...(manifest.mp4Cap === undefined
      ? {}
      : {
          mp4Cap: {
            ...manifest.mp4Cap,
            share: softwareEncoded(manifest.mp4Cap.share),
          },
        }),
    ...(manifest.stills === undefined ? {} : { stills: manifest.stills }),
    onFrame: wholePercent((done, total, width, pass) =>
      width === undefined
        ? report?.(done, total)
        : pass === undefined
          ? report?.(done, total, width)
          : report?.(done, total, width, pass),
    ),
  });
  outputs = files.map((f) => f.bytes);
  return {
    ...facts,
    files: files.map((f) => ({ name: f.name, byteLength: f.bytes.byteLength })),
    timing: {
      renderMs: performance.now() - started,
      framesMs,
      frameReads,
    },
  };
}

function readChunk(index: number, offset: number, length: number): string {
  const output = outputs[index];
  if (!output) {
    throw new Error(
      `render-entry: readChunk asked for output ${index} of ${outputs.length}`,
    );
  }
  const slice = output.subarray(offset, offset + length);
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < slice.length; i += CHUNK) {
    binary += String.fromCharCode(...slice.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

const entry: RenderEntry = { render, readChunk };
(globalThis as unknown as Record<string, unknown>)[RENDER_ENTRY_GLOBAL] = entry;

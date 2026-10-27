/**
 * Phase two (b): the render phase. Composes the replayed (and now muxed)
 * bundle into a single mp4 and writes it to `--out`.
 *
 * **Mirrors `apps/extension/entrypoints/offscreen/main.ts`'s `framesFor` +
 * `renderOne`, not `packages/compositor/scripts/render-fixture.ts`.** Both
 * are headless render harnesses and the resemblance is a trap —
 * `render-fixture.ts` serves a directory of numbered JPEGs because a
 * *harvest* is what it renders, and its own `render-entry.ts` comment says
 * a directory of numbered JPEGs is a harvest artefact and not a shape the
 * compositor ships. `render-entry.ts` (this file's in-page half) routes
 * motion spans through `createVideoFrameSource` and keyframes through
 * `createImageFrameSource` instead — the production split.
 *
 * What IS borrowed from `render-fixture.ts`, deliberately, is only its
 * *transport*: a `file://` page cannot fetch the filesystem store, so this
 * starts a small http server of its own (same shape as `mux.ts`'s, which
 * borrows the identical transport for the same reason), bundles
 * `render-entry.ts` with esbuild, injects it with `page.addScriptTag`, and
 * pulls the finished mp4 back through `page.evaluate` in bounded base64
 * chunks (`CHUNK_BYTES`, matching `render-fixture.ts`'s own constant and
 * `mux.ts`'s reuse of it) rather than risking one `page.evaluate` call
 * carrying the whole file — the same crossing `mux.ts`'s header docblock
 * measures and refuses, on the output side rather than the input side.
 *
 * **`store.refs()`'s first real consumer.** The http server below does not
 * serve the store's directory verbatim: it builds an allow-list from
 * `refs()` once, up front, and answers only requests whose decoded ref is
 * in it. `refs()` deliberately excludes the `bundles/` subdirectory entry
 * (`frame-store.ts`'s own `listBlobRefs` filters to regular files), so this
 * server can never be asked to serve a bundle row as if it were a blob.
 */
import { promises as fs } from "node:fs";
import { createServer, type Server } from "node:http";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type ClampedRange,
  COMPOSITOR_VERSION,
  type DetailViolation,
  type FrameBundle,
  type LoweredZoom,
  type RenderTarget,
  type UnavailableSpan,
  type UnplacedStill,
} from "@demoman/compositor";
import {
  type CapRender,
  type FileType,
  frameOf,
  type GifSize,
  type StillsOptions,
  targetFor,
  type VideoCap,
} from "@demoman/run-core";
import type { SceneDocument } from "@demoman/scene-schema";
import type { Page } from "playwright";
import { bundleEntry } from "./bundle-js.js";
import {
  RENDER_ENTRY_GLOBAL,
  RENDER_PROGRESS_BINDING,
} from "./entry-globals.js";
import type { RunnerStore } from "./frame-store.js";
import { listenOnLoopback } from "./loopback.js";
import type {
  RenderEntry,
  RenderedFacts,
  RenderManifest,
} from "./render-entry.js";
import type { StageTimes } from "./stage-times.js";

/** Bytes pulled back per `page.evaluate` round trip for the finished mp4.
 *  Matches `render-fixture.ts`'s own `CHUNK_BYTES`, reused via `mux.ts` —
 *  the same transport, not a second one invented at a different number. */
const CHUNK_BYTES = 4_000_000;

/** The in-page entry, as this module is running: `src/render-entry.ts`
 *  under vite-node/tsx, `dist/render-entry.js` from the shipped CLI. Same
 *  rule as `mux.ts`'s own `ENTRY_PATH` — decided from this module's own
 *  extension, never by probing the filesystem. */
const ENTRY_PATH = fileURLToPath(
  new URL(
    import.meta.url.endsWith(".ts") ? "./render-entry.ts" : "./render-entry.js",
    import.meta.url,
  ),
);

let bundled: Promise<string> | null = null;
function renderEntryBundle(): Promise<string> {
  bundled ??= bundleEntry(ENTRY_PATH).catch((error: unknown) => {
    bundled = null;
    throw error;
  });
  return bundled;
}

/** Runs `render` on the page's `RENDER_ENTRY_GLOBAL`. Carries no closure
 *  over anything else in this module — `page.evaluate` serializes only this
 *  function's own source text and re-runs it inside the page — so the
 *  "is the global even installed" check is written out again here, same
 *  duplication `mux.ts`'s two `page.evaluate` call sites already carry. */
async function renderInPage(
  page: Page,
  manifest: RenderManifest,
): Promise<RenderedFacts> {
  return page.evaluate(
    ([globalName, renderManifest]) => {
      const entry = (
        globalThis as unknown as Record<string, RenderEntry | undefined>
      )[globalName as string];
      if (entry === undefined) {
        throw new Error(
          `${globalName} is not installed on this page — render.ts must ` +
            "inject render-entry.ts's bundle before calling into it",
        );
      }
      return entry.render(renderManifest as RenderManifest);
    },
    [RENDER_ENTRY_GLOBAL, manifest] as const,
  );
}

async function readChunkInPage(
  page: Page,
  index: number,
  offset: number,
  length: number,
): Promise<string> {
  return page.evaluate(
    ([globalName, outputIndex, chunkOffset, chunkLength]) => {
      const entry = (
        globalThis as unknown as Record<string, RenderEntry | undefined>
      )[globalName as string];
      if (entry === undefined) {
        throw new Error(
          `${globalName} is not installed on this page — render.ts must ` +
            "inject render-entry.ts's bundle before calling into it",
        );
      }
      return entry.readChunk(
        outputIndex as number,
        chunkOffset as number,
        chunkLength as number,
      );
    },
    [RENDER_ENTRY_GLOBAL, index, offset, length] as const,
  );
}

/**
 * Composes `bundle` into one landscape mp4 and writes it to `outPath`,
 * inside `page` — a BLANK page, for the same reason `mux.ts` needs one:
 * WebCodecs and OffscreenCanvas exist there and nowhere in node.
 *
 * `scene` is stamped with `COMPOSITOR_VERSION` here, once, before it ever
 * reaches the page — mirroring `offscreen/main.ts`'s `run()`, which does the
 * same before calling `renderOne`. There is no `replayEngineVersion` to
 * stamp alongside it: design §9 re-defers that field, and adding one here
 * would be a schema bump this project did not plan.
 *
 * Throws — never writes a truncated `outPath` — when the in-page render
 * fails for any reason, `createMp4Sink.finish()`'s own zero-frame refusal
 * included. The write below is the LAST thing this function does, after
 * every byte has already crossed back from the page; a thrown rejection at
 * any earlier point (the render itself, a chunk read) leaves `outPath`
 * untouched. See `render.slow.test.ts` for why "mp4 sink finished with no frame
 * added" specifically is not the failure this function's own test drives —
 * `renderScene`'s frame-count floor (`Math.max(1, …)`) makes that exact
 * message unreachable through this path, a fact this file's test proves
 * empirically rather than assumes.
 */
/**
 * The render phase's own http server: `/` is the blank page
 * `render-entry.ts` is injected into, and `/<encoded ref>` is that blob's
 * bytes, for refs in `allowed` only. Exported so its one failure path can
 * be driven without a render (`render.slow.test.ts`); `renderPhase` below is
 * its only production caller.
 */
export function createRenderServer(
  store: RunnerStore,
  allowed: ReadonlySet<string>,
): Server {
  return createServer((req, res) => {
    const url = req.url ?? "/";
    if (url === "/") {
      res.writeHead(200, { "content-type": "text/html" });
      res.end("<!doctype html><meta charset=utf-8><title>render</title>");
      return;
    }
    // Runner audit 2026-09-14: `decodeURIComponent` throws `URIError` on a
    // malformed percent-escape, and an exception thrown synchronously in
    // an http `request` listener is an uncaught exception — the whole
    // process, mid-render, with nothing on any stream naming the request.
    // A path this server cannot decode is a path it does not hold: 404,
    // the same answer an unknown ref gets.
    let ref: string;
    try {
      ref = decodeURIComponent(url.slice(1));
    } catch {
      res.writeHead(404).end();
      return;
    }
    if (!allowed.has(ref)) {
      res.writeHead(404).end();
      return;
    }
    store.load(ref).then(
      (bytes) => {
        res.writeHead(200, { "content-type": "application/octet-stream" });
        res.end(Buffer.from(bytes));
      },
      () => {
        // `ref` was in the allow-list a moment ago; a read failing anyway
        // (removed between listing and reading) is the same "not there" a
        // ref never listed reports — a 404 either way, not a 500 that would
        // read as this server's own bug.
        res.writeHead(404).end();
      },
    );
  });
}

export type LogoInput =
  | { ok: true; bytes: Uint8Array; contentType: string }
  | { ok: false; error: string };

export interface Rendered {
  /** One file, `name: null`, for mp4 and gif; a named file per still. */
  files: { name: string | null; bytes: Buffer }[];
  detailViolations: DetailViolation[];
  unavailableSpans: UnavailableSpan[];
  /** Zooms a 9:16 frame capped or narrowed; see `zoomWarnings`. */
  loweredZooms: LoweredZoom[];
  /** Steps that got no still; empty for mp4 and gif. */
  unplacedStills: UnplacedStill[];
  /** "The logo was left out: …", or null when there was none to leave. */
  logoWarning: string | null;
  /** What the plan clamped. */
  clampedRanges: ClampedRange[];
  /** The size the file was rendered at: the target, or wider for a GIF
   *  with a budget. */
  rendered: { width: number; height: number; fps: number };
  /** Set for a GIF rendered under a budget: see `GifSize`. */
  gifBudget?: GifSize;
  /** Set for an MP4 rendered under a size cap: see `VideoCap`. */
  videoCap?: VideoCap;
  /** Stills whose asked width the 4K cap cut: the width asked for. */
  stillsCapped?: { askedWidth: number };
}

/**
 * Composes `bundle` into `fileType` (one mp4, one gif, or a still per step) at
 * `target` inside `page` and hands the files' bytes
 * back — written nowhere, so the CLI's export can choose a name that does not
 * overwrite (save.ts) and the pipeline can write to `--out`. Throws on any
 * render failure; a logo is never a reason to throw (`logoWarning`). With
 * `onFrame` it exposes a binding on `page`, so each such call needs a page of
 * its own.
 */
export async function renderToFiles(input: {
  scene: SceneDocument;
  bundle: FrameBundle;
  store: RunnerStore;
  page: Page;
  target: RenderTarget;
  fileType: FileType;
  logo: LogoInput | null;
  /** See `renderOutput`'s `onFrame`: a budgeted GIF and a capped MP4 add
   *  their width, and a capped MP4 which render it is. */
  onFrame?: (
    done: number,
    total: number,
    width?: number,
    pass?: CapRender,
  ) => void;
  /** See `RenderManifest.gifBudget`. */
  gifBudget?: { maxBytes: number };
  /** See `RenderManifest.mp4Cap`. */
  mp4Cap?: { maxBytes: number; share: RenderTarget };
  /** See `RenderManifest.stills`. */
  stills?: StillsOptions;
  /** Marked at each of this render's stages (`stage-times.ts`). */
  times?: StageTimes;
}): Promise<Rendered> {
  const {
    scene,
    bundle,
    store,
    page,
    target,
    fileType,
    logo,
    onFrame,
    gifBudget,
    mp4Cap,
    stills,
    times,
  } = input;
  const stamped: SceneDocument = {
    ...scene,
    meta: {
      ...scene.meta,
      toolchain: {
        ...scene.meta.toolchain,
        compositorVersion: COMPOSITOR_VERSION,
      },
    },
  };

  // The allow-list `render-entry.ts`'s `load(ref)` is served from — see the
  // module docblock for why this is `refs()`'s first real consumer.
  const allowed = new Set(await store.refs());
  const server = createRenderServer(store, allowed);
  // Loopback only — see `listenOnLoopback`.
  const origin = await listenOnLoopback(server);

  try {
    // Before navigating: an exposed function is installed for the page's
    // future documents. Absent onFrame, nothing is exposed and the entry's
    // `report?.` finds no binding.
    if (onFrame !== undefined) {
      await page.exposeFunction(
        RENDER_PROGRESS_BINDING,
        (done: number, total: number, width?: number, pass?: CapRender) =>
          onFrame(done, total, width, pass),
      );
    }
    await page.goto(origin);
    await page.addScriptTag({ content: await renderEntryBundle() });
    times?.mark("render page");

    const facts = await renderInPage(page, {
      scene: stamped,
      bundle,
      target,
      fileType,
      logo:
        logo?.ok === true
          ? {
              base64: Buffer.from(logo.bytes).toString("base64"),
              contentType: logo.contentType,
            }
          : null,
      ...(gifBudget === undefined ? {} : { gifBudget }),
      ...(mp4Cap === undefined ? {} : { mp4Cap }),
      ...(stills === undefined ? {} : { stills }),
    });
    times?.mark("render");
    const { renderMs, framesMs, frameReads } = facts.timing;
    times?.note(
      `in page: render ${(renderMs / 1000).toFixed(2)}s, of it ${(framesMs / 1000).toFixed(2)}s waiting on ${frameReads} frame reads, ${((renderMs - framesMs) / 1000).toFixed(2)}s drawing, encoding and finishing (${facts.rendered.width}x${facts.rendered.height} ${facts.rendered.fps}fps)`,
    );

    const files: Rendered["files"] = [];
    for (const [index, meta] of facts.files.entries()) {
      const parts: Buffer[] = [];
      for (let offset = 0; offset < meta.byteLength; offset += CHUNK_BYTES) {
        const base64 = await readChunkInPage(page, index, offset, CHUNK_BYTES);
        parts.push(Buffer.from(base64, "base64"));
      }
      files.push({ name: meta.name, bytes: Buffer.concat(parts) });
    }
    times?.mark("read back");
    return {
      files,
      detailViolations: facts.detailViolations,
      unavailableSpans: facts.unavailableSpans,
      loweredZooms: facts.loweredZooms,
      unplacedStills: facts.unplacedStills,
      logoWarning:
        logo !== null && !logo.ok
          ? `The logo was left out: ${logo.error}`
          : facts.logoWarning,
      clampedRanges: facts.clampedRanges,
      rendered: facts.rendered,
      ...(facts.gifBudget === undefined ? {} : { gifBudget: facts.gifBudget }),
      ...(facts.videoCap === undefined ? {} : { videoCap: facts.videoCap }),
      ...(facts.stillsCapped === undefined
        ? {}
        : { stillsCapped: facts.stillsCapped }),
    };
  } finally {
    server.close();
  }
}

/** `demoman render`'s phase: the scene's own aspect through `targetFor`, then
 *  the whole file written to `outPath` or nothing written. */
export async function renderPhase(input: {
  scene: SceneDocument;
  bundle: FrameBundle;
  store: RunnerStore;
  page: Page;
  outPath: string;
  /** Tests only: `RunPipeline`'s `maxTier`. */
  maxTier?: RenderTarget;
}): Promise<Rendered> {
  const { scene, bundle, outPath, maxTier } = input;
  const rendered = await renderToFiles({
    ...input,
    fileType: "mp4",
    target: targetFor("mp4", scene.canvas.aspect, bundle, frameOf(scene), {
      maxTier,
    }),
    // The runner's `render` command has no library to look a logo up in; a
    // scene that names one is told so rather than drawn without a word.
    logo:
      scene.branding.logo === null
        ? null
        : {
            ok: false,
            error: `demoman render reads no logo files (the scene names "${scene.branding.logo.ref}"); export through demoman-mcp --browser cli for a logo`,
          },
  });
  // Every byte is already back in node: a render that threw above never
  // touched the filesystem, so `outPath` is written whole or not at all.
  await fs.mkdir(dirname(outPath), { recursive: true });
  const file = rendered.files[0];
  if (file === undefined) throw new Error("the render produced no file");
  await fs.writeFile(outPath, file.bytes);
  return rendered;
}

// The harness `wallpaper-own.test.ts` and `wallpaper-own.slow.test.ts`
// share: an executor on a fresh home, the fixture app, a scratch folder
// outside the home for the paths a script names, and the PNGs put there.
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32, deflateSync } from "node:zlib";
import { BRANDING_DEFAULTS, type SceneBackground } from "@demoman/scene-schema";
import { afterAll, beforeAll } from "vitest";
import { createLibrary } from "../src/executor/library.js";
import {
  createLocalExecutor,
  type LocalExecutor,
} from "../src/package-entry.js";
import { ownVideo, serveFixtureApp, WALLPAPERS_DIR } from "./fixture.js";

// As executor.test.ts measured (2026-10-12): a run 6.2 s at the slowest
// locally, x5 for CI.
export const RUN_MS = 31_000;

export const ASSET_REF = /^assets\/[0-9a-f-]{36}\.webp$/;

/** A `width`x`height` PNG of one colour, encoded here (no browser), so the
 *  file on disk is the fixture the run is handed. */
export function flatPng(
  width: number,
  height: number,
  rgb: [number, number, number],
) {
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8); // 8-bit RGB
  const row = Buffer.concat([
    Buffer.from([0]),
    Buffer.alloc(width * 3, Buffer.from(rgb)),
  ]);
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

export const exists = (path: string) =>
  stat(path).then(
    () => true,
    () => false,
  );

export interface RunAnswer {
  outcome: string;
  reason?: string;
  detail?: string;
  field?: string | null;
  provenance?: { takeId: string | null };
  summary?: string;
  look?: { branding: string; wallpaperError: string | null } | null;
}

/** Registers the file's beforeAll/afterAll; read its members inside tests. */
export function ownHarness() {
  const h = {
    app: null as unknown as { url: string; close(): void },
    home: "",
    scratch: "",
    executor: null as unknown as LocalExecutor,
    lines: [] as string[],
  };
  beforeAll(async () => {
    h.app = await serveFixtureApp();
    h.home = await mkdtemp(join(tmpdir(), "demoman-own-home-"));
    // Outside the home: a path an agent names is anywhere on the machine.
    h.scratch = await mkdtemp(join(tmpdir(), "demoman-own-scratch-"));
    h.executor = createLocalExecutor({
      wallpapersDir: WALLPAPERS_DIR,
      home: h.home,
      headless: true,
      outDir: join(h.home, "out"),
      log: (line) => void h.lines.push(line),
    });
  }, 30_000);
  afterAll(async () => {
    await h.executor.close();
    h.app.close();
    await rm(h.home, { recursive: true, force: true });
    await rm(h.scratch, { recursive: true, force: true });
  }, 30_000);

  const scriptOn = (background?: SceneBackground) => ({
    scriptVersion: 1,
    name: "place an order",
    target: h.app.url,
    viewport: { width: 1280, height: 800 },
    steps: [
      { do: "waitForLoad" },
      { do: "click", on: { text: "Place order" } },
    ],
    ...(background === undefined
      ? {}
      : { look: { branding: { ...BRANDING_DEFAULTS, background } } }),
  });

  /** The run's answer, and its take's background as the library holds it.
   *  `video` defaults to a new one; a re-film passes `{ id }` and no script. */
  async function run(
    script: unknown,
    callId: string,
    video: unknown = ownVideo(),
  ) {
    const out = await h.executor.request("run", {
      video,
      ...(script === undefined ? {} : { script }),
      callId,
    });
    if (!out.ok) throw new Error(JSON.stringify(out));
    const value = out.value as RunAnswer;
    const takeId = value.provenance?.takeId ?? null;
    const scene =
      takeId === null ? null : await createLibrary(h.home).getScene(takeId);
    return { value, takeId, background: scene?.branding.background ?? null };
  }

  /** The home's default kit, on an image at `ref`. */
  const kitOn = (ref: string) =>
    writeFile(
      join(h.home, "kits.json"),
      JSON.stringify({
        kits: [
          {
            id: "k1",
            name: "Photo",
            branding: {
              ...BRANDING_DEFAULTS,
              background: { kind: "image", ref },
            },
          },
        ],
        default: "k1",
      }),
    );

  return { h, scriptOn, run, kitOn };
}

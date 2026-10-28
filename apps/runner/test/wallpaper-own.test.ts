import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32, deflateSync } from "node:zlib";
import { BRANDING_DEFAULTS, type SceneBackground } from "@demoman/scene-schema";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLibrary } from "../src/executor/library.js";
import {
  createLocalExecutor,
  type LocalExecutor,
} from "../src/package-entry.js";
import { ownVideo, serveFixtureApp, WALLPAPERS_DIR } from "./fixture.js";

// As executor.test.ts measured (2026-10-12): a run 6.2 s at the slowest
// locally, x5 for CI. A stills export of the same take: 120 s of margin.
const RUN_MS = 31_000;
const EXPORT_MS = 120_000;

/** A `width`x`height` PNG of one colour, encoded here (no browser), so the
 *  file on disk is the fixture the run is handed. */
function flatPng(width: number, height: number, rgb: [number, number, number]) {
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

const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const exists = (path: string) =>
  stat(path).then(
    () => true,
    () => false,
  );

let app: { url: string; close(): void };
let home: string;
let scratch: string;
let executor: LocalExecutor;

beforeAll(async () => {
  app = await serveFixtureApp();
  home = await mkdtemp(join(tmpdir(), "demoman-own-home-"));
  // Outside the home: a path an agent names is anywhere on the machine.
  scratch = await mkdtemp(join(tmpdir(), "demoman-own-scratch-"));
  executor = createLocalExecutor({
    wallpapersDir: WALLPAPERS_DIR,
    home,
    headless: true,
    outDir: join(home, "out"),
    log: () => undefined,
  });
}, 30_000);
afterAll(async () => {
  await executor.close();
  app.close();
  await rm(home, { recursive: true, force: true });
  await rm(scratch, { recursive: true, force: true });
}, 30_000);

const scriptOn = (background?: SceneBackground) => ({
  scriptVersion: 1,
  name: "place an order",
  target: app.url,
  viewport: { width: 1280, height: 800 },
  steps: [{ do: "waitForLoad" }, { do: "click", on: { text: "Place order" } }],
  ...(background === undefined
    ? {}
    : { look: { branding: { ...BRANDING_DEFAULTS, background } } }),
});

/** The run's answer, and its take's background as the library holds it. */
async function run(script: unknown, callId: string) {
  const out = await executor.request("run", {
    video: ownVideo(),
    script,
    callId,
  });
  if (!out.ok) throw new Error(JSON.stringify(out));
  const value = out.value as {
    outcome: string;
    reason?: string;
    detail?: string;
    field?: string | null;
    provenance?: { takeId: string | null };
  };
  const takeId = value.provenance?.takeId ?? null;
  const scene =
    takeId === null ? null : await createLibrary(home).getScene(takeId);
  return { value, takeId, background: scene?.branding.background ?? null };
}

const ASSET_REF = /^assets\/[0-9a-f-]{36}\.webp$/;

describe("an image path at the run door", () => {
  it(
    "a script's path becomes the take's own WebP under assets/, and the original is untouched",
    async () => {
      const photo = join(scratch, "photo.png");
      const original = flatPng(64, 48, [200, 40, 160]);
      await writeFile(photo, original);
      // The fixture: a real PNG, outside the home.
      expect(original.subarray(1, 4).toString("ascii")).toBe("PNG");
      expect(photo.startsWith(home)).toBe(false);

      const { value, background } = await run(
        scriptOn({ kind: "image", ref: photo }),
        "own-1",
      );
      expect(value.outcome, JSON.stringify(value)).toBe("complete");
      expect(background?.kind).toBe("image");
      const ref = (background as { ref: string }).ref;
      expect(ref).toMatch(ASSET_REF);
      const copy = await readFile(join(home, ref));
      // RIFF....WEBP: the copy is the fitted WebP, not the PNG copied.
      expect(copy.subarray(0, 4).toString("ascii")).toBe("RIFF");
      expect(copy.subarray(8, 12).toString("ascii")).toBe("WEBP");
      expect(sha(await readFile(photo))).toBe(sha(original));
    },
    RUN_MS,
  );

  it(
    "a script naming a missing path is refused wallpaperUnreadable, naming it, and makes no take",
    async () => {
      const gone = join(scratch, "gone.png");
      expect(await exists(gone)).toBe(false);
      const before = (await createLibrary(home).list()).length;
      const { value } = await run(
        scriptOn({ kind: "image", ref: gone }),
        "own-2",
      );
      expect(value).toMatchObject({
        outcome: "refusedBeforeRun",
        reason: "wallpaperUnreadable",
        field: "look.branding.background",
      });
      expect(value.detail).toContain(gone);
      expect((await createLibrary(home).list()).length).toBe(before);
    },
    RUN_MS,
  );

  it(
    "a script naming a file that is not an image is refused, saying it could not be opened",
    async () => {
      const notes = join(scratch, "notes.png");
      await writeFile(notes, "just some notes");
      const { value } = await run(
        scriptOn({ kind: "image", ref: notes }),
        "own-3",
      );
      expect(value).toMatchObject({
        outcome: "refusedBeforeRun",
        reason: "wallpaperUnreadable",
      });
      expect(value.detail).toBe(
        `The image "${notes}" could not be opened as an image`,
      );
    },
    RUN_MS,
  );
});

describe("an image path in the default kit", () => {
  const kitOn = async (ref: string) =>
    writeFile(
      join(home, "kits.json"),
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

  it(
    "an existing path is owned for the take, as a script's is",
    async () => {
      const photo = join(scratch, "kit-photo.png");
      await writeFile(photo, flatPng(32, 32, [20, 120, 220]));
      await kitOn(photo);
      const { value, background } = await run(scriptOn(), "kit-1");
      expect(value.outcome, JSON.stringify(value)).toBe("complete");
      expect((background as { ref: string }).ref).toMatch(ASSET_REF);
    },
    RUN_MS,
  );

  it(
    "a missing path still films, the take keeps the kit's ref, and its export says it was left out",
    async () => {
      const gone = join(scratch, "kit-gone.png");
      expect(await exists(gone)).toBe(false);
      await kitOn(gone);
      const { value, takeId, background } = await run(scriptOn(), "kit-2");
      expect(value.outcome, JSON.stringify(value)).toBe("complete");
      expect(background).toEqual({ kind: "image", ref: gone });
      const exported = await executor.request("export", {
        takeId,
        fileType: "stills",
        callId: "kit-2-export",
      });
      if (!exported.ok) throw new Error(JSON.stringify(exported));
      const answer = exported.value as {
        outcome: string;
        warnings?: { wallpaperWarning?: { kind: string; sentence: string } };
      };
      expect(answer.outcome, JSON.stringify(answer)).toBe("saved");
      expect(answer.warnings?.wallpaperWarning?.kind).toBe("leftOut");
      expect(answer.warnings?.wallpaperWarning?.sentence).toContain(gone);
    },
    RUN_MS + EXPORT_MS,
  );
});

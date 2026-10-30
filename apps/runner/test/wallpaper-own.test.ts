import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { WALLPAPER_LONG_SIDE } from "@demoman/compositor";
import { webpSize } from "@demoman/run-core";
import { BRANDING_DEFAULTS } from "@demoman/scene-schema";
import type { Page } from "playwright";
import { describe, expect, it } from "vitest";
import { createLibrary } from "../src/executor/library.js";
import { ownWallpaperImage } from "../src/executor/wallpaper-own.js";
import { videoOfTake } from "./fixture.js";
import {
  ASSET_REF,
  exists,
  flatPng,
  ownHarness,
  RUN_MS,
} from "./wallpaper-own-harness.js";

// The export half of the default kit's missing image is
// `wallpaper-own-export.test.ts`: it renders.

const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

const { h, run, scriptOn, kitOn } = ownHarness();

describe("an image path at the run door", () => {
  it(
    "a script's path becomes the take's own WebP under assets/, the original is untouched, and script.json keeps the path asked",
    async () => {
      const photo = join(h.scratch, "photo.png");
      const original = flatPng(64, 48, [200, 40, 160]);
      await writeFile(photo, original);
      // The fixture: a real PNG, outside the home.
      expect(original.subarray(1, 4).toString("ascii")).toBe("PNG");
      expect(photo.startsWith(h.home)).toBe(false);

      const { value, takeId, background } = await run(
        scriptOn({ kind: "image", ref: photo }),
        "own-1",
      );
      expect(value.outcome, JSON.stringify(value)).toBe("complete");
      expect(background?.kind).toBe("image");
      const ref = (background as { ref: string }).ref;
      expect(ref).toMatch(ASSET_REF);
      const copy = await readFile(join(h.home, ref));
      // RIFF....WEBP: the copy is the fitted WebP, not the PNG copied.
      expect(copy.subarray(0, 4).toString("ascii")).toBe("RIFF");
      expect(copy.subarray(8, 12).toString("ascii")).toBe("WEBP");
      expect(sha(await readFile(photo))).toBe(sha(original));
      // The record of what the script asked is the path, not the copy.
      const asked = JSON.parse(
        await readFile(
          join(h.home, "takes", takeId as string, "script.json"),
          "utf8",
        ),
      ) as { look: { branding: { background: unknown } } | null };
      expect(asked.look?.branding.background).toEqual({
        kind: "image",
        ref: photo,
      });
    },
    RUN_MS,
  );

  // Only where the image lives changes: red if the copy drops the blur, as
  // it did before blur was carried (a blurred take re-filmed sharp).
  it(
    "a script's blurred image keeps its blur on the take's own copy",
    async () => {
      const photo = join(h.scratch, "blurred.png");
      await writeFile(photo, flatPng(64, 48, [40, 160, 200]));
      const { value, background } = await run(
        scriptOn({ kind: "image", ref: photo, blur: 0.3 }),
        "own-blur",
      );
      expect(value.outcome, JSON.stringify(value)).toBe("complete");
      expect((background as { ref: string }).ref).toMatch(ASSET_REF);
      expect(background).toMatchObject({ kind: "image", blur: 0.3 });
    },
    RUN_MS,
  );

  it(
    "a script naming a missing path is refused wallpaperUnreadable, naming it, and makes no take",
    async () => {
      const gone = join(h.scratch, "gone.png");
      expect(await exists(gone)).toBe(false);
      const before = (await createLibrary(h.home).list()).length;
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
      expect((await createLibrary(h.home).list()).length).toBe(before);
    },
    RUN_MS,
  );

  it(
    "a script naming a file that is not an image is refused, saying it could not be opened",
    async () => {
      const notes = join(h.scratch, "notes.png");
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
  it(
    "an existing path is owned for the take, as a script's is",
    async () => {
      const photo = join(h.scratch, "kit-photo.png");
      await writeFile(photo, flatPng(32, 32, [20, 120, 220]));
      await kitOn(photo);
      const { value, background } = await run(scriptOn(), "kit-1");
      expect(value.outcome, JSON.stringify(value)).toBe("complete");
      expect((background as { ref: string }).ref).toMatch(ASSET_REF);
    },
    RUN_MS,
  );

  it(
    "a missing path still films, the take keeps the kit's ref, and a re-film of that take is not refused",
    async () => {
      const gone = join(h.scratch, "kit-gone.png");
      expect(await exists(gone)).toBe(false);
      await kitOn(gone);
      const first = await run(scriptOn(), "kit-2");
      expect(first.value.outcome, JSON.stringify(first.value)).toBe("complete");
      expect(first.background).toEqual({ kind: "image", ref: gone });
      // Filmed, and the run report says why the image is not the take's own
      // (ruling R19): in `look`, and in the summary an agent hands back.
      expect(first.value.look?.branding).toBe("defaultKit");
      expect(first.value.look?.wallpaperError).toContain(gone);
      expect(first.value.summary).toContain(
        first.value.look?.wallpaperError as string,
      );
      // The premise of the re-film: the script it builds from the take
      // carries the take's branding as `look.branding`, a path no agent
      // wrote, and the path is still gone.
      const takeScene = await createLibrary(h.home).getScene(
        first.takeId as string,
      );
      expect(takeScene?.branding.background).toEqual({
        kind: "image",
        ref: gone,
      });
      const linesBefore = h.lines.length;
      const again = await run(
        undefined,
        "kit-2-refilm",
        await videoOfTake(h.home, first.takeId as string),
      );
      expect(again.value.outcome, JSON.stringify(again.value)).toBe("complete");
      expect(again.background).toEqual({ kind: "image", ref: gone });
      // Kept, and said.
      expect(
        h.lines
          .slice(linesBefore)
          .some(
            (l) => l.includes("left as the take has it") && l.includes(gone),
          ),
        h.lines.slice(linesBefore).join("\n"),
      ).toBe(true);
    },
    RUN_MS * 2,
  );
});

describe("an image path in a kit the script names", () => {
  it(
    "a missing path is refused wallpaperUnreadable on look.kit, naming it, and makes no take",
    async () => {
      const gone = join(h.scratch, "named-kit-gone.png");
      expect(await exists(gone)).toBe(false);
      await kitOn(gone);
      const before = (await createLibrary(h.home).list()).length;
      const { value } = await run(
        { ...scriptOn(), scriptVersion: 2, look: { kit: "Photo" } },
        "named-kit-1",
      );
      expect(value).toMatchObject({
        outcome: "refusedBeforeRun",
        reason: "wallpaperUnreadable",
        field: "look.kit",
      });
      expect(value.detail).toContain('"Photo"');
      expect(value.detail).toContain(gone);
      expect((await createLibrary(h.home).list()).length).toBe(before);
    },
    RUN_MS,
  );

  it(
    "an existing path is owned for the take, and the report has no image error",
    async () => {
      const photo = join(h.scratch, "named-kit-photo.png");
      await writeFile(photo, flatPng(32, 32, [220, 120, 20]));
      await kitOn(photo);
      const { value, background } = await run(
        { ...scriptOn(), scriptVersion: 2, look: { kit: "Photo" } },
        "named-kit-2",
      );
      expect(value.outcome, JSON.stringify(value)).toBe("complete");
      expect(value.look?.branding).toBe("kit");
      expect(value.look?.wallpaperError).toBeNull();
      expect((background as { ref: string }).ref).toMatch(ASSET_REF);
    },
    RUN_MS,
  );
});

describe("the take's own copy is named by its source", () => {
  it(
    "the same file run twice answers one ref, named by its bytes, and writes one asset",
    async () => {
      const photo = join(h.scratch, "twice.png");
      const original = flatPng(40, 30, [90, 200, 60]);
      await writeFile(photo, original);
      const first = await run(
        scriptOn({ kind: "image", ref: photo }),
        "twice-1",
      );
      expect(first.value.outcome, JSON.stringify(first.value)).toBe("complete");
      const ref = (first.background as { ref: string }).ref;
      expect(ref).toBe(`assets/${sha(original)}.webp`);
      const assets = await readdir(join(h.home, "assets"));
      const written = (await stat(join(h.home, ref))).mtimeMs;
      const second = await run(
        scriptOn({ kind: "image", ref: photo }),
        "twice-2",
      );
      expect(second.value.outcome, JSON.stringify(second.value)).toBe(
        "complete",
      );
      expect((second.background as { ref: string }).ref).toBe(ref);
      expect(await readdir(join(h.home, "assets"))).toEqual(assets);
      expect((await stat(join(h.home, ref))).mtimeMs).toBe(written);
    },
    RUN_MS * 2,
  );

  it(
    "an already-fitted WebP outside the home is copied byte for byte, with no page",
    async () => {
      const photo = join(h.scratch, "to-fit.png");
      await writeFile(photo, flatPng(48, 36, [10, 90, 210]));
      const { value, background } = await run(
        scriptOn({ kind: "image", ref: photo }),
        "fitted-1",
      );
      expect(value.outcome, JSON.stringify(value)).toBe("complete");
      const fittedBytes = await readFile(
        join(h.home, (background as { ref: string }).ref),
      );
      // The premise: what a fit makes is a WebP within the long side.
      const size = webpSize(fittedBytes);
      expect(size).toEqual({ width: 48, height: 36 });
      expect(Math.max(48, 36)).toBeLessThanOrEqual(WALLPAPER_LONG_SIDE);
      // As a kept video's repo copy is: the take's bytes, under a new name.
      const repoCopy = join(h.scratch, "repo-copy.webp");
      await writeFile(repoCopy, fittedBytes);
      const noPage = {
        openWorkPage: () => {
          throw new Error("no page may be opened for a fitted WebP");
        },
      };
      const owned = await ownWallpaperImage(
        {
          ...BRANDING_DEFAULTS,
          background: { kind: "image", ref: repoCopy, blur: 0.3 },
        },
        { home: h.home, work: noPage, log: () => undefined },
      );
      if (!owned.ok) throw new Error(owned.detail);
      const ref = (owned.branding.background as { ref: string }).ref;
      expect(ref).toBe(`assets/${sha(fittedBytes)}.webp`);
      expect(sha(await readFile(join(h.home, ref)))).toBe(sha(fittedBytes));
      expect(owned.branding.background).toMatchObject({ blur: 0.3 });
      // One already under assets/ is the take's own: left as it is.
      const inAssets = {
        ...BRANDING_DEFAULTS,
        background: { kind: "image" as const, ref },
      };
      expect(
        await ownWallpaperImage(inAssets, {
          home: h.home,
          work: noPage,
          log: () => undefined,
        }),
      ).toEqual({ ok: true, branding: inAssets });
    },
    RUN_MS,
  );

  it(
    "an SVG under assets/ is fitted to a WebP, never passed on raw",
    async () => {
      await mkdir(join(h.home, "assets"), { recursive: true });
      const svg = join(h.home, "assets", "x.svg");
      await writeFile(
        svg,
        '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="30"><rect width="40" height="30" fill="#c83"/></svg>',
      );
      const { value, background } = await run(
        scriptOn({ kind: "image", ref: svg }),
        "assets-svg",
      );
      expect(value.outcome, JSON.stringify(value)).toBe("complete");
      const ref = (background as { ref: string }).ref;
      expect(ref).toMatch(ASSET_REF);
      const copy = await readFile(join(h.home, ref));
      expect(webpSize(copy)).not.toBeNull();
    },
    RUN_MS,
  );
});

describe("two owns of one source at once", () => {
  it("both succeed with the same ref, each writing its own temp file", async () => {
    const src = join(h.scratch, "twice.webp");
    const b = Buffer.alloc(30);
    b.write("RIFF", 0, "ascii");
    b.writeUInt32LE(22, 4);
    b.write("WEBPVP8X", 8, "ascii");
    b.writeUInt32LE(10, 16);
    b.writeUIntLE(99, 24, 3);
    b.writeUIntLE(99, 27, 3);
    await writeFile(src, b);
    // The premise: small enough to be copied whole, so no browser is needed.
    expect(webpSize(b)).toEqual({ width: 100, height: 100 });
    const deps = {
      home: h.home,
      work: {
        openWorkPage: async () => ({ ok: false, detail: "no page" }),
      } as never,
      log: () => {},
    };
    const branding = {
      ...BRANDING_DEFAULTS,
      background: { kind: "image" as const, ref: src },
    };
    const [a, c] = await Promise.all([
      ownWallpaperImage(branding, deps),
      ownWallpaperImage(branding, deps),
    ]);
    expect(a).toEqual(c);
    expect(a.ok, JSON.stringify(a)).toBe(true);
  });
});

describe("webpSize and the fit's failures, without a browser", () => {
  /** A RIFF/WEBP header with a VP8X chunk claiming `width`x`height`. */
  const vp8x = (width: number, height: number) => {
    const b = Buffer.alloc(30);
    b.write("RIFF", 0, "ascii");
    b.writeUInt32LE(22, 4);
    b.write("WEBPVP8X", 8, "ascii");
    b.writeUInt32LE(10, 16);
    b.writeUIntLE(width - 1, 24, 3);
    b.writeUIntLE(height - 1, 27, 3);
    return b;
  };

  it("reads a VP8X header's size, and nothing from a PNG", () => {
    expect(webpSize(vp8x(9601, 10))).toEqual({ width: 9601, height: 10 });
    expect(webpSize(flatPng(4, 4, [0, 0, 0]))).toBeNull();
  });

  it("a WebP over the long side is fitted, and a page that will not close is said", async () => {
    const big = join(h.scratch, "big.webp");
    await writeFile(big, vp8x(WALLPAPER_LONG_SIDE + 1, 10));
    const lines: string[] = [];
    let opened = 0;
    const page = {
      addScriptTag: () => Promise.reject(new Error("boom")),
      close: () => Promise.reject(new Error("stuck")),
    } as unknown as Page;
    const owned = await ownWallpaperImage(
      { ...BRANDING_DEFAULTS, background: { kind: "image", ref: big } },
      {
        home: h.home,
        work: {
          openWorkPage: async () => {
            opened++;
            return { ok: true, page };
          },
        },
        log: (line) => void lines.push(line),
      },
    );
    expect(opened).toBe(1);
    expect(owned).toEqual({ ok: false, detail: `The image ${big}: boom` });
    expect(lines).toEqual([
      `the page that resized ${big} would not close (stuck)`,
    ]);
  });
});

import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createLibrary } from "../src/executor/library.js";
import { videoOfTake } from "./fixture.js";
import {
  ASSET_REF,
  exists,
  flatPng,
  ownHarness,
  RUN_MS,
} from "./wallpaper-own-harness.js";

// The export half of the default kit's missing image is
// `wallpaper-own.slow.test.ts`: it renders.

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

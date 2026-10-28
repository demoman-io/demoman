import { copyFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { KeptScreens } from "@demoman/run-core";
import type { SceneDocument } from "@demoman/scene-schema";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type BrowserSession,
  createBrowserSession,
} from "../src/executor/browser.js";
import { exportTake } from "../src/executor/export.js";
import { createLibrary, type Library } from "../src/executor/library.js";
import { samePicture } from "../src/executor/same-picture.js";
import { createVideoStore } from "../src/executor/videos.js";
import { makeDiskTake, putTake } from "./disk-take.js";
import { LOGO_SVG, WALLPAPERS_DIR } from "./fixture.js";

// Measured locally (2026-10-27, M-series Mac, headless): the disk take
// about 2 s, each export 2-4 s, each comparison 2-6 s. x5 for CI
// (fff4505) with margin.
const SETUP_MS = 180_000;
const CASE_MS = 60_000;

let home: string;
let library: Library;
let session: BrowserSession;
const files: Record<string, string> = {};
const screens: Record<string, KeptScreens> = {};

async function exported(
  name: string,
  takeId: string,
  fileType: "mp4" | "gif",
  aspect?: "9:16",
): Promise<string> {
  const outDir = join(home, name);
  const answer = await exportTake(
    {
      takeId,
      fileType,
      unlisted: true,
      ...(aspect === undefined ? {} : { aspect }),
    },
    {
      wallpapersDir: WALLPAPERS_DIR,
      library,
      videos: createVideoStore(home, library),
      session,
      door: "agent",
      home,
      outDir,
      log: () => undefined,
    },
    () => undefined,
  );
  if (answer.outcome !== "saved" || answer.fileType === "stills")
    throw new Error(JSON.stringify(answer));
  screens[name] = answer.screens;
  return answer.file.path;
}

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), "demoman-same-picture-"));
  library = createLibrary(home);
  session = createBrowserSession({ headless: true, log: () => undefined });
  const { takeId, original, bundle } = await makeDiskTake(home);
  // The pointer holds still, as a run's does between steps: the disk take's
  // own glides for all 9 s, and a film never still is never at rest.
  const still = { sourceTimeMs: 0, x: 900, y: 600 };
  await putTake(home, takeId, original, {
    ...bundle,
    cursorSamples: [still, { ...still, sourceTimeMs: 9000 }],
  });
  files.mp4 = await exported("mp4", takeId, "mp4");
  files.gif = await exported("gif", takeId, "gif");
  files.tall = await exported("tall", takeId, "mp4", "9:16");
  // The same take with a logo in one corner: one region of every frame.
  await writeFile(join(home, "acme.svg"), LOGO_SVG);
  const withLogo: SceneDocument = {
    ...original,
    branding: {
      ...original.branding,
      logo: { ref: "acme.svg", corner: "top-right", size: 0.06, opacity: 1 },
    },
  };
  await library.putScene(withLogo);
  files.mp4Logo = await exported("mp4Logo", takeId, "mp4");
  files.gifLogo = await exported("gifLogo", takeId, "gif");
}, SETUP_MS);

afterAll(async () => {
  await session?.close();
  if (home) await rm(home, { recursive: true, force: true });
});

/** samePicture's answer when both files decoded; throws otherwise. */
async function compared(
  a: string,
  b: string,
  fileType: "mp4" | "gif",
  sa: KeptScreens,
  sb: KeptScreens,
): Promise<{ same: boolean; detail: string }> {
  const out = await samePicture(a, b, fileType, sa, sb, {
    session,
    log: console.warn,
  });
  if (!("same" in out)) throw new Error(JSON.stringify(out));
  return out;
}

const of = (name: string) => screens[name] as KeptScreens;

describe("samePicture", () => {
  // The fixture's premise, asserted: the moments below are what is compared.
  it("the disk take's exports record at least 2 screens", () => {
    for (const name of ["mp4", "gif", "mp4Logo", "gifLogo", "tall"])
      expect(of(name).moments.length, name).toBeGreaterThanOrEqual(2);
  });

  it(
    "an MP4 against a copy of itself is the same",
    async () => {
      const copy = join(home, "copy.mp4");
      await copyFile(files.mp4 as string, copy);
      const out = await compared(
        files.mp4 as string,
        copy,
        "mp4",
        of("mp4"),
        of("mp4"),
      );
      expect(out.same, out.detail).toBe(true);
      expect(out.detail).toMatch(
        /^at most 0\.0000% sharply and 0\.0000% faintly of the picture changed, over \d+ of \d+ screens$/,
      );
    },
    CASE_MS,
  );

  it(
    "an MP4 with a logo in one corner is not the same",
    async () => {
      const out = await compared(
        files.mp4 as string,
        files.mp4Logo as string,
        "mp4",
        of("mp4"),
        of("mp4Logo"),
      );
      expect(out.same, out.detail).toBe(false);
      expect(out.detail).toMatch(
        /% of the picture changed \w+ (before action \d+|on the final screen) at [\d.]+s, over the 0\.0\d+% allowed, of \d+ of \d+ screens$/,
      );
    },
    CASE_MS,
  );

  it(
    "a GIF against itself is the same, and with the logo is not",
    async () => {
      const gif = files.gif as string;
      expect((await compared(gif, gif, "gif", of("gif"), of("gif"))).same).toBe(
        true,
      );
      const out = await compared(
        gif,
        files.gifLogo as string,
        "gif",
        of("gif"),
        of("gifLogo"),
      );
      expect(out.same, out.detail).toBe(false);
      expect(out.detail).toMatch(/% of the picture changed/);
    },
    CASE_MS,
  );

  it(
    "another frame size is not the same",
    async () => {
      const out = await compared(
        files.mp4 as string,
        files.tall as string,
        "mp4",
        of("mp4"),
        of("tall"),
      );
      expect(out).toMatchObject({ same: false });
      expect(out.detail).toMatch(
        /^the frame size changed, \d+x\d+ to \d+x\d+$/,
      );
    },
    CASE_MS,
  );

  // Decided by the kept output's type, never guessed from a file name.
  it(
    "reads a GIF as a GIF whatever its file is called",
    async () => {
      const bin = join(home, "order.bin");
      await copyFile(files.gif as string, bin);
      const out = await samePicture(bin, bin, "gif", of("gif"), of("gif"), {
        session,
        log: console.warn,
      });
      expect(out, JSON.stringify(out)).toMatchObject({ same: true });
    },
    CASE_MS,
  );

  it(
    "says which file could not be decoded, and throws when no page opens",
    async () => {
      const junk = join(home, "junk.mp4");
      await writeFile(junk, "not a video");
      const mp4 = files.mp4 as string;
      const s = of("mp4");
      expect(
        await samePicture(junk, mp4, "mp4", s, s, {
          session,
          log: console.warn,
        }),
      ).toMatchObject({ undecodable: "committed" });
      expect(
        await samePicture(mp4, junk, "mp4", s, s, {
          session,
          log: console.warn,
        }),
      ).toMatchObject({ undecodable: "new" });
      await expect(
        samePicture(mp4, mp4, "mp4", s, s, {
          session: {
            openWorkPage: async () => ({
              ok: false,
              reason: "windowDidNotOpen",
              detail: "injected",
            }),
          },
          log: console.warn,
        }),
      ).rejects.toThrow("no page to decode on: injected");
    },
    CASE_MS,
  );

  it(
    "a committed screen past the committed file's end is uncomparable",
    async () => {
      const mp4 = files.mp4 as string;
      const s = of("mp4");
      const first = s.moments[0] as KeptScreens["moments"][number];
      const past: KeptScreens = {
        steps: s.steps,
        moments: [{ step: first.step, ms: 600_000 }],
      };
      const fresh: KeptScreens = { steps: s.steps, moments: [first] };
      const out = await samePicture(mp4, mp4, "mp4", past, fresh, {
        session,
        log: console.warn,
      });
      expect(out, JSON.stringify(out)).toMatchObject({
        uncomparable: expect.stringMatching(
          /^the committed video ends at [\d.]+s, before its screen at 600\.000s$/,
        ),
      });
    },
    CASE_MS,
  );
});

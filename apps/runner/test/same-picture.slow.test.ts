import { copyFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
import { makeDiskTake } from "./disk-take.js";
import { LOGO_SVG } from "./fixture.js";

// Measured locally (2026-10-27, M-series Mac, headless): the disk take
// about 2 s, each export 2-4 s, each comparison 2-6 s. x5 for CI
// (fff4505) with margin.
const SETUP_MS = 180_000;
const CASE_MS = 60_000;

let home: string;
let library: Library;
let session: BrowserSession;
const files: Record<string, string> = {};

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
  return answer.file.path;
}

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), "demoman-same-picture-"));
  library = createLibrary(home);
  session = createBrowserSession({ headless: true, log: () => undefined });
  const { takeId, original } = await makeDiskTake(home);
  files.mp4 = await exported("plain-mp4", takeId, "mp4");
  files.gif = await exported("plain-gif", takeId, "gif");
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
  files.mp4Logo = await exported("logo-mp4", takeId, "mp4");
  files.gifLogo = await exported("logo-gif", takeId, "gif");
}, SETUP_MS);

afterAll(async () => {
  await session?.close();
  if (home) await rm(home, { recursive: true, force: true });
});

/** samePicture's answer when both files decoded; throws otherwise. */
async function compared(
  ...args: Parameters<typeof samePicture>
): Promise<{ same: boolean; detail: string }> {
  const out = await samePicture(...args);
  if (!("same" in out)) throw new Error(JSON.stringify(out));
  return out;
}

describe("samePicture", () => {
  it(
    "an MP4 against a copy of itself is the same",
    async () => {
      const copy = join(home, "copy.mp4");
      await copyFile(files.mp4 as string, copy);
      const out = await compared(files.mp4 as string, copy, "mp4", {
        session,
      });
      expect(out.same, out.detail).toBe(true);
      expect(out.detail).toMatch(
        /^at most 0\.000% of the picture changed, over \d+ moments at rest$/,
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
        { session },
      );
      expect(out.same, out.detail).toBe(false);
      expect(out.detail).toMatch(
        /% of the picture changed at [\d.]+s, over the 0\.015% allowed, of \d+ moments at rest$/,
      );
    },
    CASE_MS,
  );

  it(
    "a GIF against itself is the same, and with the logo is not",
    async () => {
      const gif = files.gif as string;
      expect((await compared(gif, gif, "gif", { session })).same).toBe(true);
      const out = await compared(gif, files.gifLogo as string, "gif", {
        session,
      });
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
        {
          session,
        },
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
      const out = await samePicture(bin, bin, "gif", { session });
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
      expect(await samePicture(junk, mp4, "mp4", { session })).toMatchObject({
        undecodable: "committed",
      });
      expect(await samePicture(mp4, junk, "mp4", { session })).toMatchObject({
        undecodable: "new",
      });
      await expect(
        samePicture(mp4, mp4, "mp4", {
          session: {
            openWorkPage: async () => ({
              ok: false,
              reason: "windowDidNotOpen",
              detail: "injected",
            }),
          },
        }),
      ).rejects.toThrow("no page to decode on: injected");
    },
    CASE_MS,
  );
});

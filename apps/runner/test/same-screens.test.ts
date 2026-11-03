import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { KeptScreens } from "@demoman/run-core";
import { screenImageName } from "@demoman/run-core/render";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type BrowserSession,
  createBrowserSession,
} from "../src/executor/browser.js";
import { sameScreens } from "../src/executor/same-picture.js";

// Measured locally 2026-11-03: setup 2 s, each comparison 1-2 s; x5 for CI
// (fff4505) with margin.
const SETUP_MS = 60_000;
const CASE_MS = 60_000;

const SIZE = { width: 2560, height: 1440 };
const screens: KeptScreens = {
  steps: 2,
  moments: [
    { step: 0, ms: 0 },
    { step: 1, ms: 1000 },
    { step: null, ms: 2000 },
  ],
};
const NAMES = screens.moments.map((m) => screenImageName(m.step));

let home: string;
let session: BrowserSession;
const dirs: Record<string, string> = {};

/** A 1280x720 page with a big heading and some body text, as PNG bytes. */
async function drawn(heading: string, colour: string): Promise<Buffer> {
  const work = await session.openWorkPage();
  if (!work.ok) throw new Error(work.detail);
  try {
    const base64 = await work.page.evaluate(
      async ([text, fill]) => {
        const canvas = new OffscreenCanvas(1280, 720);
        const ctx = canvas.getContext(
          "2d",
        ) as OffscreenCanvasRenderingContext2D;
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(0, 0, 1280, 720);
        ctx.fillStyle = fill as string;
        ctx.font = "bold 120px sans-serif";
        ctx.fillText(text as string, 80, 200);
        ctx.fillStyle = "#374151";
        ctx.font = "40px sans-serif";
        ctx.fillText("Invoices due this week", 80, 400);
        const bytes = new Uint8Array(
          await (
            await canvas.convertToBlob({ type: "image/png" })
          ).arrayBuffer(),
        );
        let binary = "";
        for (const b of bytes) binary += String.fromCharCode(b);
        return btoa(binary);
      },
      [heading, colour] as const,
    );
    return Buffer.from(base64, "base64");
  } finally {
    await work.page.close();
  }
}

async function folder(name: string, bytes: Buffer[]): Promise<string> {
  const dir = join(home, name);
  await mkdir(dir);
  for (const [i, file] of bytes.entries())
    await writeFile(join(dir, NAMES[i] as string), file);
  return dir;
}

const side = (dir: string, size = SIZE) => ({ dir, screens, size });
const deps = () => ({ session, log: console.warn });

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), "demoman-same-screens-"));
  session = createBrowserSession({ headless: true, log: () => undefined });
  const plain = await drawn("Revenue", "#111827");
  const edited = await drawn("Revenue!", "#b91c1c");
  // Premise: the repainted heading is a different picture, not a copy.
  expect(edited.equals(plain), "the repainted image differs").toBe(false);
  dirs.a = await folder("a", [plain, plain, plain]);
  dirs.same = await folder("same", [plain, plain, plain]);
  dirs.edited = await folder("edited", [plain, edited, plain]);
  dirs.missing = await folder("missing", [plain, plain]);
  dirs.notPng = await folder("notPng", [
    plain,
    Buffer.from("this is not a picture"),
    plain,
  ]);
}, SETUP_MS);

afterAll(async () => {
  await session?.close();
  if (home) await rm(home, { recursive: true, force: true });
});

describe("sameScreens", () => {
  it("premise: three shared screens, each named by its step", () => {
    expect(NAMES).toEqual(["step-0.png", "step-1.png", "final.png"]);
  });

  it(
    "the same images are the same picture, over every screen",
    async () => {
      const out = await sameScreens(
        side(dirs.a as string),
        side(dirs.same as string),
        deps(),
      );
      expect(out).toMatchObject({ same: true });
      expect((out as { detail: string }).detail).toMatch(
        /^at most 0\.0000% sharply and 0\.0000% faintly of the picture changed, over 3 of 3 screens$/,
      );
    },
    CASE_MS,
  );

  it(
    "a repainted heading on one screen is a change, named by its step",
    async () => {
      const out = await sameScreens(
        side(dirs.a as string),
        side(dirs.edited as string),
        deps(),
      );
      expect(out).toMatchObject({ same: false });
      expect((out as { detail: string }).detail).toMatch(
        /% of the picture changed \w+ before action 2 at 1\.00s, over the 0\.0\d+% allowed, of 3 of 3 screens$/,
      );
    },
    CASE_MS,
  );

  it(
    "an image missing from either folder is uncomparable, naming the file",
    async () => {
      const gone = join(dirs.missing as string, "final.png");
      expect(
        await sameScreens(
          side(dirs.a as string),
          side(dirs.missing as string),
          deps(),
        ),
      ).toEqual({ uncomparable: `${gone} is missing` });
      const goneA = await sameScreens(
        side(dirs.missing as string),
        side(dirs.a as string),
        deps(),
      );
      expect(goneA).toEqual({ uncomparable: `${gone} is missing` });
    },
    CASE_MS,
  );

  it(
    "a file that is not a PNG is uncomparable, naming the file",
    async () => {
      const out = await sameScreens(
        side(dirs.a as string),
        side(dirs.notPng as string),
        deps(),
      );
      expect(out).toMatchObject({
        uncomparable: expect.stringContaining(
          `${join(dirs.notPng as string, "step-1.png")} could not be read as a PNG (`,
        ),
      });
    },
    CASE_MS,
  );

  it(
    "folders filmed at different sizes read the frame size changed",
    async () => {
      const out = await sameScreens(
        side(dirs.a as string),
        side(dirs.same as string, { width: 1920, height: 1080 }),
        deps(),
      );
      expect(out).toEqual({
        same: false,
        detail: "the frame size changed, 2560x1440 to 1920x1080",
      });
    },
    CASE_MS,
  );
});

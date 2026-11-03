import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

/** The badge drawn on every image, at the image's own 1280 width. */
const BADGE = { x: 900, y: 300, width: 200, height: 100 };
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
async function drawn(
  heading: string,
  colour: string,
  badge = "#2563eb",
): Promise<Buffer> {
  const work = await session.openWorkPage();
  if (!work.ok) throw new Error(work.detail);
  try {
    const base64 = await work.page.evaluate(
      async ([text, fill, badgeFill, box]) => {
        const canvas = new OffscreenCanvas(1280, 720);
        const ctx = canvas.getContext(
          "2d",
        ) as OffscreenCanvasRenderingContext2D;
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(0, 0, 1280, 720);
        ctx.fillStyle = fill as string;
        ctx.font = "bold 120px sans-serif";
        ctx.fillText(text as string, 80, 200);
        ctx.fillStyle = badgeFill as string;
        const b = box as typeof BADGE;
        ctx.fillRect(b.x, b.y, b.width, b.height);
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
      [heading, colour, badge, BADGE] as const,
    );
    return Buffer.from(base64, "base64");
  } finally {
    await work.page.close();
  }
}

/** Whether two PNGs differ in any pixel of a rect (image pixels). */
async function differsIn(
  a: Buffer,
  b: Buffer,
  r: { x: number; y: number; width: number; height: number },
): Promise<boolean> {
  const work = await session.openWorkPage();
  if (!work.ok) throw new Error(work.detail);
  try {
    return await work.page.evaluate(
      async ([x, y, r0]) => {
        const read = async (base64: string) => {
          const bmp = await createImageBitmap(
            await (await fetch(`data:image/png;base64,${base64}`)).blob(),
          );
          const c = new OffscreenCanvas(bmp.width, bmp.height);
          const ctx = c.getContext("2d") as OffscreenCanvasRenderingContext2D;
          ctx.drawImage(bmp, 0, 0);
          return ctx.getImageData(r0.x, r0.y, r0.width, r0.height).data;
        };
        const [p, q] = await Promise.all([read(x), read(y)]);
        return p.some((v, i) => v !== q[i]);
      },
      [a.toString("base64"), b.toString("base64"), r] as const,
    );
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

/** The target the windows below are in; its images are 1280 wide. */
const TARGET = { width: 2560, height: 1758 };
const windowed = (x: number, y: number, width: number, height: number) => ({
  ...screens,
  moments: screens.moments.map((m) => ({
    ...m,
    window: { x, y, width, height, radius: 0 },
  })),
});
/** Whether a window (target pixels) holds the whole badge once scaled to the
 *  image's 1280, or none of it. */
function holdsBadge(w: {
  x: number;
  y: number;
  width: number;
  height: number;
}) {
  const k = 1280 / TARGET.width;
  const [x0, y0, x1, y1] = [
    w.x * k,
    w.y * k,
    (w.x + w.width) * k,
    (w.y + w.height) * k,
  ];
  const across =
    x0 < BADGE.x + BADGE.width &&
    x1 > BADGE.x &&
    y0 < BADGE.y + BADGE.height &&
    y1 > BADGE.y;
  const whole =
    x0 <= BADGE.x &&
    x1 >= BADGE.x + BADGE.width &&
    y0 <= BADGE.y &&
    y1 >= BADGE.y + BADGE.height;
  return { across, whole };
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
  dirs.badge = await folder("badge", [
    plain,
    await drawn("Revenue", "#111827", "#16a34a"),
    plain,
  ]);
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

  // Windows are in the target's pixels, the images 1280 wide: a window read
  // at the wrong scale lands somewhere else on the image.
  it(
    "pixels outside the window count as unchanged, inside it as changed",
    async () => {
      const around = { x: 1600, y: 500, width: 800, height: 400 };
      const away = { x: 100, y: 100, width: 1200, height: 400 };
      // Premise: scaled to 1280, one holds the badge and the other none of it.
      expect(holdsBadge(around)).toEqual({ across: true, whole: true });
      expect(holdsBadge(away).across).toBe(false);
      const run = (w: typeof around, dir: string) => {
        const win = windowed(w.x, w.y, w.width, w.height);
        return sameScreens(
          { dir: dirs.a as string, screens: win, size: TARGET },
          { dir, screens: win, size: TARGET },
          deps(),
        );
      };
      // Premise: the badge folder's step 1 differs from the plain one inside
      // the badge's rect, and not in the heading's rows above it.
      const [plain1, badge1] = await Promise.all(
        [dirs.a, dirs.badge].map((d) =>
          readFile(join(d as string, NAMES[1] as string)),
        ),
      );
      expect(
        await differsIn(plain1 as Buffer, badge1 as Buffer, BADGE),
        "the badge pixels differ",
      ).toBe(true);
      expect(
        await differsIn(plain1 as Buffer, badge1 as Buffer, {
          x: 0,
          y: 0,
          width: 1280,
          height: BADGE.y,
        }),
        "the heading rows are identical",
      ).toBe(false);
      const inside = await run(around, dirs.badge as string);
      expect(inside, "the badge changed inside its window").toMatchObject({
        same: false,
      });
      const outside = await run(away, dirs.badge as string);
      expect(outside, "the badge changed outside the window").toMatchObject({
        same: true,
      });
      // Control: the window `away` does see a change in what it holds.
      const heading = await run(away, dirs.edited as string);
      expect(heading, "the heading changed inside its window").toMatchObject({
        same: false,
      });
    },
    CASE_MS,
  );
});

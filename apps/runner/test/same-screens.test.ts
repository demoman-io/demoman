import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PageScreens } from "@demoman/run-core";
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

/** The page at CSS 1x, as the house apps' page screens are (1710x1107). */
const PAGE = { width: 1710, height: 1107 };
/** Where the small grey line is drawn, and the one digit that differs. */
const LINE = { x: 1400, y: 900, width: 160, height: 20 };
const screens: PageScreens = {
  steps: 2,
  screens: [{ step: 0 }, { step: 1 }, { step: null }],
};
const NAMES = screens.screens.map((s) => screenImageName(s.step));

let home: string;
let session: BrowserSession;
const dirs: Record<string, string> = {};
const images: Record<string, Buffer> = {};

/** A page with a big heading, body text, and a line of 12 px grey text, as
 *  PNG bytes at `size`. */
async function drawn(
  heading: string,
  colour: string,
  grey = "14:11 local time",
  size = PAGE,
): Promise<Buffer> {
  const work = await session.openWorkPage();
  if (!work.ok) throw new Error(work.detail);
  try {
    const base64 = await work.page.evaluate(
      async ([text, fill, small, at, box]) => {
        const { width, height } = box as typeof PAGE;
        const canvas = new OffscreenCanvas(width, height);
        const ctx = canvas.getContext(
          "2d",
        ) as OffscreenCanvasRenderingContext2D;
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(0, 0, width, height);
        ctx.fillStyle = fill as string;
        ctx.font = "bold 120px sans-serif";
        ctx.fillText(text as string, 80, 200);
        ctx.fillStyle = "#374151";
        ctx.font = "40px sans-serif";
        ctx.fillText("Invoices due this week", 80, 400);
        // gray-500 on white, 12 px: the DEM-138 line.
        const l = at as { x: number; y: number };
        ctx.fillStyle = "#6b7280";
        ctx.font = "12px sans-serif";
        ctx.textBaseline = "top";
        ctx.fillText(small as string, l.x, l.y);
        const bytes = new Uint8Array(
          await (
            await canvas.convertToBlob({ type: "image/png" })
          ).arrayBuffer(),
        );
        let binary = "";
        for (const b of bytes) binary += String.fromCharCode(b);
        return btoa(binary);
      },
      [heading, colour, grey, LINE, size] as const,
    );
    return Buffer.from(base64, "base64");
  } finally {
    await work.page.close();
  }
}

/** The bounding box of the pixels two same-sized PNGs differ in, or null. */
async function differing(
  a: Buffer,
  b: Buffer,
): Promise<{ x0: number; y0: number; x1: number; y1: number } | null> {
  const work = await session.openWorkPage();
  if (!work.ok) throw new Error(work.detail);
  try {
    return await work.page.evaluate(
      async ([x, y]) => {
        const read = async (base64: string) => {
          const bmp = await createImageBitmap(
            await (await fetch(`data:image/png;base64,${base64}`)).blob(),
          );
          const c = new OffscreenCanvas(bmp.width, bmp.height);
          const ctx = c.getContext("2d") as OffscreenCanvasRenderingContext2D;
          ctx.drawImage(bmp, 0, 0);
          return {
            w: bmp.width,
            data: ctx.getImageData(0, 0, c.width, c.height).data,
          };
        };
        const [p, q] = await Promise.all([read(x), read(y)]);
        let box: { x0: number; y0: number; x1: number; y1: number } | null =
          null;
        for (let i = 0; i < p.data.length; i += 4) {
          if (
            p.data[i] === q.data[i] &&
            p.data[i + 1] === q.data[i + 1] &&
            p.data[i + 2] === q.data[i + 2]
          )
            continue;
          const px = (i / 4) % p.w;
          const py = Math.floor(i / 4 / p.w);
          box =
            box === null
              ? { x0: px, y0: py, x1: px, y1: py }
              : {
                  x0: Math.min(box.x0, px),
                  y0: Math.min(box.y0, py),
                  x1: Math.max(box.x1, px),
                  y1: Math.max(box.y1, py),
                };
        }
        return box;
      },
      [a.toString("base64"), b.toString("base64")] as const,
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

const side = (dir: string, sc: PageScreens = screens) => ({ dir, screens: sc });
const deps = () => ({ session, log: console.warn });

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), "demoman-same-screens-"));
  session = createBrowserSession({ headless: true, log: () => undefined });
  const plain = await drawn("Revenue", "#111827");
  images.plain = plain;
  images.edited = await drawn("Revenue!", "#b91c1c");
  images.digit = await drawn("Revenue", "#111827", "15:11 local time");
  // Premise: the repainted heading is a different picture, not a copy.
  expect(images.edited.equals(plain), "the repainted image differs").toBe(
    false,
  );
  dirs.a = await folder("a", [plain, plain, plain]);
  dirs.same = await folder("same", [plain, plain, plain]);
  dirs.edited = await folder("edited", [plain, images.edited, plain]);
  dirs.digit = await folder("digit", [plain, images.digit, plain]);
  const small = await drawn("Revenue", "#111827", undefined, {
    width: 1280,
    height: 800,
  });
  dirs.smaller = await folder("smaller", [plain, small, plain]);
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
  it("premise: three screens, each named by its step", () => {
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
      expect(out).toEqual({
        same: true,
        detail:
          "at most 0.0000% sharply and 0.0000% faintly of the picture changed, over 3 of 3 screens",
        skipped: [],
      });
    },
    CASE_MS,
  );

  // DEM-138. Red if the images are drawn smaller before they are compared,
  // as the receipt's 1280-wide screens were.
  it(
    "compares at the images' own size",
    async () => {
      // Premise: two 1710-wide pages that differ only inside the small grey
      // line, which is 12 px text.
      const box = await differing(
        images.plain as Buffer,
        images.digit as Buffer,
      );
      expect(box, "the digit's pixels differ").not.toBeNull();
      const b = box as NonNullable<typeof box>;
      expect(b.x0).toBeGreaterThanOrEqual(LINE.x);
      expect(b.x1).toBeLessThan(LINE.x + LINE.width);
      expect(b.y0).toBeGreaterThanOrEqual(LINE.y);
      expect(b.y1).toBeLessThan(LINE.y + LINE.height);
      const out = await sameScreens(
        side(dirs.a as string),
        side(dirs.digit as string),
        deps(),
      );
      expect(out, JSON.stringify(out)).toMatchObject({ same: false });
      expect((out as { detail: string }).detail).toMatch(
        /% of the picture changed \w+ before action 2, over the 0\.\d+% allowed, of 3 of 3 screens$/,
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
        { ...deps(), steps: [{ do: "waitForLoad" }, { do: "click" }] },
      );
      expect(out).toMatchObject({ same: false });
      expect((out as { detail: string }).detail).toMatch(
        /% of the picture changed \w+ before step 2, over the 0\.\d+% allowed, of 3 of 3 screens$/,
      );
    },
    CASE_MS,
  );

  // Red if an unsettled screen is compared (the edited one would read
  // changed) or skipped without saying so.
  it(
    "skips a screen unsettled on one side and names it",
    async () => {
      const unsettled: PageScreens = {
        ...screens,
        screens: [
          { step: 0 },
          { step: 1, unsettled: "the DOM never went quiet" },
          { step: null },
        ],
      };
      // Premise: compared, that screen is a change.
      expect(
        await sameScreens(
          side(dirs.a as string),
          side(dirs.edited as string),
          deps(),
        ),
      ).toMatchObject({ same: false });
      const out = await sameScreens(
        side(dirs.a as string),
        side(dirs.edited as string, unsettled),
        deps(),
      );
      expect(out).toEqual({
        same: true,
        detail:
          "at most 0.0000% sharply and 0.0000% faintly of the picture changed, over 2 of 3 screens; before action 2: the DOM never went quiet in the new video",
        skipped: ["before action 2: the DOM never went quiet in the new video"],
      });
    },
    CASE_MS,
  );

  // Review Focus 5's shape and the anti-goal: nothing compared is never
  // "unchanged".
  it(
    "no screen settled in both is uncomparable, never same",
    async () => {
      const never = (why: string): PageScreens => ({
        ...screens,
        screens: screens.screens.map((s) => ({ ...s, unsettled: why })),
      });
      const out = await sameScreens(
        side(dirs.a as string),
        side(dirs.same as string, never("2 requests in flight")),
        deps(),
      );
      expect(out).toEqual({
        uncomparable:
          "no screen settled in both the committed video and the new one; before action 1: 2 requests in flight in the new video; before action 2: 2 requests in flight in the new video; on the final screen: 2 requests in flight in the new video",
      });
    },
    CASE_MS,
  );

  it(
    "a different page size is a change",
    async () => {
      const out = await sameScreens(
        side(dirs.a as string),
        side(dirs.smaller as string),
        deps(),
      );
      expect(out).toEqual({
        same: false,
        detail: "the page size changed, 1710x1107 to 1280x800, before action 2",
        skipped: [],
      });
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
      expect(
        await sameScreens(
          side(dirs.missing as string),
          side(dirs.a as string),
          deps(),
        ),
      ).toEqual({ uncomparable: `${gone} is missing` });
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
    "steps or a look that differ are a change, before anything is read",
    async () => {
      const none = {} as never;
      expect(
        await sameScreens(
          side("/nowhere"),
          side("/nowhere", { ...screens, steps: 3 }),
          { session: none, log: () => undefined },
        ),
      ).toEqual({
        same: false,
        detail: "the video's steps changed, 2 to 3",
        skipped: [],
      });
      expect(
        await sameScreens(
          side("/nowhere", { ...screens, look: "a1" }),
          side("/nowhere", { ...screens, look: "b2" }),
          { session: none, log: () => undefined },
        ),
      ).toMatchObject({
        same: false,
        detail: expect.stringMatching(/^the look changed: /),
      });
    },
    CASE_MS,
  );
});

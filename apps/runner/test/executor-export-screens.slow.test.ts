import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type BrowserSession,
  createBrowserSession,
} from "../src/executor/browser.js";
import { exportTake } from "../src/executor/export.js";
import { createLibrary } from "../src/executor/library.js";
import { createVideoStore } from "../src/executor/videos.js";
import { makeDiskTake, putTake } from "./disk-take.js";
import { WALLPAPERS_DIR } from "./fixture.js";

// Measured locally (2026-10-27): the disk take about 2 s, each export 2-4 s.
// x5 for CI (fff4505) with margin.
const SETUP_MS = 180_000;

let home: string;
let session: BrowserSession;
let actions: number;
const answers: Record<string, unknown> = {};

async function exported(fileType: "mp4" | "gif", takeId: string) {
  const library = createLibrary(home);
  const answer = await exportTake(
    { takeId, fileType, unlisted: true },
    {
      wallpapersDir: WALLPAPERS_DIR,
      library,
      videos: createVideoStore(home, library),
      session,
      door: "agent",
      home,
      outDir: join(home, fileType),
      log: () => undefined,
    },
    () => undefined,
  );
  if (answer.outcome !== "saved" || answer.fileType === "stills")
    throw new Error(JSON.stringify(answer));
  return answer;
}

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), "demoman-export-screens-"));
  session = createBrowserSession({ headless: true, log: () => undefined });
  const { takeId, original, bundle } = await makeDiskTake(home);
  actions = original.actions.length;
  // The pointer holds still, as in same-picture.slow.test.ts: the disk
  // take's own glides for all 9 s, and a film never still has no screens.
  const still = { sourceTimeMs: 0, x: 900, y: 600 };
  await putTake(home, takeId, original, {
    ...bundle,
    cursorSamples: [still, { ...still, sourceTimeMs: 9000 }],
  });
  answers.mp4 = await exported("mp4", takeId);
  answers.gif = await exported("gif", takeId);
}, SETUP_MS);

afterAll(async () => {
  await session?.close();
  if (home) await rm(home, { recursive: true, force: true });
});

const screensOf = (k: string) =>
  (answers[k] as { screens?: { steps: number; moments: { ms: number }[] } })
    .screens;

describe("an export's answer carries the screens", () => {
  // Red if the answer drops the screens, or the render found none.
  it("names every step and at least two still screens, in order", () => {
    const screens = screensOf("mp4");
    expect(screens?.steps).toBe(actions);
    const ms = (screens?.moments ?? []).map((m) => m.ms);
    expect(ms.length, JSON.stringify(screens)).toBeGreaterThanOrEqual(2);
    expect(ms.every((t) => t >= 0)).toBe(true);
    expect(ms.every((t, i) => i === 0 || t > (ms[i - 1] as number))).toBe(true);
  });

  // Red if the GIF's render decides its own screens.
  it("gives a GIF the screens of the MP4", () => {
    // The premise: both have screens, so equality is not undefined === undefined.
    expect(screensOf("mp4")?.moments.length).toBeGreaterThan(0);
    expect(screensOf("gif")).toEqual(screensOf("mp4"));
  });
});

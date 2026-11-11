import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { KeptScreens } from "@demoman/run-core";
import { screenImageName } from "@demoman/run-core/render";
import type { SceneDocument } from "@demoman/scene-schema";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type BrowserSession,
  createBrowserSession,
} from "../src/executor/browser.js";
import { createLocalExecutor } from "../src/executor/executor.js";
import { exportTake, type ScreensAnswer } from "../src/executor/export.js";
import { createLibrary } from "../src/executor/library.js";
import { createVideoStore } from "../src/executor/videos.js";
import { makeDiskTake, putTake } from "./disk-take.js";
import { ownVideo, WALLPAPERS_DIR } from "./fixture.js";

// Measured locally (2026-10-27): the disk take about 2 s, each export 2-4 s.
// x5 for CI (fff4505) with margin. The recorded take (2026-11-10): its run
// about 6 s, as executor.test.ts measured one.
const SETUP_MS = 180_000;

let home: string;
let session: BrowserSession;
let actions: number;
let diskTakeId: string;
const answers: Record<string, unknown> = {};
/** How many work pages the exports below opened. */
let pagesOpened = 0;

/** Two buttons and a pause between them: a pause makes no action, so a
 *  screen counted by script step would be off by one after it. */
const PAUSED_APP = `<!doctype html><meta charset=utf-8><title>Paused</title>
<style>
  body { margin: 0; background: #fff; font: 16px sans-serif; }
  button { position: absolute; width: 160px; height: 48px; left: 80px; }
  #go { top: 80px; } #next { top: 200px; }
</style>
<button id=go onclick="document.title='went'">Go</button>
<button id=next onclick="this.textContent='Done'">Next</button>`;
const PAUSED_STEPS = [
  { do: "waitForLoad" },
  { do: "click", on: { text: "Go" } },
  { do: "pause", ms: 300 },
  { do: "click", on: { text: "Next" } },
];
let server: Server;
let pausedTakeId: string;

const exportDeps = (outDir: string) => {
  const library = createLibrary(home);
  return {
    wallpapersDir: WALLPAPERS_DIR,
    library,
    videos: createVideoStore(home, library),
    session: {
      ...session,
      openWorkPage: (...a: Parameters<BrowserSession["openWorkPage"]>) => {
        pagesOpened++;
        return session.openWorkPage(...a);
      },
    } as BrowserSession,
    door: "agent" as const,
    home,
    outDir,
    log: () => undefined,
  };
};

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
  diskTakeId = takeId;
  actions = original.actions.length;
  // The pointer holds still, as in same-picture.test.ts: the disk
  // take's own glides for all 9 s, and a film never still has no screens.
  const still = { sourceTimeMs: 0, x: 900, y: 600 };
  await putTake(home, takeId, original, {
    ...bundle,
    cursorSamples: [still, { ...still, sourceTimeMs: 9000 }],
  });
  answers.mp4 = await exported("mp4", takeId);
  answers.gif = await exported("gif", takeId);
  // A take recorded in real time, so it carries page screens.
  server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(PAUSED_APP);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const executor = createLocalExecutor({
    wallpapersDir: WALLPAPERS_DIR,
    home,
    headless: true,
    outDir: join(home, "out"),
    log: () => undefined,
  });
  try {
    const run = await executor.request("run", {
      video: ownVideo(),
      callId: "make-paused-take",
      script: {
        scriptVersion: 1,
        name: "Paused",
        target: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
        viewport: { width: 1280, height: 800 },
        steps: PAUSED_STEPS,
      },
    });
    const id = run.ok
      ? (run.value as { provenance?: { takeId?: unknown } }).provenance?.takeId
      : undefined;
    if (typeof id !== "string")
      throw new Error(`the paused take was not made: ${JSON.stringify(run)}`);
    pausedTakeId = id;
  } finally {
    await executor.close();
  }
}, SETUP_MS);

afterAll(async () => {
  await session?.close();
  server?.close();
  if (home) await rm(home, { recursive: true, force: true });
});

const screensOf = (k: string) =>
  (answers[k] as { screens?: KeptScreens }).screens;

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
    const times = (k: string) => {
      const s = screensOf(k);
      return {
        steps: s?.steps,
        look: s?.look,
        moments: s?.moments.map(({ step, ms }) => ({ step, ms })),
      };
    };
    expect(times("gif")).toEqual(times("mp4"));
    // Each window is the same one, in each file's own pixels.
    const k =
      (answers.gif as { width: number }).width /
      (answers.mp4 as { width: number }).width;
    const gif = screensOf("gif")?.moments ?? [];
    for (const [i, m] of (screensOf("mp4")?.moments ?? []).entries()) {
      const [a, b] = [m.window, gif[i]?.window];
      expect(a && b, JSON.stringify([a, b])).toBeTruthy();
      for (const key of ["x", "y", "width", "height"] as const)
        expect(
          Math.abs((b?.[key] ?? 0) - (a?.[key] ?? 0) * k),
          `${key} ${JSON.stringify([a, b])}`,
        ).toBeLessThan(1);
    }
  });
});

describe("a screens-only export copies the take's page screens", () => {
  it(
    "screensOnly copies the take's page screens, named by step, byte-identical",
    async () => {
      const library = createLibrary(home);
      const scene = (await library.getScene(pausedTakeId)) as SceneDocument;
      const store = library.frameStore(pausedTakeId);
      const page = (await store.getBundle(pausedTakeId))?.pageScreens ?? [];
      const evidence = JSON.stringify(page);
      // Premises: the script has a pause, which made no action, and the
      // take settled at least two screens, the opening and the final one.
      expect(PAUSED_STEPS.some((s) => s.do === "pause")).toBe(true);
      expect(scene.actions.length).toBe(PAUSED_STEPS.length - 1);
      const settled = page.filter((p) => p.unsettled === undefined);
      expect(settled.length, evidence).toBeGreaterThanOrEqual(2);
      expect(
        page.some((p) => p.after === scene.actions.length),
        evidence,
      ).toBe(true);

      // The mp4 export's screens (`screenMoments`) count what a step is.
      const mp4 = await exportTake(
        { takeId: pausedTakeId, fileType: "mp4", unlisted: true },
        exportDeps(join(home, "paused-mp4")),
        () => undefined,
      );
      if (mp4.outcome !== "saved" || mp4.fileType === "stills")
        throw new Error(JSON.stringify(mp4));
      const opened = pagesOpened;
      const out = (await exportTake(
        {
          takeId: pausedTakeId,
          fileType: "mp4",
          unlisted: true,
          screensOnly: true,
        },
        exportDeps(join(home, "paused-screens")),
        () => undefined,
      )) as ScreensAnswer;
      expect(out.outcome, JSON.stringify(out)).toBe("saved");
      // No render: the images are the take's own.
      expect(pagesOpened).toBe(opened);
      expect(out.screens.steps).toBe(mp4.screens?.steps);
      expect(out.screens.look).toBe(mp4.screens?.look);
      const step = (after: number) =>
        after < scene.actions.length ? after : null;
      expect(out.screens.screens).toEqual(
        page.map((p) => ({
          step: step(p.after),
          ...(p.unsettled === undefined ? {} : { unsettled: p.unsettled }),
        })),
      );
      expect((await readdir(out.folder.path)).sort()).toEqual(
        settled.map((p) => screenImageName(step(p.after))).sort(),
      );
      for (const p of settled) {
        const bytes = await readFile(
          join(out.folder.path, screenImageName(step(p.after))),
        );
        expect(
          Buffer.compare(
            bytes,
            Buffer.from((await store.getPageScreen(p.ref)) ?? []),
          ),
          `${p.ref} is copied byte for byte`,
        ).toBe(0);
      }
    },
    SETUP_MS,
  );

  // Review Focus 5: an older take has nothing to compare, and says why.
  it("screensOnly on a take with no page screens refuses, saying it was recorded before page screens or not in real time", async () => {
    const library = createLibrary(home);
    // Premise: the disk take carries none.
    expect(
      (await library.frameStore(diskTakeId).getBundle(diskTakeId))?.pageScreens,
    ).toBeUndefined();
    const out = await exportTake(
      {
        takeId: diskTakeId,
        fileType: "mp4",
        unlisted: true,
        screensOnly: true,
      },
      exportDeps(join(home, "none")),
      () => undefined,
    );
    expect(out).toMatchObject({
      outcome: "refusedBeforeExport",
      reason: "noFrames",
    });
    const detail = (out as { detail: string }).detail;
    expect(detail).toContain(`video ${diskTakeId} has no page screens`);
    expect(detail).toContain("recorded before page screens");
    expect(detail).toContain("not in real time");
  });
});

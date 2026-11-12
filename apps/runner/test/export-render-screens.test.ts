import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { BrowserSession } from "../src/executor/browser.js";

const renderToFiles = vi.hoisted(() => vi.fn());
vi.mock("../src/render.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/render.js")>()),
  renderToFiles,
}));

import { exportTake } from "../src/executor/export.js";
import { createLibrary } from "../src/executor/library.js";
import { createVideoStore } from "../src/executor/videos.js";
import { makeDiskTake } from "./disk-take.js";
import { WALLPAPERS_DIR } from "./fixture.js";

// makeDiskTake paints one frame in a browser: about 2 s here, x5 for CI.
const SETUP_MS = 60_000;

let home: string;
let takeId: string;

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), "demoman-export-render-screens-"));
  ({ takeId } = await makeDiskTake(home));
}, SETUP_MS);
afterAll(() => rm(home, { recursive: true, force: true }));

/**
 * Nothing compares a full export's render screens: refresh and keep compare
 * the take's page screens (a `screensOnly` export). So a render that found
 * none is a saved video, not a failed one (close review 9).
 */
describe("a full export whose render reports no screens", () => {
  // Red while the guard stands: the video was answered renderFailed, "the
  // mp4 render reported no screens", with its file thrown away.
  it("is saved, its file written and no screens said", async () => {
    const bytes = Buffer.from("not really an mp4");
    renderToFiles.mockResolvedValueOnce({
      files: [{ name: null, bytes }],
      detailViolations: [],
      unavailableSpans: [],
      loweredZooms: [],
      unplacedStills: [],
      logoWarning: null,
      wallpaperWarning: null,
      clampedRanges: [],
      rendered: { width: 1280, height: 720, fps: 30 },
    });
    const library = createLibrary(home);
    const outDir = join(home, "out");
    const answer = await exportTake(
      { takeId, fileType: "mp4", unlisted: true },
      {
        wallpapersDir: WALLPAPERS_DIR,
        library,
        videos: createVideoStore(home, library),
        session: {
          headless: true,
          openWorkPage: async () => ({
            ok: true,
            page: { isClosed: () => true },
          }),
        } as unknown as BrowserSession,
        door: "agent",
        home,
        outDir,
        log: () => undefined,
      },
      () => undefined,
    );
    // The premise: the render this case stands in for was the one asked.
    expect(renderToFiles).toHaveBeenCalledTimes(1);
    expect(answer.outcome, JSON.stringify(answer)).toBe("saved");
    if (answer.outcome !== "saved" || answer.fileType !== "mp4")
      throw new Error(JSON.stringify(answer));
    expect(answer.screens).toBeUndefined();
    expect(await readFile(answer.file.path)).toEqual(bytes);
  });
});

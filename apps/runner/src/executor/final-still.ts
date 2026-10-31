// apps/runner/src/executor/final-still.ts
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  composeForTarget,
  planScene,
  type RenderTarget,
  wallpaperShape,
} from "@demoman/compositor";
import {
  DEFAULT_EXPORT_QUALITY,
  type FinalStill,
  frameOf,
  messageOf,
  targetFor,
} from "@demoman/run-core";
import type { Page } from "playwright";
import { renderToFiles } from "../render.js";
import type { BrowserSession } from "./browser.js";
import type { Library } from "./library.js";
import { readLogo } from "./logo-ref.js";
import { readWallpaper } from "./wallpaper-read.js";

/**
 * The widest still a run or probe answer carries (ruling F, 2026-10-30): an
 * image costs about width x height / 750 tokens, so 1280 x 800 is ~1,365 on
 * every answer, against ~2,520 for a 1710 x 1107 recording at its own size.
 */
export const STILL_MAX_WIDTH = 1280;

/** `target`, no wider than STILL_MAX_WIDTH, as a PNG: the same frame. */
export function stillTarget(target: RenderTarget): RenderTarget {
  const k = Math.min(1, STILL_MAX_WIDTH / target.width);
  return {
    ...target,
    format: "png",
    width: Math.round(target.width * k),
    height: Math.round(target.height * k),
    cornerRadius: target.cornerRadius * k,
  };
}

/**
 * The take's film at its last instant, as the MP4 export frames it (the
 * default quality's target, logo, wallpaper, camera and cursor), written to
 * `<take>/final-still.png` (spec 2026-10-30 A1). Never throws: a still is a
 * look at the result, and failing to make one never fails the run — it is
 * said instead.
 */
export async function renderFinalStill(args: {
  library: Library;
  takeId: string;
  page: Page;
  home: string;
  wallpapersDir: string;
}): Promise<FinalStill> {
  const { library, takeId, page, home, wallpapersDir } = args;
  try {
    const read = await library.getSceneRead(takeId);
    if (read === null) {
      return { unavailable: `there is no take ${takeId} in the library` };
    }
    const store = library.frameStore(takeId);
    const bundle = await store.getBundle(takeId);
    if (bundle === null) {
      return { unavailable: `take ${takeId} has no frames to show` };
    }
    const { scene } = read;
    const target = stillTarget(
      targetFor("mp4", scene.canvas.aspect, bundle, frameOf(scene), {
        quality: DEFAULT_EXPORT_QUALITY,
      }),
    );
    const { outputDurationMs } = composeForTarget({
      plan: planScene(scene),
      bundle,
      scene,
      target,
    }).resolved.timeline;
    const rendered = await renderToFiles({
      scene,
      bundle,
      store,
      page,
      target,
      fileType: "stills",
      logo:
        scene.branding.logo === null
          ? null
          : await readLogo(home, scene.branding.logo.ref),
      wallpaper: await readWallpaper(
        home,
        wallpapersDir,
        scene.branding.background,
        wallpaperShape(target),
      ),
      // The last instant the film shows: its duration is the end, not in it.
      outputTimesMs: [Math.max(0, outputDurationMs - 1)],
    });
    const [file] = rendered.files;
    if (file === undefined) {
      return { unavailable: "the render produced no still" };
    }
    const path = join(library.takeDir(takeId), "final-still.png");
    await writeFile(path, file.bytes);
    return { path };
  } catch (error) {
    return {
      unavailable: `the film's last frame could not be rendered (${messageOf(error)})`,
    };
  }
}

/** `renderFinalStill` on a work page of its own, closed after. */
export function finalStillFor(deps: {
  session: Pick<BrowserSession, "openWorkPage">;
  library: Library;
  home: string;
  wallpapersDir: string;
  log: (line: string) => void;
}): (takeId: string) => Promise<FinalStill> {
  return async (takeId) => {
    // No relaunch: the run's own browser, as the mux after it.
    const work = await deps.session.openWorkPage({ relaunch: false });
    if (!work.ok) return { unavailable: work.detail };
    try {
      return await renderFinalStill({ ...deps, takeId, page: work.page });
    } finally {
      await work.page.close().catch((error: unknown) => {
        deps.log(
          `the final still's page would not close (${messageOf(error)})`,
        );
      });
    }
  };
}

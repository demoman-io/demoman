/**
 * The size an agent run films at when its script names none.
 *
 * Until 2026-10-11 that was the hidden stage window's own content area —
 * `REPLAY_WINDOW` is 900x640 outer, about 900x519 of page — so every agent
 * video came out small and squat while a manual take, recorded in the
 * author's own window, came out at the screen's shape. The author's setting
 * (`ReplaySettings.runSize`) now picks it, measured off the screen the run
 * page is on: the page lays out as it would full screen, through the same
 * `Emulation.setDeviceMetricsOverride` a script's own `viewport` uses.
 */

export const RUN_SIZES = ["screen", "16:9", "16:10"] as const;
export type RunSizeSetting = (typeof RUN_SIZES)[number];
export const DEFAULT_RUN_SIZE: RunSizeSetting = "screen";

const RATIOS: Record<Exclude<RunSizeSetting, "screen">, [number, number]> = {
  "16:9": [16, 9],
  "16:10": [16, 10],
};

interface Viewport {
  width: number;
  height: number;
}

/**
 * What a run filmed at and why — in the run report and the snapshot answer,
 * so an agent can tell which layout its targets and its video describe.
 * `error` is set for `window`, the fallback when the screen could not be
 * read, which films at a size nobody chose and has to say so; and for a
 * size the script or its device chose when the film's scale was lost (the
 * CLI's headless browser could not read the display, so it filmed at 1x).
 */
export interface RunSize extends Viewport {
  from: RunSizeSetting | "script" | "device" | "window";
  error: string | null;
}

/** A screen the caller knows is not the real one, and why: the CLI's headless
 *  browser when it could not read the display it stands in for. */
export interface ScreenUnknown {
  error: string;
}

export type ScreenSizeAnswer =
  | { ok: true; viewport: Viewport }
  | { ok: false; error: string };

/**
 * The viewport for `setting` on `screen` (CSS px, `window.screen`'s
 * `width`/`height`). A ratio keeps the screen's width and derives the
 * height: the width is what a page's breakpoints read, so shrinking it
 * would hand a desktop app a narrower layout than the author's screen gets.
 */
export function viewportForScreen(
  screen: Viewport | ScreenUnknown | undefined,
  setting: RunSizeSetting,
): ScreenSizeAnswer {
  if (screen === undefined) {
    return { ok: false, error: "the run page could not read its screen" };
  }
  if ("error" in screen) return { ok: false, error: screen.error };
  const { width, height } = screen;
  if (
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width < 1 ||
    height < 1
  ) {
    return {
      ok: false,
      error: `the screen reported ${width}x${height}, which no page can be recorded at`,
    };
  }
  const w = Math.floor(width);
  if (setting === "screen") {
    return { ok: true, viewport: { width: w, height: Math.floor(height) } };
  }
  const [rw, rh] = RATIOS[setting];
  return {
    ok: true,
    viewport: { width: w, height: Math.round((w * rh) / rw) },
  };
}

export type RunSizePlan =
  | { kind: "fixed"; size: RunSize }
  /** Film at the stage window's measured size, and report `error`. */
  | { kind: "measure"; error: string };

/**
 * Which size a run films at: the script's own `viewport`, else its device's,
 * else the author's setting on this screen. Only a screen that cannot be read
 * leaves the window's own size — and then the reason goes with the plan.
 */
export function chooseRunSize(input: {
  scriptViewport: Viewport | undefined;
  device: Viewport | undefined;
  setting: RunSizeSetting;
  screen: Viewport | ScreenUnknown | undefined;
}): RunSizePlan {
  if (input.scriptViewport !== undefined) {
    const { width, height } = input.scriptViewport;
    return {
      kind: "fixed",
      size: { width, height, from: "script", error: null },
    };
  }
  if (input.device !== undefined) {
    const { width, height } = input.device;
    return {
      kind: "fixed",
      size: { width, height, from: "device", error: null },
    };
  }
  const answer = viewportForScreen(input.screen, input.setting);
  if (!answer.ok) return { kind: "measure", error: answer.error };
  return {
    kind: "fixed",
    size: { ...answer.viewport, from: input.setting, error: null },
  };
}

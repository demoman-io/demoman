import { execFile } from "node:child_process";
import type { Display } from "./launch.js";

/** Asks macOS for the menu-bar screen through JXA: `screens[0]` is fixed,
 *  where `mainScreen` follows whichever screen holds the focused window, so a
 *  two-monitor desk would film a different size depending on where the
 *  developer last clicked. NSScreen's frame is in points, which is what a
 *  page's `screen` reports. `ObjC["import"]` is JXA's `ObjC.import`, spelled
 *  so no scan of this file reads it as a module. */
const JXA = `ObjC["import"]("AppKit");
const s = $.NSScreen.screens.objectAtIndex(0);
JSON.stringify({ width: s.frame.size.width, height: s.frame.size.height, scale: s.backingScaleFactor });`;

/** Why headless films at 1x, and how to fix it: said in `status` before
 *  anything is filmed ("films") and on every size filmed without it
 *  ("filmed"), in the same words. */
export function displayUnreadSentence(
  failed: string,
  tense: "records" | "recorded",
): string {
  const names = tense === "records" ? "names" : "named";
  return `Demoman could not read this computer's display (${failed}), so headless ${tense} at 1x, and at its own window size unless the script or its device ${names} one — set DEMOMAN_DISPLAY to <width>x<height>@<scale> (such as 1710x1107@2), or start Demoman with --headed`;
}

/** `DEMOMAN_DISPLAY`, as `<width>x<height>@<scale>` in CSS px, e.g.
 *  `1710x1107@2`. */
const DISPLAY_SETTING = /^(\d+)x(\d+)@(\d+(?:\.\d+)?)$/;

/**
 * The display a visible window would open on, for a headless launch to stand
 * in for (`launch`'s `display`). `DEMOMAN_DISPLAY` names one outright: where
 * it cannot be read (not macOS, no window server) and where a test needs the
 * same display on every machine. Otherwise macOS is asked. Anything else is
 * `{ failed }` with why, never a guess — a guessed screen would film a size
 * nobody has.
 */
export function readDisplay(
  env: NodeJS.ProcessEnv = process.env,
): Promise<Display | { failed: string }> {
  const setting = env.DEMOMAN_DISPLAY;
  if (setting !== undefined && setting !== "") {
    const m = DISPLAY_SETTING.exec(setting.trim());
    const display =
      m === null
        ? null
        : { width: Number(m[1]), height: Number(m[2]), scale: Number(m[3]) };
    if (
      display === null ||
      display.width < 1 ||
      display.height < 1 ||
      display.scale <= 0
    ) {
      return Promise.resolve({
        failed: `DEMOMAN_DISPLAY is "${setting}", not <width>x<height>@<scale> such as 1710x1107@2`,
      });
    }
    return Promise.resolve(display);
  }
  if (process.platform !== "darwin") {
    return Promise.resolve({
      failed: `reading the display is macOS only, and this is ${process.platform}`,
    });
  }
  return new Promise((resolve) => {
    execFile(
      "osascript",
      ["-l", "JavaScript", "-e", JXA],
      { timeout: 10_000 },
      (error, stdout) => {
        if (error !== null) {
          resolve({ failed: `osascript refused: ${error.message}` });
          return;
        }
        try {
          const d = JSON.parse(stdout) as Partial<Display>;
          const ok = (n: unknown): n is number =>
            typeof n === "number" && Number.isFinite(n) && n > 0;
          if (!ok(d.width) || !ok(d.height) || !ok(d.scale)) {
            resolve({ failed: `osascript answered ${stdout.trim()}` });
            return;
          }
          resolve({ width: d.width, height: d.height, scale: d.scale });
        } catch (parseError) {
          resolve({
            failed: `osascript answered something that is not JSON (${String(parseError)}): ${stdout.trim()}`,
          });
        }
      },
    );
  });
}

// apps/runner/src/executor/held.ts

/**
 * Held-clock capture (the held-clock spec, 2026-11-15):
 * the page's own time is held and moved on one video frame at a time.
 * The default since 2026-11-18 (the author); `DEMOMAN_HELD_CLOCK=0` records
 * in real time, as every recording did before.
 */
export const heldClockAsked = (env: NodeJS.ProcessEnv = process.env): boolean =>
  env.DEMOMAN_HELD_CLOCK !== "0";

/** Chromium switches for a held recording: animations and scrolls on the
 *  main thread's clock, every compositor stage run before a frame is drawn,
 *  and no smooth scroll, which Chrome runs on its real clock whatever page
 *  time is (measured 2026-11-15, `compare/held-probe-matrix.mjs`): an app's
 *  own smooth scroll shows as a cut, and the walk plays its own. */
export const HELD_FLAGS = [
  "--disable-threaded-animation",
  "--disable-threaded-scrolling",
  "--run-all-compositor-stages-before-draw",
  "--disable-smooth-scrolling",
];

/** Whether this recording holds the page's clock, and why not when not:
 *  the run report says it. A mode is held once a recording of it has been
 *  shown to hold. */
export function shouldHold(opts: {
  headed: boolean;
  device?: boolean;
}): { hold: true } | { hold: false; why: string } {
  if (opts.headed) {
    return {
      hold: false,
      why: "a visible window records in real time: holding its clock is not yet proven there",
    };
  }
  if (opts.device === true) {
    return {
      hold: false,
      why: "a device's video (touch, a phone's scale) records in real time: holding its clock is not yet proven there",
    };
  }
  return { hold: true };
}

/** Every document of a held recording hides its caret: it blinks on
 *  Chrome's real clock. A constructed sheet, which a page's CSP does not
 *  refuse, adopted as the document is created. */
export const HELD_CARET_SCRIPT = `(() => {
  try {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync("*{caret-color:transparent!important}");
    document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
  } catch (e) {} // said by every page screen, which reads the caret it shows
})()`;

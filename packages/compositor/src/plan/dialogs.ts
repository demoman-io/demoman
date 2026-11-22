/**
 * A JavaScript dialog in the video (DEM-161). The walk answers the dialog at
 * once and records `DIALOG_BEAT_MS` on the action as the card's hold, so the
 * render reads the beat rather than deciding it again.
 */

/** How long the dialog card holds on screen, in output ms. */
export const DIALOG_BEAT_MS = 1500;

/** The last part of the beat, in ms, in which the answer's button is drawn pressed. */
export const DIALOG_PRESS_MS = 300;

import type { FrameBroker } from "../types.js";

/** Default: no cross-origin reach. Same-origin frames need no broker. */
export const NO_FRAMES: FrameBroker = {
  resolveInFrame: () => Promise.reject(new Error("no FrameBroker supplied")),
};

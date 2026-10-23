import type { Surface } from "./types.js";

/** The production surface: a real OffscreenCanvas per render. */
export function createOffscreenSurface(): Surface {
  return {
    create: (width, height) => new OffscreenCanvas(width, height),
  };
}

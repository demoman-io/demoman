import { ACT_CEILING_MS } from "./constants.js";

/**
 * When a step's act was over (spec 2026-10-19, unhurried beats): the verb
 * returned at `verbEndMs`, and the page went on reacting until
 * `lastMotionMs` (the recorder's last frame of real motion), up to
 * `ACT_CEILING_MS` after the verb. Motion from before the verb returned is
 * the verb's own and ends with it.
 */
export function actEndOf(
  verbEndMs: number,
  lastMotionMs: number | null,
): number {
  if (lastMotionMs === null || lastMotionMs <= verbEndMs) return verbEndMs;
  return Math.min(lastMotionMs, verbEndMs + ACT_CEILING_MS);
}

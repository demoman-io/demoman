// The camera a frame is drawn with, and where it puts the app's window:
// apart from compose.ts so a render's screens (`renderScene`) read them
// from the one place `renderFrame` does.
import type { Rect, Vec } from "../geometry.js";
import type { frameCamera } from "../plan/camera.js";
import { frameTrack } from "../plan/camera-follow.js";
import type { ResolvedPlan } from "../plan/resolve.js";
import { contentScale, type Presentation } from "./presentation.js";

/** The camera `renderFrame` draws the frame at `outputTimeMs` with. */
export function sceneCameraAt(
  resolved: ResolvedPlan,
  presentation: Presentation,
  target: { width: number; height: number },
  outputTimeMs: number,
): ReturnType<typeof frameCamera> {
  const viewport = resolved.plan.viewport;
  const { frameRect } = presentation;
  return frameTrack(
    resolved,
    outputTimeMs,
    contentScale(frameRect, viewport),
    frameRect,
    viewport,
    target,
  );
}

/** The app's window in output pixels: `frameRect`, and its rounded corners'
 *  radius, through the scene transform `renderFrame`'s `toScene` applies. */
export function windowOnScreen(
  presentation: Presentation,
  camera: { scale: number; focus: Vec },
): Rect & { radius: number } {
  const { frameRect: r, cornerRadius } = presentation;
  const s = camera.scale;
  return {
    x: r.x + r.width / 2 + (r.x - camera.focus.x) * s,
    y: r.y + r.height / 2 + (r.y - camera.focus.y) * s,
    width: r.width * s,
    height: r.height * s,
    radius: Math.min(cornerRadius, r.width / 2, r.height / 2) * s,
  };
}

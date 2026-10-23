import { CAMERA_DEFAULTS, type CameraKey } from "../../src/plan/camera";

/**
 * A camera key for a test that builds keys by hand. The move fields are the
 * default smoothness's push-in — `transitionMs` and `stiffness` describe the
 * move that ARRIVES at a key — so a test that eases between two of these
 * eases the way a default-smoothness push-in does. A test that cares about
 * the move's length passes its own.
 */
export function cameraKey(
  key: Pick<CameraKey, "outputTimeMs" | "center" | "scale"> &
    Partial<Pick<CameraKey, "transitionMs" | "stiffness">>,
): CameraKey {
  return {
    transitionMs: CAMERA_DEFAULTS.zoomInMs,
    stiffness: CAMERA_DEFAULTS.stiffness,
    ...key,
  };
}

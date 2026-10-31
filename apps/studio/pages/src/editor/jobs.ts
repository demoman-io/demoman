import type { DetailViolation } from "@demoman/compositor";
import type { FileType } from "@demoman/run-core";
import type { SceneAspect } from "@demoman/scene-schema";

// Moved to @demoman/run-core (CLI executor plan 2, Task 1): the CLI's export
// resolves its target and file name through the same functions. Re-exported
// so the editor, the offscreen renderer and their tests import them as before.
export {
  contentTypeFor,
  exportBaseName,
  exportFileName,
  type FileType,
  type FrameFacts,
  frameOf,
  type RenderedFile,
  type RenderProgress,
  recordingOf,
  stillsFolder,
  targetFor,
} from "@demoman/run-core";

// Moved to @demoman/run-core/render (launch D1) with the render it names.
export { RECLAIMED_SPAN_REASON } from "@demoman/run-core/render";

export interface RenderJob {
  jobId: string;
  sceneId: string;
  fileType: FileType;
  /**
   * The aspect the Export button showed when it was pressed. Carried rather
   * than read from the stored scene: the offscreen document fetches the
   * scene after the job is queued, and a toggle in between would export the
   * shape the author did not ask for.
   */
  aspect: SceneAspect;
}

/** A take's closed motion spans, waiting for an encoder. Carries no frames:
 *  the offscreen document reads those from the store itself, because bytes
 *  never cross messaging. */
export interface MuxJob {
  jobId: string;
  sceneId: string;
  /**
   * Each span's claimed parked-frame range, as `[firstFrameIndex,
   * firstFrameIndex + frames)`. Structural rather than a `ClosedCaptureSpan`
   * because this file describes job messages, one layer above capture, and
   * has no reason to import capture's own types to do it — the mux is the
   * only reader that cares which concrete type this satisfies. That
   * structural shape doubles as a compile-time tripwire, though:
   * `entrypoints/offscreen/main.ts` assigns `job.spans` straight into
   * `MuxDeps.spans: ClosedCaptureSpan[]`, so the two shapes drifting apart
   * is a type error at that assignment, not a silent mismatch at the seam.
   *
   * `startMs`/`endMs` are rebased onto the take's start; `firstFrameIndex`
   * is NOT — it is a storage-key index, not a timestamp.
   */
  spans: {
    index: number;
    startMs: number;
    endMs: number;
    frames: number;
    firstFrameIndex: number;
  }[];
}

/**
 * A detail violation, in a sentence the author can act on.
 *
 * SP6 returns these instead of silently upscaling to hit a resolution
 * number, and swallowing them here would undo that decision one layer up.
 *
 * `DetailViolation` carries a time and no action, so the beat is found by
 * time — naming it matters more than naming the millisecond, because the
 * author knows their demo by its steps. `sourceWidth` is included because
 * it is the number the author can actually change: it is what the frames
 * carried at that instant, and a higher-DPR re-record or a
 * higher-resolution replay display is what raises it.
 */
export function violationSentence(
  violation: DetailViolation,
  beatAt: (outputTimeMs: number) => string | null,
): string {
  const label = beatAt(violation.outputTimeMs);
  const where =
    label === null
      ? `at ${(violation.outputTimeMs / 1000).toFixed(1)}s`
      : `on the ${label} beat`;
  const needed = Math.round(violation.neededWidth);
  const short = violation.sourceWidth < violation.neededWidth;
  const upscale = (violation.neededWidth / violation.sourceWidth).toFixed(2);

  // Nothing was cut: the grant is already on its 1.0 floor and the frames
  // still cannot fill the output. The old sentence would have said "reduced
  // from 1x to 1x", which is why this branch exists rather than a tacked-on
  // clause.
  if (violation.grantedScale >= violation.requestedScale) {
    return (
      `The picture ${where} is upscaled ${upscale}x — the source frames were ` +
      `only ${violation.sourceWidth}px wide there against the ${needed}px it ` +
      `is drawn at.`
    );
  }

  const [asked, granted] = distinctScaleTexts(
    violation.requestedScale,
    violation.grantedScale,
  );
  const reduced =
    `The camera zoom ${where} was reduced from ${asked}x ` +
    `to ${granted}x — the source frames were only ` +
    `${violation.sourceWidth}px wide there and could not back it.`;
  // A cut that lands on the 1.0 floor and is STILL short. Saying only that
  // the zoom was reduced would imply what is left is safe, and it is not.
  return short
    ? `${reduced} Even at ${granted}x it is upscaled ` +
        `${upscale}x against the ${needed}px it is drawn at.`
    : reduced;
}

/**
 * Two decimal places, with trailing zeros dropped.
 *
 * The export panel printed `1.4444444444444444x` on a real render: the raw
 * grant is a ratio of two pixel widths and nothing rounded it on the way to
 * the author.
 */
function scaleText(scale: number, places = 2): string {
  return String(Number(scale.toFixed(places)));
}

/**
 * Two scales printed so they read as different numbers when they are.
 *
 * Two places, as `scaleText` prints, until they collide: a source backing
 * 1.797x of a 1.8x zoom is a real cut, and printed alike it read "reduced
 * from 1.8x to 1.8x". Widened a place at a time up to four, which separates
 * any cut worth a clamp; past that they are printed as they fall.
 */
function distinctScaleTexts(a: number, b: number): [string, string] {
  for (let places = 2; places < 4; places++) {
    if (scaleText(a, places) !== scaleText(b, places)) {
      return [scaleText(a, places), scaleText(b, places)];
    }
  }
  return [scaleText(a, 4), scaleText(b, 4)];
}

/**
 * The violations of one output, as a heading and a deduplicated list.
 *
 * Two jobs, both of which the export panel got wrong once `clampToSourceDetail`
 * started reporting under-sampling as well as cut zooms.
 *
 * **The heading has to follow the list.** It was the hardcoded string
 * "Camera zoom was reduced on this export", which is a false claim over a
 * list of beats where no zoom was reduced at all.
 *
 * **The list has to collapse.** A cut zoom lands on the handful of keys that
 * asked for the zoom; under-sampling is true of EVERY key over an affected
 * span, so the panel would grow one line per camera key — dozens of lines
 * saying one thing about one beat. One line per beat per fault, keeping the
 * worst-sampled of the group, which is the one whose numbers the author
 * needs.
 */
export function violationReport(
  violations: DetailViolation[],
  beatAt: (outputTimeMs: number) => string | null,
): { heading: string; lines: string[] } {
  const cut = violations.some((v) => v.grantedScale < v.requestedScale);
  const short = violations.some((v) => v.sourceWidth < v.neededWidth);
  const heading =
    cut && short
      ? "This export asked for more detail than the video holds"
      : cut
        ? "Camera zoom was reduced on this export"
        : "This export is drawn from fewer pixels than it has";

  // Keyed on the beat rather than the instant, because the instant is what
  // makes every key distinct. An unlabelled violation falls back to its
  // second, so a take with no beats still collapses rather than flooding.
  const worst = new Map<string, DetailViolation>();
  for (const violation of violations) {
    const label = beatAt(violation.outputTimeMs);
    const kind =
      violation.grantedScale < violation.requestedScale ? "cut" : "short";
    const key = `${label ?? Math.floor(violation.outputTimeMs / 1000)}|${kind}`;
    const held = worst.get(key);
    const sampling = violation.sourceWidth / violation.neededWidth;
    if (!held || sampling < held.sourceWidth / held.neededWidth) {
      worst.set(key, violation);
    }
  }

  return {
    heading,
    lines: [...worst.values()].map((v) => violationSentence(v, beatAt)),
  };
}

/**
 * The beat a given output instant belongs to: the last one at or before it.
 * A violation lands inside a beat's dwell far more often than exactly on
 * its marker, so "nearest preceding" is the honest mapping.
 */
export function beatLabelAt(
  beats: { outputMs: number | null; label: string }[],
): (outputTimeMs: number) => string | null {
  const placed = beats
    .flatMap((b) =>
      b.outputMs === null ? [] : [{ outputMs: b.outputMs, label: b.label }],
    )
    .sort((a, b) => a.outputMs - b.outputMs);
  return (outputTimeMs: number) => {
    let found: string | null = null;
    for (const beat of placed) {
      if (beat.outputMs <= outputTimeMs) found = beat.label;
      else break;
    }
    return found;
  };
}

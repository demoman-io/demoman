/**
 * Whether a decoder has to seek, or can walk forward to the frame asked for.
 *
 * `CanvasSink.getCanvas` is random access: it locates the packet covering an
 * instant and decodes it, and calling it once per output frame is what held
 * the editor's preview at 47 of the 60 frames a second it asked for.
 * `CanvasSink.canvases()` is the sequential door — its own documentation
 * says it "will intelligently pre-decode a few frames ahead to enable fast
 * iteration" — and it is 3.4x faster. Measured in Chromium on a 2560x1600
 * span: 15.09ms per frame seeking, 4.43ms per frame walking.
 *
 * Playback is the case that matters and it is monotonic, so nearly every
 * request can walk. Scrubbing is not, so this decides.
 */

/**
 * How far ahead is still worth walking to.
 *
 * Walking to an instant decodes every frame between here and there, so a
 * long jump costs more than the seek it saves. Half a second is comfortably
 * more than the largest hop playback makes even when it is dropping frames
 * badly — at 47 of 60 frames that hop is about 21ms — and comfortably less
 * than a scrub, which is what should re-seek.
 */
export const MAX_WALK_SECONDS = 0.5;

export interface DecodePosition {
  /** The timestamp of the frame most recently served from this span. */
  servedSeconds: number;
}

export function shouldReseek(
  position: DecodePosition | null,
  wantedSeconds: number,
): boolean {
  if (position === null) return true;
  // An iterator only goes forwards.
  if (wantedSeconds < position.servedSeconds) return true;
  return wantedSeconds - position.servedSeconds > MAX_WALK_SECONDS;
}

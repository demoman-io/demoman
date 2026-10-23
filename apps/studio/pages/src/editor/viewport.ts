/**
 * The window of time the timeline is currently showing, in output ms.
 *
 * Pixels are deliberately absent: this module is the arithmetic, and the
 * conversion to a percentage of some element's width belongs to the view. A
 * viewport that knew about pixels could not be tested in the node lane, which
 * is where every one of its edge cases lives.
 */
export interface Viewport {
  startMs: number;
  endMs: number;
}

/** Zooming further in than this shows nothing anyone can act on. */
export const MIN_SPAN_MS = 250;

const clamp = (value: number, low: number, high: number): number =>
  Math.min(high, Math.max(low, value));

export const fitAll = (durationMs: number): Viewport => ({
  startMs: 0,
  endMs: Math.max(MIN_SPAN_MS, durationMs),
});

export const toFraction = (viewport: Viewport, ms: number): number =>
  (ms - viewport.startMs) / (viewport.endMs - viewport.startMs);

export const toMs = (viewport: Viewport, fraction: number): number =>
  viewport.startMs + fraction * (viewport.endMs - viewport.startMs);

function windowAt(
  anchorMs: number,
  fraction: number,
  spanMs: number,
  durationMs: number,
): Viewport {
  const limit = Math.max(MIN_SPAN_MS, durationMs);
  const span = clamp(spanMs, MIN_SPAN_MS, limit);
  const startMs = clamp(anchorMs - fraction * span, 0, limit - span);
  return { startMs, endMs: startMs + span };
}

/**
 * Zoom by `factor` about `fraction` of the current window.
 *
 * The instant under the pointer stays under the pointer — except at an end of
 * the take, where the clamp wins. That is the right trade: the alternative is
 * a viewport that scrolls past the end of the video to honour a gesture.
 */
export function zoomAt(
  viewport: Viewport,
  durationMs: number,
  factor: number,
  fraction: number,
): Viewport {
  const anchorMs = toMs(viewport, fraction);
  const span = (viewport.endMs - viewport.startMs) / factor;
  return windowAt(anchorMs, fraction, span, durationMs);
}

export function pan(
  viewport: Viewport,
  durationMs: number,
  deltaMs: number,
): Viewport {
  const span = viewport.endMs - viewport.startMs;
  return windowAt(viewport.startMs + deltaMs, 0, span, durationMs);
}

/**
 * Show exactly `spanMs` of take, about `fraction` of the current window.
 *
 * `zoomAt`'s sibling, and the one a slider needs: a slider knows the span it
 * wants outright, where a wheel only knows "a fifth more than before".
 *
 * `zoomAt(viewport, duration, currentSpan / spanMs, fraction)` computes the
 * same window — measured, not assumed — so this is an interface, not a fix.
 * It is worth its three lines because the slider's whole contract is "the
 * knob's position decides the span", and a call site that has to divide its
 * way there can get the division backwards without anything in the types
 * noticing.
 */
export const zoomTo = (
  viewport: Viewport,
  durationMs: number,
  spanMs: number,
  fraction: number,
): Viewport => windowAt(toMs(viewport, fraction), fraction, spanMs, durationMs);

/**
 * The zoom slider's travel, as a span.
 *
 * Logarithmic, not linear: the interesting half of this control is the zoomed-
 * in half. On a 60s take a linear map spends its first 90% of travel between
 * 60s and 6s — a region where the lanes barely change — and crams everything
 * from 6s down to the 250ms floor into the last sliver. Geometric travel gives
 * every doubling the same distance, which is how every NLE's zoom behaves.
 *
 * `0` is the whole take and `1` is `MIN_SPAN_MS`; `spanToZoom` is its inverse,
 * so a window arrived at by ⌘-wheel puts the knob where the same drag would
 * have put it.
 */
export function zoomToSpan(durationMs: number, value: number): number {
  const limit = Math.max(MIN_SPAN_MS, durationMs);
  return limit * (MIN_SPAN_MS / limit) ** clamp(value, 0, 1);
}

export function spanToZoom(durationMs: number, spanMs: number): number {
  const limit = Math.max(MIN_SPAN_MS, durationMs);
  // A take at the floor has no travel at all — every span it can hold is the
  // same span — and `Math.log(1)` in the denominator would make that a
  // division by zero. The knob belongs at the "whole take" end there, which
  // is also where the take already is.
  if (limit <= MIN_SPAN_MS) return 0;
  const span = clamp(spanMs, MIN_SPAN_MS, limit);
  return Math.log(span / limit) / Math.log(MIN_SPAN_MS / limit);
}

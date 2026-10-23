/**
 * The editor's one element constructor. Was copied verbatim into
 * `view.ts`, `timeline-view.ts` and `inspector.ts`; a change to any copy
 * would have had to be made three times to stay one helper. The branding
 * controls (`src/branding/controls.ts`) use it too, on both pages.
 */
export const el = <K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

/**
 * Paints a range input's filled portion, as a `--fill` percentage the
 * stylesheet turns into a gradient stop.
 *
 * Chrome has no CSS-only way to do this. `accent-color` draws the two-tone
 * track natively, but the moment a thumb needs styling the input needs
 * `appearance: none`, and that takes the native fill with it — so the fill
 * becomes a gradient and its stop has to come from here.
 *
 * Sets a property on the element it is given and touches nothing else. That
 * restraint is the point: this runs from a slider's own `input` event, and
 * `view.ts` records what replacing that element mid-gesture costs — Blink's
 * implicit pointer capture ends with the node, and the drag dies with it.
 */
export const paintSliderFill = (input: HTMLInputElement): void => {
  const min = Number(input.min === "" ? 0 : input.min);
  const max = Number(input.max === "" ? 100 : input.max);
  const span = max - min;
  // A zero or backwards range has no meaningful fill, and dividing by it
  // would write `NaN%` into the gradient — which paints as no fill at all,
  // silently, on a slider that still moves.
  const fraction = span > 0 ? (Number(input.value) - min) / span : 0;
  const clamped = Math.min(1, Math.max(0, fraction));
  input.style.setProperty("--fill", `${(clamped * 100).toFixed(2)}%`);
};

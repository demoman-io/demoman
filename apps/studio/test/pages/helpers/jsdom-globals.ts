// apps/studio/test/pages/helpers/jsdom-globals.ts

/**
 * What jsdom does not implement and the editor's entrypoint needs at import.
 *
 * `main.ts` constructs a `ResizeObserver` at module scope to publish the
 * picture's measured width to the stylesheet (`--bar-w`). jsdom has no
 * ResizeObserver at all, so without this every one of the eighteen
 * `editor-main-*.test.ts` files — each of which boots the real entrypoint —
 * throws `ResizeObserver is not defined` before a single assertion runs.
 *
 * Inert by construction, and that is the honest shape rather than a
 * limitation to apologise for: jsdom performs no layout, so there is no
 * size for a real observer to report and nothing it could truthfully fire
 * with. The stylesheet's `min(var(--bar-w, 100%), 100%)` falls back to the
 * full-width row when the property is never set, which is exactly what this
 * lane should see. The frame-tracking width is a painted-geometry claim and
 * it is asserted in the BROWSER lane, where there is real layout to measure
 * — see `editor-shell-layout.test.ts`'s "sits the control row on the
 * picture's own edges".
 *
 * If a test ever needs to drive a resize, replace this per-test rather than
 * teaching this stub to fire: a shared stub that invents sizes would hand
 * every other file in the lane numbers no layout produced.
 */
class InertResizeObserver implements ResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

globalThis.ResizeObserver ??= InertResizeObserver;

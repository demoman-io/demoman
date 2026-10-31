/**
 * Whether an element can be SEEN: laid out, not transparent, not
 * `visibility: hidden`, and more than a 2 px sliver (Tremor's native
 * `<select>` is 1×1). The one question the snapshot's `shown` and a
 * `waitFor` both ask.
 *
 * Self-contained on purpose — no imports, no closures — because the walk sends
 * `seenNow.toString()` to the page. Do not let a compiler helper creep in.
 */
export function seenNow(el: Element): boolean {
  if (
    !el.checkVisibility({ opacityProperty: true, visibilityProperty: true })
  ) {
    return false;
  }
  const r = el.getBoundingClientRect();
  return r.width > 2 && r.height > 2;
}

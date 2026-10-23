/**
 * "Put this on screen, and let it be watched", asked in the page.
 *
 * The corrective scroll used to be `behavior: "instant"`, taken before the
 * marker keyframe and before the span opened — so nothing recorded it. That
 * was deliberate and it was wrong for the deliverable: measured against real
 * Chromium on a page with targets 1800px apart, a single `scrollTo` beat
 * travelled 843px in an instant nothing photographed and then 389px in the
 * smooth scroll the span did record. The next beat jumped 1452px. Two thirds
 * of the movement in the video was a cut, and the author saw a demo that
 * jumped around the page with occasional smooth stretches in between.
 *
 * It applies to every verb, not only `scrollTo`: a click below the fold is
 * corrected the same way, so every beat off the first screen teleported. A
 * viewer watching a human drive this app would see the page travel to the
 * thing being clicked, so that is what the take records.
 *
 * **Settling is measured on the element, not on the window.** `scrollIntoView`
 * may scroll a nested container rather than the document, so watching
 * `scrollY` would report "finished" the moment a scrollable panel started
 * moving. The element's own viewport rect is what every consumer downstream
 * cares about — the cursor path is dispatched at it and `DOM.getBoxModel`
 * measures it — so its stability is the thing worth waiting for.
 *
 * **Bounded, and it answers with data rather than throwing.** A page that
 * animates forever under the target would otherwise hold the run open; on
 * expiry the reply says so and the engine records a `scrollUnsettled`
 * degradation. That matters more than it looks: the rect is measured after
 * this returns, and a rect measured mid-scroll sends the click somewhere the
 * target no longer is — a run that reports `complete` having clicked whatever
 * had moved into that spot.
 */
export const SCROLL_MARKER = "__demomanScrollIntoView";

export interface ScrollReport {
  /** The element's rect stopped moving before the deadline. */
  settled: boolean;
  /** How far the element travelled, in CSS pixels. Zero means it was already
   *  where it needed to be and no scroll happened at all. */
  movedPx: number;
}

/**
 * Where a scroll puts its target.
 *
 * - `"nearest"`: every verb but `scrollTo`. The scroll is a correction, and
 *   the shortest one that works is the least disruptive to the page's own
 *   composition.
 * - `{ top }`: a recorded `scrollTo`, or an authored one whose step says
 *   where (`landing.top`, which a derived script carries from the take). The
 *   anchor's viewport top when the author's scroll stopped (`action.rect.y`),
 *   so the page lands where they left it. The anchor is whatever sat under
 *   the centre of the screen, and centring it instead is only right for an
 *   element small enough to have been centred: on the author's take of
 *   2026-09-29 it was a 909px block whose top sat at 318, and centring put
 *   that top at -34.5 — 352px short.
 * - `"center"`: a `scrollTo` with no landing — an authored step that names
 *   an element and nothing else, or a document written before `action.rect`
 *   existed.
 */
export type ScrollAim = "center" | "nearest" | { top: number };

/**
 * The function to hand `Runtime.callFunctionOn` with `awaitPromise: true` and
 * `returnByValue: true`, called on the target element. Resolves to a
 * {@link ScrollReport}.
 *
 * A recorded landing moves the element's nearest scrollable ancestor — the
 * document when there is none — by the distance between the element's top
 * and the recorded one. `scrollIntoView` has no alignment for an arbitrary
 * offset. The sensor records a scroll inside a panel too, and moving the
 * panel moves its content by exactly that distance while the panel stays
 * put, so the one container is enough. The browser clamps at the ends of the
 * scroll range, the same way it did for the author.
 */
export function scrollIntoViewFunction(
  aim: ScrollAim,
  timeoutMs: number,
): string {
  return `async function(){
  const ${SCROLL_MARKER} = true;
  const at = () => { const r = this.getBoundingClientRect(); return { x: r.left, y: r.top }; };
  const from = at();
  ${scrollStatement(aim)}
  const deadline = Date.now() + ${timeoutMs};
  let last = from;
  let still = 0;
  for (;;) {
    await new Promise((r) => requestAnimationFrame(() => r()));
    const now = at();
    // Three consecutive frames unmoved. One is not enough: a smooth scroll
    // is sampled per frame and can repeat a position between steps, which
    // would read as arrival while the page is still travelling.
    if (now.x === last.x && now.y === last.y) {
      if (++still >= 3) break;
    } else {
      still = 0;
    }
    last = now;
    if (Date.now() >= deadline) break;
  }
  const movedPx = Math.round(
    Math.hypot(last.x - from.x, last.y - from.y),
  );
  return { settled: still >= 3, movedPx };
}`;
}

/** The one statement that starts the scroll, for {@link scrollIntoViewFunction}. */
function scrollStatement(aim: ScrollAim): string {
  if (typeof aim === "string") {
    return `this.scrollIntoView({ behavior: "smooth", block: "${aim}", inline: "nearest" });`;
  }
  // Interpolated into page source, so it must be a number and nothing else.
  if (!Number.isFinite(aim.top)) {
    throw new Error(
      `a recorded scroll landing must be a finite number, got ${aim.top}`,
    );
  }
  return `const scroller = (() => {
    for (let el = this.parentElement; el !== null; el = el.parentElement) {
      const overflow = getComputedStyle(el).overflowY;
      if ((overflow === "auto" || overflow === "scroll" || overflow === "overlay") && el.scrollHeight > el.clientHeight) return el;
    }
    return document.scrollingElement ?? document.documentElement;
  })();
  scroller.scrollBy({ top: from.y - (${aim.top}), behavior: "smooth" });`;
}

/**
 * Whether the corrective scroll has anything to do.
 *
 * The approach is recorded in a span of its own, and a span costs
 * `SPAN_QUIET_MS` to close whether or not anything painted into it. Paying
 * that on every beat — most of which target something already on screen —
 * would add a quarter of a second per action to every take in exchange for
 * an empty span that `SPAN_MIN_FRAMES` then discards.
 *
 * `nearest` scrolls the shortest distance that puts the element in view, so
 * it moves nothing when the element is already wholly inside the viewport.
 * `center` has work to do wherever the element is not already centred, which
 * is almost always — so the `scrollTo` verb, whose whole point is the
 * travel, always records its approach.
 *
 * The rect is viewport-relative, as `DOM.getBoxModel` reports it: an element
 * above the fold has a negative `y`, one below it a `y` past the viewport
 * height.
 */
export function scrollWillMove(
  rect: { x: number; y: number; width: number; height: number },
  viewport: { width: number; height: number },
  aim: ScrollAim,
): boolean {
  if (aim === "center") return true;
  // Within half a pixel is already there: the rects are fractional, and a
  // sub-pixel scroll paints nothing for the span to keep.
  if (typeof aim !== "string") return Math.abs(rect.y - aim.top) >= 0.5;
  return (
    rect.y < 0 ||
    rect.x < 0 ||
    rect.y + rect.height > viewport.height ||
    rect.x + rect.width > viewport.width
  );
}

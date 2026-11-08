// apps/runner/src/executor/pinned-clock.ts
//
// The page side of a pinned `now` (DEM-79, spec 2026-11-07-pinned-now): the
// page's Date reads the real time shifted by one offset, so it starts at the
// repo's instant and keeps running. Never frozen: a debounce that measures
// with Date.now() (lodash's), and Demoman's own settle and scroll windows,
// need time to pass. Timers, requestAnimationFrame and performance.now() are
// left alone.

/**
 * The script, installed once per flow on the stage's target before its first
 * navigation, that shifts the page's `Date` by `offsetMs`. The offset is
 * fixed when the flow's stage is prepared, so every document of the flow
 * (a navigation runs the script again) continues the same clock.
 */
export function pinnedClockSource(offsetMs: number): string {
  if (!Number.isFinite(offsetMs))
    throw new Error(`pinned clock offset ${offsetMs} is not a number`);
  // A plain constructor sharing Date.prototype, not a subclass: a Date the
  // browser makes itself (an IndexedDB value, a structured clone) is still
  // `instanceof Date`, and `new Date()`'s prototype is still Date.prototype.
  return `(() => {
  const Real = Date;
  if (Real.__demomanPinned) return;
  const offset = ${offsetMs};
  const now = () => Real.now() + offset;
  // Not named Date: a hoisted \`function Date\` would shadow the real one above.
  function PinnedDate(...args) {
    // Date() called without new answers a string of the current time.
    if (!new.target) return new Real(now()).toString();
    // new.target: a subclass of Date (date-fns' TZDate) keeps its prototype.
    return Reflect.construct(Real, args.length === 0 ? [now()] : args, new.target);
  }
  PinnedDate.prototype = Real.prototype;
  PinnedDate.now = now;
  PinnedDate.parse = Real.parse;
  PinnedDate.UTC = Real.UTC;
  Object.defineProperty(PinnedDate, "name", { value: "Date" });
  Object.defineProperty(PinnedDate, "__demomanPinned", { value: true });
  Object.defineProperty(Real.prototype, "constructor", {
    value: PinnedDate, writable: true, configurable: true,
  });
  Object.defineProperty(globalThis, "Date", {
    value: PinnedDate, writable: true, configurable: true,
  });
})();`;
}

/** The offset from this machine's clock to `pinnedNow`. Node and the
 *  browser it drives read the same machine clock. */
export const pinnedOffsetMs = (pinnedNow: string, realNow = Date.now()) =>
  Date.parse(pinnedNow) - realNow;

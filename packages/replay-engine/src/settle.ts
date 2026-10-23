import { SETTLE_QUIET_MS, SETTLE_QUIET_TIMEOUT_MS } from "./constants.js";

/**
 * "Is the page done painting what it already has?", asked in the page.
 *
 * `Page.loadEventFired` does not answer this. `load` waits for the
 * subresources the markup asked for eagerly and says nothing about anything
 * marked `loading="lazy"` — which on a content site is most of the images,
 * the ones on the first screen included. So `load` would fire, the engine
 * would take its opening keyframe, and the lazy images would finish arriving
 * *inside the video*: the take opened on a half-drawn page.
 *
 * **Near the viewport, not the whole document.** Waiting for every image on
 * the page cannot terminate: a `loading="lazy"` image far below the fold is
 * never `complete` until something scrolls to it, so that wait would expire
 * on every long article and report a failure every time. Forcing the page to
 * `loading="eager"` would make it terminate at the cost of fetching hundreds
 * of images to render four seconds of video, and of overriding how the page
 * chose to load itself. One viewport-height of margin is the compromise: it
 * covers what the keyframe can actually show plus the start of the scroll
 * that follows, and it sits inside Chromium's own lazy-loading fetch
 * threshold (~1250px on a fast connection), so the images in the band are
 * ones the browser has already decided to fetch.
 *
 * **Bounded twice.** The image loop has its own deadline so the reply can
 * still carry an accurate count of what was outstanding; an outer race is the
 * backstop for the two waits that can hang indefinitely rather than slowly —
 * `document.fonts.ready`, and a `requestAnimationFrame` that never fires
 * because the window is occluded. Without it the probe would hang the engine
 * on exactly the case the occlusion guard exists to survive.
 *
 * **And still.** `load` says nothing about an app that is still building
 * itself either: a LiveView joining its socket, a SPA rendering its first
 * route. Those draw their own loading state — a bar sweeping across the top,
 * a skeleton — and a frame taken then is a frame of the loading state. On
 * 2026-10-03 an agent take opened on Phoenix's `topbar` three-quarters across
 * and held it for two seconds of video, past a probe that had answered
 * settled. No question about images or fonts can see that, so the probe also
 * waits for the document to stop changing: no DOM mutation for
 * `SETTLE_QUIET_MS`. A page that never stops (a ticking clock, a carousel)
 * costs the wait's own bound and comes back `quiet: false`, said rather than
 * forgiven. A playing `<video>` mutates nothing, so a hero video does not
 * hold it open.
 *
 * The reply is data, never a throw: `{ settled, pending, fonts, ready,
 * quiet }`. A caller that cannot read it must treat that as unsettled — see
 * the engine's `settlePaint`.
 */
export const SETTLE_MARKER = "__demomanSettlePaint";

export interface SettleReport {
  /** Everything in the band finished. False means the deadline won. */
  settled: boolean;
  /** How many images were still loading when the deadline won. */
  pending: number;
  /** `"ok"`, `"unsupported"`, or `"failed: <message>"`. */
  fonts: string;
  /**
   * `document.readyState` when the reply was made. `"loading"` alongside
   * `settled: false` means the parse, not the pictures, is what the deadline
   * caught — a different fault with a different fix, and `pending` alone
   * cannot tell the two apart.
   */
  ready: string;
  /**
   * The document had gone `SETTLE_QUIET_MS` without a DOM mutation when the
   * reply was made. `false` alongside `pending: 0` and `ready: "complete"`
   * is a page still building itself — the third fault, and the one the
   * other two fields read as no fault at all.
   */
  quiet: boolean;
}

/**
 * The expression to hand `Runtime.evaluate` with `awaitPromise: true` and
 * `returnByValue: true`. Resolves to a {@link SettleReport}.
 *
 * `timeoutMs` bounds the parse-and-images wait; `quietTimeoutMs` bounds the
 * wait for the document to stop changing that follows it. Separate budgets,
 * because they are separate faults: the take that motivated the second one
 * needed about three seconds of it after a page whose images had all
 * arrived.
 */
export function settlePaintExpression(
  timeoutMs: number,
  quietTimeoutMs: number = SETTLE_QUIET_TIMEOUT_MS,
): string {
  return `(() => {
  const ${SETTLE_MARKER} = true;
  const t0 = Date.now();
  const TIMEOUT = ${timeoutMs};
  const QUIET_TIMEOUT = ${quietTimeoutMs};
  const QUIET = ${SETTLE_QUIET_MS};
  let pending = -1;
  let parsing = true;
  let fonts = "pending";
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  // From the moment the probe is asked, so mutations during the image wait
  // count: a page that was busy then and is still busy is not quiet.
  let lastChange = Date.now();
  const watcher = new MutationObserver(() => { lastChange = Date.now(); });
  watcher.observe(document, {
    subtree: true, childList: true, attributes: true, characterData: true,
  });
  const quietNow = () => Date.now() - lastChange >= QUIET;
  let deadline = t0 + TIMEOUT + 250;
  // Within one viewport-height above or below what is on screen.
  const outstanding = () =>
    [...document.images].filter((img) => {
      if (img.complete) return false;
      const r = img.getBoundingClientRect();
      return r.bottom > -innerHeight && r.top < innerHeight * 2;
    }).length;
  const work = (async () => {
    for (;;) {
      // The parse state is read with the count, and for the same reason.
      // \`document.images\` is only as long as the markup that has arrived, so
      // a document still being parsed answers "none outstanding" whatever it
      // is about to load — and breaking on that reports a page that has
      // loaded nothing as a settled one. The engine asks on exactly such a
      // page: the navigating guard gives up waiting for \`load\` after
      // NAVIGATE_TIMEOUT_MS and settles against whatever document is there.
      parsing = document.readyState === "loading";
      pending = outstanding();
      if (!parsing && pending === 0) break;
      if (Date.now() - t0 >= TIMEOUT) break;
      await sleep(50);
    }
    // Only once the images are in: a page still missing its pictures has
    // already lost, and the reply says so by its count.
    if (!parsing && pending === 0) {
      const tq = Date.now();
      deadline = Math.max(deadline, tq + QUIET_TIMEOUT + 250);
      while (!quietNow() && Date.now() - tq < QUIET_TIMEOUT) await sleep(50);
      // Back to what the fonts and the frame had before: whatever is left
      // of TIMEOUT, or the 250 ms grace. The quiet budget is not theirs.
      deadline = Math.max(t0 + TIMEOUT, Date.now()) + 250;
    }
    if (document.fonts) {
      await document.fonts.ready.then(
        () => { fonts = "ok"; },
        (e) => { fonts = "failed: " + ((e && e.message) || e); },
      );
    } else {
      fonts = "unsupported";
    }
    // One painted frame, so "settled" means drawn and not merely loaded.
    await new Promise((r) => requestAnimationFrame(() => r()));
  })();
  const ready = () => document.readyState;
  // Read at the reply, not when the wait ended: the rAF and the fonts wait
  // sit between the two, and a page that started changing again in that gap
  // is not quiet in the frame the caller is about to take.
  const reply = (settled) => {
    watcher.disconnect();
    const quiet = quietNow();
    return {
      settled: settled && !parsing && pending === 0 && quiet,
      pending,
      fonts,
      ready: ready(),
      quiet,
    };
  };
  // The backstop, polled rather than one timer, because its deadline moves:
  // the quiet wait extends it only while that wait is actually running, so
  // a probe that never reaches it — still parsing, an image never came —
  // hangs on fonts or the frame for no longer than it did before it existed.
  const backstop = (async () => {
    while (Date.now() < deadline) await sleep(50);
  })();
  return Promise.race([
    work.then(() => reply(true)),
    backstop.then(() => reply(false)),
  ]);
})()`;
}

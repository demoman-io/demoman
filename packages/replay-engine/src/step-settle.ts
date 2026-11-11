/**
 * "Has this step's result finished arriving?", asked in the page after each
 * step of a continuous walk, and the capture hold that follows it.
 *
 * Settled here means: the input is painted (one rAF round trip), no finite
 * animation or transition is running, and no DOM mutation for `quietMs`.
 * Endless animations (a spinner) are ignored: they never finish, and waiting
 * on them would cost the cap on every step of a page that has one. In-flight
 * requests are a separate question, asked from outside the page.
 *
 * The pattern is `settle.ts`'s (MutationObserver plus a `setTimeout` backstop,
 * because rAF stops in an occluded window) but the opening's probe keeps its
 * own meaning, so this is its own expression. It never rejects: a page-side
 * error resolves `quiet: false`, said rather than forgiven.
 */
export const STEP_SETTLE_MARKER = "__demomanStepSettle";

export interface StepSettleReport {
  /** The rAF round trip completed, so the input is on screen. */
  painted: boolean;
  /** Finite animations still running when the reply was made. */
  animations: number;
  /** No finite animation running and no mutation for `quietMs`. */
  quiet: boolean;
  /** Milliseconds from asking to answering. */
  waitedMs: number;
}

export function stepSettleExpression(quietMs: number, capMs: number): string {
  return `(() => {
  const ${STEP_SETTLE_MARKER} = true;
  const t0 = Date.now();
  let lastChange = t0;
  let painted = false;
  let animations = 0;
  let watcher = null;
  const countAnimations = () => {
    try {
      if (!document.getAnimations) return 0;
      return document.getAnimations().filter((a) => {
        if (a.playState !== "running") return false;
        const t = a.effect && a.effect.getComputedTiming();
        return !t || t.iterations !== Infinity;
      }).length;
    } catch (e) { return 0; }
  };
  const quietNow = () => Date.now() - lastChange >= ${quietMs};
  const reply = () => {
    if (watcher) watcher.disconnect();
    animations = countAnimations();
    return {
      painted,
      animations,
      quiet: painted && animations === 0 && quietNow(),
      waitedMs: Date.now() - t0,
    };
  };
  try {
    watcher = new MutationObserver(() => { lastChange = Date.now(); });
    watcher.observe(document, {
      subtree: true, childList: true, attributes: true, characterData: true,
    });
  } catch (e) { return Promise.resolve(reply()); }
  const frame = () => new Promise((r) => requestAnimationFrame(() => r()));
  const work = (async () => {
    await frame();
    painted = true;
    for (;;) {
      if (countAnimations() === 0 && quietNow()) return;
      await frame();
    }
  })();
  const backstop = new Promise((r) => setTimeout(r, ${capMs}));
  return Promise.race([work, backstop]).then(reply, reply);
})()`;
}

/** The style that hides every caret for the capture. */
const CARET_STYLE_ID = "__demomanCaretHold";

/**
 * Before a page capture: hide the caret and freeze endless animations at
 * time 0, so two captures of the same page agree. Only animations whose
 * iterations are `Infinity` are held; a finished `fill: forwards` one stays
 * as it is. Replies with the capture geometry.
 */
export const PAGE_CAPTURE_HOLD = `(() => {
  if (!document.getElementById("${CARET_STYLE_ID}")) {
    const s = document.createElement("style");
    s.id = "${CARET_STYLE_ID}";
    s.textContent = "*{caret-color:transparent!important}";
    document.head.append(s);
  }
  const held = window.__demomanHeld || (window.__demomanHeld = []);
  for (const a of document.getAnimations ? document.getAnimations() : []) {
    const t = a.effect && a.effect.getComputedTiming();
    if (a.playState !== "running" || !t || t.iterations !== Infinity) continue;
    held.push({ a, t: a.currentTime });
    a.pause();
    a.currentTime = 0;
  }
  return {
    held: held.length, x: scrollX, y: scrollY,
    width: innerWidth, height: innerHeight, dpr: devicePixelRatio,
  };
})()`;

/** After the capture: put the caret and the held animations back. */
export const PAGE_CAPTURE_RELEASE = `(() => {
  const s = document.getElementById("${CARET_STYLE_ID}");
  if (s) s.remove();
  const held = window.__demomanHeld || [];
  for (const { a, t } of held) { a.currentTime = t; a.play(); }
  window.__demomanHeld = [];
  return held.length;
})()`;

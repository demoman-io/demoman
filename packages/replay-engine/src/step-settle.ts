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
  /**
   * Why it answered, from what the loop itself saw: `quiet` when it saw the
   * page settled, `cap` at the backstop, `animationReadFailed` when reading
   * the animations threw (or the page has none to read), `unwatched` when
   * the page's changes could not be observed. Never recomputed after the
   * fact: a change in the moment between seeing quiet and answering must
   * not read as a failed animation read.
   */
  stopped: "quiet" | "cap" | "animationReadFailed" | "unwatched";
}

export function stepSettleExpression(quietMs: number, capMs: number): string {
  return `(() => {
  const ${STEP_SETTLE_MARKER} = true;
  const t0 = Date.now();
  let lastChange = t0;
  let painted = false;
  let animations = 0;
  let watcher = null;
  // An animation read that failed is unknown, not zero: never quiet.
  let failed = false;
  // Set once answered: a loop the backstop beat must not read the page's
  // animations every frame for the rest of the take.
  let done = false;
  const countAnimations = () => {
    try {
      if (!document.getAnimations) { failed = true; return 0; }
      return document.getAnimations().filter((a) => {
        if (a.playState !== "running") return false;
        const t = a.effect && a.effect.getComputedTiming();
        return !t || t.iterations !== Infinity;
      }).length;
    } catch (e) { failed = true; return 0; }
  };
  const quietNow = () => Date.now() - lastChange >= ${quietMs};
  const reply = (stopped) => {
    done = true;
    if (watcher) watcher.disconnect();
    // Settled as the loop saw it; at the cap, the page as it is then.
    if (stopped === "cap") {
      animations = countAnimations();
      if (painted && !failed && animations === 0 && quietNow()) stopped = "quiet";
    }
    if (failed) stopped = "animationReadFailed";
    return {
      painted,
      animations,
      quiet: stopped === "quiet",
      waitedMs: Date.now() - t0,
      stopped,
    };
  };
  try {
    watcher = new MutationObserver(() => { lastChange = Date.now(); });
    watcher.observe(document, {
      subtree: true, childList: true, attributes: true, characterData: true,
    });
  } catch (e) { return Promise.resolve(reply("unwatched")); }
  const frame = () => new Promise((r) => requestAnimationFrame(() => r()));
  const work = (async () => {
    await frame();
    painted = true;
    for (;;) {
      if (done) return "done";
      const n = countAnimations();
      if (failed) return "animationReadFailed";
      if (n === 0 && quietNow()) return "quiet";
      await frame();
    }
  })();
  const backstop = new Promise((r) => setTimeout(() => r("cap"), ${capMs}));
  return Promise.race([work, backstop]).then(reply);
})()`;
}

/** The style that hides every caret for the capture. */
const CARET_STYLE_ID = "__demomanCaretHold";
const CARET_RULE = "*{caret-color:transparent!important}";

/**
 * Before a page capture: hide the caret and freeze endless animations at
 * time 0, so two captures of the same page agree. Only animations whose
 * iterations are `Infinity` are held; a finished `fill: forwards` one stays
 * as it is. Replies with the capture geometry, and `caretShown`: a focused
 * field whose caret is still drawn (its own `!important` inline colour, say),
 * which the screen must then say.
 *
 * The focused field is looked for through open shadow roots: a component
 * that sets its own caret-color is not reached by a rule in the document,
 * so its field's caret has to be read where it is. A focused frame counts
 * as a caret shown: the rule is not in its document, and a cross-origin one
 * cannot be read.
 *
 * A page whose CSP refuses inline styles gives the `<style>` no sheet; a
 * constructed sheet is not subject to that policy, so it stands in. The
 * refusal is remembered for the document, so later captures go straight to
 * the stand-in rather than setting off the page's CSP report each time.
 */
export const PAGE_CAPTURE_HOLD = `(() => {
  if (!document.getElementById("${CARET_STYLE_ID}") && !window.__demomanCaretSheet) {
    if (!window.__demomanCaretRefused) {
      const s = document.createElement("style");
      s.id = "${CARET_STYLE_ID}";
      s.textContent = "${CARET_RULE}";
      (document.head || document.documentElement).append(s);
      if (!s.sheet) {
        s.remove();
        window.__demomanCaretRefused = true;
      }
    }
    if (window.__demomanCaretRefused) {
      try {
        const c = new CSSStyleSheet();
        c.replaceSync("${CARET_RULE}");
        document.adoptedStyleSheets = [...document.adoptedStyleSheets, c];
        window.__demomanCaretSheet = c;
      } catch (e) {} // said below: the caret is still shown
    }
  }
  let f = document.activeElement;
  while (f && f.shadowRoot && f.shadowRoot.activeElement) f = f.shadowRoot.activeElement;
  const caretShown = !!f && (f.tagName === "IFRAME" || f.tagName === "FRAME" ||
    ((f.isContentEditable || f.tagName === "INPUT" || f.tagName === "TEXTAREA") &&
      getComputedStyle(f).caretColor !== "rgba(0, 0, 0, 0)"));
  const held = window.__demomanHeld || (window.__demomanHeld = []);
  for (const a of document.getAnimations ? document.getAnimations() : []) {
    const t = a.effect && a.effect.getComputedTiming();
    if (a.playState !== "running" || !t || t.iterations !== Infinity) continue;
    held.push({ a, t: a.currentTime });
    a.pause();
    a.currentTime = 0;
  }
  return {
    held: held.length, caretShown, x: scrollX, y: scrollY,
    width: innerWidth, height: innerHeight, dpr: devicePixelRatio,
  };
})()`;

/** After the capture: put the caret and the held animations back. */
export const PAGE_CAPTURE_RELEASE = `(() => {
  const s = document.getElementById("${CARET_STYLE_ID}");
  if (s) s.remove();
  const c = window.__demomanCaretSheet;
  if (c) {
    document.adoptedStyleSheets = document.adoptedStyleSheets.filter((x) => x !== c);
    delete window.__demomanCaretSheet;
  }
  const held = window.__demomanHeld || [];
  for (const { a, t } of held) { a.currentTime = t; a.play(); }
  window.__demomanHeld = [];
  return held.length;
})()`;

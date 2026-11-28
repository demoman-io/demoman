/**
 * "Has this step's result finished arriving?", asked in the page after each
 * step of a continuous walk, and the capture hold that follows it.
 *
 * Settled here means: the input is painted (one rAF round trip), no finite
 * animation or transition is running (or held mid-way by a held clock's
 * pin), and no DOM mutation for `quietMs`.
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

/**
 * `quietFrames`, on a held clock: the quiet window is counted in the page's
 * frames, one per frame of held time, not read off its clock. The page reads
 * whole milliseconds, so a window in milliseconds that ends near a frame was
 * met a frame apart by where on the grid it began, which follows how long
 * the server took before it: 400 ms was 12 frames or 13, and 383 ms tipped
 * the same way from a half-frame start (traced 2026-11-16, twice).
 */
/**
 * `capFrames`, with `quietFrames`: the cap too is counted in frames, and a
 * frame shot while following the server (`window.__demomanServerFrame`)
 * counts toward neither. Both then end at the same page frame on any
 * machine however long the server took: inside a server stretch frames come
 * as fast as the machine captures them and the page's clock follows real
 * time, so a settle over a streamed answer ended at its cap on one run and
 * quiet on another, 7 frames apart (Chatbot, 2026-11-16). `capMs`
 * is then only the bound with the server's time in it.
 */
export function stepSettleExpression(
  quietMs: number,
  capMs: number,
  quietFrames?: number,
  capFrames?: number,
): string {
  return `(() => {
  const ${STEP_SETTLE_MARKER} = true;
  const t0 = Date.now();
  let lastChange = t0;
  // Frames drawn since the last change. Every one counts, also one a
  // fraction of a millisecond after the question: told apart by the page's
  // clock, it counted or not by which whole millisecond it fell in.
  let still = 0;
  // Frames counted toward a cap in frames.
  let counted = 0;
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
        // Running, or held mid-way by the held clock's pin (PIN_ANIMATIONS),
        // which leaves every animation paused: unseen, a toast was pictured
        // half slid in (measured 2026-11-16).
        const pinned = a.playState === "paused" && a.__v0 !== undefined && !a.__done && !a.__pagePaused;
        if (a.playState !== "running" && !pinned) return false;
        const t = a.effect && a.effect.getComputedTiming();
        return !t || t.iterations !== Infinity;
      }).length;
    } catch (e) { failed = true; return 0; }
  };
  const quietNow = () => ${quietFrames === undefined ? `Date.now() - lastChange >= ${quietMs}` : `still >= ${quietFrames}`};
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
    watcher = new MutationObserver(() => { lastChange = Date.now(); still = 0; });
    watcher.observe(document, {
      subtree: true, childList: true, attributes: true, characterData: true,
    });
  } catch (e) { return Promise.resolve(reply("unwatched")); }
  const frame = () => new Promise((r) => requestAnimationFrame(() => {
    ${capFrames === undefined ? "still++;" : "if (!window.__demomanServerFrame) { still++; counted++; }"}
    r();
  }));
  const work = (async () => {
    await frame();
    painted = true;
    for (;;) {
      if (done) return "done";
      const n = countAnimations();
      if (failed) return "animationReadFailed";
      if (n === 0 && quietNow()) return "quiet";
      ${capFrames === undefined ? "" : `if (counted >= ${capFrames}) return "cap";`}
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
 * as it is. One the held clock's pin paused (`__v0`, `PIN_ANIMATIONS`) is
 * held too, and left paused after: its pose follows how many frames the
 * server took before it, so two held recordings of one page showed it a
 * frame apart (traced 2026-11-16: one more frame of server wait, one more
 * frame of spin on every screen after). One the page itself paused is its
 * picture, and stays. Replies with the capture geometry, and `caretShown`: a focused
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
    const run = a.playState === "running";
    if ((!run && (a.__v0 === undefined || a.__pagePaused)) || !t || t.iterations !== Infinity) continue;
    held.push({ a, t: a.currentTime, run });
    // Not the page's pause, which the held clock's pin would say.
    if (window.__demomanPause) window.__demomanPause.call(a);
    else a.pause();
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
  for (const { a, t, run } of held) { a.currentTime = t; if (run) a.play(); }
  window.__demomanHeld = [];
  return held.length;
})()`;

/**
 * How long after a page capture a frame of another size than the page had
 * before it is still the capture's stray. Measured 2026-11-10 at display
 * scale 2: Chrome's one 1x frame arrived within two frames (about 33 ms) of
 * the capture returning; the rest is room for a loaded machine.
 */
export const STRAY_WINDOW_MS = 250;

/**
 * How long after a page capture's release a frame of any size is still the
 * capture's echo: the page repainting what the screen just took, not the
 * page moving. Measured on CI (ubuntu, PR #67, 2026-11-12): two frames
 * painted 4 ms before to 52 ms after every release. Kept, they joined a
 * full still's own two echo frames in one span of 3 or more
 * (`SPAN_MIN_FRAMES`), which owed a settled still; the next step's still,
 * decided within `MOVING_RECENT_MS` of it, stood in at the screencast's
 * size, and the zoom on the click after it was granted 1x. The rest is room
 * for a loaded machine. The echo ends early at the walk's next input, so a
 * hover the next step's pointer paints is the page's, filmed and seen; an
 * endless animation loses at most this long after each step's capture,
 * beside the hold it already loses.
 */
export const ECHO_WINDOW_MS = 100;

/**
 * How long after a full still, a page capture or a metrics re-send a frame
 * is judged for the window's unscaled surface (`surfaceCrop`).
 * Sized from CI's film (PR #143's ubuntu, run 45454571676): its stray came
 * about 423 ms after its still ended; see the walk's `cropWatch`. Judging
 * costs one luma decode a frame, and only inside it.
 */
// shortcut: a stray Chrome sends more than this after its capture ended is
// filmed as a flash and nothing says so; widen it, or judge every frame,
// if a film shows one later.
export const SURFACE_CROP_WINDOW_MS = 1000;

/**
 * How long after a full still answers a frame at the still's size is still
 * its echo (`stillEcho`). Measured under CI-like load on the Mac
 * (2026-11-28): the latest was painted 120 ms after the still answered,
 * unloaded 35 to 40 ms; this is about 8 times the latest.
 */
export const STILL_ECHO_WINDOW_MS = 1000;

/**
 * The latest full still (`Page.captureScreenshot` at the still's scale):
 * whether it is being taken, when the latest to answer did, on the walk's
 * clock (null before one has), the screencast's own frame size before it,
 * and the size a full still comes back at (null until one has). No start
 * time: reading the clock for one moves a walk's timings on a test's clock.
 */
export interface StillWindow {
  taking: boolean;
  toMs: number | null;
  own: string | null;
  still: string | null;
}

/**
 * Whether a screencast frame is a full still's echo: a frame at the still's
 * size, which is not the screencast's own. The screencast draws the window's surface, at the display's scale;
 * only a still draws the page at its own, and Chrome sends a frame or two
 * of that drawing after it. Under CI-like load on the Mac (2026-11-28,
 * motion-budget's takes beside six background burners) every such frame
 * was painted during a still or 35 to 120 ms after it answered, arriving
 * out of paint order beside the screencast's own; two of them and one
 * frame of the page made a span of `SPAN_MIN_FRAMES`, kept as motion at
 * the still's scale while the page stood still.
 *
 * "echo" while a still is taken and within `STILL_ECHO_WINDOW_MS` of the
 * latest answer, "late" after it: still not the screencast's scale, so
 * still refused, but past where an echo was seen, so the walk says it. null
 * for any other frame. `size` is read only once a still has come back at
 * another size than the screencast's: it decodes.
 */
export function stillEcho(
  paintedMs: number,
  size: () => string | null,
  still: StillWindow | null,
): "echo" | "late" | null {
  if (
    still === null ||
    still.still === null ||
    still.own === null ||
    still.own === still.still ||
    size() !== still.still
  )
    return null;
  return still.taking ||
    still.toMs === null ||
    paintedMs <= still.toMs + STILL_ECHO_WINDOW_MS
    ? "echo"
    : "late";
}

/** A page capture, on the walk's clock: when the hold began and ended (null
 *  while it holds), when the walk's next input began after it (null until
 *  then), and the frame size seen before it (null when none was). */
export interface CaptureWindow {
  fromMs: number;
  toMs: number | null;
  inputMs: number | null;
  size: string | null;
}

/**
 * Whether a screencast frame stamped at `paintedMs` stays out of the film
 * because of a page capture: stamped while the capture held the page (caret
 * hidden, spinners held), whenever it arrives; stamped within
 * `ECHO_WINDOW_MS` after the release and before the walk's next input, at
 * any size (the capture's echo); or
 * stamped within `STRAY_WINDOW_MS` after it at another size than the page
 * had before it, whatever came between. `size` is read only past the echo
 * and inside the stray window: it decodes.
 */
export function capturedAway(
  paintedMs: number,
  size: () => string | null,
  capture: CaptureWindow | null,
): boolean {
  if (capture === null || paintedMs < capture.fromMs) return false;
  if (capture.toMs === null || paintedMs <= capture.toMs) return true;
  const echoEnds = Math.min(
    capture.toMs + ECHO_WINDOW_MS,
    capture.inputMs ?? Number.POSITIVE_INFINITY,
  );
  if (paintedMs <= echoEnds) return true;
  if (capture.size === null || paintedMs > capture.toMs + STRAY_WINDOW_MS)
    return false;
  return size() !== capture.size;
}

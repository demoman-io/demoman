import type { NetworkWatch } from "./network-watch.js";
import type { CdpSession, Clock } from "./types.js";

/** One video frame of page time. */
export const HELD_FRAME_MS = 1000 / 30;

/** A grant expires once the page has run what falls due in it (milliseconds in
 *  the spike); Chrome that never says so, a crashed or detached renderer, would
 *  hold the recording for good. 15 s is the spike's watchdog: room for a page's
 *  own long task, short enough to say what happened. */
export const GRANT_EXPIRY_TIMEOUT_MS = 15_000;

/** Real time the walk itself spends between two frames of a stretch that
 *  counts as the server's: its own work there (a condition read, a few page
 *  calls) is milliseconds; past this it is a call of the walk's that stuck,
 *  which the server did not take (a 30 s stretch on CI ubuntu, 2026-11-15).
 *  shortcut: a fixed bound, not the walk telling the clock; upgrade if a
 *  walk's honest work between frames comes near it. */
export const WALK_GAP_CREDIT_MS = 2000;

/** 30 · (1000/30) is 1000.0000000000001: held times are compared this
 *  loosely, so a sleep of no more than this moves no page time, and a caller
 *  looping until a held time is reached must stop within it. */
export const HELD_EPS_MS = 1e-6;
const EPS = HELD_EPS_MS;

/** Captured frames a playing video's `currentTime` may stand still across
 *  before it is said to have stopped (half a second of frames): a video
 *  frozen on one picture reads as a still in the recording (DEM-207). */
const VIDEO_STALL_PINS = 15;

/** Page script: pins every animation in the document to the held time (ms),
 *  and answers the ones it could not pin, each named once.
 *  An animation's own currentTime runs on Chrome's real clock, so it starts at
 *  the held time it is first seen at; it is finished at its end, so a library
 *  waiting for `animationend` still hears it, and pinned again from the frame
 *  the page is seen playing it again. A scroll-driven animation follows the
 *  scroll, which the walk moves, so it is left alone.
 *  An animation the page itself holds paused is the page's picture, and is
 *  left where it is: one first seen paused, until the page plays it, and a
 *  CSS animation whose element says `animation-play-state: paused`, for as
 *  long as it does (a progress ring scrubbed by a negative delay swept from
 *  0 to full under the pin; review of 2026-11-16). It goes on from where it
 *  stood.
 *  shortcut: a script's `pause()` of an animation the pin already holds is
 *  not seen, so it plays on; upgrade if an app shows it.
 *  An animation at a playbackRate other than 1 is not pinned (played at
 *  rate 1, a reversed one ran forward and snapped back): it is answered by
 *  name and runs on Chrome's clock.
 *  A playing <video> runs on Chrome's real clock too, and is not held: it is
 *  answered once, so the report says it (measured 2026-11-15: every frame of
 *  one apart between two held recordings).
 *  shortcut: said, not held, and only a video of this document (none in a
 *  shadow root or a frame); holding one means seeking it every frame.
 *  One whose `currentTime` stands still while playing (its data stalled)
 *  is said too, once per video (`VIDEO_STALL_PINS`).
 *  shortcut: a picture that stands still while `currentTime` moves (what
 *  DEM-207 saw on a held recording) is not seen; upgrade by counting the
 *  frames it presents (`requestVideoFrameCallback`) once that is measured.
 *  Upgrade if recordings of pages with video matter. */
export const PIN_ANIMATIONS = `(v, server) => {
  const unpinned =
    typeof window.__demomanFlushFrames === "function" ? window.__demomanFlushFrames(v, server) : [];
  const cssPaused = (a) => {
    const el = a.animationName && a.effect && a.effect.target;
    if (!el) return false;
    const cs = getComputedStyle(el, a.effect.pseudoElement || null);
    const states = cs.animationPlayState.split(", ");
    const i = cs.animationName.split(", ").indexOf(a.animationName);
    return i !== -1 && states[i % states.length] === "paused";
  };
  const nameOf = (a) =>
    (a.animationName || a.transitionProperty || a.id || "an animation") + " on " +
    (a.effect?.target?.tagName?.toLowerCase() ?? "no element");
  for (const a of document.getAnimations()) {
    if (a.__unpinned) continue;
    if (a.timeline && !(a.timeline instanceof DocumentTimeline)) continue;
    if ((a.playbackRate ?? 1) !== 1) {
      a.__unpinned = true;
      if (a.__v0 !== undefined) a.play();
      unpinned.push(nameOf(a) + ": plays at rate " + a.playbackRate + ", which the held clock does not play");
      continue;
    }
    // The page's own pause: left where it is, and it goes on from there.
    a.__pagePaused = a.__v0 === undefined ? a.playState === "paused" || cssPaused(a) : cssPaused(a);
    if (a.__pagePaused) {
      if (a.__v0 === undefined) a.__waited = true;
      else a.__v0 = v - (a.currentTime ?? 0);
      continue;
    }
    if (a.__waited) {
      a.__waited = false;
      a.__v0 = v - (a.currentTime ?? 0);
    }
    if (a.__done) {
      if (a.playState !== "running") continue;
      a.__done = false;
      a.__v0 = v;
    }
    try {
      a.__v0 ??= v;
      const t = v - a.__v0;
      const end = a.effect?.getComputedTiming().endTime ?? Number.POSITIVE_INFINITY;
      if (Number.isFinite(end) && t >= end) {
        a.finish();
        a.__done = true;
      } else {
        a.pause();
        a.currentTime = t;
      }
    } catch (e) {
      a.__unpinned = true;
      unpinned.push(nameOf(a) + ": " + (e && e.message ? e.message : String(e)));
    }
  }
  const stalls = (window.__demomanVideoStalls ??= new WeakMap());
  const query = window.__demomanQuery ?? ((s) => document.querySelectorAll(s));
  for (const m of query("video")) {
    if (m.paused || m.ended) continue;
    if (!window.__demomanVideoSaid) {
      window.__demomanVideoSaid = true;
      unpinned.push("a playing video runs on its own clock: it was not held");
    }
    const s = stalls.get(m) ?? { t: m.currentTime, n: 0, said: false };
    stalls.set(m, s);
    if (s.t !== m.currentTime) {
      s.t = m.currentTime;
      s.n = 0;
    } else if (++s.n === ${VIDEO_STALL_PINS} && !s.said) {
      s.said = true;
      unpinned.push("a video stopped on one frame while playing");
    }
  }
  return unpinned;
}`;

/** Page script for every document of a held recording: Chrome runs
 *  animation frames on its real clock even while page time is held
 *  (measured 2026-11-15, apps/runner/compare/held-probe-matrix.mjs), so the
 *  page's `requestAnimationFrame` queues instead, and `PIN_ANIMATIONS` runs
 *  the queue once per captured frame (`__demomanFlushFrames(heldMs, server)`),
 *  as a browser runs one frame's callbacks. A callback asked for inside a
 *  frame runs on the next. `server`: the frame was shot following the
 *  server, which a callback reads as `window.__demomanServerFrame` (a held
 *  settle counts no such frame, DEM-204).
 *
 *  The callbacks' timestamp is the held time on this document's clock, not a
 *  read of `performance.now()`, which Chrome clamps to 100 µs with a jitter
 *  of its own each run (measured 2026-11-15, compare/held-probe-timestamps.mjs):
 *  the document's start is read once against the held time and put on the
 *  frame grid, which the jitter cannot move it off. A document started on a
 *  frame (any the walk starts) reads its own clock to within that jitter.
 *
 *  A frame this document cannot reach (another origin kept in this renderer,
 *  a sandboxed one) is never run by it: such a frame, and every frame in it,
 *  keeps Chrome's own animation frames, and is answered once by name, with
 *  what the pin could not hold. Chrome's own stays at `__demomanRaf` for Demoman's probes that
 *  must not wait on a captured frame.
 *
 *  A held recording's browser plays no smooth scroll (Chrome runs one on its
 *  real clock), so a scroll the page asks to be smooth is a jump: the first
 *  one that moved anything is answered, once, with what the pin could not
 *  hold (the author's ruling, 2026-11-16).
 *  shortcut: only a scroll a script asks for (scrollTo, scrollBy,
 *  scrollIntoView), smooth by its own word or the root's `scroll-behavior`;
 *  a link to an anchor on a smooth-scrolling page is not seen. Upgrade if an
 *  app shows it. */
export const HELD_FRAMES_SCRIPT = `(() => {
  if (window.__demomanFlushFrames) return;
  if (window !== window.parent) {
    // Queued only for a parent that runs the queue (its script ran before
    // this frame existed); one that cannot be reached, or itself kept
    // Chrome's frames, runs none: Chrome's own frames.
    try { if (!window.parent.__demomanFlushFrames) return; } catch (e) { return; }
  }
  const request = window.requestAnimationFrame.bind(window);
  // Read before the page's own scripts run: a page that replaces it (DEM-210's
  // hostile page) would otherwise stop the pin on every frame.
  const all = document.querySelectorAll;
  const query = (s) => all.call(document, s);
  const FRAME = 1000 / 30;
  const queue = new Map();
  const said = new Set();
  let last = 0;
  let origin = null;
  window.requestAnimationFrame = function requestAnimationFrame(callback) {
    if (typeof callback !== "function") return request(callback);
    queue.set(++last, callback);
    return last;
  };
  window.cancelAnimationFrame = function cancelAnimationFrame(id) {
    queue.delete(id);
  };
  const named = (el) => {
    let o = "null";
    try { o = new URL(el.getAttribute("src") || "about:srcdoc", location.href).origin; } catch (e) {} // an address it never named: said as sandboxed
    return o === "null" ? "a sandboxed frame" : "a frame from " + o;
  };
  const SMOOTH = "the page asked for a smooth scroll, which the held clock does not play: it showed as a jump";
  let jumped = false;
  let asked = [];
  // Where everything el scrolls in stands: its own scroll, each box around it, the window.
  const where = (el) => {
    let s = "" + window.scrollX + "," + window.scrollY;
    for (let n = el; n && n.nodeType === 1; n = n.parentElement) s += "," + n.scrollLeft + "," + n.scrollTop;
    return s;
  };
  const watched = (own) => function (...args) {
    const el = this === window || this == null ? null : this;
    try {
      const b = args[0] && typeof args[0] === "object" ? args[0].behavior : undefined;
      const smooth = b === "smooth" ||
        (b !== "instant" && getComputedStyle(document.documentElement).scrollBehavior === "smooth");
      // Looked at on the next frame: Chrome moves the page after the call.
      if (smooth && !jumped && asked.length < 8) asked.push({ el, before: where(el) });
    } catch (e) {} // a page this cannot read is not said
    return own.apply(this, args);
  };
  for (const [on, names] of [
    [window, ["scroll", "scrollTo", "scrollBy"]],
    [window.Element && window.Element.prototype, ["scroll", "scrollTo", "scrollBy", "scrollIntoView"]],
  ])
    for (const name of on ? names : [])
      if (typeof on[name] === "function") on[name] = watched(on[name]);
  const flush = (v, server) => {
    if (origin === null) origin = FRAME * Math.round((v - performance.now()) / FRAME);
    window.__demomanServerFrame = !!server;
    const due = [...queue.keys()];
    const t = v - origin;
    for (const id of due) {
      const callback = queue.get(id);
      if (callback === undefined) continue;
      queue.delete(id);
      try { callback(t); } catch (e) { reportError(e); }
    }
    const out = [];
    try { if (asked.some((a) => where(a.el) !== a.before)) jumped = true; } catch (e) {}
    asked = [];
    if (jumped && !said.has(SMOOTH)) { said.add(SMOOTH); out.push(SMOOTH); }
    for (let i = 0; i < window.frames.length; i++) {
      const w = window.frames[i];
      let run;
      try { run = w.__demomanFlushFrames; } catch (e) {
        const el = [...query("iframe, frame")].find((f) => f.contentWindow === w);
        const what = (el ? named(el) : "a frame from another origin") + " runs its animations on its own clock: they were not held";
        if (!said.has(what)) { said.add(what); out.push(what); }
        continue;
      }
      if (run) for (const what of run(v, server)) if (!said.has(what)) { said.add(what); out.push(what); }
    }
    return out;
  };
  Object.defineProperty(window, "__demomanRaf", { value: request });
  Object.defineProperty(window, "__demomanFlushFrames", { value: flush });
  Object.defineProperty(window, "__demomanQuery", { value: query });
})()`;

export interface HeldFrame {
  sourceTimeMs: number;
  bytes: Uint8Array;
  width: number;
  height: number;
}

export interface HeldClock extends Clock {
  /** The scale the page is rendered and every frame captured at: the
   *  recording's, not the stills' 3x. Every held frame is a screenshot, and
   *  one of a 3x page took 97 ms on a CI runner against 16 ms at 1x
   *  (measured 2026-11-16, apps/runner/compare/held-probe-capture.mjs).
   *  shortcut: a zoom into a held still is no sharper than this scale;
   *  upgrade if zooms on 1x recordings read soft. */
  readonly scale: number;
  /** Holds the page's clock at `startEpochMs` (the pinned now, or the real time). */
  hold(startEpochMs: number): Promise<void>;
  /** Every frame captured so far is handed here, in order. */
  onFrame(listener: (frame: HeldFrame) => Promise<void>): void;
  /** Source-ms stretches spent waiting on the server. */
  networkSpans(): { startMs: number; endMs: number; label: string }[];
  /** Page animations the pin could not hold, at the held time first seen. */
  unpinned(): { atMs: number; what: string }[];
  /** Connections that stopped counting as waiting on the server (`NetworkWatch.ignored`). */
  ignoredConnections(): string[];
  /** Whether a document's request is open (`NetworkWatch.loading`). */
  loading(): boolean;
  /** Whether a sleep begun now would begin in the server's time: a document's
   *  request is open, or a wait heard of since the last frame, or heard
   *  over, is owed frames. The walk plays frames until it is not before it
   *  asks the page a timed question: a settle's quiet window ran inside the
   *  owed frames by as much as the machine made it (246 against 248 on a
   *  slowed one, traced 2026-11-16). */
  owing(): boolean;
  /** Runs `run` as a wait on the page: only a sleep inside one follows the
   *  server while a connection is open. Any other sleep is designed time (a
   *  pause, a rest, a journey) and is held frames whatever is open: read off
   *  the connection alone, a page with a channel that kept answering made a
   *  5 s video 76 s, a pause cut short on every step (measured 2026-11-16,
   *  compare/held-push.sh; the author's ruling, DEM-202). Nests. Frames a wait
   *  heard over is still owed when the wait on the page ends are not played
   *  on the way out (a wait that follows at once plays them, inside its own
   *  reported stretch), a connection still open is left, and real time that
   *  passes outside a wait is not credited to one. `since`: the wait's
   *  window on the page's clock (`now()` ms; none: no lower bound), whose
   *  requests alone it follows; data on an older one during it is unpaced
   *  (DEM-204, DEM-202). Nested waits follow the earliest window among
   *  them: an inner wait is part of the outer. */
  waiting<T>(run: () => Promise<T>, since?: number | null): Promise<T>;
  /** A page's `wallTime` (ms, its held clock) as `now()` ms. */
  pageOf(wallMs: number): number;
  /** The held time data first arrived at, outside a wait or on a request
   *  older than its window, on a connection the recording had followed: an
   *  answer that landed where the machine put it. Null when none did. */
  unpaced(): number | null;
  /** Re-applies the hold to a new document, continuing the same time. */
  rehold(): Promise<void>;
  /** Lets the page run, a frame of page time at a go and capturing none,
   *  until `read` settles: for a read after the recording that a paused page
   *  never answers (its storage). */
  through<T>(read: Promise<T>): Promise<T>;
  /** Lets the page go, after the recording's last read of it: its clock
   *  runs again and it is put on a blank document, so nothing of the app
   *  runs on at that clock's pace. A page left paused slows every other page
   *  of its browser: the final still rendered in 7.2 s beside one against
   *  0.5 s (measured 2026-11-16, compare/held-probe-two-runs.mjs). */
  release(): Promise<void>;
  /** Why the clock gave up on the page, once a frame's read of it went
   *  unanswered (`abandon` has closed it); the run's stop. Else null. */
  failed(): Error | null;
}

export function createHeldClock(deps: {
  cdp: CdpSession;
  network: NetworkWatch;
  /** `HeldClock.scale`. */
  scale: number;
  realNow: () => number;
  capture: () => Promise<{ bytes: Uint8Array; width: number; height: number }>;
  /** Runs `source`, a page function, with the held time and whether the
   *  frame follows the server (`PIN_ANIMATIONS`). */
  evaluate: (source: string, arg: number, server: boolean) => Promise<unknown>;
  /** Waits real time (default: a timer). */
  wait?: (ms: number) => Promise<void>;
  /** Closes the page from the browser's side, where a page whose script
   *  never ends still closes: every call waiting on it answers at once. */
  abandon?: () => Promise<void>;
}): HeldClock {
  const { cdp, network, realNow } = deps;
  const wait =
    deps.wait ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  /** The frame of the grid at or after `ms`, or at or before it. */
  const frameFrom = (ms: number) =>
    Math.ceil(ms / HELD_FRAME_MS - EPS) * HELD_FRAME_MS;
  const frameTo = (ms: number) =>
    Math.floor(ms / HELD_FRAME_MS + EPS) * HELD_FRAME_MS;
  let startEpochMs: number | null = null;
  let held = 0;
  /** `HeldClock.failed`. */
  let fatal: Error | null = null;
  const listeners: ((frame: HeldFrame) => Promise<void>)[] = [];
  const spans: { startMs: number; endMs: number; labels: Set<string> }[] = [];
  let span: (typeof spans)[number] | null = null;
  /** Where the open stretch began, in real and in held time: by its end it
   *  has followed all the real time between. */
  let stretchFrom = { real: 0, held: 0 };
  /** When the page last stopped at `held`, in real time. */
  let pausedAt = 0;
  /** The last look at the network, in real and held time. */
  let lookedAt = { real: 0, held: 0 };
  /** When the latest grant began, and the real time from a grant's start to
   *  its frame's capture, as last measured. */
  let grantAt = 0;
  let shotLatency = 0;
  /** When the latest frame was taken, in real time. */
  let shotAt = 0;
  /** A held grant's frame not taken because the page was waiting by its
   *  end: a stretch replaces it, or, if none comes of the wait, it is taken
   *  after all, at its time. */
  let unshot = false;
  /** Where a wait that began at real `from` (null: now) began in page time:
   *  where the page stood then, so `held` if it began after the page last
   *  stopped, or the look before if it began inside that grant. Never
   *  before that look: a wait heard after it is not credited from earlier.
   *  One rule, whichever branch of the sleep sees the wait. A page's own
   *  request says which by its `page` clock time; a document's, by real
   *  time. Nylon's click sent its fetch at the start of the next grant or
   *  10 ms into it, as Chrome had it, and heard 1 ms either side of the
   *  grant's end: the stretch began at the click or a frame later, and
   *  the rest of the video stood a frame apart (DEM-206). */
  const dated = (
    wait: { from: number; page?: number } | null,
    looked: { real: number; held: number },
  ) =>
    wait === null
      ? { real: realNow(), held }
      : {
          real: Math.max(wait.from, looked.real),
          held:
            wait.page !== undefined
              ? wait.page < held - pageSlack()
                ? looked.held
                : held
              : wait.from > pausedAt
                ? held
                : looked.held,
        };
  /** How far the page's clock may read behind `held`: Chrome counts a
   *  grant in whole µs, so it falls about 8e-6 ms behind per ms (measured
   *  2026-11-17, 0.03 ms at 4 s on Nylon); 2.5 times that. */
  const pageSlack = () => 0.05 + held * 2e-5;
  /** The waits since a look: heard after it, or sent by the page since it
   *  stood there. */
  const waitsSinceLook = (looked: { real: number; held: number }) =>
    network.waitsSince(looked.real, looked.held - pageSlack());
  const unpinned: { atMs: number; what: string }[] = [];
  /** The windows of the waits on the page running (`waiting`). */
  const windows: number[] = [];
  const narrow = () => {
    const from = Math.min(...windows);
    network.window(Number.isFinite(from) ? from : null);
  };
  /** Real ms the last wait on the page ended at: data after it is unpaced. */
  let leftWaitAt = Number.NEGATIVE_INFINITY;
  let unpacedAt: number | null = null;

  const pause = async (initialVirtualTime: number) => {
    try {
      await cdp.send("Emulation.setVirtualTimePolicy", {
        policy: "pause",
        initialVirtualTime,
      });
    } catch (e) {
      throw new Error(
        `could not hold the page's clock: Emulation.setVirtualTimePolicy was refused (${(e as Error).message})`,
      );
    }
  };

  /** Grants the page time up to `to` (source ms), then pauses it there:
   *  Chrome refuses a budget on `pause`, and a renderer a navigation starts
   *  takes the last policy sent, so it must be the pause at the held time
   *  (measured 2026-11-15, apps/runner/compare/held-probe-navigation.mjs). */
  const grant = async (to: number) => {
    if (startEpochMs === null) throw new Error("grant before hold");
    grantAt = realNow();
    const epochMs = startEpochMs;
    await advance(to);
    await pause((epochMs + to) / 1000);
  };
  const advance = (to: number) =>
    new Promise<void>((resolve, reject) => {
      if (fatal !== null) return reject(fatal);
      const budget = to - held;
      const settle = (error?: Error) => {
        clearTimeout(timer);
        off();
        if (error) reject(error);
        else {
          held = to;
          pausedAt = realNow();
          resolve();
        }
      };
      // A grant does not expire while a navigation waits on its server
      // (measured, Task 6), so a slow server is not Chrome's failure: while
      // the page is waiting the grant is waited on, and a wait that went
      // quiet is said as the server's (review of 2026-11-16). Only a
      // document's request re-arms it: any open connection did, and one that
      // kept sending (a fetch stream) waited on a hung navigation for good.
      // shortcut: a server silent for the whole of the bound still stops the
      // run, where a real clock goes on; upgrade if a cold route does it.
      const expired = () => {
        if (network.loading()) {
          timer = setTimeout(expired, GRANT_EXPIRY_TIMEOUT_MS);
          return;
        }
        const waits = network.waitsSince(grantAt - 1);
        settle(
          new Error(
            waits === null
              ? `the page's clock did not move: Chrome sent no Emulation.virtualTimeBudgetExpired for a ${budget} ms grant at ${held} ms within ${GRANT_EXPIRY_TIMEOUT_MS} ms`
              : `the page's clock did not move: the page was waiting on its server (${waits.labels.join(", ")}), which had not answered ${GRANT_EXPIRY_TIMEOUT_MS / 1000} s on`,
          ),
        );
      };
      let timer = setTimeout(expired, GRANT_EXPIRY_TIMEOUT_MS);
      // Listening before the send: the event can come before the answer.
      const off = cdp.on("Emulation.virtualTimeBudgetExpired", () => settle());
      cdp
        .send("Emulation.setVirtualTimePolicy", { policy: "advance", budget })
        .catch((e: Error) =>
          settle(
            new Error(
              `could not move the page's clock: Emulation.setVirtualTimePolicy was refused (${e.message})`,
            ),
          ),
        );
    });

  /** A frame's read of the page, bounded: page time stands still while a
   *  script runs, so a loop that waits on `performance.now()` or
   *  `Date.now()` never ends and its page never answers. */
  const answered = <T>(read: Promise<T>): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        fatal ??= new Error(
          `the page did not answer within ${GRANT_EXPIRY_TIMEOUT_MS / 1000} s at ${Math.round(held)} ms of the recording: a script on it is still running, as one that waits in a loop on performance.now() or Date.now() does, and on a held clock that loop never ends; record this page in real time with DEMOMAN_HELD_CLOCK=0`,
        );
        void deps.abandon?.().catch(() => undefined); // its calls answer, closed
        reject(fatal);
      }, GRANT_EXPIRY_TIMEOUT_MS);
    });
    return Promise.race([read, late]).finally(() => clearTimeout(timer));
  };

  /** `server`: the frame was shot following the server (a stretch's). */
  const shoot = async (server = false) => {
    if (fatal !== null) throw fatal;
    let failed: unknown;
    try {
      failed = await answered(deps.evaluate(PIN_ANIMATIONS, held, server));
    } catch (e) {
      throw new Error(
        `could not pin the page's animations at ${held} ms (${(e as Error).message})`,
      );
    }
    if (!Array.isArray(failed))
      throw new Error(
        `the animation pin at ${held} ms answered ${String(failed)}, not a list of the animations it could not pin`,
      );
    for (const what of failed)
      unpinned.push({ atMs: held, what: String(what) });
    const shot = await answered(deps.capture());
    shotAt = realNow();
    shotLatency = shotAt - grantAt;
    if (listeners.length === 0)
      throw new Error("a frame was captured with no frame listener to file it");
    for (const listener of listeners)
      await listener({ sourceTimeMs: held, ...shot });
  };

  /** Plays the frames a wait that is over is still owed, if any. */
  const owedPaid = async (looked: { real: number; held: number }) => {
    // A stretch ends having followed all the real time of its wait,
    // also what passed inside a grant or a frame: a navigation's old
    // page answers neither until the new one commits (measured
    // 2026-11-15: a 1 ms grant took 227 ms, the server's 200).
    const quiet = network.quietSince();
    // A wait can also begin and end between two looks, inside one
    // grant (a cross-site click's whole wait, 1 of 20 times on
    // 2026-11-15): one more connection of a stretch open up to now, or
    // a stretch of its own from where the page stood when it began,
    // kept only if it is owed time.
    const last = waitsSinceLook(looked);
    let unseen: typeof span = null;
    if (quiet !== null && last !== null) {
      if (span?.endMs === held) for (const l of last.labels) span.labels.add(l);
      else {
        stretchFrom = dated(last, looked);
        unseen = {
          startMs: stretchFrom.held,
          endMs: held,
          labels: new Set(last.labels),
        };
      }
    }
    const open = unseen ?? (span?.endMs === held ? span : null);
    const owed =
      open !== null && quiet !== null
        ? stretchFrom.held + (quiet - stretchFrom.real) - held
        : 0;
    if (open !== null && owed > EPS) {
      if (open === unseen) {
        span = open;
        spans.push(open);
      }
      await grant(frameFrom(held + owed));
      unshot = false;
      open.endMs = held;
      await shoot(true);
      return true;
    }
    return false;
  };

  return {
    scale: deps.scale,
    now: () => held,
    async hold(epochMs) {
      await pause(epochMs / 1000);
      startEpochMs = epochMs;
      held = 0;
      lookedAt = { real: realNow(), held };
      // A request already open at the hold: its real time before it is not
      // the page's.
      pausedAt = lookedAt.real;
    },
    async rehold() {
      if (startEpochMs === null) throw new Error("rehold before hold");
      await pause((startEpochMs + held) / 1000);
    },
    async through(read) {
      let settled = false;
      const done = read.finally(() => {
        settled = true;
      });
      done.catch(() => {}); // handed on below; a failed grant must not leave it unhandled
      // A frame of page time for a frame of real time: unpaced, a 2 s read
      // ran a minute of the page's timers and polls. Bounded, in words: a
      // read that never answers would hold the run for good.
      const by = realNow() + GRANT_EXPIRY_TIMEOUT_MS;
      while (!settled) {
        if (realNow() > by)
          throw new Error(
            `the page did not answer a read of it within ${GRANT_EXPIRY_TIMEOUT_MS / 1000} s of its clock running`,
          );
        try {
          await grant(held + HELD_FRAME_MS);
        } catch (error) {
          // The page may be gone and the read still answer (its browser
          // holds the storage): given a moment before the grant's failure
          // is the answer.
          await wait(1000);
          if (settled) break;
          throw error;
        }
        if (!settled) await wait(HELD_FRAME_MS);
      }
      return done;
    },
    async release() {
      // Chrome has no policy for "the real clock": an advance with no budget
      // runs the page's time as fast as it will go, so the page is blanked
      // at once (probe-storage: a 1 s timer fired 125 times in a second).
      await cdp.send("Emulation.setVirtualTimePolicy", { policy: "advance" });
      await cdp.send("Page.navigate", { url: "about:blank" });
    },
    onFrame(listener) {
      listeners.push(listener);
    },
    failed: () => fatal,
    loading: () => network.loading(),
    owing() {
      if (network.loading() || network.waitsSince(lookedAt.real) !== null)
        return true;
      const quiet = network.quietSince();
      return (
        quiet !== null &&
        span?.endMs === held &&
        stretchFrom.held + (quiet - stretchFrom.real) - held > EPS
      );
    },
    networkSpans: () =>
      spans.map((s) => ({
        startMs: s.startMs,
        endMs: s.endMs,
        label: [...s.labels].join(", "),
      })),
    unpinned: () => [...unpinned],
    ignoredConnections: () => network.ignored(),
    async sleep(ms) {
      if (startEpochMs === null) throw new Error("sleep before hold");
      if (!(ms >= 0)) throw new Error(`cannot sleep ${ms} ms of page time`);
      const end = held + ms;
      // Not past a frame skipped at the sleep's last grant: the walk would
      // change the page before it was taken (review of Task 9 round 3).
      while (end - held > EPS || unshot) {
        const looked = lookedAt;
        lookedAt = { real: realNow(), held };
        // Only a wait on the page follows the server (`waiting`).
        const following = windows.length > 0;
        // Not only while the connection is open: a stream's last chunk and
        // its end can both land inside one designed frame (review, Session C).
        if (
          ((following ? network.outsideDataAt() : network.followedDataAt()) ??
            Number.NEGATIVE_INFINITY) > Math.max(looked.real, leftWaitAt)
        )
          unpacedAt ??= held;
        if (following && network.waiting()) {
          network.follow();
          // The server's pace: page time catches up with all the real time
          // since the stretch began, past the sleep's end if real time is
          // there, as a real clock's sleep overruns (cut at the end, a
          // 1800 ms stream played in 839 ms, then jumped; 2026-11-15). The
          // stretch begins when the page began waiting, or when it last
          // stopped at this held time if later: real time before either was
          // the walk's own work, or is in a frame already. Frames stay on
          // the grid, so the page's timers keep one phase however long the
          // server took (off it, the load's wait made "the same video
          // twice" differ): a frame of the grid at or before where real
          // time is expected at the frame's capture, and a machine that
          // captures faster than a frame waits for it.
          const continues = span?.endMs === held;
          // Waits since the last look, also one already over: a cross-site
          // click's whole wait can fall inside one grant, and the new
          // page's favicon be what the next look sees (CI ubuntu,
          // 2026-11-15).
          const since = waitsSinceLook(looked);
          if (!continues) stretchFrom = dated(since, looked);
          const walked = lookedAt.real - Math.max(shotAt, stretchFrom.real);
          if (walked > WALK_GAP_CREDIT_MS)
            stretchFrom = {
              real: stretchFrom.real + walked - WALK_GAP_CREDIT_MS,
              held: stretchFrom.held,
            };
          // Where real time will be when this frame is taken, a grant and a
          // capture from now, as the last one took: what the page shows then
          // is what the frame's time must say. A capture faster than the last
          // is stamped ahead of when it was taken by the difference, at most
          // the last one's length; one slower, behind. Stamped at the look
          // instead, every frame of a stream was one capture early on a slow
          // machine, where that is about 240 ms (2026-11-15).
          const due =
            stretchFrom.held + (realNow() + shotLatency - stretchFrom.real);
          const labels = [...(since?.labels ?? []), ...network.labels()];
          const to = Math.max(frameTo(held) + HELD_FRAME_MS, frameTo(due));
          if (to > due) await wait(to - due);
          await grant(to);
          unshot = false;
          if (!continues || !span) {
            span = {
              startMs: stretchFrom.held,
              endMs: held,
              labels: new Set(),
            };
            spans.push(span);
          }
          span.endMs = held;
          for (const l of labels) span.labels.add(l);
          await shoot(true);
          continue;
        }
        if (following && (await owedPaid(looked))) continue;
        // A wait shorter than a frame left no stretch: the frame it skipped
        // is taken, at its time, as on a machine that never saw the wait
        // (review of Task 9 round 2, finding 3).
        if (unshot) {
          unshot = false;
          await shoot();
          continue;
        }
        const next =
          (Math.floor(held / HELD_FRAME_MS + EPS) + 1) * HELD_FRAME_MS;
        if (next > end + EPS) {
          await grant(end);
          break;
        }
        await grant(next < end - EPS ? next : end);
        // The page began waiting during this grant: what it shows by the
        // capture is the server's, so the frame is the stretch's first, taken
        // where real time is (the next look), not here. Taken here, a
        // stream's first chunks showed a capture early on a slow machine.
        if (following && network.waiting()) {
          unshot = true;
          continue;
        }
        await shoot();
      }
    },
    pageOf(wallMs) {
      if (startEpochMs === null) throw new Error("pageOf before hold");
      return wallMs - startEpochMs;
    },
    async waiting(run, since) {
      const from = since ?? Number.NEGATIVE_INFINITY;
      windows.push(from);
      narrow();
      let out: Awaited<ReturnType<typeof run>>;
      try {
        out = await run();
      } finally {
        windows.splice(windows.lastIndexOf(from), 1);
        narrow();
        if (windows.length === 0) leftWaitAt = realNow();
      }
      // A frame skipped for a wait is still taken. Frames a wait heard over
      // is owed are not played here: they would be page time added by how
      // long the server took, after the page's own scripts began, and its
      // animations then stood a frame or more apart between two recordings
      // (the opening's load: the first frame at 633, 667 or 700 ms by the
      // machine, CI macOS and a slowed recording here, 2026-11-16). Only a
      // sleep inside a wait plays them, as part of its own time.
      if (windows.length === 0 && startEpochMs !== null && unshot) {
        unshot = false;
        await shoot();
      }
      return out;
    },
    unpaced: () => unpacedAt,
  };
}

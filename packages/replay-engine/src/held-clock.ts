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

/** Page script: pins every animation in the document to the held time (ms),
 *  and answers the ones it could not pin, each named once.
 *  An animation's own currentTime runs on Chrome's real clock, so it starts at
 *  the held time it is first seen at; it is finished at its end, so a library
 *  waiting for `animationend` still hears it, and pinned again from the frame
 *  the page is seen playing it again. A scroll-driven animation follows the
 *  scroll, which the walk moves, so it is left alone.
 *  shortcut: an animation at a playbackRate other than 1 plays at rate 1 under
 *  the pin; upgrade if an app shows it. */
export const PIN_ANIMATIONS = `(v) => {
  const unpinned =
    typeof window.__demomanFlushFrames === "function" ? window.__demomanFlushFrames(v) : [];
  for (const a of document.getAnimations()) {
    if (a.__unpinned) continue;
    if (a.timeline && !(a.timeline instanceof DocumentTimeline)) continue;
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
      const name = a.animationName || a.transitionProperty || a.id || "an animation";
      const tag = a.effect?.target?.tagName?.toLowerCase() ?? "no element";
      unpinned.push(name + " on " + tag + ": " + (e && e.message ? e.message : String(e)));
    }
  }
  return unpinned;
}`;

/** Page script for every document of a held recording: Chrome runs
 *  animation frames on its real clock even while page time is held
 *  (measured 2026-11-15, apps/runner/compare/held-probe-matrix.mjs), so the
 *  page's `requestAnimationFrame` queues instead, and `PIN_ANIMATIONS` runs
 *  the queue once per captured frame (`__demomanFlushFrames(heldMs)`), as a
 *  browser runs one frame's callbacks. A callback asked for inside a frame
 *  runs on the next.
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
 *  must not wait on a captured frame. */
export const HELD_FRAMES_SCRIPT = `(() => {
  if (window.__demomanFlushFrames) return;
  if (window !== window.parent) {
    // Queued only for a parent that runs the queue (its script ran before
    // this frame existed); one that cannot be reached, or itself kept
    // Chrome's frames, runs none: Chrome's own frames.
    try { if (!window.parent.__demomanFlushFrames) return; } catch (e) { return; }
  }
  const request = window.requestAnimationFrame.bind(window);
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
  const flush = (v) => {
    if (origin === null) origin = FRAME * Math.round((v - performance.now()) / FRAME);
    const due = [...queue.keys()];
    const t = v - origin;
    for (const id of due) {
      const callback = queue.get(id);
      if (callback === undefined) continue;
      queue.delete(id);
      try { callback(t); } catch (e) { reportError(e); }
    }
    const out = [];
    for (let i = 0; i < window.frames.length; i++) {
      const w = window.frames[i];
      let run;
      try { run = w.__demomanFlushFrames; } catch (e) {
        const el = [...document.querySelectorAll("iframe, frame")].find((f) => f.contentWindow === w);
        const what = (el ? named(el) : "a frame from another origin") + " runs its animations on its own clock: they were not held";
        if (!said.has(what)) { said.add(what); out.push(what); }
        continue;
      }
      if (run) for (const what of run(v)) if (!said.has(what)) { said.add(what); out.push(what); }
    }
    return out;
  };
  Object.defineProperty(window, "__demomanRaf", { value: request });
  Object.defineProperty(window, "__demomanFlushFrames", { value: flush });
})()`;

export interface HeldFrame {
  sourceTimeMs: number;
  bytes: Uint8Array;
  width: number;
  height: number;
}

export interface HeldClock extends Clock {
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
  /** Re-applies the hold to a new document, continuing the same time. */
  rehold(): Promise<void>;
}

export function createHeldClock(deps: {
  cdp: CdpSession;
  network: NetworkWatch;
  realNow: () => number;
  capture: () => Promise<{ bytes: Uint8Array; width: number; height: number }>;
  evaluate: (source: string, arg: number) => Promise<unknown>;
  /** Waits real time (default: a timer). */
  wait?: (ms: number) => Promise<void>;
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
   *  One rule, whichever branch of the sleep sees the wait. */
  const dated = (
    from: number | null,
    looked: { real: number; held: number },
  ) =>
    from === null
      ? { real: realNow(), held }
      : {
          real: Math.max(from, looked.real),
          held: from > pausedAt ? held : looked.held,
        };
  const unpinned: { atMs: number; what: string }[] = [];

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
      const timer = setTimeout(
        () =>
          settle(
            new Error(
              `the page's clock did not move: Chrome sent no Emulation.virtualTimeBudgetExpired for a ${budget} ms grant at ${held} ms within ${GRANT_EXPIRY_TIMEOUT_MS} ms`,
            ),
          ),
        GRANT_EXPIRY_TIMEOUT_MS,
      );
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

  const shoot = async () => {
    let failed: unknown;
    try {
      failed = await deps.evaluate(PIN_ANIMATIONS, held);
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
    const shot = await deps.capture();
    shotAt = realNow();
    shotLatency = shotAt - grantAt;
    if (listeners.length === 0)
      throw new Error("a frame was captured with no frame listener to file it");
    for (const listener of listeners)
      await listener({ sourceTimeMs: held, ...shot });
  };

  return {
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
    onFrame(listener) {
      listeners.push(listener);
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
      // Nor owing a stretch whose wait it has heard end: the walk would ask
      // the page next, and a settle's 200 ms quiet window ran inside the
      // owed network time on one machine and after it on another, a frame
      // apart (the two-machines test, 2026-11-15).
      const owing = () => {
        const quiet = network.quietSince();
        return (
          quiet !== null &&
          span?.endMs === held &&
          stretchFrom.held + (quiet - stretchFrom.real) - held > EPS
        );
      };
      while (end - held > EPS || unshot || owing()) {
        const looked = lookedAt;
        lookedAt = { real: realNow(), held };
        if (network.waiting()) {
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
          const since = network.waitsSince(looked.real);
          if (!continues) stretchFrom = dated(since?.from ?? null, looked);
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
          await shoot();
          continue;
        }
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
        const last = network.waitsSince(looked.real);
        let unseen: typeof span = null;
        if (quiet !== null && last !== null) {
          if (span?.endMs === held)
            for (const l of last.labels) span.labels.add(l);
          else {
            stretchFrom = dated(last.from, looked);
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
          await shoot();
          continue;
        }
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
        if (network.waiting()) {
          unshot = true;
          continue;
        }
        await shoot();
      }
    },
  };
}

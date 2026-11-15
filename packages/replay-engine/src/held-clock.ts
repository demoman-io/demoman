import type { NetworkWatch } from "./network-watch.js";
import type { CdpSession, Clock } from "./types.js";

/** One video frame of page time. */
export const HELD_FRAME_MS = 1000 / 30;

/** A grant expires once the page has run what falls due in it (milliseconds in
 *  the spike); Chrome that never says so, a crashed or detached renderer, would
 *  hold the recording for good. 15 s is the spike's watchdog: room for a page's
 *  own long task, short enough to say what happened. */
export const GRANT_EXPIRY_TIMEOUT_MS = 15_000;

/** 30 · (1000/30) is 1000.0000000000001: frame times are compared this loosely. */
const EPS = 1e-6;

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
  const unpinned = [];
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
  /** Re-applies the hold to a new document, continuing the same time. */
  rehold(): Promise<void>;
}

export function createHeldClock(deps: {
  cdp: CdpSession;
  network: NetworkWatch;
  realNow: () => number;
  capture: () => Promise<{ bytes: Uint8Array; width: number; height: number }>;
  evaluate: (source: string, arg: number) => Promise<unknown>;
}): HeldClock {
  const { cdp, network, realNow } = deps;
  let startEpochMs: number | null = null;
  let held = 0;
  let grantEnded = 0;
  const listeners: ((frame: HeldFrame) => Promise<void>)[] = [];
  const spans: { startMs: number; endMs: number; labels: Set<string> }[] = [];
  let span: (typeof spans)[number] | null = null;
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

  /** Grants the page time up to `to` (source ms). */
  const grant = (to: number) =>
    new Promise<void>((resolve, reject) => {
      const budget = to - held;
      const settle = (error?: Error) => {
        clearTimeout(timer);
        off();
        if (error) reject(error);
        else {
          held = to;
          grantEnded = realNow();
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
        .send("Emulation.setVirtualTimePolicy", { policy: "pause", budget })
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
    async sleep(ms) {
      if (startEpochMs === null) throw new Error("sleep before hold");
      if (!(ms >= 0)) throw new Error(`cannot sleep ${ms} ms of page time`);
      const end = held + ms;
      while (end - held > EPS) {
        if (network.waiting()) {
          // The server's pace: page time follows the real time since the last
          // grant. Not for a stretch's first: the real time before it was the
          // walk's own work, which takes no time in the video.
          const continues = span?.endMs === held;
          const realMs = continues ? realNow() - grantEnded : 0;
          const labels = network.labels();
          const from = held;
          await grant(Math.min(end, held + Math.max(1, realMs)));
          if (!continues || !span) {
            span = { startMs: from, endMs: held, labels: new Set() };
            spans.push(span);
          }
          span.endMs = held;
          for (const l of labels) span.labels.add(l);
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
        await shoot();
      }
    },
  };
}

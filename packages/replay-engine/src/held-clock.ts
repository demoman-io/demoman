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

/** Page script: pins every animation in the document to the held time (ms).
 *  An animation's own currentTime runs on Chrome's real clock, so it starts at
 *  the held time it is first seen at; it is finished at its end, so a library
 *  waiting for `animationend` still hears it. */
export const PIN_ANIMATIONS = `(v) => {
  for (const a of document.getAnimations()) {
    if (a.__done) continue;
    a.__v0 ??= v;
    const t = v - a.__v0;
    const end = a.effect?.getComputedTiming().endTime ?? Number.POSITIVE_INFINITY;
    if (Number.isFinite(end) && t >= end) {
      a.__done = true;
      a.finish();
    } else {
      a.pause();
      a.currentTime = t;
    }
  }
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
    await deps.evaluate(PIN_ANIMATIONS, held);
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
      grantEnded = realNow();
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
    async sleep(ms) {
      if (startEpochMs === null) throw new Error("sleep before hold");
      if (!(ms >= 0)) throw new Error(`cannot sleep ${ms} ms of page time`);
      const end = held + ms;
      while (end - held > EPS) {
        if (network.waiting()) {
          // The server's pace: page time follows the real time since the last grant.
          const labels = network.labels();
          const from = held;
          await grant(
            Math.min(end, held + Math.max(1, realNow() - grantEnded)),
          );
          if (!span || span.endMs !== from) {
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

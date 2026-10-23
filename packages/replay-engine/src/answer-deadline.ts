import type { CdpSession } from "./types.js";

/**
 * How long the walk waits for the browser to answer any one CDP call.
 *
 * Measured 2026-10-13: a CLI run on Wikipedia sat in its second
 * `waitForLoad` for ten minutes, saying nothing, until `film:compare` gave up
 * and closed the browser — some call never answered, and nothing in the walk
 * had a deadline over one. The run's own waits each have a bound
 * (`WAIT_TIMEOUT_MS`, the settle's, the drain's); a call underneath them did
 * not.
 *
 * The longest answer the walk asks for on purpose is the settle probe's —
 * `SETTLE_PAINT_TIMEOUT_MS` plus `SETTLE_QUIET_TIMEOUT_MS` plus its 250 ms
 * grace, about 8.3 s, timed inside the page. Thirty seconds is that with room,
 * and a ceiling on a browser that stopped answering, not a budget.
 */
export const ANSWER_DEADLINE_MS = 30_000;

export interface AnsweringCdp {
  cdp: CdpSession;
  /** Clears every deadline still running, without settling its call: what
   *  the walk abandons at teardown it abandons as it always did. */
  stop(): void;
}

/**
 * `cdp`, with every `send` refused once it has gone `deadlineMs` without an
 * answer, in words that name the call — so a hang becomes the run's
 * `portFailure` with its cause in the note, instead of a run that never
 * returns. An answer that arrives later is dropped.
 *
 * Real timers, not the run's `Clock`, on purpose. A test's clock resolves
 * every sleep at once, so a deadline raced on it would refuse every call
 * there; and Chrome's throttling of a hidden page's timers only ever makes
 * this fire late, which a backstop can afford. Each timer is cleared when its
 * call answers, and `stop` clears the rest, so none outlives the walk.
 */
export function withAnswerDeadline(
  cdp: CdpSession,
  deadlineMs: number = ANSWER_DEADLINE_MS,
): AnsweringCdp {
  const running = new Set<ReturnType<typeof setTimeout>>();
  return {
    cdp: {
      send(method, params) {
        return new Promise((resolve, reject) => {
          const timer = setTimeout(() => {
            running.delete(timer);
            reject(
              new Error(
                `${method} got no answer from the browser in ${deadlineMs / 1000} s`,
              ),
            );
          }, deadlineMs);
          running.add(timer);
          cdp.send(method, params).then(
            (reply) => {
              clearTimeout(timer);
              running.delete(timer);
              resolve(reply);
            },
            (error: unknown) => {
              clearTimeout(timer);
              running.delete(timer);
              reject(error);
            },
          );
        });
      },
      on: (event, handler) => cdp.on(event, handler),
      detach: () => cdp.detach(),
    },
    stop() {
      for (const timer of running) clearTimeout(timer);
      running.clear();
    },
  };
}

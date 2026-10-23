import { ANSWER_DEADLINE_MS } from "@demoman/replay-engine";

/**
 * `work`, refused once it has gone `ms` without settling, in words that name
 * it — the walk's `withAnswerDeadline`, for a Playwright call on the author's
 * page rather than a CDP one.
 *
 * `page.evaluate` has no timeout of its own, and a page stuck in its own
 * script never answers one: the snapshot's walk, a step's capture or a
 * resolve then held the executor's single slot for the life of the process,
 * with nothing to cancel (review 2026-10-13, #3). The same ceiling as a CDP
 * call: what these ask the page for is a DOM walk, never a wait.
 *
 * The work is not cancelled — Playwright cannot take back an evaluate — and
 * a late settle is dropped: `Promise.race` holds a handler on it, so a late
 * rejection is never unhandled.
 */
export function withinDeadline<T>(
  work: Promise<T>,
  what: string,
  ms: number = ANSWER_DEADLINE_MS,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new Error(`${what} got no answer from the page in ${ms / 1000} s`),
        ),
      ms,
    );
  });
  return Promise.race([work, late]).finally(() => clearTimeout(timer));
}

// apps/studio/pages/src/shell/refresher.ts

/**
 * A page's renders, one at a time, and its refreshes nobody asked for. Settings
 * and the Recordings page each kept a copy of this until 2026-10-17, and a fix
 * to one would not have reached the other.
 *
 * - `render()` is an action's own. It always paints, after every render asked
 *   before it, and clears the page's notice (`keepNotice` false): a stale
 *   refusal must not stand over the next thing that works.
 * - `soon()` is a change seen elsewhere: a feed event, a tab flip. It keeps
 *   the notice, since a change the author did not ask for must not take
 *   away a sentence an action just wrote. It is skipped when a paint that
 *   began after it was asked already covers it — an action writes, its own
 *   render reads, and the change event that same write raises would read it
 *   all again. A burst costs one paint in flight and one after it, never
 *   one per event. And it waits while `hold()` says the author is mid-edit.
 * - `resume()` runs a held refresh once `hold()` lets go.
 * - `pending()` is the newest render queued. A caller waiting for the page
 *   to be quiet awaits it, then compares it by identity with a fresh call
 *   to tell whether another render was queued meanwhile.
 *
 * Renders chain on both arms, so one that rejects does not stop every later
 * one; the rejection still reaches whoever awaited that render.
 */
export interface Refresher {
  render(): Promise<void>;
  soon(): void;
  resume(): void;
  pending(): Promise<void>;
}

export function createRefresher(o: {
  /** Reads and draws the page. `keepNotice` is false for an action's own
   *  render, true for a refresh. */
  paint: (keepNotice: boolean) => Promise<void>;
  /** Where a refresh's failure is said: `soon` is fire-and-forget, and an
   *  extension page's unhandled rejection lands on chrome://extensions. */
  onRefreshFailed: (error: unknown) => void;
  /** True while a refresh must wait (the author mid-edit). */
  hold?: () => boolean;
}): Refresher {
  let chain: Promise<void> = Promise.resolve();
  /** Refreshes asked for so far, and how many had been asked for when the
   *  newest paint began reading. Counted when asked, not when run: a read
   *  that began after that moment already shows the cause. */
  let asked = 0;
  let readFrom = 0;
  /** A refresh is running, waiting its turn, or held. */
  let queued = false;
  /** A refresh asked for while one was queued. That one may have read
   *  before this one's cause landed, so one more runs when it ends. */
  let again = false;
  let held = false;

  function queue(keepNotice: boolean, unlessReadSince?: number) {
    const run = (): Promise<void> => {
      if (unlessReadSince !== undefined && readFrom >= unlessReadSince) {
        return Promise.resolve();
      }
      readFrom = asked;
      return o.paint(keepNotice);
    };
    chain = chain.then(run, run);
    return chain;
  }

  function start(since: number): void {
    queued = true;
    if (o.hold?.() === true) {
      // Still queued, so a request made meanwhile folds into this one.
      held = true;
      return;
    }
    void queue(true, since)
      .catch(o.onRefreshFailed)
      .finally(() => {
        queued = false;
        if (again) {
          again = false;
          start(asked);
        }
      });
  }

  return {
    render: () => queue(false),
    soon() {
      const n = ++asked;
      if (queued) {
        again = true;
        return;
      }
      start(n);
    },
    resume() {
      if (!held || o.hold?.() === true) return;
      held = false;
      // Whatever was asked while it waited is covered by this one read.
      again = false;
      start(asked);
    },
    pending: () => chain,
  };
}

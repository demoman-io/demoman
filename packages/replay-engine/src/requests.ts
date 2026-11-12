import type { CdpSession } from "./types.js";

/**
 * What counts as in flight: fetch and XHR, and the code a page loads to draw
 * what it shows (a route change's lazily loaded scripts and stylesheets,
 * which run before its fetch; DEM-176). Any origin's, as a fetch already was:
 * a build may serve its chunks from a CDN. A script always finishes or
 * fails; a slow third-party one costs a step at most `STEP_REQUEST_CAP_MS`
 * and is named on the screen ("N request(s) in flight"), never forgiven.
 * A dev server's WebSocket/EventSource never closes, and documents and
 * images are the load check's business.
 */
const COUNTED = new Set(["Fetch", "XHR", "Script", "Stylesheet"]);
const POLL_MS = 25;

export interface RequestTracker {
  /** Requests in flight that opened after `openedAfter` (every one when it is left out). */
  inFlight(openedAfter?: number): number;
  /** True once none opened after `openedAfter` is in flight; false when `deadlineMs` arrives first. */
  idle(
    deadlineMs: number,
    sleep: (ms: number) => Promise<void>,
    openedAfter?: number,
  ): Promise<boolean>;
  /** Stops listening and turns the Network domain off again. */
  dispose(): void;
}

/** Rejects with the reason when `Network.enable` fails: a tracker that counts nothing must not look like one that counts. `now` is the clock each request's opening and every deadline are on. */
export async function trackRequests(
  cdp: Pick<CdpSession, "on" | "send">,
  now: () => number,
): Promise<RequestTracker> {
  /** Each request in flight, by id: when it opened, and the frame it is for. */
  const open = new Map<string, { at: number; frame: unknown }>();
  const forget = (frame: unknown): void => {
    if (frame === undefined) return;
    for (const [id, r] of open) if (r.frame === frame) open.delete(id);
  };
  const offs = [
    cdp.on("Network.requestWillBeSent", (p) => {
      const id = String(p.requestId);
      // A redirect reuses its id: it stays one request, opened when it first did.
      if (COUNTED.has(String(p.type)) && !open.has(id))
        open.set(id, { at: now(), frame: p.frameId });
    }),
    cdp.on(
      "Network.loadingFinished",
      (p) => void open.delete(String(p.requestId)),
    ),
    cdp.on(
      "Network.loadingFailed",
      (p) => void open.delete(String(p.requestId)),
    ),
    // A new document in a frame: the old one's requests died with it, and
    // Chrome does not always say so with `loadingFailed`. Left counted, each
    // would cost the step the whole cap and read as in flight when it was
    // not. A new top document takes its frames' requests with it too.
    cdp.on("Page.frameNavigated", (p) => {
      const frame = p.frame as { id?: string; parentId?: string } | undefined;
      if (frame === undefined) return;
      if (frame.parentId === undefined) open.clear();
      else forget(frame.id);
    }),
    // A frame removed from the page: its requests went with it.
    cdp.on("Page.frameDetached", (p) => forget(p.frameId)),
  ];
  const dispose = () => {
    for (const off of offs) off();
  };
  try {
    // Only the events are read: no body is kept, so none is buffered.
    await cdp.send("Network.enable", {
      maxTotalBufferSize: 0,
      maxResourceBufferSize: 0,
      maxPostDataSize: 0,
    });
  } catch (err) {
    dispose();
    throw err;
  }
  const inFlight = (openedAfter = Number.NEGATIVE_INFINITY): number => {
    let n = 0;
    for (const r of open.values()) if (r.at > openedAfter) n++;
    return n;
  };
  return {
    inFlight,
    async idle(deadlineMs, sleep, openedAfter) {
      while (inFlight(openedAfter) > 0) {
        if (now() >= deadlineMs) return false;
        await sleep(POLL_MS);
      }
      return true;
    },
    dispose() {
      dispose();
      // Swallowed on purpose: at teardown the session is often already
      // closed, which refuses this, and nothing is left that reads the
      // domain or waits on its answer.
      void cdp.send("Network.disable").catch(() => undefined);
    },
  };
}

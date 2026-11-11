import type { CdpSession } from "./types.js";

/** Only fetch and XHR count: a dev server's WebSocket/EventSource never closes, and documents and images are the load check's business. */
const COUNTED = new Set(["Fetch", "XHR"]);
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
  dispose(): void;
}

/** Rejects with the reason when `Network.enable` fails: a tracker that counts nothing must not look like one that counts. `now` is the clock each request's opening and every deadline are on. */
export async function trackRequests(
  cdp: Pick<CdpSession, "on" | "send">,
  now: () => number,
): Promise<RequestTracker> {
  /** Each request in flight, by id, and when it opened. */
  const open = new Map<string, number>();
  const offs = [
    cdp.on("Network.requestWillBeSent", (p) => {
      const id = String(p.requestId);
      // A redirect reuses its id: it stays one request, opened when it first did.
      if (COUNTED.has(String(p.type)) && !open.has(id)) open.set(id, now());
    }),
    cdp.on(
      "Network.loadingFinished",
      (p) => void open.delete(String(p.requestId)),
    ),
    cdp.on(
      "Network.loadingFailed",
      (p) => void open.delete(String(p.requestId)),
    ),
    // A new top document: the old one's requests died with it, and Chrome
    // does not always say so with `loadingFailed`. Left counted, each would
    // cost the step the whole cap and read as in flight when it was not.
    cdp.on("Page.frameNavigated", (p) => {
      const frame = p.frame as { parentId?: string } | undefined;
      if (frame !== undefined && frame.parentId === undefined) open.clear();
    }),
  ];
  const dispose = () => {
    for (const off of offs) off();
  };
  try {
    await cdp.send("Network.enable");
  } catch (err) {
    dispose();
    throw err;
  }
  const inFlight = (openedAfter = Number.NEGATIVE_INFINITY): number => {
    let n = 0;
    for (const at of open.values()) if (at > openedAfter) n++;
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
    dispose,
  };
}

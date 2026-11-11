import type { CdpSession } from "./types.js";

/** Only fetch and XHR count: a dev server's WebSocket/EventSource never closes, and documents and images are the load check's business. */
const COUNTED = new Set(["Fetch", "XHR"]);
const POLL_MS = 25;

export interface RequestTracker {
  inFlight(): number;
  /** True once nothing is in flight; false when `deadlineMs` (on `now`'s clock) arrives first. */
  idle(
    deadlineMs: number,
    sleep: (ms: number) => Promise<void>,
    now: () => number,
  ): Promise<boolean>;
  dispose(): void;
}

/** Rejects with the reason when `Network.enable` fails: a tracker that counts nothing must not look like one that counts. */
export async function trackRequests(
  cdp: Pick<CdpSession, "on" | "send">,
): Promise<RequestTracker> {
  const open = new Set<string>();
  const offs = [
    cdp.on("Network.requestWillBeSent", (p) => {
      if (COUNTED.has(String(p.type))) open.add(String(p.requestId)); // a redirect reuses its id: the Set keeps it one
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
  return {
    inFlight: () => open.size,
    async idle(deadlineMs, sleep, now) {
      while (open.size > 0) {
        if (now() >= deadlineMs) return false;
        await sleep(POLL_MS);
      }
      return true;
    },
    dispose,
  };
}

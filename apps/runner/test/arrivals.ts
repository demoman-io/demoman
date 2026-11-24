import type { BrowserContext } from "playwright";

/** A response's data as Demoman heard it: each `Network.dataReceived` for
 *  a request, at `performance.now()` when its CDP session emitted it. */
export interface Arrival {
  requestId: string;
  url: string;
  /** Bytes in this event; chunks that came together share one. */
  bytes: number;
  at: number;
}

const urls = new Map<string, string>();
const heard: Arrival[] = [];
let watching = false;
/** Every arrival heard in this process so far (`watchArrivals`). */
export const arrivals = (): readonly Arrival[] => heard;

type EmittingProto = {
  emit: (event: string | symbol, ...args: unknown[]) => boolean;
};

/**
 * Hears every CDP session's network data in this process (DEM-235): when
 * Demoman's own session heard each answer's data arrive, which is all a held
 * clock can follow. The server's send times say when it was sent; a loaded
 * runner delivered one 140 ms late. `performance.now()`, the clock the test
 * servers stamp their sends with.
 *
 * `CDPSession`'s prototype is the process's, shared by every browser it
 * launches, so the wrapper goes on once (as `lagCdp`'s does).
 */
export async function watchArrivals(context: BrowserContext): Promise<void> {
  if (watching) return;
  // A browser-level session: the same class, and no page opened to get it.
  const browser = context.browser();
  if (browser === null) throw new Error("watchArrivals: no browser");
  const session = await browser.newBrowserCDPSession();
  const proto = Object.getPrototypeOf(session) as EmittingProto;
  await session.detach();
  const emit = proto.emit;
  proto.emit = function (this: unknown, event, ...args) {
    const p = args[0] as
      | { requestId?: string; request?: { url?: string }; dataLength?: number }
      | undefined;
    if (event === "Network.requestWillBeSent" && p?.requestId !== undefined)
      urls.set(p.requestId, p.request?.url ?? "");
    else if (event === "Network.dataReceived" && p?.requestId !== undefined)
      heard.push({
        requestId: p.requestId,
        url: urls.get(p.requestId) ?? "",
        bytes: p.dataLength ?? 0,
        at: performance.now(),
      });
    return emit.call(this, event, ...args);
  };
  watching = true;
}

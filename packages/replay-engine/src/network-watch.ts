import type { CdpSession } from "./types.js";

/** A connection with no data for this long stops counting as "waiting on the server". */
export const IDLE_CONNECTION_MS = 10_000;

export interface NetworkWatch {
  /** Whether the page is waiting on the server right now (the spec's rule). */
  waiting(): boolean;
  /** Connections dropped from the count after IDLE_CONNECTION_MS with no data, in order. */
  ignored(): string[];
  stop(): void;
}

const pathOf = (url: unknown): string => {
  try {
    return new URL(String(url)).pathname;
  } catch {
    return String(url);
  }
};

export async function createNetworkWatch(
  cdp: CdpSession,
  realNow: () => number,
): Promise<NetworkWatch> {
  // lastAt is the start, then the latest data: a connection awaiting its first answer is idle from its start.
  const live = new Map<string, { label: string; lastAt: number }>();
  const idle = new Map<string, string>(); // dropped for silence, may resume
  const dropped: string[] = []; // each label named once
  const id = (p: Record<string, unknown>) => String(p.requestId);
  const begin = (p: Record<string, unknown>, label: string) =>
    live.set(id(p), { label, lastAt: realNow() });
  const name = (label: string) => {
    if (!dropped.includes(label)) dropped.push(label);
  };
  const data = (p: Record<string, unknown>) => {
    const now = realNow();
    const c = live.get(id(p));
    if (c) {
      if (now - c.lastAt > IDLE_CONNECTION_MS) name(c.label);
      c.lastAt = now;
      return;
    }
    const label = idle.get(id(p));
    if (label === undefined) return;
    idle.delete(id(p));
    live.set(id(p), { label, lastAt: now });
  };
  const end = (p: Record<string, unknown>) => {
    live.delete(id(p));
    idle.delete(id(p));
  };

  const offs = [
    cdp.on("Network.requestWillBeSent", (p) => {
      const r = (p.request ?? {}) as Record<string, unknown>;
      begin(p, `${r.method} ${pathOf(r.url)}`);
    }),
    cdp.on("Network.webSocketCreated", (p) =>
      begin(p, `websocket ${pathOf(p.url)}`),
    ),
    ...[
      "Network.responseReceived",
      "Network.dataReceived",
      "Network.eventSourceMessageReceived",
      "Network.webSocketFrameReceived",
    ].map((e) => cdp.on(e, data)),
    ...[
      "Network.loadingFinished",
      "Network.loadingFailed",
      "Network.webSocketClosed",
    ].map((e) => cdp.on(e, end)),
  ];
  const stop = () => {
    for (const off of offs) off();
  };
  try {
    await cdp.send("Network.enable");
  } catch (e) {
    stop();
    throw e;
  }

  const sweep = () => {
    const now = realNow();
    for (const [k, c] of live)
      if (now - c.lastAt > IDLE_CONNECTION_MS) {
        name(c.label);
        idle.set(k, c.label);
        live.delete(k);
      }
  };
  return {
    waiting() {
      sweep();
      return live.size > 0;
    },
    ignored() {
      sweep();
      return [...dropped];
    },
    stop,
  };
}

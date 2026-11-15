import type { CdpSession } from "./types.js";

/** A connection with no data for this long stops counting as "waiting on the server". */
export const IDLE_CONNECTION_MS = 10_000;

export interface NetworkWatch {
  /** Whether the page is waiting on the server right now (the spec's rule). */
  waiting(): boolean;
  /** The connections counted right now, in the order they began. */
  labels(): string[];
  /** Connections dropped from the count after IDLE_CONNECTION_MS with no data, in order. */
  ignored(): string[];
  /** When the page stopped waiting (real ms), while it is not; null while
   *  it is, or before it ever waited. */
  quietSince(): number | null;
  /** The waits heard of after `realMs`, over or not: when the first began
   *  (when the browser sent its request, which its word can trail) and
   *  every connection they counted; null when none was. */
  waitsSince(realMs: number): { from: number; labels: string[] } | null;
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
  let quietAt: number | null = null;
  /** Every wait, in order: when it began, when it was heard of, and the
   *  connections it counted. */
  const waits: { from: number; heard: number; labels: string[] }[] = [];
  const dropped: string[] = []; // each label named once
  const id = (p: Record<string, unknown>) => String(p.requestId);
  const name = (label: string) => {
    if (!dropped.includes(label)) dropped.push(label);
  };
  const sweep = () => {
    const now = realNow();
    for (const [k, c] of live)
      if (now - c.lastAt > IDLE_CONNECTION_MS) {
        name(c.label);
        idle.set(k, c.label);
        live.delete(k);
        if (live.size === 0) quietAt = c.lastAt + IDLE_CONNECTION_MS;
      }
  };
  const count = (
    p: Record<string, unknown>,
    label: string,
    now: number,
    sent = now,
  ) => {
    // A connection gone silent first, or a new wait takes its start.
    sweep();
    if (live.size === 0 || waits.length === 0)
      waits.push({ from: sent, heard: now, labels: [] });
    const last = waits[waits.length - 1] as (typeof waits)[number];
    if (!last.labels.includes(label)) last.labels.push(label);
    live.set(id(p), { label, lastAt: now });
  };
  // Dated by when the browser sent it: its word can come after the walk's
  // next grant (CI ubuntu, 2026-11-15: a cross-site click's request, heard
  // a frame late, counted that frame as held).
  const begin = (p: Record<string, unknown>, label: string) => {
    const now = realNow();
    const wall = typeof p.wallTime === "number" ? p.wallTime * 1000 : now;
    count(p, label, now, Math.min(now, wall));
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
    count(p, label, now);
  };
  const end = (p: Record<string, unknown>) => {
    const was = live.size;
    live.delete(id(p));
    idle.delete(id(p));
    if (was > 0 && live.size === 0) quietAt = realNow();
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

  return {
    waiting() {
      sweep();
      return live.size > 0;
    },
    labels() {
      sweep();
      return [...live.values()].map((c) => c.label);
    },
    ignored() {
      sweep();
      return [...dropped];
    },
    quietSince() {
      sweep();
      return live.size > 0 ? null : quietAt;
    },
    waitsSince(realMs) {
      sweep();
      const since = waits.filter((w) => w.heard > realMs);
      const first = since[0];
      if (first === undefined) return null;
      return {
        from: Math.min(...since.map((w) => w.from)),
        labels: [...new Set(since.flatMap((w) => w.labels))],
      };
    },
    stop,
  };
}

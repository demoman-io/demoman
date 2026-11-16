import type { CdpSession } from "./types.js";

/** A connection with no data for this long stops counting as "waiting on the server". */
export const IDLE_CONNECTION_MS = 10_000;

export interface NetworkWatch {
  /** Whether the page is waiting on the server right now (the spec's rule). */
  waiting(): boolean;
  /** The connections counted right now, in the order they began. */
  labels(): string[];
  /** Connections not counted, in order: dropped after IDLE_CONNECTION_MS
   *  with no data. */
  ignored(): string[];
  /** When the page stopped waiting (real ms), while it is not; null while
   *  it is, or before it ever waited. */
  quietSince(): number | null;
  /** The waits heard of after `realMs`, over or not: when the first began
   *  (when the browser sent its request, which its word can trail) and
   *  every connection they counted; null when none was. */
  waitsSince(realMs: number): { from: number; labels: string[] } | null;
  /** Whether a document's request is open. */
  loading(): boolean;
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
  /** A frame's document request, by frame: the one a swap ends. */
  const documents = new Map<string, string>();
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
  // A document's request is dated by when the browser sent it: its word can
  // come after the walk's next grant (CI ubuntu, 2026-11-15: a cross-site
  // click's request, heard a frame late, counted that frame as held). Only a
  // document's: the browser stamps it in real time, but a page's own fetch
  // is stamped by the page, on its held clock (measured 2026-11-15,
  // apps/runner/compare/held-probe-walltime.mjs: a fetch 10 h behind real
  // time under a pin 10 h ago, a document within 2 ms; CI run 3 recorded a
  // 10.5 h stretch from it).
  const begin = (p: Record<string, unknown>, label: string) => {
    const now = realNow();
    if (p.type === "Document" && typeof p.frameId === "string")
      documents.set(p.frameId, id(p));
    const wall =
      p.type === "Document" && typeof p.wallTime === "number"
        ? p.wallTime * 1000
        : now;
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
      // An EventSource is never a wait, as a websocket is not (below): it
      // is a subscription, open for as long as the page is, and what
      // arrives on it is pushed. Counted, one that sent every 3 s made a
      // 5 s video 72 s, and one that sent once cost 10 s and a note
      // (measured 2026-11-16, compare/held-push.sh; the author's ruling).
      // The walk's own request watch never counted one (`requests.ts`).
      // shortcut: a reply streamed over an EventSource lands where the
      // machine puts it, unsaid; upgrade if an app shows it.
      if (p.type === "EventSource") return;
      const r = (p.request ?? {}) as Record<string, unknown>;
      begin(p, `${r.method} ${pathOf(r.url)}`);
    }),
    // A websocket is never a wait, and none is listened for: what arrives
    // on one is pushed, not an answer the page asked for, and it stays open.
    // A dev server's hot-reload socket sends on every request, which kept
    // each wait open 10 s past its last request (traced 2026-11-15, Chatbot
    // sample). A rule, not a loss, so nothing says it: named as ignored, it
    // made every run of an app under a dev server a degraded one, which
    // refresh records twice (review of 2026-11-16).
    // shortcut: a reply streamed over a websocket is not server time, so its
    // words land where the machine puts them, unsaid; upgrade if an app
    // shows it.
    // A frame of another site moves to that site's process as its document
    // answers, and the rest of its load is said to that process, not here:
    // this session hears the swap and never the request's end, so the wait
    // stood until the idle cut-off (a 10 s opening wait on every page with
    // such a frame; traced 2026-11-16). The swap is the answer arriving.
    // What the frame then asks for is its own process's, and goes unseen.
    cdp.on("Page.frameDetached", (p) => {
      const request = documents.get(String(p.frameId));
      if (p.reason === "swap" && request !== undefined)
        end({ requestId: request });
    }),
    ...["Network.responseReceived", "Network.dataReceived"].map((e) =>
      cdp.on(e, data),
    ),
    ...["Network.loadingFinished", "Network.loadingFailed"].map((e) =>
      cdp.on(e, end),
    ),
  ];
  const stop = () => {
    for (const off of offs) off();
  };
  try {
    await cdp.send("Page.enable"); // for the swap above
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
    loading() {
      sweep();
      const open = new Set(documents.values());
      return [...live.keys()].some((k) => open.has(k));
    },
    stop,
  };
}

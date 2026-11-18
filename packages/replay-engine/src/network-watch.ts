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
  /** The waits heard of after `realMs`, or sent at or after `pageMs` on the
   *  page's clock, over or not: when the first began (when the browser sent
   *  its request, which its word can trail), when on the page's clock if
   *  every one is the page's own request, and every connection they
   *  counted; null when none was. */
  waitsSince(
    realMs: number,
    pageMs?: number,
  ): { from: number; page?: number; labels: string[] } | null;
  /** Whether the top frame's document request is open (DEM-203). */
  loading(): boolean;
  /** The connections counted now are ones the recording followed: data on
   *  one of them later is an answer the script once waited on. */
  follow(): void;
  /** When data last arrived on a connection the recording followed (real
   *  ms); null when none has. */
  followedDataAt(): number | null;
  /** The wait's window for every answer above until the next call: only
   *  requests opened at or after `since` on the page's clock count (null:
   *  every one). A request older than the wait is not followed by it
   *  (DEM-204, DEM-202). */
  window(since: number | null): void;
  /** When data last arrived on a connection the recording followed while it
   *  was outside the window; null when none has. */
  outsideDataAt(): number | null;
  /** The walk's settle: requests counted and open that opened at or after
   *  `since` on the page's clock (every one when left out), whatever the
   *  window. */
  inFlight(since?: number): number;
  /** True once none opened at or after `since` is open; false when the
   *  page's clock reaches `deadlineMs` first. */
  idle(
    deadlineMs: number,
    sleep: (ms: number) => Promise<void>,
    since?: number,
  ): Promise<boolean>;
  /** Requests counted and open that opened before `since`: what a step's
   *  settle leaves out (`requestNotWaited`). */
  openedBefore(since: number): number;
  /** Stops listening and turns the Network domain off again. */
  stop(): void;
}

const pathOf = (url: unknown): string => {
  try {
    return new URL(String(url)).pathname;
  } catch {
    return String(url);
  }
};

/** What is never the page waiting on its server: a subscription (what
 *  arrives on it is pushed, and it stays open) and media (a video's download
 *  runs as long as it plays). Everything else the top frame asks for is
 *  (DEM-202, the author's ruling of 2026-11-17). */
const NEVER = new Set(["WebSocket", "EventSource", "Media"]);
const POLL_MS = 25;

/** The page's clock, which windows are on. */
export interface NetworkWatchClocks {
  /** The page's clock (`clock.now()` ms). Default: `realNow`. */
  pageNow?: () => number;
  /** A Fetch's or XHR's `wallTime` (ms) on the page's clock: held only,
   *  where the page stamps them on its held clock (DEM-206). */
  pageOfWall?: (wallMs: number) => number;
}

export async function createNetworkWatch(
  cdp: CdpSession,
  realNow: () => number,
  clocks: NetworkWatchClocks = {},
): Promise<NetworkWatch> {
  const pageNow = clocks.pageNow ?? realNow;
  const { pageOfWall } = clocks;
  // lastAt is the start, then the latest data: a connection awaiting its first answer is idle from its start.
  // page: when it opened on the page's clock; seq: the order it opened in.
  type Entry = {
    label: string;
    lastAt: number;
    page: number;
    seq: number;
    frame?: string;
    followed?: true;
  };
  const live = new Map<string, Entry>();
  let seq = 0;
  let followedDataAt: number | null = null;
  let since = Number.NEGATIVE_INFINITY;
  let outsideDataAt: number | null = null;
  /** The top frame's id; null until known, when every frame counts. */
  let topId: string | null = null;
  /** The live connections that count: those in the window. */
  const counted = () => [...live].filter(([, c]) => c.page >= since);
  /** Dropped for silence, kept whole: one that resumes is the request it
   *  was, opened when it first did (review of DEM-202, finding 1). */
  const idle = new Map<string, Entry>();
  let quietAt: number | null = null;
  /** Every wait, in order: when it began, when it was heard of, and the
   *  connections it counted. */
  const waits: {
    from: number;
    heard: number;
    page?: number;
    labels: string[];
  }[] = [];
  const dropped: string[] = []; // each label named once
  /** The top frame's latest document request: its id and order. */
  let document: { id: string; seq: number } | null = null;
  const id = (p: Record<string, unknown>) => String(p.requestId);
  const name = (label: string) => {
    if (!dropped.includes(label)) dropped.push(label);
  };
  const sweep = () => {
    const now = realNow();
    for (const [k, c] of live)
      if (now - c.lastAt > IDLE_CONNECTION_MS) {
        name(c.label);
        idle.set(k, c);
        live.delete(k);
        if (counted().length === 0) quietAt = c.lastAt + IDLE_CONNECTION_MS;
      }
  };
  const count = (
    p: Record<string, unknown>,
    label: string,
    now: number,
    opened: Omit<Entry, "label" | "lastAt">,
    sent = now,
    page?: number,
  ) => {
    // A connection gone silent first, or a new wait takes its start.
    sweep();
    if (counted().length === 0 || waits.length === 0)
      waits.push({ from: sent, heard: now, page, labels: [] });
    const last = waits[waits.length - 1] as (typeof waits)[number];
    if (!last.labels.includes(label)) last.labels.push(label);
    live.set(id(p), { label, lastAt: now, ...opened });
  };
  const isTop = (frame: unknown) =>
    topId === null || frame === undefined || frame === topId;
  // A document's request is dated by when the browser sent it: its word can
  // come after the walk's next grant (CI ubuntu, 2026-11-15: a cross-site
  // click's request, heard a frame late, counted that frame as held). Only a
  // document's: the browser stamps it in real time, but a page's own fetch
  // is stamped by the page, on its held clock (measured 2026-11-15,
  // apps/runner/compare/held-probe-walltime.mjs: a fetch 10 h behind real
  // time under a pin 10 h ago, a document within 2 ms; CI run 3 recorded a
  // 10.5 h stretch from it). A fetch's or XHR's page time is kept: it says
  // where the page stood when it sent the request, whichever side of a look
  // its word lands (DEM-206; both within 0.01 ms of the held time, measured
  // 2026-11-17). Only those two: a request the browser makes itself (a
  // preflight) may be stamped in real time, unmeasured.
  // A request's window is placed on the page's clock the same way: its
  // `wallTime` for a fetch or XHR, held; otherwise when it is heard.
  const begin = (p: Record<string, unknown>, label: string) => {
    const now = realNow();
    // A redirect reuses its id: one request, opened when it first did.
    const known = live.get(id(p));
    if (known !== undefined) {
      known.lastAt = now;
      return;
    }
    if (resume(p, now)) return;
    const wall = typeof p.wallTime === "number" ? p.wallTime * 1000 : null;
    const own = p.type === "Fetch" || p.type === "XHR";
    const opened = {
      page:
        own && wall !== null && pageOfWall !== undefined
          ? pageOfWall(wall)
          : pageNow(),
      seq: seq++,
      ...(typeof p.frameId === "string" && { frame: p.frameId }),
    };
    if (p.type === "Document") {
      document = { id: id(p), seq: opened.seq };
      count(p, label, now, opened, Math.min(now, wall ?? now));
    } else if (own)
      count(
        p,
        label,
        now,
        opened,
        now,
        wall === null ? undefined : (pageOfWall?.(wall) ?? wall),
      );
    else count(p, label, now, opened);
  };
  const data = (p: Record<string, unknown>) => {
    const now = realNow();
    const c = live.get(id(p));
    if (c) {
      if (now - c.lastAt > IDLE_CONNECTION_MS) name(c.label);
      c.lastAt = now;
      if (c.followed) followedDataAt = now;
      if (c.followed && c.page < since) outsideDataAt = now;
      return;
    }
    resume(p, now);
  };
  /** A request dropped for silence heard from again counts again. */
  function resume(p: Record<string, unknown>, now: number): boolean {
    const { label, lastAt: _, ...opened } = idle.get(id(p)) ?? {};
    if (label === undefined) return false;
    idle.delete(id(p));
    count(p, label, now, opened as Omit<Entry, "label" | "lastAt">);
    return true;
  }
  const forget = (
    gone: (k: string, c: { seq: number; frame?: string }) => boolean,
  ) => {
    const was = counted().length;
    for (const [k, c] of live) if (gone(k, c)) live.delete(k);
    for (const [k, c] of idle) if (gone(k, c)) idle.delete(k);
    if (was > 0 && counted().length === 0) quietAt = realNow();
  };
  const end = (p: Record<string, unknown>) => forget((k) => k === id(p));
  const inFlight = (from = Number.NEGATIVE_INFINITY) => {
    sweep();
    return [...live.values()].filter((c) => c.page >= from).length;
  };

  const offs = [
    cdp.on("Network.requestWillBeSent", (p) => {
      // An EventSource or a websocket was measured (2026-11-16,
      // compare/held-push.sh): counted, one that sent every 3 s made a 5 s
      // video 72 s. A websocket is never heard here at all (no request is
      // sent for one): a dev server's hot-reload socket sends on every
      // request, and counted it kept each wait open 10 s past its last
      // request (Chatbot, 2026-11-15). A video's download froze a held
      // video's step settle 8 s (DEM-207). A rule, not a loss, so nothing
      // says it.
      // shortcut: a reply streamed over a websocket or an EventSource lands
      // where the machine puts it, unsaid; upgrade if an app shows it.
      // An iframe's requests are its own document's business (DEM-203): a
      // slow widget would hold the top page's every settle. A frame of
      // another site is its own process already, unseen here.
      if (NEVER.has(String(p.type)) || !isTop(p.frameId)) return;
      const r = (p.request ?? {}) as Record<string, unknown>;
      begin(p, `${r.method} ${pathOf(r.url)}`);
    }),
    // A new top document: what the old one asked for died with it, and
    // Chrome does not always say so with `loadingFailed`; its own request
    // runs on until its last byte.
    cdp.on("Page.frameNavigated", (p) => {
      const frame = p.frame as { id?: string; parentId?: string } | undefined;
      if (frame?.id === undefined || frame.parentId !== undefined) return;
      topId = frame.id;
      const from = document?.seq ?? Number.POSITIVE_INFINITY;
      forget((_, c) => c.seq < from);
    }),
    // A frame removed from the page, or swapped to another site's process
    // (which this session never hears the end of): its requests went with
    // it. Counted only before the top frame is known.
    cdp.on("Page.frameDetached", (p) =>
      forget((_, c) => c.frame !== undefined && c.frame === p.frameId),
    ),
    ...["Network.responseReceived", "Network.dataReceived"].map((e) =>
      cdp.on(e, data),
    ),
    ...["Network.loadingFinished", "Network.loadingFailed"].map((e) =>
      cdp.on(e, end),
    ),
  ];
  const unlisten = () => {
    for (const off of offs) off();
  };
  try {
    await cdp.send("Page.enable"); // for the frames above
    // Without buffer sizes, as the held clock's watch always enabled it:
    // enabled with no buffers instead, Chatbot asked for a lazily loaded
    // script after the opening in 4 of 24 held recordings against 0 of 40
    // (measured 2026-11-17; why not traced), and the video began 8 frames
    // early.
    await cdp.send("Network.enable");
    const tree = (await cdp.send("Page.getFrameTree")) as {
      frameTree?: { frame?: { id?: string } };
    };
    topId ??= tree.frameTree?.frame?.id ?? null;
  } catch (e) {
    unlisten();
    throw e;
  }

  return {
    waiting() {
      sweep();
      return counted().length > 0;
    },
    labels() {
      sweep();
      return counted().map(([, c]) => c.label);
    },
    ignored() {
      sweep();
      return [...dropped];
    },
    quietSince() {
      sweep();
      return counted().length > 0 ? null : quietAt;
    },
    waitsSince(realMs, pageMs = Number.POSITIVE_INFINITY) {
      sweep();
      const since = waits.filter(
        (w) =>
          w.heard > realMs || (w.page ?? Number.NEGATIVE_INFINITY) >= pageMs,
      );
      const first = since[0];
      if (first === undefined) return null;
      const pages = since.flatMap((w) =>
        w.page === undefined ? [] : [w.page],
      );
      return {
        from: Math.min(...since.map((w) => w.from)),
        ...(pages.length === since.length && { page: Math.min(...pages) }),
        labels: [...new Set(since.flatMap((w) => w.labels))],
      };
    },
    loading() {
      sweep();
      return document !== null && live.has(document.id);
    },
    follow() {
      for (const [, c] of counted()) c.followed = true;
    },
    followedDataAt: () => followedDataAt,
    window(from) {
      since = from ?? Number.NEGATIVE_INFINITY;
    },
    outsideDataAt: () => outsideDataAt,
    inFlight,
    async idle(deadlineMs, sleep, from) {
      while (inFlight(from) > 0) {
        if (pageNow() >= deadlineMs) return false;
        await sleep(POLL_MS);
      }
      return true;
    },
    openedBefore(from) {
      sweep();
      return [...live.values()].filter((c) => c.page < from).length;
    },
    stop() {
      unlisten();
      // Swallowed on purpose: at teardown the session is often already
      // closed, and nothing is left that reads the domain.
      void cdp.send("Network.disable").catch(() => undefined);
    },
  };
}

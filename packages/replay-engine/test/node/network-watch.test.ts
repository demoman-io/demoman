import { describe, expect, it } from "vitest";
import { createNetworkWatch } from "../../src/index.js";
import type { CdpSession } from "../../src/types.js";

/** `top`: the top frame's id `Page.getFrameTree` answers (null: none). */
function setup(top: string | null = "top") {
  const handlers = new Map<string, Set<(p: Record<string, unknown>) => void>>();
  const sent: string[] = [];
  const cdp: CdpSession = {
    async send(method) {
      sent.push(method);
      return method === "Page.getFrameTree" && top !== null
        ? { frameTree: { frame: { id: top } } }
        : {};
    },
    on(event, handler) {
      const set = handlers.get(event) ?? new Set();
      set.add(handler);
      handlers.set(event, set);
      return () => set.delete(handler);
    },
    async detach() {},
  };
  const emit = (event: string, params: Record<string, unknown>) => {
    for (const h of handlers.get(event) ?? []) h(params);
  };
  const listeners = () =>
    [...handlers.values()].reduce((n, s) => n + s.size, 0);
  return { cdp, emit, sent, listeners };
}

const start = (id: string, url = "http://app.test/poll?x=1") => ({
  requestId: id,
  request: { method: "GET", url },
});

describe("createNetworkWatch", () => {
  // A label reaches the run report: a record's id in a path must not.
  it("names a request by its scrubbed address", async () => {
    const { cdp, emit } = setup();
    const w = await createNetworkWatch(cdp, () => 0, {
      scrubUrl: (url) => url.replace(/\/orders\/\w+/, "/orders/redacted"),
    });
    emit(
      "Network.requestWillBeSent",
      start("1", "http://app.test/orders/507f1f77bcf86cd799439011?x=1"),
    );
    expect(w.labels()).toEqual(["GET /orders/redacted"]);
  });

  it("is waiting from a request's start until it finishes", async () => {
    const { cdp, emit, sent } = setup();
    const w = await createNetworkWatch(cdp, () => 0);
    expect(sent).toContain("Network.enable");
    expect(w.waiting()).toBe(false);
    emit("Network.requestWillBeSent", start("1"));
    expect(w.waiting()).toBe(true);
    emit("Network.loadingFinished", { requestId: "1" });
    expect(w.waiting()).toBe(false);
  });

  // An answer landing in a pause is said only for a connection the
  // recording followed. Red if data on any connection counts.
  it("says when data last arrived on a connection the recording followed", async () => {
    const { cdp, emit } = setup();
    let now = 0;
    const w = await createNetworkWatch(cdp, () => now);
    emit("Network.requestWillBeSent", start("1"));
    now = 10;
    emit("Network.dataReceived", { requestId: "1" });
    expect(w.followedDataAt()).toBeNull();
    w.follow();
    emit("Network.requestWillBeSent", start("2"));
    now = 20;
    emit("Network.dataReceived", { requestId: "2" });
    expect(w.followedDataAt()).toBeNull();
    now = 30;
    emit("Network.dataReceived", { requestId: "1" });
    expect(w.followedDataAt()).toBe(30);
  });

  // A page's fetch heard before a look is still one since it, by
  // the page's clock. Red if real time alone decides.
  it("finds a page's own request by when the page sent it", async () => {
    const { cdp, emit } = setup();
    let now = 100;
    const w = await createNetworkWatch(cdp, () => now);
    emit("Network.requestWillBeSent", {
      ...start("1"),
      type: "Fetch",
      wallTime: 5.05,
    });
    expect(w.waitsSince(100, 5000)).toEqual({
      from: 100,
      page: 5050,
      labels: ["GET /poll"],
    });
    expect(w.waitsSince(100, 5051)).toBeNull();
    expect(w.waitsSince(100)).toBeNull();
    // A document's or a script's time is not the page's to say.
    emit("Network.loadingFinished", { requestId: "1" });
    now = 200;
    emit("Network.requestWillBeSent", {
      ...start("2", "http://app.test/x.js"),
      type: "Script",
      wallTime: 5.1,
    });
    expect(w.waitsSince(200, 5000)).toEqual({
      from: 100,
      page: 5050,
      labels: ["GET /poll"],
    });
    expect(w.waitsSince(150, 5051)).toEqual({
      from: 200,
      labels: ["GET /x.js"],
    });
  });

  // Session A, 2026-11-16: the walk's held loops ask this, not the
  // browser's load events. Red if another request counts as a document's.
  it("says whether a document's request is open", async () => {
    const { cdp, emit } = setup();
    const w = await createNetworkWatch(cdp, () => 0);
    emit("Network.requestWillBeSent", start("2"));
    expect(w.loading()).toBe(false);
    emit("Network.requestWillBeSent", {
      ...start("1", "http://app.test/there"),
      type: "Document",
      frameId: "top",
    });
    expect(w.loading()).toBe(true);
    emit("Network.loadingFinished", { requestId: "1" });
    expect(w.loading()).toBe(false);
    expect(w.waiting()).toBe(true); // premise: "2" is still open
  });

  // Fix round 1, finding 3: when the page stopped waiting, for a stretch
  // that ended while the held clock was taking a frame.
  it("says when the page stopped waiting", async () => {
    const { cdp, emit } = setup();
    let now = 0;
    const w = await createNetworkWatch(cdp, () => now);
    expect(w.quietSince()).toBeNull();
    emit("Network.requestWillBeSent", start("1"));
    emit("Network.requestWillBeSent", start("2"));
    now = 150;
    emit("Network.loadingFinished", { requestId: "1" });
    expect(w.quietSince()).toBeNull(); // premise: "2" still open
    now = 210;
    emit("Network.loadingFailed", { requestId: "2" });
    now = 400;
    expect(w.quietSince()).toBe(210);
  });

  it("says the waits since a time, also those over, from the first one's start", async () => {
    const { cdp, emit } = setup();
    let now = 0;
    const w = await createNetworkWatch(cdp, () => now);
    expect(w.waitsSince(0)).toBeNull();
    now = 100;
    emit("Network.requestWillBeSent", start("1", "http://app.test/a"));
    now = 150;
    emit("Network.requestWillBeSent", start("2", "http://app.test/b"));
    emit("Network.loadingFinished", { requestId: "1" });
    expect(w.waiting()).toBe(true); // premise: "2" still open: one wait
    expect(w.waitsSince(50)).toEqual({
      from: 100,
      labels: ["GET /a", "GET /b"],
    });
    emit("Network.loadingFinished", { requestId: "2" });
    expect(w.waiting()).toBe(false);
    now = 300;
    emit("Network.requestWillBeSent", start("3", "http://app.test/c"));
    // Both waits since 50, though the first is over; only the second since 200.
    expect(w.waitsSince(50)).toEqual({
      from: 100,
      labels: ["GET /a", "GET /b", "GET /c"],
    });
    expect(w.waitsSince(200)).toEqual({ from: 300, labels: ["GET /c"] });
    expect(w.waitsSince(300)).toBeNull();
  });

  // Review of Task 9 round 1 (CI ubuntu): a request's word can come late;
  // its wait began when the browser sent it.
  it("dates a wait by when the browser sent its request, found by when it was heard", async () => {
    const { cdp, emit } = setup();
    let now = 0;
    const w = await createNetworkWatch(cdp, () => now);
    now = 1450;
    emit("Network.requestWillBeSent", {
      ...start("1", "http://app.test/there"),
      type: "Document",
      wallTime: 1.3, // sent at 1300, heard at 1450
    });
    expect(w.waitsSince(1400)).toEqual({ from: 1300, labels: ["GET /there"] });
    expect(w.waitsSince(1450)).toBeNull();
  });

  // Review of Task 9 round 2, finding 1: a page's own fetch is stamped on
  // its held clock (10 h behind real time under a pin 10 h ago, measured).
  it("dates a page's own request by when it was heard", async () => {
    const { cdp, emit } = setup();
    let now = 0;
    const w = await createNetworkWatch(cdp, () => now);
    now = 36_000_000;
    emit("Network.requestWillBeSent", {
      ...start("1", "http://app.test/answer"),
      type: "Fetch",
      wallTime: 0.333, // the page's held clock
    });
    expect(w.waitsSince(0)).toEqual({
      from: 36_000_000,
      page: 333,
      labels: ["GET /answer"],
    });
  });

  // Review of Task 9, M4: a connection gone quiet is dropped before a new
  // wait is dated, or the new wait takes the old one's start.
  it("dates a new wait after a silent connection, from its own start", async () => {
    const { cdp, emit } = setup();
    let now = 0;
    const w = await createNetworkWatch(cdp, () => now);
    emit("Network.requestWillBeSent", start("1", "http://app.test/poll"));
    now = 20_000; // "1" silent past the cut-off, and nobody asked since
    emit("Network.requestWillBeSent", start("2", "http://app.test/next"));
    expect(w.waitsSince(10_000)).toEqual({
      from: 20_000,
      labels: ["GET /next"],
    });
  });

  it("keeps waiting while a stream's data arrives", async () => {
    const { cdp, emit } = setup();
    let now = 0;
    const w = await createNetworkWatch(cdp, () => now);
    emit("Network.requestWillBeSent", start("1"));
    for (let s = 1; s <= 30; s++) {
      now = s * 1000;
      emit("Network.dataReceived", { requestId: "1" });
      expect(w.waiting()).toBe(true);
    }
    expect(w.ignored()).toEqual([]);
    emit("Network.loadingFinished", { requestId: "1" });
    expect(w.waiting()).toBe(false);
  });

  it("drops a connection with no data for 10 s and names it", async () => {
    const { cdp, emit } = setup();
    let now = 0;
    const w = await createNetworkWatch(cdp, () => now);
    emit("Network.requestWillBeSent", start("1"));
    now = 10_000;
    expect(w.waiting()).toBe(true);
    now = 10_001;
    expect(w.waiting()).toBe(false);
    expect(w.ignored()).toEqual(["GET /poll"]);
  });

  // The author's ruling, 2026-11-16 (measured: compare/held-push.sh). Red
  // if an EventSource is a wait again, or named as dropped.
  it("never counts an EventSource, whatever arrives on it, nor says it was ignored", async () => {
    const { cdp, emit } = setup();
    let now = 0;
    const w = await createNetworkWatch(cdp, () => now);
    emit("Network.requestWillBeSent", {
      ...start("e", "http://app.test/events"),
      type: "EventSource",
    });
    emit("Network.responseReceived", { requestId: "e" });
    emit("Network.dataReceived", { requestId: "e" });
    expect(w.waiting()).toBe(false);
    expect(w.waitsSince(-1)).toBeNull();
    now = 20_000;
    expect(w.ignored()).toEqual([]);
    // premise: a request beside it still counts
    emit("Network.requestWillBeSent", { ...start("1"), type: "Fetch" });
    expect(w.waiting()).toBe(true);
  });

  it("never counts a websocket, whatever arrives on it, nor says it was ignored", async () => {
    // A dev server's hot-reload socket sends on every request and never
    // closes: counted, each server wait ran 10 s past its last request
    // (traced 2026-11-15 on the Chatbot sample).
    const { cdp, emit } = setup();
    let now = 0;
    const w = await createNetworkWatch(cdp, () => now);
    emit("Network.webSocketCreated", {
      requestId: "w",
      url: "ws://app.test/hmr",
    });
    expect(w.waiting()).toBe(false);
    now = 1000;
    emit("Network.webSocketFrameReceived", { requestId: "w" });
    expect(w.waiting()).toBe(false);
    expect(w.waitsSince(-1)).toBeNull();
    // Not a degradation: every app under a dev server has one (hot reload).
    now = 20_000;
    expect(w.ignored()).toEqual([]);
    // premise: a request beside it still counts
    emit("Network.requestWillBeSent", start("1"));
    expect(w.waiting()).toBe(true);
    expect(w.labels()).toEqual(["GET /poll"]);
  });

  // One rule for both the settle and the held clock.
  it("never counts a websocket, an EventSource or media", async () => {
    const { cdp, emit } = setup();
    const w = await createNetworkWatch(cdp, () => 0);
    for (const [id, type] of [
      ["w", "WebSocket"],
      ["e", "EventSource"],
      ["m", "Media"],
    ] as const)
      emit("Network.requestWillBeSent", { ...start(id), type, frameId: "top" });
    expect(w.waiting()).toBe(false);
    expect(w.inFlight()).toBe(0);
    // premise: an image beside them counts
    emit("Network.requestWillBeSent", { ...start("i"), type: "Image" });
    expect(w.inFlight()).toBe(1);
  });

  it("counts only the top frame's requests", async () => {
    const { cdp, emit } = setup();
    const w = await createNetworkWatch(cdp, () => 0);
    emit("Network.requestWillBeSent", {
      ...start("c"),
      type: "Image",
      frameId: "child",
    });
    expect(w.waiting()).toBe(false);
    expect(w.inFlight()).toBe(0);
    emit("Network.requestWillBeSent", {
      ...start("t"),
      type: "Image",
      frameId: "top",
    });
    expect(w.waiting()).toBe(true);
  });

  it("learns the top frame from a navigation without a parent", async () => {
    const { cdp, emit } = setup(null);
    const w = await createNetworkWatch(cdp, () => 0);
    // Unknown: every frame counts.
    emit("Network.requestWillBeSent", { ...start("a"), frameId: "child" });
    expect(w.inFlight()).toBe(1);
    emit("Page.frameNavigated", { frame: { id: "T" } });
    emit("Network.requestWillBeSent", { ...start("b"), frameId: "child" });
    emit("Network.requestWillBeSent", { ...start("c"), frameId: "T" });
    expect(w.labels()).toEqual(["GET /poll"]); // only "c": "a" died with the old document
    expect(w.inFlight()).toBe(1);
  });

  // An iframe's document is never the page loading.
  it("says loading only for the top frame's document", async () => {
    const { cdp, emit } = setup();
    const w = await createNetworkWatch(cdp, () => 0);
    emit("Network.requestWillBeSent", {
      ...start("c", "http://app.test/frame"),
      type: "Document",
      frameId: "child",
    });
    expect(w.loading()).toBe(false);
    emit("Network.requestWillBeSent", {
      ...start("t", "http://app.test/there"),
      type: "Document",
      frameId: "top",
    });
    expect(w.loading()).toBe(true);
  });

  it("counts a request with no frame as the top frame's", async () => {
    const { cdp, emit } = setup();
    const w = await createNetworkWatch(cdp, () => 0);
    emit("Network.requestWillBeSent", { ...start("1"), type: "Fetch" });
    expect(w.inFlight()).toBe(1);
    expect(w.waiting()).toBe(true);
  });

  it("keeps a redirect's first opening", async () => {
    const { cdp, emit } = setup();
    let page = 100;
    const w = await createNetworkWatch(cdp, () => 0, { pageNow: () => page });
    emit("Network.requestWillBeSent", { ...start("1"), type: "Image" });
    page = 200;
    emit("Network.requestWillBeSent", { ...start("1"), type: "Image" });
    expect(w.inFlight(150)).toBe(0);
    expect(w.inFlight(100)).toBe(1);
  });

  it("stamps a fetch by its page time and anything else when heard", async () => {
    const { cdp, emit } = setup();
    const page = 900;
    const w = await createNetworkWatch(cdp, () => 0, {
      pageNow: () => page,
      pageOfWall: (wall) => wall - 5000,
    });
    emit("Network.requestWillBeSent", {
      ...start("f"),
      type: "Fetch",
      wallTime: 5.4,
    });
    expect(w.inFlight(400)).toBe(1);
    expect(w.inFlight(401)).toBe(0);
    emit("Network.requestWillBeSent", {
      ...start("i"),
      type: "Image",
      wallTime: 5.4,
    });
    expect(w.inFlight(900)).toBe(1);
    // The held clock's waits are on the page's clock too.
    expect(w.waitsSince(1, 400)?.page).toBe(400);
  });

  it("follows only what the window holds", async () => {
    const { cdp, emit } = setup();
    let page = 0;
    const w = await createNetworkWatch(cdp, () => 0, { pageNow: () => page });
    emit("Network.requestWillBeSent", start("old", "http://app.test/old"));
    page = 7000;
    emit("Network.requestWillBeSent", start("new", "http://app.test/new"));
    w.window(1000);
    expect(w.labels()).toEqual(["GET /new"]);
    expect(w.inFlight()).toBe(2); // the window is the clock's, not the settle's
    w.window(null);
    expect(w.labels()).toEqual(["GET /old", "GET /new"]);
  });

  it("says data on a followed request outside the window", async () => {
    const { cdp, emit } = setup();
    let page = 0;
    let now = 0;
    const w = await createNetworkWatch(cdp, () => now, {
      pageNow: () => page,
    });
    emit("Network.requestWillBeSent", start("old", "http://app.test/old"));
    page = 7000;
    emit("Network.requestWillBeSent", start("new", "http://app.test/new"));
    w.follow();
    w.window(1000);
    now = 20;
    emit("Network.dataReceived", { requestId: "new" });
    expect(w.outsideDataAt()).toBeNull();
    now = 30;
    emit("Network.dataReceived", { requestId: "old" });
    expect(w.outsideDataAt()).toBe(30);
  });

  // Review Focus 1: a navigation's server wait lasts until its document
  // has answered, not only until it commits.
  it("keeps the committing document's request open", async () => {
    const { cdp, emit } = setup();
    const w = await createNetworkWatch(cdp, () => 0);
    emit("Network.requestWillBeSent", { ...start("f"), type: "Fetch" });
    emit("Network.requestWillBeSent", {
      ...start("d", "http://app.test/there"),
      type: "Document",
      frameId: "top",
    });
    emit("Page.frameNavigated", { frame: { id: "top" } });
    expect(w.inFlight()).toBe(1);
    expect(w.labels()).toEqual(["GET /there"]);
    expect(w.loading()).toBe(true);
    emit("Network.loadingFinished", { requestId: "d" });
    expect(w.loading()).toBe(false);
    expect(w.waiting()).toBe(false);
  });

  it("forgets a detached frame's requests", async () => {
    const { cdp, emit } = setup(null);
    const w = await createNetworkWatch(cdp, () => 0);
    emit("Network.requestWillBeSent", { ...start("a"), frameId: "F" });
    emit("Network.requestWillBeSent", { ...start("b"), frameId: "G" });
    emit("Page.frameDetached", { frameId: "F", reason: "swap" });
    expect(w.inFlight()).toBe(1);
  });

  it("answers idle false at the deadline", async () => {
    const { cdp, emit } = setup();
    let page = 0;
    const w = await createNetworkWatch(cdp, () => 0, { pageNow: () => page });
    const sleep = async (ms: number) => {
      page += ms;
    };
    emit("Network.requestWillBeSent", start("1"));
    expect(await w.idle(50, sleep)).toBe(false);
    expect(page).toBeGreaterThanOrEqual(50);
    // Only those opened since count.
    expect(await w.idle(1000, sleep, 1)).toBe(true);
    emit("Network.loadingFinished", { requestId: "1" });
    expect(await w.idle(page + 50, sleep)).toBe(true);
  });

  // A request quiet past the cut-off that
  // speaks again is the request it was, opened when it first did. Red if
  // it is stamped anew and so falls inside a later wait's window.
  it("keeps a resumed connection's first opening", async () => {
    const { cdp, emit } = setup();
    let page = 0;
    let now = 0;
    const w = await createNetworkWatch(cdp, () => now, {
      pageNow: () => page,
    });
    emit("Network.requestWillBeSent", start("1"));
    now = 10_001;
    page = 20_000;
    expect(w.inFlight()).toBe(0); // premise: dropped for silence
    emit("Network.dataReceived", { requestId: "1" });
    expect(w.inFlight()).toBe(1);
    expect(w.inFlight(14_000)).toBe(0);
    // A redirect of a dropped request too.
    emit("Network.requestWillBeSent", start("2"));
    now = 20_002;
    page = 40_000;
    expect(w.inFlight(30_000)).toBe(0);
    emit("Network.requestWillBeSent", start("2"));
    expect(w.inFlight(30_000)).toBe(0);
    expect(w.openedBefore(30_000)).toBe(1); // "2"; "1" is quiet again
  });

  it("counts what opened before a window", async () => {
    const { cdp, emit } = setup();
    let page = 0;
    const w = await createNetworkWatch(cdp, () => 0, { pageNow: () => page });
    emit("Network.requestWillBeSent", start("a"));
    page = 7000;
    emit("Network.requestWillBeSent", start("b"));
    expect(w.openedBefore(1000)).toBe(1);
  });

  it("stop turns the Network domain off, and a closed session rejects nothing", async () => {
    const { cdp, sent } = setup();
    const w = await createNetworkWatch(cdp, () => 0);
    cdp.send = async (method) => {
      sent.push(method);
      throw new Error("Target page, context or browser has been closed");
    };
    expect(() => w.stop()).not.toThrow();
    await new Promise((r) => setTimeout(r, 0));
    expect(sent).toContain("Network.disable");
  });

  it("counts a dropped connection again when its data resumes, and keeps it named", async () => {
    const { cdp, emit } = setup();
    let now = 0;
    const w = await createNetworkWatch(cdp, () => now);
    emit("Network.requestWillBeSent", start("1"));
    now = 10_001;
    expect(w.waiting()).toBe(false);
    emit("Network.dataReceived", { requestId: "1" });
    expect(w.waiting()).toBe(true);
    expect(w.ignored()).toEqual(["GET /poll"]);
  });

  it("treats data after a gap over 10 s as dropped then resumed, without a sweep between", async () => {
    const { cdp, emit } = setup();
    let now = 0;
    const w = await createNetworkWatch(cdp, () => now);
    emit("Network.requestWillBeSent", start("1"));
    now = 10_001;
    emit("Network.dataReceived", { requestId: "1" });
    expect(w.waiting()).toBe(true);
    expect(w.ignored()).toEqual(["GET /poll"]);
  });

  it("names a label once when a poller reconnects and idles again", async () => {
    const { cdp, emit } = setup();
    let now = 0;
    const w = await createNetworkWatch(cdp, () => now);
    emit("Network.requestWillBeSent", start("1"));
    now = 10_001;
    expect(w.waiting()).toBe(false);
    emit("Network.requestWillBeSent", start("2"));
    now = 20_002;
    expect(w.waiting()).toBe(false);
    expect(w.ignored()).toEqual(["GET /poll"]);
  });

  it("an idle connection that finishes leaves the idle set", async () => {
    const { cdp, emit } = setup();
    let now = 0;
    const w = await createNetworkWatch(cdp, () => now);
    emit("Network.requestWillBeSent", start("1"));
    now = 10_001;
    expect(w.waiting()).toBe(false);
    emit("Network.loadingFinished", { requestId: "1" });
    emit("Network.dataReceived", { requestId: "1" });
    expect(w.waiting()).toBe(false);
  });

  it("labels the connections counted now, not the dropped or ended ones", async () => {
    const { cdp, emit } = setup();
    let now = 0;
    const w = await createNetworkWatch(cdp, () => now);
    emit("Network.requestWillBeSent", start("1"));
    emit("Network.requestWillBeSent", start("2", "http://app.test/api/chat"));
    emit("Network.requestWillBeSent", start("3", "http://app.test/done"));
    emit("Network.loadingFinished", { requestId: "3" });
    expect(w.labels()).toEqual(["GET /poll", "GET /api/chat"]);
    now = 5000;
    emit("Network.dataReceived", { requestId: "2" });
    now = 10_001;
    expect(w.labels()).toEqual(["GET /api/chat"]);
  });

  it("a failed request stops counting", async () => {
    const { cdp, emit } = setup();
    const w = await createNetworkWatch(cdp, () => 0);
    emit("Network.requestWillBeSent", start("1"));
    emit("Network.loadingFailed", { requestId: "1" });
    expect(w.waiting()).toBe(false);
  });

  it("stop removes its listeners", async () => {
    const { cdp, listeners } = setup();
    const w = await createNetworkWatch(cdp, () => 0);
    expect(listeners()).toBeGreaterThan(0);
    w.stop();
    expect(listeners()).toBe(0);
  });

  it("rejects when Network cannot be enabled", async () => {
    const { cdp } = setup();
    cdp.send = async () => {
      throw new Error("no network");
    };
    await expect(createNetworkWatch(cdp, () => 0)).rejects.toThrow(
      "no network",
    );
  });
});

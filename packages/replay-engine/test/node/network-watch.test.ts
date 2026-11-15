import { describe, expect, it } from "vitest";
import { createNetworkWatch } from "../../src/index.js";
import type { CdpSession } from "../../src/types.js";

function setup() {
  const handlers = new Map<string, Set<(p: Record<string, unknown>) => void>>();
  const sent: string[] = [];
  const cdp: CdpSession = {
    async send(method) {
      sent.push(method);
      return {};
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

  it("counts a websocket only while frames arrive", async () => {
    const { cdp, emit } = setup();
    let now = 0;
    const w = await createNetworkWatch(cdp, () => now);
    emit("Network.webSocketCreated", {
      requestId: "w",
      url: "ws://app.test/hmr",
    });
    expect(w.waiting()).toBe(true);
    now = 1000;
    emit("Network.webSocketFrameReceived", { requestId: "w" });
    now = 11_000;
    expect(w.waiting()).toBe(true);
    now = 11_001;
    expect(w.waiting()).toBe(false);
    expect(w.ignored()).toEqual(["websocket /hmr"]);
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

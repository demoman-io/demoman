import { describe, expect, it } from "vitest";
import { trackRequests } from "../../src/requests.js";

type Handler = (p: Record<string, unknown>) => void;

function fakeCdp(
  enable: () => Promise<Record<string, unknown>> = async () => ({}),
) {
  const handlers = new Map<string, Set<Handler>>();
  const sent: string[] = [];
  return {
    sent,
    listeners: () => [...handlers.values()].reduce((n, s) => n + s.size, 0),
    emit(event: string, params: Record<string, unknown>) {
      for (const h of handlers.get(event) ?? []) h(params);
    },
    send: async (method: string) => {
      sent.push(method);
      return enable();
    },
    on(event: string, h: Handler) {
      if (!handlers.has(event)) handlers.set(event, new Set());
      handlers.get(event)?.add(h);
      return () => handlers.get(event)?.delete(h);
    },
  };
}

const start = (
  id: string,
  type: string,
  extra: Record<string, unknown> = {},
) => ({
  requestId: id,
  type,
  ...extra,
});

describe("trackRequests", () => {
  it("counts a fetch until it finishes", async () => {
    const cdp = fakeCdp();
    const t = await trackRequests(cdp);
    expect(cdp.sent).toEqual(["Network.enable"]);
    cdp.emit("Network.requestWillBeSent", start("1", "Fetch"));
    cdp.emit("Network.requestWillBeSent", start("2", "XHR"));
    expect(t.inFlight()).toBe(2);
    cdp.emit("Network.loadingFinished", { requestId: "1" });
    expect(t.inFlight()).toBe(1);
    cdp.emit("Network.loadingFinished", { requestId: "2" });
    expect(t.inFlight()).toBe(0);
  });

  it("does not count EventSource, WebSocket, Document or Image requests", async () => {
    const cdp = fakeCdp();
    const t = await trackRequests(cdp);
    for (const type of ["EventSource", "WebSocket", "Document", "Image"]) {
      cdp.emit("Network.requestWillBeSent", start(type, type));
    }
    expect(t.inFlight()).toBe(0);
    // finishing an uncounted or unseen request must not go negative
    cdp.emit("Network.loadingFinished", { requestId: "Image" });
    cdp.emit("Network.loadingFailed", { requestId: "never-seen" });
    cdp.emit("Network.requestWillBeSent", start("f", "Fetch"));
    expect(t.inFlight()).toBe(1);
  });

  it("a redirect is still one request", async () => {
    const cdp = fakeCdp();
    const t = await trackRequests(cdp);
    cdp.emit("Network.requestWillBeSent", start("1", "Fetch"));
    cdp.emit(
      "Network.requestWillBeSent",
      start("1", "Fetch", { redirectResponse: { status: 302 } }),
    );
    expect(t.inFlight()).toBe(1);
    cdp.emit("Network.loadingFinished", { requestId: "1" });
    expect(t.inFlight()).toBe(0);
  });

  it("a request that fails is no longer in flight", async () => {
    const cdp = fakeCdp();
    const t = await trackRequests(cdp);
    cdp.emit("Network.requestWillBeSent", start("1", "XHR"));
    cdp.emit("Network.loadingFailed", { requestId: "1" });
    expect(t.inFlight()).toBe(0);
  });

  it("idle answers true once the last request ends, false at the deadline while a fetch never answers", async () => {
    const cdp = fakeCdp();
    const t = await trackRequests(cdp);
    let clock = 0;
    const now = () => clock;
    const sleep = async (ms: number) => {
      clock += ms;
    };
    expect(await t.idle(100, sleep, now)).toBe(true);
    cdp.emit("Network.requestWillBeSent", start("1", "Fetch"));
    expect(await t.idle(200, sleep, now)).toBe(false);
    expect(clock).toBeGreaterThanOrEqual(200);
    const ends = async (ms: number) => {
      clock += ms;
      cdp.emit("Network.loadingFinished", { requestId: "1" });
    };
    expect(await t.idle(clock + 500, ends, now)).toBe(true);
  });

  it("dispose removes every listener", async () => {
    const cdp = fakeCdp();
    const t = await trackRequests(cdp);
    expect(cdp.listeners()).toBeGreaterThan(0);
    t.dispose();
    expect(cdp.listeners()).toBe(0);
  });

  it("rejects with the reason when Network.enable fails, leaving no listener", async () => {
    const cdp = fakeCdp(async () => {
      throw new Error("session closed");
    });
    await expect(trackRequests(cdp)).rejects.toThrow("session closed");
    expect(cdp.listeners()).toBe(0);
  });
});

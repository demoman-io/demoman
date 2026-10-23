import type { ServerResponse } from "node:http";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { createEventHub, frameOf, KEEP_ALIVE_MS } from "../../src/events.js";

/** A response stand-in: records the head and every write. */
function fakeResponse() {
  const sink = new PassThrough();
  let text = "";
  sink.on("data", (c: Buffer) => {
    text += c.toString("utf8");
  });
  const head: { status?: number; headers?: Record<string, string> } = {};
  const res = Object.assign(sink, {
    writeHead(status: number, headers: Record<string, string>) {
      head.status = status;
      head.headers = headers;
      return res;
    },
  });
  return {
    res: res as unknown as ServerResponse,
    head,
    text: () => text,
  };
}

describe("the event hub", () => {
  it("keeps 15 s as the keep-alive", () => {
    expect(KEEP_ALIVE_MS).toBe(15_000);
  });

  it("frames an event as event: <type> and its JSON", () => {
    expect(frameOf({ type: "open", path: "/editor.html?scene=a" })).toBe(
      'event: open\ndata: {"type":"open","path":"/editor.html?scene=a"}\n\n',
    );
  });

  it("answers text/event-stream and writes keep-alive comments", async () => {
    const hub = createEventHub({ log: () => {}, keepAliveMs: 10 });
    const page = fakeResponse();
    const answer = await hub.handler({} as never);
    if (!("stream" in answer)) throw new Error("not a stream answer");
    answer.stream(page.res);
    expect(page.head.status).toBe(200);
    expect(page.head.headers?.["Content-Type"]).toBe("text/event-stream");
    await expect
      .poll(() => page.text().split(": keep-alive\n\n").length - 1, {
        timeout: 5_000,
      })
      .toBeGreaterThanOrEqual(2);
    page.res.emit("close");
    expect(hub.size()).toBe(0);
  });

  it("a stream that errors leaves the hub and the log says so", async () => {
    const logs: string[] = [];
    const hub = createEventHub({ log: (l) => logs.push(l) });
    const page = fakeResponse();
    const answer = await hub.handler({} as never);
    if (!("stream" in answer)) throw new Error("not a stream answer");
    answer.stream(page.res);
    expect(hub.size()).toBe(1);
    page.res.emit("error", new Error("EPIPE"));
    expect(hub.size()).toBe(0);
    expect(logs).toEqual(["studio: an event stream failed (EPIPE)"]);
  });
});

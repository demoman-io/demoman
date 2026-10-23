import type { ServerResponse } from "node:http";
import type { StudioEvent } from "@demoman/studio-protocol";
import type { Handler } from "./server.js";

/** Comments every 15 s keep an idle stream from being timed out between
 *  the page and the server. */
export const KEEP_ALIVE_MS = 15_000;

export interface EventHub {
  /** To every connected page. */
  send(e: StudioEvent): void;
  /** `GET /api/events`: one stream per connected page. */
  handler: Handler;
  /** Pages connected now. */
  size(): number;
  /** Ends every stream (the server is stopping). */
  close(): void;
}

/** One SSE frame: `event: <type>` so a page can listen per type. */
export const frameOf = (e: StudioEvent): string =>
  `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`;

export function createEventHub(o: {
  log: (line: string) => void;
  keepAliveMs?: number;
}): EventHub {
  const clients = new Set<ServerResponse>();
  const keepAliveMs = o.keepAliveMs ?? KEEP_ALIVE_MS;

  const drop = (res: ServerResponse): void => {
    clients.delete(res);
  };

  const write = (res: ServerResponse, text: string): void => {
    if (res.destroyed || res.writableEnded) {
      drop(res);
      return;
    }
    res.write(text);
  };

  return {
    send(e) {
      const text = frameOf(e);
      for (const res of clients) write(res, text);
    },
    async handler() {
      return {
        stream(res) {
          res.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
          });
          // A first comment flushes the head, so the page's reader knows the
          // stream is open before any event has been sent.
          res.write(": connected\n\n");
          clients.add(res);
          const timer = setInterval(
            () => write(res, ": keep-alive\n\n"),
            keepAliveMs,
          );
          timer.unref();
          res.on("close", () => {
            clearInterval(timer);
            drop(res);
          });
          res.on("error", (error) => {
            // A page that went away mid-write: its stream is over, and the
            // other pages' are not. Said, because a stream that errors for
            // any other reason is a page that stopped hearing events.
            o.log(`studio: an event stream failed (${error.message})`);
            clearInterval(timer);
            drop(res);
          });
        },
      };
    },
    size: () => clients.size,
    close() {
      for (const res of clients) res.end();
      clients.clear();
    },
  };
}

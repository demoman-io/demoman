import { randomBytes } from "node:crypto";
import {
  createServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { listenOnLoopback } from "@demoman/runner/studio";
import {
  matchRoute,
  type Refusal,
  type RouteId,
  STUDIO_COOKIE,
  type StudioReason,
} from "@demoman/studio-protocol";
import { EXPIRED_CSP, EXPIRED_HTML } from "./expired-page.js";
import {
  checkRequest,
  createTicketBook,
  entryTicket,
  REASON_DETAIL,
  SECURITY_HEADERS,
} from "./guard.js";
import { entryUrlFor, pagePathFor } from "./paths.js";

export interface StudioRequest {
  method: string;
  params: Record<string, string>;
  query: URLSearchParams;
  headers: IncomingHttpHeaders;
  body(): Promise<Buffer>;
  raw: IncomingMessage;
}

export type StudioResponse =
  | { status: number; json: unknown; headers?: Record<string, string> }
  | {
      status: number;
      body: Buffer | Uint8Array;
      contentType: string;
      headers?: Record<string, string>;
    }
  | { stream: (res: ServerResponse) => void };

export type Handler = (req: StudioRequest) => Promise<StudioResponse>;
/** Mapped, so a route without a handler is a compile error. */
export type StudioHandlers = { [K in RouteId]: Handler };

/** What the page server is told: the pathname the door already parsed (so it
 *  never parses `req.url` a second time). */
export interface PageRequest {
  pathname: string;
}

export interface PageServer {
  serve(
    req: IncomingMessage,
    res: ServerResponse,
    page: PageRequest,
  ): Promise<void>;
}

export interface StudioServer {
  origin: string;
  port: number;
  /** The session token: the cookie's value. Never put in a URL (R12). */
  token: string;
  /** A fresh entry URL on `takeId` (the library without one), carrying a
   *  new single-use ticket, never the token (ruling R12). */
  entryUrl(takeId?: string): string;
  close(): Promise<void>;
}

function send(
  res: ServerResponse,
  status: number,
  contentType: string,
  body: Buffer | Uint8Array | string,
  headers: Record<string, string> = {},
): void {
  res.writeHead(status, {
    ...headers,
    ...SECURITY_HEADERS,
    "Content-Type": contentType,
  });
  res.end(body);
}

function refuse(
  res: ServerResponse,
  status: number,
  reason: StudioReason,
  detail: string,
  api: boolean,
): void {
  if (api) {
    const body: Refusal = { reason, detail };
    send(res, status, "application/json", JSON.stringify(body));
    return;
  }
  // The one response with a CSP of its own: it has no session, so it styles
  // itself (`expired-page.ts`). `send` would put the spec's CSP over it.
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    "Content-Security-Policy": EXPIRED_CSP,
    "Content-Type": "text/html; charset=utf-8",
  });
  res.end(EXPIRED_HTML);
}

export async function createStudioServer(o: {
  handlers: StudioHandlers;
  pages: PageServer;
  token?: string;
  /** Tests: the clock entry tickets expire by. */
  now?: () => number;
}): Promise<StudioServer> {
  const token = o.token ?? randomBytes(32).toString("base64url");
  const tickets = createTicketBook(o.now === undefined ? {} : { now: o.now });
  let port = 0;

  const handle = async (
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> => {
    const url = new URL(req.url ?? "/", "http://studio.invalid");
    const api = url.pathname.startsWith("/api/");
    const denied = checkRequest(req, { port, token, tickets, api });
    if (denied) {
      refuse(res, 403, denied, REASON_DETAIL[denied], api);
      return;
    }
    if (entryTicket(req) !== null) {
      url.searchParams.delete("t");
      // `take` names the take a fresh window opens on (`entryUrlFor`): the
      // redirect goes straight to its editor, so the window's history never
      // holds the token or a library page it did not ask for.
      const take = url.searchParams.get("take");
      const qs = url.searchParams.toString();
      res.writeHead(302, {
        ...SECURITY_HEADERS,
        Location:
          take !== null && take !== ""
            ? pagePathFor(take)
            : qs
              ? `/?${qs}`
              : "/",
        "Set-Cookie": `${STUDIO_COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/`,
      });
      res.end();
      return;
    }
    if (!api) {
      // Headers first: the page server writes the response itself.
      for (const [k, v] of Object.entries(SECURITY_HEADERS)) {
        res.setHeader(k, v);
      }
      await o.pages.serve(req, res, { pathname: url.pathname });
      return;
    }
    const m = matchRoute(req.method ?? "GET", url.pathname);
    if (!m) {
      refuse(res, 404, "routeNotFound", REASON_DETAIL.routeNotFound, true);
      return;
    }
    const answer = await o.handlers[m.id]({
      method: req.method ?? "GET",
      params: m.params,
      query: url.searchParams,
      headers: req.headers,
      body: () => readBody(req),
      raw: req,
    });
    if ("stream" in answer) {
      for (const [k, v] of Object.entries(SECURITY_HEADERS)) {
        res.setHeader(k, v);
      }
      answer.stream(res);
    } else if ("json" in answer) {
      send(
        res,
        answer.status,
        "application/json",
        JSON.stringify(answer.json),
        answer.headers,
      );
    } else {
      send(res, answer.status, answer.contentType, answer.body, answer.headers);
    }
  };

  const server = createServer((req, res) => {
    handle(req, res).catch((e) => {
      // A handler or page server threw: say so to the caller and the log
      // (the serve process's stderr is studio.log).
      const detail = e instanceof Error ? e.message : String(e);
      console.error(`studio: ${req.method} ${req.url} failed: ${detail}`);
      if (res.headersSent) {
        // Too late for a status: cut the response short, so the page sees a
        // failed read rather than a truncated body that looks complete.
        res.destroy();
        return;
      }
      const body: Refusal = { reason: "internalError", detail };
      send(res, 500, "application/json", JSON.stringify(body));
    });
  });
  const origin = await listenOnLoopback(server);
  port = Number(new URL(origin).port);
  const bare = origin.replace(/\/$/, "");
  return {
    origin: bare,
    port,
    token,
    entryUrl: (takeId) => entryUrlFor(bare, tickets.mint(), takeId),
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((e) => (e ? reject(e) : resolve()));
        server.closeAllConnections();
      }),
  };
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

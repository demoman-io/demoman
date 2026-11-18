import { randomBytes } from "node:crypto";
import {
  createServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { WALLPAPER_MAX_BYTES } from "@demoman/run-core";
import { type Library, listenOnLoopback } from "@demoman/runner/studio";
import {
  matchRoute,
  type Refusal,
  type RouteId,
  STUDIO_COOKIE,
  type StudioReason,
} from "@demoman/studio-protocol";
import { EXPIRED_CSP, EXPIRED_HTML } from "./expired-page.js";
import { messageOf, noTakeRefusal } from "./files.js";
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

export const json = (status: number, body: unknown): StudioResponse => ({
  status,
  json: body,
});

export const refuse = (
  status: number,
  reason: StudioReason,
  detail: string,
): { status: number; json: Refusal } => {
  const body: Refusal = { reason, detail };
  return { status, json: body };
};

export const noTake = (library: Library, id: string): StudioResponse =>
  json(404, noTakeRefusal(library, id));

export const noVideo = (id: string): StudioResponse =>
  refuse(404, "videoNotFound", `There is no flow "${id}".`);

/** The most bytes an asset upload may carry. The largest asset is a
 *  wallpaper at `WALLPAPER_MAX_BYTES`; twice that leaves its route's own
 *  sentence to answer anything near its line. */
export const ASSET_BODY_MAX_BYTES = 2 * WALLPAPER_MAX_BYTES;
/** The most bytes any other (JSON) body may carry. The largest is a scene,
 *  about 100 KB for a long take on 2026-11-18; this is 160 times that. */
export const JSON_BODY_MAX_BYTES = 16 * 1024 * 1024;

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
  entryUrl(takeId?: string, project?: string): string;
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

function sendRefusal(
  res: ServerResponse,
  status: number,
  reason: StudioReason,
  detail: string,
  api: boolean,
): void {
  if (api) {
    const r = refuse(status, reason, detail);
    send(res, r.status, "application/json", JSON.stringify(r.json));
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
  /** Tests: one body cap for every route, in place of the two above. */
  bodyMaxBytes?: number;
}): Promise<StudioServer> {
  const capOf = (id: RouteId): number =>
    o.bodyMaxBytes ??
    (id === "assetPut" ? ASSET_BODY_MAX_BYTES : JSON_BODY_MAX_BYTES);
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
      sendRefusal(res, 403, denied, REASON_DETAIL[denied], api);
      return;
    }
    if (entryTicket(req) !== null) {
      url.searchParams.delete("t");
      // `take` names the take a fresh window opens on (`entryUrlFor`): the
      // redirect goes straight to its editor, so the window's history never
      // holds the token or a library page it did not ask for.
      const take = url.searchParams.get("take");
      const project = url.searchParams.get("project");
      const qs = url.searchParams.toString();
      res.writeHead(302, {
        ...SECURITY_HEADERS,
        Location:
          take !== null && take !== ""
            ? pagePathFor(take)
            : project !== null && project !== ""
              ? pagePathFor(undefined, project)
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
      sendRefusal(res, 404, "routeNotFound", REASON_DETAIL.routeNotFound, true);
      return;
    }
    const cap = capOf(m.id);
    const read = { overCap: false };
    let body: Promise<Buffer> | undefined;
    // Decided here, not by the handler: whatever it made of the refused read
    // (a parse error, a swallowed throw), the caller hears the cap.
    const tooLarge = refuse(
      413,
      "bodyTooLarge",
      `The request carried more than the Studio accepts here (${(cap / 1024 / 1024).toFixed(1)} MB).`,
    );
    let answer: StudioResponse = await o.handlers[m.id]({
      method: req.method ?? "GET",
      params: m.params,
      query: url.searchParams,
      headers: req.headers,
      // One read per request: a second call answers the first's result.
      body: () => {
        body ??= readBody(req, cap, read);
        return body;
      },
      raw: req,
    }).catch((e: unknown) => {
      if (!read.overCap) throw e;
      // Answered as the cap, but what the handler threw is still said.
      console.error(
        `studio: ${req.method} ${req.url} threw after its body was refused: ${messageOf(e)}`,
      );
      return tooLarge;
    });
    if (read.overCap) answer = tooLarge;
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
      const detail = messageOf(e);
      console.error(`studio: ${req.method} ${req.url} failed: ${detail}`);
      if (res.headersSent) {
        // Too late for a status: cut the response short, so the page sees a
        // failed read rather than a truncated body that looks complete.
        res.destroy();
        return;
      }
      const r = refuse(500, "internalError", detail);
      send(res, r.status, "application/json", JSON.stringify(r.json));
    });
  });
  const origin = await listenOnLoopback(server);
  port = Number(new URL(origin).port);
  const bare = origin.replace(/\/$/, "");
  return {
    origin: bare,
    port,
    token,
    entryUrl: (takeId, project) =>
      entryUrlFor(bare, tickets.mint(), takeId, project),
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((e) => (e ? reject(e) : resolve()));
        server.closeAllConnections();
      }),
  };
}

/** The body, counted as it arrives: past `max` bytes, declared or counted, it
 *  stops keeping it, sets `read.overCap` and rejects, so an oversized body is
 *  never held whole. */
function readBody(
  req: IncomingMessage,
  max: number,
  read: { overCap: boolean },
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const overCap = () => {
      req.off("data", onData);
      // Drained, not paused: closing on an unread upload resets the socket,
      // and the client loses the 413 before it reads it.
      // shortcut: the rest of the upload is read and discarded, not cut off;
      // cut it off if a slow multi-GB upload ever matters here.
      req.resume();
      read.overCap = true;
      reject(new Error(`the request body is past ${max} bytes`));
    };
    const onData = (c: Buffer) => {
      size += c.byteLength;
      if (size > max) {
        overCap();
        return;
      }
      chunks.push(c);
    };
    if (Number(req.headers["content-length"] ?? 0) > max) {
      overCap();
      return;
    }
    req.on("data", onData);
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

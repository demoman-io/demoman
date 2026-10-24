import { randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import {
  STUDIO_COOKIE,
  STUDIO_HEADER,
  type StudioReason,
} from "@demoman/studio-protocol";

export const EXPIRED_LINE =
  "This Studio link has expired; run `npx demoman studio`.";

export const SECURITY_HEADERS = {
  "Content-Security-Policy":
    "default-src 'self'; img-src 'self' blob: data:; media-src 'self' blob:; connect-src 'self'; frame-ancestors 'none'",
  "X-Content-Type-Options": "nosniff",
} as const;

/** The door's own refusals, in the order `checkRequest` tries them. */
export type GuardReason = Extract<
  StudioReason,
  "hostRefused" | "tokenMissing" | "tokenWrong" | "headerMissing"
>;

/**
 * Every refusal the server writes itself, each with its sentence. Exhaustive,
 * so a reason added to the door without a sentence is a compile error rather
 * than a detail that falls back to the reason's identifier. `internalError`
 * is not here: its detail is the thrown error's own message.
 */
export const REASON_DETAIL: Record<GuardReason | "routeNotFound", string> = {
  hostRefused: "The request was not addressed to the Studio's own address.",
  tokenMissing: EXPIRED_LINE,
  tokenWrong: EXPIRED_LINE,
  headerMissing: `The request lacked the ${STUDIO_HEADER} header.`,
  routeNotFound: "No such studio route.",
};

function sameToken(given: string, token: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(token);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function cookieValue(req: IncomingMessage, name: string): string | null {
  const raw = req.headers.cookie;
  if (!raw) return null;
  for (const part of raw.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

/** How long an entry ticket stays good after it is minted (ruling R12). */
export const TICKET_TTL_MS = 60_000;

/**
 * Single-use entry tickets (ruling R12). The session token never leaves the
 * process but in studio.json (0600); a window is sent to a URL carrying a
 * ticket instead, good once and for `TICKET_TTL_MS`, and only through
 * Playwright's pipe: argv, stdout and tool answers are readable by others,
 * who could spend it first.
 */
export interface TicketBook {
  /** A fresh ticket: 32 random bytes, base64url. */
  mint(): string;
  /** True once for a live ticket, which is then spent; false for a spent,
   *  expired or unknown one. */
  redeem(ticket: string): boolean;
}

export function createTicketBook(
  o: { now?: () => number; ttlMs?: number } = {},
): TicketBook {
  const now = o.now ?? Date.now;
  const ttlMs = o.ttlMs ?? TICKET_TTL_MS;
  const live = new Map<string, number>();
  const prune = () => {
    const t = now();
    for (const [ticket, minted] of live) {
      if (t - minted > ttlMs) live.delete(ticket);
    }
  };
  return {
    mint() {
      prune();
      const ticket = randomBytes(32).toString("base64url");
      live.set(ticket, now());
      return ticket;
    },
    redeem(given) {
      prune();
      // Compared in constant time against each live ticket, as the cookie
      // is against the token: never a lookup keyed by what was sent.
      for (const ticket of live.keys()) {
        if (sameToken(given, ticket)) {
          live.delete(ticket);
          return true;
        }
      }
      return false;
    },
  };
}

/** The `t` of a `GET /?t=...` entry request, or null for any other request. */
export function entryTicket(req: IncomingMessage): string | null {
  if (req.method !== "GET") return null;
  const url = new URL(req.url ?? "/", "http://studio.invalid");
  if (url.pathname !== "/") return null;
  return url.searchParams.get("t");
}

/**
 * Host, then cookie, then (for /api/*) the header. The one request let in
 * without the cookie is `GET /?t=<ticket>` with the right Host and a live
 * entry ticket, which is what sets it — and spends the ticket. A spent,
 * expired or unknown `t` (the session token included) is `tokenWrong`
 * unless the request already carries the session cookie: then it is a
 * window that is already in re-opening a used entry link, and it is let
 * through to the entry redirect, which drops `t`. Refusing it showed
 * "link expired" in a signed-in window while `open` reported success.
 */
export function checkRequest(
  req: IncomingMessage,
  o: { port: number; token: string; tickets: TicketBook; api: boolean },
): GuardReason | null {
  if (req.headers.host !== `127.0.0.1:${o.port}`) return "hostRefused";
  const cookie = cookieValue(req, STUDIO_COOKIE);
  const t = entryTicket(req);
  if (t !== null) {
    if (o.tickets.redeem(t)) return null;
    return cookie !== null && sameToken(cookie, o.token) ? null : "tokenWrong";
  }
  if (cookie === null) return "tokenMissing";
  if (!sameToken(cookie, o.token)) return "tokenWrong";
  if (o.api && req.headers[STUDIO_HEADER.toLowerCase()] !== "1") {
    return "headerMissing";
  }
  return null;
}

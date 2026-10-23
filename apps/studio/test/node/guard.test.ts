import { createHash } from "node:crypto";
import { request } from "node:http";
import { ROUTES, type RouteId, STUDIO_HEADER } from "@demoman/studio-protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TICKET_TTL_MS } from "../../src/guard.js";
import {
  createStudioServer,
  type Handler,
  type StudioHandlers,
  type StudioServer,
} from "../../src/server.js";

const CSP =
  "default-src 'self'; img-src 'self' blob: data:; media-src 'self' blob:; connect-src 'self'; frame-ancestors 'none'";

const ok: Handler = async () => ({ status: 200, json: {} });
const handlers = Object.fromEntries(
  (Object.keys(ROUTES) as RouteId[]).map((id) => [id, ok]),
) as StudioHandlers;

let studio: StudioServer;
/** The clock entry tickets expire by: moved by hand. */
let clock = 0;
beforeEach(async () => {
  clock = 1_000_000;
  studio = await createStudioServer({
    now: () => clock,
    handlers,
    pages: {
      async serve(_req, res) {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end("<p>page</p>");
      },
    },
  });
});
afterEach(async () => {
  await studio.close();
});

interface Answer {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  text: string;
}

/** A raw request, so `Host` can be anything (fetch forbids setting it). */
function call(
  path: string,
  o: { method?: string; host?: string; headers?: Record<string, string> } = {},
): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: "127.0.0.1",
        port: studio.port,
        path,
        method: o.method ?? "GET",
        headers: { Host: o.host ?? `127.0.0.1:${studio.port}`, ...o.headers },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            text: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    req.on("error", reject);
    req.end();
  });
}

const cookie = () => `studio=${studio.token}`;
/** A fresh entry link's path and query: `/?t=<ticket>[&take=…]`. */
const entry = (takeId?: string) => {
  const url = new URL(studio.entryUrl(takeId));
  return `${url.pathname}${url.search}`;
};
const good = () => ({ Cookie: cookie(), [STUDIO_HEADER]: "1" });

describe("the door refuses, each with its own reason", () => {
  it("hostRefused: a wrong Host, even with the right cookie and header", async () => {
    const r = await call("/api/ping", {
      host: `evil.test:${studio.port}`,
      headers: good(),
    });
    expect(r.status).toBe(403);
    expect(JSON.parse(r.text).reason).toBe("hostRefused");
  });

  it("hostRefused: the entry link with a wrong Host sets no cookie", async () => {
    const r = await call(entry(), {
      host: `evil.test:${studio.port}`,
    });
    expect(r.status).toBe(403);
    expect(r.headers["set-cookie"]).toBeUndefined();
  });

  it("tokenMissing: no cookie", async () => {
    const r = await call("/api/ping", { headers: { [STUDIO_HEADER]: "1" } });
    expect(r.status).toBe(403);
    expect(JSON.parse(r.text).reason).toBe("tokenMissing");
  });

  it("tokenWrong: a cookie of the same length", async () => {
    const wrong = "x".repeat(studio.token.length);
    const r = await call("/api/ping", {
      headers: { Cookie: `studio=${wrong}`, [STUDIO_HEADER]: "1" },
    });
    expect(r.status).toBe(403);
    expect(JSON.parse(r.text).reason).toBe("tokenWrong");
  });

  it("tokenWrong: a cookie of another length", async () => {
    const r = await call("/api/ping", {
      headers: { Cookie: "studio=short", [STUDIO_HEADER]: "1" },
    });
    expect(r.status).toBe(403);
    expect(JSON.parse(r.text).reason).toBe("tokenWrong");
  });

  it("tokenWrong: a wrong t on the entry link", async () => {
    const r = await call("/?t=nope");
    expect(r.status).toBe(403);
    expect(r.headers["set-cookie"]).toBeUndefined();
  });

  it("headerMissing: /api/* without X-Demoman-Studio", async () => {
    const r = await call("/api/ping", { headers: { Cookie: cookie() } });
    expect(r.status).toBe(403);
    expect(JSON.parse(r.text).reason).toBe("headerMissing");
  });

  it("a page needs no header, only Host and cookie", async () => {
    const r = await call("/", { headers: { Cookie: cookie() } });
    expect(r.status).toBe(200);
    expect(r.text).toBe("<p>page</p>");
  });

  it("a page 403 carries the expired-link line, as HTML", async () => {
    const r = await call("/");
    expect(r.status).toBe(403);
    expect(String(r.headers["content-type"])).toContain("text/html");
    expect(r.text).toContain("This studio link has expired; run ");
    expect(r.text).toContain("npx demoman studio");
  });
});

describe("the expired page's style", () => {
  const styleOf = (html: string): string =>
    /<style>([\s\S]*)<\/style>/.exec(html)?.[1] ?? "";

  // R20: the page has no session, so its guarded assets cannot load; it
  // styles itself, and only this response's CSP says the style is allowed.
  it("is inline, allowed by its own hash on that response only", async () => {
    const r = await call("/");
    expect(r.status).toBe(403);
    const style = styleOf(r.text);
    // Premise: there is a style, and it is the studio's: dark only (spec
    // 2026-10-19 §6), the site's near-black ground and ink, no dots, Geist
    // by name. Red: the old shell's light-and-dark block.
    expect(style).not.toContain("prefers-color-scheme");
    expect(style).toContain("#0a0a0a");
    expect(style).toContain("#f4f4f5");
    expect(style).not.toContain("radial-gradient");
    expect(style).toMatch(/"Geist",/);
    expect(style).toMatch(/"Geist Mono",/);
    const hash = createHash("sha256").update(style).digest("base64");
    const csp = String(r.headers["content-security-policy"]);
    expect(csp).toBe(`${CSP}; style-src 'sha256-${hash}'`);
    // Drawn as code, no literal backtick.
    expect(r.text).toContain("<code>npx demoman studio</code>");
    expect(r.text).not.toContain("`");
    // Every other kind of answer keeps exactly the spec's CSP.
    for (const other of [
      await call("/api/ping"),
      await call("/api/nope", { headers: good() }),
      await call("/", { headers: { Cookie: cookie() } }),
    ]) {
      expect(other.headers["content-security-policy"]).toBe(CSP);
    }
  });

  // Why the expired page names its faces and links no file: without the
  // session a font is refused like any other path, so the page can only use
  // a Geist the machine has installed, then the system's.
  it("cannot load the studio's fonts: they are behind the session too", async () => {
    const font = await call("/fonts/geist-variable.woff2");
    expect(font.status).toBe(403);
  });
});

describe("the entry link", () => {
  it("sets the cookie and redirects without t, keeping other query", async () => {
    const r = await call(`${entry()}&q=x`);
    expect(r.status).toBe(302);
    expect(r.headers.location).toBe("/?q=x");
    expect(String(r.headers.location)).not.toContain(studio.token);
    expect(r.headers["set-cookie"]).toEqual([
      `studio=${studio.token}; HttpOnly; SameSite=Strict; Path=/`,
    ]);
  });

  it("an entry naming a take redirects to that take's editor (Task 7)", async () => {
    // Red: drop the `take` branch from the door's redirect.
    const r = await call(entry("a b/.."));
    expect(r.status).toBe(302);
    expect(r.headers.location).toBe(
      `/editor.html?scene=${encodeURIComponent("a b/..")}`,
    );
    expect(String(r.headers.location)).not.toContain(studio.token);
    expect(r.headers["set-cookie"]).toEqual([
      `studio=${studio.token}; HttpOnly; SameSite=Strict; Path=/`,
    ]);
  });

  it("a ticket lets in once; the second use is tokenWrong (R12)", async () => {
    const link = entry();
    const first = await call(link);
    expect(first.status).toBe(302);
    // Red: leave the ticket in the book on redeem.
    const again = await call(link);
    expect(again.status).toBe(403);
    expect(again.headers["set-cookie"]).toBeUndefined();
    expect(again.text).toContain("npx demoman studio");
  });

  it("a spent ticket with a valid session cookie is let in, without t", async () => {
    const link = `${entry()}&q=x`;
    expect((await call(link)).status).toBe(302);
    // Premise: the ticket is spent — without the cookie it is refused.
    expect((await call(link)).status).toBe(403);
    // Red: answer tokenWrong for a spent `t` whatever the cookie says.
    const r = await call(link, { headers: { Cookie: cookie() } });
    expect(r.status).toBe(302);
    expect(r.headers.location).toBe("/?q=x");
    expect(String(r.headers.location)).not.toContain("t=");
  });

  it("a spent ticket with a wrong cookie is still tokenWrong", async () => {
    const link = entry();
    expect((await call(link)).status).toBe(302);
    const wrong = "x".repeat(studio.token.length);
    const r = await call(link, { headers: { Cookie: `studio=${wrong}` } });
    expect(r.status).toBe(403);
    expect(r.headers["set-cookie"]).toBeUndefined();
    expect(r.text).toContain("npx demoman studio");
  });

  it("a ticket older than 60 s is tokenWrong (R12)", async () => {
    const stale = entry();
    clock += TICKET_TTL_MS + 1;
    const fresh = entry();
    // Red: drop the expiry from the ticket book.
    const r = await call(stale);
    expect(r.status).toBe(403);
    expect(r.headers["set-cookie"]).toBeUndefined();
    // Premise: at this clock the door still takes a ticket, so the refusal
    // above is the stale ticket's age.
    expect((await call(fresh)).status).toBe(302);
  });

  it("the session token itself is no entry ticket (R12)", async () => {
    // Red: accept the token in `?t=` again (checkRequest's entry branch).
    const r = await call(`/?t=${encodeURIComponent(studio.token)}`);
    expect(r.status).toBe(403);
    expect(r.headers["set-cookie"]).toBeUndefined();
  });

  it("an entry URL carries a ticket, never the token (R12)", () => {
    const url = new URL(studio.entryUrl("t1"));
    expect(url.origin).toBe(studio.origin);
    expect(url.href).not.toContain(studio.token);
    expect(url.searchParams.get("t")).toMatch(/^[\w-]{43}$/);
    expect(url.searchParams.get("take")).toBe("t1");
  });

  it("redirects to a bare / when t was the only query", async () => {
    const r = await call(entry());
    expect(r.status).toBe(302);
    expect(r.headers.location).toBe("/");
  });
});

describe("every answer", () => {
  it("carries the CSP and nosniff: 200, 302, 403, 404", async () => {
    const answers = [
      await call("/api/ping", { headers: good() }),
      await call(entry()),
      await call("/api/ping"),
      await call("/api/nope", { headers: good() }),
      await call("/", { headers: { Cookie: cookie() } }),
    ];
    expect(answers.map((a) => a.status)).toEqual([200, 302, 403, 404, 200]);
    for (const a of answers) {
      expect(a.headers["content-security-policy"]).toBe(CSP);
      expect(a.headers["x-content-type-options"]).toBe("nosniff");
    }
  });

  it("an unmatched /api/* answers 404 routeNotFound", async () => {
    const r = await call("/api/nope", { headers: good() });
    expect(r.status).toBe(404);
    expect(JSON.parse(r.text).reason).toBe("routeNotFound");
  });

  it("a thrown handler answers 500, not an empty success", async () => {
    await studio.close();
    studio = await createStudioServer({
      handlers: {
        ...handlers,
        ping: async () => {
          throw new Error("boom");
        },
      },
      pages: { async serve() {} },
    });
    // The server's stderr is studio.log; spied so the line is asserted and
    // the test output stays clean.
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const r = await call("/api/ping", { headers: good() });
      expect(r.status).toBe(500);
      expect(JSON.parse(r.text)).toEqual({
        reason: "internalError",
        detail: "boom",
      });
      expect(logged).toHaveBeenCalledTimes(1);
      expect(String(logged.mock.calls[0]?.[0])).toContain("GET /api/ping");
      expect(String(logged.mock.calls[0]?.[0])).toContain("boom");
    } finally {
      logged.mockRestore();
    }
  });

  it("the page server is handed the parsed pathname, and no theme", async () => {
    await studio.close();
    const seen: unknown[] = [];
    studio = await createStudioServer({
      handlers,
      pages: {
        async serve(_req, res, page) {
          seen.push(page);
          res.writeHead(200, { "Content-Type": "text/html" });
          res.end("<p>page</p>");
        },
      },
    });
    const r = await call("/editor.html?scene=a", {
      headers: { Cookie: cookie() },
    });
    expect(r.status).toBe(200);
    expect(seen).toEqual([{ pathname: "/editor.html" }]);
  });
});

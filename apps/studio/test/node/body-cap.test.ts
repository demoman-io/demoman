import { request } from "node:http";
import { ROUTES, type RouteId, STUDIO_HEADER } from "@demoman/studio-protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createStudioServer,
  type Handler,
  JSON_BODY_MAX_BYTES,
  type StudioHandlers,
  type StudioServer,
} from "../../src/server.js";

const ok: Handler = async () => ({ status: 200, json: {} });
const base = Object.fromEntries(
  (Object.keys(ROUTES) as RouteId[]).map((id) => [id, ok]),
) as StudioHandlers;
const MB = 1024 * 1024;

let studio: StudioServer | undefined;
afterEach(async () => {
  await studio?.close();
  studio = undefined;
});

async function serve(
  handlers: Partial<StudioHandlers>,
  bodyMaxBytes?: number,
): Promise<StudioServer> {
  studio = await createStudioServer({
    ...(bodyMaxBytes === undefined ? {} : { bodyMaxBytes }),
    handlers: { ...base, ...handlers },
    pages: { async serve() {} },
  });
  return studio;
}

/** A request whose body is `whole` (sent and ended), or, with `stream`, 64 KB
 *  chunks written until the answer arrives and never ended: an answer then
 *  proves the server refused before the body was whole. */
function upload(
  s: StudioServer,
  path: string,
  method: string,
  body: { whole: Buffer } | { stream: true; declared?: number },
): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    let answered = false;
    const headers: Record<string, string | number> = {
      Host: `127.0.0.1:${s.port}`,
      Cookie: `studio=${s.token}`,
      [STUDIO_HEADER]: "1",
    };
    if ("stream" in body && body.declared !== undefined) {
      headers["Content-Length"] = body.declared;
    }
    const req = request(
      { host: "127.0.0.1", port: s.port, path, method, headers },
      (res) => {
        answered = true;
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            text: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    req.on("error", (e) =>
      reject(new Error(`the upload failed before an answer was read: ${e}`)),
    );
    if ("whole" in body) {
      req.end(body.whole);
      return;
    }
    const chunk = Buffer.alloc(64 * 1024);
    const more = () => {
      if (answered) return;
      if (req.write(chunk)) setImmediate(more);
      else req.once("drain", more);
    };
    more();
    setTimeout(() => {
      if (answered) return;
      answered = true;
      req.destroy();
      resolve({
        status: 0,
        text: "no answer in 5 s while the upload stayed open: the server is waiting for the whole body",
      });
    }, 5_000).unref();
  });
}

describe("a request body past its cap", () => {
  it("answers 413 during an open upload, whatever the handler made of the read", async () => {
    const seen: string[] = [];
    const s = await serve(
      {
        // Swallows the refused read and claims success: the server's 413
        // must win over it.
        assetPut: async (req) => {
          try {
            seen.push(`read ${(await req.body()).byteLength}`);
          } catch (e) {
            seen.push(`refused: ${(e as Error).message}`);
          }
          return { status: 200, json: { ref: "assets/x.webp" } };
        },
      },
      MB,
    );
    const r = await upload(s, "/api/assets", "POST", { stream: true });
    expect(r.status, r.text).toBe(413);
    expect(JSON.parse(r.text)).toEqual({
      reason: "bodyTooLarge",
      detail: "The request carried more than the Studio accepts here (1.0 MB).",
    });
    expect(seen).toEqual([`refused: the request body is past ${MB} bytes`]);
  });

  it("says what a handler threw after its body was refused", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const s = await serve(
        {
          assetPut: async (req) => {
            await req.body().catch(() => undefined);
            throw new Error("a second failure");
          },
        },
        MB,
      );
      const r = await upload(s, "/api/assets", "POST", { stream: true });
      expect(r.status, r.text).toBe(413);
      expect(logged).toHaveBeenCalledTimes(1);
      expect(String(logged.mock.calls[0]?.[0])).toContain(
        "POST /api/assets threw after its body was refused: a second failure",
      );
    } finally {
      logged.mockRestore();
    }
  });

  it("is refused from its Content-Length, before any byte is kept", async () => {
    const seen: string[] = [];
    const s = await serve({
      scenePut: async (req) => {
        await req.body().catch((e: Error) => seen.push(e.message));
        return { status: 200, json: {} };
      },
    });
    const r = await upload(s, "/api/takes/t/scene", "PUT", {
      stream: true,
      declared: JSON_BODY_MAX_BYTES + 1,
    });
    expect(r.status, r.text).toBe(413);
    expect(JSON.parse(r.text).detail).toContain("(16.0 MB)");
    expect(seen).toEqual([
      `the request body is past ${JSON_BODY_MAX_BYTES} bytes`,
    ]);
  });
});

describe("a request body within its cap", () => {
  it("is read whole at exactly the cap", async () => {
    const seen: number[] = [];
    const s = await serve(
      {
        assetPut: async (req) => {
          seen.push((await req.body()).byteLength);
          return { status: 200, json: {} };
        },
      },
      MB,
    );
    const r = await upload(s, "/api/assets", "POST", {
      whole: Buffer.alloc(MB),
    });
    expect(r.status, r.text).toBe(200);
    expect(seen).toEqual([MB]);
  });

  it("an asset upload has a cap of its own, above a JSON body's", async () => {
    const seen: number[] = [];
    const s = await serve({
      assetPut: async (req) => {
        seen.push((await req.body()).byteLength);
        return { status: 200, json: {} };
      },
    });
    const size = JSON_BODY_MAX_BYTES + MB;
    const r = await upload(s, "/api/assets", "POST", {
      whole: Buffer.alloc(size),
    });
    expect(r.status, r.text).toBe(200);
    expect(seen).toEqual([size]);
  });

  it("a second read answers the first one's bytes", async () => {
    const seen: number[] = [];
    const s = await serve({
      scenePut: async (req) => {
        const a = await req.body();
        const b = await req.body();
        seen.push(a.byteLength, b.byteLength);
        return { status: 200, json: {} };
      },
    });
    const r = await upload(s, "/api/takes/t/scene", "PUT", {
      whole: Buffer.from('{"a":1}'),
    });
    expect(r.status, r.text).toBe(200);
    expect(seen).toEqual([7, 7]);
  });
});

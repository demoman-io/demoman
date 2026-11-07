import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExportAnswer } from "@demoman/run-core";
import { describe, expect, it } from "vitest";
import type { ExportDeps } from "../src/executor/export.js";
import { linkTake } from "../src/executor/link.js";
import { HostedClient } from "../src/hosted/client.js";
import { writeCredential } from "../src/hosted/credential.js";

const CRED = {
  base: "https://demoman.io",
  token: "tok",
  login: "octo",
  workspace: { id: "w1", name: "octo" },
};
const MB = 1_000_000;

type Seen = { url: string; method: string; bytes: number };

/** A home with (or without) a sign-in, an export stub writing `size` bytes,
 *  and a fake service answering by route. */
function harness(o: {
  signedIn?: boolean;
  size?: number;
  me?: () => Response;
  part?: (n: number) => Response;
  complete?: () => Response;
}) {
  const home = mkdtempSync(join(tmpdir(), "dm-link-"));
  const out = mkdtempSync(join(tmpdir(), "dm-link-out-"));
  if (o.signedIn !== false) writeCredential(home, CRED);
  const seen: Seen[] = [];
  const exportArgs: Record<string, unknown>[] = [];
  const size = o.size ?? 2 * MB;
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status });
  const fetchImpl = async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const url = String(input);
    const body = init?.body;
    seen.push({
      url,
      method: init?.method ?? "GET",
      bytes: body instanceof Uint8Array ? body.length : 0,
    });
    const path = url.replace("https://demoman.io/api/hosted", "");
    if (path === "/me")
      return (
        o.me?.() ??
        json(200, {
          login: "octo",
          workspace: { id: "w1", name: "octo", plan: "free" },
          links: { active: 0, limit: 5 },
        })
      );
    if (path === "/uploads")
      return json(200, {
        id: "u1",
        partSize: 50 * MB,
        parts: Math.ceil(size / (50 * MB)),
      });
    const part = /^\/uploads\/u1\/parts\/(\d+)$/.exec(path);
    if (part)
      return (
        o.part?.(Number(part[1])) ?? json(200, { ok: true, n: Number(part[1]) })
      );
    if (path === "/uploads/u1/poster") return json(200, { ok: true });
    if (path === "/uploads/u1/complete")
      return (
        o.complete?.() ??
        json(200, {
          id: "u1",
          durationS: 2,
          tag: { flow: "f", video: "v", commit: null, dirty: null },
        })
      );
    if (path === "/links")
      return json(201, {
        id: "L".repeat(22),
        title: "Checkout",
        pageUrl: "https://demoman.io/v/x",
        fileUrl: "https://demoman.io/v/x.mp4",
        posterUrl: "https://demoman.io/v/x.png",
        createdAt: "2026-11-07T00:00:00Z",
        expiresAt: null,
      });
    throw new Error(`unexpected ${url}`);
  };
  const exportTake = (async (args: Record<string, unknown>) => {
    exportArgs.push(args);
    if (args.fileType === "stills") {
      const folder = join(out, "stills");
      mkdirSync(folder, { recursive: true });
      writeFileSync(
        join(folder, "01.png"),
        new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]),
      );
      return {
        outcome: "saved",
        fileType: "stills",
        takeId: "t1",
        folder: { path: folder, files: [{ name: "01.png", byteLength: 8 }] },
      } as unknown as ExportAnswer;
    }
    const path = join(out, "Checkout.mp4");
    writeFileSync(path, new Uint8Array(size));
    return {
      outcome: "saved",
      fileType: "mp4",
      takeId: "t1",
      file: { path, byteLength: size, downloadId: null },
    } as unknown as ExportAnswer;
  }) as never;
  const deps = {
    export: {} as ExportDeps,
    home,
    client: (c: typeof CRED) => new HostedClient(c, fetchImpl),
    exportTake,
  };
  return { deps, seen, exportArgs };
}

describe("link", () => {
  it("signed out refuses signedOut, says demoman login, and calls neither export nor fetch", async () => {
    const h = harness({ signedIn: false });
    const answer = await linkTake({ takeId: "t1" }, h.deps, () => {});
    expect(answer).toMatchObject({
      outcome: "refusedBeforeLink",
      reason: "signedOut",
    });
    expect((answer as { detail: string }).detail).toContain("demoman login");
    expect(h.seen.length).toBe(0);
    expect(h.exportArgs.length).toBe(0);
  });

  it("a revoked token (me answers 401) refuses signedOut before any export", async () => {
    const h = harness({
      me: () =>
        new Response(
          JSON.stringify({
            ok: false,
            reason: "signedOut",
            detail: "no longer valid",
          }),
          { status: 401 },
        ),
    });
    const answer = await linkTake({ takeId: "t1" }, h.deps, () => {});
    expect(answer).toMatchObject({
      outcome: "refusedBeforeLink",
      reason: "signedOut",
    });
    expect(h.exportArgs.length).toBe(0);
  });

  it("a free workspace at 5 of 5 refuses freeLimit before any export", async () => {
    const h = harness({
      me: () =>
        new Response(
          JSON.stringify({
            login: "octo",
            workspace: { id: "w1", name: "octo", plan: "free" },
            links: { active: 5, limit: 5 },
          }),
          { status: 200 },
        ),
    });
    const answer = await linkTake({ takeId: "t1" }, h.deps, () => {});
    expect(answer).toMatchObject({
      outcome: "refusedBeforeLink",
      reason: "freeLimit",
    });
    expect((answer as { detail: string }).detail).toContain("5 of 5");
    expect(h.exportArgs.length).toBe(0);
  });

  it("a 120 MB export uploads in 3 parts and answers the link", async () => {
    const h = harness({ size: 120 * MB });
    const answer = await linkTake(
      { takeId: "t1", title: "Checkout" },
      h.deps,
      () => {},
    );
    expect(answer).toMatchObject({
      outcome: "linked",
      link: { pageUrl: "https://demoman.io/v/x" },
    });
    const parts = h.seen.filter((s) => /\/parts\/\d+$/.test(s.url));
    expect(parts.map((p) => p.bytes)).toEqual([50 * MB, 50 * MB, 20 * MB]);
  });

  it("a part refused rateLimited answers notLinked at step upload with the server's detail", async () => {
    const h = harness({
      part: () =>
        new Response(
          JSON.stringify({
            ok: false,
            reason: "rateLimited",
            detail: "Too many uploads",
          }),
          { status: 429 },
        ),
    });
    const answer = await linkTake({ takeId: "t1" }, h.deps, () => {});
    expect(answer).toMatchObject({
      outcome: "notLinked",
      step: "upload",
      reason: "rateLimited",
      detail: "Too many uploads",
    });
  });

  it("complete refusing notDemoman answers notLinked at step complete", async () => {
    const h = harness({
      complete: () =>
        new Response(
          JSON.stringify({ ok: false, reason: "notDemoman", detail: "no tag" }),
          { status: 422 },
        ),
    });
    const answer = await linkTake({ takeId: "t1" }, h.deps, () => {});
    expect(answer).toMatchObject({
      outcome: "notLinked",
      step: "complete",
      reason: "notDemoman",
    });
  });

  it('the MP4 is exported without quality "share"', async () => {
    const h = harness({});
    await linkTake({ takeId: "t1" }, h.deps, () => {});
    const mp4 = h.exportArgs.find((a) => a.fileType !== "stills");
    expect(mp4, JSON.stringify(h.exportArgs)).toBeDefined();
    expect(mp4?.quality).toBeUndefined();
  });

  it("an expiry that is not a string or null refuses invalidLink with no request", async () => {
    const h = harness({});
    const answer = await linkTake(
      { takeId: "t1", expiresAt: 5 },
      h.deps,
      () => {},
    );
    expect(answer).toMatchObject({
      outcome: "refusedBeforeLink",
      reason: "invalidLink",
    });
    expect(h.seen.length).toBe(0);
  });
});

describe("the executor's link op", () => {
  it("answers a signed-out link without a browser or a request", async () => {
    const { createLocalExecutor } = await import("../src/executor/executor.js");
    const home = mkdtempSync(join(tmpdir(), "dm-link-exec-"));
    const executor = createLocalExecutor({
      home,
      wallpapersDir: home,
      log: () => {},
    });
    try {
      const out = await executor.request("link", { takeId: "t1" });
      expect(out).toMatchObject({
        ok: true,
        value: { outcome: "refusedBeforeLink", reason: "signedOut" },
      });
      expect(executor.browser()).toBeNull();
    } finally {
      await executor.close();
    }
  });
});

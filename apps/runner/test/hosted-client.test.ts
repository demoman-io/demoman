import { describe, expect, it } from "vitest";
import { HostedClient } from "../src/hosted/client.js";

const C = {
  base: "https://demoman.io",
  token: "tok",
  login: "octo",
  workspace: { id: "w1", name: "octo" },
};
const answer = (status: number, body: unknown) => async () =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

describe("HostedClient", () => {
  it("sends the token and answers the body", async () => {
    let auth: string | null = null;
    const client = new HostedClient(C, async (_url, init) => {
      auth = new Headers(init?.headers).get("Authorization");
      return new Response(
        JSON.stringify({
          login: "octo",
          workspace: { id: "w1", name: "octo", plan: "free" },
          links: { active: 0, limit: 5 },
        }),
        { status: 200 },
      );
    });
    const me = await client.me();
    expect(auth).toBe("Bearer tok");
    expect(me).toMatchObject({ ok: true, value: { login: "octo" } });
  });

  it("a 401 answers signedOut", async () => {
    const client = new HostedClient(
      C,
      answer(401, {
        ok: false,
        reason: "signedOut",
        detail: "This Demoman sign-in is no longer valid.",
      }),
    );
    expect(await client.me()).toMatchObject({ ok: false, reason: "signedOut" });
  });

  it("a bare 401 with no refusal body answers signedOut", async () => {
    const client = new HostedClient(
      C,
      async () => new Response("", { status: 401 }),
    );
    expect(await client.me()).toMatchObject({ ok: false, reason: "signedOut" });
  });

  it("a refused fetch answers unavailable with its message", async () => {
    const client = new HostedClient(C, async () => {
      throw new TypeError("fetch failed: ECONNREFUSED");
    });
    const out = await client.me();
    expect(out).toMatchObject({ ok: false, reason: "unavailable" });
    expect(!out.ok && out.detail).toContain("ECONNREFUSED");
  });

  it("a refusal body is passed through with its reason and detail", async () => {
    const client = new HostedClient(
      C,
      answer(403, { ok: false, reason: "freeLimit", detail: "5 of 5" }),
    );
    expect(
      await client.createLink({ upload: "u", title: "t", expiresAt: null }),
    ).toEqual({ ok: false, reason: "freeLimit", detail: "5 of 5" });
  });

  it("a 500 with no refusal body answers unavailable naming the status", async () => {
    const client = new HostedClient(
      C,
      async () => new Response("<html>Bad gateway</html>", { status: 502 }),
    );
    const out = await client.me();
    expect(out).toMatchObject({ ok: false, reason: "unavailable" });
    expect(!out.ok && out.detail).toContain("502");
  });
});

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readCredential, writeCredential } from "@demoman/runner/package";
import { describe, expect, it } from "vitest";
import { runLogin, runLogout } from "../src/login";

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

function harness(answers: Array<() => Response>) {
  const home = mkdtempSync(join(tmpdir(), "dm-login-"));
  const said: string[] = [];
  const asked: string[] = [];
  const opened: string[] = [];
  const fetchImpl = async (url: string | URL | Request) => {
    asked.push(String(url));
    const next = answers.shift();
    if (next === undefined)
      throw new Error(`unexpected request ${String(url)}`);
    return next();
  };
  return {
    home,
    said,
    asked,
    opened,
    deps: {
      home,
      base: "https://demoman.io",
      fetchImpl,
      say: (l: string) => void said.push(l),
      open: (u: string) => void opened.push(u),
      sleep: async () => {},
    },
  };
}

const START = {
  code: "secret",
  userCode: "ABCD-EFGH",
  verifyUrl: "https://demoman.io/cli/approve?user_code=ABCD-EFGH",
  expiresAt: "2099-01-01T00:00:00Z",
  intervalMs: 2000,
};

describe("demoman login", () => {
  it("prints the URL and code, polls until approved, writes the credential, says who", async () => {
    const h = harness([
      () => json(200, START),
      () => json(200, { pending: true }),
      () =>
        json(200, {
          token: "tok",
          login: "octo",
          workspace: { id: "w1", name: "octo" },
        }),
    ]);
    expect(await runLogin(h.deps)).toBe(0);
    expect(h.said.join("\n")).toContain(START.verifyUrl);
    expect(h.said.join("\n")).toContain("ABCD-EFGH");
    expect(h.opened).toEqual([START.verifyUrl]);
    expect(readCredential(h.home)).toEqual({
      ok: true,
      credential: {
        base: "https://demoman.io",
        token: "tok",
        login: "octo",
        workspace: { id: "w1", name: "octo" },
      },
    });
    expect(h.said.at(-1)).toBe("signed in as octo (workspace octo)");
  });

  it("loginExpired exits 1 saying so", async () => {
    const h = harness([
      () => json(200, START),
      () =>
        json(410, {
          ok: false,
          reason: "loginExpired",
          detail: "The sign-in was not approved within 10 minutes.",
        }),
    ]);
    expect(await runLogin(h.deps)).toBe(1);
    expect(h.said.join("\n")).toContain("not approved within 10 minutes");
    expect("none" in readCredential(h.home)).toBe(true);
  });

  it("already signed in says who and makes no request", async () => {
    const h = harness([]);
    writeCredential(h.home, {
      base: "https://demoman.io",
      token: "tok",
      login: "octo",
      workspace: { id: "w1", name: "octo" },
    });
    expect(await runLogin(h.deps)).toBe(0);
    expect(h.asked).toEqual([]);
    expect(h.said.join("\n")).toContain("already signed in as octo");
  });
});

describe("demoman logout", () => {
  it("revokes on the server and deletes the credential", async () => {
    const h = harness([() => json(200, { ok: true })]);
    writeCredential(h.home, {
      base: "https://demoman.io",
      token: "tok",
      login: "octo",
      workspace: { id: "w1", name: "octo" },
    });
    expect(await runLogout(h.deps)).toBe(0);
    expect(h.asked).toEqual(["https://demoman.io/api/hosted/cli/logout"]);
    expect("none" in readCredential(h.home)).toBe(true);
  });

  it("a server that cannot be reached still deletes the credential, says so, and exits 1", async () => {
    const h = harness([
      () => {
        throw new TypeError("fetch failed");
      },
    ]);
    writeCredential(h.home, {
      base: "https://demoman.io",
      token: "tok",
      login: "octo",
      workspace: { id: "w1", name: "octo" },
    });
    expect(await runLogout(h.deps)).toBe(1);
    expect("none" in readCredential(h.home)).toBe(true);
    expect(h.said.join("\n")).toMatch(/could not be revoked/);
  });
});

describe("demoman login, when the service stumbles", () => {
  it("a poll that fails once and then succeeds still signs in", async () => {
    const h = harness([
      () => json(200, START),
      () => json(503, { ok: false, reason: "unavailable", detail: "a blip" }),
      () =>
        json(429, { ok: false, reason: "rateLimited", detail: "slow down" }),
      () =>
        json(200, {
          token: "tok",
          login: "octo",
          workspace: { id: "w1", name: "octo" },
        }),
    ]);
    expect(await runLogin(h.deps)).toBe(0);
    expect(h.said.at(-1)).toBe("signed in as octo (workspace octo)");
  });

  it("a sign-in still pending past its expiresAt exits 1 saying it expired", async () => {
    const h = harness([
      () => json(200, { ...START, expiresAt: "2026-01-01T00:00:00Z" }),
      ...Array.from({ length: 5 }, () => () => json(200, { pending: true })),
    ]);
    const code = await runLogin({
      ...h.deps,
      now: () => Date.parse("2026-01-01T00:00:01Z"),
    });
    expect(code).toBe(1);
    expect(h.said.join("\n")).toMatch(/not approved/);
    expect("none" in readCredential(h.home)).toBe(true);
  });

  it("an address that is not http(s) is printed but not opened", async () => {
    const h = harness([
      () => json(200, { ...START, verifyUrl: "file:///etc/passwd" }),
      () =>
        json(200, {
          token: "tok",
          login: "octo",
          workspace: { id: "w1", name: "octo" },
        }),
    ]);
    await runLogin(h.deps);
    expect(h.opened).toEqual([]);
    expect(h.said.join("\n")).toContain("file:///etc/passwd");
  });
});

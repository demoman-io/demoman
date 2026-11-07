import { describe, expect, it } from "vitest";
import {
  type AppSpec,
  draftHoles,
  parseApp,
  serializeApp,
} from "../../src/app/file.js";

const FULL: AppSpec = {
  appVersion: 1,
  install: ["pnpm install", "pnpm build"],
  start: "pnpm dev",
  url: "http://localhost:3000/",
  timeoutSeconds: 90,
  env: { NODE_ENV: "development" },
  secrets: ["STRIPE_KEY"],
  services: {
    postgres: {
      image: "postgres:16",
      ports: ["5432:5432"],
      env: { POSTGRES_PASSWORD: "dev" },
      options: null,
    },
  },
};
const withChange = (change: object) =>
  JSON.stringify({ ...FULL, ...change }, null, 2);
const invalid = (text: string) => {
  const r = parseApp(text, ".demoman/app.json");
  if (r.ok) throw new Error("expected appInvalid");
  return r;
};

describe(".demoman/app.json", () => {
  it("round-trips a full file unchanged", () => {
    const text = serializeApp(FULL);
    expect(text.endsWith("}\n")).toBe(true);
    expect(Object.keys(JSON.parse(text))).toEqual(Object.keys(FULL));
    const r = parseApp(text, ".demoman/app.json");
    expect(r).toEqual({ ok: true, app: FULL });
    expect(serializeApp((r as { app: AppSpec }).app)).toBe(text);
  });

  it("names a missing start or an empty url", () => {
    const { start: _s, ...noStart } = FULL;
    expect(invalid(JSON.stringify(noStart)).field).toBe("start");
    expect(invalid(withChange({ url: "" })).field).toBe("url");
  });

  it("refuses a url that is not http(s)", () => {
    const r = invalid(withChange({ url: "ftp://localhost:3000" }));
    expect(r).toMatchObject({ reason: "appInvalid", field: "url" });
  });

  it("refuses a vendor-shaped secret in env and says to list it under secrets", () => {
    const r = invalid(
      withChange({ env: { STRIPE_KEY: "sk_live_abcdefgh12345678" } }),
    );
    expect(r.field).toBe("env.STRIPE_KEY");
    expect(r.detail).toContain("secrets");
  });

  it("refuses secret names GitHub would not take", () => {
    for (const name of ["GITHUB_TOKEN", "lower"]) {
      const r = invalid(withChange({ secrets: [name] }));
      expect(r.field).toBe("secrets.0");
      expect(r.detail).toContain("A-Z");
    }
  });

  it("says a newer Demoman wrote a newer appVersion", () => {
    const r = invalid(withChange({ appVersion: 2 }));
    expect(r.field).toBe("appVersion");
    expect(r.detail).toContain("newer Demoman");
  });

  it("refuses an unknown top-level key", () => {
    expect(invalid(withChange({ extra: 1 })).reason).toBe("appInvalid");
  });

  // Red when a hand-written file without env, secrets or services is
  // refused, and when a refusal's detail does not name its field (DEM-48).
  it("env, secrets and services default to empty", () => {
    const r = parseApp(
      JSON.stringify({
        appVersion: 1,
        install: [],
        start: "pnpm dev",
        url: "http://localhost:4401",
      }),
      ".demoman/app.json",
    );
    expect(r).toMatchObject({
      ok: true,
      app: { env: {}, secrets: [], services: {}, timeoutSeconds: 120 },
    });
  });

  it("a refusal's detail names its field", () => {
    const r = invalid(withChange({ env: [] }));
    expect(r.field).toBe("env");
    expect(r.detail).toMatch(/^\.demoman\/app\.json: env: /);
  });

  // Red when app.json cannot name a reset command, or writes one it was not
  // given (DEM-57).
  it("round-trips an optional reset after start, and writes none when absent", () => {
    const withReset = serializeApp({ ...FULL, reset: "pnpm reset" });
    expect(Object.keys(JSON.parse(withReset))).toEqual([
      "appVersion",
      "install",
      "start",
      "reset",
      "url",
      "timeoutSeconds",
      "env",
      "secrets",
      "services",
    ]);
    const r = parseApp(withReset, ".demoman/app.json");
    expect(r).toMatchObject({ ok: true, app: { reset: "pnpm reset" } });
    expect(serializeApp(FULL)).not.toContain("reset");
  });

  it("names the draft's holes", () => {
    const { start: _s, url: _u, ...rest } = FULL;
    expect(draftHoles({ ...rest, start: null, url: null })).toEqual([
      "start",
      "url",
    ]);
    expect(draftHoles({ ...rest, start: "x", url: null })).toEqual(["url"]);
  });
});

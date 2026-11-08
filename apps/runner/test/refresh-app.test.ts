import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  APP_FILE,
  type AppSpec,
  FLOWS_DIR,
  type KeptVideo,
  keptFileName,
  serializeKept,
} from "@demoman/run-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppStarted } from "../src/executor/app-start.js";
import { appPlanFor, withApp } from "../src/executor/refresh-app.js";

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "refresh-app-"));
});
afterEach(() => rm(root, { recursive: true, force: true }));

const app = (over: Partial<AppSpec> = {}): AppSpec => ({
  appVersion: 1,
  install: [],
  start: "npm start",
  url: "http://localhost:3000/",
  timeoutSeconds: 10,
  env: {},
  secrets: [],
  services: {},
  ...over,
});
const writeApp = (a: AppSpec) =>
  mkdir(join(root, ".demoman"), { recursive: true }).then(() =>
    writeFile(join(root, APP_FILE), JSON.stringify(a)),
  );
const writeFlow = async (name: string, target: string) => {
  const kept = {
    keptVersion: 2,
    flow: `0b6e1c52-7d3a-4f0e-9a41-2c8d5e6f7a9${name.length % 10}`,
    deliver: "commit",
    name,
    script: {
      scriptVersion: 1,
      name,
      target,
      viewport: { width: 1280, height: 800 },
      steps: [{ do: "waitForLoad" }],
    },
    scale: 1,
    logo: null,
    wallpaper: null,
    outputs: [
      { path: "docs/o.mp4", fileType: "mp4", aspect: "16:9", quality: "share" },
    ],
    report: null,
  } as unknown as KeptVideo;
  await mkdir(join(root, FLOWS_DIR), { recursive: true });
  await writeFile(
    join(root, FLOWS_DIR, keptFileName(name)),
    serializeKept(kept),
  );
};

describe("appPlanFor", () => {
  it("is none, said, with no app.json", async () => {
    expect(await appPlanFor(root, {})).toEqual({
      kind: "none",
      said: `no ${APP_FILE}; the app must already answer`,
    });
  });

  it("starts the app when its origin serves every flow", async () => {
    await writeApp(app());
    await writeFlow("One", "http://localhost:3000/a");
    await writeFlow("Two", "http://localhost:3000/b");
    expect(await appPlanFor(root, {})).toEqual({ kind: "start", app: app() });
  });

  // Review Focus 4. Red when origins are compared by host (port dropped).
  it("refuses, naming both origins and the flow at the unserved one", async () => {
    await writeApp(app());
    await writeFlow("One", "http://localhost:3000/a");
    await writeFlow("Other", "http://localhost:4000/b");
    const plan = await appPlanFor(root, {});
    expect(plan.kind).toBe("refused");
    if (plan.kind !== "refused") return;
    expect(plan.reason).toBe("appOriginMismatch");
    expect(plan.detail).toContain("Other (http://localhost:4000)");
    expect(plan.detail).toContain("http://localhost:3000");
    expect(plan.detail).not.toContain("One");
  });

  it("refuses an invalid app.json", async () => {
    await mkdir(join(root, ".demoman"), { recursive: true });
    await writeFile(join(root, APP_FILE), "{");
    const plan = await appPlanFor(root, {});
    expect(plan).toMatchObject({ kind: "refused", reason: "appInvalid" });
  });

  it("with --base-url and no now, is none with no note", async () => {
    await writeApp(app());
    const plan = await appPlanFor(root, { baseUrl: "http://x.test" });
    expect(plan).toEqual({
      kind: "none",
      said: `--base-url given; ${APP_FILE} not used`,
    });
  });

  // Red when a pin the repo asked for silently does not happen (DEM-79).
  it("with --base-url and now set, is none and notes now was not used", async () => {
    await writeApp(app({ now: "2026-11-06T09:00:00Z" }));
    const plan = await appPlanFor(root, { baseUrl: "http://x.test" });
    expect(plan.kind).toBe("none");
    const note = plan.kind === "none" ? plan.note : undefined;
    expect(note).toContain("2026-11-06T09:00:00Z");
    expect(note).toContain("--base-url");
  });

  it("with --base-url and an invalid app.json, is none and never refuses", async () => {
    await mkdir(join(root, ".demoman"), { recursive: true });
    await writeFile(join(root, APP_FILE), "{");
    const plan = await appPlanFor(root, { baseUrl: "http://x.test" });
    expect(plan).toEqual({
      kind: "none",
      said: `--base-url given; ${APP_FILE} not used`,
    });
  });
});

describe("withApp", () => {
  const o = (ci: boolean) => ({
    root,
    env: {},
    ci,
    log: () => {},
  });
  const started = (
    stop: () => Promise<string[]> = async () => [],
  ): AppStarted => ({
    reused: false,
    said: "started the app",
    seconds: 1,
    stop,
    reset: async () => ({ ok: true }),
    pinnedNow: null,
  });

  // Red when the run cannot reach the app's reset (DEM-57).
  it("hands the run the started app's reset, and a no-op with no app", async () => {
    const reset = vi.fn(async () => ({ ok: true as const }));
    const startApp = vi.fn(async () => ({ ...started(), reset }));
    const r = await withApp(
      { kind: "start", app: app() },
      o(true),
      async (doReset) => doReset(),
      { startApp },
    );
    expect(r).toMatchObject({ ok: true, value: { ok: true } });
    expect(reset).toHaveBeenCalledTimes(1);
    const none = await withApp(
      { kind: "none", said: "" } as never,
      o(true),
      async (doReset) => doReset(),
    );
    expect(none).toMatchObject({ ok: true, value: { ok: true } });
  });

  // Red when the run cannot learn the instant the started app was given (DEM-79).
  it("withApp hands the started app's pinnedNow to run, and a none plan's note to lines", async () => {
    const startApp = vi.fn(async () => ({
      ...started(),
      pinnedNow: "2026-11-06T09:00:00Z",
    }));
    const r = await withApp(
      { kind: "start", app: app() },
      o(true),
      async (_reset, pinnedNow) => pinnedNow,
      { startApp },
    );
    expect(r).toMatchObject({ ok: true, value: "2026-11-06T09:00:00Z" });
    const none = await withApp(
      { kind: "none", said: "s", note: "now was not used" },
      o(true),
      async (_reset, pinnedNow) => pinnedNow,
    );
    expect(none).toMatchObject({
      ok: true,
      value: null,
      lines: ["now was not used"],
    });
    const plain = await withApp({ kind: "none", said: "s" }, o(true), async () => 1);
    expect(plain).toMatchObject({ ok: true, lines: [] });
  });

  it("stops the app when run throws", async () => {
    const stop = vi.fn(async () => [] as string[]);
    const startApp = vi.fn(async () => started(stop));
    await expect(
      withApp(
        { kind: "start", app: app() },
        o(false),
        async () => {
          throw new Error("boom");
        },
        { startApp },
      ),
    ).rejects.toThrow("boom");
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it("says the app started and what it could not stop", async () => {
    const startApp = vi.fn(async () => started(async () => ["server"]));
    const r = await withApp(
      { kind: "start", app: app() },
      o(false),
      async () => 7,
      { startApp },
    );
    expect(r).toEqual({
      ok: true,
      value: 7,
      lines: ["started the app", "could not stop server"],
    });
  });

  it("does not run when the app does not start", async () => {
    const run = vi.fn(async () => 1);
    const startApp = vi.fn(async () => ({
      reason: "appInstallFailed" as const,
      detail: "npm ci failed",
      tail: "",
    }));
    const r = await withApp({ kind: "start", app: app() }, o(true), run, {
      startApp,
    });
    expect(r).toMatchObject({
      ok: false,
      refusal: { reason: "appInstallFailed", detail: "npm ci failed" },
    });
    expect(run).not.toHaveBeenCalled();
  });

  it("refuses a refused plan without starting", async () => {
    const startApp = vi.fn();
    const r = await withApp(
      { kind: "refused", reason: "appOriginMismatch", detail: "d" },
      o(false),
      async () => 1,
      { startApp },
    );
    expect(r).toEqual({
      ok: false,
      refusal: { reason: "appOriginMismatch", detail: "d" },
    });
    expect(startApp).not.toHaveBeenCalled();
  });

  // Decision 7. Red when `services: "docker"` is passed off CI.
  it("off CI reuses and provides services; on CI owns the port", async () => {
    const seen: unknown[] = [];
    const startApp = vi.fn(async (_a: AppSpec, opts: unknown) => {
      seen.push(opts);
      return started();
    });
    for (const ci of [false, true])
      await withApp({ kind: "start", app: app() }, o(ci), async () => 1, {
        startApp,
      });
    expect(seen).toMatchObject([
      { mode: "reuse", services: "provided" },
      { mode: "own", services: "provided" },
    ]);
  });

  // Red when `services: "docker"` is passed off CI: the stub is then called.
  it("off CI the real startApp never runs docker", async () => {
    const docker = vi.fn(async () => ({ code: 1, stdout: "", stderr: "" }));
    const fetchMock = vi.fn(async () => {
      throw new Error("refused");
    });
    const r = await withApp(
      {
        kind: "start",
        app: app({
          start: "node -e 0",
          timeoutSeconds: 1,
          services: {
            postgres: {
              image: "postgres",
              ports: ["5432:5432"],
              env: {},
              options: null,
            },
          },
        }),
      },
      o(false),
      async () => 1,
      { docker, fetch: fetchMock as unknown as typeof fetch },
    );
    expect(r).toMatchObject({ ok: false });
    expect(docker).not.toHaveBeenCalled();
  });

  it("off CI an unanswered app names its services and ports", async () => {
    const svc = {
      postgres: {
        image: "postgres",
        ports: ["5432:5432"],
        env: {},
        options: null,
      },
      redis: { image: "redis", ports: ["6379:6379"], env: {}, options: null },
    };
    const refuse = (reason: "appNeverAnswered") => async () => ({
      reason,
      detail: "the app did not answer on http://localhost:3000",
      tail: "",
    });
    const withServices = await withApp(
      { kind: "start", app: app({ services: svc }) },
      o(false),
      async () => 1,
      { startApp: refuse("appNeverAnswered") },
    );
    expect(withServices).toMatchObject({
      ok: false,
      refusal: {
        detail: `the app did not answer on http://localhost:3000; ${APP_FILE} needs postgres (5432) and redis (6379): start them, then run refresh again`,
      },
    });
    const without = await withApp(
      { kind: "start", app: app() },
      o(false),
      async () => 1,
      { startApp: refuse("appNeverAnswered") },
    );
    expect(without).toMatchObject({
      ok: false,
      refusal: { detail: "the app did not answer on http://localhost:3000" },
    });
  });
});

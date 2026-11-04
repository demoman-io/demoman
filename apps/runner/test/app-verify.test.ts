// verifySetup with its app and refresh stubbed: a real temp git repo and a
// real worktree (git is fast), so what reaches the clean checkout is read off
// the disk rather than assumed.
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  APP_FILE,
  type AppSpec,
  FLOWS_DIR,
  type KeptVideo,
  keptFileName,
  serializeApp,
  serializeKept,
} from "@demoman/run-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  AppStarted,
  AppStartRefusal,
  startApp,
} from "../src/executor/app-start.js";
import { verifySetup } from "../src/executor/app-verify.js";
import type { RefreshResult, RefreshVideo } from "../src/executor/refresh.js";
import { execGit, type GitRunner } from "../src/executor/repo.js";

const app = (over: Partial<AppSpec> = {}): AppSpec => ({
  appVersion: 1,
  install: [],
  start: "node server.mjs",
  url: "http://127.0.0.1:3999/",
  timeoutSeconds: 10,
  env: {},
  secrets: [],
  services: {},
  ...over,
});
const SHORT_ID = randomUUID();
const LONG_ID = randomUUID();
const flowText = (name: string, steps: number) =>
  serializeKept({
    keptVersion: 2,
    flow: steps === 1 ? SHORT_ID : LONG_ID,
    deliver: "commit",
    name,
    script: {
      scriptVersion: 1,
      name,
      target: "http://127.0.0.1:3999/",
      viewport: { width: 1280, height: 800 },
      steps: Array.from({ length: steps }, () => ({ do: "waitForLoad" })),
    },
    scale: 1,
    logo: null,
    wallpaper: null,
    outputs: [
      { path: "docs/o.mp4", fileType: "mp4", aspect: "16:9", quality: "share" },
    ],
    report: null,
  } as unknown as KeptVideo);
const BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 255]);
const files = () => [
  { path: APP_FILE, text: serializeApp(app()) },
  { path: `${FLOWS_DIR}/${keptFileName("Long")}`, text: flowText("Long", 3) },
  { path: `${FLOWS_DIR}/${keptFileName("Short")}`, text: flowText("Short", 1) },
  { path: ".demoman/receipts/short.screens/final.png", text: BYTES },
];
const video = (over: Partial<RefreshVideo> = {}): RefreshVideo => ({
  name: "Short",
  file: `${FLOWS_DIR}/${keptFileName("Short")}`,
  flow: null,
  deliver: "commit",
  outcome: "uncompared",
  detail: "nothing to compare against; delivered as new",
  outputs: [],
  line: null,
  notes: [],
  video: null,
  filmedCode: null,
  sameAs: null,
  files: [],
  screens: null,
  report: null,
  ...over,
});

let root: string;
/** Every git call verifySetup made, and an override per subcommand. */
let gitCalls: string[][];
let gitOverride: Partial<Record<string, Awaited<ReturnType<GitRunner>>>> = {};
const git: GitRunner = async (args, cwd, env) => {
  gitCalls.push(args);
  const over = gitOverride[args.slice(0, 2).join(" ")];
  return over ?? execGit(args, cwd, env);
};
/** What the stubbed app and refresh saw, and the checkout as they found it. */
let started: { app: AppSpec; o: Parameters<typeof startApp>[1] }[];
let stops: number;
let refreshed: {
  args: Parameters<Parameters<typeof verifySetup>[1]["refresh"]>[0];
  env: NodeJS.ProcessEnv;
}[];
let seen: Map<string, string | Buffer | null>;
let dockerCalls: string[][];
let leftToStop: string[];

const look = async (dir: string) => {
  for (const p of [
    ...files().map((f) => f.path),
    "README.md",
    ".demoman/secrets.env",
  ])
    seen.set(p, await readFile(join(dir, p)).catch(() => null));
};
const startStub =
  (
    answer: (
      o: Parameters<typeof startApp>[1],
    ) => Promise<AppStarted | AppStartRefusal> = async () => ({
      reused: false,
      said: "started the app with `node server.mjs` from .demoman/app.json",
      seconds: 2.5,
      stop: async () => {
        stops++;
        return leftToStop;
      },
    }),
  ): typeof startApp =>
  async (a, o) => {
    started.push({ app: a, o });
    await look(o.root);
    return answer(o);
  };
const refreshStub =
  (
    answer: () => Promise<RefreshResult> = async () => ({
      videos: [video()],
    }),
  ) =>
  async (
    args: Parameters<Parameters<typeof verifySetup>[1]["refresh"]>[0],
    env: NodeJS.ProcessEnv,
  ) => {
    refreshed.push({ args, env });
    if (!seen.size) await look(args.repoRoot);
    return answer();
  };
const deps = (
  over: Partial<Parameters<typeof verifySetup>[1]> = {},
): Parameters<typeof verifySetup>[1] => ({
  git,
  startApp: startStub(),
  refresh: refreshStub(),
  docker: async (args) => {
    dockerCalls.push(args);
    return { code: 0 };
  },
  log: () => undefined,
  ...over,
});
const removeCalls = () =>
  gitCalls.filter((a) => a[0] === "worktree" && a[1] === "remove");
/** The checkout the run used, read off what the stubs were handed. */
const checkout = () =>
  started[0]?.o.root ?? (refreshed[0]?.args.repoRoot as string);

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "app-verify-"));
  const g = (...a: string[]) =>
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], {
      cwd: root,
    });
  g("init", "-q");
  await writeFile(join(root, "README.md"), "committed\n");
  await writeFile(join(root, ".gitignore"), ".demoman/secrets.env\n");
  g("add", "-A");
  g("commit", "-q", "-m", "x");
  // The person's own ignored secrets: a clean checkout must not carry them.
  await mkdir(join(root, ".demoman"), { recursive: true });
  await writeFile(join(root, ".demoman/secrets.env"), "DEMOMAN_SECRET_A=pw\n");
  gitCalls = [];
  gitOverride = {};
  started = [];
  stops = 0;
  refreshed = [];
  seen = new Map();
  dockerCalls = [];
  leftToStop = [];
});
afterEach(async () => {
  const dir = started[0]?.o.root ?? refreshed[0]?.args.repoRoot;
  if (dir) await rm(dir, { recursive: true, force: true });
  await rm(root, { recursive: true, force: true });
});

describe("verifySetup", () => {
  // Red when files are not written into the worktree, or the app or refresh
  // is pointed at the real root (which holds secrets.env and no flows).
  it("checks out HEAD clean, writes every file, starts the app there and refreshes the shortest flow", async () => {
    leftToStop = ["the process `node server.mjs`"];
    const r = await verifySetup(
      { root, files: files(), target: { app: app() }, secrets: {} },
      deps(),
    );
    const tmp = checkout();
    expect(tmp).not.toBe(root);
    // The premise: the real root holds the ignored secrets file.
    expect(existsSync(join(root, ".demoman/secrets.env"))).toBe(true);
    expect(seen.get(".demoman/secrets.env")).toBeNull();
    expect(seen.get("README.md")?.toString()).toBe("committed\n");
    for (const f of files())
      expect(Buffer.from(seen.get(f.path) as Buffer)).toEqual(
        Buffer.from(f.text),
      );
    expect(gitCalls[0]).toEqual(["worktree", "add", "--detach", tmp, "HEAD"]);
    expect(started[0]?.o).toMatchObject({
      root: tmp,
      mode: "own",
      services: "docker",
    });
    expect(refreshed).toHaveLength(1);
    const args = refreshed[0]?.args;
    expect(args).toMatchObject({
      repoRoot: tmp,
      only: ["Short"],
      library: "throwaway",
    });
    expect(args?.outDir).toEqual(expect.any(String));
    expect(args?.outDir).not.toContain(tmp);
    expect(args && "baseUrl" in args).toBe(false);
    expect(r).toEqual({
      passed: true,
      flow: "Short",
      outcome: "uncompared",
      recordSeconds: expect.any(Number),
      appSeconds: 2.5,
      lines: [
        "started the app with `node server.mjs` from .demoman/app.json",
        "could not stop the process `node server.mjs`",
      ],
    });
    expect(stops).toBe(1);
    expect(removeCalls()).toEqual([["worktree", "remove", "--force", tmp]]);
    expect(existsSync(tmp)).toBe(false);
    expect(existsSync(args?.outDir as string)).toBe(false);
    // No services: Docker is never asked.
    expect(dockerCalls).toEqual([]);
  });

  // Red when `flow` is ignored for the shortest.
  it("refreshes the flow it is given", async () => {
    await verifySetup(
      {
        root,
        files: files(),
        flow: "Long",
        target: { app: app() },
        secrets: {},
      },
      deps({
        refresh: refreshStub(async () => ({
          videos: [video({ name: "Long" })],
        })),
      }),
    );
    expect(refreshed[0]?.args.only).toEqual(["Long"]);
  });

  // Red when process.env is passed whole, or secrets reach only one side.
  it("hands secrets to the app and the refresh through env alone, and no other DEMOMAN_SECRET_", async () => {
    process.env.DEMOMAN_SECRET_UNLISTED = "leak";
    try {
      await verifySetup(
        {
          root,
          files: files(),
          target: { app: app() },
          secrets: { DEMOMAN_SECRET_ADMIN: "pw", APP_KEY: "k" },
        },
        deps(),
      );
    } finally {
      delete process.env.DEMOMAN_SECRET_UNLISTED;
    }
    for (const env of [started[0]?.o.env, refreshed[0]?.env]) {
      expect(env?.DEMOMAN_SECRET_ADMIN).toBe("pw");
      expect(env?.APP_KEY).toBe("k");
      expect(env && "DEMOMAN_SECRET_UNLISTED" in env).toBe(false);
      // The rest of the environment still goes: PATH starts the app.
      expect(env?.PATH).toBe(process.env.PATH);
    }
  });

  // Red when a refusal is reported as passing, or the tail is dropped.
  it("maps an app refusal to step app, keeps its tail, never refreshes, and removes the checkout", async () => {
    const r = await verifySetup(
      { root, files: files(), target: { app: app() }, secrets: {} },
      deps({
        startApp: startStub(async () => ({
          reason: "appStartExited",
          detail: "`node server.mjs` exited with code 1",
          tail: "Error: boom",
        })),
      }),
    );
    expect(r).toEqual({
      passed: false,
      step: "app",
      reason: "appStartExited",
      detail: "`node server.mjs` exited with code 1",
      tail: "Error: boom",
    });
    expect(refreshed).toEqual([]);
    expect(removeCalls()).toEqual([
      ["worktree", "remove", "--force", checkout()],
    ]);
    expect(existsSync(checkout())).toBe(false);
  });

  // Red when a failed video reads as a pass.
  it("maps a failed video to step refresh with the video's own detail, and stops the app", async () => {
    const r = await verifySetup(
      { root, files: files(), target: { app: app() }, secrets: {} },
      deps({
        refresh: refreshStub(async () => ({
          videos: [
            video({
              outcome: "failed",
              detail: "signedOut: the page asked for a sign-in",
            }),
          ],
        })),
      }),
    );
    expect(r).toEqual({
      passed: false,
      step: "refresh",
      reason: "refreshFailed",
      detail: "signedOut: the page asked for a sign-in",
      tail: "",
    });
    expect(stops).toBe(1);
    expect(removeCalls()).toHaveLength(1);
    expect(existsSync(checkout())).toBe(false);
  });

  // Red when a throw skips the cleanup, or escapes as a throw.
  it("answers a refresh that throws as a failure, and still stops the app and removes the checkout", async () => {
    const r = await verifySetup(
      { root, files: files(), target: { app: app() }, secrets: {} },
      deps({
        refresh: refreshStub(async () => {
          throw new Error("browser crashed");
        }),
      }),
    );
    expect(r).toMatchObject({
      passed: false,
      step: "refresh",
      reason: "checkThrew",
      detail: expect.stringContaining("browser crashed"),
    });
    expect(stops).toBe(1);
    expect(removeCalls()).toHaveLength(1);
    expect(existsSync(checkout())).toBe(false);
  });

  // Red when git's refusal to add the worktree is not said with its output.
  it("maps a checkout git refuses to step checkout, with git's output as the tail", async () => {
    gitOverride["worktree add"] = {
      code: 128,
      stdout: "",
      stderr: "fatal: invalid reference: HEAD",
    };
    const r = await verifySetup(
      { root, files: files(), target: { app: app() }, secrets: {} },
      deps(),
    );
    expect(r).toMatchObject({
      passed: false,
      step: "checkout",
      reason: "checkoutFailed",
      detail: expect.stringContaining("code 128"),
      tail: "fatal: invalid reference: HEAD",
    });
    expect(started).toEqual([]);
    expect(refreshed).toEqual([]);
  });

  // Red when a failed removal is swallowed.
  it("says a checkout it could not remove, naming the folder", async () => {
    gitOverride["worktree remove"] = {
      code: 1,
      stdout: "",
      stderr: "fatal: not a working tree",
    };
    const r = await verifySetup(
      { root, files: files(), target: { app: app() }, secrets: {} },
      deps(),
    );
    const tmp = checkout();
    expect(r).toMatchObject({ passed: true });
    expect(r && "lines" in r && r.lines).toContainEqual(
      expect.stringMatching(
        new RegExp(
          `^could not remove the checkout at ${tmp} \\(fatal: not a working tree\\)`,
        ),
      ),
    );
    await execGit(["worktree", "remove", "--force", tmp], root);
  });

  // Red when skipped fires without services, or on a Docker that answers.
  it("skips, naming Docker, when the app needs services and Docker does not answer", async () => {
    const withDb = app({
      services: {
        postgres: {
          image: "postgres:16",
          ports: ["5432:5432"],
          env: {},
          options: null,
        },
      },
    });
    const r = await verifySetup(
      { root, files: files(), target: { app: withDb }, secrets: {} },
      deps({
        docker: async (args) => {
          dockerCalls.push(args);
          return { code: 1 };
        },
      }),
    );
    expect(r).toEqual({ skipped: expect.stringContaining("Docker") });
    expect(r).toEqual({ skipped: expect.stringContaining("postgres") });
    expect(dockerCalls).toEqual([["info"]]);
    expect(gitCalls).toEqual([]);
    expect(started).toEqual([]);
  });

  // Finding 13: a `docker info` stopped at its timeout reads as not answering.
  it("says a docker info past its timeout as not answering in time", async () => {
    const r = await verifySetup(
      {
        root,
        files: files(),
        target: {
          app: app({
            services: {
              postgres: {
                image: "postgres:16",
                ports: [],
                env: {},
                options: null,
              },
            },
          }),
        },
        secrets: {},
      },
      deps({ docker: async () => ({ code: 124 }) }),
    );
    expect(r).toEqual({
      skipped: expect.stringContaining(
        "`docker info` did not answer within 20 s",
      ),
    });
  });

  it("starts the app when it needs services and Docker answers", async () => {
    const withDb = app({
      services: {
        postgres: {
          image: "postgres:16",
          ports: ["5432:5432"],
          env: {},
          options: null,
        },
      },
    });
    const r = await verifySetup(
      { root, files: files(), target: { app: withDb }, secrets: {} },
      deps(),
    );
    expect(r).toMatchObject({ passed: true });
    expect(started).toHaveLength(1);
  });

  // Red when a deployment target starts an app, or drops its URL.
  it("refreshes a deployment at its URL and starts nothing", async () => {
    const r = await verifySetup(
      {
        root,
        files: files(),
        target: {
          baseUrl: "https://staging.example.com",
          environment: "staging",
        },
        secrets: {},
      },
      deps(),
    );
    expect(started).toEqual([]);
    expect(refreshed[0]?.args).toMatchObject({
      repoRoot: expect.any(String),
      only: ["Short"],
      baseUrl: "https://staging.example.com",
      library: "throwaway",
    });
    expect(r).toMatchObject({ passed: true, appSeconds: 0, lines: [] });
    expect(removeCalls()).toHaveLength(1);
  });

  // R3. Red when an abort waits for the refresh, leaves the app up, or
  // leaves the checkout behind.
  it("stops mid-refresh on abort: stops the app, removes the checkout, and says so", async () => {
    const stop = new AbortController();
    const r = await verifySetup(
      { root, files: files(), target: { app: app() }, secrets: {} },
      deps({
        signal: stop.signal,
        refresh: refreshStub(() => {
          stop.abort();
          return new Promise<RefreshResult>(() => undefined);
        }),
      }),
    );
    const tmp = checkout();
    expect(r).toEqual({
      passed: false,
      step: "refresh",
      reason: "checkStopped",
      detail: `stopped; removed the checkout at ${tmp}`,
      tail: "",
    });
    expect(stops).toBe(1);
    expect(removeCalls()).toEqual([["worktree", "remove", "--force", tmp]]);
    expect(existsSync(tmp)).toBe(false);
  });
  // R3, Finding 1. Red when the app an aborted start finishes with is not
  // kept to be stopped (Ctrl-C during an install leaves it running).
  it("stops during the app start on abort: waits for the start, stops what it started, removes the checkout", async () => {
    const stop = new AbortController();
    const r = await verifySetup(
      { root, files: files(), target: { app: app() }, secrets: {} },
      deps({
        signal: stop.signal,
        startApp: startStub(async () => {
          stop.abort();
          await new Promise((later) => setTimeout(later, 20));
          return {
            reused: false,
            said: "started",
            seconds: 1,
            stop: async () => {
              stops++;
              return [];
            },
          };
        }),
      }),
    );
    const tmp = checkout();
    expect(r).toEqual({
      passed: false,
      step: "app",
      reason: "checkStopped",
      detail: `stopped; removed the checkout at ${tmp}`,
      tail: "",
    });
    expect(stops).toBe(1);
    expect(refreshed).toEqual([]);
    expect(removeCalls()).toEqual([["worktree", "remove", "--force", tmp]]);
    expect(existsSync(tmp)).toBe(false);
  });

  // R18. Red when a name that starts with two dots is read as leaving the
  // repo, or a path that leaves it is written.
  it("writes a root file named ..env, and refuses a path outside the repo with the next action", async () => {
    const ok = await verifySetup(
      {
        root,
        files: [...files(), { path: "..env", text: "A=1\n" }],
        target: { app: app() },
        secrets: {},
      },
      deps(),
    );
    expect(ok).toMatchObject({ passed: true });
    started = [];
    refreshed = [];
    gitCalls = [];
    const r = await verifySetup(
      {
        root,
        files: [...files(), { path: "../escape.txt", text: "x" }],
        target: { app: app() },
        secrets: {},
      },
      deps(),
    );
    expect(r).toEqual({
      passed: false,
      step: "checkout",
      reason: "checkoutFailed",
      detail:
        "../escape.txt is outside the repo, so it was not written; give its path from the repo's root, then run again",
      tail: "",
    });
    expect(started).toEqual([]);
    expect(removeCalls()).toHaveLength(1);
  });

  // R18. Red when an empty refresh answer reads as a pass, or names no next
  // action.
  it("fails when refresh answers no video for the flow, naming the command to see why", async () => {
    const r = await verifySetup(
      { root, files: files(), target: { app: app() }, secrets: {} },
      deps({ refresh: refreshStub(async () => ({ videos: [] })) }),
    );
    expect(r).toEqual({
      passed: false,
      step: "refresh",
      reason: "refreshFailed",
      detail:
        'refresh answered no video for "Short", so whether it records is unknown; run `npx demoman refresh "Short"` in the repo to see why, then run again',
      tail: "",
    });
  });
});

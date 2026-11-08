import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AppSpec } from "@demoman/run-core";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  type AppStartDeps,
  type AppStarted,
  type AppStartRefusal,
  startApp,
  whoListens,
} from "../src/executor/app-start.js";

const SERVER = fileURLToPath(
  new URL("./fixtures/app-start/server.mjs", import.meta.url),
);
const START = `node ${SERVER}`;

/** A port nothing listens on: the OS hands one out, then it is released. */
async function freePort(): Promise<number> {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const { port } = s.address() as AddressInfo;
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}
async function canListen(port: number): Promise<boolean> {
  const s = createServer();
  const ok = await new Promise<boolean>((r) => {
    s.once("error", () => r(false));
    s.listen(port, () => r(true));
  });
  if (ok) await new Promise<void>((r) => s.close(() => r()));
  return ok;
}
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
const isRefusal = (r: AppStarted | AppStartRefusal): r is AppStartRefusal =>
  "reason" in r;

let port: number;
let root: string;
let url: string;
const children: ChildProcess[] = [];
/** Pid files a detached fixture child writes; afterEach ends each one. */
const pidFiles: string[] = [];
const servers: Server[] = [];
const toStop: AppStarted[] = [];

/** The real spawn, with every child it made kept for the test to see and for
 *  afterEach to end. */
const spawnSpy = (() => {
  const calls: string[] = [];
  const fn = ((cmd: string, args: string[], opts: object) => {
    calls.push(args.join(" "));
    const c = spawn(cmd, args, opts);
    children.push(c);
    return c;
  }) as unknown as AppStartDeps["spawn"];
  return { fn, calls };
})();

const app = (over: Partial<AppSpec> = {}): AppSpec => ({
  appVersion: 1,
  install: [],
  start: START,
  url,
  timeoutSeconds: 10,
  env: {},
  secrets: [],
  services: {},
  ...over,
});
const opts = (over: Partial<Parameters<typeof startApp>[1]> = {}) => ({
  root,
  env: { ...process.env, PORT: String(port), MODE: "normal" },
  mode: "own" as const,
  services: "provided" as const,
  log: () => {},
  ...over,
});

beforeAll(async () => {
  // Fixture premise: run by hand, MODE=normal answers 200 on PORT.
  const p = await freePort();
  const c = spawn(process.execPath, [SERVER], {
    env: { ...process.env, PORT: String(p), MODE: "normal" },
    stdio: "ignore",
  });
  try {
    let status = 0;
    for (let i = 0; i < 100 && status === 0; i++) {
      status = await fetch(`http://127.0.0.1:${p}/`).then(
        (r) => r.status,
        () => new Promise<number>((r) => setTimeout(() => r(0), 50)),
      );
    }
    expect(status).toBe(200);
  } finally {
    c.kill("SIGKILL");
  }
});

beforeEach(async () => {
  port = await freePort();
  url = `http://127.0.0.1:${port}/`;
  root = await mkdtemp(join(tmpdir(), "app-start-"));
  spawnSpy.calls.length = 0;
  // Premise of every case: nothing answers on the port before it starts.
  expect(await canListen(port)).toBe(true);
});

afterEach(async () => {
  for (const s of toStop.splice(0)) await s.stop();
  for (const c of children.splice(0)) {
    if (c.pid && c.exitCode === null && c.signalCode === null) {
      try {
        process.kill(-c.pid, "SIGKILL");
      } catch {
        c.kill("SIGKILL");
      }
    }
  }
  for (const f of pidFiles.splice(0)) {
    const pid = Number(await readFile(f, "utf8").catch(() => ""));
    if (pid > 0 && alive(pid)) process.kill(pid, "SIGKILL");
  }
  for (const s of servers.splice(0)) {
    s.closeAllConnections();
    s.close();
  }
  await rm(root, { recursive: true, force: true });
});

const started = (r: AppStarted | AppStartRefusal): AppStarted => {
  if (isRefusal(r)) throw new Error(`refused ${r.reason}: ${r.detail}`);
  toStop.push(r);
  return r;
};

describe("startApp", () => {
  it("refuses appInstallFailed naming the command and code, and never starts", async () => {
    const r = await startApp(app({ install: ["echo boom; exit 3"] }), opts(), {
      spawn: spawnSpy.fn,
    });
    expect(isRefusal(r) && r.reason).toBe("appInstallFailed");
    const f = r as AppStartRefusal;
    expect(f.detail).toContain("`echo boom; exit 3`");
    expect(f.detail).toContain("exited with code 3");
    expect(f.tail).toContain("boom");
    expect(spawnSpy.calls).toEqual(["-c echo boom; exit 3"]);
  });

  it("refuses appNeverAnswered after the timeout, with the output's tail, and ends the process", async () => {
    const r = await startApp(
      app({ timeoutSeconds: 1 }),
      opts({ env: { ...opts().env, MODE: "never", GREETING: "hi" } }),
      { spawn: spawnSpy.fn },
    );
    expect(isRefusal(r) && r.reason).toBe("appNeverAnswered");
    const f = r as AppStartRefusal;
    expect(f.detail).toContain(url);
    expect(f.detail).toContain("1 s");
    expect(f.tail).toContain("never listening hi");
    const pid = children[0]?.pid;
    expect(pid).toBeTypeOf("number");
    expect(alive(pid as number)).toBe(false);
    expect(() => process.kill(-(pid as number), 0)).toThrow();
  });

  it("refuses appStartExited with the exit code as soon as the start exits", async () => {
    // The sleep never resolves, so only the process's exit can end the wait:
    // the 120 s timeout cannot be what answered.
    const r = await startApp(
      app({ timeoutSeconds: 120 }),
      opts({ env: { ...opts().env, MODE: "exit" } }),
      { spawn: spawnSpy.fn, now: () => 0, sleep: () => new Promise(() => {}) },
    );
    expect(isRefusal(r) && r.reason).toBe("appStartExited");
    const f = r as AppStartRefusal;
    expect(f.detail).toContain("exited with code 1");
    expect(f.detail).toContain(`\`${START}\``);
    expect(f.tail).toContain("exiting at once");
    // Its group is gone and nothing answers: nothing is left to name.
    expect(f.detail).not.toContain("could not stop");
    expect(f.detail).not.toContain("started after it exited");
  });

  it("a start that daemonizes and exits 0 is started, and stop says what it could not stop", async () => {
    const pidfile = join(root, "child.pid");
    pidFiles.push(pidfile);
    const r = started(
      await startApp(
        app(),
        opts({ env: { ...opts().env, MODE: "fork", PIDFILE: pidfile } }),
        { spawn: spawnSpy.fn },
      ),
    );
    const childPid = Number(await readFile(pidfile, "utf8"));
    // Premise: the started process exited, and a detached child answers.
    expect(children[0]?.exitCode).toBe(0);
    expect(alive(childPid)).toBe(true);
    expect(r.reused).toBe(false);
    expect(await r.stop()).toEqual([
      `the process \`${START}\` started after it exited`,
    ]);
    toStop.length = 0;
  });

  describe("ready is Playwright's rule", () => {
    const answering = (status: number): AppStartDeps["fetch"] => {
      let calls = 0;
      // The first call is the before-start probe: nothing answers yet.
      return (async () => {
        if (calls++ === 0) throw new Error("ECONNREFUSED");
        return new Response(null, { status });
      }) as AppStartDeps["fetch"];
    };
    let t = 0;
    const clock = {
      now: () => t,
      sleep: async (ms: number) => {
        t += ms;
        await new Promise((r) => setImmediate(r));
      },
    };
    for (const status of [200, 302, 403]) {
      it(`ready on ${status}`, async () => {
        const r = await startApp(app({ start: "sleep 30" }), opts(), {
          spawn: spawnSpy.fn,
          fetch: answering(status),
          ...clock,
        });
        expect(started(r).reused).toBe(false);
      });
    }
    for (const status of [404, 500]) {
      it(`not ready on ${status}`, async () => {
        const r = await startApp(
          app({ start: "sleep 30", timeoutSeconds: 1 }),
          opts(),
          { spawn: spawnSpy.fn, fetch: answering(status), ...clock },
        );
        expect(isRefusal(r) && r.reason).toBe("appNeverAnswered");
      });
    }
  });

  describe("when the URL already answers before anything starts", () => {
    beforeEach(async () => {
      const s = createServer((_q, res) => res.end("dev server"));
      await new Promise<void>((r) => s.listen(port, r));
      servers.push(s);
      // Premise: the person's own server holds the port.
      expect(await canListen(port)).toBe(false);
    });

    it('mode "own" refuses appPortTaken naming the URL, and starts nothing', async () => {
      const r = await startApp(app({ install: ["true"] }), opts(), {
        spawn: spawnSpy.fn,
      });
      expect(isRefusal(r) && r.reason).toBe("appPortTaken");
      expect((r as AppStartRefusal).detail).toContain(url);
      // Red when the refusal leaves the person to find what holds the port (DEM-62).
      if (hasLsof)
        // lsof's command is the process title: "node", or "node (vitest 1)"
        // on Linux, where vitest renames its workers.
        expect((r as AppStartRefusal).detail).toMatch(
          new RegExp(`\\(held by node.* \\(pid ${process.pid}\\)\\)`),
        );
      expect(spawnSpy.calls).toEqual([]);
    });

    it('mode "reuse" uses it and starts nothing', async () => {
      const r = started(
        await startApp(app({ install: ["true"] }), opts({ mode: "reuse" }), {
          spawn: spawnSpy.fn,
        }),
      );
      expect(r.reused).toBe(true);
      expect(r.said).toBe(`used the app already answering at ${url}`);
      expect(spawnSpy.calls).toEqual([]);
      expect(await r.stop()).toEqual([]);
    });
  });

  // Red when a flow's changes show in the next: reset runs the app's own
  // command before each flow (DEM-57).
  describe("reset", () => {
    it("runs the reset command, saying so, and answers ok", async () => {
      const said: string[] = [];
      const r = started(
        await startApp(
          app({ reset: "echo reset-ran" }),
          opts({ mode: "reuse", log: (l: string) => said.push(l) }),
          { spawn: spawnSpy.fn },
        ),
      );
      const before = spawnSpy.calls.length;
      expect(await r.reset()).toEqual({ ok: true });
      expect(said).toContain("resetting: `echo reset-ran`");
      expect(spawnSpy.calls.slice(before)).toEqual(["-c echo reset-ran"]);
    });
    it("answers why when the reset command fails", async () => {
      const r = started(
        await startApp(
          app({ reset: "echo nope; exit 3" }),
          opts({ mode: "reuse" }),
          { spawn: spawnSpy.fn },
        ),
      );
      const got = await r.reset();
      expect(got.ok).toBe(false);
      if (!got.ok) {
        expect(got.detail).toContain("`echo nope; exit 3` exited with code 3");
        expect(got.detail).toContain("nope");
      }
    });
    // Review, finding 8. Red when a reset that never ends holds the job.
    it("stops a reset that outlasts the app's timeout, and says so", async () => {
      const r = started(
        await startApp(
          app({ reset: "sleep 30", timeoutSeconds: 1 }),
          opts({ mode: "reuse" }),
          { spawn: spawnSpy.fn },
        ),
      );
      const t0 = Date.now();
      const got = await r.reset();
      expect(Date.now() - t0).toBeLessThan(5000);
      expect(got.ok).toBe(false);
      if (!got.ok) expect(got.detail).toContain("did not finish within 1 s");
    }, 20_000);
    it("without a reset command runs nothing", async () => {
      const r = started(
        await startApp(app(), opts({ mode: "reuse" }), { spawn: spawnSpy.fn }),
      );
      const before = spawnSpy.calls.length;
      expect(await r.reset()).toEqual({ ok: true });
      expect(spawnSpy.calls.slice(before)).toEqual([]);
    });
  });

  describe('mode "own" when something holds the port but is not ready', () => {
    const hold = async (handler: Parameters<typeof createServer>[1]) => {
      const s = createServer(handler);
      await new Promise<void>((r) => s.listen(port, r));
      servers.push(s);
      expect(await canListen(port)).toBe(false);
    };
    const own = () =>
      startApp(app({ install: ["true"] }), opts(), { spawn: spawnSpy.fn });

    it("refuses appPortTaken when it answers 500", async () => {
      await hold((_q, res) => {
        res.statusCode = 500;
        res.end("broken dev server");
      });
      // Premise: it answers, and not ready by Playwright's rule.
      expect((await fetch(url)).status).toBe(500);
      const r = await own();
      expect(isRefusal(r) && r.reason).toBe("appPortTaken");
      expect((r as AppStartRefusal).detail).toContain(url);
      expect(spawnSpy.calls).toEqual([]);
    });

    it("refuses appPortTaken when it takes the request and never answers", async () => {
      await hold(() => {});
      // Premise: a probe gets no answer in time.
      await expect(
        fetch(url, { signal: AbortSignal.timeout(300) }),
      ).rejects.toThrow();
      const r = await own();
      expect(isRefusal(r) && r.reason).toBe("appPortTaken");
      expect(spawnSpy.calls).toEqual([]);
    });
  });

  it("waits for a slow start, then stop() frees the port", async () => {
    const r = started(
      await startApp(app(), opts({ env: { ...opts().env, MODE: "slow" } }), {
        spawn: spawnSpy.fn,
      }),
    );
    expect(r.said).toBe(
      `started the app with \`${START}\` from .demoman/app.json`,
    );
    expect(await canListen(port)).toBe(false);
    expect(await r.stop()).toEqual([]);
    toStop.length = 0;
    expect(await canListen(port)).toBe(true);
    // A second stop answers the same: it stopped the process, which did not
    // exit by itself.
    expect(await r.stop()).toEqual([]);
  });

  it("env and app.env reach install and start, run in root", async () => {
    const r = started(
      await startApp(
        app({
          install: ['echo "install $GREETING $FROM_APP" > install.txt'],
          start: `echo "start $GREETING $FROM_APP" > start.txt; exec ${START}`,
          env: { FROM_APP: "committed" },
        }),
        opts({ env: { ...opts().env, GREETING: "hello" } }),
        { spawn: spawnSpy.fn },
      ),
    );
    expect(r.reused).toBe(false);
    expect(await readFile(join(root, "install.txt"), "utf8")).toBe(
      "install hello committed\n",
    );
    expect(await readFile(join(root, "start.txt"), "utf8")).toBe(
      "start hello committed\n",
    );
  });

  it("the tail never carries a value app.json lists under secrets", async () => {
    const r = await startApp(
      app({
        install: ["echo token=$API_TOKEN; exit 1"],
        secrets: ["API_TOKEN"],
      }),
      opts({ env: { ...opts().env, API_TOKEN: "plain-words-value" } }),
      { spawn: spawnSpy.fn },
    );
    const f = r as AppStartRefusal;
    expect(f.reason).toBe("appInstallFailed");
    expect(f.tail).toContain("token=");
    expect(f.tail).not.toContain("plain-words-value");
  });

  describe('services: "docker"', () => {
    const services: AppSpec["services"] = {
      redis: { image: "redis:7", ports: ["6379:6379"], env: {}, options: null },
      postgres: {
        image: "postgres:16",
        ports: ["5432:5432"],
        env: { POSTGRES_PASSWORD: "pw" },
        options: '--health-cmd "pg_isready -U postgres" --health-interval=1s',
      },
    };
    const fakeDocker = (answer: (args: string[]) => number, stderr = "") => {
      const calls: string[][] = [];
      const removed = new Set<string>();
      let inspects = 0;
      const docker: AppStartDeps["docker"] = async (args) => {
        calls.push(args);
        if (args[0] === "rm") {
          const name = args[2] as string;
          if (removed.has(name))
            return {
              code: 1,
              stdout: "",
              stderr: `No such container: ${name}`,
            };
          removed.add(name);
          return { code: 0, stdout: "", stderr: "" };
        }
        if (args[0] === "inspect")
          return {
            code: 0,
            stdout: inspects++ < 2 ? "starting\n" : "healthy\n",
            stderr: "",
          };
        const code = answer(args);
        return {
          code,
          stdout: code ? "" : "abc123\n",
          stderr: code ? stderr : "",
        };
      };
      return { docker, calls };
    };

    it("refuses appDockerMissing when docker info fails, starting nothing", async () => {
      const d = fakeDocker((a) => (a[0] === "info" ? 1 : 0), "Cannot connect");
      const r = await startApp(
        app({ services }),
        opts({ services: "docker" }),
        {
          spawn: spawnSpy.fn,
          docker: d.docker,
        },
      );
      expect(isRefusal(r) && r.reason).toBe("appDockerMissing");
      expect(d.calls).toEqual([["info"]]);
      expect(spawnSpy.calls).toEqual([]);
    });

    it("refuses appServiceFailed naming the service and docker's words, removing what it started", async () => {
      const d = fakeDocker(
        (a) => (a[0] === "run" && a.includes("postgres:16") ? 125 : 0),
        "docker: port is already allocated.",
      );
      const r = await startApp(
        app({ services }),
        opts({ services: "docker" }),
        {
          spawn: spawnSpy.fn,
          docker: d.docker,
        },
      );
      expect(isRefusal(r) && r.reason).toBe("appServiceFailed");
      const f = r as AppStartRefusal;
      expect(f.detail).toContain("postgres");
      expect(f.detail).toContain("docker: port is already allocated.");
      const redisName = d.calls.find((a) => a.includes("redis:7"))?.[4];
      expect(redisName).toMatch(/^demoman-redis-/);
      expect(d.calls).toContainEqual(["rm", "-f", redisName]);
      expect(spawnSpy.calls).toEqual([]);
    });

    it("refuses appServiceFailed at once when the container is gone before it is healthy", async () => {
      // A service that exits is removed by --rm: inspect then fails. Time
      // runs out after 40 polls, so only the failed inspect can answer at 1.
      const calls: string[][] = [];
      let t = 0;
      const docker: AppStartDeps["docker"] = async (args) => {
        calls.push(args);
        if (args[0] === "inspect")
          return {
            code: 1,
            stdout: "\n",
            stderr: `Error: No such object: ${args.at(-1)}\n`,
          };
        return { code: 0, stdout: "abc123\n", stderr: "" };
      };
      const r = await startApp(
        app({ services }),
        opts({ services: "docker" }),
        {
          spawn: spawnSpy.fn,
          docker,
          now: () => t,
          sleep: async (ms) => {
            t += ms;
          },
        },
      );
      expect(isRefusal(r) && r.reason).toBe("appServiceFailed");
      const f = r as AppStartRefusal;
      expect(calls.filter((a) => a[0] === "inspect")).toHaveLength(1);
      expect(f.detail).toContain("postgres");
      expect(f.detail).toContain("Error: No such object: demoman-postgres-");
      expect(f.detail).not.toContain("within");
      expect(spawnSpy.calls).toEqual([]);
    });

    it("runs each service, waits for health, and stop() removes each container", async () => {
      const d = fakeDocker(() => 0);
      let probes = 0;
      const fetch = (async () => {
        if (probes++ === 0) throw new Error("ECONNREFUSED");
        return new Response(null, { status: 200 });
      }) as AppStartDeps["fetch"];
      const r = started(
        await startApp(
          app({ services, start: "sleep 30" }),
          opts({ services: "docker" }),
          {
            spawn: spawnSpy.fn,
            docker: d.docker,
            fetch,
            sleep: async () => {},
          },
        ),
      );
      const runs = d.calls.filter((a) => a[0] === "run");
      const pgName = runs[1]?.[4] as string;
      expect(pgName).toMatch(/^demoman-postgres-[0-9a-f]+$/);
      expect(runs[1]).toEqual([
        "run",
        "-d",
        "--rm",
        "--name",
        pgName,
        "-p",
        "5432:5432",
        "-e",
        "POSTGRES_PASSWORD=pw",
        "--health-cmd",
        "pg_isready -U postgres",
        "--health-interval=1s",
        "postgres:16",
      ]);
      const inspects = d.calls.filter((a) => a[0] === "inspect");
      expect(inspects).toHaveLength(3);
      expect(inspects.every((a) => a.at(-1) === pgName)).toBe(true);
      const redisName = runs[0]?.[4] as string;
      expect(await r.stop()).toEqual([]);
      expect(await r.stop()).toEqual([]);
      toStop.length = 0;
      expect(d.calls.filter((a) => a[0] === "rm")).toEqual([
        ["rm", "-f", redisName],
        ["rm", "-f", pgName],
      ]);
    });
  });
});

const hasLsof = spawnSync("lsof", ["-v"]).error === undefined;

describe("whoListens", () => {
  it.skipIf(!hasLsof)("names the process listening on the port", async () => {
    const server = createServer().listen(0, "127.0.0.1");
    await new Promise((r) => server.once("listening", r));
    const { port } = server.address() as AddressInfo;
    try {
      expect(await whoListens(port)).toMatch(
        new RegExp(`^node.* \\(pid ${process.pid}\\)$`),
      );
    } finally {
      server.close();
    }
  });

  it("answers null for a port nothing listens on", async () => {
    expect(await whoListens(1)).toBeNull();
  });
});

// Red when the app Demoman starts is not handed the repo's pinned instant, or
// a pin that cannot hold is recorded anyway (DEM-79).
describe("now", () => {
  const NOW = "2026-11-06T09:00:00Z";
  const seen = (name: string) =>
    readFile(join(root, name), "utf8").catch(() => "(none)");
  const writes = (name: string) =>
    `printf %s "\${DEMOMAN_NOW-unset}" > ${name}`;
  /** An hour after NOW: these cases must not depend on today's date. */
  const soon = () => Date.parse(NOW) + 3_600_000;

  it("hands DEMOMAN_NOW to install, start and reset", async () => {
    const r = started(
      await startApp(
        app({
          now: NOW,
          install: [writes("install.txt")],
          start: `${writes("start.txt")}; exec ${START}`,
          reset: writes("reset.txt"),
        }),
        opts(),
        { spawn: spawnSpy.fn, now: soon },
      ),
    );
    expect(await r.reset()).toEqual({ ok: true });
    expect(await seen("install.txt")).toBe(NOW);
    expect(await seen("start.txt")).toBe(NOW);
    expect(await seen("reset.txt")).toBe(NOW);
    expect(r.pinnedNow).toBe(NOW);
  });

  it("sets no DEMOMAN_NOW without now", async () => {
    const r = started(
      await startApp(
        app({
          install: [writes("install.txt")],
          start: `${writes("start.txt")}; exec ${START}`,
          reset: writes("reset.txt"),
        }),
        // Final review, minor 4: one left in the shell must not pin the
        // server while the browser runs on the real clock.
        opts({ env: { ...opts().env, DEMOMAN_NOW: "2020-01-01T00:00:00Z" } }),
        { spawn: spawnSpy.fn },
      ),
    );
    expect(await r.reset()).toEqual({ ok: true });
    for (const f of ["install.txt", "start.txt", "reset.txt"])
      expect(await seen(f), f).toBe("unset");
    expect(r.pinnedNow).toBeNull();
  });

  it("refuses appNowInFuture before installing anything", async () => {
    const r = await startApp(
      app({ now: NOW, install: [writes("install.txt")] }),
      opts(),
      { spawn: spawnSpy.fn, now: () => Date.parse(NOW) - 3_600_000 },
    );
    expect(isRefusal(r) && r.reason).toBe("appNowInFuture");
    expect((r as AppStartRefusal).detail).toContain("now");
    expect((r as AppStartRefusal).detail).toContain(".demoman/app.json");
    expect(spawnSpy.calls).toEqual([]);
  });

  // Chosen after code review #1: a page clock far behind the browser's own
  // drops cookies the page sets and can reject the server's tokens.
  it("refuses appNowTooOld when now is more than 7 days old", async () => {
    const r = await startApp(
      app({ now: NOW, install: [writes("install.txt")] }),
      opts(),
      { spawn: spawnSpy.fn, now: () => Date.parse(NOW) + 8 * 86_400_000 },
    );
    expect(isRefusal(r) && r.reason).toBe("appNowTooOld");
    const { detail } = r as AppStartRefusal;
    expect(detail).toContain("8 days");
    expect(detail).toContain("7 days");
    expect(detail).toContain(".demoman/app.json");
    expect(spawnSpy.calls).toEqual([]);
  });

  it("accepts a now 6 days old", async () => {
    const r = started(
      await startApp(app({ now: NOW }), opts(), {
        spawn: spawnSpy.fn,
        now: () => Date.parse(NOW) + 6 * 86_400_000,
      }),
    );
    expect(r.pinnedNow).toBe(NOW);
  });

  // Code review #8: a DEMOMAN_NOW in the shell is dropped, and said.
  it("says when it drops a DEMOMAN_NOW from the shell", async () => {
    const said: string[] = [];
    started(
      await startApp(
        app(),
        opts({
          env: { ...opts().env, DEMOMAN_NOW: "2020-01-01T00:00:00Z" },
          log: (l: string) => said.push(l),
        }),
        { spawn: spawnSpy.fn },
      ),
    );
    expect(said.join(" ")).toContain("DEMOMAN_NOW");
    expect(said.join(" ")).toContain("now");
  });

  describe("when the app already answers", () => {
    beforeEach(async () => {
      const s = createServer((_q, res) => res.end("ok"));
      await new Promise<void>((r) => s.listen(port, r));
      servers.push(s);
      // Premise: the port answers before startApp runs.
      expect((await fetch(url)).status).toBe(200);
    });

    it("refuses appNowNotPinned when now is set", async () => {
      const r = await startApp(
        app({ now: NOW, reset: writes("reset.txt") }),
        opts({ mode: "reuse" }),
        { spawn: spawnSpy.fn, now: soon },
      );
      expect(isRefusal(r) && r.reason).toBe("appNowNotPinned");
      const { detail } = r as AppStartRefusal;
      expect(detail).toContain("already running");
      expect(detail).toContain("stop it and run again");
      expect(detail).toContain("CI");
      expect(spawnSpy.calls).toEqual([]);
    });

    it("reuses an answering app without now, as before", async () => {
      const r = started(
        await startApp(app(), opts({ mode: "reuse" }), {
          spawn: spawnSpy.fn,
        }),
      );
      expect(r.reused).toBe(true);
      expect(r.pinnedNow).toBeNull();
    });
  });
});

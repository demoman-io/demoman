// apps/runner/src/executor/app-start.ts
//
// Starts and stops the app `.demoman/app.json` describes: its services (in
// Docker, or provided by the CI job), its install commands, its start
// command, then waits for its URL to be ready by Playwright's rule (2xx,
// 3xx, 400-403). Every way it can fail is a named refusal carrying what
// failed, the next action, and the failing command's last lines.
import { type ChildProcess, execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { connect } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { APP_FILE, type AppSpec, scrubSecrets } from "@demoman/run-core";

export type AppStartRefusal = {
  reason:
    | "appInstallFailed"
    | "appStartExited"
    | "appNeverAnswered"
    | "appServiceFailed"
    | "appPortTaken"
    | "appNowInFuture"
    | "appNowNotPinned"
    | "appDockerMissing";
  /** What failed and the next action. */
  detail: string;
  /** The last 40 lines of the failing command's output, secrets scrubbed. */
  tail: string;
};
export type AppStarted = {
  /** True only off CI, when the URL already answered. */
  reused: boolean;
  said: string;
  seconds: number;
  /** What it could not stop, by name; [] when all stopped. */
  stop(): Promise<string[]>;
  /** Runs app.json's `reset`, if any, before a flow (DEM-57). */
  reset(): Promise<{ ok: true } | { ok: false; detail: string }>;
  /** app.json's `now` when the app was started here with it as
   *  DEMOMAN_NOW; null when unset (DEM-79). A reused app is never pinned. */
  pinnedNow: string | null;
};
export interface AppStartDeps {
  spawn: typeof import("node:child_process").spawn;
  fetch: typeof fetch;
  docker(
    args: string[],
  ): Promise<{ code: number; stdout: string; stderr: string }>;
  now(): number;
  sleep(ms: number): Promise<void>;
}

const POLL_MS = 250;
const PROBE_MS = 2_000;
const KILL_WAIT_MS = 5_000;
const DRAIN_MS = 500;
const TAIL_LINES = 40;

/** A `docker info` that hangs (a stuck daemon) is Docker not answering. */
export const DOCKER_INFO_MS = 20_000;
/** What a `docker info` stopped at DOCKER_INFO_MS exits with, as timeout(1). */
export const DOCKER_TIMED_OUT = 124;
export const dockerInfoSaid = (code: number): string =>
  code === DOCKER_TIMED_OUT
    ? `\`docker info\` did not answer within ${DOCKER_INFO_MS / 1000} s`
    : `\`docker info\` exited with code ${code}`;

const defaultDocker: AppStartDeps["docker"] = (args) =>
  new Promise((resolve) => {
    const info = args[0] === "info";
    execFile(
      "docker",
      args,
      { timeout: info ? DOCKER_INFO_MS : 0 },
      (err, stdout, stderr) => {
        const code =
          err === null
            ? 0
            : info && err.killed
              ? DOCKER_TIMED_OUT
              : typeof err.code === "number"
                ? err.code
                : -1;
        resolve({ code, stdout, stderr: stderr || (err?.message ?? "") });
      },
    );
  });

const lastLines = (text: string, n: number) =>
  text.split("\n").slice(-n).join("\n");

/** `options` the way a shell reads it: whitespace splits, quotes group. */
function shellWords(s: string): string[] {
  const words: string[] = [];
  let word: string | null = null;
  let quote: string | null = null;
  for (const ch of s) {
    if (quote) {
      if (ch === quote) quote = null;
      else word += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      word ??= "";
    } else if (/\s/.test(ch)) {
      if (word !== null) words.push(word);
      word = null;
    } else word = (word ?? "") + ch;
  }
  if (word !== null) words.push(word);
  return words;
}

/** What listens on a local TCP port, as "<command> (pid <pid>)", from
 *  `lsof`; null when lsof is missing, fails or sees nothing. Never throws. */
export function whoListens(port: number): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      "lsof",
      ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-Fpc"],
      { timeout: 3000 },
      (error, stdout) => {
        if (error) return resolve(null);
        const pid = /^p(\d+)$/m.exec(stdout)?.[1];
        const command = /^c(.+)$/m.exec(stdout)?.[1];
        resolve(pid && command ? `${command} (pid ${pid})` : null);
      },
    );
  });
}

export async function startApp(
  app: AppSpec,
  o: {
    root: string;
    env: NodeJS.ProcessEnv;
    mode: "reuse" | "own";
    services: "docker" | "provided";
    log: (l: string) => void;
  },
  deps: Partial<AppStartDeps> = {},
): Promise<AppStarted | AppStartRefusal> {
  const d: AppStartDeps = {
    spawn,
    fetch: globalThis.fetch,
    docker: defaultDocker,
    now: Date.now,
    sleep: (ms) => delay(ms),
    ...deps,
  };
  const t0 = d.now();
  // Refused before anything runs: a future instant can make the app treat a
  // fresh sign-in as expired, which would read as a sign-in fault (DEM-79).
  if (app.now !== undefined && Date.parse(app.now) > t0)
    return {
      reason: "appNowInFuture",
      detail: `now in ${APP_FILE} (${app.now}) is later than this machine's clock (${new Date(t0).toISOString()}); set now to an instant that has passed`,
      tail: "",
    };
  const env: NodeJS.ProcessEnv = {
    ...o.env,
    ...app.env,
    ...(app.now === undefined ? {} : { DEMOMAN_NOW: app.now }),
  };
  const secretValues = app.secrets
    .map((n) => env[n])
    .filter((v): v is string => !!v);
  const tailOf = (text: string) => {
    let out = scrubSecrets(lastLines(text.trimEnd(), TAIL_LINES));
    for (const v of secretValues) out = out.replaceAll(v, "<redacted>");
    return out;
  };
  const ready = async () => {
    try {
      const r = await d.fetch(app.url, {
        redirect: "manual",
        signal: AbortSignal.timeout(PROBE_MS),
      });
      return r.status >= 200 && r.status <= 403;
    } catch {
      return false;
    }
  };

  // The app's own reset, before each flow: one flow's changes never show in
  // the next (DEM-57). Run like an install command; nothing without one.
  const reset: AppStarted["reset"] = async () => {
    if (app.reset === undefined) return { ok: true };
    o.log(`resetting: \`${app.reset}\``);
    // Its own process group, so a reset that hangs (a lock the app holds, a
    // prompt) is ended whole, within the app's own timeout (review).
    const r = launch(d.spawn, app.reset, o.root, env, true);
    const done = await Promise.race([
      r.exited,
      delay(app.timeoutSeconds * 1000).then(() => null),
    ]);
    if (done === null) {
      await endGroup(r.child);
      return {
        ok: false,
        detail: `\`${app.reset}\` did not finish within ${app.timeoutSeconds} s and was stopped; fix the reset command in ${APP_FILE}, or raise timeoutSeconds there`,
      };
    }
    const { code, signal } = done;
    if (code === 0) return { ok: true };
    await Promise.race([r.drained, delay(DRAIN_MS)]);
    const tail = tailOf(r.output());
    return {
      ok: false,
      detail: `\`${app.reset}\` ${code === null ? `was stopped by ${signal}` : `exited with code ${code}`}; fix the reset command in ${APP_FILE}${tail === "" ? "" : `:\n${tail}`}`,
    };
  };

  // "own" refuses anything there, ready or not: a dev server answering 500,
  // or slowly, must never be recorded as the app this call starts.
  if (o.mode === "own" && (await listening(app.url))) {
    const u = new URL(app.url);
    const who = await whoListens(
      Number(u.port || (u.protocol === "https:" ? 443 : 80)),
    );
    return {
      reason: "appPortTaken",
      detail: `something already listens at ${app.url}${who === null ? "" : ` (held by ${who})`} before the app was started; stop it (the check needs that port for the app it starts from ${APP_FILE}), then run again`,
      tail: "",
    };
  }
  if (o.mode === "reuse" && (await ready())) {
    // Recording it anyway would put real-date videos back over pinned ones,
    // and the next CI refresh would flip them again (DEM-79).
    if (app.now !== undefined)
      return {
        reason: "appNowNotPinned",
        detail: `the app was already running at ${app.url} before Demoman started it, so the now in ${APP_FILE} (${app.now}) cannot be pinned; stop it and run again, or let CI refresh`,
        tail: "",
      };
    return {
      reused: true,
      said: `used the app already answering at ${app.url}`,
      seconds: Math.round((d.now() - t0) / 100) / 10,
      stop: async () => [],
      reset,
      pinnedNow: null,
    };
  }

  const containers: { service: string; name: string }[] = [];
  let proc: Launched | null = null;
  const stopAll = async (): Promise<string[]> => {
    const left: string[] = [];
    if (proc) {
      // Exited before stop: whatever it left running is out of reach, and is
      // named only when it still listens at the URL (nothing did before).
      const exitedFirst = proc.exited.done;
      if (!(await endGroup(proc.child)))
        left.push(`the process \`${app.start}\``);
      else if (exitedFirst && (await listening(app.url)))
        left.push(`the process \`${app.start}\` started after it exited`);
    }
    for (const c of containers) {
      const r = await d.docker(["rm", "-f", c.name]);
      if (r.code !== 0)
        left.push(`the ${c.service} container ${c.name} (${r.stderr.trim()})`);
    }
    return left;
  };
  // Once: a second stop would read its own kill as an exit, and re-remove
  // containers already gone.
  let stopped: Promise<string[]> | null = null;
  const stop = () => {
    stopped ??= stopAll();
    return stopped;
  };
  const refuse = async (
    reason: AppStartRefusal["reason"],
    detail: string,
    tail: string,
  ): Promise<AppStartRefusal> => {
    const left = await stop();
    const also = left.length ? `; could not stop ${left.join(", ")}` : "";
    return { reason, detail: detail + also, tail: tailOf(tail) };
  };

  const services = Object.entries(app.services);
  if (o.services === "docker" && services.length > 0) {
    const info = await d.docker(["info"]);
    if (info.code !== 0) {
      return {
        reason: "appDockerMissing",
        detail: `${APP_FILE} needs ${services.map(([n]) => n).join(", ")}, and Docker is not installed or not running (${dockerInfoSaid(info.code)}); start Docker, then run again`,
        tail: tailOf(info.stderr),
      };
    }
    const deadline = t0 + app.timeoutSeconds * 1000;
    for (const [service, s] of services) {
      const name = `demoman-${service}-${randomBytes(4).toString("hex")}`;
      o.log(`starting ${service} (${s.image}) in Docker`);
      const run = await d.docker([
        "run",
        "-d",
        "--rm",
        "--name",
        name,
        ...s.ports.flatMap((p) => ["-p", p]),
        ...Object.entries(s.env).flatMap(([k, v]) => ["-e", `${k}=${v}`]),
        ...shellWords(s.options ?? ""),
        s.image,
      ]);
      if (run.code !== 0) {
        return refuse(
          "appServiceFailed",
          `the ${service} service (${s.image}) did not start: docker run exited with code ${run.code}: ${tailOf(lastLines(run.stderr.trim(), 1))}; fix it in ${APP_FILE}'s services, then run again`,
          run.stderr,
        );
      }
      containers.push({ service, name });
      if (!s.options?.includes("--health-cmd")) continue;
      for (;;) {
        const h = await d.docker([
          "inspect",
          "--format",
          "{{.State.Health.Status}}",
          name,
        ]);
        const status = h.stdout.trim();
        if (h.code === 0 && status === "healthy") break;
        // --rm removes a service that exits, so inspect no longer finds it.
        if (h.code !== 0) {
          return refuse(
            "appServiceFailed",
            `the ${service} service (${s.image}) stopped before it became healthy (docker inspect exited with code ${h.code}: ${tailOf(lastLines(h.stderr.trim(), 1))}); check its image, env and options in ${APP_FILE}, then run again`,
            h.stderr,
          );
        }
        if (status === "unhealthy" || d.now() >= deadline) {
          return refuse(
            "appServiceFailed",
            `the ${service} service (${s.image}) did not become healthy within ${app.timeoutSeconds} s (last health: ${status || h.stderr.trim() || "unknown"}); check its health command in ${APP_FILE}, then run again`,
            h.stderr,
          );
        }
        await d.sleep(POLL_MS);
      }
    }
  }

  for (const cmd of app.install) {
    o.log(`installing: \`${cmd}\``);
    const inst = launch(d.spawn, cmd, o.root, env, false);
    const { code, signal } = await inst.exited;
    if (code !== 0) {
      await Promise.race([inst.drained, delay(DRAIN_MS)]);
      return refuse(
        "appInstallFailed",
        `\`${cmd}\` ${code === null ? `was stopped by ${signal}` : `exited with code ${code}`}; fix the install command in ${APP_FILE}, then run again`,
        inst.output(),
      );
    }
  }

  o.log(`starting: \`${app.start}\``);
  o.log(`waiting for ${app.url} (up to ${app.timeoutSeconds} s)`);
  const started = launch(d.spawn, app.start, o.root, env, true);
  proc = started;
  const deadline = d.now() + app.timeoutSeconds * 1000;
  for (;;) {
    const ex = started.exited.done;
    // A start that daemonizes exits 0 before the URL answers: keep waiting.
    if (ex && ex.code !== 0) {
      await Promise.race([started.drained, delay(DRAIN_MS)]);
      return refuse(
        "appStartExited",
        `\`${app.start}\` ${ex.code === null ? `was stopped by ${ex.signal}` : `exited with code ${ex.code}`} before ${app.url} answered; fix the start command in ${APP_FILE}, then run again`,
        started.output(),
      );
    }
    if (await ready()) break;
    if (d.now() >= deadline) {
      return refuse(
        "appNeverAnswered",
        `nothing answered at ${app.url} within ${app.timeoutSeconds} s of \`${app.start}\`${ex ? " (it exited with code 0)" : ""}; check the URL and timeoutSeconds in ${APP_FILE}, then run again`,
        started.output(),
      );
    }
    await (ex
      ? d.sleep(POLL_MS)
      : Promise.race([d.sleep(POLL_MS), started.exited]));
  }
  return {
    reused: false,
    said: `started the app with \`${app.start}\` from ${APP_FILE}`,
    seconds: Math.round((d.now() - t0) / 100) / 10,
    stop,
    reset,
    pinnedNow: app.now ?? null,
  };
}

type Exit = { code: number | null; signal: NodeJS.Signals | null };
type Launched = {
  child: ChildProcess;
  exited: Promise<Exit> & { done?: Exit };
  drained: Promise<void>;
  output(): string;
};

function launch(
  spawnFn: AppStartDeps["spawn"],
  cmd: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
  detached: boolean,
): Launched {
  const child = spawnFn("sh", ["-c", cmd], {
    cwd,
    env,
    detached,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let buf = "";
  const keep = (chunk: Buffer) => {
    buf = lastLines(buf + chunk.toString(), TAIL_LINES + 1);
  };
  child.stdout?.on("data", keep);
  child.stderr?.on("data", keep);
  const exited: Launched["exited"] = new Promise<Exit>((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
    child.once("error", (e) => {
      buf += `\n${e.message}`;
      resolve({ code: -1, signal: null });
    });
  });
  exited.then((e) => {
    exited.done = e;
  });
  const drained = new Promise<void>((r) => child.once("close", () => r()));
  return { child, exited, drained, output: () => buf };
}

/** Whether anything accepts a connection at the URL's host and port. */
function listening(url: string): Promise<boolean> {
  const u = new URL(url);
  const port = Number(u.port) || (u.protocol === "https:" ? 443 : 80);
  return new Promise((resolve) => {
    const socket = connect({ host: u.hostname.replace(/^\[|\]$/g, ""), port });
    const done = (yes: boolean) => {
      socket.destroy();
      resolve(yes);
    };
    socket.setTimeout(PROBE_MS, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

/** SIGTERM the whole process group, SIGKILL after 5 s; true once it is gone. */
async function endGroup(child: ChildProcess): Promise<boolean> {
  const pid = child.pid;
  if (pid === undefined) return true;
  const alive = () => {
    try {
      process.kill(-pid, 0);
      return true;
    } catch (e) {
      return (e as NodeJS.ErrnoException).code === "EPERM";
    }
  };
  for (const signal of ["SIGTERM", "SIGKILL"] as const) {
    try {
      process.kill(-pid, signal);
    } catch {
      // ESRCH: the group is already gone.
    }
    for (let waited = 0; alive() && waited < KILL_WAIT_MS; waited += 50) {
      await delay(50);
    }
    if (!alive()) return true;
  }
  return false;
}

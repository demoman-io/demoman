import { spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { join } from "node:path";
import { createLibrary, LibraryError } from "@demoman/runner/studio";
import {
  type PingAnswer,
  type Refusal,
  STUDIO_COOKIE,
  STUDIO_HEADER,
  type WindowAnswer,
} from "@demoman/studio-protocol";
import {
  readStudioState,
  removeStudioState,
  type StudioState,
} from "./state-file.js";

/** What `openStudio` answers, and so what the `studio` tool answers. */
export type StudioAnswer =
  | { outcome: "opened"; url: string; takeId?: string; note?: string }
  | Refusal;

const STALE_NOTE = "A stale Studio record was replaced.";
const REPLACED_LATER_NOTE =
  "An older Studio is running an export; it stays open until that export ends and its window closes, and the next Studio call starts the new version.";
const PING_TIMEOUT_MS = 2_000;
const WINDOW_TIMEOUT_MS = 30_000;
const LOG_TAIL_LINES = 10;

const messageOf = (e: unknown): string =>
  e instanceof Error ? e.message : String(e);

/** `process.kill(pid, 0)`: ESRCH is dead; EPERM is alive and not ours. */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

type Call =
  | { ok: true; status: number; json: unknown }
  | { ok: false; error: string };

/** One request to the studio, carrying all three things its guard checks. */
function call(
  s: StudioState,
  method: "GET" | "POST",
  path: string,
  body: unknown,
  timeoutMs: number,
): Promise<Call> {
  return new Promise((resolve) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = request(
      {
        host: "127.0.0.1",
        port: s.port,
        method,
        path,
        timeout: timeoutMs,
        headers: {
          Host: `127.0.0.1:${s.port}`,
          Cookie: `${STUDIO_COOKIE}=${s.token}`,
          [STUDIO_HEADER]: "1",
          ...(payload === undefined
            ? {}
            : {
                "Content-Type": "application/json",
                "Content-Length": Buffer.byteLength(payload),
              }),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("error", (e) => resolve({ ok: false, error: messageOf(e) }));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          try {
            resolve({
              ok: true,
              status: res.statusCode ?? 0,
              json: JSON.parse(text) as unknown,
            });
          } catch {
            resolve({
              ok: false,
              error: `answered ${res.statusCode ?? 0} with something that is not JSON`,
            });
          }
        });
      },
    );
    req.on("timeout", () => {
      req.destroy(new Error(`no answer within ${timeoutMs / 1000} s`));
    });
    req.on("error", (e) => resolve({ ok: false, error: messageOf(e) }));
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

function isPing(v: unknown): v is PingAnswer {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.version === "string" &&
    typeof o.pid === "number" &&
    typeof o.queued === "number"
  );
}

/** The studio the file names, when that pid is alive and the studio on the
 *  port answers with the token and as that pid; else null. */
async function livePing(s: StudioState): Promise<PingAnswer | null> {
  if (!pidAlive(s.pid)) return null;
  const answer = await call(s, "GET", "/api/ping", undefined, PING_TIMEOUT_MS);
  if (!answer.ok || answer.status !== 200 || !isPing(answer.json)) return null;
  // A pid that was reused by something else answers on no studio's port;
  // one that answers as another pid is not the studio the file names.
  return answer.json.pid === s.pid ? answer.json : null;
}

async function lastLines(path: string): Promise<string> {
  try {
    const text = await readFile(path, "utf8");
    const lines = text.split("\n").filter((l) => l.trim() !== "");
    return lines.slice(-LOG_TAIL_LINES).join("\n");
  } catch (error) {
    return `(the log ${path} could not be read: ${messageOf(error)})`;
  }
}

function isRefusal(v: unknown): v is Refusal {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return typeof o.reason === "string" && typeof o.detail === "string";
}

interface Spawned {
  state: StudioState;
}

/** Spawns the studio detached and waits for the `studio.json` that names it.
 *  A child that exits first, or never writes it, is `studioDidNotStart`. */
async function startStudio(o: {
  home: string;
  serve: { command: string; args: string[] };
  waitMs: number;
}): Promise<Spawned | Refusal> {
  const logPath = join(o.home, "studio.log");
  try {
    await rename(logPath, `${logPath}.1`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      return {
        reason: "studioDidNotStart",
        detail: `The Studio's log ${logPath} could not be moved aside: ${messageOf(error)}.`,
      };
    }
  }
  let fd: number;
  try {
    fd = openSync(logPath, "a", 0o600);
  } catch (error) {
    return {
      reason: "studioDidNotStart",
      detail: `The Studio's log ${logPath} could not be opened: ${messageOf(error)}.`,
    };
  }
  // An object, not two lets: the handlers assign it after TypeScript has
  // narrowed a let to its initial value.
  const ended: { exit: string | null; error: string | null } = {
    exit: null,
    error: null,
  };
  let pid: number | undefined;
  try {
    const child = spawn(o.serve.command, o.serve.args, {
      detached: true,
      stdio: ["ignore", "ignore", fd],
    });
    child.on("exit", (code, signal) => {
      ended.exit = code === null ? `signal ${signal}` : `code ${code}`;
    });
    child.on("error", (e) => {
      ended.error = messageOf(e);
    });
    pid = child.pid;
    child.unref();
  } finally {
    closeSync(fd);
  }
  const deadline = Date.now() + o.waitMs;
  while (Date.now() < deadline) {
    const s = await readStudioState(o.home);
    if (s !== null && !("unreadable" in s) && s.pid === pid) {
      return { state: s };
    }
    if (ended.error !== null || ended.exit !== null) break;
    await sleep(40);
  }
  const why =
    ended.error !== null
      ? `could not be started (${ended.error})`
      : ended.exit !== null
        ? `exited at once (${ended.exit})`
        : `did not write studio.json within ${Math.round(o.waitMs / 1000)} s`;
  if (pid !== undefined && ended.exit === null) {
    // It is still running and will not be used: do not leave it behind.
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // already gone
    }
  }
  return {
    reason: "studioDidNotStart",
    detail: `The Studio ${why}. The end of ${logPath}:\n${await lastLines(logPath)}`,
  };
}

/** An O_EXCL file in home holding the starter's pid. A holder that died is
 *  taken over; a live one is waited for, up to `waitMs` plus a margin. */
async function acquireStartLock(
  home: string,
  waitMs: number,
): Promise<{ release: () => Promise<void> } | Refusal> {
  const path = join(home, "studio.start.lock");
  const deadline = Date.now() + waitMs + 5_000;
  await mkdir(home, { recursive: true });
  for (;;) {
    try {
      await writeFile(path, `${process.pid}\n`, { flag: "wx", mode: 0o600 });
      return { release: () => rm(path, { force: true }) };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        return {
          reason: "studioDidNotStart",
          detail: `The Studio's start lock ${path} could not be taken: ${messageOf(error)}.`,
        };
      }
    }
    let holder = Number.NaN;
    try {
      holder = Number.parseInt(await readFile(path, "utf8"), 10);
    } catch {
      // released between the write and the read: try again
      continue;
    }
    if (!Number.isInteger(holder) || !pidAlive(holder)) {
      await rm(path, { force: true });
      continue;
    }
    if (Date.now() > deadline) {
      return {
        reason: "studioDidNotStart",
        detail: `Another demoman (pid ${holder}) has been starting the Studio for over ${Math.round(waitMs / 1000)} s; see ${join(home, "studio.log")}.`,
      };
    }
    await sleep(40);
  }
}

/**
 * Start-or-reuse the studio (spec §4.3), then ask it for a window. The
 * answer's `url` carries a single-use entry ticket (R12): print it, do not
 * offer it for reuse.
 */
export async function openStudio(o: {
  home: string;
  takeId?: string;
  version: string;
  serve: { command: string; args: string[] };
  waitMs?: number;
}): Promise<StudioAnswer> {
  if (o.takeId !== undefined) {
    // Before anything starts: an unknown take must not open the library in
    // its place, nor spawn a process for nothing.
    const library = createLibrary(o.home);
    if (!library.isTakeId(o.takeId)) {
      return {
        reason: "takeNotFound",
        detail: `${JSON.stringify(o.takeId)} is not a take id, so no take has it.`,
      };
    }
    try {
      if ((await library.getScene(o.takeId)) === null) {
        return {
          reason: "takeNotFound",
          detail: `No take has the id ${o.takeId}.`,
        };
      }
    } catch (error) {
      if (error instanceof LibraryError) {
        return { reason: error.reason, detail: error.message };
      }
      throw error;
    }
  }

  const notes: string[] = [];
  /** Reads studio.json and decides: a live studio to use, or null. */
  const resolve = async (): Promise<StudioState | null> => {
    const found = await readStudioState(o.home);
    if (found === null) return null;
    if ("unreadable" in found) {
      notes.push(`${STALE_NOTE} (${found.unreadable})`);
      return null;
    }
    const ping = await livePing(found);
    if (ping === null) {
      notes.push(STALE_NOTE);
      try {
        await removeStudioState(o.home, found.pid);
      } catch (error) {
        notes.push(
          `(the old studio.json could not be removed: ${messageOf(error)})`,
        );
      }
      return null;
    }
    if (ping.version === o.version) return found;
    if (ping.queued > 0) {
      notes.push(REPLACED_LATER_NOTE);
      return found;
    }
    const stopped = await stopStudio({ home: o.home });
    if (!stopped.stopped && stopped.why !== undefined) {
      notes.push(`The older studio was not stopped: ${stopped.why}`);
    }
    return null;
  };

  let state = await resolve();
  if (state === null) {
    // One start at a time: two callers that both found nothing would each
    // spawn a studio, and the second's log rotation would move the first
    // child's log. Whoever waits re-reads, and finds the first one's studio.
    const waitMs = o.waitMs ?? 15_000;
    const lock = await acquireStartLock(o.home, waitMs);
    if ("reason" in lock) return lock;
    try {
      state = await resolve();
      if (state === null) {
        const started = await startStudio({
          home: o.home,
          serve: o.serve,
          waitMs,
        });
        if ("reason" in started) return started;
        state = started.state;
      }
    } finally {
      await lock.release();
    }
  }
  const win = await call(
    state,
    "POST",
    "/api/window",
    o.takeId === undefined ? {} : { takeId: o.takeId },
    WINDOW_TIMEOUT_MS,
  );
  if (!win.ok) {
    return {
      reason: "windowDidNotOpen",
      detail: `The Studio did not answer the request for a window: ${win.error}.`,
    };
  }
  if (win.status !== 200) {
    if (isRefusal(win.json)) return win.json;
    return {
      reason: "windowDidNotOpen",
      detail: `The Studio answered ${win.status} to the request for a window.`,
    };
  }
  const answer = win.json as Partial<WindowAnswer>;
  if (typeof answer.url !== "string") {
    return {
      reason: "windowDidNotOpen",
      detail: "The Studio opened a window but did not say its address.",
    };
  }
  return {
    outcome: "opened",
    url: answer.url,
    ...(o.takeId === undefined ? {} : { takeId: o.takeId }),
    ...(notes.length === 0 ? {} : { note: notes.join(" ") }),
  };
}

/**
 * Ends the studio now. `cutShort` is how many exports it was holding. Only a
 * studio that answers as the pid its file names is signalled: a pid the
 * system has reused is left alone.
 */
export async function stopStudio(o: { home: string }): Promise<{
  stopped: boolean;
  cutShort: number;
  /** Set when nothing was stopped but something may still be running. */
  why?: string;
}> {
  const found = await readStudioState(o.home);
  if (found === null) return { stopped: false, cutShort: 0 };
  if ("unreadable" in found) {
    return { stopped: false, cutShort: 0, why: found.unreadable };
  }
  if (!pidAlive(found.pid)) return { stopped: false, cutShort: 0 };
  const ping = await livePing(found);
  if (ping === null) {
    return {
      stopped: false,
      cutShort: 0,
      why: `pid ${found.pid} is alive but did not answer as the Studio, so it was left alone`,
    };
  }
  const signal = (sig: "SIGTERM" | "SIGKILL"): void => {
    try {
      process.kill(found.pid, sig);
    } catch (error) {
      // ESRCH: it exited between the ping and the signal, which is the goal.
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  };
  signal("SIGTERM");
  const deadline = Date.now() + 10_000;
  while (pidAlive(found.pid) && Date.now() < deadline) await sleep(40);
  if (pidAlive(found.pid)) {
    signal("SIGKILL");
    await removeStudioState(o.home, found.pid);
  }
  return { stopped: true, cutShort: ping.queued };
}

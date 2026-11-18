// One vitest run at a time on the machine, off CI. Two suites at once took a
// 16 GB Mac down more than once, and sessions cannot see each other, so every
// run queues on one lock file through vitest's `globalSetup`
// (`suiteLock()` in test-tier.mjs).

import {
  linkSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** @param {Record<string, string | undefined>} env */
export function defaultLockFile(env = process.env) {
  // The home directory, not tmpdir(): each Claude session may have its own TMPDIR.
  return (
    env.DEMOMAN_SUITE_LOCK_FILE ||
    join(homedir(), ".cache", "demoman", "suite.lock")
  );
}

const processAlive = (/** @type {number} */ pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return /** @type {any} */ (err).code !== "ESRCH"; // EPERM: alive, not ours
  }
};

const unlinkQuietly = (/** @type {string} */ file) => {
  try {
    unlinkSync(file);
  } catch (err) {
    if (/** @type {any} */ (err).code !== "ENOENT") throw err;
  }
};

/**
 * Resolves once this process holds the lock; the returned function releases
 * it, and only removes the file if it still names `pid`.
 *
 * @param {{
 *   file?: string, pid?: number, command?: string, cwd?: string,
 *   isAlive?: (pid: number) => boolean | Promise<boolean>,
 *   sleep?: (ms: number) => Promise<void>,
 *   say?: (line: string) => void,
 *   now?: () => number, pollMs?: number, sayEveryMs?: number,
 * }} opts
 * @returns {Promise<() => void>}
 */
export async function acquireSuiteLock(opts = {}) {
  const {
    file = defaultLockFile(),
    pid = process.pid,
    command = "vitest",
    cwd = process.cwd(),
    isAlive = processAlive,
    sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
    say = (line) => console.error(line),
    now = Date.now,
    pollMs = 2000,
    sayEveryMs = 60000,
  } = opts;
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${pid}.tmp`;
  const takeover = `${file}.takeover`;
  /** Create `target` holding our record, atomically; false if it exists. Link, not write: a reader never sees a half-written record. */
  const tryCreate = (/** @type {string} */ target) => {
    writeFileSync(
      tmp,
      JSON.stringify({ pid, command, cwd, startedAt: new Date().toISOString() }),
    );
    try {
      linkSync(tmp, target);
      return true;
    } catch (err) {
      if (/** @type {any} */ (err).code !== "EEXIST") throw err;
      return false;
    } finally {
      unlinkQuietly(tmp);
    }
  };
  /**
   * Remove the main lock only if it still holds `raw`, the record we judged
   * stale, and only under the takeover lock. Without that, two waiters that
   * read the same dead record both unlink, and the second removes the
   * first's live lock. False when someone else is mid-takeover (poll again).
   */
  const removeStale = async (/** @type {string} */ raw) => {
    if (!tryCreate(takeover)) {
      try {
        const other = JSON.parse(readFileSync(takeover, "utf8"));
        // A dead taker is cleared like any dead holder; the race only delays
        // us, because the re-check below protects a live lock.
        if (!(await isAlive(other.pid))) unlinkQuietly(takeover);
      } catch {
        // gone or mid-replace: the next poll sees it
      }
      return false;
    }
    try {
      if (readFileSync(file, "utf8") === raw) unlinkQuietly(file);
    } catch (err) {
      if (/** @type {any} */ (err).code !== "ENOENT") throw err;
    } finally {
      unlinkQuietly(takeover);
    }
    return true;
  };
  let lastSaid = -Infinity;
  for (;;) {
    if (tryCreate(file)) {
      return () => {
        try {
          if (JSON.parse(readFileSync(file, "utf8")).pid === pid) {
            unlinkQuietly(file);
          }
        } catch (err) {
          // Gone already, or someone else's unreadable file: not ours to remove.
          if (/** @type {any} */ (err).code !== "ENOENT") {
            say(`demoman suite lock: could not release ${file}: ${err}`);
          }
        }
      };
    }
    let raw;
    try {
      raw = readFileSync(file, "utf8");
    } catch (err) {
      if (/** @type {any} */ (err).code === "ENOENT") continue; // released meanwhile
      throw err;
    }
    let held;
    try {
      held = JSON.parse(raw);
    } catch {
      say(`demoman suite lock: ${file} is unreadable; taking it`);
      if (!(await removeStale(raw))) await sleep(pollMs);
      continue;
    }
    // shortcut: a reused pid makes a dead holder look alive and the waiter waits; the waiting line names pid and cwd so it can be killed by hand. Upgrade to comparing process start time if it bites.
    if (!(await isAlive(held.pid))) {
      say(
        `demoman suite lock: pid ${held.pid} (${held.command} in ${held.cwd}) held it and is gone; taking it`,
      );
      if (!(await removeStale(raw))) await sleep(pollMs);
      continue;
    }
    if (now() - lastSaid >= sayEveryMs) {
      lastSaid = now();
      const minutes = Math.floor((now() - Date.parse(held.startedAt)) / 60000);
      say(
        `demoman suite lock: waiting for pid ${held.pid} (${held.command} in ${held.cwd}, ${minutes} min) — ${file}`,
      );
    }
    await sleep(pollMs);
  }
}

/** vitest `globalSetup`: queue behind the machine's suite lock; the teardown releases it. */
export default async function setup() {
  const release = await acquireSuiteLock({ command: "vitest", cwd: process.cwd() });
  // vitest's own SIGINT/SIGTERM handler exits without teardown, so ours goes first.
  process.prependOnceListener("exit", release);
  for (const signal of /** @type {const} */ (["SIGINT", "SIGTERM"])) {
    process.prependOnceListener(signal, () => {
      release();
      // A listener suppresses Node's default exit; with none left, restore it.
      if (process.listenerCount(signal) === 0) process.kill(process.pid, signal);
    });
  }
  return release;
}

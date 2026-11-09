import { randomUUID } from "node:crypto";
import { link, open, readFile, rm, stat, writeFile } from "node:fs/promises";

/** A pid that signals as nonexistent is dead; EPERM means alive and ours to
 *  leave alone. */
export const pidAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
};

export type PidLock =
  | { ok: true; release: () => Promise<void> }
  /** Still held by a live `holder` when `waitMs` ran out. */
  | { ok: false; holder: number }
  | { ok: false; error: unknown };

/** A breaker older than this was left by a process that died mid-break. */
const BREAKER_STALE_MS = 10_000;
/** A lock naming no pid is an older Demoman's (its sign-in lock was empty):
 *  taken over at the age that one was, never while it may still be live. */
const NO_PID_STALE_MS = 120_000;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const code = (e: unknown) => (e as NodeJS.ErrnoException).code;

/** Release found the lock was not this one any more: gone, or another's. */
export class LockNotMine extends Error {}

async function textOf(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (code(error) === "ENOENT") return null;
    throw error;
  }
}

/** Is the lock whose text is `held` left by a process that is gone? Its pid
 *  is the first number in it: `<pid> <token>`, or an older `{"pid":N}`. */
async function deadHolder(path: string, held: string): Promise<boolean> {
  const pid = /\d+/.exec(held);
  if (pid !== null) return !pidAlive(Number(pid[0]));
  try {
    return Date.now() - (await stat(path)).mtimeMs > NO_PID_STALE_MS;
  } catch (error) {
    if (code(error) === "ENOENT") return false; // released: the loop retries
    throw error;
  }
}

/**
 * The file at `path`, held across processes. Its text is `<pid> <token>`,
 * written whole and then linked into place, so it is never seen empty
 * (DEM-66). A lock whose pid is dead is broken; a live one is waited for, up
 * to `waitMs`. Release removes the lock only while it is still this one.
 */
export async function takePidLock(
  path: string,
  waitMs: number,
  retryMs = 25,
): Promise<PidLock> {
  const text = `${process.pid} ${randomUUID()}\n`;
  const mine = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(mine, text, { mode: 0o600 });
  } catch (error) {
    return { ok: false, error };
  }
  const deadline = Date.now() + waitMs;
  try {
    for (;;) {
      try {
        await link(mine, path);
        return { ok: true, release: () => releaseIfMine(path, text) };
      } catch (error) {
        if (code(error) !== "EEXIST") return { ok: false, error };
      }
      const held = await textOf(path);
      if (held === null) continue; // released between the two calls
      const dead = await deadHolder(path, held);
      // A dead lock that another waiter is already breaking is waited on.
      if (dead && (await breakIfStill(path, held))) continue;
      if (Date.now() >= deadline) {
        const pid = /\d+/.exec(held);
        if (!dead && pid !== null) return { ok: false, holder: Number(pid[0]) };
        return {
          ok: false,
          error: new Error(
            dead
              ? `${path} was left by a process that is gone, and ${path}.break stayed held while ${waitMs} ms ran out; remove both if no other Demoman is running`
              : `${path} names no process and stayed for ${waitMs} ms; remove it if no other Demoman is running`,
          ),
        };
      }
      await sleep(retryMs);
    }
  } catch (error) {
    return { ok: false, error };
  } finally {
    // Forgiven, not hidden: a stray temp file sits beside the lock, named
    // for it, and is not a held lock; failing here would leave one held.
    await rm(mine, { force: true }).catch(() => undefined);
  }
}

/**
 * Removes the lock at `path` only if its text is still `judged`, the dead
 * holder's. Two waiters can judge the same dead lock; without the re-read
 * the slower one removed the lock the faster one had just taken, and both
 * held it. The re-read and the remove happen under `<path>.break`, so no
 * other breaker acts between them. False when another waiter holds the
 * breaker, so the caller waits as for a live lock. Exported for its test.
 */
export async function breakIfStill(
  path: string,
  judged: string,
): Promise<boolean> {
  const breaker = `${path}.break`;
  try {
    await (await open(breaker, "wx", 0o600)).close();
  } catch (error) {
    if (code(error) !== "EEXIST") throw error;
    // shortcut: a breaker left by a process killed inside these few lines is
    // cleared once old; two waiters clearing it together can still both
    // break, so only if a breaker is ever seen old.
    try {
      if (Date.now() - (await stat(breaker)).mtimeMs > BREAKER_STALE_MS) {
        await rm(breaker, { force: true });
      }
    } catch (e) {
      if (code(e) !== "ENOENT") throw e;
    }
    return false;
  }
  try {
    if ((await textOf(path)) === judged) await rm(path, { force: true });
  } finally {
    await rm(breaker, { force: true });
  }
  return true;
}

/** Throws when the lock could not be read or removed, so a lock left behind
 *  is said rather than waited out by the next taker; and when it is no
 *  longer this one, since then another process held it at the same time. */
async function releaseIfMine(path: string, text: string): Promise<void> {
  const held = await textOf(path);
  if (held !== text) {
    throw new LockNotMine(
      `${path} was no longer this process's lock at release (${held === null ? "it was gone" : `it named ${held.trim()}`}), so another process may have held it at the same time; it was left alone`,
    );
  }
  await rm(path, { force: true });
}

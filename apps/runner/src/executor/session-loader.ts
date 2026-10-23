import { messageOf } from "@demoman/run-core";
import type { BrowserContext } from "playwright";
import {
  filesFor,
  mergeStates,
  restorable,
  type SessionChoice,
  type SessionFile,
  type SessionStore,
} from "./sessions.js";

export type SessionsLoaded =
  | { ok: true; files: SessionFile[] }
  | {
      ok: false;
      reason: "sessionUnreadable" | "sessionNotLoaded";
      detail: string;
    };

/**
 * Puts the saved sessions into a context before a snapshot or run, when any
 * file changed since that context last took them (a `signin` in another
 * terminal, another session's write-back), or when `forget` was called
 * since. `setStorageState` clears what the context held first, so each load
 * starts from the saved state. An IndexedDB database the browser would
 * refuse is left out and named through `log`, rather than refusing them all.
 */
export function createSessionLoader(
  store: SessionStore,
  log: (line: string) => void,
) {
  let loaded = new WeakMap<BrowserContext, string>();
  return {
    /**
     * Every context loads the saved state again on its next call. Called
     * after every run: a run can change the context's cookies (a sign-out
     * demo signs it out) without changing any file — its write-back is
     * skipped — and the next run must start from the saved session, not be
     * told it has expired. Every context, not one: a run can stage on a
     * later context than the one it was handed (the browser relaunched).
     */
    forget(): void {
      loaded = new WeakMap();
    },
    async load(
      context: BrowserContext,
      choice: SessionChoice | null,
    ): Promise<SessionsLoaded> {
      let read: Awaited<ReturnType<SessionStore["read"]>>;
      try {
        read = await store.read();
      } catch (error) {
        return {
          ok: false,
          reason: "sessionUnreadable",
          detail: messageOf(error),
        };
      }
      const stamp = `${read.stamp}#${choice === null ? "" : `${choice.origin} ${choice.name}`}`;
      const files = filesFor(read.files, choice);
      if (loaded.get(context) !== stamp) {
        const { state, dropped } = restorable(mergeStates(files));
        for (const db of dropped) {
          log(
            `the saved IndexedDB database ${db} lost a record's key when it was saved, so it was not restored; the rest of the session was`,
          );
        }
        try {
          await context.setStorageState(
            state as Parameters<BrowserContext["setStorageState"]>[0],
          );
        } catch (error) {
          return {
            ok: false,
            reason: "sessionNotLoaded",
            detail: `the browser would not take the sessions saved in ${store.dir} (${messageOf(error)}) — run demoman signin again for the site you need`,
          };
        }
        loaded.set(context, stamp);
      }
      return { ok: true, files };
    },
  };
}

// apps/runner/src/executor/sessions.ts
//
// Saved sessions (launch C): one Playwright storageState per site under
// <home>/sessions, written by `demoman signin` and by a run's write-back,
// read before every snapshot and run. Spec 2026-10-15 §3.1.
import { randomBytes } from "node:crypto";
import type { Dirent } from "node:fs";
import {
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import type { BrowserContext } from "playwright";
import { getDomain } from "tldts";
import { messageOf } from "../report.js";

export type StorageState = Awaited<ReturnType<BrowserContext["storageState"]>>;

export interface SessionFile {
  sessionVersion: 1;
  site: string;
  /** When the author signed in (`signin`), ISO 8601. A write-back keeps it. */
  savedAt: string;
  /** The last write-back after a run, or null. */
  refreshedAt: string | null;
  /** The URL `signin` was given. */
  startUrl: string;
  /** Where `startUrl` landed before the author signed in; null when it
   *  landed on itself with no password field (already signed in). */
  signInUrl: string | null;
  /** Set on an account's session (launch C2): the origin and the name it
   *  was provisioned under. Absent on C's manual per-site session. */
  account?: { origin: string; name: string; definition?: string };
  state: StorageState;
}

export interface SessionChoice {
  site: string;
  origin: string;
  name: string;
}

/** An origin as a folder name, one per origin: [A-Za-z0-9] kept, every
 *  other character (`_` too) as `_` and its two hex digits, so `my-app.test`
 *  and `my.app.test` never share a folder (review 2026-10-16). An origin is
 *  ASCII (`URL` punycodes its host), so two digits always suffice. */
export const originSlug = (origin: string) =>
  origin.replace(
    /[^A-Za-z0-9]/g,
    (c) => `_${c.charCodeAt(0).toString(16).padStart(2, "0")}`,
  );

export class SessionError extends Error {}

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

/** The site a URL belongs to: its registrable domain, `localhost` for every
 *  loopback host and port (cookies ignore ports, so keying by port would
 *  claim an isolation there is none of), else the host. */
export function siteOf(raw: string): string | null {
  let host: string;
  try {
    host = new URL(raw).hostname;
  } catch {
    return null;
  }
  if (host === "") return null;
  if (LOOPBACK.has(host) || host.endsWith(".localhost")) return "localhost";
  return getDomain(host) ?? host;
}

/** One page: same origin and path, whatever the query, hash or trailing
 *  slash. A sign-in redirect carries `return_to`; the page is the same. */
export function samePage(a: string, b: string): boolean {
  try {
    const x = new URL(a);
    const y = new URL(b);
    const path = (u: URL) => u.pathname.replace(/\/+$/, "") || "/";
    return x.origin === y.origin && path(x) === path(y);
  } catch {
    return false;
  }
}

const exposed = (mode: number) =>
  process.platform !== "win32" && (mode & 0o077) !== 0;
const octal = (mode: number) => (mode & 0o777).toString(8).padStart(4, "0");
const fileName = (site: string) => `${site.replace(/[^a-z0-9.-]/gi, "_")}.json`;

function isSessionFile(v: unknown): v is SessionFile {
  if (typeof v !== "object" || v === null) return false;
  const f = v as Record<string, unknown>;
  const state = f.state as Record<string, unknown> | undefined;
  return (
    f.sessionVersion === 1 &&
    typeof f.site === "string" &&
    typeof f.savedAt === "string" &&
    typeof f.startUrl === "string" &&
    (f.signInUrl === null || typeof f.signInUrl === "string") &&
    (f.refreshedAt === null || typeof f.refreshedAt === "string") &&
    typeof state === "object" &&
    state !== null &&
    Array.isArray(state.cookies) &&
    Array.isArray(state.origins) &&
    (f.account === undefined ||
      (typeof f.account === "object" &&
        f.account !== null &&
        typeof (f.account as Record<string, unknown>).origin === "string" &&
        typeof (f.account as Record<string, unknown>).name === "string" &&
        ["undefined", "string"].includes(
          typeof (f.account as Record<string, unknown>).definition,
        )))
  );
}

export interface SessionStore {
  dir: string;
  pathOf(site: string): string;
  pathOfAccount(origin: string, name: string): string;
  /** Every saved session, and a stamp that changes whenever any file does.
   *  Throws `SessionError` naming the file and the fix: a session that
   *  cannot be read is never answered as no session. */
  read(): Promise<{ files: SessionFile[]; stamp: string }>;
  /** Writes one site's file atomically (temp file, then rename); answers
   *  its path. Throws `SessionError` naming the path and the error. */
  save(file: SessionFile): Promise<string>;
}

export function createSessionStore(home: string): SessionStore {
  const dir = join(home, "sessions");
  const pathOf = (site: string) => join(dir, fileName(site));
  const pathOfAccount = (origin: string, name: string) =>
    join(dir, originSlug(origin), `${name}.json`);

  /** One session file, refused by name when it cannot be used. */
  async function readOne(
    path: string,
    stampKey: string,
    stamp: string[],
  ): Promise<SessionFile> {
    let parsed: unknown;
    try {
      const info = await stat(path);
      if (exposed(info.mode)) {
        throw new SessionError(
          `${path} is readable by other users (mode ${octal(info.mode)}), and it holds a signed-in session — run: chmod 600 ${path}`,
        );
      }
      stamp.push(`${stampKey}:${info.mtimeMs}:${info.size}`);
      parsed = JSON.parse(await readFile(path, "utf8"));
    } catch (error) {
      if (error instanceof SessionError) throw error;
      throw new SessionError(
        `${path} could not be read as a Demoman session (${messageOf(error)}) — remove it and run demoman signin again`,
      );
    }
    if (!isSessionFile(parsed)) {
      throw new SessionError(
        `${path} is not a Demoman session file — remove it and run demoman signin again`,
      );
    }
    return parsed;
  }

  return {
    dir,
    pathOf,
    pathOfAccount,
    async read() {
      let entries: Dirent[];
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          return { files: [], stamp: "" };
        }
        throw new SessionError(
          `${dir} could not be read (${messageOf(error)})`,
        );
      }
      const dirMode = (await stat(dir)).mode;
      if (exposed(dirMode)) {
        throw new SessionError(
          `${dir} is open to other users (mode ${octal(dirMode)}), and it holds signed-in sessions — run: chmod 700 ${dir}`,
        );
      }
      const files: SessionFile[] = [];
      const stamp: string[] = [];
      const visible = entries
        .filter((e) => !e.name.startsWith("."))
        .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      // A symlink is resolved to what it points at, as C's stat/readFile did;
      // an entry that is neither a file nor a folder is refused and named,
      // never skipped as "no session".
      const kinds = new Map<string, "file" | "dir">();
      for (const entry of visible) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) {
          kinds.set(entry.name, "dir");
          continue;
        }
        if (entry.isFile()) {
          if (entry.name.endsWith(".json")) kinds.set(entry.name, "file");
          continue;
        }
        let info: Awaited<ReturnType<typeof stat>>;
        try {
          info = await stat(path);
        } catch (error) {
          throw new SessionError(
            `${path} could not be read (${messageOf(error)}) — remove it`,
          );
        }
        if (info.isDirectory()) kinds.set(entry.name, "dir");
        else if (info.isFile()) {
          if (entry.name.endsWith(".json")) kinds.set(entry.name, "file");
        } else {
          throw new SessionError(
            `${path} is neither a session file nor a folder of them — remove it`,
          );
        }
      }
      for (const [name, kind] of kinds) {
        if (kind === "file") {
          files.push(await readOne(join(dir, name), name, stamp));
        }
      }
      for (const [name, kind] of kinds) {
        if (kind !== "dir") continue;
        const entry = { name };
        const sub = join(dir, entry.name);
        let subMode: number;
        try {
          subMode = (await stat(sub)).mode;
        } catch (error) {
          throw new SessionError(
            `${sub} could not be read (${messageOf(error)}) — remove it`,
          );
        }
        if (exposed(subMode)) {
          throw new SessionError(
            `${sub} is open to other users (mode ${octal(subMode)}), and it holds signed-in sessions — run: chmod 700 ${sub}`,
          );
        }
        let names: string[];
        try {
          names = await readdir(sub);
        } catch (error) {
          throw new SessionError(
            `${sub} could not be read (${messageOf(error)})`,
          );
        }
        for (const name of names
          .filter((n) => n.endsWith(".json") && !n.startsWith("."))
          .sort()) {
          const path = join(sub, name);
          const file = await readOne(path, `${entry.name}/${name}`, stamp);
          if (
            file.account === undefined ||
            originSlug(file.account.origin) !== entry.name ||
            `${file.account.name}.json` !== name
          ) {
            throw new SessionError(
              `${path} does not belong in ${sub} — remove it`,
            );
          }
          files.push(file);
        }
      }
      return { files, stamp: stamp.join("|") };
    },
    async save(file) {
      const folder = file.account
        ? join(dir, originSlug(file.account.origin))
        : dir;
      const path = file.account
        ? pathOfAccount(file.account.origin, file.account.name)
        : pathOf(file.site);
      const base = file.account
        ? `${file.account.name}.json`
        : fileName(file.site);
      const temp = join(
        folder,
        `.${base}.${randomBytes(6).toString("hex")}.tmp`,
      );
      try {
        await mkdir(dir, { recursive: true, mode: 0o700 });
        if (folder !== dir)
          await mkdir(folder, { recursive: true, mode: 0o700 });
        await writeFile(temp, `${JSON.stringify(file, null, 2)}\n`, {
          mode: 0o600,
        });
        await rename(temp, path);
        return path;
      } catch (error) {
        // The write already failed and is being reported below; a temp file
        // that will not delete is skipped by read() (dot-file).
        await rm(temp, { force: true }).catch(() => undefined);
        throw new SessionError(
          `${path} could not be written (${messageOf(error)})`,
        );
      }
    },
  };
}

/** What one context loads: every manual session, except the chosen
 *  account's site's (one cookie jar, one user), plus that account's own
 *  file. Other accounts never load: cookies ignore ports, so two
 *  accounts of one site would overwrite each other. */
export function filesFor(
  files: readonly SessionFile[],
  choice: SessionChoice | null,
): SessionFile[] {
  return files.filter((f) =>
    f.account === undefined
      ? choice === null || f.site !== choice.site
      : choice !== null &&
        f.account.origin === choice.origin &&
        f.account.name === choice.name,
  );
}

/** Every saved site's state as one, for one context: a run can cross sites
 *  (an SSO hop), so the context carries all of them. */
export function mergeStates(files: readonly SessionFile[]): StorageState {
  return {
    cookies: files.flatMap((f) => f.state.cookies),
    origins: files.flatMap((f) => f.state.origins),
  };
}

/**
 * `state` less every IndexedDB database the browser would refuse, named in
 * `dropped`. Playwright 1.62.1 saves a record keyed `0` or `""` with no key
 * (`if (trivial) record.key = …`), and an out-of-line store cannot add it
 * back, which fails the whole state: on 2026-10-21 Actual Budget's file
 * blocks, keyed from -1, refused every localhost session.
 */
/**
 * What a run writes back to `saved`: the site's cookies, and storage only for
 * the origins `saved` already holds. Every localhost port is one site, so on
 * 2026-10-21 a run of Actual Budget on 3001 saved its budget into the session
 * signed in on 4000, and the next run of either started somewhere else.
 */
export function writeBackOf(
  state: StorageState,
  saved: SessionFile,
): StorageState {
  const slice = sliceForSite(state, saved.site);
  const held = new Set(saved.state.origins.map((o) => o.origin));
  return { ...slice, origins: slice.origins.filter((o) => held.has(o.origin)) };
}

// Playwright's public types leave IndexedDB out of the state it saves.
type SavedDatabase = {
  name: string;
  stores: {
    keyPath?: string;
    keyPathArray?: string[];
    autoIncrement: boolean;
    records: { key?: unknown; keyEncoded?: unknown }[];
  }[];
};

export function restorable(state: StorageState): {
  state: StorageState;
  dropped: string[];
} {
  const dropped: string[] = [];
  const origins = state.origins.map((o) => {
    const saved = (o as { indexedDB?: SavedDatabase[] }).indexedDB;
    if (saved === undefined) return o;
    const indexedDB = saved.filter((db) => {
      const lost = db.stores.some(
        (s) =>
          s.keyPath === undefined &&
          s.keyPathArray === undefined &&
          !s.autoIncrement &&
          s.records.some(
            (r) => r.key === undefined && r.keyEncoded === undefined,
          ),
      );
      if (lost) dropped.push(`${o.origin} "${db.name}"`);
      return !lost;
    });
    return { ...o, indexedDB };
  });
  return { state: { ...state, origins }, dropped };
}

/** The part of a state that belongs to `site`. */
export function sliceForSite(state: StorageState, site: string): StorageState {
  return {
    cookies: state.cookies.filter(
      (c) => siteOf(`http://${c.domain.replace(/^\./, "")}/`) === site,
    ),
    origins: state.origins.filter((o) => siteOf(o.origin) === site),
  };
}

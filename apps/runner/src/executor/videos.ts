import { randomUUID } from "node:crypto";
import type { Dirent } from "node:fs";
import {
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { AgentName } from "@demoman/agent-bridge";
import { isFlowId } from "@demoman/run-core";
import type { SceneDocument } from "@demoman/scene-schema";
import { messageOf } from "../report.js";
import type { Library } from "./library.js";
import type { RepoRef } from "./repo.js";
import { type Aliases, resolveKey } from "./repo-aliases.js";
import { normaliseName, sameName } from "./video-match.js";

export type VideoRepo = { key: string } | { none: string } | { unknown: true };

export interface VideoRecord {
  id: string;
  name: string;
  repo: VideoRepo;
  startPage: string;
  createdAt: string;
  /** The checkout and repo-relative kept file that commit this flow's id;
   *  written once by `keep` or `adopt`. */
  kept?: { root: string; file: string; key?: string };
}

export interface Made {
  repo: RepoRef | { none: string };
  agent: AgentName | { none: string };
  by: string | { none: string };
  door: "mcp" | "studio" | "migration";
}

export interface TakeVideo {
  videoId: string;
  made: Made;
  recordedRevision: string | null;
  expired?: { at: string; freedBytes: number };
}

export interface Version {
  takeId: string;
  number: number;
  createdAt: string;
  complete: boolean;
  edited: boolean;
  hasScript: boolean;
  expired: { at: string; freedBytes: number } | null;
}

export class VideoError extends Error {
  constructor(
    readonly reason: "videoUnreadable" | "videoUnwritable" | "videoNotFound",
    message: string,
  ) {
    super(message);
  }
}

type Taken = { ok: false; reason: "nameTaken"; holder: VideoRecord };
type Kept = { root: string; file: string; key?: string };

/** `exclusive`'s answer: `fn`'s value, or the lock another process holds. */
export type Exclusive<T> = { ok: true; value: T } | { ok: false; held: string };

export interface VideoStore {
  create(a: {
    name: string;
    repo: VideoRepo;
    startPage: string;
  }): Promise<{ ok: true; video: VideoRecord } | Taken>;
  /** Under the lock: the record whose id is `id` (a kept file's committed
   *  id), made if absent. Refuses, writing nothing, when another flow holds
   *  the name in a shared repo. Throws `videoUnwritable` on a non-flow id.
   *  `except`: a flow left out of that check (join-flow's, about to go). */
  adopt(a: {
    id: string;
    name: string;
    repo: VideoRepo;
    startPage: string;
    kept: Kept;
    except?: string;
  }): Promise<
    | { ok: true; video: VideoRecord; created: boolean }
    | { ok: false; reason: "repoFlowNameTaken"; holder: VideoRecord }
  >;
  setKept(
    id: string,
    kept: Kept | null,
  ): Promise<{ ok: true } | { ok: false; reason: "videoNotFound" }>;
  /** Under the lock: writes `key` into the mark, only while the record's mark
   *  still has this root and file. */
  setKeptKey(
    id: string,
    mark: { root: string; file: string },
    key: string,
  ): Promise<
    { ok: true } | { ok: false; reason: "videoNotFound" | "markMoved" }
  >;
  /** The repo-key aliases (`old → new`) upkeep recorded when a checkout's
   *  key changed; `{}` when none were. Throws `videoUnreadable` naming the
   *  file when it will not read. `get` and `list` answer records with their
   *  keys resolved through it. */
  aliases(): Promise<Aliases>;
  /** `repo` with its key resolved through the aliases. */
  resolve(repo: VideoRepo): Promise<VideoRepo>;
  /** Under the lock: records each `from → to` (from `from`'s current end,
   *  so aliases chain; never one that would close a cycle), then rewrites
   *  every record and kept mark whose key resolves to another, re-reading
   *  each so a change made meanwhile stays. Answers how many it rewrote,
   *  and every name two or more flows now share in one repo (merging two
   *  keys can bring an old clone's "Checkout" and a new clone's together). */
  follow(aliases: { from: string; to: string }[]): Promise<{
    moved: number;
    collisions: { name: string; ids: string[] }[];
  }>;
  /** Under the lock: re-points every take of `fromId` to `intoId`, then
   *  removes `fromId`'s record. Names the flow that is missing. */
  merge(
    fromId: string,
    intoId: string,
  ): Promise<
    | { ok: true; moved: number }
    | { ok: false; reason: "videoNotFound" | "sameFlow"; id: string }
  >;
  get(id: string): Promise<VideoRecord | null>;
  list(): Promise<Array<VideoRecord | { id: string; unreadable: string }>>;
  rename(
    id: string,
    name: string,
  ): Promise<{ ok: true } | Taken | { ok: false; reason: "videoNotFound" }>;
  /** Under the lock; throws `videoNotFound`, writing nothing, when the
   *  video's record is gone. */
  join(takeId: string, v: TakeVideo): Promise<void>;
  videoOf(takeId: string): Promise<TakeVideo | null>;
  /** A take that will not read is left out (and so never expired);
   *  `leftOut` says why. */
  versions(videoId: string): Promise<Version[]>;
  /** Why `versions()` leaves out the take whose membership is `member`,
   *  or null when it reads. */
  leftOut(takeId: string, member: TakeVideo): Promise<string | null>;
  current(videoId: string): Promise<Version | null>;
  markExpired(takeId: string, at: string, freedBytes: number): Promise<void>;
  remove(id: string): Promise<void>;
  /** Runs `fn` holding the library's lock, which every process's `create`
   *  and `rename` take too; answers `held` at once when another holds it.
   *  `fn`'s store does not take the lock again. */
  exclusive<T>(fn: (store: VideoStore) => Promise<T>): Promise<Exclusive<T>>;
}

const isMissing = (e: unknown) => (e as { code?: string }).code === "ENOENT";

/** A video record's id: run-core's `isFlowId`, the one definition the MCP
 *  checks agents' ids against too. */
export const isVideoId = isFlowId;

/** Unknown matches any repo; two `none`s are one ("no repo") for name
 *  uniqueness. Keys are compared as given: resolve both first
 *  (`VideoStore.resolve`; records from `get` and `list` already are). */
export const sharesRepo = (a: VideoRepo, b: VideoRepo) =>
  "unknown" in a ||
  "unknown" in b ||
  ("key" in a && "key" in b && a.key === b.key) ||
  ("none" in a && "none" in b);

/** Any edit list in use (a mask, hold, gap, split or removed stretch), or
 *  a trim: the scene differs from what was recorded. */
const carriesEdits = (scene: SceneDocument): boolean =>
  Object.values(scene.edits).some((v) =>
    Array.isArray(v) ? v.length > 0 : v !== undefined,
  );

/** A run writes status.json after scene.json; a scene written this much
 *  later was saved by the studio (ruling 18). */
export const EDIT_GAP_MS = 60_000;

/** A lock older than this was left by a process that died holding it. */
export const LOCK_STALE_MS = 2 * 60_000;

/** While held, the lock's mtime is refreshed this often, well inside
 *  `LOCK_STALE_MS`, so a slow holder is never taken for a dead one. */
export const LOCK_REFRESH_MS = 30_000;

export interface VideoStoreOptions {
  /** Where the lock says what it could not do without failing the call
   *  (release it, refresh it). */
  log?: (line: string) => void;
  /** Tests only: shorter than `LOCK_STALE_MS` / `LOCK_REFRESH_MS`. */
  lockStaleMs?: number;
  lockRefreshMs?: number;
}

/** Videos live in `<home>/videos/<id>.json`; a take's membership in `takes/<id>/video.json`. */
export function createVideoStore(
  home: string,
  library: Library,
  options: VideoStoreOptions = {},
): VideoStore {
  const dir = join(home, "videos");
  const recordPath = (id: string) => join(dir, `${id}.json`);
  const memberPath = (takeId: string) =>
    join(library.takeDir(takeId), "video.json");
  const lockPath = join(dir, ".lock");
  const aliasPath = join(dir, ".aliases.json");
  const ownerPath = join(lockPath, "owner");
  const say = options.log ?? ((line: string) => console.warn(line));
  const staleMs = options.lockStaleMs ?? LOCK_STALE_MS;
  const refreshMs = options.lockRefreshMs ?? LOCK_REFRESH_MS;

  // Same temp-then-rename as library.ts: a kill leaves the old file or the new one.
  async function write(path: string, value: unknown): Promise<void> {
    const temp = `${path}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`;
    try {
      await mkdir(dir, { recursive: true, mode: 0o700 });
      await writeFile(temp, JSON.stringify(value), { mode: 0o600 });
      await rename(temp, path);
    } catch (error) {
      await rm(temp, { force: true }).catch(() => undefined);
      throw new VideoError(
        "videoUnwritable",
        `could not write ${path} (${messageOf(error)})`,
      );
    }
  }

  /** A take's membership. Its folder is never made here: a write landing
   *  after the take was deleted would bring the folder back. */
  async function writeMember(takeId: string, value: TakeVideo): Promise<void> {
    const path = memberPath(takeId);
    const temp = `${path}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`;
    try {
      await writeFile(temp, JSON.stringify(value), { mode: 0o600 });
      await rename(temp, path);
    } catch (error) {
      await rm(temp, { force: true }).catch(() => undefined);
      throw new VideoError(
        "videoUnwritable",
        isMissing(error)
          ? `video ${takeId} is gone (${dirname(path)} no longer exists), so ${path} was not written`
          : `could not write ${path} (${messageOf(error)})`,
      );
    }
  }

  /**
   * Holds `<home>/videos/.lock` for `fn`: a folder, since `mkdir` makes it
   * for one process only. `wait`: poll until it is free; else answer `held`
   * at once. A lock not refreshed for `LOCK_STALE_MS` is taken over. Its
   * `owner` file names the holder (a token, and the pid for people), and
   * only the holder removes it.
   */
  async function locked<T>(
    fn: () => Promise<T>,
    wait: boolean,
  ): Promise<Exclusive<T>> {
    const unwritable = (doing: string, error: unknown) =>
      new VideoError(
        "videoUnwritable",
        `could not ${doing} ${lockPath} (${messageOf(error)})`,
      );
    try {
      await mkdir(dir, { recursive: true, mode: 0o700 });
    } catch (error) {
      throw unwritable("make the folder for", error);
    }
    for (;;) {
      try {
        await mkdir(lockPath, { mode: 0o700 });
        break;
      } catch (error) {
        if ((error as { code?: string }).code !== "EEXIST")
          throw unwritable("take", error);
      }
      let since: number;
      try {
        since = (await stat(lockPath)).mtimeMs;
      } catch (error) {
        if (isMissing(error)) continue; // released between the two calls
        throw unwritable("read", error);
      }
      if (Date.now() - since > staleMs) {
        // Renamed aside first: of two processes taking it over, one rename
        // wins and the other finds it gone and tries again.
        const aside = `${lockPath}.stale-${randomUUID()}`;
        try {
          await rename(lockPath, aside);
          await rm(aside, { recursive: true, force: true });
        } catch (error) {
          if (!isMissing(error)) throw unwritable("take over", error);
        }
        continue;
      }
      if (!wait) {
        return {
          ok: false,
          held: `another Demoman process holds ${lockPath} (last refreshed ${new Date(since).toISOString()})`,
        };
      }
      await delay(100);
    }
    const token = randomUUID();
    try {
      await writeFile(ownerPath, JSON.stringify({ token, pid: process.pid }), {
        mode: 0o600,
      });
    } catch (error) {
      await rm(lockPath, { recursive: true, force: true }).catch((e) =>
        say(
          `${lockPath} could not be removed after its owner file failed to write (${messageOf(e)}); it is taken over once ${staleMs / 1000} s old`,
        ),
      );
      throw unwritable("write the owner of", error);
    }
    const refresh = setInterval(() => {
      const now = new Date();
      utimes(lockPath, now, now).catch((error: unknown) =>
        say(
          `could not refresh ${lockPath} (${messageOf(error)}); another process may take it over`,
        ),
      );
    }, refreshMs);
    refresh.unref();
    try {
      return { ok: true, value: await fn() };
    } finally {
      clearInterval(refresh);
      await release(token);
    }
  }

  /** Removes the lock if it is still `token`'s; never throws, so `fn`'s
   *  answer stands, and says what it could not do. */
  async function release(token: string): Promise<void> {
    let owner: { token?: unknown } | null;
    try {
      owner = JSON.parse(await readFile(ownerPath, "utf8"));
    } catch (error) {
      say(
        `left ${lockPath} in place: its owner file will not read (${messageOf(error)}), so it may be another process's now`,
      );
      return;
    }
    if (owner?.token !== token) {
      say(
        `left ${lockPath} in place: another process took it over while this one held it`,
      );
      return;
    }
    // Checked, then removed: a takeover between the two needs this holder
    // to stall `LOCK_STALE_MS` here, with the refresh just cleared.
    try {
      await rm(lockPath, { recursive: true, force: true });
    } catch (error) {
      say(
        `could not release ${lockPath} (${messageOf(error)}); another process takes it over once it is ${staleMs / 1000} s old`,
      );
    }
  }

  /** `locked` that waits, so it always answers `fn`'s value. */
  async function waitLocked<T>(fn: () => Promise<T>): Promise<T> {
    const r = await locked(fn, true);
    if (!r.ok)
      throw new Error(`unreachable: a waiting lock answered ${r.held}`);
    return r.value;
  }

  /** null only when the file is absent; anything else unreadable throws. */
  async function readJson<T>(path: string): Promise<T | null> {
    let text: string;
    try {
      text = await readFile(path, "utf8");
    } catch (error) {
      if (isMissing(error)) return null;
      throw new VideoError(
        "videoUnreadable",
        `could not read ${path} (${messageOf(error)})`,
      );
    }
    try {
      return JSON.parse(text) as T;
    } catch (error) {
      throw new VideoError(
        "videoUnreadable",
        `${path} is not JSON (${messageOf(error)})`,
      );
    }
  }

  const rawGet = async (id: string) =>
    isVideoId(id) ? readJson<VideoRecord>(recordPath(id)) : null;

  /** Absent is none; anything but an object of key strings throws. */
  async function aliases(): Promise<Aliases> {
    const table = await readJson<unknown>(aliasPath);
    if (table === null) return {};
    if (
      typeof table !== "object" ||
      Array.isArray(table) ||
      Object.values(table).some((v) => typeof v !== "string")
    ) {
      throw new VideoError(
        "videoUnreadable",
        `${aliasPath} is not a table of repo keys`,
      );
    }
    return table as Aliases;
  }

  /** For reading records: a table that will not read resolves nothing, and
   *  says so here; the Studio's upkeep, which reads it strictly, names it
   *  in a row. */
  async function readableAliases(): Promise<Aliases> {
    try {
      return await aliases();
    } catch (error) {
      say(
        `${messageOf(error)}; flows are listed under the repo keys they recorded`,
      );
      return {};
    }
  }

  const resolveRepo = (repo: VideoRepo, table: Aliases): VideoRepo =>
    "key" in repo ? { key: resolveKey(table, repo.key) } : repo;

  const resolved = (rec: VideoRecord, table: Aliases): VideoRecord => ({
    ...rec,
    repo: resolveRepo(rec.repo, table),
    ...(rec.kept?.key !== undefined && {
      kept: { ...rec.kept, key: resolveKey(table, rec.kept.key) },
    }),
  });

  const get = async (id: string) => {
    const rec = await rawGet(id);
    return rec && resolved(rec, await readableAliases());
  };

  async function ids(path: string): Promise<string[]> {
    try {
      return await readdir(path);
    } catch (error) {
      if (isMissing(error)) return [];
      throw new VideoError(
        "videoUnreadable",
        `could not list ${path} (${messageOf(error)})`,
      );
    }
  }

  async function list() {
    const out: Array<VideoRecord | { id: string; unreadable: string }> = [];
    const table = await readableAliases();
    for (const f of await ids(dir)) {
      // Only `<uuid>.json` is a record: `.expiry.json`, `.lock` and
      // `.DS_Store` are not, and a row for one could never be deleted.
      const id = f.slice(0, -".json".length);
      if (!f.endsWith(".json") || !isVideoId(id)) continue;
      try {
        const rec = await rawGet(id);
        if (rec) out.push(resolved(rec, table));
      } catch (error) {
        out.push({ id, unreadable: messageOf(error) });
      }
    }
    return out;
  }

  async function holderOf(
    name: string,
    repo: VideoRepo,
    exceptId?: string,
  ): Promise<VideoRecord | null> {
    repo = resolveRepo(repo, await readableAliases());
    for (const r of await list()) {
      if ("unreadable" in r || r.id === exceptId) continue;
      if (sharesRepo(r.repo, repo) && sameName(r.name, name)) return r;
    }
    return null;
  }

  /** Ruling 18: a migrated take has no recorded revision, so it counts as
   *  edited when it carries an edit list, when its scene.json was written
   *  over `EDIT_GAP_MS` after status.json, or when it has no status.json. */
  async function migratedEdited(
    takeId: string,
    scene: SceneDocument,
  ): Promise<boolean> {
    if (carriesEdits(scene)) return true;
    const mtime = async (name: string): Promise<number | null> => {
      const path = join(library.takeDir(takeId), name);
      try {
        return (await stat(path)).mtimeMs;
      } catch (error) {
        if (isMissing(error)) return null;
        throw new VideoError(
          "videoUnreadable",
          `could not read ${path} (${messageOf(error)})`,
        );
      }
    };
    const status = await mtime("status.json");
    if (status === null) return true;
    const written = await mtime("scene.json");
    return written !== null && written - status > EDIT_GAP_MS;
  }

  /** A member take as a version (numbered later); throws a VideoError
   *  naming the file that will not read. */
  async function readVersion(
    takeId: string,
    member: TakeVideo,
  ): Promise<Version & { at: number }> {
    let read: Awaited<ReturnType<Library["getSceneRead"]>>;
    try {
      read = await library.getSceneRead(takeId);
    } catch (error) {
      throw new VideoError("videoUnreadable", messageOf(error));
    }
    if (!read) {
      throw new VideoError(
        "videoUnreadable",
        `${join(library.takeDir(takeId), "scene.json")} is missing but ${memberPath(takeId)} names video ${member.videoId}`,
      );
    }
    const status = await readJson<{ outcome?: string }>(
      join(library.takeDir(takeId), "status.json"),
    );
    const script = await readJson<unknown>(
      join(library.takeDir(takeId), "script.json"),
    );
    const createdAt = read.scene.meta.createdAt;
    return {
      takeId,
      number: 0,
      createdAt,
      at: Date.parse(createdAt),
      complete: status?.outcome === "complete",
      edited:
        member.recordedRevision === null
          ? await migratedEdited(takeId, read.scene)
          : read.revision !== member.recordedRevision,
      hasScript: script !== null,
      expired: member.expired ?? null,
    };
  }

  // shortcut: reads every take's video.json per call, so a listing costs videos × takes reads; build an index when listings are measured slow.
  async function versions(videoId: string): Promise<Version[]> {
    if (!isVideoId(videoId)) return [];
    const found: Array<Version & { at: number }> = [];
    let entries: Dirent[] = [];
    try {
      entries = await readdir(join(home, "takes"), { withFileTypes: true });
    } catch (error) {
      if (!isMissing(error)) {
        throw new VideoError(
          "videoUnreadable",
          `could not list ${join(home, "takes")} (${messageOf(error)})`,
        );
      }
    }
    for (const entry of entries) {
      // Strays (.DS_Store, the library's .trash-* folders) are not takes.
      if (!entry.isDirectory() || !library.isTakeId(entry.name)) continue;
      const takeId = entry.name;
      try {
        const member = await readJson<TakeVideo>(memberPath(takeId));
        if (member?.videoId !== videoId) continue;
        found.push(await readVersion(takeId, member));
      } catch (error) {
        if (!(error instanceof VideoError)) throw error;
        // One take that will not read (its video.json, scene, status or
        // script) must not hide every video: it is left out, and so never
        // expired, and ensureVideos, which every listing runs first, names
        // it in `skipped`.
      }
    }
    found.sort((a, b) => a.at - b.at || a.takeId.localeCompare(b.takeId));
    return found.map(({ at: _at, ...v }, i) => ({ ...v, number: i + 1 }));
  }

  // Read-check-write: only under the lock, or two processes could both
  // find a name free.
  const createUnlocked: VideoStore["create"] = async (a) => {
    const holder = await holderOf(a.name, a.repo);
    if (holder) return { ok: false, reason: "nameTaken", holder };
    const video: VideoRecord = {
      id: randomUUID(),
      name: a.name,
      repo: a.repo,
      startPage: a.startPage,
      createdAt: new Date().toISOString(),
    };
    await write(recordPath(video.id), video);
    return { ok: true, video };
  };
  const renameUnlocked: VideoStore["rename"] = async (id, name) => {
    const rec = await get(id);
    if (!rec) return { ok: false, reason: "videoNotFound" };
    const holder = await holderOf(name, rec.repo, id);
    if (holder) return { ok: false, reason: "nameTaken", holder };
    await write(recordPath(id), { ...rec, name });
    return { ok: true };
  };

  // Under the lock: the record is read, and rewritten to adopt a repo, with
  // no rename landing in between to be overwritten.
  const joinUnlocked: VideoStore["join"] = async (takeId, v) => {
    const rec = await get(v.videoId);
    if (!rec) {
      throw new VideoError(
        "videoNotFound",
        `flow ${v.videoId} was deleted, so video ${takeId} was not joined to it`,
      );
    }
    await writeMember(takeId, v);
    if ("unknown" in rec.repo && "key" in v.made.repo) {
      await write(recordPath(rec.id), {
        ...rec,
        repo: { key: v.made.repo.key },
      });
    }
  };

  const adoptUnlocked: VideoStore["adopt"] = async (a) => {
    if (!isFlowId(a.id)) {
      throw new VideoError(
        "videoUnwritable",
        `"${a.id}" is not a flow id, so no flow was adopted`,
      );
    }
    const existing = await get(a.id);
    if (existing) {
      const holder = await holderOf(a.name, existing.repo, a.id);
      if (holder) return { ok: false, reason: "repoFlowNameTaken", holder };
      const video = { ...existing, name: a.name, kept: a.kept };
      await write(recordPath(a.id), video);
      return { ok: true, video, created: false };
    }
    const holder = await holderOf(a.name, a.repo, a.except);
    if (holder) return { ok: false, reason: "repoFlowNameTaken", holder };
    const video: VideoRecord = {
      id: a.id,
      name: a.name,
      repo: a.repo,
      startPage: a.startPage,
      createdAt: new Date().toISOString(),
      kept: a.kept,
    };
    await write(recordPath(a.id), video);
    return { ok: true, video, created: true };
  };
  const setKeptUnlocked: VideoStore["setKept"] = async (id, kept) => {
    const rec = await get(id);
    if (!rec) return { ok: false, reason: "videoNotFound" };
    const { kept: _old, ...rest } = rec;
    await write(recordPath(id), kept ? { ...rest, kept } : rest);
    return { ok: true };
  };
  const setKeptKeyUnlocked: VideoStore["setKeptKey"] = async (
    id,
    mark,
    key,
  ) => {
    const rec = await get(id);
    if (!rec) return { ok: false, reason: "videoNotFound" };
    if (rec.kept?.root !== mark.root || rec.kept.file !== mark.file)
      return { ok: false, reason: "markMoved" };
    await write(recordPath(id), { ...rec, kept: { ...rec.kept, key } });
    return { ok: true };
  };
  const followUnlocked: VideoStore["follow"] = async (pairs) => {
    let table = await aliases();
    for (const { from, to } of pairs) {
      const end = resolveKey(table, from);
      if (resolveKey(table, to) !== end) table = { ...table, [end]: to };
    }
    if (pairs.length > 0) await write(aliasPath, table);
    let moved = 0;
    const named = new Map<string, { name: string; ids: string[] }>();
    for (const f of (await ids(dir)).sort()) {
      const id = f.slice(0, -".json".length);
      if (!f.endsWith(".json") || !isVideoId(id)) continue;
      let rec: VideoRecord | null;
      try {
        rec = await rawGet(id);
      } catch {
        continue; // the listing names a record that will not read
      }
      if (rec === null) continue;
      const now = resolved(rec, table);
      if ("key" in now.repo) {
        const at = `${now.repo.key}\n${normaliseName(now.name)}`;
        const group = named.get(at) ?? { name: now.name, ids: [] };
        group.ids.push(id);
        named.set(at, group);
      }
      if (JSON.stringify(now) === JSON.stringify(rec)) continue;
      await write(recordPath(id), now);
      moved++;
    }
    const collisions = [...named.values()].filter((g) => g.ids.length > 1);
    return { moved, collisions };
  };
  const mergeUnlocked: VideoStore["merge"] = async (fromId, intoId) => {
    if (fromId === intoId) return { ok: false, reason: "sameFlow", id: fromId };
    for (const id of [fromId, intoId]) {
      if (!(await get(id))) return { ok: false, reason: "videoNotFound", id };
    }
    let entries: Dirent[] = [];
    try {
      entries = await readdir(join(home, "takes"), { withFileTypes: true });
    } catch (error) {
      if (!isMissing(error)) {
        throw new VideoError(
          "videoUnreadable",
          `could not list ${join(home, "takes")} (${messageOf(error)})`,
        );
      }
    }
    let moved = 0;
    entries.sort((a, b) => a.name.localeCompare(b.name));
    try {
      for (const entry of entries) {
        if (!entry.isDirectory() || !library.isTakeId(entry.name)) continue;
        const member = await readJson<TakeVideo>(memberPath(entry.name));
        if (member?.videoId !== fromId) continue;
        await joinUnlocked(entry.name, { ...member, videoId: intoId });
        moved++;
      }
    } catch (error) {
      // The source record stays; say how far the merge got.
      throw new VideoError(
        error instanceof VideoError ? error.reason : "videoUnwritable",
        `merge of ${fromId} into ${intoId} stopped after moving ${moved} video${moved === 1 ? "" : "s"} into ${intoId}; ${fromId} still exists: ${messageOf(error)}`,
      );
    }
    await rm(recordPath(fromId), { force: true });
    return { ok: true, moved };
  };

  const store: VideoStore = {
    create: (a) => waitLocked(() => createUnlocked(a)),
    adopt: (a) => waitLocked(() => adoptUnlocked(a)),
    setKept: (id, kept) => waitLocked(() => setKeptUnlocked(id, kept)),
    setKeptKey: (id, mark, key) =>
      waitLocked(() => setKeptKeyUnlocked(id, mark, key)),
    merge: (f, i) => waitLocked(() => mergeUnlocked(f, i)),
    aliases,
    resolve: async (repo) => resolveRepo(repo, await readableAliases()),
    follow: (pairs) => waitLocked(() => followUnlocked(pairs)),
    get,
    list,
    rename: (id, name) => waitLocked(() => renameUnlocked(id, name)),
    join: (takeId, v) => waitLocked(() => joinUnlocked(takeId, v)),
    videoOf: (takeId) => readJson<TakeVideo>(memberPath(takeId)),
    versions,
    async leftOut(takeId, member) {
      try {
        await readVersion(takeId, member);
        return null;
      } catch (error) {
        if (!(error instanceof VideoError)) throw error;
        return error.message;
      }
    },
    async current(videoId) {
      const all = await versions(videoId);
      return all.filter((v) => v.complete).at(-1) ?? null;
    },
    async markExpired(takeId, at, freedBytes) {
      const member = await readJson<TakeVideo>(memberPath(takeId));
      if (!member) {
        throw new VideoError(
          "videoUnreadable",
          `${memberPath(takeId)} is missing, so the video cannot be marked expired`,
        );
      }
      await writeMember(takeId, {
        ...member,
        expired: { at, freedBytes },
      });
    },
    async remove(id) {
      if (!isVideoId(id)) {
        throw new VideoError(
          "videoUnwritable",
          `"${id}" is not a video id, so nothing was removed`,
        );
      }
      await rm(recordPath(id), { force: true });
    },
    exclusive: (fn) =>
      locked(
        () =>
          fn({
            ...store,
            create: createUnlocked,
            adopt: adoptUnlocked,
            setKept: setKeptUnlocked,
            setKeptKey: setKeptKeyUnlocked,
            merge: mergeUnlocked,
            follow: followUnlocked,
            rename: renameUnlocked,
            join: joinUnlocked,
          }),
        false,
      ),
  };
  return store;
}

import { createHash, randomUUID } from "node:crypto";
import type { Dirent } from "node:fs";
import {
  chmod,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { join, sep } from "node:path";
import {
  type OutputListing,
  type OutputRecord,
  parseSkeleton,
  type SkeletonRead,
  untitleTimestampName,
} from "@demoman/run-core";
import {
  migrateToCurrent,
  type SceneDocument,
  SchemaVersionError,
} from "@demoman/scene-schema";
import { createFileFrameStore, type RunnerStore } from "../frame-store.js";
import { messageOf } from "../report.js";

export type LibraryReason = "libraryUnreadable" | "libraryUnwritable";

/** A library failure, with the reason the agent is answered and the path. */
export class LibraryError extends Error {
  constructor(
    readonly reason: LibraryReason,
    message: string,
  ) {
    super(message);
  }
}

export type TakeEntry =
  | {
      id: string;
      name: string;
      createdAt: string;
      mode: string;
      actions: number;
    }
  /** A folder under `takes/` that is not a readable take, and why — listed
   *  rather than refusing the whole list over it (review 2026-10-13, #2). */
  | { id: string; unreadable: string };

/** Who is reading a take for an export: a file in `takes/<id>/.busy/`. */
export interface LeaseHolder {
  pid: number;
  op: "export";
  door: "agent" | "studio";
  jobId: string;
  startedAt: string;
}

export interface Lease {
  release(): Promise<void>;
}

export type DeleteAnswer =
  | { ok: true; clearedLeases: LeaseHolder[]; leftBehind: string | null }
  | { ok: false; holders: LeaseHolder[] }
  | { ok: false; missing: true };

export type PutSceneIfAnswer =
  | { ok: true; revision: string }
  | { ok: false; current: string | null };

export interface Library {
  readonly root: string;
  /** Whether `id` can name a take folder at all (one name under `takes/`). */
  isTakeId(id: string): boolean;
  takeDir(id: string): string;
  frameStore(id: string): RunnerStore;
  putScene(doc: SceneDocument): Promise<void>;
  getScene(id: string): Promise<SceneDocument | null>;
  /** The scene, its revision (the sha256 hex of `scene.json`'s bytes), and
   *  what reading it took away from it (`migrateToCurrent`'s notes). */
  getSceneRead(id: string): Promise<{
    scene: SceneDocument;
    revision: string;
    notes: string[];
  } | null>;
  /** Writes `doc` only when `scene.json` still hashes to `ifMatch`. */
  putSceneIf(doc: SceneDocument, ifMatch: string): Promise<PutSceneIfAnswer>;
  lease(
    id: string,
    holder: Omit<LeaseHolder, "pid" | "startedAt">,
  ): Promise<Lease>;
  deleteTake(id: string): Promise<DeleteAnswer>;
  appendOutput(id: string, row: OutputRecord): Promise<void>;
  outputs(id: string): Promise<OutputListing[]>;
  putJson(
    id: string,
    name: "report.json" | "status.json" | "script.json",
    value: unknown,
  ): Promise<void>;
  getSkeleton(id: string): Promise<SkeletonRead>;
  removeTake(id: string): Promise<void>;
  list(): Promise<TakeEntry[]>;
}

const sha256 = (text: string): string =>
  createHash("sha256").update(text).digest("hex");

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

const LOCK_RETRY_MS = 25;
const LOCK_WAIT_MS = 2000;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const isMissing = (error: unknown): boolean =>
  (error as NodeJS.ErrnoException | null)?.code === "ENOENT";

/** `outputs.json`'s rows: none when the file is absent, and a named
 *  failure when it is there and will not read — never `[]`. */
async function readOutputRows(file: string): Promise<OutputRecord[]> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    if (isMissing(error)) return [];
    throw new LibraryError(
      "libraryUnreadable",
      `could not read ${file} (${messageOf(error)})`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new LibraryError(
      "libraryUnreadable",
      `${file} is not JSON (${messageOf(error)})`,
    );
  }
  if (!Array.isArray(parsed)) {
    throw new LibraryError(
      "libraryUnreadable",
      `${file} is not a list of outputs`,
    );
  }
  return parsed as OutputRecord[];
}

/** The lease files in a take's `.busy/` folder, parsed. A file that will
 *  not parse is said, not skipped: skipping it would let a delete past a
 *  live export. */
export async function readLeases(
  dir: string,
): Promise<{ file: string; holder: LeaseHolder }[]> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (error) {
    if (isMissing(error)) return [];
    throw new LibraryError(
      "libraryUnreadable",
      `could not list ${dir} (${messageOf(error)})`,
    );
  }
  const found: { file: string; holder: LeaseHolder }[] = [];
  for (const name of names.filter((n) => n.endsWith(".json"))) {
    const file = join(dir, name);
    try {
      found.push({
        file,
        holder: JSON.parse(await readFile(file, "utf8")) as LeaseHolder,
      });
    } catch (error) {
      throw new LibraryError(
        "libraryUnreadable",
        `could not read the lease ${file} (${messageOf(error)})`,
      );
    }
  }
  return found;
}

/**
 * The CLI's take library: one folder per take, plain files, so step 2's
 * studio reads them with no migration. `<home>/takes/<id>/scene.json`, the
 * frames (`createFileFrameStore`), `status.json` and `report.json`.
 *
 * Every failure is a `LibraryError` naming the path — never a null that
 * reads as "no such take", which is the one answer a missing take gets.
 */
/**
 * The Demoman home, made owner-only: takes are frames of signed-in pages,
 * as private as the sessions they come from (audit run 1). Chmodded too,
 * because a recursive mkdir's mode does not reach a folder already there.
 */
export async function ownHome(home: string): Promise<void> {
  await mkdir(home, { recursive: true, mode: 0o700 });
  await chmod(home, 0o700);
}

export function createLibrary(
  home: string,
  options: { updateCommand?: string } = {},
): Library {
  const root = join(home, "takes");
  /** An id is one folder name under `takes/`; anything else would reach
   *  outside the library (or, empty, be the library itself). */
  const isTakeId = (id: string): boolean =>
    !(
      id === "" ||
      // `.`, `..`, and the library's own `.trash-*` folders.
      id.startsWith(".") ||
      id.includes("/") ||
      id.includes("\\") ||
      id.includes(sep)
    );
  const guard = (id: string, reason: LibraryReason): void => {
    if (!isTakeId(id)) {
      throw new LibraryError(reason, `"${id}" is not a take id`);
    }
  };
  const takeDir = (id: string) => {
    guard(id, "libraryUnreadable");
    return join(root, id);
  };

  async function readTakeRaw(
    id: string,
  ): Promise<{ doc: SceneDocument; revision: string; notes: string[] } | null> {
    const path = join(takeDir(id), "scene.json");
    let text: string;
    try {
      text = await readFile(path, "utf8");
    } catch (error) {
      if (isMissing(error)) return null;
      throw new LibraryError(
        "libraryUnreadable",
        `could not read ${path} (${messageOf(error)})`,
      );
    }
    let doc: SceneDocument;
    const notes: string[] = [];
    try {
      doc = migrateToCurrent(JSON.parse(text), notes);
    } catch (error) {
      const fix =
        error instanceof SchemaVersionError &&
        error.tooNew &&
        options.updateCommand !== undefined
          ? ` — it was written by a newer Demoman; run \`${options.updateCommand}\``
          : "";
      throw new LibraryError(
        "libraryUnreadable",
        `${path} is not a take (${messageOf(error)})${fix}`,
      );
    }
    // Every reader and writer goes to `takes/<meta.id>/`. A folder named
    // otherwise — copied or renamed in Finder — would list as that take,
    // and its Delete would remove the take's real folder, not this one.
    if (doc.meta.id !== id) {
      throw new LibraryError(
        "libraryUnreadable",
        `${takeDir(id)} holds the take ${doc.meta.id}, so it was copied or renamed: a take's folder must be named after its id`,
      );
    }
    return { doc, revision: sha256(text), notes };
  }

  async function readTake(id: string): Promise<SceneDocument | null> {
    const read = await readTakeRaw(id);
    return read === null ? null : untitleTimestampName(read.doc);
  }

  const busyDir = (id: string) => join(takeDir(id), ".busy");

  const holdersOf = (id: string) => readLeases(busyDir(id));

  /** Written beside, then renamed over: a process killed mid-write leaves
   *  the old file or the new one, never half of one (review 2026-10-13,
   *  #2). The leftover temp file of such a kill is not a take's file. */
  async function write(path: string, text: string): Promise<void> {
    const temp = `${path}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`;
    try {
      await mkdir(join(path, ".."), { recursive: true, mode: 0o700 });
      await writeFile(temp, text, { mode: 0o600 });
      await rename(temp, path);
    } catch (error) {
      // Only the temp file: whatever was at `path` before is still there.
      // A temp file that will not go either is the same failure the throw
      // below names, in the same folder.
      await rm(temp, { force: true }).catch(() => undefined);
      throw new LibraryError(
        "libraryUnwritable",
        `could not write ${path} (${messageOf(error)}) — the library is ${root}`,
      );
    }
  }

  return {
    root,
    isTakeId,
    takeDir,
    frameStore: (id) => createFileFrameStore(join(takeDir(id), "frames")),
    async putScene(doc) {
      guard(doc.meta.id, "libraryUnwritable");
      await write(
        join(takeDir(doc.meta.id), "scene.json"),
        JSON.stringify(doc),
      );
    },
    getScene: readTake,
    async getSceneRead(id) {
      const read = await readTakeRaw(id);
      return read === null
        ? null
        : {
            scene: untitleTimestampName(read.doc),
            revision: read.revision,
            notes: read.notes,
          };
    },
    async putSceneIf(doc, ifMatch) {
      guard(doc.meta.id, "libraryUnwritable");
      const path = join(takeDir(doc.meta.id), "scene.json");
      let current: string | null;
      try {
        current = sha256(await readFile(path, "utf8"));
      } catch (error) {
        if (!isMissing(error)) {
          throw new LibraryError(
            "libraryUnreadable",
            `could not read ${path} (${messageOf(error)})`,
          );
        }
        current = null;
      }
      if (current !== ifMatch) return { ok: false, current };
      // Check-then-rename is not atomic across processes. That is accepted:
      // the studio is the only scene writer for an existing take and it
      // serialises saves per take, so no second writer races this gap.
      const text = JSON.stringify(doc);
      await write(path, text);
      return { ok: true, revision: sha256(text) };
    },
    async lease(id, holder) {
      guard(id, "libraryUnwritable");
      const full: LeaseHolder = {
        ...holder,
        pid: process.pid,
        startedAt: new Date().toISOString(),
      };
      const file = join(busyDir(id), `${full.pid}-${full.jobId}.json`);
      await write(file, JSON.stringify(full));
      return {
        async release() {
          try {
            await rm(file, { force: true });
          } catch (error) {
            throw new LibraryError(
              "libraryUnwritable",
              `could not remove the lease ${file} (${messageOf(error)})`,
            );
          }
        },
      };
    },
    async deleteTake(id) {
      guard(id, "libraryUnwritable");
      const path = join(root, id);
      try {
        await stat(path);
      } catch (error) {
        if (isMissing(error)) return { ok: false, missing: true };
        throw new LibraryError(
          "libraryUnreadable",
          `could not read ${path} (${messageOf(error)})`,
        );
      }
      const clearedLeases: LeaseHolder[] = [];
      const holders: LeaseHolder[] = [];
      for (const { file, holder } of await holdersOf(id)) {
        if (pidAlive(holder.pid)) {
          holders.push(holder);
          continue;
        }
        try {
          await rm(file, { force: true });
        } catch (error) {
          throw new LibraryError(
            "libraryUnwritable",
            `could not clear the dead lease ${file} (${messageOf(error)})`,
          );
        }
        clearedLeases.push(holder);
      }
      if (holders.length > 0) return { ok: false, holders };
      const trash = join(root, `.trash-${id}-${Date.now()}`);
      try {
        await rename(path, trash);
      } catch (error) {
        throw new LibraryError(
          "libraryUnwritable",
          `could not move ${path} to ${trash} (${messageOf(error)})`,
        );
      }
      try {
        await rm(trash, { recursive: true, force: true });
      } catch {
        // The take is gone from the library; only its bytes remain. Said in
        // the answer, so the caller can tell the person where they are.
        return { ok: true, clearedLeases, leftBehind: trash };
      }
      return { ok: true, clearedLeases, leftBehind: null };
    },
    async appendOutput(id, row) {
      guard(id, "libraryUnwritable");
      const file = join(takeDir(id), "outputs.json");
      const lock = `${file}.lock`;
      const deadline = Date.now() + LOCK_WAIT_MS;
      for (;;) {
        try {
          const handle = await open(lock, "wx", 0o600);
          try {
            await handle.writeFile(JSON.stringify({ pid: process.pid }));
          } finally {
            await handle.close();
          }
          break;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
            throw new LibraryError(
              "libraryUnwritable",
              `could not take ${lock} (${messageOf(error)})`,
            );
          }
        }
        // Held. A holder that died leaves the lock behind: take it over.
        let holderPid: number | null = null;
        try {
          const parsed = JSON.parse(await readFile(lock, "utf8")) as {
            pid?: unknown;
          };
          if (typeof parsed.pid === "number") holderPid = parsed.pid;
        } catch {
          // Empty or half-written: the holder is between open and write, so
          // treat it as live; the deadline below names it if it never ends.
        }
        if (holderPid !== null && !pidAlive(holderPid)) {
          await rm(lock, { force: true });
          continue;
        }
        if (Date.now() >= deadline) {
          throw new LibraryError(
            "libraryUnwritable",
            `${lock} stayed held for ${LOCK_WAIT_MS} ms${holderPid === null ? "" : ` by process ${holderPid}`}`,
          );
        }
        await sleep(LOCK_RETRY_MS);
      }
      let failure: unknown;
      try {
        const rows = await readOutputRows(file);
        rows.push(row);
        await write(file, JSON.stringify(rows, null, 2));
      } catch (error) {
        failure = error;
      }
      try {
        await rm(lock, { force: true });
      } catch (error) {
        // A lock left holding this live pid would make every later append
        // wait out its deadline and blame "another process". Say so here.
        throw new LibraryError(
          "libraryUnwritable",
          `${failure === undefined ? "the row was listed in" : "could not write"} ${file}, but the lock ${lock} could not be removed (${messageOf(error)}) — remove it by hand or later exports of this take will wait on it`,
        );
      }
      if (failure !== undefined) throw failure;
    },
    async outputs(id) {
      const rows = await readOutputRows(join(takeDir(id), "outputs.json"));
      const listed: OutputListing[] = [];
      for (const row of rows) {
        let exists = true;
        try {
          await stat(row.path);
        } catch (error) {
          if (!isMissing(error)) {
            throw new LibraryError(
              "libraryUnreadable",
              `could not read ${row.path} (${messageOf(error)})`,
            );
          }
          exists = false;
        }
        listed.push({ ...row, exists });
      }
      return listed;
    },
    async putJson(id, name, value) {
      guard(id, "libraryUnwritable");
      await write(join(takeDir(id), name), JSON.stringify(value, null, 2));
    },
    /** `script.json`: none (an old or extension take), one, or one that
     *  will not read — never the same answer for the last two. */
    async getSkeleton(id) {
      const path = join(takeDir(id), "script.json");
      let text: string;
      try {
        text = await readFile(path, "utf8");
      } catch (error) {
        if (isMissing(error)) return { kind: "none" };
        return {
          kind: "unreadable",
          error: `could not read ${path} (${messageOf(error)})`,
        };
      }
      let raw: unknown;
      try {
        raw = JSON.parse(text);
      } catch (error) {
        return {
          kind: "unreadable",
          error: `${path} is not JSON (${messageOf(error)})`,
        };
      }
      const parsed = parseSkeleton(raw);
      return parsed.ok
        ? { kind: "ok", skeleton: parsed.skeleton }
        : { kind: "unreadable", error: `${path}: ${parsed.error}` };
    },
    async removeTake(id) {
      guard(id, "libraryUnwritable");
      const path = join(root, id);
      try {
        await rm(path, { recursive: true, force: true });
      } catch (error) {
        throw new LibraryError(
          "libraryUnwritable",
          `could not remove ${path} (${messageOf(error)})`,
        );
      }
    },
    async list() {
      let dirents: Dirent[];
      try {
        dirents = await readdir(root, { withFileTypes: true });
      } catch (error) {
        if (isMissing(error)) return [];
        throw new LibraryError(
          "libraryUnreadable",
          `could not list ${root} (${messageOf(error)})`,
        );
      }
      const entries: Extract<TakeEntry, { name: string }>[] = [];
      // One folder that will not read — a truncated scene.json, a schema
      // this build cannot migrate — is said on its own entry, after the
      // takes, and never costs the agent every other take.
      const unreadable: Extract<TakeEntry, { unreadable: string }>[] = [];
      const ids = dirents
        // A stray file (.DS_Store) is not a take; a folder is read below.
        .filter((d) => d.isDirectory() && !d.name.startsWith("."))
        .map((d) => d.name);
      for (const id of ids) {
        let doc: SceneDocument | null;
        try {
          doc = await readTake(id);
        } catch (error) {
          unreadable.push({
            id,
            unreadable: `${error instanceof LibraryError ? error.message : messageOf(error)} — remove ${join(root, id)} if the take is not wanted`,
          });
          continue;
        }
        if (doc === null) continue;
        entries.push({
          id: doc.meta.id,
          name: doc.meta.name,
          createdAt: doc.meta.createdAt,
          mode: doc.meta.capture.mode,
          actions: doc.actions.length,
        });
      }
      // Newest first, by when the take was made: the extension's order
      // (`scene-store.ts`'s `newestFirst`), and what the `takes` tool and
      // the recipe promise. A folder name is a random id and says nothing
      // about age (final review 2026-10-12, Important 5).
      return [
        ...entries.sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
        ...unreadable,
      ];
    },
  };
}

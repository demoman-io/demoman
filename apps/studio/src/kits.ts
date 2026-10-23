import { constants } from "node:fs";
import { copyFile } from "node:fs/promises";
import { join } from "node:path";
import { coerceBrandKits } from "@demoman/run-core";
import { judgeKitsText } from "@demoman/runner/studio";
import type {
  KitsPutAnswer,
  KitsRead,
  KitsResetAnswer,
  Refusal,
} from "@demoman/studio-protocol";
import {
  createChains,
  messageOf,
  readIfPresent,
  sha256,
  writeAtomic,
} from "./files.js";

/** The revision of a home with no `kits.json`. */
export const ABSENT_REVISION = "absent";

export const KITS_CHANGED_ELSEWHERE =
  "The brand kits changed in another window.";

export type KitsWrite<T> =
  | { ok: true; answer: T }
  | { ok: false; status: number; refusal: Refusal };

/** What the file says; the route adds the watch feed's `unwatched`. */
export type KitsBody = KitsRead extends infer T
  ? T extends unknown
    ? Omit<T, "unwatched">
    : never
  : never;

export interface KitsFile {
  read(): Promise<KitsBody>;
  put(body: unknown, ifMatch: string): Promise<KitsWrite<KitsPutAnswer>>;
  reset(): Promise<KitsWrite<KitsResetAnswer>>;
}

const EMPTY = `${JSON.stringify({ kits: [], default: null }, null, 2)}\n`;

/**
 * `<home>/kits.json`, the file `readKits` reads, so an agent's `look.kit`
 * resolves against what the studio wrote. Every write goes through one
 * chain, so a PUT's revision check and its rename never interleave with
 * another PUT or a reset in this process.
 */
export function createKitsFile(home: string): KitsFile {
  const path = join(home, "kits.json");
  const chain = createChains();

  async function current(): Promise<{
    bytes: Buffer | null;
    revision: string;
  }> {
    const bytes = await readIfPresent(path);
    return {
      bytes,
      revision: bytes === null ? ABSENT_REVISION : sha256(bytes),
    };
  }

  const unwritable = (error: unknown, what: string): KitsWrite<never> => ({
    ok: false,
    status: 500,
    refusal: {
      reason: "studioUnwritable",
      detail: `${what}: ${messageOf(error)}.`,
    },
  });

  return {
    async read() {
      let read: { bytes: Buffer | null; revision: string };
      try {
        read = await current();
      } catch (error) {
        // Not "no kits": the file is there and would not read, which is
        // what `readKits` calls `storageRefused`.
        return {
          invalid: {
            reason: `${path} could not be read (${messageOf(error)})`,
            storageRefused: true,
          },
          revision: ABSENT_REVISION,
        };
      }
      if (read.bytes === null) {
        return { stored: { kits: [], default: null }, revision: read.revision };
      }
      const text = read.bytes.toString("utf8");
      const judged = judgeKitsText(path, text);
      if (judged.state === "invalid") {
        return { invalid: { reason: judged.reason }, revision: read.revision };
      }
      // It parsed as an object, or `judgeKitsText` would have said otherwise.
      const raw = JSON.parse(text) as { kits?: unknown; default?: unknown };
      return {
        stored: {
          kits: Array.isArray(raw.kits) ? raw.kits : [],
          default: typeof raw.default === "string" ? raw.default : null,
        },
        revision: read.revision,
      };
    },

    put(body, ifMatch) {
      const shape = body as { kits?: unknown; default?: unknown } | null;
      if (typeof shape !== "object" || shape === null || Array.isArray(shape)) {
        return Promise.resolve({
          ok: false,
          status: 400,
          refusal: {
            reason: "kitsInvalid",
            detail:
              'The kits were not saved: expected { "kits": [...], "default": "<id>" }.',
          },
        });
      }
      const judged = coerceBrandKits(shape.kits, shape.default);
      if (judged.state === "invalid") {
        return Promise.resolve({
          ok: false,
          status: 400,
          refusal: {
            reason: "kitsInvalid",
            detail: `The kits were not saved: ${judged.reason}.`,
          },
        });
      }
      const text = `${JSON.stringify(
        {
          kits: Array.isArray(shape.kits) ? shape.kits : [],
          default: typeof shape.default === "string" ? shape.default : null,
        },
        null,
        2,
      )}\n`;
      return chain(path, async (): Promise<KitsWrite<KitsPutAnswer>> => {
        const { revision } = await current();
        if (revision !== ifMatch) {
          return {
            ok: false,
            status: 409,
            refusal: {
              reason: "changedElsewhere",
              detail: KITS_CHANGED_ELSEWHERE,
            },
          };
        }
        try {
          await writeAtomic(path, text);
        } catch (error) {
          return unwritable(error, "The kits were not saved");
        }
        return { ok: true, answer: { revision: sha256(text) } };
      });
    },

    reset() {
      return chain(path, async (): Promise<KitsWrite<KitsResetAnswer>> => {
        const { bytes } = await current();
        let backup: string | null = null;
        if (bytes !== null) {
          backup = `${path}.bak-${Date.now()}`;
          try {
            // EXCL: two resets in one millisecond must not overwrite the
            // first one's copy of the file.
            await copyFile(path, backup, constants.COPYFILE_EXCL);
          } catch (error) {
            // The old file stays where it is: nothing is emptied that was
            // not kept first.
            return unwritable(
              error,
              `The kits were not reset; ${path} could not be kept`,
            );
          }
        }
        try {
          await writeAtomic(path, EMPTY);
        } catch (error) {
          return unwritable(error, "The kits were not reset");
        }
        return { ok: true, answer: { backup } };
      });
    },
  };
}

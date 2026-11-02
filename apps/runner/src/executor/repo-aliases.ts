import { stat } from "node:fs/promises";
import { messageOf } from "../report.js";
import type { KeptKeyFailure } from "./kept-keys.js";
import type { Library } from "./library.js";
import type { RepoRead } from "./repo.js";
import type { VideoStore } from "./videos.js";

/** `old key → new key`, as upkeep recorded each change of a checkout's repo
 *  key (pushed, renamed or moved on its host, `git remote set-url`). Kept in
 *  `<home>/videos/.aliases.json`. */
export type Aliases = Record<string, string>;

/** Where `key` ends up: aliases chain (`a → b`, `b → c` resolves `a` to
 *  `c`). A cycle, which only a hand-edited table can hold, ends at its
 *  least key, so every key in it resolves to the same one. */
export function resolveKey(aliases: Aliases, key: string): string {
  const path: string[] = [];
  let k = key;
  while (Object.hasOwn(aliases, k)) {
    const at = path.indexOf(k);
    if (at >= 0) return path.slice(at).sort()[0] as string;
    path.push(k);
    k = aliases[k] as string;
  }
  return k;
}

/**
 * Reads the repo again in every checkout a flow was recorded in (each
 * take's `made.repo.root`) and every kept mark's root; where the key there
 * resolves to another than the one recorded, records the alias and re-keys
 * the records and marks under the store's lock (`VideoStore.follow`).
 * A checkout that is gone is skipped quietly; one that will not read is
 * named in `failed`, once per flow recorded there, and its flows stay.
 * A table that will not read throws, naming it.
 */
export async function followCheckouts(
  videos: VideoStore,
  library: Library,
  read: (dir: string) => Promise<RepoRead>,
): Promise<{ moved: number; failed: KeptKeyFailure[] }> {
  const table = await videos.aliases();
  const names = new Map<string, string>();
  // root → the keys recorded there, and the flows (id → name) that did.
  const at = new Map<string, { keys: Set<string>; flows: Set<string> }>();
  const note = (root: string, key: string, flow: string) => {
    const there = at.get(root) ?? { keys: new Set(), flows: new Set() };
    there.keys.add(key);
    there.flows.add(flow);
    at.set(root, there);
  };
  for (const rec of await videos.list()) {
    if ("unreadable" in rec) continue; // the listing names it
    names.set(rec.id, rec.name);
    if (rec.kept?.key !== undefined) note(rec.kept.root, rec.kept.key, rec.id);
  }
  for (const t of await library.list()) {
    if ("unreadable" in t) continue; // the listing names it
    let member: Awaited<ReturnType<VideoStore["videoOf"]>>;
    try {
      member = await videos.videoOf(t.id);
    } catch {
      continue; // ensureVideos names a video.json that will not read
    }
    const repo = member?.made.repo;
    if (!member || !names.has(member.videoId) || !repo || !("key" in repo))
      continue;
    if (typeof repo.root === "string")
      note(repo.root, repo.key, member.videoId);
  }

  const pairs: { from: string; to: string }[] = [];
  const failed: KeptKeyFailure[] = [];
  for (const [root, { keys, flows }] of at) {
    const miss = (why: string) => {
      for (const flow of flows)
        failed.push({ flow, name: names.get(flow) ?? flow, root, why });
    };
    try {
      await stat(root);
    } catch (error) {
      if ((error as { code?: string }).code !== "ENOENT")
        miss(`the checkout cannot be checked (${messageOf(error)})`);
      continue;
    }
    try {
      const r = await read(root);
      if (!r.ok) {
        miss(r.none);
        continue;
      }
      for (const from of keys) {
        if (resolveKey(table, from) !== resolveKey(table, r.repo.key))
          pairs.push({ from, to: r.repo.key });
      }
    } catch (error) {
      miss(messageOf(error));
    }
  }
  // With no new alias, still re-keys a record made since under an old key.
  if (pairs.length === 0 && Object.keys(table).length === 0)
    return { moved: 0, failed };
  const { moved } = await videos.follow(pairs);
  return { moved, failed };
}

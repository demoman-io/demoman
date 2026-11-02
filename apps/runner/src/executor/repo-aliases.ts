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

/** A key read from a checkout with no remote. */
export const isLocalKey = (key: string): boolean => key.startsWith("local:");

type Recorded = { flows: Set<string>; commits: Set<string> };

/**
 * Reads the repo again in every checkout a flow was recorded in (each
 * take's `made.repo.root`) and every kept mark's root; where the key there
 * resolves to another than the one recorded, records the alias and re-keys
 * the records and marks under the store's lock (`VideoStore.follow`).
 *
 * An alias is recorded only to a hosted key (a checkout that lost its
 * remote has not moved), and only when a commit recorded from that checkout
 * under the old key is still in it (`has`): a take's own commit, or for a
 * kept mark every commit its flow's takes recorded. Without that proof the
 * path may hold another repo now, and the flows stay, named in `failed`.
 *
 * A checkout that is gone is skipped quietly; one that will not read is
 * named in `failed`, once per flow recorded there. `collisions`: names two
 * flows now share in one repo. A table that will not read throws, naming it.
 */
export async function followCheckouts(
  videos: VideoStore,
  library: Library,
  read: (dir: string) => Promise<RepoRead>,
  has: (dir: string, sha: string) => Promise<boolean>,
): Promise<{
  moved: number;
  failed: KeptKeyFailure[];
  collisions: { name: string; ids: string[] }[];
}> {
  const table = await videos.aliases();
  const names = new Map<string, string>();
  // root → key recorded there → the flows that did, and the commits with it.
  const at = new Map<string, Map<string, Recorded>>();
  const recorded = (root: string, key: string): Recorded => {
    const byKey = at.get(root) ?? new Map<string, Recorded>();
    at.set(root, byKey);
    const r = byKey.get(key) ?? { flows: new Set(), commits: new Set() };
    byKey.set(key, r);
    return r;
  };
  const commitsOf = new Map<string, Set<string>>();
  const marked: { id: string; root: string; key: string }[] = [];
  for (const rec of await videos.list()) {
    if ("unreadable" in rec) continue; // the listing names it
    names.set(rec.id, rec.name);
    if (rec.kept?.key !== undefined)
      marked.push({ id: rec.id, root: rec.kept.root, key: rec.kept.key });
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
    if (typeof repo.root !== "string") continue;
    const r = recorded(repo.root, repo.key);
    r.flows.add(member.videoId);
    if (repo.commit) {
      r.commits.add(repo.commit);
      const all = commitsOf.get(member.videoId) ?? new Set<string>();
      all.add(repo.commit);
      commitsOf.set(member.videoId, all);
    }
  }
  for (const m of marked) {
    const r = recorded(m.root, m.key);
    r.flows.add(m.id);
    for (const c of commitsOf.get(m.id) ?? []) r.commits.add(c);
  }

  const pairs: { from: string; to: string }[] = [];
  const failed: KeptKeyFailure[] = [];
  for (const [root, byKey] of at) {
    const miss = (flows: Iterable<string>, why: string) => {
      for (const flow of flows)
        failed.push({ flow, name: names.get(flow) ?? flow, root, why });
    };
    const everyFlow = [...byKey.values()].flatMap((r) => [...r.flows]);
    try {
      await stat(root);
    } catch (error) {
      if ((error as { code?: string }).code !== "ENOENT")
        miss(everyFlow, `the checkout cannot be checked (${messageOf(error)})`);
      continue;
    }
    try {
      const r = await read(root);
      if (!r.ok) {
        miss(everyFlow, r.none);
        continue;
      }
      const now = r.repo.key;
      for (const [from, { flows, commits }] of byKey) {
        if (resolveKey(table, from) === resolveKey(table, now)) continue;
        if (isLocalKey(now)) continue; // lost its remote: it has not moved
        let proven = false;
        for (const sha of commits) {
          proven = await has(root, sha);
          if (proven) break;
        }
        if (proven) {
          pairs.push({ from, to: now });
          continue;
        }
        miss(
          flows,
          `the checkout's repo is ${now} now, not ${from}, but ${
            commits.size === 0
              ? "no recorded commit proves it is the same repo"
              : `none of the commits recorded there (${[...commits].map((c) => c.slice(0, 7)).join(", ")}) is in it, so it may be another repo`
          }; its flows stay under ${from}`,
        );
      }
    } catch (error) {
      miss(everyFlow, messageOf(error));
    }
  }
  // With no new alias, still re-keys a record made since under an old key.
  if (pairs.length === 0 && Object.keys(table).length === 0)
    return { moved: 0, failed, collisions: [] };
  const { moved, collisions } = await videos.follow(pairs);
  return { moved, failed, collisions };
}

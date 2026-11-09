import { stat } from "node:fs/promises";
import { videoSlug } from "@demoman/run-core";
import type { AccountsFound } from "./accounts.js";
import { type KeepRefusal, vetForAdd } from "./keep.js";
import type { Library } from "./library.js";
import { type GitRunner, readRepo } from "./repo.js";
import type { SessionFile } from "./sessions.js";
import type { VideoRecord, VideoStore } from "./videos.js";

export type Addable =
  | { ok: true; root: string; defaultPath: string }
  | {
      ok: false;
      reason: KeepRefusal | "noCheckout";
      label: string;
      detail: string;
    };

export const isDir = (path: string): Promise<boolean> =>
  stat(path).then(
    (s) => s.isDirectory(),
    () => false,
  );

/** The checkout to add `video` to: where it was last added, else the first
 *  folder a version was recorded in that is still its repo, trying complete
 *  versions before incomplete ones and each newest first. A flow can be
 *  recorded from more than one checkout (another repo serving the same app),
 *  so one folder that no longer fits must not hide another that does. */
export async function checkoutOf(
  video: VideoRecord,
  store: VideoStore,
  read: typeof readRepo,
): Promise<{ root: string } | { missing: string }> {
  const why: string[] = [];
  // No key check here: keepVideo adds only among the flows of its checkout's
  // repo, so a kept folder now holding another repo is refused there.
  if (video.kept !== undefined) {
    if (await isDir(video.kept.root)) return { root: video.kept.root };
    why.push(`${video.kept.root}, where it was last added, is gone`);
  }
  const all = await store.versions(video.id);
  const order = [
    ...all.filter((v) => v.complete).reverse(),
    ...all.filter((v) => !v.complete).reverse(),
  ];
  const made = await Promise.all(order.map((v) => store.videoOf(v.takeId)));
  const roots: string[] = [];
  for (const m of made) {
    const repo = m?.made.repo;
    if (repo && "root" in repo && typeof repo.root === "string")
      if (!roots.includes(repo.root)) roots.push(repo.root);
  }
  if (roots.length === 0 && why.length === 0)
    return { missing: "it was recorded outside a git repo" };
  for (const root of roots) {
    if (!(await isDir(root))) {
      why.push(`${root} is gone`);
      continue;
    }
    const now = await read(root);
    if (!now.ok) {
      why.push(`${root} could not be read (${now.none})`);
      continue;
    }
    if ("key" in video.repo && now.repo.key === video.repo.key) return { root };
    why.push(`${root} is no longer this flow's repo`);
  }
  // The escape hatch: `demoman add` adds to the checkout it runs in.
  // shortcut: POSIX single quotes, wrong for cmd.exe; upgrade with native Windows (DEM-85).
  const name = `'${video.name.replaceAll("'", `'\\''`)}'`;
  const key = "key" in video.repo ? ` of ${video.repo.key}` : "";
  return {
    missing: `${why.join("; ")}. To add it to another checkout${key}, run \`npx demoman add ${name} --to <path>\` there`,
  };
}

/** The one answer that needs no git: a flow recorded with no repo. The
 *  Studio's listing asks only this; `checkAddable` asks it first. */
export function notInRepo(
  video: VideoRecord,
): Extract<Addable, { ok: false }> | null {
  if ("key" in video.repo) return null;
  return {
    ok: false,
    reason: "noCheckout",
    label: "not in a repo",
    detail: `"${video.name}" has no checkout to add to: it was recorded outside a git repo`,
  };
}

/** Whether `video` can be added to its repo; the Studio's button and
 *  `demoman add` both ask here. */
export async function checkAddable(
  a: { video: VideoRecord },
  deps: {
    videos: VideoStore;
    library: Library;
    home: string;
    git: GitRunner;
    accounts?: Map<string, AccountsFound>;
    sessions?: SessionFile[];
    /** readRepo's answers by directory, so flows in one checkout run git once. */
    repos?: Map<string, Promise<Awaited<ReturnType<typeof readRepo>>>>;
  },
): Promise<Addable> {
  const { video } = a;
  const none = notInRepo(video);
  if (none !== null) return none;
  const where = await checkoutOf(video, deps.videos, (dir) => {
    let read = deps.repos?.get(dir);
    if (read === undefined) {
      read = readRepo(dir, deps.git);
      deps.repos?.set(dir, read);
    }
    return read;
  });
  if ("missing" in where) {
    return {
      ok: false,
      reason: "noCheckout",
      label: "key" in video.repo ? "no checkout found" : "not in a repo",
      detail: `"${video.name}" has no checkout to add to: ${where.missing}`,
    };
  }
  // `deps` is the cache: vetForAdd fills in what it had to read.
  const vetted = await vetForAdd(video, where.root, deps, deps);
  if (!vetted.ok) {
    const { ok: _ok, ...refusal } = vetted;
    return { ok: false, ...refusal };
  }
  return {
    ok: true,
    root: where.root,
    defaultPath: `docs/demos/${videoSlug(video.name)}.mp4`,
  };
}

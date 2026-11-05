import { stat } from "node:fs/promises";
import { keptFileName } from "@demoman/run-core";
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

const isDir = (path: string) =>
  stat(path).then(
    (s) => s.isDirectory(),
    () => false,
  );

/** The checkout to add `video` to: where it was last added, else where its
 *  current version was recorded, when that folder is still its repo. */
export async function checkoutOf(
  video: VideoRecord,
  store: VideoStore,
  read: typeof readRepo,
): Promise<{ root: string } | { missing: string }> {
  if (video.kept !== undefined && (await isDir(video.kept.root)))
    return { root: video.kept.root };
  const all = await store.versions(video.id);
  const from = all.filter((v) => v.complete).at(-1) ?? all.at(-1);
  const repo = from && (await store.videoOf(from.takeId))?.made.repo;
  if (!repo || !("root" in repo) || typeof repo.root !== "string") {
    return { missing: "it was recorded outside a git repo" };
  }
  if (!(await isDir(repo.root))) return { missing: `${repo.root} is gone` };
  const now = await read(repo.root);
  if (!now.ok || !("key" in video.repo) || now.repo.key !== video.repo.key) {
    return { missing: `${repo.root} is no longer this flow's repo` };
  }
  return { root: repo.root };
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
      label: "key" in video.repo ? "its checkout is gone" : "not in a repo",
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
    defaultPath: `docs/demos/${keptFileName(video.name).replace(/\.json$/, ".mp4")}`,
  };
}

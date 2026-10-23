import { type Dirent, promises as fs } from "node:fs";
import { dirname, join } from "node:path";
import type { FrameBundle } from "@demoman/compositor";
import type { EngineStore } from "@demoman/replay-engine";

/**
 * The filesystem frame store: where harvested keyframes, parked motion
 * frames and rendered spans live between the replay phase and the render
 * phase. `EngineStore` stays two methods on purpose (`putKeyframe`,
 * `putBundle` — see `packages/replay-engine/src/types.ts`'s docblock); the
 * rest are the runner's own, not the engine's.
 */
export interface RunnerStore extends EngineStore {
  /** Parked frames, the shape capture already uses: written by the encoder,
   *  read by the mux. */
  putParked(
    namespace: string,
    index: number,
    bytes: Uint8Array,
  ): Promise<string>;
  readParked(
    namespace: string,
    firstIndex: number,
    count: number,
  ): Promise<{ index: number; bytes: Uint8Array }[]>;
  dropParked(namespace: string): Promise<void>;
  /** Written by the mux, over the ref the encoder already handed the bundle. */
  putSpan(ref: string, bytes: Uint8Array): Promise<void>;
  load(ref: string): Promise<Uint8Array>;
  getBundle(sceneId: string): Promise<FrameBundle | null>;
  /**
   * Removes a stored bundle **and every blob it names** — every keyframe and
   * kept motion span ref, the same shape `apps/extension`'s IndexedDB store
   * and its `test/helpers/frame-store.ts` fake both take (whose own comment
   * says why: a fake that dropped only the row would let a caller that
   * leaks blobs pass its tests and leak in the real browser). Used by the
   * replay phase when `assertSceneWasLoaded`'s tripwire is about to fire:
   * the engine stores its bundle before `runReplay` returns, so a
   * blank-frame bundle — keyframes and all — is already on disk by then.
   * Dropping only the row would leave those keyframes reachable through
   * `refs()`, which the render phase's http server (Task 12) serves
   * verbatim: a bundle deliberately destroyed for being worthless would
   * still be able to hand a later phase its blobs.
   *
   * Not an error to call when nothing is stored — the bundle-assembly
   * refusal paths reach here too, with nothing to remove — nor to call
   * twice: the second call finds no row and deletes nothing further.
   */
  deleteBundle(sceneId: string): Promise<void>;
  /** Every ref this store holds, for the http server the render phase runs. */
  refs(): Promise<string[]>;
  /** The directory it is rooted at. */
  readonly root: string;
}

const BUNDLES_DIR = "bundles";

/**
 * The store's own ref -> filename rule. A ref contains `:`, which is legal
 * in a POSIX filename but not worth relying on, so it is percent-encoded.
 * Exported: the test reads bytes straight off disk with it, and the render
 * phase's http server (Task 12) uses the same rule to serve the store's
 * blobs over http.
 */
export function fileNameOf(ref: string): string {
  return encodeURIComponent(ref);
}

function parkedPrefix(namespace: string): string {
  return `park:${namespace}:`;
}

function parseParkedIndex(ref: string, prefix: string): number | null {
  if (!ref.startsWith(prefix)) return null;
  const remainder = ref.slice(prefix.length);
  // The index segment must be the WHOLE remainder after the prefix. Without
  // this, "s1"'s prefix "park:s1:" also matches "park:s1:extra:0"'s ref (a
  // different namespace, "s1:extra", whose name merely extends this one) —
  // a trap a real bounded IDBKeyRange never falls into, because that key
  // sorts above "s1"'s upper bound. See
  // apps/extension/test/helpers/frame-store.ts's readParked.
  if (remainder.includes(":")) return null;
  if (!/^\d+$/.test(remainder)) return null;
  return Number(remainder);
}

async function ensureDir(path: string): Promise<void> {
  await fs.mkdir(path, { recursive: true });
}

/** Every blob ref a bundle names — the set `deleteBundle` must remove
 *  alongside the bundle row itself. Mirrors `apps/extension/src/adapters
 *  /frame-store.ts`'s `blobRefsOf`. */
function blobRefsOf(bundle: FrameBundle): string[] {
  return [
    ...bundle.keyframes.map((k) => k.ref),
    ...bundle.motionSpans.map((m) => m.ref),
  ];
}

/** A blob already gone (ENOENT) is the ordinary case for a second
 *  `deleteBundle` call, or a ref that never got written — not an error.
 *  Anything else (a permissions failure, a disk fault) is real and is
 *  re-thrown rather than swallowed here: swallowing it would report this
 *  bundle as fully deleted while a blob it named is still sitting on disk
 *  under a ref `refs()` would keep listing — exactly the orphan this
 *  method exists to stop creating. */
async function removeBlob(path: string): Promise<void> {
  try {
    await fs.rm(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
}

export function createFileFrameStore(root: string): RunnerStore {
  const bundlesDir = join(root, BUNDLES_DIR);

  // Blobs live directly at `<root>/<encoded-ref>`: the render phase's http
  // server (Task 12) serves this directory verbatim, and the test above
  // reads a keyframe's bytes at exactly this path.
  const blobPath = (ref: string): string => join(root, fileNameOf(ref));
  const bundlePath = (sceneId: string): string =>
    join(bundlesDir, `${fileNameOf(sceneId)}.json`);

  async function writeBlob(ref: string, bytes: Uint8Array): Promise<void> {
    const path = blobPath(ref);
    await ensureDir(dirname(path));
    await fs.writeFile(path, bytes);
  }

  /** Every blob file directly under `root`, decoded back to its ref. Skips
   *  `bundles/` — a directory, not a blob — by filtering to regular files. */
  async function listBlobRefs(): Promise<string[]> {
    let entries: Dirent[];
    try {
      entries = await fs.readdir(root, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    return entries
      .filter((entry) => entry.isFile())
      .map((entry) => decodeURIComponent(entry.name));
  }

  return {
    root,

    async putKeyframe(sceneId, index, bytes) {
      const ref = `kf:${sceneId}:${index}`;
      await writeBlob(ref, bytes);
      return ref;
    },

    async putSpan(ref, bytes) {
      await writeBlob(ref, bytes);
    },

    async putParked(namespace, index, bytes) {
      const ref = `park:${namespace}:${String(index).padStart(6, "0")}`;
      await writeBlob(ref, bytes);
      return ref;
    },

    async readParked(namespace, firstIndex, count) {
      if (count <= 0) return [];
      const prefix = parkedPrefix(namespace);
      const refs = await listBlobRefs();
      const found: { index: number; bytes: Uint8Array }[] = [];
      for (const ref of refs) {
        const index = parseParkedIndex(ref, prefix);
        if (index === null) continue;
        if (index < firstIndex || index >= firstIndex + count) continue;
        const bytes = await fs.readFile(blobPath(ref));
        found.push({ index, bytes: new Uint8Array(bytes) });
      }
      found.sort((a, b) => a.index - b.index);
      return found;
    },

    async dropParked(namespace) {
      const prefix = parkedPrefix(namespace);
      const refs = await listBlobRefs();
      for (const ref of refs) {
        if (parseParkedIndex(ref, prefix) === null) continue;
        await fs.rm(blobPath(ref));
      }
    },

    async putBundle(sceneId, bundle) {
      const path = bundlePath(sceneId);
      await ensureDir(dirname(path));
      await fs.writeFile(path, JSON.stringify(bundle));
    },

    async getBundle(sceneId) {
      try {
        const raw = await fs.readFile(bundlePath(sceneId), "utf8");
        return JSON.parse(raw) as FrameBundle;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      }
    },

    async deleteBundle(sceneId) {
      let raw: string;
      try {
        raw = await fs.readFile(bundlePath(sceneId), "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
        throw error;
      }
      const bundle = JSON.parse(raw) as FrameBundle;
      // The blobs first, the row last: a caller that reads `getBundle`
      // between the two still sees a bundle whose blobs are all present
      // (it just hasn't been removed itself yet), rather than a row
      // already gone that would still resolve to refs nothing can load.
      for (const ref of blobRefsOf(bundle)) {
        await removeBlob(blobPath(ref));
      }
      await removeBlob(bundlePath(sceneId));
    },

    async load(ref) {
      try {
        const bytes = await fs.readFile(blobPath(ref));
        return new Uint8Array(bytes);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          throw new Error(`no frame at ref ${ref}`);
        }
        throw error;
      }
    },

    async refs() {
      return listBlobRefs();
    },
  };
}

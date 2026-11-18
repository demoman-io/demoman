import {
  BRAND_KITS_KEY,
  type BrandKitsRead,
  coerceBrandKits,
  DEFAULT_KIT_KEY,
  type StoredKit,
} from "../core/brand-kit";

/** The list as stored, each kit's branding unchecked: what an update edits,
 *  so editing one kit never rewrites an invalid sibling's stored value. */
export interface StoredKits {
  kits: StoredKit[];
  defaultId: string | null;
}

export interface BrandKitStore {
  /** Never rejects: a refused read is `{state: "invalid", reason}`. */
  read(): Promise<BrandKitsRead>;
  /**
   * Read-modify-write of the whole list, under the kit lock (see
   * `KitLock`), so no other page's or the worker's read or write lands
   * between this read and this write. `change` returns the next list, or a
   * sentence refusing the change (nothing is written); it may be async, and
   * holds the lock while it runs. Resolves null on success and the sentence
   * on a refusal — including a list nobody could read, which is never
   * overwritten here. Rejects when storage refuses the write.
   */
  update(
    change: (
      current: StoredKits,
    ) => StoredKits | string | Promise<StoredKits | string>,
  ): Promise<string | null>;
  /** The raw stored list. A sentence when the list is unreadable; never
   *  rejects. */
  readStored(): Promise<StoredKits | string>;
  /**
   * Replaces the list with an empty one, under the same lock. The one write
   * that replaces a list nobody could read — which `update` refuses by
   * design — so only ever behind the author's say-so. Rejects when storage
   * refuses the write.
   */
  reset(): Promise<void>;
}

/** Runs `fn` while no other holder of the brand kits' lock runs. */
export type KitLock = <T>(fn: () => Promise<T>) => Promise<T>;

/** The Web Locks name: one origin, so every studio page shares it. */
export const KIT_LOCK_NAME = "demoman-brand-kits";

/** This context's fallback, for a runtime with no `navigator.locks` (node
 *  tests). It orders the stores in one context only; every studio page has
 *  Web Locks, and uses those. */
let localChain: Promise<unknown> = Promise.resolve();
const localLock: KitLock = (fn) => {
  const run = localChain.then(fn);
  // The chain only orders; `run` carries a failure to its caller.
  localChain = run.catch(() => undefined);
  return run;
};

/**
 * Web Locks when the context has them, looked up at each use (as `area`
 * is). The kits' storage has no transactions, so a read-modify-write is only
 * whole while every reader and writer of these keys holds this lock: an
 * update (Settings and the editor saving at once) lost a write without it.
 */
const defaultLock: KitLock = <T>(fn: () => Promise<T>) =>
  typeof navigator !== "undefined" && navigator.locks !== undefined
    ? // lib.dom types the answer as the callback's own return, a promise;
      // `request` resolves with what that promise resolves to.
      (navigator.locks.request(KIT_LOCK_NAME, fn) as unknown as Promise<T>)
    : localLock(fn);

/** The two calls the store makes, so a test can hand it a fake. The
 *  shape is chrome's `StorageArea`, which the retired extension passed;
 *  the studio's (`src/platform/http.ts`) is one now. */
export interface KitStorageArea {
  get(keys: string[]): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
}
type Area = KitStorageArea;

const describe = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * The store over any area, looked up through `area` at each use. The
 * studio's maps the keys onto `GET`/`PUT /api/kits`
 * (`src/platform/http.ts`). Until 2026-10-20 the extension's
 * `chrome.storage.local` was the other.
 */
export function createBrandKitStore(
  area: () => Area,
  lock: KitLock = defaultLock,
): BrandKitStore {
  /** The raw keys. Rejects only when storage refuses the read. */
  async function load(): Promise<{ list: unknown; def: unknown }> {
    const got = await area().get([BRAND_KITS_KEY, DEFAULT_KIT_KEY]);
    return { list: got[BRAND_KITS_KEY], def: got[DEFAULT_KIT_KEY] };
  }

  async function read(): Promise<BrandKitsRead> {
    try {
      const { list, def } = await lock(load);
      return coerceBrandKits(list, def);
    } catch (error) {
      return {
        state: "invalid",
        storageRefused: true,
        reason: `storage refused the read: ${describe(error)}`,
      };
    }
  }

  /** `readStored` without taking the lock, for a caller already holding it. */
  async function storedUnlocked(): Promise<StoredKits | string> {
    try {
      const { list, def } = await load();
      const current = coerceBrandKits(list, def);
      if (current.state === "invalid") {
        return `your brand kits could not be read (${current.reason}), so nothing was changed`;
      }
      return {
        kits: (list as StoredKit[] | undefined) ?? [],
        defaultId: current.defaultId,
      };
    } catch (error) {
      return `your brand kits could not be read (${describe(error)}), so nothing was changed`;
    }
  }

  return {
    read,
    readStored: () => lock(storedUnlocked),
    update: (change) =>
      lock(async () => {
        const stored = await storedUnlocked();
        if (typeof stored === "string") return stored;
        const next = await change(stored);
        if (typeof next === "string") return next;
        await area().set({
          [BRAND_KITS_KEY]: next.kits,
          [DEFAULT_KIT_KEY]: next.defaultId,
        });
        return null;
      }),
    reset: () =>
      lock(() => area().set({ [BRAND_KITS_KEY]: [], [DEFAULT_KIT_KEY]: null })),
  };
}

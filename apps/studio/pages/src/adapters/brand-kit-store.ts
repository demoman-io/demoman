import {
  BRAND_KITS_KEY,
  type BrandKitsRead,
  coerceBrandKits,
  DEFAULT_KIT_KEY,
  LEGACY_KIT_KEY,
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
  /** The raw stored list (after any migration). A sentence when the list is
   *  unreadable; never rejects. */
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

/** The Web Locks name: one origin, so every extension page and the worker
 *  share it. */
export const KIT_LOCK_NAME = "demoman-brand-kits";

/** This context's fallback, for a runtime with no `navigator.locks` (node
 *  tests). It orders the stores in one context only; every extension page
 *  and the worker have Web Locks, and use those. */
let localChain: Promise<unknown> = Promise.resolve();
const localLock: KitLock = (fn) => {
  const run = localChain.then(fn);
  // The chain only orders; `run` carries a failure to its caller.
  localChain = run.catch(() => undefined);
  return run;
};

/**
 * Web Locks when the context has them, looked up at each use (as `area`
 * is). chrome.storage has no transactions, so a read-modify-write is only
 * whole while every reader and writer of these keys holds this lock: the
 * move from the single kit (two pages reading the old key at once) and an
 * update (Settings and the editor saving at once) both lost a write
 * without it.
 */
const defaultLock: KitLock = <T>(fn: () => Promise<T>) =>
  typeof navigator !== "undefined" && navigator.locks !== undefined
    ? // lib.dom types the answer as the callback's own return, a promise;
      // `request` resolves with what that promise resolves to.
      (navigator.locks.request(KIT_LOCK_NAME, fn) as unknown as Promise<T>)
    : localLock(fn);

/** The three calls the store makes, so a test can hand it a fake without
 *  standing up chrome's whole `StorageArea`. `chrome.storage.local` is one. */
export interface KitStorageArea {
  get(keys: string[]): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string): Promise<void>;
}
type Area = KitStorageArea;

const describe = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** The moved single kit's id: the same from every page that moves it. */
export const MIGRATED_KIT_ID = "kit-migrated";

/** Storage refused step 1 of the move: said as the move, not as a read. */
class MoveRefused extends Error {}

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
  /**
   * The raw keys, after the move from the single kit if one is owed (spec
   * 2026-10-08 §1). Rejects only when storage refuses the read or step 1.
   * Called only under the lock: step 1's get and set are a read-modify-
   * write like any update's.
   */
  async function load(): Promise<{
    list: unknown;
    def: unknown;
    pending: boolean;
  }> {
    const got = await area().get([
      BRAND_KITS_KEY,
      DEFAULT_KIT_KEY,
      LEGACY_KIT_KEY,
    ]);
    let list = got[BRAND_KITS_KEY];
    let def = got[DEFAULT_KIT_KEY];
    const legacy = got[LEGACY_KIT_KEY];
    if (legacy === undefined) return { list, def, pending: false };
    if (list === undefined) {
      // Step 1: the list, written whole, the old value copied as it is — an
      // invalid kit stays invalid under its new name. The old key stays
      // until this resolves, so a refusal loses nothing.
      // A fixed id, not a minted one: a refused step 2 leaves the old key
      // for the next read to retry, and that retry must not rename the kit
      // a page has already selected.
      const id = MIGRATED_KIT_ID;
      list = [{ id, name: "Brand kit", branding: legacy }];
      def = id;
      try {
        await area().set({ [BRAND_KITS_KEY]: list, [DEFAULT_KIT_KEY]: def });
      } catch (error) {
        throw new MoveRefused(describe(error));
      }
    }
    // Step 2: the old key. Refused, it is an expected and retried outcome —
    // info, not warn — and `migrationPending` lets Diagnostics say so.
    try {
      await area().remove(LEGACY_KIT_KEY);
      return { list, def, pending: false };
    } catch (error) {
      console.info(
        "demoman: could not remove the old brand kit key; the next read retries",
        error,
      );
      return { list, def, pending: true };
    }
  }

  async function read(): Promise<BrandKitsRead> {
    try {
      const { list, def, pending } = await lock(load);
      return coerceBrandKits(list, def, pending);
    } catch (error) {
      return {
        state: "invalid",
        storageRefused: true,
        reason:
          error instanceof MoveRefused
            ? `storage refused moving your brand kit into the kit list: ${error.message}`
            : `storage refused the read: ${describe(error)}`,
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

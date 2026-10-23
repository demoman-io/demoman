import { vi } from "vitest";

/** `chrome.storage.local` as far as the kit store uses it: `get` with one
 *  key or several, `set`, `remove`. Setting `refuse.<name>` makes the next
 *  call of that name reject with it, for the failure paths. */
export function fakeStorageArea(initial: Record<string, unknown> = {}) {
  const data: Record<string, unknown> = structuredClone(initial);
  const refuse = {
    get: null as Error | null,
    set: null as Error | null,
    remove: null as Error | null,
  };
  const take = (name: keyof typeof refuse) => {
    const error = refuse[name];
    refuse[name] = null;
    if (error !== null) throw error;
  };
  return {
    data,
    refuse,
    area: {
      get: vi.fn(async (keys: string | string[]) => {
        take("get");
        const out: Record<string, unknown> = {};
        for (const k of typeof keys === "string" ? [keys] : keys)
          if (k in data) out[k] = structuredClone(data[k]);
        return out;
      }),
      set: vi.fn(async (entries: Record<string, unknown>) => {
        take("set");
        Object.assign(data, structuredClone(entries));
      }),
      remove: vi.fn(async (keys: string | string[]) => {
        take("remove");
        for (const k of typeof keys === "string" ? [keys] : keys)
          delete data[k];
      }),
    },
  };
}

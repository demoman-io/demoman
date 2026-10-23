import { describe, expect, it, vi } from "vitest";
import { createBrandKitStore } from "../../../pages/src/adapters/brand-kit-store";
import { fakeStorageArea } from "../helpers/fake-storage-area";

const kit = {
  background: { kind: "solid", color: "#1b2a4a" },
  logo: null,
  padding: 0.08,
};

describe("migration from the single kit", () => {
  it("moves brandKit into a one-kit list named Brand kit, as the default, then removes it", async () => {
    const s = fakeStorageArea({ brandKit: kit });
    const read = await createBrandKitStore(() => s.area).read();
    expect(read).toEqual({
      state: "ready",
      migrationPending: false,
      defaultId: "kit-migrated",
      kits: [
        {
          id: "kit-migrated",
          name: "Brand kit",
          read: { state: "ready", kit },
        },
      ],
    });
    expect(s.data).toEqual({
      brandKits: [{ id: "kit-migrated", name: "Brand kit", branding: kit }],
      defaultKitId: "kit-migrated",
    });
    // Red if the removal runs before (or without waiting for) the write.
    const setOrder = s.area.set.mock.invocationCallOrder[0] ?? Infinity;
    const removeOrder = s.area.remove.mock.invocationCallOrder[0] ?? -1;
    expect(removeOrder).toBeGreaterThan(setOrder);
  });

  // Final review: the worker and an open editor both read on the first
  // load after the update. Red if each mints its own id: the last write
  // wins and the other page's selection names a kit that is not there.
  it("migrates to the same id from two pages reading at once", async () => {
    const s = fakeStorageArea({ brandKit: kit });
    const [a, b] = await Promise.all([
      createBrandKitStore(() => s.area).read(),
      createBrandKitStore(() => s.area).read(),
    ]);
    const idsOf = (r: typeof a) =>
      r.state === "ready" ? r.kits.map((k) => k.id) : [];
    expect(idsOf(a)).toEqual(idsOf(b));
    expect((s.data.brandKits as { id: string }[]).map((k) => k.id)).toEqual(
      idsOf(a),
    );
  });

  // Review Focus 1.
  it("keeps an invalid single kit, invalid and named, rather than dropping it", async () => {
    const bad = { ...kit, background: { kind: "solid", color: "navy" } };
    const s = fakeStorageArea({ brandKit: bad });
    const read = await createBrandKitStore(() => s.area).read();
    if (read.state !== "ready") throw new Error(JSON.stringify(read));
    expect(read.kits[0]?.name).toBe("Brand kit");
    expect(read.kits[0]?.read.state).toBe("invalid");
    expect((s.data.brandKits as unknown[])[0]).toMatchObject({ branding: bad });
  });

  it("reports a refused move and keeps the old key for the next read", async () => {
    const s = fakeStorageArea({ brandKit: kit });
    s.refuse.set = new Error("quota");
    const store = createBrandKitStore(() => s.area);
    expect(await store.read()).toEqual({
      state: "invalid",
      reason: "storage refused moving your brand kit into the kit list: quota",
      storageRefused: true,
    });
    expect(s.data).toEqual({ brandKit: kit });
    expect(s.area.remove).not.toHaveBeenCalled();
    // The next read retries, and succeeds.
    expect((await store.read()).state).toBe("ready");
    expect(s.data).not.toHaveProperty("brandKit");
  });

  it("says the migration is pending when the old key could not be removed, and retries", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const s = fakeStorageArea({ brandKit: kit });
    s.refuse.remove = new Error("busy");
    const store = createBrandKitStore(() => s.area);
    const first = await store.read();
    expect(first.state === "ready" && first.migrationPending).toBe(true);
    expect(info).toHaveBeenCalledWith(
      expect.stringMatching(/could not remove the old brand kit key/),
      expect.any(Error),
    );
    const second = await store.read();
    expect(second.state === "ready" && second.migrationPending).toBe(false);
    // The retry did not migrate twice: one kit, same id.
    expect(second.state === "ready" && second.kits.map((k) => k.id)).toEqual([
      "kit-migrated",
    ]);
    info.mockRestore();
  });

  it("reads nothing stored as no kits, and writes nothing", async () => {
    const s = fakeStorageArea();
    expect(await createBrandKitStore(() => s.area).read()).toEqual({
      state: "ready",
      kits: [],
      defaultId: null,
      migrationPending: false,
    });
    expect(s.area.set).not.toHaveBeenCalled();
  });

  it("says a refused read, never no kits", async () => {
    const s = fakeStorageArea();
    s.refuse.get = new Error("gone");
    expect(await createBrandKitStore(() => s.area).read()).toEqual({
      state: "invalid",
      reason: "storage refused the read: gone",
      storageRefused: true,
    });
  });
});

// Final review, Important 2: only a malformed list is offered a fresh
// start, so a read must say which kind of invalid it is.
it("reads a malformed list as invalid without storageRefused", async () => {
  const s = fakeStorageArea({ brandKits: "garbage" });
  const read = await createBrandKitStore(() => s.area).read();
  expect(read.state).toBe("invalid");
  expect(read).not.toHaveProperty("storageRefused");
});

describe("update", () => {
  const two = {
    brandKits: [
      { id: "a", name: "Dark", branding: kit },
      { id: "b", name: "Light", branding: kit },
    ],
    defaultKitId: "a",
  };

  it("runs updates strictly in order, each on the list the one before wrote", async () => {
    const s = fakeStorageArea(two);
    const store = createBrandKitStore(() => s.area);
    const rename = (id: string, name: string) =>
      store.update((cur) => ({
        ...cur,
        kits: cur.kits.map((k) => (k.id === id ? { ...k, name } : k)),
      }));
    // Not awaited between: the second must see the first's write.
    await Promise.all([rename("a", "Night"), rename("b", "Day")]);
    expect((s.data.brandKits as { name: string }[]).map((k) => k.name)).toEqual(
      ["Night", "Day"],
    );
  });

  it("writes nothing when the change refuses, and resolves its sentence", async () => {
    const s = fakeStorageArea(two);
    const store = createBrandKitStore(() => s.area);
    expect(await store.update(() => 'a kit is already named "Dark"')).toBe(
      'a kit is already named "Dark"',
    );
    expect(s.area.set).not.toHaveBeenCalled();
  });

  it("refuses to update a list nobody could read", async () => {
    const s = fakeStorageArea({ brandKits: "garbage" });
    const store = createBrandKitStore(() => s.area);
    expect(await store.update((c) => c)).toMatch(
      /^your brand kits could not be read/,
    );
    expect(s.data.brandKits).toBe("garbage");
  });

  it("readStored answers the raw list, and a sentence for an unreadable one", async () => {
    const s = fakeStorageArea(two);
    expect(await createBrandKitStore(() => s.area).readStored()).toEqual({
      kits: two.brandKits,
      defaultId: "a",
    });
    const g = fakeStorageArea({ brandKits: "garbage" });
    expect(await createBrandKitStore(() => g.area).readStored()).toMatch(
      /^your brand kits could not be read/,
    );
  });

  it("rejects when storage refuses the write, and the next update still runs", async () => {
    const s = fakeStorageArea(two);
    const store = createBrandKitStore(() => s.area);
    s.refuse.set = new Error("quota");
    await expect(
      store.update((c) => ({ ...c, defaultId: "b" })),
    ).rejects.toThrow("quota");
    await store.update((c) => ({ ...c, defaultId: "b" }));
    expect(s.data.defaultKitId).toBe("b");
  });
});

// Review 2026-10-08: chrome.storage has no transactions, so every read and
// write of the kit keys runs under one lock that every page and the worker
// share (Web Locks; this context's fallback in node).
describe("the kit lock", () => {
  const kitNamed = (id: string, name: string) => ({ id, name, branding: kit });
  const names = (data: Record<string, unknown>) =>
    (data.brandKits as { name: string }[]).map((k) => k.name);
  /** The same storage, with a `get` that answers what was stored when it
   *  was called but only after `release` — a page whose read is slow. */
  const slowReader = (s: ReturnType<typeof fakeStorageArea>) => {
    let release = (): void => undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const area = {
      ...s.area,
      get: async (keys: string[]) => {
        const got = await s.area.get(keys);
        await gate;
        return got;
      },
    };
    return { area, release };
  };
  const drain = () => new Promise((r) => setTimeout(r, 0));

  // Red without the lock: the slow page saw the old key and no list, the
  // other page migrated and added a kit, then the slow page's step 1 wrote
  // the one-kit list over it.
  it("keeps a kit added while another page was still reading the old key", async () => {
    const s = fakeStorageArea({ brandKit: kit });
    const slow = slowReader(s);
    const reading = createBrandKitStore(() => slow.area).read();
    const adding = createBrandKitStore(() => s.area).update((cur) => ({
      ...cur,
      kits: [...cur.kits, kitNamed("n", "New")],
    }));
    await drain();
    slow.release();
    const [read, refused] = await Promise.all([reading, adding]);
    expect(refused).toBeNull();
    // The premise: the slow page did read the old key and migrate it.
    expect(read.state === "ready" && read.kits.map((k) => k.id)).toEqual([
      "kit-migrated",
    ]);
    expect(names(s.data)).toEqual(["Brand kit", "New"]);
  });

  // Red without the lock (and was the shape of Settings' old kitWrite): an
  // update whose change awaits, with another page's update landing inside
  // that wait, wrote its stale list over the other's.
  it("holds the lock across an async change, so another page's update is kept", async () => {
    const s = fakeStorageArea({
      brandKits: [kitNamed("a", "Dark")],
      defaultKitId: "a",
    });
    let decoded = (): void => undefined;
    const decoding = new Promise<void>((r) => {
      decoded = r;
    });
    let changeStarted = false;
    const settings = createBrandKitStore(() => s.area).update(async (cur) => {
      changeStarted = true;
      await decoding;
      return { ...cur, kits: [...cur.kits, kitNamed("s", "From Settings")] };
    });
    await drain();
    // The premise: the slow change is in flight when the editor saves.
    expect(changeStarted).toBe(true);
    const editor = createBrandKitStore(() => s.area).update((cur) => ({
      ...cur,
      kits: [...cur.kits, kitNamed("e", "From the editor")],
    }));
    await drain();
    decoded();
    expect(await Promise.all([settings, editor])).toEqual([null, null]);
    expect(names(s.data)).toEqual(["Dark", "From Settings", "From the editor"]);
  });

  it("takes the Web Lock by name when the context has one", async () => {
    const request = vi.fn((_name: string, fn: () => Promise<unknown>) => fn());
    vi.stubGlobal("navigator", { locks: { request } });
    try {
      const s = fakeStorageArea({ brandKits: [], defaultKitId: null });
      await createBrandKitStore(() => s.area).read();
      expect(request).toHaveBeenCalledWith(
        "demoman-brand-kits",
        expect.any(Function),
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("reset", () => {
  it("replaces a list nobody could read with an empty one", async () => {
    const s = fakeStorageArea({ brandKits: "garbage", defaultKitId: "x" });
    const store = createBrandKitStore(() => s.area);
    await store.reset();
    expect(s.data).toEqual({ brandKits: [], defaultKitId: null });
    expect(await store.read()).toEqual({
      state: "ready",
      kits: [],
      defaultId: null,
      migrationPending: false,
    });
  });

  it("rejects when storage refuses the write", async () => {
    const s = fakeStorageArea({ brandKits: "garbage" });
    s.refuse.set = new Error("quota");
    await expect(createBrandKitStore(() => s.area).reset()).rejects.toThrow(
      "quota",
    );
    expect(s.data.brandKits).toBe("garbage");
  });
});

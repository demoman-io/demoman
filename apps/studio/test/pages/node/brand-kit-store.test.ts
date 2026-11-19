import { describe, expect, it, vi } from "vitest";
import { createBrandKitStore } from "../../../pages/src/adapters/brand-kit-store";
import { fakeStorageArea } from "../helpers/fake-storage-area";

const kit = {
  background: { kind: "solid", color: "#1b2a4a" },
  logo: null,
  padding: 0.08,
};

describe("read", () => {
  it("reads nothing stored as no kits, and writes nothing", async () => {
    const s = fakeStorageArea();
    expect(await createBrandKitStore(() => s.area).read()).toEqual({
      state: "ready",
      kits: [],
      defaultId: null,
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

// Review 2026-10-08, when the kits lived in chrome.storage, which has no
// transactions: every read and write of the kit keys runs under one lock
// that every page shares (Web Locks; this context's fallback in node).
describe("the kit lock", () => {
  const kitNamed = (id: string, name: string) => ({ id, name, branding: kit });
  const names = (data: Record<string, unknown>) =>
    (data.brandKits as { name: string }[]).map((k) => k.name);
  const drain = () => new Promise((r) => setTimeout(r, 0));

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

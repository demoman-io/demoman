// apps/studio/test/pages/node/settings-studio.test.ts
import type { LogoSource } from "@demoman/run-core/logo";
import type { LogoLoad } from "@demoman/run-core/render";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type BrandKitStore,
  createBrandKitStore,
  type KitStorageArea,
} from "../../../pages/src/adapters/brand-kit-store";
import {
  BRAND_KITS_KEY,
  type BrandKitsRead,
  DEFAULT_KIT_KEY,
  type StoredKit,
} from "../../../pages/src/core/brand-kit";
import type { Platform } from "../../../pages/src/platform/types";
import { captureNavigations, type Navigations } from "../helpers/navigation";

/**
 * The Settings page on a platform with no `settings` member (the studio):
 * the real `entrypoints/settings/main.ts` and the real view, `#platform`
 * replaced by one whose kits live in memory. What this pins is that the page
 * is the Brand kit section alone there — no extension read is made, so no
 * section says it could not read one — and that the kit's store, its logos,
 * its change feed, its backup on a fresh start and its watcher's health all
 * come from the platform.
 *
 * Same mount pattern as `library-folder.test.ts`; the mock replaces
 * `#platform`'s `createPlatform` and keeps its other exports.
 *
 * Production changes that redden it, made and watched go red (see the task
 * report): run the extension reads whether or not `settings` is there; build
 * the `logo:` ref in the page instead of using the one `logos.put` answers;
 * subscribe to no `nav.onOpen`; leave on it without waiting for the kit
 * write in flight.
 */

const confirmDialog = vi.hoisted(() => ({
  ask: vi.fn<(question: unknown) => Promise<boolean>>(),
}));
vi.mock("../../../pages/src/shell/confirm-dialog", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  askToConfirm: (question: unknown) => confirmDialog.ask(question),
}));

// jsdom decodes no image. The page's own check that a file is an image is
// the only thing this replaces; what is stored, and where, is the platform's.
const logoSource = vi.hoisted(
  () =>
    ({
      rasterAt: async () => {
        throw new Error("jsdom has no raster");
      },
    }) as unknown as LogoSource,
);
vi.mock("../../../pages/src/adapters/logo", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  decodeLogo: async () => logoSource,
}));

const world = vi.hoisted(() => ({
  platform: null as unknown,
}));
vi.mock("#platform", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  createPlatform: () => world.platform,
}));

interface Fake {
  /** The kits file, as the studio holds it. */
  area: Record<string, unknown>;
  /** Set to make `read` answer the hand-broken file's reading. */
  broken: string | null;
  unwatched: string | null;
  kitListeners: Array<() => void>;
  openListeners: Array<(path: string) => void>;
  /** Set to hold every kits write open until it resolves. */
  writeGate: Promise<void> | null;
  /** Kits writes begun, and finished. */
  writes: { begun: number; done: number };
  puts: string[];
  loads: string[];
  load: (ref: string) => LogoLoad;
  reset: { backup: string | null };
  platform: Platform;
}

function fakePlatform(kits: StoredKit[] = []): Fake {
  const fake: Fake = {
    area: {
      [BRAND_KITS_KEY]: kits,
      [DEFAULT_KIT_KEY]: kits[0]?.id ?? null,
    },
    broken: null,
    unwatched: null,
    kitListeners: [],
    openListeners: [],
    writeGate: null,
    writes: { begun: 0, done: 0 },
    puts: [],
    loads: [],
    load: () => ({ ok: false, error: "the fake holds no image" }),
    reset: { backup: null },
    platform: null as unknown as Platform,
  };
  const area: KitStorageArea = {
    async get(keys) {
      return Object.fromEntries(
        keys.filter((k) => k in fake.area).map((k) => [k, fake.area[k]]),
      );
    },
    async set(items) {
      fake.writes.begun += 1;
      if (fake.writeGate !== null) await fake.writeGate;
      Object.assign(fake.area, items);
      fake.writes.done += 1;
    },
    async remove(key) {
      delete fake.area[key];
    },
  };
  const store: BrandKitStore = createBrandKitStore(() => area);
  fake.platform = {
    pullRequests: {
      read: async () => ({ value: null }),
      write: async () => ({}),
    },
    exportQuality: {
      read: async () => ({ quality: "share" }),
      write: async () => ({}),
    },
    nav: {
      editor: (id: string) => `/editor.html?scene=${id}`,
      library: () => "/",
      kits: () => "/settings.html",
      firstTakeHint: () => "",
      rerun: (id: string) => ({ kind: "line", text: `re-film ${id}` }),
      onOpen(fn: (path: string) => void) {
        fake.openListeners.push(fn);
      },
    },
    kits: {
      read: async (): Promise<BrandKitsRead> =>
        fake.broken === null
          ? store.read()
          : { state: "invalid", reason: fake.broken },
      update: (change: Parameters<BrandKitStore["update"]>[0]) =>
        store.update(change),
      readStored: () => store.readStored(),
      async reset() {
        fake.broken = null;
        await store.reset();
        return fake.reset;
      },
      onChange(fn: () => void) {
        fake.kitListeners.push(fn);
        return () => {};
      },
      unwatched: () => fake.unwatched,
    },
    logos: {
      async put(file: File) {
        fake.puts.push(file.name);
        return { ref: "assets/abc.png" };
      },
      async load(ref: string) {
        fake.loads.push(ref);
        return fake.load(ref);
      },
    },
  } as unknown as Platform;
  world.platform = fake.platform;
  return fake;
}

const BRANDING = {
  background: { kind: "solid", color: "#1b2a4a" },
  logo: null,
  padding: 0.08,
};
const KIT: StoredKit = { id: "kit-a", name: "Brand kit", branding: BRANDING };

const storedKits = (fake: Fake): StoredKit[] =>
  fake.area[BRAND_KITS_KEY] as StoredKit[];

function mountDom(): void {
  document.body.innerHTML = `
    <header class="topbar"><div class="topbar-actions">
      <div class="topbar-theme" data-theme-slot></div>
    </div></header>
    <div id="notice" class="hidden" role="alert"></div>
    <main id="root"></main>
  `;
  delete document.documentElement.dataset.theme;
}

async function openPage(): Promise<void> {
  vi.resetModules();
  await import("../../../pages/entrypoints/settings/main");
}

const kitSection = (): HTMLElement => {
  const box = document.querySelector<HTMLElement>('[data-section="brandKit"]');
  if (box === null) {
    throw new Error(
      `no Brand kit section; page: ${document.body.textContent?.slice(0, 300)}`,
    );
  }
  return box;
};

const tileNames = (): string[] =>
  [...document.querySelectorAll("[data-kit-tile] .kit-tile-name")].map(
    (n) => n.textContent ?? "",
  );

describe("the studio's Settings page", () => {
  let nav: Navigations;
  beforeEach(() => {
    nav = captureNavigations();
    mountDom();
    confirmDialog.ask.mockReset();
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "info").mockImplementation(() => {});
  });
  afterEach(() => {
    nav.restore();
    vi.restoreAllMocks();
    document.body.innerHTML = "";
  });

  it("draws Brand kit, Export and Pull requests, and no section says it couldn't read anything", async () => {
    fakePlatform([KIT]);
    await openPage();
    await vi.waitFor(() => {
      if (tileNames().join() !== "Brand kit") {
        throw new Error(`tiles: ${tileNames().join()}`);
      }
    });
    const sections = [...document.querySelectorAll("[data-section]")].map((s) =>
      s.getAttribute("data-section"),
    );
    const links = [...document.querySelectorAll("a[data-nav]")].map((a) =>
      a.getAttribute("data-nav"),
    );
    expect({ sections, links }).toEqual({
      sections: ["brandKit", "export", "pullRequests"],
      links: ["brand-kit", "export", "pull-requests"],
    });
    expect(document.body.textContent).not.toMatch(/Couldn't read/);
    // The page's own faults only: jsdom reports its missing canvas at error.
    const faults = vi
      .mocked(console.error)
      .mock.calls.filter((c) => String(c[0]).startsWith("demoman settings"));
    expect(faults).toEqual([]);
  });

  it("a new kit is stored through platform.kits", async () => {
    const fake = fakePlatform([KIT]);
    await openPage();
    const add = await vi.waitFor(() => {
      const node = document.querySelector<HTMLButtonElement>("[data-kit-new]");
      if (node === null) throw new Error("no New kit");
      return node;
    });
    add.click();
    await vi.waitFor(() => {
      const names = storedKits(fake).map((k) => k.name);
      if (!names.includes("Untitled kit")) {
        throw new Error(
          `stored: ${names.join()}; notice: ${document.querySelector("#notice")?.textContent}`,
        );
      }
    });
    await vi.waitFor(() => {
      if (!tileNames().includes("Untitled kit")) {
        throw new Error(`tiles: ${tileNames().join()}`);
      }
    });
  });

  it("a logo upload stores through logos.put and the kit's ref is what it answered", async () => {
    const fake = fakePlatform([KIT]);
    await openPage();
    const input = await vi.waitFor(() => {
      const node =
        kitSection().querySelector<HTMLInputElement>('input[type="file"]');
      if (node === null) throw new Error("no logo picker");
      return node;
    });
    const file = new File([new Uint8Array([137, 80, 78, 71])], "mark.png", {
      type: "image/png",
    });
    Object.defineProperty(input, "files", { value: [file] });
    input.dispatchEvent(new Event("change"));
    await vi.waitFor(() => {
      const logo = storedKits(fake)[0]?.branding as
        | { logo: { ref: string } | null }
        | undefined;
      if (logo?.logo?.ref !== "assets/abc.png") {
        throw new Error(
          `stored logo: ${JSON.stringify(logo?.logo)}; puts: ${fake.puts.join()}; notice: ${document.querySelector("#notice")?.textContent}`,
        );
      }
    });
    expect(fake.puts).toEqual(["mark.png"]);
    // Read back by the ref it was stored under.
    await vi.waitFor(() => {
      if (!fake.loads.includes("assets/abc.png")) {
        throw new Error(`loads: ${fake.loads.join()}`);
      }
    });
  });

  it("a carried-over logo: ref shows the studio's sentence and offers Replace", async () => {
    const sentence =
      "logo:9f1c was saved by the extension, which keeps logos in the browser — upload it again here";
    const fake = fakePlatform([
      {
        ...KIT,
        branding: {
          ...BRANDING,
          logo: {
            ref: "logo:9f1c",
            corner: "top-left",
            size: 0.05,
            opacity: 1,
          },
        },
      },
    ]);
    fake.load = () => ({ ok: false, error: sentence });
    await openPage();
    const notes = await vi.waitFor(() => {
      const node = kitSection().querySelector("[data-logo-notes]");
      if (node === null) throw new Error("no logo notes");
      return node;
    });
    expect(fake.loads).toContain("logo:9f1c");
    expect(notes.textContent).toContain(sentence);
    const pick = [...kitSection().querySelectorAll("label")].find((l) =>
      l.querySelector('input[type="file"]'),
    );
    expect(pick?.textContent).toBe("Replace");
  });

  it("kits.onChange re-reads: a kit added elsewhere appears", async () => {
    const fake = fakePlatform([KIT]);
    await openPage();
    await vi.waitFor(() => {
      if (tileNames().join() !== "Brand kit") {
        throw new Error(`tiles: ${tileNames().join()}`);
      }
      if (fake.kitListeners.length !== 1) {
        throw new Error(`kit listeners: ${fake.kitListeners.length}`);
      }
    });
    fake.area[BRAND_KITS_KEY] = [KIT, { ...KIT, id: "kit-b", name: "Launch" }];
    fake.kitListeners[0]?.();
    await vi.waitFor(() => {
      if (tileNames().join() !== "Brand kit,Launch") {
        throw new Error(`tiles: ${tileNames().join()}`);
      }
    });
  });

  /** Two macrotask turns: a refresh that was going to repaint has by now.
   *  An ordering point, not a duration. */
  const turns = async (): Promise<void> => {
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
  };

  it("a kit change from elsewhere waits while a kit name is being typed, then shows", async () => {
    const fake = fakePlatform([KIT]);
    await openPage();
    const name = await vi.waitFor(() => {
      const node =
        kitSection().querySelector<HTMLInputElement>("[data-kit-name]");
      if (node === null || fake.kitListeners.length !== 1) {
        throw new Error(
          `name: ${node}, listeners: ${fake.kitListeners.length}`,
        );
      }
      return node;
    });
    name.focus();
    name.value = "Half typ";
    // The premise: the author is in the field, mid-word.
    expect(document.activeElement).toBe(name);
    fake.area[BRAND_KITS_KEY] = [KIT, { ...KIT, id: "kit-b", name: "Launch" }];
    fake.kitListeners[0]?.();
    await turns();
    // Red: drop the authorMidEdit check in startRefresh — the redraw
    // replaces the field and the half-typed name is gone.
    expect(name.isConnected).toBe(true);
    expect(name.value).toBe("Half typ");
    expect(tileNames()).toEqual(["Brand kit"]);
    // Leaving the field lets the parked refresh run.
    name.blur();
    await vi.waitFor(() => {
      if (tileNames().join() !== "Brand kit,Launch") {
        throw new Error(`tiles: ${tileNames().join()}`);
      }
    });
  });

  it("a kit change from elsewhere waits while a pointer is held on the page, then shows", async () => {
    const fake = fakePlatform([KIT]);
    await openPage();
    const slider = await vi.waitFor(() => {
      const node = kitSection().querySelector<HTMLInputElement>(
        'input[type="range"]',
      );
      if (node === null || fake.kitListeners.length !== 1) {
        throw new Error(
          `slider: ${node}, listeners: ${fake.kitListeners.length}`,
        );
      }
      return node;
    });
    slider.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    fake.area[BRAND_KITS_KEY] = [KIT, { ...KIT, id: "kit-b", name: "Launch" }];
    fake.kitListeners[0]?.();
    await turns();
    // Red: drop the held-pointer check — the redraw replaces the slider
    // under the drag, which ends it.
    expect(slider.isConnected).toBe(true);
    expect(tileNames()).toEqual(["Brand kit"]);
    window.dispatchEvent(new Event("pointerup"));
    await vi.waitFor(() => {
      if (tileNames().join() !== "Brand kit,Launch") {
        throw new Error(`tiles: ${tileNames().join()}`);
      }
    });
  });

  it("a hand-broken kits file shows the unreadable state; Start fresh names the backup", async () => {
    const fake = fakePlatform([KIT]);
    fake.reset = { backup: "/h/kits.json.bak-1" };
    confirmDialog.ask.mockResolvedValue(true);
    await openPage();
    await vi.waitFor(() => {
      if (fake.kitListeners.length !== 1) {
        throw new Error(`kit listeners: ${fake.kitListeners.length}`);
      }
    });
    fake.broken = "kits.json is not valid JSON";
    fake.kitListeners[0]?.();
    const reset = await vi.waitFor(() => {
      const node = kitSection().querySelector<HTMLButtonElement>(
        "[data-kit-reset-list]",
      );
      if (node === null) {
        throw new Error(`no Start fresh: ${kitSection().textContent}`);
      }
      return node;
    });
    expect(kitSection().textContent).toContain("kits.json is not valid JSON");
    reset.click();
    const notice = document.querySelector<HTMLElement>("#notice");
    await vi.waitFor(() => {
      if (
        notice?.textContent !==
        "Started a fresh kit list. The old list is kept at /h/kits.json.bak-1."
      ) {
        throw new Error(`notice: ${notice?.textContent}`);
      }
    });
    expect(confirmDialog.ask).toHaveBeenCalledTimes(1);
    // Said at info: the fresh start is what the author asked for.
    expect(
      [...(notice?.classList ?? [])].filter((c) =>
        ["notice-error", "notice-warn", "hidden"].includes(c),
      ),
    ).toEqual([]);
    expect(storedKits(fake)).toEqual([]);
  });

  it("the watcher being down is said in the Brand kit section", async () => {
    const fake = fakePlatform([KIT]);
    fake.unwatched = "/h/kits.json could not be watched (EMFILE)";
    await openPage();
    const line = await vi.waitFor(() => {
      const node = kitSection().querySelector("[data-unwatched]");
      if (node === null) throw new Error("no watcher line");
      return node;
    });
    expect(line.textContent).toBe(
      "Kits changed outside this window will not show until you reload — /h/kits.json could not be watched (EMFILE).",
    );
    expect(line.hasAttribute("data-notice")).toBe(true);
  });
  it("the studio's open event takes the window to the path", async () => {
    const fake = fakePlatform([KIT]);
    await openPage();
    await vi.waitFor(() => {
      if (tileNames().join() !== "Brand kit") {
        throw new Error(`tiles: ${tileNames().join()}`);
      }
    });
    // Premise: the page subscribed, once, and has gone nowhere yet.
    expect(fake.openListeners).toHaveLength(1);
    expect(nav.assigned).toEqual([]);
    fake.openListeners[0]?.("/editor.html?scene=take-1");
    await vi.waitFor(() => {
      if (nav.assigned.length === 0) throw new Error("not navigated yet");
    });
    expect(nav.assigned).toEqual(["/editor.html?scene=take-1"]);
  });

  it("an open that arrives during a kit write leaves only once the write has landed", async () => {
    const fake = fakePlatform([KIT]);
    await openPage();
    const add = await vi.waitFor(() => {
      const node = document.querySelector<HTMLButtonElement>("[data-kit-new]");
      if (node === null) throw new Error("no New kit");
      return node;
    });
    const gate = { release: () => {} };
    fake.writeGate = new Promise<void>((resolve) => {
      gate.release = resolve;
    });
    add.click();
    await vi.waitFor(() => {
      if (fake.writes.begun !== 1) {
        throw new Error(`writes begun: ${fake.writes.begun}`);
      }
    });
    fake.openListeners[0]?.("/editor.html?scene=take-1");
    // A macrotask turn: a navigation that was not going to wait has happened
    // by now. An ordering point, not a duration.
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    // Premise: the write is still held open, and nothing has left.
    expect(fake.writes.done).toBe(0);
    expect(nav.assigned).toEqual([]);
    gate.release();
    await vi.waitFor(() => {
      if (nav.assigned.length === 0) {
        throw new Error(
          `not navigated yet; writes: ${JSON.stringify(fake.writes)}`,
        );
      }
    });
    expect(nav.assigned).toEqual(["/editor.html?scene=take-1"]);
    expect(fake.writes.done).toBe(1);
    expect(storedKits(fake).map((k) => k.name)).toContain("Untitled kit");
  });

  it("an open that arrives during a kit write that fails stays, and the notice offers the take", async () => {
    const fake = fakePlatform([KIT]);
    await openPage();
    const add = await vi.waitFor(() => {
      const node = document.querySelector<HTMLButtonElement>("[data-kit-new]");
      if (node === null) throw new Error("no New kit");
      return node;
    });
    const gate = { fail: (_e: Error) => {} };
    fake.writeGate = new Promise<void>((_resolve, reject) => {
      gate.fail = reject;
    });
    add.click();
    await vi.waitFor(() => {
      if (fake.writes.begun !== 1) {
        throw new Error(`writes begun: ${fake.writes.begun}`);
      }
    });
    fake.openListeners[0]?.("/editor.html?scene=take-1");
    gate.fail(new Error("the disk is full"));
    const notice = document.querySelector<HTMLElement>("#notice");
    // Red: drop the offer in leaveAfterOwedWork's failed branch — the page
    // stays with only the kit's failure, and nothing says a take was asked
    // for while the CLI reported the window as opened.
    const offer = await vi.waitFor(() => {
      const node =
        notice?.querySelector<HTMLButtonElement>("[data-open-asked]");
      if (node == null) {
        throw new Error(`no offer; notice: ${notice?.textContent}`);
      }
      return node;
    });
    // The premise: the write really failed, the failure is still said, and
    // the page did not leave over it.
    expect(fake.writes.done).toBe(0);
    expect(nav.assigned).toEqual([]);
    // The fault as a title, its words behind Details, and the offer in the
    // action row beneath. Red: print the error into the title, as the page
    // did until 2026-10-17.
    expect(notice?.querySelector(".notice-title")?.textContent).toBe(
      "Couldn't add a kit",
    );
    const details = notice?.querySelector<HTMLDetailsElement>(
      "details.notice-details",
    );
    expect(details?.open).toBe(false);
    expect(
      details?.querySelector("[data-notice-reason]")?.textContent,
    ).toContain("the disk is full");
    expect(offer.parentElement?.className).toBe("notice-actions");
    expect(offer.textContent).toBe("Open the take");
    offer.click();
    expect(nav.assigned).toEqual(["/editor.html?scene=take-1"]);
  });

  it("an offer with no failure line left to sit beside brings its own", async () => {
    const fake = fakePlatform([KIT]);
    await openPage();
    const add = await vi.waitFor(() => {
      const node = document.querySelector<HTMLButtonElement>("[data-kit-new]");
      if (node === null) throw new Error("no New kit");
      return node;
    });
    // Two writes owed when the open arrives: the first fails and its line
    // is dismissed, the second lands — and its render clears the line too.
    // So the page stays over the first, with no failure line left to offer
    // the take beside.
    const gates: Array<{ release: () => void; fail: (e: Error) => void }> = [];
    const area = fake.platform.kits;
    const update = area.update.bind(area);
    area.update = (change) => {
      const gate = { release: () => {}, fail: (_e: Error) => {} };
      gates.push(gate);
      return new Promise<void>((resolve, reject) => {
        gate.release = resolve;
        gate.fail = reject;
      }).then(() => update(change));
    };
    add.click();
    add.click();
    await vi.waitFor(() => {
      if (gates.length !== 2) throw new Error(`writes asked: ${gates.length}`);
    });
    fake.openListeners[0]?.("/editor.html?scene=take-1");
    gates[0]?.fail(new Error("the disk is full"));
    const notice = document.querySelector<HTMLElement>("#notice");
    const dismiss = await vi.waitFor(() => {
      const node = notice?.querySelector<HTMLButtonElement>(
        "[data-notice-dismiss]",
      );
      if (node == null) throw new Error(`no failure: ${notice?.textContent}`);
      return node;
    });
    dismiss.click();
    // The premise: the dismiss cleared the line.
    expect(notice?.classList.contains("hidden")).toBe(true);
    expect(notice?.childElementCount).toBe(0);
    gates[1]?.release();
    // Red: let the offer go nowhere when addNoticeAction finds no line.
    const offer = await vi.waitFor(() => {
      const node =
        notice?.querySelector<HTMLButtonElement>("[data-open-asked]");
      if (node == null) throw new Error(`no offer: ${notice?.textContent}`);
      return node;
    });
    expect(notice?.classList.contains("hidden")).toBe(false);
    expect(nav.assigned).toEqual([]);
    expect(offer.textContent).toBe("Open the take");
    expect(notice?.querySelector(".notice-title")?.textContent).toBe(
      "A change here didn't save, so this window stayed on Settings.",
    );
    // The premise: the second write did land.
    expect(
      storedKits(fake).filter((k) => k.name === "Untitled kit"),
    ).toHaveLength(1);
  });
});

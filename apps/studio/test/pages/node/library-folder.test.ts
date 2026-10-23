// apps/studio/test/pages/node/library-folder.test.ts
import type { SceneDocument } from "@demoman/scene-schema";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  FolderListing,
  Platform,
} from "../../../pages/src/platform/types";

/**
 * The library page on a platform with a take folder (the studio): the real
 * `entrypoints/library/main.ts` and the real view, `#platform` replaced by
 * one whose `folder` the test drives. What this pins is the page's side of
 * the studio's feeds: a burst of `takes` events costs two reads, not one per
 * event; a name being typed survives the re-read; a watcher that failed
 * before the page opened is said; a folder that will not read is a row with
 * a Delete that works; a thumbnail the studio refused shows the studio's
 * words in the card's own failed state.
 *
 * Same mount pattern as `library-main-delete.test.ts`; the mock replaces
 * `#platform`'s `createPlatform` and keeps its other exports.
 *
 * Production changes that redden it, made and watched go red (see the task
 * report): call `render()` per event instead of `refreshSoon`; stop
 * `renderLibrary` restoring the typed name; drop the `unwatched` notice;
 * make the empty card ignore `unreadable`; route `image` past `folder.thumb`.
 */

const STUDIO_HINT = "Ask your agent for a demo video. Each take shows up here.";

const confirmDialog = vi.hoisted(() => ({
  ask: vi.fn<(question: unknown) => Promise<boolean>>(),
}));
vi.mock("../../../pages/src/shell/confirm-dialog", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  askToConfirm: (question: unknown) => confirmDialog.ask(question),
}));

/** What the fake platform does, set per case before the page is imported. */
const world = vi.hoisted(() => ({
  platform: null as unknown,
}));
vi.mock("#platform", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  createPlatform: () => world.platform,
}));

async function scene(id: string, name: string): Promise<SceneDocument> {
  const { readonlyScene } = await import(
    "../../../../../packages/replay-engine/test/helpers/scenes"
  );
  const base = readonlyScene();
  return { ...base, meta: { ...base.meta, id, name } };
}

interface Fake {
  reads: number;
  removed: string[];
  changeListeners: Array<() => void>;
  thumbs: string[];
  platform: Platform;
}

/** A platform with a `folder` whose reads `answer` decides, by call number. */
async function fakePlatform(
  answer: (call: number) => Promise<FolderListing> | FolderListing,
  thumb: (ref: string) => Promise<ImageBitmap> = () =>
    new Promise<never>(() => {}),
): Promise<Fake> {
  const { proceduralBundle } = await import(
    "../../../../../packages/replay-engine/test/helpers/bundles"
  );
  const fake: Fake = {
    reads: 0,
    removed: [],
    changeListeners: [],
    thumbs: [],
    platform: null as unknown as Platform,
  };
  fake.platform = {
    scenes: {
      get: async () => null,
      put: async () => ({ revision: "r" }),
      list: async () => {
        throw new Error("the page listed scenes instead of reading the folder");
      },
      remove: async (id: string) => {
        fake.removed.push(id);
        return { ok: true };
      },
    },
    bundles: {
      active: async () => ({
        bundle: proceduralBundle(),
        replay: null,
        capture: null,
      }),
      load: () => new Promise<never>(() => {}),
    },
    folder: {
      read: async () => {
        fake.reads += 1;
        return answer(fake.reads);
      },
      onChange: (fn: () => void) => {
        fake.changeListeners.push(fn);
        return () => {};
      },
      thumb: (ref: string) => {
        fake.thumbs.push(ref);
        return thumb(ref);
      },
    },
    theme: { read: async () => "system", write: async () => undefined },
    nav: {
      editor: (id: string) => `/editor.html?scene=${id}`,
      library: () => "/",
      firstTakeHint: () => STUDIO_HINT,
      rerun: (id: string) => ({ kind: "line", text: `re-film ${id}` }),
    },
  } as unknown as Platform;
  world.platform = fake.platform;
  return fake;
}

function listing(
  scenes: SceneDocument[],
  more: Partial<FolderListing> = {},
): FolderListing {
  return {
    scenes,
    sizes: Object.fromEntries(scenes.map((s) => [s.meta.id, 1024])),
    unreadable: [],
    unwatched: null,
    ...more,
  };
}

function mountDom(): void {
  document.body.innerHTML = `
    <div data-storage-slot></div>
    <div data-theme-slot></div>
    <div id="notice" class="hidden" role="alert"></div>
    <main id="root"></main>
  `;
}

async function openPage(): Promise<void> {
  vi.resetModules();
  await import("../../../pages/entrypoints/library/main");
}

function nameField(id: string): HTMLInputElement | null {
  return document.querySelector<HTMLInputElement>(
    `[data-row="${id}"] [data-name]`,
  );
}

describe("the library page on a platform with a take folder", () => {
  beforeEach(() => {
    mountDom();
    confirmDialog.ask.mockReset();
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "info").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("a takes change re-reads, and three in a burst cost two reads, not four", async () => {
    const gate = { release: () => {} };
    const first = new Promise<void>((resolve) => {
      gate.release = resolve;
    });
    const fake = await fakePlatform(async (call) => {
      if (call === 1) await first;
      return listing([await scene("a", `read ${call}`)]);
    });
    await openPage();
    await vi.waitFor(() => {
      if (fake.reads !== 1) throw new Error(`reads: ${fake.reads}, wanted 1`);
      if (fake.changeListeners.length !== 1) {
        throw new Error(`onChange listeners: ${fake.changeListeners.length}`);
      }
    });
    // Premise: the first read is held open, so the burst lands during it.
    expect(document.querySelector("[data-row]")).toBeNull();
    for (let i = 0; i < 3; i++) fake.changeListeners[0]?.();
    gate.release();
    await vi.waitFor(() => {
      const field = nameField("a");
      if (field?.value !== "read 2") {
        throw new Error(
          `name field: ${field?.value ?? "none"}, reads: ${fake.reads}`,
        );
      }
    });
    // Let anything still queued run: a macrotask yield, not a duration.
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    expect(fake.reads).toBe(2);
  });

  it("a name being typed survives a re-read", async () => {
    const fake = await fakePlatform(async (call) =>
      listing([
        await scene("a", "Checkout"),
        ...(call > 1 ? [await scene("b", "New take")] : []),
      ]),
    );
    await openPage();
    const field = await vi.waitFor(() => {
      const f = nameField("a");
      if (f === null) throw new Error("row a not drawn");
      return f;
    });
    field.focus();
    field.value = "Check";
    field.setSelectionRange(5, 5);
    // Premise: the field holds typed text and has focus before the change.
    expect(document.activeElement).toBe(field);
    expect(field.value).toBe("Check");
    fake.changeListeners[0]?.();
    await vi.waitFor(() => {
      if (document.querySelector('[data-row="b"]') === null) {
        throw new Error(`take b not drawn; reads: ${fake.reads}`);
      }
    });
    const after = nameField("a");
    expect(after).not.toBe(field);
    expect(after?.value).toBe("Check");
    expect(document.activeElement).toBe(after);
  });

  it("the page opened after the watcher failed says so", async () => {
    await fakePlatform(async () =>
      listing([await scene("a", "Checkout")], {
        unwatched: "/Users/a/takes could not be watched (EMFILE)",
      }),
    );
    await openPage();
    const line = await vi.waitFor(() => {
      const node = document.querySelector("[data-unwatched]");
      if (node === null) throw new Error("no watcher line drawn");
      return node;
    });
    expect(line.textContent).toBe(
      "New takes will not show until you reload — /Users/a/takes could not be watched (EMFILE).",
    );
    expect(line.classList.contains("notice-warn")).toBe(true);
  });

  // Found in the D3 check: a take card and the "Couldn't read" row its
  // folder becomes share one id, and so did their statuses — a delete
  // refused on the card during an export ("Not deleted: … being exported")
  // reappeared on the row once scene.json broke, long after the export had
  // ended. Red if a status is keyed on the id alone: the row says it.
  it("a card's refusal does not follow its take onto a Couldn't-read row, and the row's own still shows", async () => {
    const t1 = await scene("t1", "Busy take");
    let broken = false;
    const fake = await fakePlatform(async () =>
      broken
        ? listing([], {
            unreadable: [{ folder: "t1", reason: "scene.json is not a take" }],
            sizes: { t1: 2048 },
          })
        : listing([t1]),
    );
    const BUSY = "This take is being exported by an agent.";
    fake.platform.scenes.remove = async (id: string) => {
      fake.removed.push(id);
      return { ok: false, error: "takeBusy", detail: BUSY };
    };
    confirmDialog.ask.mockResolvedValue(true);
    await openPage();
    const card = await vi.waitFor(() => {
      const node = document.querySelector('[data-row="t1"]');
      if (node === null) throw new Error("no card drawn");
      return node;
    });
    card.querySelector<HTMLButtonElement>('[data-action="delete"]')?.click();
    // The premise: the refusal is said on the card.
    await vi.waitFor(() => {
      const said = document.querySelector('[data-row="t1"] [data-status]');
      if (!said?.textContent?.includes(BUSY)) {
        throw new Error(`card status: ${said?.textContent ?? "none"}`);
      }
    });
    broken = true;
    for (const fn of fake.changeListeners) fn();
    const row = await vi.waitFor(() => {
      const node = document.querySelector('[data-unreadable-row="t1"]');
      if (node === null) throw new Error("no unreadable row drawn");
      return node;
    });
    expect(document.querySelector('[data-row="t1"]')).toBeNull();
    expect(row.querySelector("[data-status]")?.textContent ?? null).toBeNull();
    // The control: the row's own Delete, refused, is said on the row.
    row.querySelector<HTMLButtonElement>('[data-action="delete"]')?.click();
    await vi.waitFor(() => {
      const said = document.querySelector(
        '[data-unreadable-row="t1"] [data-status]',
      );
      if (!said?.textContent?.includes(BUSY)) {
        throw new Error(`row status: ${said?.textContent ?? "none"}`);
      }
    });
    expect(fake.removed).toEqual(["t1", "t1"]);
  });

  it("Delete on an unreadable row asks, deletes the folder and re-reads", async () => {
    let removed = false;
    const fake = await fakePlatform(async () =>
      listing([], {
        unreadable: removed
          ? []
          : [{ folder: "bad-take", reason: "scene.json is not valid JSON" }],
        sizes: removed ? {} : { "bad-take": 2048 },
      }),
    );
    const remove = fake.platform.scenes.remove.bind(fake.platform.scenes);
    fake.platform.scenes.remove = async (id) => {
      const r = await remove(id);
      removed = true;
      return r;
    };
    confirmDialog.ask.mockResolvedValue(true);
    await openPage();
    const unreadable = await vi.waitFor(() => {
      const node = document.querySelector('[data-unreadable-row="bad-take"]');
      if (node === null) throw new Error("no unreadable row drawn");
      return node;
    });
    // Premise: the library holds nothing but the unreadable folder, and the
    // empty card is not hiding it.
    expect(document.querySelector("[data-row]")).toBeNull();
    expect(document.querySelector("[data-empty]")).toBeNull();
    expect(unreadable.textContent).toContain("scene.json is not valid JSON");
    unreadable
      .querySelector<HTMLButtonElement>('[data-action="delete"]')
      ?.click();
    await vi.waitFor(() => {
      if (document.querySelector("[data-empty]") === null) {
        throw new Error(
          `still listed; removed: ${fake.removed.join(",")}, reads: ${fake.reads}`,
        );
      }
    });
    expect(confirmDialog.ask).toHaveBeenCalledTimes(1);
    expect(fake.removed).toEqual(["bad-take"]);
    expect(fake.reads).toBeGreaterThanOrEqual(2);
    expect(document.querySelector("[data-empty]")?.textContent).toContain(
      STUDIO_HINT,
    );
  });

  // Launch D3's screenshot pass: the unreadable folders sit after every
  // day, below the fold of a long library, so the jump list names them.
  // Red if `jumpList` drops its unreadable link.
  it("the jump list names the folders that couldn't be read, and links to them", async () => {
    const take = await scene("take-1", "One");
    await fakePlatform(async () =>
      listing([take], {
        unreadable: [
          { folder: "bad-take", reason: "scene.json is not valid JSON" },
        ],
        sizes: { "take-1": 1024, "bad-take": 2048 },
      }),
    );
    await openPage();
    const link = await vi.waitFor(() => {
      const a = document.querySelector<HTMLAnchorElement>(
        '[data-jumps] a[data-nav="unreadable"]',
      );
      if (a === null) {
        throw new Error(
          `no link: ${document.querySelector("[data-jumps]")?.innerHTML}`,
        );
      }
      return a;
    });
    // Premise: the take's own day is listed too, so the list is the dated
    // one with the unreadable link after it.
    const labels = [
      ...document.querySelectorAll("[data-jumps] .side-label"),
    ].map((l) => l.textContent);
    expect(labels).toHaveLength(2);
    expect(labels.at(-1)).toBe("Couldn't read");
    expect(link.querySelector(".side-count")?.textContent).toBe("1");
    const target = document.getElementById(
      link.getAttribute("href")?.slice(1) ?? "",
    );
    expect(target?.hasAttribute("data-unreadable")).toBe(true);
  });

  it("a thumb that fails shows the preview-failed state with the Studio's words", async () => {
    const detail = "Couldn't make a preview of kf:x:0: sips: Error 13.";
    const fake = await fakePlatform(
      async () => listing([await scene("a", "Checkout")]),
      async () => {
        throw new Error(detail);
      },
    );
    await openPage();
    const note = await vi.waitFor(
      () => {
        const text =
          document.querySelector('[data-row="a"] [data-preview-note]')
            ?.textContent ?? "";
        if (!text.startsWith("Preview unavailable — ")) {
          throw new Error(
            `note: ${JSON.stringify(text)}, thumbs asked: ${fake.thumbs.join(",")}`,
          );
        }
        return text;
      },
      { timeout: 5_000 },
    );
    expect(note).toBe(`Preview unavailable — ${detail}`);
    expect(fake.thumbs.length).toBeGreaterThan(0);
  });
});

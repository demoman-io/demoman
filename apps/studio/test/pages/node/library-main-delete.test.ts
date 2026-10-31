// apps/studio/test/pages/node/library-main-delete.test.ts
import type { SceneDocument } from "@demoman/scene-schema";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createMemoryPlatform,
  type MemoryPlatform,
} from "../helpers/memory-platform";

const state = vi.hoisted(() => ({ memory: null as MemoryPlatform | null }));
// The real module's other exports stay; only the platform is the memory one.
vi.mock("#platform", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  createPlatform: () => state.memory,
}));

/**
 * `entrypoints/library/main.ts` decides WHICH sentence an author reads for
 * a `demo:delete` reply — refused / partly deleted / deleted — and until
 * this file, nothing drove that decision through the real entrypoint.
 * `library-view.test.ts` only proves that a pre-made status string gets
 * rendered; it says nothing about whether `main.ts` builds the right
 * string from a given reply. A partial delete silently reported as
 * success is the worst thing this page can say (data an author believes
 * is freed is not), so this is exactly the "report before you forgive"
 * class CLAUDE.md names, sitting on the one path that tells an author
 * whether their data survived.
 *
 * Same pattern as `editor-main-share.test.ts`: mount the real DOM, stub a
 * memory platform (until 2026-10-20 a faked `chrome`), `vi.resetModules()`,
 * import the real entrypoint.
 *
 * `renderLibrary` replaces the whole row element on every re-render (see
 * `view.ts`'s `root.replaceChildren`), so every lookup below re-queries
 * `document` for the CURRENT row rather than holding a reference across a
 * click — a stale reference would just show whatever it showed before the
 * click forever, which would make every assertion here pass vacuously.
 */

function mountLibraryDom(): void {
  document.body.innerHTML = `
    <div id="notice" class="hidden" role="alert"></div>
    <main id="root"></main>
  `;
}

// No `onMessage.addListener` stub: unlike the editor, the library page
// never listens for a background broadcast, and pinning that pattern here
// would only add an interface nothing uses.

const SCENE = {
  meta: {
    id: "a",
    name: "Checkout",
    createdAt: "2026-09-01T00:00:00Z",
    capture: { originUrl: "https://app.test/x" },
  },
} as never;

// Stateful rather than a fixed `[SCENE]`: FINDING 5's test below needs
// `scenes.list()` to actually stop returning the scene once a delete's
// "scene" step has run — the real `SceneStore.delete` this mock stands in
// for — so the row genuinely vanishes from the next render, the way it
// does against the real background.
const sceneStoreState = vi.hoisted(() => ({ deleted: false }));

// jsdom has no `showModal`, so the dialog itself is asserted in
// test/browser/confirm-dialog.test.ts and only its answer is faked here.
// `DELETE_DEMO` stays real, so the question asked is the shipped one.
const confirmDialog = vi.hoisted(() => ({
  ask: vi.fn<(question: unknown) => Promise<boolean>>(),
}));
vi.mock("../../../pages/src/shell/confirm-dialog", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  askToConfirm: (question: unknown) => confirmDialog.ask(question),
}));
// The Needs a look flags' read. No take here is flagged; the files that
// are about the flag drive this themselves (library-main-open.test.ts).

/** Always the CURRENT row node — see the file-level comment on why a held
 *  reference across a re-render is wrong. */
async function currentRow(): Promise<HTMLElement> {
  return vi.waitFor(() => {
    const row = document.querySelector('[data-row="a"]');
    if (!row) throw new Error("row not rendered yet");
    return row as HTMLElement;
  });
}

async function clickDelete(): Promise<void> {
  const row = await currentRow();
  const button = row.querySelector(
    '[data-action="delete"]',
  ) as HTMLButtonElement;
  button.click();
}

/** Waits for the CURRENT row's status text to satisfy `predicate`, so a
 *  test never reads a detached node left over from before the click. */
async function waitForStatus(
  predicate: (text: string) => boolean,
): Promise<string> {
  return vi.waitFor(() => {
    const el = document.querySelector('[data-row="a"] [data-status]');
    const text = el?.textContent ?? null;
    if (text === null || !predicate(text)) {
      throw new Error(
        `status not yet matching — currently ${JSON.stringify(text)}`,
      );
    }
    return text;
  });
}

describe("library main — the three demo:delete outcomes read differently", () => {
  let memory: MemoryPlatform;

  beforeEach(() => {
    vi.resetModules();
    mountLibraryDom();
    sceneStoreState.deleted = false;
    memory = createMemoryPlatform();
    state.memory = memory;
    // The take folder as the studio lists it: the one take, until a test
    // says its scene is already gone.
    memory.answer("folder.read", async () => ({
      scenes: sceneStoreState.deleted
        ? []
        : [SCENE as unknown as SceneDocument],
      sizes: {},
      unreadable: [],
      unwatched: null,
    }));
    // Delete asks first; every test here says yes unless it says otherwise.
    confirmDialog.ask.mockReset().mockResolvedValue(true);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it("asks the shipped Delete question, and sends nothing on Cancel", async () => {
    const { DELETE_DEMO } = await import(
      "../../../pages/src/shell/confirm-dialog"
    );
    confirmDialog.ask.mockResolvedValue(false);
    memory.answer("scenes.remove", async () => ({ ok: true }));
    await import("../../../pages/entrypoints/library/main");
    await currentRow();
    await clickDelete();

    await vi.waitFor(() => {
      if (confirmDialog.ask.mock.calls.length === 0) {
        throw new Error("not asked yet");
      }
    });
    expect(confirmDialog.ask).toHaveBeenCalledWith(DELETE_DEMO);
    // Settle anything the answer set off before asserting it set off nothing.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(
      memory.calls.some((c) => c.member === "scenes" && c.method === "remove"),
    ).toBe(false);
    expect(document.querySelector('[data-row="a"] [data-status]')).toBeNull();
  });

  it("says on the row that nothing was deleted when the question could not open", async () => {
    confirmDialog.ask.mockRejectedValue(new Error("dialog refused"));
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    memory.answer("scenes.remove", async () => ({ ok: true }));
    await import("../../../pages/entrypoints/library/main");
    await currentRow();
    await clickDelete();

    const status = await waitForStatus((t) => t.length > 0);
    expect(status).toBe(
      "Not deleted: the confirmation could not open — dialog refused.",
    );
    expect(
      memory.calls.some((c) => c.member === "scenes" && c.method === "remove"),
    ).toBe(false);
  });

  it("says a render is running when demo:delete refuses on that ground", async () => {
    memory.answer("scenes.remove", async () => ({
      ok: false,
      error: "rendering",
    }));
    await import("../../../pages/entrypoints/library/main");
    await currentRow();
    await clickDelete();

    const status = await waitForStatus((t) => t.length > 0);
    expect(status).toBe("Not deleted: a render is running.");
  });

  // A second refusal code, asserted with its own exact text, so a refusal
  // cannot pass a test for a DIFFERENT refusal's reason — collapsing every
  // refusal to one generic sentence would still pass a looser assertion.
  it("says a share is in progress when demo:delete refuses on that ground", async () => {
    memory.answer("scenes.remove", async () => ({
      ok: false,
      error: "sharing",
    }));
    await import("../../../pages/entrypoints/library/main");
    await currentRow();
    await clickDelete();

    const status = await waitForStatus((t) => t.length > 0);
    expect(status).toBe("Not deleted: a share is in progress.");
  });

  // A fourth refusal reason arrived with the replay hold, and an unmapped
  // reason falls through to `?? r.error` — the author would read the raw
  // identifier "replaying". The mapping is what makes it a sentence.
  it("says a video is being run in Runs when demo:delete refuses on that ground", async () => {
    memory.answer("scenes.remove", async () => ({
      ok: false,
      error: "replaying",
    }));
    await import("../../../pages/entrypoints/library/main");
    await currentRow();
    await clickDelete();

    const status = await waitForStatus((t) => t.length > 0);
    expect(status).toBe("Not deleted: a video is being run in Runs.");
  });

  it("says which step failed for a partial delete, and never claims success", async () => {
    memory.answer("scenes.remove", async () => ({
      ok: true,
      result: {
        ok: false,
        steps: [
          { step: "bundles", ok: true, error: null },
          { step: "outputs", ok: false, error: "outputs db closed" },
        ],
      },
    }));
    await import("../../../pages/entrypoints/library/main");
    await currentRow();
    await clickDelete();

    const status = await waitForStatus((t) => t.length > 0);
    expect(status).toBe(
      "Partly deleted: outputs could not be removed — outputs db closed",
    );
    // The one sentence this page must never say for a partial delete.
    expect(status).not.toBe("Deleted");
    expect(status).not.toMatch(/^Deleted\b/);
  });

  it("clears a stale status once a delete fully succeeds", async () => {
    let attempt = 0;
    memory.answer("scenes.remove", async () => {
      attempt += 1;
      return attempt === 1
        ? {
            ok: true,
            result: {
              ok: false,
              steps: [
                { step: "outputs", ok: false, error: "outputs db closed" },
              ],
            },
          }
        : {
            ok: true,
            result: {
              ok: true,
              steps: [{ step: "outputs", ok: true, error: null }],
            },
          };
    });
    await import("../../../pages/entrypoints/library/main");
    await currentRow();

    // First attempt: partial, so a status line exists.
    await clickDelete();
    await waitForStatus((t) => /Partly deleted/.test(t));

    // Second attempt: clean delete. The stale partial message must not
    // linger — it must be cleared, not merely overwritten with the same
    // words a first-time success would show.
    await clickDelete();
    await vi.waitFor(() => {
      if (document.querySelector('[data-row="a"] [data-status]')) {
        throw new Error("status still rendered");
      }
    });
    expect(document.querySelector('[data-row="a"] [data-status]')).toBeNull();
  });

  it("toasts a clean delete of a video in no flow, and never a partial one", async () => {
    memory.answer("scenes.remove", async () => ({ ok: true }));
    await import("../../../pages/entrypoints/library/main");
    await currentRow();
    await clickDelete();
    await vi.waitFor(() => {
      const said = document.querySelector("[data-toast-text]")?.textContent;
      if (said !== "Deleted the video") throw new Error(`toast: ${said}`);
    });
    expect(
      document.querySelector("#notice")?.classList.contains("hidden"),
    ).toBe(true);
  });

  it("a partial delete says so on the row and toasts nothing", async () => {
    memory.answer("scenes.remove", async () => ({
      ok: true,
      result: {
        ok: false,
        steps: [{ step: "outputs", ok: false, error: "outputs db closed" }],
      },
    }));
    await import("../../../pages/entrypoints/library/main");
    await currentRow();
    await clickDelete();
    await waitForStatus((t) => /Partly deleted/.test(t));
    expect(document.querySelector("[data-toast]")).toBeNull();
  });

  it("a delete with a note says the note on the notice line, not in a toast", async () => {
    memory.answer("scenes.remove", async () => ({
      ok: true,
      note: "Cleared a stale export lock left by process 42.",
    }));
    await import("../../../pages/entrypoints/library/main");
    await currentRow();
    await clickDelete();
    await vi.waitFor(() => {
      const t = document.querySelector("#notice")?.textContent;
      if (t !== "Cleared a stale export lock left by process 42.") {
        throw new Error(`notice: ${t}`);
      }
    });
    expect(document.querySelector("[data-toast]")).toBeNull();
  });

  // FINDING 5 (whole-branch review). `deleteDemo` deletes the scene
  // document before its LAST step (`drift`). A failure at "drift" (or any
  // step after "scene") still writes a row-level status here, but the row
  // it would appear on is already gone from the next `scenes.list()` —
  // this codebase's own `SceneStore.delete` ran successfully as an earlier
  // step. A row-level status the row can never show is the same defect as
  // no status at all: the demo vanishes and the author sees success. The
  // fix surfaces this at PAGE level, through the same `#notice`/`fail(...)`
  // path a `sendMessage` failure already uses.
  it("surfaces a partial delete at page level when the scene itself is already gone", async () => {
    memory.answer("scenes.remove", async () => {
      // The real `deleteDemo`'s own ordering: "scene" succeeds, "drift" —
      // its last step — fails. The scene document is genuinely gone by
      // the time this reply is read.
      sceneStoreState.deleted = true;
      return {
        ok: true,
        result: {
          ok: false,
          steps: [
            { step: "bundles", ok: true, error: null },
            { step: "statuses", ok: true, error: null },
            { step: "outputs", ok: true, error: null },
            { step: "flags", ok: true, error: null },
            { step: "hosted", ok: true, error: null },
            { step: "scene", ok: true, error: null },
            { step: "drift", ok: false, error: "drift index broke" },
          ],
        },
      };
    });
    await import("../../../pages/entrypoints/library/main");
    await currentRow();
    await clickDelete();

    // The row itself must actually be gone — otherwise this test would
    // pass whether or not the page-level surface exists.
    await vi.waitFor(() => {
      if (document.querySelector('[data-row="a"]')) {
        throw new Error("row still rendered");
      }
    });
    expect(document.querySelector('[data-row="a"]')).toBeNull();

    const notice = await vi.waitFor(() => {
      const el = document.querySelector("#notice");
      if (el === null || el.classList.contains("hidden")) {
        throw new Error("notice not yet shown");
      }
      return el;
    });
    expect(notice.textContent).toMatch(/drift/);
    expect(notice.textContent).toMatch(/drift index broke/);
  });
});

// The editor's Delete ends here, and on the studio its reply can carry a
// note the editor could not stay to say (final review I1). It comes in the
// URL's `note` and is said once the page has drawn.
describe("library main — a note carried from the editor's Delete", () => {
  const NOTE =
    "This video was deleted. /h/.demoman/takes/.trash-a could not be removed — delete it by hand.";
  let memory: MemoryPlatform;

  beforeEach(() => {
    vi.resetModules();
    mountLibraryDom();
    sceneStoreState.deleted = false;
    memory = createMemoryPlatform();
    state.memory = memory;
    // The take folder as the studio lists it: the one take, until a test
    // says its scene is already gone.
    memory.answer("folder.read", async () => ({
      scenes: sceneStoreState.deleted
        ? []
        : [SCENE as unknown as SceneDocument],
      sizes: {},
      unreadable: [],
      unwatched: null,
    }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.resetModules();
    window.history.replaceState({}, "", "/");
  });

  it("says the note at info once the page has drawn, and drops it from the URL", async () => {
    window.history.replaceState(
      {},
      "",
      `/library.html?note=${encodeURIComponent(NOTE)}`,
    );
    await import("../../../pages/entrypoints/library/main");
    // Premise: the page drew (its render clears the notice as it starts).
    await currentRow();
    // Red: drop the `say(carried, …)` after the first render.
    const notice = await vi.waitFor(() => {
      const el = document.querySelector("#notice") as HTMLElement;
      if (el.textContent !== NOTE) {
        throw new Error(`notice reads ${JSON.stringify(el.textContent)}`);
      }
      return el;
    });
    expect(notice.className).toBe("notice");
    // A reload must not say it again.
    expect(window.location.search).toBe("");
  });

  it("toasts the editor's clean delete, and leaves the notice line empty", async () => {
    window.history.replaceState(
      {},
      "",
      `/library.html?note=${encodeURIComponent("Deleted the video")}`,
    );
    await import("../../../pages/entrypoints/library/main");
    await currentRow();
    await vi.waitFor(() => {
      const said = document.querySelector("[data-toast-text]")?.textContent;
      if (said !== "Deleted the video") throw new Error(`toast: ${said}`);
    });
    const notice = document.querySelector("#notice") as HTMLElement;
    expect(notice.classList.contains("hidden")).toBe(true);
    expect(window.location.search).toBe("");
  });

  it("says nothing without a note (a delete with no note)", async () => {
    window.history.replaceState({}, "", "/library.html");
    await import("../../../pages/entrypoints/library/main");
    await currentRow();
    const notice = document.querySelector("#notice") as HTMLElement;
    expect(notice.textContent).toBe("");
    expect(notice.classList.contains("hidden")).toBe(true);
  });
});

// apps/studio/test/pages/node/library-main-open.test.ts
import type { SceneDocument } from "@demoman/scene-schema";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createMemoryPlatform,
  type MemoryPlatform,
} from "../helpers/memory-platform";
import { captureNavigations, type Navigations } from "../helpers/navigation";

/**
 * Opening a take from a Recordings card, and where it opens.
 *
 * Until 2026-09-21 `edit` called `chrome.tabs.create`, and NOTHING asserted
 * what it was handed — a wrong scene id or a path typo would have shipped
 * green. It navigates this tab now, so the editor's Back control and the
 * browser's own Back both lead here. These cases assert the FULL url, not
 * merely that a navigation happened.
 *
 * Moved from apps/extension on 2026-10-20, onto the memory platform. The
 * cases for the extension's own doors left with it: Restore motion (Runs)
 * and the drift flag (Needs a look).
 */

const state = vi.hoisted(() => ({ memory: null as MemoryPlatform | null }));
// The real module's other exports stay; only the platform is the memory one.
vi.mock("#platform", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  createPlatform: () => state.memory,
}));

function mountLibraryDom(): void {
  document.body.innerHTML = `
    <div id="notice" class="hidden" role="alert"></div>
    <main id="root"></main>
  `;
}

// An id that has to survive `encodeURIComponent` intact to be worth
// asserting: a handler that pasted the raw id into the query string would
// produce `?scene=a b&x=1`, which reads as a second parameter.
const SCENE_ID = "a b&x=1";
const EDITOR = `/editor.html?scene=${encodeURIComponent(SCENE_ID)}`;

const take = (): SceneDocument =>
  ({
    meta: {
      id: SCENE_ID,
      name: "Checkout",
      createdAt: "2026-09-01T00:00:00Z",
      capture: { originUrl: "https://app.test/x" },
    },
  }) as unknown as SceneDocument;

async function control(action: string): Promise<HTMLButtonElement> {
  return vi.waitFor(() => {
    const node = document.querySelector(`[data-action="${action}"]`);
    if (!node) throw new Error(`no ${action} control rendered yet`);
    return node as HTMLButtonElement;
  });
}

describe("library main — opening a take", () => {
  let memory: MemoryPlatform;
  let nav: Navigations;

  beforeEach(() => {
    vi.resetModules();
    mountLibraryDom();
    nav = captureNavigations();
    memory = createMemoryPlatform({ scenes: [take()] });
    state.memory = memory;
  });

  afterEach(() => {
    nav.restore();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it("Edit goes to the editor for that take, in this tab", async () => {
    await import("../../../pages/entrypoints/library/main");
    (await control("edit")).click();

    expect(nav.assigned).toEqual([EDITOR]);
  });

  /** Commits a rename on the card the way the blur before a click does. */
  async function renameCard(name: string): Promise<void> {
    const field = await vi.waitFor(() => {
      const node = document.querySelector<HTMLInputElement>("[data-name]");
      if (!node) throw new Error("no name field rendered yet");
      return node;
    });
    field.value = name;
    field.dispatchEvent(new Event("change", { bubbles: true }));
  }

  /**
   * The mousedown that pressed Edit blurred the card's name field and
   * committed a rename: two round trips, neither sent when the navigation
   * began, so the rename was dropped and the editor opened on the old name.
   * Verified failable: calling `openInThisTab` directly from `edit`, as
   * before, navigates before the put and fails the first `toEqual([])`.
   */
  it("Edit waits for a rename the same click committed", async () => {
    let answerPut: (reply: { revision: string }) => void = () => undefined;
    memory.answer(
      "scenes.put",
      () =>
        new Promise((resolve) => {
          answerPut = resolve;
        }),
    );
    await import("../../../pages/entrypoints/library/main");
    await renameCard("Checkout, renamed");
    (await control("edit")).click();
    await vi.waitFor(() => {
      if (memory.putCalls().length === 0) {
        throw new Error("rename not sent yet");
      }
    });
    expect(nav.assigned).toEqual([]);

    answerPut({ revision: "r2" });
    await vi.waitFor(() => {
      if (nav.assigned.length === 0) throw new Error("not navigated yet");
    });
    expect(nav.assigned).toEqual([EDITOR]);
  });

  /** Verified failable: opening on a failed rename too fails `toEqual([])`. */
  it("Edit stays on the card when that rename is refused", async () => {
    memory.answer("scenes.put", async () => {
      throw new Error("refused, distinctive-marker-l7");
    });
    await import("../../../pages/entrypoints/library/main");
    await renameCard("Checkout, renamed");
    (await control("edit")).click();
    await vi.waitFor(() => {
      const status = document.querySelector("[data-status]")?.textContent;
      if (!status?.includes("distinctive-marker-l7")) {
        throw new Error(`row not updated yet: ${JSON.stringify(status)}`);
      }
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(nav.assigned).toEqual([]);
  });

  it("says so on the page when the navigation is refused", async () => {
    // `location.assign` throws. Left unhandled the author, still looking at
    // Recordings, is told nothing about why Edit did nothing.
    nav.failAssignWith(new Error("navigation refused, distinctive-marker"));
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    await import("../../../pages/entrypoints/library/main");
    (await control("edit")).click();

    const notice = await vi.waitFor(() => {
      const text = document.querySelector("#notice")?.textContent ?? "";
      if (!/opening the editor/.test(text)) {
        throw new Error(
          `notice not shown yet — currently ${JSON.stringify(text)}`,
        );
      }
      return text;
    });
    expect(notice).toMatch(/Something went wrong/);
    expect(
      errors.mock.calls.some((args) =>
        args.some((a) => String(a).includes("navigation refused")),
      ),
    ).toBe(true);
  });
});

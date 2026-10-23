import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readonlyScene } from "../../../../../packages/replay-engine/test/helpers/scenes";
import { editorDom } from "../helpers/editor-dom";
import {
  createMemoryPlatform,
  type MemoryPlatform,
} from "../helpers/memory-platform";
import { captureNavigations, type Navigations } from "../helpers/navigation";

const state = vi.hoisted(() => ({ memory: null as MemoryPlatform | null }));
// The real module's other exports (the studio's own copy, such as
// `refilmLine`) stay; only the platform the page builds is the memory one.
vi.mock("#platform", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  createPlatform: () => state.memory,
}));

/**
 * `entrypoints/editor/main.ts`'s side of the storage lifecycle: the header
 * Delete button, the header Back button, and a frameless take's route to
 * Runs — where the library's "Restore motion" now goes too, in place of the
 * `?replay=1` door that ran a replay from here until 2026-09-28. Same rationale as `editor-main-share.test.ts` (see that file's own
 * header comment) — `entrypoints/**` runs unmocked in production and is
 * exercised by nothing except a file that drives the real module against a
 * faked `chrome`.
 *
 * A refusal, a partial delete, and a clean delete must read differently —
 * `library-main-delete.test.ts` pins the identical rule for the library
 * page's own `demo:delete` wiring; this file pins it for the editor's.
 * A partial reported as success would be the worst thing this page could
 * say: Delete is not undoable.
 */

class FakeOffscreenCanvas {
  width: number;
  height: number;
  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
  }
  getContext(): Record<string, never> {
    return {};
  }
}

// Delegates to the same in-memory helper `EditorStore` implements, rather
// than hand-writing five stub methods here: the helper is typechecked as an
// `EditorStore`, so a future method added to the interface breaks the build
// instead of producing a runtime "is not a function" in one unlucky test —
// exactly the trap Task 5's implementer found in this file's siblings.
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

describe("editor main — storage lifecycle wiring", () => {
  let memory: MemoryPlatform;
  let nav: Navigations;

  beforeEach(() => {
    vi.resetModules();
    editorDom();
    nav = captureNavigations();
    vi.stubGlobal("OffscreenCanvas", FakeOffscreenCanvas);
    memory = createMemoryPlatform();
    state.memory = memory;
    memory.serveScene(() => readonlyScene());
    memory.serveBundle(null, null);
  });

  afterEach(() => {
    nav.restore();
    vi.unstubAllGlobals();
    vi.resetModules();
    window.history.replaceState({}, "", "/");
  });

  it("Back goes to the Recordings page in this tab, from a tab with no history", async () => {
    // No `pushState` before this: the editor is the first page in its tab
    // whenever the popup or a finished recording opened it. That is the
    // case `history.back()` would silently do nothing in, and the reason
    // this control navigates to a named page instead — so the test that
    // guards it has to be the one with nothing behind it.
    window.history.replaceState({}, "", "/editor.html?scene=s1");
    await import("../../../pages/entrypoints/editor/main");
    (document.querySelector("#back") as HTMLButtonElement).click();

    // Asynchronous since Back waits for the session's writes; with none
    // owed, the wait is one turn.
    await vi.waitFor(() => {
      if (nav.assigned.length === 0) throw new Error("not navigated yet");
    });
    expect(nav.assigned).toEqual(["/"]);
  });

  it("says so on the page when Back's navigation is refused", async () => {
    window.history.replaceState({}, "", "/editor.html?scene=s1");
    nav.failAssignWith(new Error("assign broke, distinctive-marker-8"));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await import("../../../pages/entrypoints/editor/main");
      // Throws inside the listener without the guard: jsdom reports it and
      // the click returns as though nothing happened.
      (document.querySelector("#back") as HTMLButtonElement).click();
      // Premise: the navigation was attempted, and refused. Waited for,
      // since Back first lets the session's queued writes land.
      await vi.waitFor(() => {
        if (nav.assigned.length === 0) throw new Error("not attempted yet");
      });
      expect(nav.assigned).toEqual(["/"]);
      await vi.waitFor(() => {
        const box = document.querySelector("[data-navigation-error]");
        if (!box?.textContent?.includes("distinctive-marker-8"))
          throw new Error(
            `not shown: ${document.getElementById("failure")?.textContent}`,
          );
      });
      expect(
        document.querySelector("[data-navigation-error]")?.textContent,
      ).toContain("The Recordings page did not open");
    } finally {
      errorSpy.mockRestore();
    }
  });

  /** Loads the page, then commits a rename the way a blur does. */
  async function renameThenBack(name: string): Promise<void> {
    window.history.replaceState({}, "", "/editor.html?scene=s1");
    await import("../../../pages/entrypoints/editor/main");
    const field = await vi.waitFor(() => {
      const input = document.querySelector("#name") as HTMLInputElement | null;
      if (!input?.value) throw new Error("not loaded yet");
      return input;
    });
    field.value = name;
    field.dispatchEvent(new Event("change"));
    (document.querySelector("#back") as HTMLButtonElement).click();
  }

  /**
   * The blur that pressed Back is the one that committed the new name, and
   * that rename is queued on the session's lane, not yet sent. Leaving in
   * the same task dropped it without a word. Verified failable: navigating
   * straight from the click handler, as before, fails the first
   * `nav.assigned` assertion.
   */
  it("Back waits for a rename the same click committed", async () => {
    let answerPut: (reply: unknown) => void = () => undefined;
    memory.answer(
      "scenes.put",
      () =>
        new Promise((resolve) => {
          answerPut = resolve;
        }),
    );
    await renameThenBack("Checkout, renamed");
    await vi.waitFor(() => {
      if (memory.putCalls().length === 0) {
        throw new Error("rename not sent yet");
      }
    });
    // Premise: the rename is really the write in flight.
    const put = memory.putCalls()[0] as {
      scene?: { meta?: { name?: string } };
    };
    expect(put.scene?.meta?.name).toBe("Checkout, renamed");
    expect(nav.assigned).toEqual([]);

    answerPut({ revision: "r1" });
    await vi.waitFor(() => {
      if (nav.assigned.length === 0) throw new Error("not navigated yet");
    });
    expect(nav.assigned).toEqual(["/"]);
  });

  /**
   * A rename refused in the wait keeps the author on the page that says so,
   * rather than carrying them to a library showing the old name with
   * nothing to explain it. Verified failable: dropping the `last?.error`
   * check navigates and fails the `toEqual([])`.
   */
  it("Back stays, and says why, when that rename is refused", async () => {
    memory.answer("scenes.put", async () => {
      throw new Error("the store refused it, distinctive-marker-b7");
    });
    await renameThenBack("Checkout, renamed");
    await vi.waitFor(() => {
      const failure = document.querySelector("#failure")?.textContent ?? "";
      if (!failure.includes("distinctive-marker-b7")) {
        throw new Error(`failure not shown yet: ${JSON.stringify(failure)}`);
      }
    });
    // A turn for a navigation that should not come.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(nav.assigned).toEqual([]);
  });

  it("Delete confirms, sends demo:delete for this scene, and opens the library on success", async () => {
    window.history.replaceState({}, "", "/editor.html?scene=s1");
    confirmDialog.ask.mockReset().mockResolvedValue(true);
    memory.answer("scenes.remove", async () => ({
      ok: true,
      result: { ok: true, steps: [] },
    }));
    await import("../../../pages/entrypoints/editor/main");
    (document.querySelector("#delete") as HTMLButtonElement).click();
    await vi.waitFor(() => {
      if (nav.assigned.length === 0) throw new Error("library not opened yet");
    });
    expect(
      memory.calls.some(
        (c) =>
          c.member === "scenes" && c.method === "remove" && c.args[0] === "s1",
      ),
    ).toBe(true);
    // In THIS tab. It used to be `chrome.tabs.create` plus `window.close()`,
    // which stopped being correct once the Recordings page began opening
    // the editor in place: `window.close()` is refused for a tab the page
    // did not open, so that pairing left the author on a deleted demo with
    // a second Recordings tab behind it.
    // No `note` in this reply, so the URL is the bare Recordings page.
    expect(nav.assigned.at(-1)).toBe("/");
  });

  // Final review I1. On the studio, a delete's reply can carry a note — a
  // folder it could not remove, a stale export lock it cleared.
  describe("a delete whose reply carries a note (the Studio)", () => {
    const NOTE = "Cleared a stale export lock left by process 42.";
    beforeEach(() => {
      memory.answer("scenes.remove", async () => ({
        ok: true as const,
        note: NOTE,
      }));
      window.history.replaceState({}, "", "/editor.html?scene=s1");
      confirmDialog.ask.mockReset().mockResolvedValue(true);
    });

    it("carries the note to the Recordings page", async () => {
      await import("../../../pages/entrypoints/editor/main");
      (document.querySelector("#delete") as HTMLButtonElement).click();
      await vi.waitFor(() => {
        if (nav.assigned.length === 0) throw new Error("library not opened");
      });
      // Red: open the library without the note (`openLibrary(…)` with no
      // second argument) — the URL is the bare library page.
      const url = new URL(nav.assigned.at(-1) ?? "", "http://x.invalid");
      expect(url.pathname).toBe("/");
      expect(url.searchParams.get("note")).toBe(
        `This demo was deleted. ${NOTE}`,
      );
      // Premise: the delete went through the platform, once.
      expect(
        memory.calls.filter(
          (c) => c.member === "scenes" && c.method === "remove",
        ),
      ).toHaveLength(1);
    });

    it("says the note before a refused navigation's reason", async () => {
      nav.failAssignWith(new Error("assign broke"));
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        await import("../../../pages/entrypoints/editor/main");
        (document.querySelector("#delete") as HTMLButtonElement).click();
        await vi.waitFor(() => {
          const text =
            document.querySelector("[data-navigation-error]")?.textContent ??
            "";
          if (!text.includes(`This demo was deleted. ${NOTE} assign broke`))
            throw new Error(`not shown: ${text}`);
        });
      } finally {
        errorSpy.mockRestore();
      }
    });
  });

  it("Delete asks the shipped question, and sends nothing on Cancel", async () => {
    window.history.replaceState({}, "", "/editor.html?scene=s1");
    const { DELETE_DEMO } = await import(
      "../../../pages/src/shell/confirm-dialog"
    );
    confirmDialog.ask.mockReset().mockResolvedValue(false);
    memory.answer("scenes.remove", async () => ({
      ok: true,
      result: { ok: true, steps: [] },
    }));
    await import("../../../pages/entrypoints/editor/main");
    (document.querySelector("#delete") as HTMLButtonElement).click();
    await vi.waitFor(() => {
      if (confirmDialog.ask.mock.calls.length === 0) {
        throw new Error("not asked yet");
      }
    });
    expect(confirmDialog.ask).toHaveBeenCalledWith(DELETE_DEMO);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(
      memory.calls.some((c) => c.member === "scenes" && c.method === "remove"),
    ).toBe(false);
    expect(nav.assigned).toEqual([]);
  });

  it("Delete says nothing was deleted when its question could not open", async () => {
    window.history.replaceState({}, "", "/editor.html?scene=s1");
    confirmDialog.ask
      .mockReset()
      .mockRejectedValue(new Error("dialog refused"));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    memory.answer("scenes.remove", async () => ({
      ok: true,
      result: { ok: true, steps: [] },
    }));
    try {
      await import("../../../pages/entrypoints/editor/main");
      (document.querySelector("#delete") as HTMLButtonElement).click();
      await vi.waitFor(() => {
        if (
          !(document.querySelector("#failure")?.textContent ?? "").includes(
            "Not deleted: the confirmation could not open — dialog refused.",
          )
        ) {
          throw new Error("failure not shown yet");
        }
      });
      expect(
        memory.calls.some(
          (c) => c.member === "scenes" && c.method === "remove",
        ),
      ).toBe(false);
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("Delete reports a refusal in the author's words and stays on the page", async () => {
    window.history.replaceState({}, "", "/editor.html?scene=s1");
    confirmDialog.ask.mockReset().mockResolvedValue(true);
    memory.answer("scenes.remove", async () => ({
      ok: false,
      error: "rendering",
    }));
    await import("../../../pages/entrypoints/editor/main");
    (document.querySelector("#delete") as HTMLButtonElement).click();
    await vi.waitFor(() => {
      if (
        !/render is running/.test(
          document.querySelector("#failure")?.textContent ?? "",
        )
      ) {
        throw new Error("refusal not shown yet");
      }
    });
    expect(nav.assigned).toEqual([]);
  });

  it("Delete reports a partial delete and never says Deleted", async () => {
    window.history.replaceState({}, "", "/editor.html?scene=s1");
    confirmDialog.ask.mockReset().mockResolvedValue(true);
    memory.answer("scenes.remove", async () => ({
      ok: true,
      result: {
        ok: false,
        steps: [
          { step: "bundles", ok: true, error: null },
          { step: "statuses", ok: false, error: "closed" },
        ],
      },
    }));
    await import("../../../pages/entrypoints/editor/main");
    (document.querySelector("#delete") as HTMLButtonElement).click();
    const text = await vi.waitFor(() => {
      const t = document.querySelector("#failure")?.textContent ?? "";
      if (!/Partly deleted: statuses/.test(t)) {
        throw new Error("partial result not shown yet");
      }
      return t;
    });
    expect(nav.assigned).toEqual([]);
    // The one sentence this page must never say for a partial delete.
    expect(text).not.toMatch(/^Deleted\b/);
    expect(text).not.toContain("Deleted");
  });

  // FINDING 7 (whole-branch review). The post-delete navigation sat in a
  // `void (async …)()` with no handler. On an extension page an uncaught
  // error lands on the chrome://extensions Errors list, and the author —
  // who just watched the delete succeed — sees what looks like a crash for
  // a demo that is already gone.
  //
  // The navigation became `location.assign` on 2026-09-21, which THROWS
  // where `chrome.tabs.create` rejected. Same requirement, different catch:
  // this drives the synchronous throw, so a `.catch(…)` written in place of
  // the `try` would fail here rather than pass by looking similar.
  it("handles a refused post-delete navigation instead of leaving it unhandled", async () => {
    window.history.replaceState({}, "", "/editor.html?scene=s1");
    confirmDialog.ask.mockReset().mockResolvedValue(true);
    memory.answer("scenes.remove", async () => ({
      ok: true,
      result: { ok: true, steps: [] },
    }));
    nav.failAssignWith(new Error("assign broke, distinctive-marker-7"));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);

    try {
      await import("../../../pages/entrypoints/editor/main");
      (document.querySelector("#delete") as HTMLButtonElement).click();
      await vi.waitFor(() => {
        if (
          !errorSpy.mock.calls.some((args) =>
            args.some((a) => String(a).includes("assign broke")),
          )
        ) {
          throw new Error("not reported yet");
        }
      });
      // One more turn of the microtask/macrotask queue: an unhandled
      // rejection event fires asynchronously, after the promise settles.
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(unhandled).toEqual([]);
      // And the author reads it, not only the Errors list.
      await vi.waitFor(() => {
        const text =
          document.querySelector("[data-navigation-error]")?.textContent ?? "";
        if (!text.includes("This demo was deleted. assign broke"))
          throw new Error(`not shown: ${text}`);
      });
    } finally {
      process.off("unhandledRejection", onUnhandled);
      errorSpy.mockRestore();
    }
  });
});

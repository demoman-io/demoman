import type { SceneDocument } from "@demoman/scene-schema";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createMemoryPlatform,
  type MemoryPlatform,
} from "../helpers/memory-platform";

/**
 * A rename typed on a Recordings card has to reach the store the way an
 * editor rename does — read the take, write it back through
 * `platform.scenes.put` with the revision it read — and a refused write has
 * to say so on the row rather than leave the new name sitting in a field
 * nothing saved. The real entrypoint over the memory platform, every lookup
 * re-querying the CURRENT row because `renderLibrary` replaces the row on
 * each render.
 *
 * Moved from apps/extension on 2026-10-20, where it ran over a faked
 * `chrome.runtime` (`scene:get`, `scene:put`, `demo:delete`).
 */

const state = vi.hoisted(() => ({ memory: null as MemoryPlatform | null }));
// The real module's other exports stay; only the platform is the memory one.
vi.mock("#platform", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  createPlatform: () => state.memory,
}));

const confirmDialog = vi.hoisted(() => ({
  ask: vi.fn<(question: unknown) => Promise<boolean>>(),
}));
vi.mock("../../../pages/src/shell/confirm-dialog", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  askToConfirm: (question: unknown) => confirmDialog.ask(question),
}));

function mountLibraryDom(): void {
  document.body.innerHTML = `
    <div id="notice" class="hidden" role="alert"></div>
    <main id="root"></main>
  `;
}

/** The one take on the page, as little of a scene as the library reads. */
const take = (): SceneDocument =>
  ({
    meta: {
      id: "a",
      name: "Checkout",
      createdAt: "2026-09-01T00:00:00Z",
      capture: { originUrl: "https://app.test/x" },
    },
  }) as unknown as SceneDocument;

async function currentField(): Promise<HTMLInputElement> {
  return vi.waitFor(() => {
    const field = document.querySelector('[data-row="a"] [data-name]');
    if (!field) throw new Error("row not rendered yet");
    return field as HTMLInputElement;
  });
}

async function typeName(name: string): Promise<void> {
  const field = await currentField();
  field.value = name;
  field.dispatchEvent(new Event("change", { bubbles: true }));
}

async function waitForStatus(
  predicate: (text: string | null) => boolean,
): Promise<string | null> {
  return vi.waitFor(() => {
    const el = document.querySelector('[data-row="a"] [data-status]');
    const text = el?.textContent ?? null;
    if (!predicate(text)) {
      throw new Error(
        `status not yet matching — currently ${JSON.stringify(text)}`,
      );
    }
    return text;
  });
}

describe("library main — a rename on the card reaches the store, or says why not", () => {
  let memory: MemoryPlatform;

  beforeEach(() => {
    vi.resetModules();
    mountLibraryDom();
    memory = createMemoryPlatform({ scenes: [take()] });
    state.memory = memory;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it("writes the renamed take through scenes.put and shows the new name after the re-render", async () => {
    await import("../../../pages/entrypoints/library/main");
    await typeName("Signup flow");

    await vi.waitFor(() => {
      const put = memory.putCalls()[0];
      if (!put) throw new Error("no write yet");
      expect(put.scene.meta.name).toBe("Signup flow");
      // The rest of the document travels untouched.
      expect(put.scene.meta.id).toBe("a");
      // Written against the revision it read, so the studio can refuse a
      // write that raced another window's.
      expect(put.revision).toBe("r1");
    });
    await vi.waitFor(async () => {
      expect((await currentField()).value).toBe("Signup flow");
    });
    expect(document.querySelector('[data-row="a"] [data-status]')).toBeNull();
  });

  it("says a refused write on the row, with the Studio's reason, and puts the old name back", async () => {
    memory.answer("scenes.put", async () => {
      throw new Error("the take is being rendered");
    });
    await import("../../../pages/entrypoints/library/main");
    await typeName("Signup flow");

    const status = await waitForStatus((t) => t !== null && t.length > 0);
    expect(status).toBe("Couldn't rename: the take is being rendered.");
    expect((await currentField()).value).toBe("Checkout");
  });

  it("says so on the row when the read itself throws, and puts the old name back", async () => {
    // The call rejecting — the studio gone. `reportError` alone left the
    // field showing a name nothing saved (review finding, 2026-09-14).
    memory.answer("scenes.get", async () => {
      throw new Error("The Studio did not answer (Failed to fetch).");
    });
    await import("../../../pages/entrypoints/library/main");
    await typeName("Signup flow");

    const status = await waitForStatus((t) => t !== null && t.length > 0);
    expect(status).toMatch(/^Couldn't rename: /);
    expect(status).toContain("The Studio did not answer");
    expect((await currentField()).value).toBe("Checkout");
  });

  it("lets a delete on the same card wait for the rename its click committed", async () => {
    // Mousedown on Delete blurs the field, which commits the rename; the
    // delete must not run between that rename's read and its write, or the
    // write re-creates a take the delete just removed.
    const order: string[] = [];
    // The read answers late, so the rename is still between its read and
    // its write when Delete is clicked — the shape the confirm dialog gives
    // it for real.
    memory.answer(
      "scenes.get",
      () =>
        new Promise((resolve) =>
          setTimeout(() => resolve({ scene: take(), revision: "r1" }), 20),
        ),
    );
    memory.answer("scenes.put", async () => {
      order.push("put");
      return { revision: "r2" };
    });
    memory.answer("scenes.remove", async () => {
      order.push("remove");
      return { ok: true };
    });
    confirmDialog.ask.mockReset().mockResolvedValue(true);
    await import("../../../pages/entrypoints/library/main");
    await typeName("Signup flow");
    const row = document.querySelector('[data-row="a"]') as HTMLElement;
    (row.querySelector('[data-action="delete"]') as HTMLButtonElement).click();

    await vi.waitFor(() => {
      if (!order.includes("remove")) throw new Error("no delete yet");
    });
    expect(order).toEqual(["put", "remove"]);
  });

  it("says when the take could not be read back before the write", async () => {
    memory.answer("scenes.get", async () => null);
    await import("../../../pages/entrypoints/library/main");
    await typeName("Signup flow");

    const status = await waitForStatus((t) => t !== null && t.length > 0);
    expect(status).toBe("Couldn't rename: the take is no longer stored.");
    expect(memory.putCalls()).toEqual([]);
  });
});

// apps/studio/test/pages/node/library-main-back.test.ts
import type { FrameBundle } from "@demoman/compositor";
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
 * "Back to your recording" on a Recordings card: the write that flips the
 * take to its capture frames, and the question that follows it — which
 * frames are now served. The write landing is not the answer.
 */

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

// The Needs a look flags' read. No take here is flagged; the files that
// are about the flag drive this themselves (library-main-open.test.ts).
async function control(action: string): Promise<HTMLButtonElement> {
  return vi.waitFor(() => {
    const node = document.querySelector(`[data-action="${action}"]`);
    if (!node) throw new Error(`no ${action} control rendered yet`);
    return node as HTMLButtonElement;
  });
}

describe("library main — back to your recording", () => {
  let memory: MemoryPlatform;
  let info: ReturnType<typeof vi.spyOn>;
  let error: ReturnType<typeof vi.spyOn>;

  const stored = {
    meta: {
      id: SCENE_ID,
      name: "Checkout",
      createdAt: "2026-09-01T00:00:00Z",
      renderMode: "demo",
      capture: { originUrl: "https://app.test/x", mode: "record" },
    },
  };

  beforeEach(() => {
    vi.resetModules();
    mountLibraryDom();
    memory = createMemoryPlatform({
      scenes: [stored as unknown as SceneDocument],
    });
    state.memory = memory;
    info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    error = vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it("the fixture offers the control (its premise)", async () => {
    memory.serveBundle(null);
    await import("../../../pages/entrypoints/library/main");
    expect(await control("back-to-recording")).toBeTruthy();
  });

  it("goes back to the recording, and asks which frames are now served", async () => {
    memory.serveBundle({
      source: "capture",
      keyframes: [],
    } as unknown as FrameBundle);
    await import("../../../pages/entrypoints/library/main");
    (await control("back-to-recording")).click();
    await vi.waitFor(() => {
      const put = memory.putCalls()[0];
      expect(put?.scene.meta.renderMode).toBe("screen");
    });
    await vi.waitFor(() => {
      const asked = memory.calls.filter(
        (c) => c.member === "bundles" && c.method === "active",
      );
      expect(asked.length).toBeGreaterThan(0);
    });
    // The sentence must be absent after the whole round trip, not before it.
    await vi.waitFor(() =>
      expect(
        memory.calls.filter((c) => c.member === "folder" && c.method === "read")
          .length,
      ).toBeGreaterThan(1),
    );
    expect(document.body.textContent).not.toContain(
      "no recording of this take",
    );
    expect(document.body.textContent).not.toContain("could not be put back");
    expect(error).not.toHaveBeenCalled();
  });

  it("says there is no recording to go back to", async () => {
    memory.serveBundle({
      source: "replay",
      keyframes: [],
    } as unknown as FrameBundle);
    await import("../../../pages/entrypoints/library/main");
    (await control("back-to-recording")).click();
    await vi.waitFor(() =>
      expect(document.body.textContent).toContain(
        "There is no recording of this take to go back to",
      ),
    );
    // An expected outcome that owes a reason: info, never warn or error.
    expect(info).toHaveBeenCalledWith(
      expect.stringContaining("serving replay"),
    );
    expect(error).not.toHaveBeenCalled();
  });

  it("says when no frames could be read at all", async () => {
    memory.serveBundle(null);
    await import("../../../pages/entrypoints/library/main");
    (await control("back-to-recording")).click();
    await vi.waitFor(() =>
      expect(document.body.textContent).toContain(
        "Your recording could not be put back: no frames could be read",
      ),
    );
  });

  it("says a refused frame read on the card", async () => {
    memory.answer("bundles.active", async () => {
      throw new Error("idb refused");
    });
    await import("../../../pages/entrypoints/library/main");
    (await control("back-to-recording")).click();
    await vi.waitFor(() =>
      expect(document.body.textContent).toContain("idb refused"),
    );
    expect(error).toHaveBeenCalled();
  });

  /**
   * Final review I2. Back reads the scene and writes it across two awaits,
   * so a rename the same card committed (its put still in flight) either
   * lands after Back's write — and brings `demo` back with it, after Back
   * said it had gone — or loses its own name to Back's. Back waits for the
   * rename, as Delete, Edit and Restore do. Goes red without the `await
   * renaming.get(sceneId)` at the top of `backToRecording`.
   */
  it("waits for a rename in flight on the same card", async () => {
    let held: typeof stored | undefined;
    let current: typeof stored = stored;
    let answerRename: (reply: unknown) => void = () => undefined;
    const puts: Array<{ meta: { name: string; renderMode: string } }> = [];
    memory.serveScene(() => current as unknown as SceneDocument);
    memory.answer("scenes.put", async (doc: SceneDocument) => {
      const scene = doc as unknown as typeof stored;
      if (held === undefined) {
        // The rename's put: it lands only when the test lets it.
        held = scene;
        return new Promise((resolve) => {
          answerRename = (reply) => {
            current = scene;
            puts.push(scene);
            resolve(reply);
          };
        });
      }
      current = scene;
      puts.push(scene);
      return { revision: `r${puts.length + 1}` };
    });
    memory.serveBundle({
      source: "capture",
      keyframes: [],
    } as unknown as FrameBundle);
    await import("../../../pages/entrypoints/library/main");
    const field = await vi.waitFor(() => {
      const node = document.querySelector<HTMLInputElement>("[data-name]");
      if (!node) throw new Error("no name field rendered yet");
      return node;
    });
    field.value = "Checkout, renamed";
    field.dispatchEvent(new Event("change", { bubbles: true }));
    (await control("back-to-recording")).click();
    await vi.waitFor(() => {
      if (held === undefined) throw new Error("rename not sent yet");
    });
    // The premise: the rename is the put in flight, and it carries `demo`.
    expect(held).toMatchObject({
      meta: { name: "Checkout, renamed", renderMode: "demo" },
    });

    answerRename({ revision: "r2" });
    await vi.waitFor(() => {
      if (puts.length < 2) {
        throw new Error(`puts so far: ${JSON.stringify(puts)}`);
      }
    });
    await vi.waitFor(() =>
      expect(
        memory.calls.filter(
          (c) => c.member === "bundles" && c.method === "active",
        ).length,
      ).toBeGreaterThan(0),
    );
    expect(puts.length, JSON.stringify(puts)).toBe(2);
    expect(current.meta, JSON.stringify(puts)).toMatchObject({
      name: "Checkout, renamed",
      renderMode: "screen",
    });
  });

  // A refused rename has said so on the row; Back succeeding afterwards
  // must not wipe that sentence. Goes red if Back clears the row status on
  // success regardless of the rename it waited for.
  it("keeps a refused rename's reason on the row when Back then succeeds", async () => {
    let puts = 0;
    memory.answer("scenes.put", async () => {
      puts += 1;
      if (puts === 1) throw new Error("refused, distinctive-marker-r2");
      return { revision: `r${puts}` };
    });
    memory.serveBundle({
      source: "capture",
      keyframes: [],
    } as unknown as FrameBundle);
    await import("../../../pages/entrypoints/library/main");
    const field = await vi.waitFor(() => {
      const node = document.querySelector<HTMLInputElement>("[data-name]");
      if (!node) throw new Error("no name field rendered yet");
      return node;
    });
    field.value = "Checkout, renamed";
    field.dispatchEvent(new Event("change", { bubbles: true }));
    (await control("back-to-recording")).click();
    // Back's own put went out, so Back ran after the refusal.
    await vi.waitFor(() => expect(puts).toBe(2));
    await vi.waitFor(() =>
      expect(
        memory.calls.filter((c) => c.member === "folder" && c.method === "read")
          .length,
      ).toBeGreaterThan(2),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(document.querySelector("[data-status]")?.textContent).toContain(
      "distinctive-marker-r2",
    );
  });

  it("says a refused write on the card", async () => {
    memory.answer("scenes.put", async () => {
      throw new Error("quota");
    });
    memory.serveBundle(null);
    await import("../../../pages/entrypoints/library/main");
    (await control("back-to-recording")).click();
    await vi.waitFor(() =>
      expect(document.body.textContent).toContain("quota"),
    );
    // A refused write must not go on to ask, and then report, what frames
    // are served: a null bundle would say "could not be put back" too.
    expect(document.body.textContent).not.toContain("could not be put back");
  });
});

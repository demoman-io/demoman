import { madeFromOf } from "@demoman/compositor";
import type { SceneDocument } from "@demoman/scene-schema";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { proceduralBundle } from "../../../../../packages/replay-engine/test/helpers/bundles";
import { readonlyScene } from "../../../../../packages/replay-engine/test/helpers/scenes";
import { editorDom } from "../helpers/editor-dom";
import {
  createMemoryPlatform,
  type MemoryPlatform,
} from "../helpers/memory-platform";

const state = vi.hoisted(() => ({ memory: null as MemoryPlatform | null }));
// The real module's other exports (the studio's own copy, such as
// `refilmLine`) stay; only the platform the page builds is the memory one.
vi.mock("#platform", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  createPlatform: () => state.memory,
}));

/**
 * The inspector as `main.ts` actually wires it, rather than as
 * `editor-inspector.test.ts` calls it.
 *
 * That file hands `renderInspector` a bag of `vi.fn()`s and pins which one a
 * control calls with what. It cannot see whether `main.ts` connected that
 * handler to anything: an `onMove` wired to nothing, or a `selectedId` left
 * pointing at a step that has just been deleted, passes every assertion
 * there and is broken on screen. This file boots the real module.
 */

// jsdom does not implement `scrollIntoView` at all — `main.ts`'s
// `onNoticeRoute` calls it once a replacement route lands on a step, which
// throws `TypeError: … .scrollIntoView is not a function` uncaught, since
// the click handler that calls it runs outside any promise a test awaits.
// A no-op stub is the standard jsdom workaround. Left in place even though
// no test in this file reaches a landed replacement any more (`frozenRoutes`
// always hands the route a null anchor, so this file's own case dead-ends
// before reaching `scrollIntoView` — see the note above this file's one
// surviving route test): a scene elsewhere in this suite that DOES carry an
// action with a literal `anchorId: null` reaches the same call, and an
// unguarded page throwing there is exactly the silent failure this stub
// exists to prevent.
Element.prototype.scrollIntoView ??= () => {};

vi.mock("@demoman/compositor", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@demoman/compositor")>();
  return {
    ...actual,
    // Real motion detection and a real hover check would read a frame store
    // jsdom does not have. Neither is what this file tests.
    // Plain functions, not `vi.fn().mockResolvedValue([])`: this file's
    // `afterEach` calls `vi.restoreAllMocks()`, which strips the resolved
    // value off a module-factory `vi.fn()` for good. From the second test on,
    // `hoverVerdicts` answered `undefined`, `summarizeHoverVerdicts` threw on
    // it, and every test after the first ran the editor's hover-check FAILURE
    // path with a `console.error` on the page. A plain async function has
    // nothing for `restoreAllMocks` to take away. Nothing here asserts on
    // either spy.
    detectKeyframeMotion: async () => [],
    hoverVerdicts: async () => [],
  };
});

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

// Matches `zoomedScene()` — this file's default `scene:get` reply, and every
// override that only touches `anchors`/`edits`/`camera` rather than
// `actions` — so the frames read as verifiable and the approximations path
// this file does not test stays off the console.
const MADE_FROM = madeFromOf(zoomedScene());

/** `readonlyScene` with a zoom on its last action, so the lead-in field is
 *  rendered when act-3 is selected. */
function zoomedScene(): SceneDocument {
  const scene = readonlyScene();
  return {
    ...scene,
    camera: [
      {
        id: "cam-1",
        kind: "zoom" as const,
        anchorId: "a-checkout",
        marker: { actionId: "act-3", offsetMs: -350 },
        scale: 1.6,
      },
    ],
  };
}

describe("editor main — the inspector, wired", () => {
  let memory: MemoryPlatform;

  /** See `editor-main-keyboard.test.ts`: `document` outlives
   *  `vi.resetModules()`, so a previous test's keydown listener would still
   *  be attached and acting on its own `selectedId`. */
  const documentListeners: [string, EventListenerOrEventListenerObject][] = [];

  const boot = async (): Promise<void> => {
    await import("../../../pages/entrypoints/editor/main");
    await vi.waitFor(() => {
      if (!document.querySelector('[data-tick="act-1"]')) {
        throw new Error("timeline not rendered yet");
      }
    });
  };

  const puts = () => memory.putCalls();

  const select = (actionId: string): void => {
    (
      document.querySelector(`[data-tick="${actionId}"]`) as HTMLElement
    ).click();
  };

  beforeEach(() => {
    vi.resetModules();
    editorDom();
    const addListener = document.addEventListener.bind(document);
    vi.spyOn(document, "addEventListener").mockImplementation(
      (type, listener, options) => {
        if (listener) documentListeners.push([type, listener]);
        addListener(type, listener, options);
      },
    );
    vi.stubGlobal("OffscreenCanvas", FakeOffscreenCanvas);
    memory = createMemoryPlatform();
    state.memory = memory;
    memory.serveScene(() => zoomedScene());
    memory.serveBundle(
      proceduralBundle({ motionSpans: [], madeFrom: MADE_FROM }),
      null,
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
    for (const [type, listener] of documentListeners.splice(0)) {
      document.removeEventListener(type, listener);
    }
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  // Spec 2026-10-22 split-tool: nothing an author made changes without a
  // word. A take whose reading took text overlays away says so.
  it("says what reading the take took away from it, in the take's notes", async () => {
    const note =
      "1 text overlay was removed from this take: the video shows the text that was recorded.";
    memory.serveScene(() => zoomedScene(), "r0", [note]);
    await boot();
    const notes = [...document.querySelectorAll("[data-take-notice]")].map(
      (n) => n.textContent,
    );
    expect(notes).toContain(note);
  });

  it("says the video shows the filmed text when a typed step's text was changed", async () => {
    const retyped = zoomedScene();
    retyped.actions = retyped.actions.map((a) =>
      a.id === "act-1" && a.kind === "type" ? { ...a, text: "Maple" } : a,
    );
    // Premise: the frames typed something else into act-1.
    expect(MADE_FROM.find((m) => m.actionId === "act-1")?.text).not.toBe(
      "Maple",
    );
    memory.serveScene(() => retyped);
    await boot();
    const notes = [...document.querySelectorAll("[data-take-notice]")].map(
      (n) => n.textContent,
    );
    expect(notes).toContain(
      "The video shows the text that was recorded; re-record to type the new text.",
    );
  });

  it("says nothing of filmed text on a take whose text matches its frames", async () => {
    await boot();
    expect(document.body.textContent).not.toContain(
      "the text that was recorded",
    );
  });

  // Spec 2026-10-22 split-tool, through the real page: ⌘B, select, Delete,
  // and the join's click.
  it("splits on ⌘B, removes the selected piece on Delete, and restores it from its join", async () => {
    await boot();
    const key = (k: string, init: KeyboardEventInit = {}) =>
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: k, bubbles: true, ...init }),
      );
    // Off the take's start, where a split splits nothing.
    for (let i = 0; i < 4; i += 1) key("ArrowRight", { shiftKey: true });
    key("b", { metaKey: true });
    await vi.waitFor(() => {
      if (puts().length < 1) throw new Error("no split written yet");
    });
    expect(puts().at(-1)?.scene.edits.splits).toHaveLength(1);

    const pieces = await vi.waitFor(() => {
      const found = document.querySelectorAll<HTMLElement>("[data-piece]");
      if (found.length !== 2) throw new Error(`${found.length} pieces`);
      return found;
    });
    pieces[1]?.click();
    key("Delete");
    await vi.waitFor(() => {
      if (puts().length < 2) throw new Error("no removal written yet");
    });
    const removed = puts().at(-1)?.scene.edits.removed ?? [];
    expect(removed).toHaveLength(1);
    expect(removed[0]?.end).toBeNull();

    const join = await vi.waitFor(() => {
      const found = document.querySelector<HTMLElement>(
        `[data-join="${removed[0]?.id}"]`,
      );
      if (found === null) throw new Error("no join drawn yet");
      return found;
    });
    // The dot opens a card; it does not restore by itself.
    join.click();
    const card = await vi.waitFor(() => {
      const found = document.querySelector<HTMLElement>(
        `[data-join-card="${removed[0]?.id}"]`,
      );
      if (found === null) throw new Error("no card drawn yet");
      return found;
    });
    expect(puts()).toHaveLength(2);
    // Escape closes it, and a press elsewhere closes it too.
    key("Escape");
    expect(document.querySelector("[data-join-card]")).toBeNull();
    join.click();
    expect(document.querySelector("[data-join-card]")).not.toBeNull();
    document.body.dispatchEvent(
      new PointerEvent("pointerdown", { bubbles: true }),
    );
    expect(document.querySelector("[data-join-card]")).toBeNull();
    expect(card.isConnected).toBe(false);

    document
      .querySelector<HTMLElement>(`[data-join="${removed[0]?.id}"]`)
      ?.click();
    document
      .querySelector<HTMLElement>(`[data-restore="${removed[0]?.id}"]`)
      ?.click();
    await vi.waitFor(() => {
      if (puts().length < 3) throw new Error("no restore written yet");
    });
    expect(puts().at(-1)?.scene.edits.removed).toEqual([]);
    expect(document.querySelector("[data-join-card]")).toBeNull();
  });

  // Review 2026-10-22: a selection keyed by output position passed to the
  // next piece, which closes up onto the same instant, so a second Delete
  // removed a piece nobody selected.
  it("a second Delete after removing a piece removes nothing more", async () => {
    await boot();
    const key = (k: string, init: KeyboardEventInit = {}) =>
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: k, bubbles: true, ...init }),
      );
    for (let n = 1; n <= 2; n += 1) {
      for (let i = 0; i < 4; i += 1) key("ArrowRight", { shiftKey: true });
      key("b", { metaKey: true });
      await vi.waitFor(() => {
        if (puts().length < n) throw new Error(`split ${n} not written yet`);
      });
    }
    const pieces = await vi.waitFor(() => {
      const found = document.querySelectorAll<HTMLElement>("[data-piece]");
      if (found.length !== 3) throw new Error(`${found.length} pieces`);
      return found;
    });
    pieces[1]?.click();
    key("Delete");
    await vi.waitFor(() => {
      if (puts().length < 3) throw new Error("no removal written yet");
    });
    expect(puts().at(-1)?.scene.edits.removed).toHaveLength(1);
    // Premise: the piece after the removed one now starts where it did.
    const after = await vi.waitFor(() => {
      const found = document.querySelectorAll<HTMLElement>("[data-piece]");
      if (found.length !== 2) throw new Error(`${found.length} pieces`);
      return found;
    });
    expect(after[1]?.getAttribute("data-piece")).toBe(
      pieces[1]?.getAttribute("data-piece"),
    );
    expect(document.querySelector("[data-piece][data-selected]")).toBeNull();

    key("Delete");
    await new Promise((r) => setTimeout(r, 0));
    expect(puts()).toHaveLength(3);
  });

  // Review 2026-10-22: Delete on a step used to do nothing and say nothing.
  it("says why Delete on a step removes nothing", async () => {
    await boot();
    select("act-2");
    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Delete", bubbles: true }),
    );
    await vi.waitFor(() => {
      const said = document.querySelector("[data-refusal]");
      if (said === null || (said as HTMLElement).hidden)
        throw new Error("no refusal shown");
    });
    expect(document.querySelector("[data-refusal]")?.textContent).toBe(
      "A step can't be deleted. To take it out of the video, split the clip around it and remove that piece.",
    );
    expect(puts()).toHaveLength(0);
  });

  it("does not steal the selection onto an existing zoom when addZoom is refused", async () => {
    // `zoomedScene()` already carries "cam-1" on act-3. Clicking "Zoom on
    // this step" for a DIFFERENT beat used to select `scene.camera.at(-1)`
    // unconditionally — on a refused dispatch the scene (and its camera
    // array) reverts untouched, so `.at(-1)` was still "cam-1", and the
    // selection silently jumped there instead of staying on the step the
    // author actually clicked.
    memory.answer("scenes.put", async () => {
      throw new Error("the store is full");
    });
    await boot();
    select("act-2");
    expect(
      document
        .querySelector("[data-step-panel]")
        ?.getAttribute("data-step-panel"),
    ).toBe("act-2");

    (
      document.querySelector('[data-zoom-on-step="act-2"]') as HTMLButtonElement
    ).click();

    await vi.waitFor(() => {
      if (!document.querySelector("#failure")?.textContent?.includes("full")) {
        throw new Error("the store's refusal has not surfaced yet");
      }
    });
    // Still act-2's own panel — not cam-1's zoom panel, and not the demo
    // panel either.
    expect(
      document
        .querySelector("[data-step-panel]")
        ?.getAttribute("data-step-panel"),
    ).toBe("act-2");
    expect(document.querySelector("[data-zoom-panel]")).toBeNull();
  });

  it("authors a pause from the inspector, and refuses a negative one", async () => {
    // The same shape as the lead-in above and for the same reason: the typed
    // field and the timeline drag end in one resolver, so a value one would
    // refuse is refused in the same words through the other.
    //
    // `input[type=number]` with `min="0"` refuses nothing — it stops the
    // spinner, not a keystroke — so `-500` really does arrive at the handler.
    // Until 2026-09-08 it went straight to `setGap` and came back as a Zod
    // path from `SceneDocumentSchema.parse`, which is a developer's error
    // message for an author's typo.
    await boot();
    select("act-1");
    const field = document.querySelector(
      'input[data-gap="act-1"]',
    ) as HTMLInputElement;
    field.value = "900";
    field.dispatchEvent(new Event("change"));
    const put = await vi.waitFor(() => {
      const found = puts()[0];
      if (!found) throw new Error("no scene:put yet");
      return found;
    });
    expect((put.scene as SceneDocument).edits.gaps[0]).toMatchObject({
      afterActionId: "act-1",
      durationMs: 900,
    });

    const again = document.querySelector(
      'input[data-gap="act-1"]',
    ) as HTMLInputElement;
    again.value = "-500";
    again.dispatchEvent(new Event("change"));
    const said = document.querySelector("[data-refusal]")?.textContent ?? "";
    expect(said).toMatch(/shorter than nothing/i);
    // In the author's words, not the schema's.
    expect(said).not.toMatch(/nonnegative|durationMs/);
    expect(puts()).toHaveLength(1);
  });

  // Spec 2026-10-22 split-tool: a step is a label, so Delete on one
  // writes nothing and the step stays.
  it("writes nothing when Delete is pressed on a selected step", async () => {
    await boot();
    select("act-1");
    // Premise: the step really is selected — its panel is open.
    expect(document.querySelector('[data-step-panel="act-1"]')).not.toBeNull();
    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Delete", bubbles: true }),
    );
    await Promise.resolve();
    expect(puts()).toHaveLength(0);
    expect(document.querySelector('[data-tick="act-1"]')).not.toBeNull();
  });
});

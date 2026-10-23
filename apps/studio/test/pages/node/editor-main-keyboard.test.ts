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
 * The timeline's keyboard, against the real `entrypoints/editor/main.ts`.
 *
 * The arrows step the selection between beats and Delete removes the
 * selected one — the two gestures that replaced the ↑/↓ buttons the old beat
 * list carried. Both are global listeners, which is exactly why the third
 * test here matters: a global arrow handler that did not stand down for a
 * focused text field would move the selection every time an author moved the
 * caret in a replacement, and Delete would eat the beat they were typing on.
 */

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
    // The rendered boot's bundle carries motion spans, and the real video
    // source decodes every one up front through `bundles.load` — the real
    // IndexedDB frame store, which jsdom does not have. That threw
    // `indexedDB is not defined` into `refreshHints` on every rendered test,
    // so each ran with the hover check in its FAILURE state. The spans stay
    // in the bundle (Shift+Delete's pause is measured against them); only
    // the decode is replaced, by the lazy image source, which loads nothing
    // until something draws.
    createVideoFrameSource: async (
      ...args: Parameters<typeof actual.createImageFrameSource>
    ) => actual.createImageFrameSource(...args),
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

const press = (
  key: string,
  target: EventTarget = document,
  init: KeyboardEventInit = {},
): void => {
  target.dispatchEvent(
    new KeyboardEvent("keydown", { key, bubbles: true, ...init }),
  );
};

/**
 * Whether the editor's own handler claimed the key.
 *
 * `preventDefault` is called exactly where the handler acts on a key, so a
 * cancelable event that comes back un-prevented is one the guard stood down
 * for. It is the only observable difference for Space on a button: the
 * browser's own activation of that button is what would fire twice, and
 * jsdom does not perform it.
 */
const pressCancelable = (
  key: string,
  target: EventTarget,
  init: KeyboardEventInit = {},
): boolean => {
  const event = new KeyboardEvent("keydown", {
    key,
    bubbles: true,
    cancelable: true,
    ...init,
  });
  target.dispatchEvent(event);
  return event.defaultPrevented;
};

/** `readonlyScene` with a zoom on its last action, so there is a segment on
 *  the Zoom lane to select and remove. */
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

/**
 * Which beat the inspector is showing, read off the step panel itself.
 *
 * NOT `[data-delete]`: Task 11 withholds that button entirely on an
 * already-cut step (the ledger's minor #4 — it used to render inert), so a
 * selection landing there would read back as null though the panel is very
 * much showing something. `[data-step-panel]` is present whenever a step is
 * selected, cut or not.
 */
const selected = (): string | null =>
  document
    .querySelector("[data-step-panel]")
    ?.getAttribute("data-step-panel") ?? null;

/**
 * Every test here boots the real `entrypoints/editor/main.ts` in jsdom.
 *
 * Measured with the file to itself: 946ms for the first (it pays for the
 * module graph) and 38-115ms for each one after. Under a full `pnpm test`,
 * with the browser and integration projects running beside it, that first
 * one has crossed vitest's 5s default twice on this machine — and once it
 * times out the editor it left running goes on answering keys for the next
 * test, which then deletes the wrong beat. CLAUDE.md's note about the CI
 * runner being ~5x slower makes that a shape CI reports rather than a local
 * curiosity. 20s is headroom, not a measured need.
 */
describe("editor main — stepping and deleting from the keyboard", () => {
  let memory: MemoryPlatform;

  /**
   * `document` outlives `vi.resetModules()`, so a keydown listener a
   * previous test's copy of `main.ts` registered is still attached when the
   * next test imports a fresh one — and both would then act on the same key,
   * each with its own `selectedId`. Recorded on the way in and detached on
   * the way out, so every test here starts with exactly one editor
   * listening. (Found the hard way: Delete removed act-2 while the panel
   * plainly showed act-1.)
   */
  const documentListeners: [string, EventListenerOrEventListenerObject][] = [];

  const boot = async (): Promise<void> => {
    await import("../../../pages/entrypoints/editor/main");
    await vi.waitFor(() => {
      if (!document.querySelector('[data-tick="act-1"]')) {
        throw new Error("timeline not rendered yet");
      }
    });
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
    memory.serveScene(() => readonlyScene());
    memory.serveBundle(null, null);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    for (const [type, listener] of documentListeners.splice(0)) {
      document.removeEventListener(type, listener);
    }
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  // The VERTICAL arrows, since 2026-09-19: the bare horizontal pair moves
  // the playhead now, the way it does in Premiere, Resolve and Final Cut.
  // "Previous/next cut point" is what ↑/↓ mean there, and on a timeline
  // whose unit is the beat that is exactly this.
  it("steps the selection forward and back along the take", async () => {
    await boot();
    expect(selected()).toBeNull();

    press("ArrowDown");
    expect(selected()).toBe("act-1");
    press("ArrowDown");
    expect(selected()).toBe("act-2");
    press("ArrowUp");
    expect(selected()).toBe("act-1");
    // The ends hold rather than wrapping: a selection that jumped from the
    // first beat to the last would be a step nobody asked for.
    press("ArrowUp");
    expect(selected()).toBe("act-1");
  });

  it("leaves the selection alone on the horizontal arrows", async () => {
    // The other half of the swap, asserted here so the pair cannot drift
    // back to both doing the same thing.
    await boot();
    press("ArrowDown");
    expect(selected()).toBe("act-1");
    press("ArrowRight");
    press("ArrowRight");
    expect(selected()).toBe("act-1");
  });

  it("removes a selected zoom on Backspace", async () => {
    memory.serveScene(() => zoomedScene());
    await boot();
    const seg = document.querySelector('[data-segment="cam-1"]') as HTMLElement;
    expect(seg).not.toBeNull(); // fixture guard: the zoom is on the timeline
    seg.click();
    expect(document.querySelector("[data-zoom-panel]")).not.toBeNull();

    press("Backspace");
    const put = await vi.waitFor(() => {
      const found = memory.putCalls()[0];
      if (!found) throw new Error("no scene:put yet");
      return found;
    });
    const scene = put.scene as SceneDocument;
    expect(scene.camera.map((c) => c.id)).toEqual([]);
  });

  /** One edit with no frames needed: the demo's name, typed and committed. */
  const rename = (): string => {
    const name = document.querySelector("#name") as HTMLInputElement;
    const before = name.value;
    name.value = "renamed";
    name.dispatchEvent(new Event("change"));
    name.blur();
    return before;
  };

  /** The demo's name in the n-th persisted scene, once there are that many
   *  writes. */
  const nthPut = async (n: number): Promise<string> => {
    const put = await vi.waitFor(() => {
      const puts = memory.putCalls();
      const found = puts[n - 1];
      if (!found) throw new Error(`only ${puts.length} scene:put so far`);
      return found;
    });
    return (put.scene as SceneDocument).meta.name;
  };

  for (const [os, modifier] of [
    ["macOS", { metaKey: true }],
    ["Windows and Linux", { ctrlKey: true }],
  ] as const) {
    it(`undoes on ${os}'s modifier + Z and redoes on modifier + Shift + Z`, async () => {
      await boot();
      const original = rename();
      expect(await nthPut(1)).toBe("renamed");
      // Premise: the edit changed something undo can take back.
      expect(original).not.toBe("renamed");

      expect(pressCancelable("z", document, modifier)).toBe(true);
      expect(await nthPut(2)).toBe(original);

      // Shift turns the key's own value upper-case; the handler must not
      // care which case it sees.
      expect(
        pressCancelable("Z", document, { ...modifier, shiftKey: true }),
      ).toBe(true);
      expect(await nthPut(3)).toBe("renamed");
    });
  }

  it("redoes on Ctrl+Y, the Windows convention, but not on Cmd+Y", async () => {
    await boot();
    const original = rename();
    await nthPut(1);
    press("z", document, { ctrlKey: true });
    expect(await nthPut(2)).toBe(original);

    // Cmd+Y is the browser's history window on a Mac, not a redo; the
    // handler leaves it alone and nothing is written.
    expect(pressCancelable("y", document, { metaKey: true })).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(memory.putCalls()).toHaveLength(2);

    expect(pressCancelable("y", document, { ctrlKey: true })).toBe(true);
    expect(await nthPut(3)).toBe("renamed");
  });

  it("claims nothing when there is nothing to undo or redo", async () => {
    // A fresh session has no history. The key is left to the browser and
    // no write goes out, rather than a no-op that reads as a shortcut that
    // did something.
    await boot();
    expect(pressCancelable("z", document, { metaKey: true })).toBe(false);
    expect(
      pressCancelable("z", document, { metaKey: true, shiftKey: true }),
    ).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(memory.putCalls().length > 0).toBe(false);
  });

  it("leaves modifier + Z to the demo-name field's own text undo", async () => {
    await boot();
    rename();
    await nthPut(1);
    const name = document.querySelector("#name") as HTMLInputElement;
    name.focus();
    expect(pressCancelable("z", name, { metaKey: true })).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(memory.putCalls()).toHaveLength(1);
  });

  it("leaves Backspace to the demo-name field", async () => {
    // Or the handler would delete the selected step every time the author
    // corrected a character in the title.
    await boot();
    press("ArrowDown");
    expect(selected()).toBe("act-1");
    const name = document.querySelector("#name") as HTMLInputElement;
    name.focus();
    expect(pressCancelable("Backspace", name)).toBe(false);
    // Nothing was deleted: no write went out, and the step is still selected.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(memory.putCalls().length > 0).toBe(false);
    expect(selected()).toBe("act-1");
  });

  it("leaves Space to a focused button, which already has its own", async () => {
    // The docblock's own example: a space pressed on a focused button fires
    // that button's activation AND this handler, so Play would toggle twice
    // per press. The guard's BUTTON branch is what stands down, and it was
    // the one branch of the four that nothing exercised.
    await boot();
    const play = document.querySelector(
      "[data-transport-play]",
    ) as HTMLButtonElement;
    expect(play).not.toBeNull();
    expect(pressCancelable(" ", play)).toBe(false);
    // And the same key from anywhere else IS this handler's, or the
    // assertion above would pass against a handler that had stopped
    // listening altogether.
    expect(pressCancelable(" ", document)).toBe(true);
  });

  it("keeps the shortcuts on a tick the keyboard reached", async () => {
    // The clip's ticks are `<button>`s, so Tab walks through every step in
    // the take. The guard used to stand down for every key on a BUTTON,
    // which left the arrows, Escape and Delete dead on exactly the control
    // the author had just tabbed to. It now stands down only for the two
    // keys a button activates on.
    await boot();
    const tickOf = (id: string) =>
      document.querySelector(`[data-tick="${id}"]`) as HTMLButtonElement;

    // Space included, for a tick: the handler's own `preventDefault` stops
    // Chrome turning the press into a click, so it plays the take rather
    // than reselecting the step the playhead is already on.
    expect(pressCancelable(" ", tickOf("act-1"))).toBe(true);

    const tick = tickOf("act-1");
    tick.focus();
    expect(document.activeElement).toBe(tick);
    // ArrowDown, the beat step since the NLE swap — the point is that the
    // key reaches this handler at all from a focused tick, not which key it
    // is.
    press("ArrowDown", tick);
    expect(selected()).toBe("act-1");
    // A fresh query: the first press re-rendered the timeline.
    press(
      "ArrowDown",
      document.querySelector('[data-tick="act-1"]') as HTMLElement,
    );
    expect(selected()).toBe("act-2");
  });

  /**
   * I, O and Shift+Delete — the three bindings that produce an EDIT rather
   * than moving something.
   *
   * `src/editor/shortcuts.ts` decides that I means "set the trim's head" and
   * `src/editor/gestures.ts` works out what that is against the rendered
   * timeline; neither knows whether `main.ts` actually connects the two.
   * That is the dead-wire class this file exists for, and until these it was
   * the one part of the map with no test on the wire.
   *
   * All of them need a rendered take: a trim aims at an instant and a kept
   * pace is a measured span, so these boot with frames where the rest of the
   * file deliberately boots without them.
   */
  describe("editing from the keyboard", () => {
    const bootRendered = async (): Promise<void> => {
      // `madeFrom` matches the default `scene:get` reply (`readonlyScene()`)
      // so the frames read as verifiable — the strict `not.toHaveBeenCalled`
      // guard below now catches a real `reportError`, where it used to catch
      // nothing at all.
      const bundle = proceduralBundle({
        madeFrom: madeFromOf(readonlyScene()),
      });
      // Premise: the spans the mocked video source stands in for are there.
      // Without them the image source is the one `main.ts` picks anyway and
      // the mock above covers nothing.
      expect(bundle.motionSpans.length).toBeGreaterThan(0);
      memory.serveBundle(bundle, null);
      await boot();
    };

    // The editor reports through `console.error`, and a frame read that
    // reached a store this file does not fake is exactly what it reported
    // here, on every rendered test, while the tests stayed green.
    let reported: ReturnType<typeof vi.spyOn>;
    beforeEach(() => {
      reported = vi.spyOn(console, "error");
    });
    afterEach(() => {
      expect(reported).not.toHaveBeenCalled();
    });

    const lastPut = async (): Promise<SceneDocument> => {
      const put = await vi.waitFor(() => {
        const puts = memory.putCalls();
        const found = puts[puts.length - 1];
        if (!found) throw new Error("no scene:put yet");
        return found;
      });
      return put.scene as SceneDocument;
    };

    const refusalText = (): string =>
      document.querySelector("[data-refusal]")?.textContent ?? "";

    it("trims the take's tail to the playhead on O", async () => {
      await bootRendered();
      // Away from the ends: a trim onto either one is refused for leaving
      // nothing, so a test that pressed O at 0 would be asserting the
      // refusal rather than the binding.
      for (let i = 0; i < 6; i += 1)
        press("ArrowRight", document, {
          shiftKey: true,
        });
      press("o");
      const scene = await lastPut();
      expect(scene.edits.trim?.tail).toBeDefined();
      // A marker on one of the take's own steps, which is what this
      // timeline's trim is — never an absolute instant.
      expect(scene.actions.map((a) => a.id)).toContain(
        scene.edits.trim?.tail?.actionId,
      );
      expect(scene.edits.trim?.head).toBeUndefined();
    });

    it("trims the take's head to the playhead on I", async () => {
      await bootRendered();
      for (let i = 0; i < 6; i += 1)
        press("ArrowRight", document, {
          shiftKey: true,
        });
      press("i");
      const scene = await lastPut();
      expect(scene.edits.trim?.head).toBeDefined();
      expect(scene.edits.trim?.tail).toBeUndefined();
    });

    it("says why it cannot trim a take with no frames, rather than nothing", async () => {
      // The file's default boot: `bundle:active` answers with no bundle, so
      // there is no rendered timeline to aim at. The binding must say that
      // instead of swallowing the press.
      await boot();
      press("o");
      await vi.waitFor(() => {
        if (refusalText() === "") throw new Error("no refusal shown yet");
      });
      expect(refusalText()).toMatch(/not been rendered|rebuild/i);
      expect(memory.putCalls().length > 0).toBe(false);
    });
  });

  it("drops the selection on Escape, which is half the way back to the demo panel", async () => {
    // The other half is the click past the lanes in `timeline-view.ts`.
    // Nothing else in any view clears the selection, and the inspector
    // shows the demo panel — export, branding, render mode, replacements —
    // only when nothing is selected: without a way back to "nothing", the
    // first tick click of a session hid all of it until the author deleted
    // the step they had clicked.
    await boot();
    expect(document.querySelector("[data-panel-export]")).not.toBeNull();

    press("ArrowDown");
    expect(selected()).toBe("act-1");
    expect(document.querySelector("[data-panel-export]")).toBeNull();

    press("Escape");
    expect(selected()).toBeNull();
    expect(document.querySelector("[data-panel-export]")).not.toBeNull();
  });

  it("leaves the keys alone while a text field has focus", async () => {
    await boot();
    const name = document.getElementById("name") as HTMLInputElement;
    name.focus();
    press("ArrowRight", name);
    // Unguarded, this would have selected act-1 while the author was only
    // moving the caret through the demo's name.
    expect(selected()).toBeNull();
    expect(memory.putCalls().length > 0).toBe(false);
  });

  it("leaves every key to a dialog while one is open", async () => {
    // `askToConfirm`'s dialog over the editor: an arrow there must not
    // step the selection behind it. Pressed on the document, not on the
    // dialog's button — a click on the dialog's text can leave focus on
    // <body>, and the guard has to hold there too.
    await boot();
    const dialog = document.createElement("dialog");
    dialog.setAttribute("open", "");
    dialog.append(document.createElement("button"));
    document.body.append(dialog);
    press("ArrowDown");
    press("ArrowDown", dialog.querySelector("button") as HTMLElement);
    expect(selected()).toBeNull();

    // Positive control: the same press, once the dialog has closed, is the
    // editor's again — so the null above was the guard, not a dead press.
    dialog.remove();
    press("ArrowDown");
    expect(selected()).toBe("act-1");
  });
}, 20_000);

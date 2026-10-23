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
 * The rail as `main.ts` wires it.
 *
 * `editor-rail.test.ts` hands `renderRail` a state object and pins what it
 * draws; it cannot see whether picking an entry changes anything, whether a
 * selection opens Selection, or whether clearing one returns to the entry
 * the author had open. Those are `main.ts`'s, so this boots the real module.
 *
 * The scaffolding below — the mocks, `editorDom`, `fakeChrome`,
 * `FakeOffscreenCanvas`, `boot` and `select` — is `editor-main-inspector`'s,
 * copied rather than imported: they are file-local there, and a shared
 * harness for the editor's main module does not exist yet.
 */

// jsdom does not implement `scrollIntoView`; the replacement route calls it.
Element.prototype.scrollIntoView ??= () => {};

vi.mock("@demoman/compositor", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@demoman/compositor")>();
  return {
    ...actual,
    // Real motion detection and a real hover check would read a frame store
    // jsdom does not have. Neither is what this file tests.
    //
    // Plain functions, not `vi.fn().mockResolvedValue([])` as the file this
    // harness was copied from has them: `vi.restoreAllMocks()` in `afterEach`
    // strips the resolved value, so from the second test on `hoverVerdicts`
    // answered `undefined`, `summarizeHoverVerdicts` threw on it and
    // `reportError` put a `console.error` on the page — which the trim test
    // below asserts the absence of. Nothing here asserts on either spy.
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

/** `readonlyScene` with a zoom on its last action — the same fixture
 *  `editor-main-inspector.test.ts` boots, so the two files see one take. */
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

describe("editor main — the rail, wired", () => {
  let memory: MemoryPlatform;

  /** See `editor-main-keyboard.test.ts`: `document` outlives
   *  `vi.resetModules()`, so a previous test's keydown listener would still
   *  be attached and acting on its own selection. */
  const documentListeners: [string, EventListenerOrEventListenerObject][] = [];

  const boot = async (): Promise<void> => {
    await import("../../../pages/entrypoints/editor/main");
    await vi.waitFor(() => {
      if (!document.querySelector('[data-tick="act-1"]')) {
        throw new Error("timeline not rendered yet");
      }
    });
  };

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
    // `madeFrom` matches `zoomedScene()` — this file's fixed `scene:get`
    // reply — so the frames read as verifiable and the approximations
    // path this file does not test stays quiet on the console.
    memory.serveBundle(
      proceduralBundle({
        motionSpans: [],
        madeFrom: madeFromOf(zoomedScene()),
      }),
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

  const pressed = () =>
    [...document.querySelectorAll<HTMLButtonElement>("[data-rail]")]
      .filter((b) => b.getAttribute("aria-pressed") === "true")
      .map((b) => b.dataset.rail);
  const pick = (entry: string) =>
    (
      document.querySelector(`[data-rail="${entry}"]`) as HTMLButtonElement
    ).click();

  it("opens and closes the Export panel from the header's button", async () => {
    await boot();
    const door = document.querySelector<HTMLButtonElement>(
      "header #export-open",
    );
    expect(door?.dataset.rail).toBe("export");
    expect(document.querySelector('#rail [data-rail="export"]')).toBeNull();
    // Opens on Export, so the first press closes it.
    expect(pressed()).toEqual(["export"]);
    door?.click();
    expect(document.body.dataset.panel).toBe("closed");
    expect(pressed()).toEqual([]);
    door?.click();
    expect(document.body.dataset.panel).toBe("open");
    expect(pressed()).toEqual(["export"]);
    expect(document.querySelector("[data-panel-export]")).not.toBeNull();
  });

  // Red if the button is not drawn, does nothing, or closes the card
  // without telling the rail (an entry left pressed over a closed panel).
  it("closes the panel from the card's own close button", async () => {
    await boot();
    expect(pressed()).toEqual(["export"]);
    document
      .querySelector<HTMLButtonElement>("#inspector [data-inspector-close]")
      ?.click();
    expect(document.body.dataset.panel).toBe("closed");
    expect(pressed()).toEqual([]);
  });

  it("reads the take's length and size beside its name", async () => {
    await boot();
    expect(document.querySelector("#take-meta")?.textContent).toMatch(
      /^\d+:\d{2} · \d+ × \d+$/,
    );
  });

  it("opens on Export with the Selection entry disabled", async () => {
    await boot();
    expect(pressed()).toEqual(["export"]);
    expect(document.querySelector("[data-panel-export]")).not.toBeNull();
    expect(
      (
        document.querySelector(
          '#rail [data-rail="selection"]',
        ) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    expect(document.body.dataset.panel).toBe("open");
  });

  it("switches to Selection on a tick and remembers where it was", async () => {
    await boot();
    pick("background");
    expect(pressed()).toEqual(["background"]);
    select("act-1");
    expect(pressed()).toEqual(["selection"]);
    expect(document.querySelector("[data-step-panel]")).not.toBeNull();
    // Escape clears the selection and returns to Background, not Export.
    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );
    expect(pressed()).toEqual(["background"]);
    expect(document.querySelector("[data-panel-branding]")).not.toBeNull();
  });

  it("returns to the entry the author last opened, not the one before it", async () => {
    // FINDING 8. Only `setSelection` moved `railBeforeSelection`, so an entry
    // opened from the rail was never recorded as somewhere to come back to.
    // Select, open Background, go back to Selection from the rail, deselect —
    // and the rail landed on Export, the entry open two moves ago, rather
    // than the Background the author had actually been working in.
    await boot();
    select("act-1");
    pick("background");
    expect(pressed()).toEqual(["background"]);
    pick("selection");
    expect(pressed()).toEqual(["selection"]);
    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );
    expect(
      pressed(),
      "deselecting returned to an entry the author had left",
    ).toEqual(["background"]);
    expect(document.querySelector("[data-panel-branding]")).not.toBeNull();
  });

  it("keeps the selection while the author opens Background by hand", async () => {
    await boot();
    select("act-1");
    pick("background");
    expect(pressed()).toEqual(["background"]);
    // `data-selected` is how `timeline-view.ts` marks the selected tick.
    expect(
      document.querySelector('[data-tick="act-1"][data-selected]'),
    ).not.toBeNull();
    // Back to the selection with one click; it is still there.
    pick("selection");
    expect(document.querySelector('[data-step-panel="act-1"]')).not.toBeNull();
  });

  it("closes the panel on the pressed entry and reopens it on any entry", async () => {
    await boot();
    pick("export");
    expect(document.body.dataset.panel).toBe("closed");
    expect(pressed()).toEqual([]);
    pick("background");
    expect(document.body.dataset.panel).toBe("open");
    expect(pressed()).toEqual(["background"]);
  });

  /* Keyboard focus survives the + it was on. `renderTimeline` rebuilds the
     lanes with `replaceChildren` on every render, so the render a press
     causes threw away the very button the author was pressing: Enter (or
     Space) added a mask and the focus fell to `body`, and a second mask
     meant tabbing all the way back. Found in the final review of
     2026-10-07.

     `click()` on a focused button is what Enter and Space dispatch on a
     button, so this is the keyboard press. Premises asserted beside the
     verdict: the press really did render (a segment appeared), and the
     button really was rebuilt (the one pressed is detached) — without
     that, "the focus is on the +" would pass against a lane that was never
     redrawn. */
  it("keeps the focus on the Mask lane's + across the render its press causes", async () => {
    await boot();
    const before = document.querySelector<HTMLButtonElement>(
      '[data-lane="mask"] [data-add-mask]',
    );
    expect(before, "no + on the Mask lane").not.toBeNull();
    before?.focus();
    expect(document.activeElement, "premise: the + has the focus").toBe(before);
    before?.click();
    await vi.waitFor(() =>
      expect(document.querySelector('[data-track="mask"] .seg')).not.toBeNull(),
    );
    const after = document.querySelector<HTMLButtonElement>(
      '[data-lane="mask"] [data-add-mask]',
    );
    expect(after, "the render left no + on the Mask lane").not.toBeNull();
    expect(before?.isConnected, "premise: the render rebuilt the +").toBe(
      false,
    );
    expect(
      document.activeElement,
      `the focus is on ${document.activeElement?.tagName}#${document.activeElement?.id} after the press`,
    ).toBe(after);
  });

  /* The other half: the + takes the focus back only from itself. An author
     typing in the name field, or anywhere else, keeps the focus through a
     render that the + did not cause — and through one it did, when it was
     pressed by pointer without ever holding the focus. */
  it("leaves the focus where it was when the + did not have it", async () => {
    await boot();
    const name = document.querySelector<HTMLInputElement>("#name");
    expect(name, "no #name in the shell").not.toBeNull();
    name?.focus();
    expect(document.activeElement, "premise: #name has the focus").toBe(name);
    document
      .querySelector<HTMLButtonElement>('[data-lane="mask"] [data-add-mask]')
      ?.click();
    await vi.waitFor(() =>
      expect(document.querySelector('[data-track="mask"] .seg')).not.toBeNull(),
    );
    expect(document.activeElement).toBe(name);
  });

  it("adds the mask where the playhead is at the click, not at the last render", async () => {
    await boot();
    // Premise: no mask yet, so the segment found below is the one this adds.
    expect(document.querySelector('[data-track="mask"] .seg')).toBeNull();
    // `End` (shortcuts.ts: `seekEdge`, tail) moves the playhead without a
    // full render: `runShortcut` calls `player.seek` and the player repaints
    // the transport alone. The lane's + was drawn at position 0 and is not
    // redrawn, so only a getter on `positionMs` can see the move.
    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "End", bubbles: true }),
    );
    // Back 500ms (⇧←, a `nudge`, also no full render): a mask at the very
    // end of the take has no length to occupy and is refused.
    document.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "ArrowLeft",
        shiftKey: true,
        bubbles: true,
      }),
    );
    const add = document.querySelector<HTMLButtonElement>(
      '[data-lane="mask"] [data-add-mask]',
    );
    expect(add, "no + on the Mask lane").not.toBeNull();
    add?.click();
    await vi.waitFor(() =>
      expect(document.querySelector('[data-track="mask"] .seg')).not.toBeNull(),
    );
    const seg = document.querySelector<HTMLElement>('[data-track="mask"] .seg');
    expect(
      Number.parseFloat(seg?.style.left ?? "0"),
      `the mask landed at ${seg?.style.left}, the render-time playhead (0), not where End and ⇧← put it`,
    ).toBeGreaterThan(50);
  });
});

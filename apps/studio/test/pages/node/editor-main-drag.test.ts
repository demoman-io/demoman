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
 * The three-way gesture result, wired end to end through the real
 * `entrypoints/editor/main.ts`.
 *
 * `resolveGesture` answers with a command, a `Refusal`, or `null`, and the
 * three must stay distinguishable to the author: a command edits the scene,
 * a refusal says why it could not, and `null` — the drag that ended where it
 * began — does neither, because the clip is already where the author left it
 * and a line nagging about a cancelled gesture would be noise.
 *
 * `editor-gestures.test.ts` pins which of the three `resolveGesture` returns
 * and `editor-timeline-view.test.ts` pins that a refusal renders; only this
 * file pins that `main.ts` routes each one to a different place. A refusal
 * assigned to nothing, or a `null` treated as a failure, would pass both of
 * those and still be wrong on screen.
 *
 * jsdom never lays out, so `getBoundingClientRect()` is zeroes for every
 * element and every drag would otherwise resolve at 0ms. The track's rect is
 * stubbed for exactly that reason — it is the one number the gesture needs
 * from layout, and stubbing it is what lets the ms arithmetic (and therefore
 * all three outcomes) be reached here rather than only in the browser lane.
 *
 * Retired from Task 6's per-beat drag surface (`resolveDrag`, `data-clip`,
 * `data-edge-clip`, a "pace" edge and a "cameraOffset" edge on an "actions"
 * and a "camera" lane): the redesign in Tasks 7-9 replaced it with three
 * fixed lanes — Clip (trim handles only), Zoom and Mask (segments with a
 * body drag and start/end caps) — and moved per-beat pace authoring off the
 * timeline into the inspector's numeric field (`onGap`/`onGapClear`, no
 * `Gesture` kind at all). This file now drives the trim handle and the Zoom
 * lane's segment instead, which are the surfaces that still exist.
 */

vi.mock("@demoman/compositor", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@demoman/compositor")>();
  return {
    ...actual,
    // Real motion detection and a real hover check would read a frame store
    // jsdom does not have. Neither is what this file tests.
    detectKeyframeMotion: vi.fn().mockResolvedValue([]),
    hoverVerdicts: vi.fn().mockResolvedValue([]),
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

/** `readonlyScene` with a zoom on its last action, so the Zoom lane has a
 *  segment whose start cap is draggable. */
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

const TRACK_WIDTH = 1000;

/**
 * Drags `node` from the left of its lane to `toX`, with the lane's own rect
 * stubbed to a real width so the gesture's ms arithmetic has something to
 * work from. `trackWidth` defaults to a real width; a caller that wants
 * `msPerPx` to be exactly 0 — the "says nothing when the drag ends where it
 * began" case below — passes 0.
 */
function drag(
  node: HTMLElement,
  laneId: string,
  toX: number,
  trackWidth = TRACK_WIDTH,
): void {
  const track = document.querySelector(
    `[data-track="${laneId}"]`,
  ) as HTMLElement;
  track.getBoundingClientRect = () =>
    ({ left: 0, width: trackWidth, right: trackWidth }) as DOMRect;
  node.dispatchEvent(
    new PointerEvent("pointerdown", {
      bubbles: true,
      clientX: 0,
      pointerId: 1,
    }),
  );
  window.dispatchEvent(
    new PointerEvent("pointermove", { bubbles: true, clientX: toX }),
  );
  window.dispatchEvent(
    new PointerEvent("pointerup", { bubbles: true, clientX: toX }),
  );
}

const refusalText = (): string =>
  document.querySelector("[data-refusal]")?.textContent ?? "";

describe("editor main — what a drag's three outcomes each do", () => {
  let memory: MemoryPlatform;

  const boot = async (): Promise<void> => {
    await import("../../../pages/entrypoints/editor/main");
    await vi.waitFor(() => {
      if (!document.querySelector('[data-tick="act-1"]')) {
        throw new Error("timeline not rendered yet");
      }
    });
  };

  const puts = () => memory.putCalls();

  beforeEach(() => {
    vi.resetModules();
    editorDom();
    vi.stubGlobal("OffscreenCanvas", FakeOffscreenCanvas);
    memory = createMemoryPlatform();
    state.memory = memory;
    memory.serveScene(() => zoomedScene());
    memory.serveBundle(proceduralBundle({ motionSpans: [] }), null);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("dispatches the command a trim drag resolves to", async () => {
    await boot();
    const handle = document.querySelector(
      '[data-track="clip"] [data-trim="head"]',
    ) as HTMLElement;
    // A small fraction of a ~9s take: well inside the head's valid range
    // (above 0, well below `tailMs - TRIM_MIN_MS`).
    drag(handle, "clip", TRACK_WIDTH * 0.05);

    const put = await vi.waitFor(() => {
      const found = puts()[0];
      if (!found) throw new Error("no scene:put yet");
      return found;
    });
    const scene = put.scene as SceneDocument;
    expect(scene.edits.trim?.head).toBeTruthy();
    // A dispatched command says nothing in the refusal line.
    expect(refusalText()).toBe("");
  });

  it("carries the playhead up to a trim head dragged past it, instead of leaving it in the cut", async () => {
    // Minor round-1 fix: `player`'s own clamp only runs on its NEXT
    // `play()`/`seek()`, so without `render()` flooring it explicitly, a
    // trim authored past the resting playhead would leave the playhead
    // drawn inside the newly-shaded cut until the author happened to move
    // it themselves.
    await boot();
    const playheadLeft = (): number =>
      Number.parseFloat(
        (document.querySelector("[data-playhead]") as HTMLElement).style.left,
      );
    // Nudge the playhead a little off zero so there is somewhere for a
    // trim to pass it from.
    for (let i = 0; i < 3; i++) {
      document.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "ArrowRight",
          shiftKey: true,
          bubbles: true,
        }),
      );
    }
    const before = playheadLeft();
    expect(before).toBeGreaterThan(0);

    // Well past that nudge (300ms into a ~9s take).
    const handle = document.querySelector(
      '[data-track="clip"] [data-trim="head"]',
    ) as HTMLElement;
    drag(handle, "clip", TRACK_WIDTH * 0.3);

    await vi.waitFor(() => {
      if (puts().length === 0) throw new Error("no scene:put yet");
    });

    const headLeft = Number.parseFloat(
      (
        document.querySelector(
          '[data-track="clip"] [data-trim="head"]',
        ) as HTMLElement
      ).style.left,
    );
    // The playhead sits exactly on the new head — not still at `before`,
    // and not left behind it inside the cut.
    expect(playheadLeft()).toBeCloseTo(headLeft, 1);
  });

  // F3: the symmetric case of the guard just above. `main.ts` only ever
  // floored the playhead up to a NEW trim head; nothing capped it back down
  // to a new trim tail, so a tail dragged earlier than a resting playhead
  // left the transport reading a position inside the newly-shaded cut on
  // the OTHER side until the author moved the playhead themselves.
  it("carries the playhead down to a trim tail dragged before it, instead of leaving it in the cut", async () => {
    await boot();
    const playheadLeft = (): number =>
      Number.parseFloat(
        (document.querySelector("[data-playhead]") as HTMLElement).style.left,
      );
    // Park the playhead near the untrimmed end via a ruler scrub, so there
    // is somewhere for a tail drag to leave it behind. Not a keyboard "End"
    // press: `main.ts` registers its transport shortcuts on `document`
    // itself and this suite's `boot()` never removes an earlier test's
    // listener, so a dispatched key event also reaches every prior test's
    // dead module instance. A ruler drag targets a DOM node this test's own
    // render just created, which carries only this test's own listener.
    const ruler = document.querySelector("[data-ruler]") as HTMLElement;
    ruler.getBoundingClientRect = () =>
      ({ left: 0, width: TRACK_WIDTH, right: TRACK_WIDTH }) as DOMRect;
    ruler.dispatchEvent(
      new PointerEvent("pointerdown", {
        bubbles: true,
        clientX: TRACK_WIDTH,
        pointerId: 1,
      }),
    );
    window.dispatchEvent(
      new PointerEvent("pointerup", { bubbles: true, clientX: TRACK_WIDTH }),
    );
    const before = playheadLeft();
    expect(before).toBeGreaterThan(0);

    // Well before that (70% into a ~9s take, clear of TRIM_MIN_MS from 0).
    const handle = document.querySelector(
      '[data-track="clip"] [data-trim="tail"]',
    ) as HTMLElement;
    drag(handle, "clip", TRACK_WIDTH * 0.7);

    await vi.waitFor(() => {
      if (puts().length === 0) throw new Error("no scene:put yet");
    });

    const tailLeft = Number.parseFloat(
      (
        document.querySelector(
          '[data-track="clip"] [data-trim="tail"]',
        ) as HTMLElement
      ).style.left,
    );
    // The playhead sits exactly on the new tail — not still at `before`,
    // which is now inside the shaded cut.
    expect(playheadLeft()).toBeLessThan(before);
    expect(playheadLeft()).toBeCloseTo(tailLeft, 1);
  });

  it("reads 0:00 at the trim head, not the untrimmed position", async () => {
    // The stage bar's clock reads the TRIMMED clock: once a trim head drag
    // lands, `player.positionMs` itself is the trim head — a positive
    // number of ms into the UNTRIMMED take — but the author is looking at
    // the start of the clip they'll actually export, and
    // `renderTransportRow` subtracts the head before handing the number to
    // `renderStageBar`. A clock that forgot the subtraction would show the
    // raw (non-zero) position here instead.
    await boot();
    const handle = document.querySelector(
      '[data-track="clip"] [data-trim="head"]',
    ) as HTMLElement;
    drag(handle, "clip", TRACK_WIDTH * 0.3);

    await vi.waitFor(() => {
      if (puts().length === 0) throw new Error("no scene:put yet");
    });

    expect(
      document.querySelector("#toolbar-clock [data-transport-time]")
        ?.textContent,
    ).toMatch(/^0:00 \//);
  });

  it("shows a refused drag's reason and changes nothing", async () => {
    await boot();
    const cap = document.querySelector(
      '[data-segment="cam-1"] [data-cap="start"]',
    ) as HTMLElement;
    // Dragged past the zoom's own end, which `resolveGesture` refuses: a
    // zoom cannot start after it ends.
    drag(cap, "zoom", TRACK_WIDTH * 1.1);

    expect(refusalText()).toMatch(/cannot cross its end/i);
    expect(puts()).toHaveLength(0);
  });

  it("takes the refusal down once a later drag goes through", async () => {
    // The second half of "persists until the next successful command". A
    // refusal left standing beside an edit that worked tells the author a
    // gesture failed when it did not — the same defect as a silent failure,
    // pointed the other way.
    await boot();
    const cap = document.querySelector(
      '[data-segment="cam-1"] [data-cap="start"]',
    ) as HTMLElement;
    drag(cap, "zoom", TRACK_WIDTH * 1.1);
    expect(refusalText()).toMatch(/cannot cross its end/i);

    // A trim drag, which resolves to a command and is dispatched.
    const handle = document.querySelector(
      '[data-track="clip"] [data-trim="head"]',
    ) as HTMLElement;
    drag(handle, "clip", TRACK_WIDTH * 0.05);

    await vi.waitFor(() => {
      if (puts().length === 0) throw new Error("no scene:put yet");
      if (refusalText() !== "") {
        throw new Error(`refusal still standing: ${refusalText()}`);
      }
    });
    expect(refusalText()).toBe("");
  });

  // Un-skipped in review round 1: `fittedDurationMs` is still live code and
  // still reachable — just not through a drag any more. Pace/gap authoring
  // moved off the timeline into the inspector's numeric field
  // (`onGap`/`onGapClear`), and that field changes `model.durationMs`
  // exactly the way the old pace drag did, so this drives IT instead.
  it("re-fits the axis when an edit changes the take's length", async () => {
    // A pace longer than the original footage showed lengthens the deliverable. A
    // viewport kept across that change goes on describing the old length —
    // every tick after the edit sits at a fraction of an axis that is now
    // too short for it, which either draws them in the wrong place or (a
    // tick outside `[0,1]` is not drawn at all) drops them from the
    // timeline entirely.
    await boot();
    const tickLeft = (actionId: string): number =>
      Number.parseFloat(
        (document.querySelector(`[data-tick="${actionId}"]`) as HTMLElement)
          .style.left,
      );
    // act-1 itself does not move — the gap goes AFTER it — so its fraction
    // changing at all is proof the window rescaled, not that this beat
    // did. A frozen viewport would leave it exactly where it started.
    const before = tickLeft("act-1");

    document.querySelector<HTMLElement>('[data-tick="act-1"]')?.click();
    const gap = await vi.waitFor(() => {
      const field = document.querySelector('input[data-gap="act-1"]');
      if (!field) throw new Error("gap field not rendered yet");
      return field as HTMLInputElement;
    });
    // Well past act-1 → act-2's own recorded elapsed time (the comment on
    // the retired drag test measured it at 2800ms for this fixture), so
    // `buildTimeline`'s `max(0, targetMs − replayElapsed)` reconstruction
    // actually lengthens the take rather than reconstructing time it
    // already had.
    gap.value = "5000";
    gap.dispatchEvent(new Event("change"));

    await vi.waitFor(() => {
      if (puts().length === 0) throw new Error("no scene:put yet");
      if (tickLeft("act-1") === before) {
        throw new Error("the gap has not reached the lanes yet");
      }
    });

    // The axis got longer, so the same absolute instant is now a SMALLER
    // fraction of it — proof `fitAll` re-ran against the new duration
    // rather than the viewport staying pinned to the old one.
    expect(tickLeft("act-1")).toBeLessThan(before);
    // And nothing at the end of the take fell off the drawn window.
    expect(document.querySelector('[data-tick="act-3"]')).not.toBeNull();
  });

  it("takes the refusal down when a command from anywhere else goes through", async () => {
    // The rest of "persists until the next successful command". Only the
    // drag path used to clear it, so a refused gesture's line stood under
    // the timeline through every edit made from the inspector, the insert
    // popover and undo/redo — telling the author a gesture had failed long
    // after they had moved on from it.
    await boot();
    const cap = document.querySelector(
      '[data-segment="cam-1"] [data-cap="start"]',
    ) as HTMLElement;
    drag(cap, "zoom", TRACK_WIDTH * 1.1);
    expect(refusalText()).toMatch(/cannot cross its end/i);

    // An edit that never touches `resolveGesture`: the take's name.
    const name = document.querySelector("#name") as HTMLInputElement;
    name.value = "Renamed";
    name.dispatchEvent(new Event("change", { bubbles: true }));

    await vi.waitFor(() => {
      if (puts().length === 0) throw new Error("no scene:put yet");
      if (refusalText() !== "") {
        throw new Error(`refusal still standing: ${refusalText()}`);
      }
    });
  });

  it("keeps the refusal up when the command that followed it failed", async () => {
    // The other half, and the reason "a command was attempted" is not the
    // test: `session.dispatch` resolves normally for an edit the store
    // refused, and it reverts the scene. Clearing the line there would
    // replace one failure's explanation with nothing at all.
    memory.answer("scenes.put", async () => {
      throw new Error("the store is full");
    });
    await boot();
    const cap = document.querySelector(
      '[data-segment="cam-1"] [data-cap="start"]',
    ) as HTMLElement;
    drag(cap, "zoom", TRACK_WIDTH * 1.1);
    const said = refusalText();
    expect(said).toMatch(/cannot cross its end/i);

    const name = document.querySelector("#name") as HTMLInputElement;
    name.value = "Renamed";
    name.dispatchEvent(new Event("change", { bubbles: true }));

    await vi.waitFor(() => {
      if (puts().length === 0) throw new Error("no scene:put yet");
      if (!document.querySelector("#failure")?.textContent?.includes("full")) {
        throw new Error("the store's refusal has not surfaced yet");
      }
    });
    expect(refusalText()).toBe(said);
  });

  it("says nothing at all when the drag ends where it began", async () => {
    await boot();
    // With the zoom track's own width stubbed to 0, `msPerPx` is 0 and any
    // real drag (moved more than the 3px click threshold) computes a
    // `deltaMs` of exactly 0 — the move that resolves nowhere, which
    // `resolveGesture`'s `moveZoom` answers with `null` rather than a
    // command or a refusal.
    const seg = document.querySelector('[data-segment="cam-1"]') as HTMLElement;
    drag(seg, "zoom", 8, 0);

    await Promise.resolve();
    expect(puts()).toHaveLength(0);
    // The distinction this test exists for: no edit AND no complaint.
    expect(refusalText()).toBe("");
  });
});

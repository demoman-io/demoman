import { describe, expect, it } from "vitest";
import { readonlyScene } from "../../../../../packages/replay-engine/test/helpers/scenes";
import { applyCommand } from "../../../pages/src/editor/commands";

const ids = () => {
  let n = 0;
  return () => `gen-${++n}`;
};

describe("setTrim", () => {
  it("writes and clears each side independently", () => {
    let scene = applyCommand(
      readonlyScene(),
      { kind: "setTrim", head: { actionId: "act-2", offsetMs: 300 } },
      ids(),
    );
    expect(scene.edits.trim).toEqual({
      head: { actionId: "act-2", offsetMs: 300 },
    });
    scene = applyCommand(
      scene,
      { kind: "setTrim", tail: { actionId: "act-3", offsetMs: -100 } },
      ids(),
    );
    expect(scene.edits.trim).toEqual({
      head: { actionId: "act-2", offsetMs: 300 },
      tail: { actionId: "act-3", offsetMs: -100 },
    });
    scene = applyCommand(scene, { kind: "setTrim", head: null }, ids());
    expect(scene.edits.trim).toEqual({
      tail: { actionId: "act-3", offsetMs: -100 },
    });
  });
});

describe("zooms", () => {
  it("adds an element zoom on a tick with the default lead-in", () => {
    const scene = applyCommand(
      readonlyScene(),
      {
        kind: "addZoom",
        marker: { actionId: "act-3", offsetMs: 0 },
        target: { kind: "element", anchorId: "a-checkout" },
        scale: 1.8,
      },
      ids(),
    );
    expect(scene.camera).toEqual([
      {
        id: "gen-1",
        kind: "zoom",
        anchorId: "a-checkout",
        marker: { actionId: "act-3", offsetMs: -350 },
        scale: 1.8,
      },
    ]);
  });

  // F3: the lead-in branch keyed only on `offsetMs === 0`, contradicting its
  // own docblock ("on a tick an ELEMENT zoom gets the default lead-in").
  // `resolveGesture`'s addZoom reaches the point branch whenever the nearest
  // beat carries no anchor — a navigation `waitFor`, say — with `markerAt`
  // having snapped the offset to 0, so a point zoom dropped on such a tick
  // was stored 350ms EARLIER than the instant the author clicked, while its
  // `point` had been sampled from the cursor at the un-shifted instant. The
  // zoom then landed before the drop point and aimed at where the cursor
  // would be 350ms later.
  it("adds a point zoom on a tick at the instant it was dropped, with no lead-in", () => {
    const scene = applyCommand(
      readonlyScene(),
      {
        kind: "addZoom",
        marker: { actionId: "act-3", offsetMs: 0 },
        target: { kind: "point", x: 300, y: 400 },
        scale: 1.8,
      },
      ids(),
    );
    expect(scene.camera[0]?.marker).toEqual({
      actionId: "act-3",
      offsetMs: 0,
    });
  });

  it("adds a point zoom between ticks at its own offset, carrying the note", () => {
    const scene = applyCommand(
      readonlyScene(),
      {
        kind: "addZoom",
        marker: { actionId: "act-2", offsetMs: 1200 },
        target: { kind: "point", x: 300, y: 400 },
        scale: 1.8,
        note: "aimed at the cursor",
      },
      ids(),
    );
    expect(scene.camera[0]).toMatchObject({
      point: { x: 300, y: 400 },
      marker: { actionId: "act-2", offsetMs: 1200 },
      note: "aimed at the cursor",
    });
    expect(scene.camera[0]).not.toHaveProperty("anchorId");
  });

  it("sets a range, a scale, a point target, and removes by id", () => {
    let scene = applyCommand(
      readonlyScene(),
      {
        kind: "addZoom",
        marker: { actionId: "act-2", offsetMs: 0 },
        target: { kind: "element", anchorId: "a-row" },
        scale: 1.8,
      },
      ids(),
    );
    scene = applyCommand(
      scene,
      {
        kind: "setZoomRange",
        id: "gen-1",
        start: { actionId: "act-2", offsetMs: -500 },
        end: { actionId: "act-3", offsetMs: -200 },
      },
      ids(),
    );
    expect(scene.camera[0]?.marker).toEqual({
      actionId: "act-2",
      offsetMs: -500,
    });
    expect(scene.camera[0]?.end).toEqual({ actionId: "act-3", offsetMs: -200 });
    scene = applyCommand(
      scene,
      {
        kind: "setZoomRange",
        id: "gen-1",
        start: { actionId: "act-2", offsetMs: -500 },
        end: null,
      },
      ids(),
    );
    expect(scene.camera[0]).not.toHaveProperty("end");
    scene = applyCommand(
      scene,
      { kind: "setZoomScale", id: "gen-1", scale: 2.2 },
      ids(),
    );
    expect(scene.camera[0]?.scale).toBe(2.2);
    scene = applyCommand(
      scene,
      { kind: "setZoomTarget", id: "gen-1", point: { x: 5, y: 6 } },
      ids(),
    );
    expect(scene.camera[0]?.point).toEqual({ x: 5, y: 6 });
    expect(scene.camera[0]).not.toHaveProperty("anchorId");
    scene = applyCommand(scene, { kind: "removeZoom", id: "gen-1" }, ids());
    expect(scene.camera).toEqual([]);
  });

  // F5: every other by-id zoom command (`setZoomRange`, `setZoomScale`,
  // `setZoomTarget`) goes through `zoomById`, which throws "unknown zoom"
  // on a missing id. `removeZoom` used to just filter, silently doing
  // nothing for an id that named nothing — indistinguishable from a
  // successful removal to whatever caller sent it.
  it("refuses to remove an unknown zoom by name", () => {
    expect(() =>
      applyCommand(readonlyScene(), { kind: "removeZoom", id: "nope" }, ids()),
    ).toThrow(/unknown zoom/);
  });

  it("refuses a 1:1 scale by name", () => {
    const scene = applyCommand(
      readonlyScene(),
      {
        kind: "addZoom",
        marker: { actionId: "act-2", offsetMs: 0 },
        target: { kind: "element", anchorId: "a-row" },
        scale: 1.8,
      },
      ids(),
    );
    expect(() =>
      applyCommand(
        scene,
        { kind: "setZoomScale", id: "gen-1", scale: 1 },
        ids(),
      ),
    ).toThrow(/1:1/);
  });
});

describe("masks", () => {
  it("adds a mask with a range and moves the range", () => {
    const rect = { x: 10, y: 10, width: 100, height: 20 };
    let scene = applyCommand(
      readonlyScene(),
      {
        kind: "addMask",
        rect,
        start: { actionId: "act-1", offsetMs: 0 },
        end: { actionId: "act-2", offsetMs: 0 },
      },
      ids(),
    );
    expect(scene.edits.masks[0]).toEqual({
      id: "gen-1",
      rect,
      start: { actionId: "act-1", offsetMs: 0 },
      end: { actionId: "act-2", offsetMs: 0 },
    });
    scene = applyCommand(
      scene,
      {
        kind: "setMaskRange",
        id: "gen-1",
        start: { actionId: "act-1", offsetMs: 100 },
        end: { actionId: "act-3", offsetMs: 0 },
      },
      ids(),
    );
    expect(scene.edits.masks[0]?.end).toEqual({
      actionId: "act-3",
      offsetMs: 0,
    });
  });

  it("sets and clears a mask's note", () => {
    const rect = { x: 10, y: 10, width: 100, height: 20 };
    let scene = applyCommand(
      readonlyScene(),
      {
        kind: "addMask",
        rect,
        start: { actionId: "act-1", offsetMs: 0 },
        end: { actionId: "act-2", offsetMs: 0 },
      },
      ids(),
    );
    scene = applyCommand(
      scene,
      { kind: "setMaskNote", id: "gen-1", note: "email column" },
      ids(),
    );
    expect(scene.edits.masks[0]?.note).toBe("email column");
    scene = applyCommand(
      scene,
      { kind: "setMaskNote", id: "gen-1", note: "" },
      ids(),
    );
    expect(scene.edits.masks[0]).not.toHaveProperty("note");
  });
});

describe("aiming a zoom by hand", () => {
  it("drops the aim-fallback note along with the anchor", () => {
    // `resolveGesture` writes that note when addZoom finds no cursor to aim
    // at and falls back to the nearest element; `lanes.ts` reads it back as
    // `aimFallback` and the zoom panel prints it. Carried through into a
    // point target, it went on blaming a cursor gap for a point the author
    // had just dragged into place themselves.
    let scene = applyCommand(
      readonlyScene(),
      {
        kind: "addZoom",
        marker: { actionId: "act-2", offsetMs: 0 },
        target: { kind: "element", anchorId: "a-row" },
        scale: 1.8,
        note: 'Aimed at "Row" instead of the cursor: no cursor was recorded there.',
      },
      ids(),
    );
    expect(scene.camera[0]?.note).toMatch(/instead of the cursor/);

    scene = applyCommand(
      scene,
      { kind: "setZoomTarget", id: "gen-1", point: { x: 5, y: 6 } },
      ids(),
    );
    expect(scene.camera[0]?.point).toEqual({ x: 5, y: 6 });
    expect(scene.camera[0]).not.toHaveProperty("anchorId");
    expect(scene.camera[0]).not.toHaveProperty("note");
  });
});

describe("moving a mask's rect", () => {
  const withMask = () =>
    applyCommand(
      readonlyScene(),
      {
        kind: "addMask",
        rect: { x: 10, y: 10, width: 100, height: 20 },
        start: { actionId: "act-1", offsetMs: 0 },
        end: { actionId: "act-2", offsetMs: 0 },
      },
      ids(),
    );

  it("writes the dragged rect", () => {
    const scene = applyCommand(
      withMask(),
      {
        kind: "moveMask",
        id: "gen-1",
        rect: { x: 40, y: 12, width: 90, height: 30 },
      },
      ids(),
    );
    expect(scene.edits.masks[0]?.rect).toEqual({
      x: 40,
      y: 12,
      width: 90,
      height: 30,
    });
  });

  it("refuses a rect the drag left off the frame, and says so", () => {
    // `canvasRectToCss` clamps to the capture viewport, so a box carried
    // clean off an edge comes back with a zero side. The schema accepts it
    // (`nonnegative`), the Mask lane goes on listing the mask, and
    // `drawCosmetics` paints nothing: a redaction thrown away by a drag
    // that reported success.
    const scene = withMask();
    expect(() =>
      applyCommand(
        scene,
        {
          kind: "moveMask",
          id: "gen-1",
          rect: { x: 0, y: 12, width: 0, height: 30 },
        },
        ids(),
      ),
    ).toThrow(/off the frame/);
    expect(() =>
      applyCommand(
        scene,
        {
          kind: "moveMask",
          id: "gen-1",
          rect: { x: 8, y: 0, width: 90, height: 0 },
        },
        ids(),
      ),
    ).toThrow(/off the frame/);
    // And the mask the author still has is the one they had before.
    expect(scene.edits.masks[0]?.rect).toEqual({
      x: 10,
      y: 10,
      width: 100,
      height: 20,
    });
  });

  it("refuses to move a mask that is not there", () => {
    // Its neighbours (`setMaskRange`, `removeZoom`) check; this one mapped
    // over the list and matched nothing, which is what a successful move
    // also looks like from the caller's side.
    expect(() =>
      applyCommand(
        withMask(),
        {
          kind: "moveMask",
          id: "nope",
          rect: { x: 1, y: 1, width: 10, height: 10 },
        },
        ids(),
      ),
    ).toThrow(/unknown mask/);
  });
});

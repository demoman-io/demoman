import {
  CAMERA_DEFAULTS,
  motionTimings,
  planScene,
  resolvePlan,
  toOutputMs,
} from "@demoman/compositor";
import { ZOOM_GLIDE_MIN_MS, zoomsForClicks } from "@demoman/run-core";
import {
  MOTION_DEFAULTS,
  type SceneDocument,
  type SourcePoint,
} from "@demoman/scene-schema";
import { describe, expect, it } from "vitest";
import {
  proceduralBundle,
  stillCursorBundle,
} from "../../../../../packages/replay-engine/test/helpers/bundles";
import { readonlyScene } from "../../../../../packages/replay-engine/test/helpers/scenes";
import {
  applyCommand,
  type EditCommand,
} from "../../../pages/src/editor/commands";
import {
  type Gesture,
  type GestureContext,
  isRefusal,
  MASK_DEFAULT_MS,
  MIN_SEGMENT_MS,
  MIN_ZOOM_GAP_MS,
  placeZoom,
  resolveGap,
  resolveGesture,
  TRIM_MIN_MS,
} from "../../../pages/src/editor/gestures";
import { buildLaneModel, markerAt } from "../../../pages/src/editor/lanes";
import { buildTimelineView } from "../../../pages/src/editor/timeline";

const ids = () => {
  let n = 0;
  return () => `gen-${++n}`;
};
const VIEWPORT = { width: 1280, height: 800 };

function setup(scene = readonlyScene(), bundle = proceduralBundle()) {
  const resolved = resolvePlan(planScene(scene), bundle, scene);
  const view = buildTimelineView({ scene, bundle, resolved });
  const model = buildLaneModel({
    scene,
    view,
    bundle,
    resolved,
    hoverReport: null,
  });
  const ctx: GestureContext = { resolved, bundle, viewport: VIEWPORT };
  return { scene, model, view, ctx };
}

/** Where a mask edge's frame plays in the setup's video. */
const landsAt = (s: ReturnType<typeof setup>, p: SourcePoint): number => {
  const frame = s.ctx.bundle?.markers.find((m) => m.actionId === p.actionId);
  if (!frame || !s.ctx.resolved) throw new Error("fixture");
  return toOutputMs(
    s.ctx.resolved.timeline,
    frame.sourceTimeMs + p.sourceOffsetMs,
  );
};

const run = (s: ReturnType<typeof setup>, gesture: Gesture) =>
  resolveGesture(s.model, s.view, gesture, s.ctx);
const command = (result: ReturnType<typeof resolveGesture>): EditCommand => {
  if (result === null || isRefusal(result))
    throw new Error(`expected a command, got ${JSON.stringify(result)}`);
  return result;
};
const reason = (result: ReturnType<typeof resolveGesture>): string => {
  if (!isRefusal(result))
    throw new Error(`expected a refusal, got ${JSON.stringify(result)}`);
  expect(result.reason.length).toBeGreaterThan(0);
  return result.reason;
};

describe("trim", () => {
  it("drags the tail to a marker on the nearest step", () => {
    const s = setup();
    const t2 = s.model.clip.ticks[1];
    if (!t2) throw new Error("fixture");
    expect(
      command(
        run(s, { kind: "trim", edge: "tail", toMs: t2.atMs + 700, snapMs: 0 }),
      ),
    ).toEqual({
      kind: "setTrim",
      tail: { actionId: "act-2", offsetMs: 700 },
    });
  });

  it("clears a side dragged off its end of the take", () => {
    const s = setup();
    expect(
      command(run(s, { kind: "trim", edge: "head", toMs: -50, snapMs: 0 })),
    ).toEqual({ kind: "setTrim", head: null });
    expect(
      command(
        run(s, {
          kind: "trim",
          edge: "tail",
          toMs: s.model.durationMs + 50,
          snapMs: 0,
        }),
      ),
    ).toEqual({ kind: "setTrim", tail: null });
  });

  // F1: `trim` was the one range gesture with no `collapsed()` check, and
  // the one that needs it most. `markerAt` snaps anything within `snapMs` of
  // a tick to offset 0, which can erase a gap the raw-ms guard above just
  // approved — a 60s take on an ~800px track gives a snap band of ~600ms
  // against a `TRIM_MIN_MS` of 200. Nothing downstream catches it:
  // `setTrim` validates only that the action exists, the schema has no
  // ordering refinement for `edits.trim`, and `resolveRange` reports the
  // collapse only after the author has already been handed a zero-length
  // deliverable.
  it("refuses a head the snap lands on the tail's own step", () => {
    const s = setup(
      applyCommand(
        readonlyScene(),
        { kind: "setTrim", tail: { actionId: "act-2", offsetMs: 0 } },
        ids(),
      ),
    );
    const tailMs = s.model.clip.trim.tailMs;
    const snapMs = 600;
    const toMs = tailMs - snapMs;
    // Fixture guard: the raw-ms guard the gesture already had passes this
    // drag, so the refusal below can only come from the snap.
    expect(toMs).toBeLessThan(tailMs - TRIM_MIN_MS);
    // ...and without the snap the same drag IS accepted, so the refusal is
    // about the collapse and not about the position.
    expect(
      command(run(s, { kind: "trim", edge: "head", toMs, snapMs: 0 })),
    ).toMatchObject({ kind: "setTrim" });

    expect(
      reason(run(s, { kind: "trim", edge: "head", toMs, snapMs })),
    ).toMatch(/same step/);
  });

  it("refuses a tail the snap lands on the head's own step", () => {
    const s = setup(
      applyCommand(
        readonlyScene(),
        { kind: "setTrim", head: { actionId: "act-2", offsetMs: 0 } },
        ids(),
      ),
    );
    const headMs = s.model.clip.trim.headMs;
    const snapMs = 600;
    const toMs = headMs + snapMs;
    expect(toMs).toBeGreaterThan(headMs + TRIM_MIN_MS);
    expect(
      command(run(s, { kind: "trim", edge: "tail", toMs, snapMs: 0 })),
    ).toMatchObject({ kind: "setTrim" });

    expect(
      reason(run(s, { kind: "trim", edge: "tail", toMs, snapMs })),
    ).toMatch(/same step/);
  });

  it("refuses a head within TRIM_MIN_MS of the tail, naming the limit", () => {
    const s = setup();
    const r = run(s, {
      kind: "trim",
      edge: "head",
      toMs: s.model.clip.trim.tailMs - TRIM_MIN_MS + 1,
      snapMs: 0,
    });
    expect(reason(r)).toMatch(/leave nothing/);
  });
});

describe("addZoom", () => {
  it("aims at the recorded cursor even when the click lands on a tick", () => {
    // Until 2026-09-14 a click within the snap band of a tick that could
    // zoom became an ELEMENT zoom on that step. The author asked for the
    // cursor by default; the inspector's "Zoom on this step" is the element
    // route now. The marker still snaps to the tick, so the zoom stays
    // attached to the step.
    const s = setup();
    const t2 = s.model.clip.ticks[1];
    if (!t2) throw new Error("fixture");
    const cmd = command(
      run(s, { kind: "addZoom", atMs: t2.atMs + 3, snapMs: 10 }),
    );
    expect(cmd).toMatchObject({
      kind: "addZoom",
      marker: { actionId: "act-2", offsetMs: 0 },
      scale: CAMERA_DEFAULTS.defaultZoomScale,
    });
    if (cmd.kind !== "addZoom") throw new Error("kind");
    expect(cmd.target.kind).toBe("point");
    expect(cmd).not.toHaveProperty("note");
  });

  it("aims at the recorded cursor position between ticks", () => {
    const s = setup();
    const t2 = s.model.clip.ticks[1];
    if (!t2) throw new Error("fixture");
    const cmd = command(
      run(s, { kind: "addZoom", atMs: t2.atMs + 1500, snapMs: 0 }),
    );
    expect(cmd).toMatchObject({
      kind: "addZoom",
      marker: { actionId: "act-2", offsetMs: 1500 },
    });
    expect(cmd).not.toHaveProperty("note");
    if (cmd.kind !== "addZoom") throw new Error("kind");
    expect(cmd.target.kind).toBe("point");
    // proceduralBundle's pointer travels from (640,328) at 3200 to
    // (1060,642) at 9000, so mid-way it is strictly between the two.
    if (cmd.target.kind !== "point") throw new Error("target");
    expect(cmd.target.x).toBeGreaterThan(640);
    expect(cmd.target.x).toBeLessThan(1060);
  });

  it("falls back to the nearest element over a cursor gap, and says why", () => {
    const bundle = proceduralBundle({
      cursorGaps: [{ startMs: 4000, endMs: 8000 }],
    });
    const s = setup(readonlyScene(), bundle);
    const t2 = s.model.clip.ticks[1];
    if (!t2) throw new Error("fixture");
    const cmd = command(
      run(s, { kind: "addZoom", atMs: t2.atMs + 2500, snapMs: 0 }),
    );
    expect(cmd).toMatchObject({
      kind: "addZoom",
      target: { kind: "element", anchorId: "a-row" },
    });
    if (cmd.kind !== "addZoom") throw new Error("kind");
    expect(cmd.note).toMatch(/off the page/);
  });

  it("refuses when there is nothing at all to aim at", () => {
    const scene = {
      ...readonlyScene(),
      anchors: [],
      actions: readonlyScene().actions.map((a) => ({
        ...a,
        anchorId: null,
        kind: "waitFor" as const,
        condition: "loaded" as const,
      })),
    };
    const bundle = proceduralBundle({ cursorSamples: [], anchorRects: [] });
    const s = setup(scene as ReturnType<typeof readonlyScene>, bundle);
    expect(reason(run(s, { kind: "addZoom", atMs: 5000, snapMs: 0 }))).toMatch(
      /nothing to aim at/,
    );
  });

  it("places a click over an existing zoom right after it, and says so", () => {
    // Until 2026-09-14 this refused. A refusal that says "add it further
    // away" makes the author do the arithmetic the resolver already did;
    // the zoom goes in the first slot that fits and the note says it moved.
    //
    // The existing zoom sits on act-1, so the slot after it has the rest of
    // this 9s take to land in.
    const newId = ids();
    const scene = applyCommand(
      readonlyScene(),
      {
        kind: "addZoom",
        marker: { actionId: "act-1", offsetMs: 0 },
        target: { kind: "element", anchorId: "a-row" },
        scale: 1.8,
      },
      newId,
    );
    const s = setup(scene);
    const z = s.model.zooms[0];
    if (!z) throw new Error("fixture");
    const atMs = (z.startMs + z.endMs) / 2;
    const cmd = command(run(s, { kind: "addZoom", atMs, snapMs: 0 }));
    if (cmd.kind !== "addZoom") throw new Error("kind");
    expect(cmd.note).toMatch(/Placed after the zoom at 0:00\.0/);
    expect(cmd.note).toMatch(/no room at 0:01\.1/);
    expect(cmd.target.kind).toBe("point");

    // Where it landed: the first instant `MIN_ZOOM_GAP_MS` past the
    // existing zoom's start, reserved for the widest zoom the click could
    // add (an element zoom's lead-in) — so this point zoom, which takes
    // none, sits `-leadInMs` past the bound. Every drag of it is then legal.
    const after = setup(applyCommand(s.scene, cmd, newId));
    const fresh = after.model.zooms.find((x) => x.id !== z.id);
    if (!fresh) throw new Error("fixture");
    expect(fresh.startMs).toBeCloseTo(
      z.startMs + MIN_ZOOM_GAP_MS - CAMERA_DEFAULTS.leadInMs,
      0,
    );
    expect(
      command(
        run(after, { kind: "moveZoom", id: fresh.id, deltaMs: 1, snapMs: 0 }),
      ).kind,
    ).toBe("setZoomRange");
  });

  it("places a click over the last zoom before it when nothing fits after", () => {
    const newId = ids();
    const scene = applyCommand(
      readonlyScene(),
      {
        kind: "addZoom",
        marker: { actionId: "act-3", offsetMs: 0 },
        target: { kind: "element", anchorId: "a-checkout" },
        scale: 1.8,
      },
      newId,
    );
    const s = setup(scene);
    const z = s.model.zooms[0];
    if (!z) throw new Error("fixture");
    // Fixture guard: the zoom runs to the end of the take, so there is no
    // "after" to place into.
    expect(z.endMs).toBe(s.model.durationMs);
    const cmd = command(
      run(s, { kind: "addZoom", atMs: z.startMs + 100, snapMs: 0 }),
    );
    if (cmd.kind !== "addZoom") throw new Error("kind");
    expect(cmd.note).toMatch(/Placed before the zoom at 0:08\.6/);
    const after = setup(applyCommand(s.scene, cmd, newId));
    const fresh = after.model.zooms.find((x) => x.id !== z.id);
    if (!fresh) throw new Error("fixture");
    expect(fresh.startMs).toBeCloseTo(z.startMs - MIN_ZOOM_GAP_MS, 0);
    // Closer than a full return: the camera glides on to the zoom after it.
    expect(fresh.endMs).toBeCloseTo(z.startMs, 6);
  });

  it("refuses when no slot fits anywhere, and says so", () => {
    const newId = ids();
    let scene = applyCommand(
      readonlyScene(),
      {
        kind: "addZoom",
        marker: { actionId: "act-1", offsetMs: 0 },
        target: { kind: "element", anchorId: "a-row" },
        scale: 1.8,
      },
      newId,
    );
    scene = applyCommand(
      scene,
      {
        kind: "setZoomRange",
        id: "gen-1",
        start: { actionId: "act-1", offsetMs: 0 },
        end: { actionId: "act-3", offsetMs: 0 },
      },
      newId,
    );
    const s = setup(scene);
    const z = s.model.zooms[0];
    if (!z) throw new Error("fixture");
    // Fixture guard: an authored end at the take's end, so every later
    // start is inside it, and too little take before it for a start
    // `MIN_ZOOM_GAP_MS` earlier (with an element zoom's lead-in) to fit.
    expect(z.endAuthored).toBe(true);
    expect(z.endMs).toBe(s.model.durationMs);
    expect(z.startMs - MIN_ZOOM_GAP_MS + CAMERA_DEFAULTS.leadInMs).toBeLessThan(
      0,
    );
    expect(reason(run(s, { kind: "addZoom", atMs: 4000, snapMs: 0 }))).toMatch(
      /no room/,
    );
  });

  it("does not snap a moved placement onto a tick", () => {
    // The snap is for the author's click. A placement the resolver moved is
    // not the click any more: snapping it could pull the zoom back into the
    // clearance it was just moved out of.
    const newId = ids();
    const scene = applyCommand(
      readonlyScene(),
      {
        kind: "addZoom",
        marker: { actionId: "act-1", offsetMs: 0 },
        target: { kind: "element", anchorId: "a-row" },
        scale: 1.8,
      },
      newId,
    );
    const s = setup(scene);
    const z = s.model.zooms[0];
    const t1 = s.model.clip.ticks[0];
    if (!z || !t1) throw new Error("fixture");
    // A band wide enough to reach the moved instant from act-1's tick (it
    // lands 1000ms past it): the fixture guard below goes red if it does
    // not, since a snap could not have happened there and the marker
    // assertion after it would prove nothing.
    const snapMs = 1200;
    const cmd = command(
      run(s, { kind: "addZoom", atMs: z.startMs + 100, snapMs }),
    );
    if (cmd.kind !== "addZoom") throw new Error("kind");
    // Fixture guard: the moved instant is inside act-1's snap band, so a
    // snapped marker would read { act-1, 0 }; unsnapped, it keeps its
    // distance from that tick.
    const placedMs = z.startMs + MIN_ZOOM_GAP_MS - CAMERA_DEFAULTS.leadInMs;
    expect(Math.abs(placedMs - t1.atMs)).toBeLessThan(snapMs);
    expect(placedMs - t1.atMs).not.toBe(0);
    expect(cmd.marker).toEqual({
      actionId: "act-1",
      offsetMs: placedMs - t1.atMs,
    });
  });
});

describe("addZoom clearance", () => {
  // F5: `addZoom` gated on CONTAINMENT while every drag gesture gated on the
  // room between two zooms, so clicking one millisecond past an existing
  // zoom's end authored a zoom that `moveZoom` and both `zoomEdge` branches
  // then refused to touch — a segment the author can only delete. Since
  // 2026-10-09 both answer to one rule (`MIN_ZOOM_GAP_MS` between starts),
  // and a zoom closer than a full return is a glide, not a collision.
  // One id source per fixture, shared with whatever the test adds next:
  // `ids()` mints a fresh counter each call, so a second call would hand out
  // "gen-1" again and the schema would refuse the duplicate camera id.
  function oneZoom() {
    const newId = ids();
    return {
      ...setup(
        applyCommand(
          readonlyScene(),
          {
            kind: "addZoom",
            marker: { actionId: "act-1", offsetMs: 0 },
            target: { kind: "element", anchorId: "a-row" },
            scale: 1.8,
          },
          newId,
        ),
      ),
      newId,
    };
  }

  // Red on the room rule, which moved this add out by the room (1550ms past
  // the end) with a "Placed after" note.
  it("places an add just past an existing zoom's end where it was asked, and the camera glides between them", () => {
    const s = oneZoom();
    const z = s.model.zooms[0];
    if (!z) throw new Error("fixture");
    const atMs = z.endMs + 1;
    // Premise: past the gap from the zoom's start, and closer than a full
    // return from its end.
    expect(atMs - z.startMs).toBeGreaterThan(
      MIN_ZOOM_GAP_MS - CAMERA_DEFAULTS.leadInMs,
    );
    const cmd = command(run(s, { kind: "addZoom", atMs, snapMs: 0 }));
    if (cmd.kind !== "addZoom") throw new Error("kind");
    expect(cmd.note).toBeUndefined();
    const after = setup(applyCommand(s.scene, cmd, s.newId));
    const fresh = after.model.zooms.find((x) => x.id !== z.id);
    const first = after.model.zooms.find((x) => x.id === z.id);
    if (!fresh || !first) throw new Error("fixture");
    expect(fresh.startMs).toBeCloseTo(atMs, 0);
    // The render glides: the first zoom's segment ends where the new one
    // starts, rather than returning to full frame between them.
    expect(first.endMs).toBeCloseTo(fresh.startMs, 6);
  });

  it("moves an add under the gap out to the bound a drag would", () => {
    const s = oneZoom();
    const z = s.model.zooms[0];
    if (!z) throw new Error("fixture");
    const atMs = z.startMs + 500;
    expect(atMs - z.startMs).toBeLessThan(MIN_ZOOM_GAP_MS); // guard
    const cmd = command(run(s, { kind: "addZoom", atMs, snapMs: 0 }));
    if (cmd.kind !== "addZoom") throw new Error("kind");
    expect(cmd.note).toMatch(/Placed after/);
    const after = setup(applyCommand(s.scene, cmd, s.newId));
    const fresh = after.model.zooms.find((x) => x.id !== z.id);
    if (!fresh) throw new Error("fixture");
    expect(fresh.startMs).toBeCloseTo(
      z.startMs + MIN_ZOOM_GAP_MS - CAMERA_DEFAULTS.leadInMs,
      0,
    );
  });

  it("authors nothing a drag would then refuse to move", () => {
    const s = oneZoom();
    const z = s.model.zooms[0];
    if (!z) throw new Error("fixture");
    // The first instant the add is allowed. Every drag of the zoom it
    // creates must then be legal — that is the invariant the containment
    // gate broke.
    const atMs = z.startMs + MIN_ZOOM_GAP_MS - CAMERA_DEFAULTS.leadInMs;
    const added = command(run(s, { kind: "addZoom", atMs, snapMs: 0 }));
    expect(added.kind).toBe("addZoom");

    const after = setup(applyCommand(s.scene, added, s.newId));
    const fresh = after.model.zooms.find((x) => x.id !== z.id);
    if (!fresh) throw new Error("fixture");
    for (const deltaMs of [1, -1]) {
      expect(
        command(
          run(after, { kind: "moveZoom", id: fresh.id, deltaMs, snapMs: 0 }),
        ).kind,
      ).toBe("setZoomRange");
    }
  });
});

describe("zoom edges and bodies", () => {
  function zoomed() {
    // A single id source shared across both commands: `ids()` mints a fresh
    // counter each call, so two separate calls here would each hand out
    // "gen-1" and the second `addZoom` would collide with the first.
    const newId = ids();
    let scene = applyCommand(
      readonlyScene(),
      {
        kind: "addZoom",
        marker: { actionId: "act-2", offsetMs: 0 },
        target: { kind: "element", anchorId: "a-row" },
        scale: 1.8,
      },
      newId,
    );
    scene = applyCommand(
      scene,
      {
        kind: "addZoom",
        marker: { actionId: "act-3", offsetMs: 0 },
        target: { kind: "element", anchorId: "a-checkout" },
        scale: 1.8,
      },
      newId,
    );
    return setup(scene);
  }

  it("moves a body by its delta, keeping an automatic end automatic", () => {
    const s = zoomed();
    const z = s.model.zooms[0];
    if (!z) throw new Error("fixture");
    const cmd = command(
      run(s, { kind: "moveZoom", id: z.id, deltaMs: 200, snapMs: 0 }),
    );
    expect(cmd).toEqual({
      kind: "setZoomRange",
      id: z.id,
      start: markerAt(s.model, z.startMs + 200, 0),
      end: null,
    });
  });

  it("returns null for a body that did not move", () => {
    const s = zoomed();
    const z = s.model.zooms[0];
    if (!z) throw new Error("fixture");
    expect(
      run(s, { kind: "moveZoom", id: z.id, deltaMs: 0, snapMs: 0 }),
    ).toBeNull();
  });

  it("authors an end by dragging the end cap, keeping the start marker as stored", () => {
    const s = zoomed();
    const z = s.model.zooms[0];
    if (!z) throw new Error("fixture");
    const cmd = command(
      run(s, {
        kind: "zoomEdge",
        id: z.id,
        edge: "end",
        toMs: z.startMs + 1500,
        snapMs: 0,
      }),
    );
    expect(cmd).toEqual({
      kind: "setZoomRange",
      id: z.id,
      start: z.marker,
      end: markerAt(s.model, z.startMs + 1500, 0),
    });
  });

  // An end may stay in until the next zoom — the camera glides on from
  // there — but not past its start, which is an instant the camera has
  // already left for the next zoom. Red on the room rule for the first
  // half (it refused any end within 1550ms of the next zoom); red without
  // the `endsAfter` clause for the second.
  it("authors an end up to the next zoom's start, and refuses one past it, naming it", () => {
    const s = zoomed();
    const [a, b] = s.model.zooms;
    if (!a || !b) throw new Error("fixture");
    const upTo = run(s, {
      kind: "zoomEdge",
      id: a.id,
      edge: "end",
      toMs: b.startMs - 100,
      snapMs: 0,
    });
    expect(command(upTo).kind).toBe("setZoomRange");
    const past = run(s, {
      kind: "zoomEdge",
      id: a.id,
      edge: "end",
      toMs: b.startMs + 100,
      snapMs: 0,
    });
    expect(reason(past)).toContain(b.id);
    expect(reason(past)).toMatch(/not past it/);
  });

  // The start cap sits where the push-in sets off (`ZoomSeg.departMs`), so
  // a drop there is a departure: the zoom lands `zoomInMs` later, and the
  // snap is judged where the cap was dropped (review, 2026-10-22).
  it("lands a dropped start cap its push-in's length later, snapped where it was dropped", () => {
    const s = zoomed();
    const z = s.model.zooms[1];
    const tick = s.model.clip.ticks.find((t) => t.actionId === "act-2");
    if (!z || !tick) throw new Error("fixture");
    expect(s.model.zoomInMs).toBeGreaterThan(0); // guard
    const cmd = command(
      run(s, {
        kind: "zoomEdge",
        id: z.id,
        edge: "start",
        toMs: tick.atMs + 30,
        snapMs: 50,
      }),
    );
    expect(cmd).toEqual({
      kind: "setZoomRange",
      id: z.id,
      start: { actionId: "act-2", offsetMs: s.model.zoomInMs },
      end: null,
    });
  });

  it("sets a start cap dragged off the take's start off at the start", () => {
    const s = zoomed();
    const z = s.model.zooms[0];
    if (!z) throw new Error("fixture");
    const cmd = command(
      run(s, {
        kind: "zoomEdge",
        id: z.id,
        edge: "start",
        toMs: -400,
        snapMs: 0,
      }),
    );
    if (cmd.kind !== "setZoomRange") throw new Error("kind");
    const first = s.model.clip.ticks[0];
    if (!first) throw new Error("fixture");
    expect(first.atMs + cmd.start.offsetMs).toBe(s.model.zoomInMs);
  });

  it("refuses a start whose push-in would land after an authored end, and says when", () => {
    const s = zoomed();
    const z = s.model.zooms[0];
    if (!z) throw new Error("fixture");
    const ended = setup(
      applyCommand(
        s.scene,
        {
          kind: "setZoomRange",
          id: z.id,
          start: z.marker,
          end: markerAt(s.model, z.startMs + 1500, 0),
        },
        ids(),
      ),
    );
    const e = ended.model.zooms.find((x) => x.id === z.id);
    if (!e) throw new Error("fixture");
    // Inside the drawn block, so only the landing can be what refuses it.
    const toMs = e.startMs + 500;
    expect(toMs).toBeLessThan(e.drawnEndMs - MIN_SEGMENT_MS); // guard
    const r = run(ended, {
      kind: "zoomEdge",
      id: e.id,
      edge: "start",
      toMs,
      snapMs: 0,
    });
    expect(reason(r)).toMatch(/would land at .*after its end/);
  });

  it("refuses ends crossing", () => {
    const s = zoomed();
    const z = s.model.zooms[0];
    if (!z) throw new Error("fixture");
    expect(
      reason(
        run(s, {
          kind: "zoomEdge",
          id: z.id,
          edge: "start",
          toMs: z.endMs,
          snapMs: 0,
        }),
      ),
    ).toMatch(/before it starts|cross/);
  });

  it("refuses a body pushed past the take's end", () => {
    const s = zoomed();
    const z = s.model.zooms[1];
    if (!z) throw new Error("fixture");
    expect(
      reason(
        run(s, {
          kind: "moveZoom",
          id: z.id,
          deltaMs: s.model.durationMs,
          snapMs: 0,
        }),
      ),
    ).toMatch(/after the video/);
  });

  // `collides` used to only look FORWARD — a zoom starting after the
  // candidate range — so dragging a start cap or a body BACKWARD toward a
  // preceding zoom returned a normal command instead of a refusal. These
  // three pin the symmetric rule: (a) and (b) are the two shapes the
  // reviewer found live commands for, now one millisecond inside the gap;
  // (c) is the fixture guard proving the same drag at the gap is not
  // refused, so (a)/(b) are failing on the collision and not on some
  // unrelated bound.
  it("refuses a start dragged backward to within the gap of the preceding zoom, naming it", () => {
    const s = zoomed();
    const [a, b] = s.model.zooms;
    if (!a || !b) throw new Error("fixture");
    const r = run(s, {
      kind: "zoomEdge",
      id: b.id,
      edge: "start",
      // The start cap is the departure; the zoom lands `zoomInMs` later.
      toMs: a.startMs + MIN_ZOOM_GAP_MS - 1 - s.model.zoomInMs,
      snapMs: 0,
    });
    expect(reason(r)).toContain(a.id);
  });

  it("refuses a body moved backward to within the gap of the preceding zoom, naming it", () => {
    const s = zoomed();
    const [a, b] = s.model.zooms;
    if (!a || !b) throw new Error("fixture");
    const r = run(s, {
      kind: "moveZoom",
      id: b.id,
      deltaMs: -(b.startMs - a.startMs - MIN_ZOOM_GAP_MS + 1),
      snapMs: 0,
    });
    expect(reason(r)).toContain(a.id);
  });

  it("fixture guard: a start dragged to the gap is not refused", () => {
    const s = zoomed();
    const [a, b] = s.model.zooms;
    if (!a || !b) throw new Error("fixture");
    const cmd = command(
      run(s, {
        kind: "zoomEdge",
        id: b.id,
        edge: "start",
        toMs: a.startMs + MIN_ZOOM_GAP_MS - s.model.zoomInMs,
        snapMs: 0,
      }),
    );
    expect(cmd.kind).toBe("setZoomRange");
  });

  // F1: dragging the end edge into the start marker's own snap band
  // collapses both onto the same step at the same instant — the zoom
  // equivalent of the addMask/maskEdge collapse above.
  it("refuses an end dragged into the start's snap band, naming no length", () => {
    const scene = {
      ...readonlyScene(),
      camera: [
        {
          id: "cam-1",
          kind: "zoom" as const,
          anchorId: "a-checkout",
          marker: { actionId: "act-1", offsetMs: 0 },
          end: { actionId: "act-2", offsetMs: 0 },
          scale: 1.8,
        },
      ],
    };
    const s = setup(scene);
    const z = s.model.zooms[0];
    if (!z) throw new Error("fixture");
    const r = run(s, {
      kind: "zoomEdge",
      id: z.id,
      edge: "end",
      toMs: z.startMs + 150,
      snapMs: 400,
    });
    expect(reason(r)).toMatch(/no length/);
  });
});

describe("zoom spacing", () => {
  /** The readonly take with act-1 and act-2 recorded as clicks, and the
   *  zooms the save generates for it (`zoomsForClicks`). */
  function autoZoomed() {
    const base = readonlyScene();
    const actions = base.actions.map((a) =>
      (a.id === "act-1" || a.id === "act-2") && a.anchorId !== null
        ? {
            id: a.id,
            kind: "click" as const,
            anchorId: a.anchorId,
            timestamp: a.timestamp,
            marker: a.marker,
          }
        : a,
    );
    const { camera, zoomsSkipped } = zoomsForClicks(
      actions,
      base.meta.capture.viewport,
    );
    const s = setup({ ...base, actions, camera });
    return { s, camera, zoomsSkipped };
  }
  const moveZoom = (s: ReturnType<typeof setup>, id: string, deltaMs: number) =>
    run(s, { kind: "moveZoom", id, deltaMs, snapMs: 0 });

  // The take the author's five-click recording stands for: two clicks 2.8s
  // apart, inside the ~4s the room rule needed, which got one zoom from it.
  // Auto-zoom now zooms both, and the lane must let the author drag either
  // anywhere the one rule allows. Red on the room rule: B's start was 1550ms
  // from A's drawn end, and any drag toward A was refused.
  it("lets an auto-generated close zoom be dragged anywhere the gap allows", () => {
    const { s, camera, zoomsSkipped } = autoZoomed();
    const [a, b] = s.model.zooms;
    if (!a || !b) throw new Error("fixture: two zooms");
    // Premises: auto-zoom made both, they are its zooms, and they sit closer
    // than the ~4s the room rule asked for.
    expect(zoomsSkipped).toEqual([]);
    expect(camera.slice(0, 2).map((c) => c.marker.actionId)).toEqual([
      "act-1",
      "act-2",
    ]);
    expect([a.id, b.id]).toEqual([camera[0]?.id, camera[1]?.id]);
    const startGap = b.startMs - a.startMs;
    expect(startGap).toBeCloseTo(2800, 6);
    expect(b.startMs - a.endMs).toBeLessThanOrEqual(1550);

    const toTheGap = -(startGap - MIN_ZOOM_GAP_MS);
    expect(command(moveZoom(s, b.id, -1000)).kind).toBe("setZoomRange");
    expect(command(moveZoom(s, b.id, toTheGap)).kind).toBe("setZoomRange");
    expect(command(moveZoom(s, a.id, -toTheGap)).kind).toBe("setZoomRange");
    const inside = reason(moveZoom(s, b.id, toTheGap - 1));
    expect(inside).toContain(a.id);
    expect(inside).toContain(`${MIN_ZOOM_GAP_MS}ms`);

    // And what the allowed drag renders is the glide, not a return: A's
    // segment ends where B starts.
    const after = setup(
      applyCommand(s.scene, command(moveZoom(s, b.id, -1000)), ids()),
    );
    const [a2, b2] = after.model.zooms;
    if (!a2 || !b2) throw new Error("fixture: two zooms after");
    expect(a2.endMs).toBeCloseTo(b2.startMs, 6);
  });

  // The bound is the glide's, asked of the render: B moved to exactly the
  // gap glides for `ZOOM_GLIDE_MIN_MS`, and any closer for less — so the
  // gesture's number cannot drift from `insertNeutralKeys` unnoticed.
  it("refuses exactly the starts whose glide would be shorter than ZOOM_GLIDE_MIN_MS", () => {
    const { s } = autoZoomed();
    const [a, b] = s.model.zooms;
    if (!a || !b) throw new Error("fixture: two zooms");
    /** The length of the move that arrives at B, rendered with B moved by
     *  `deltaMs` unchecked. */
    const glideAfter = (deltaMs: number): number => {
      const after = setup(
        applyCommand(
          s.scene,
          {
            kind: "setZoomRange",
            id: b.id,
            start: markerAt(s.model, b.startMs + deltaMs, 0),
            end: null,
          },
          ids(),
        ),
      );
      const b2 = after.model.zooms.find((z) => z.id === b.id);
      const key = after.ctx.resolved?.cameraKeys.find(
        (k) => Math.abs(k.outputTimeMs - (b2?.startMs ?? Number.NaN)) < 1e-6,
      );
      if (!key) throw new Error("fixture: no key arrives at B");
      return key.transitionMs;
    };
    const fits = -(b.startMs - a.startMs - MIN_ZOOM_GAP_MS);
    const short = fits - 10;
    expect(command(moveZoom(s, b.id, fits)).kind).toBe("setZoomRange");
    expect(reason(moveZoom(s, b.id, short))).toContain(a.id);
    expect(glideAfter(fits)).toBeCloseTo(ZOOM_GLIDE_MIN_MS, 6);
    expect(glideAfter(short)).toBeLessThan(ZOOM_GLIDE_MIN_MS);
  });

  // The authored-span rule, on a drag. `placeZoom` asks the same per-zoom
  // check (`collisionWith`), so a regression in it now goes red here and in
  // the addZoom cases both. Red without the `startsInside` clause.
  it("refuses a drag that starts a zoom inside another's authored span, naming it", () => {
    const newId = ids();
    let scene = applyCommand(
      readonlyScene(),
      {
        kind: "addZoom",
        marker: { actionId: "act-1", offsetMs: 0 },
        target: { kind: "element", anchorId: "a-row" },
        scale: 1.8,
      },
      newId,
    );
    const [first] = scene.camera;
    if (!first) throw new Error("fixture: no zoom");
    scene = applyCommand(
      scene,
      {
        kind: "setZoomRange",
        id: first.id,
        start: first.marker,
        end: { actionId: "act-2", offsetMs: 0 },
      },
      newId,
    );
    scene = applyCommand(
      scene,
      {
        kind: "addZoom",
        marker: { actionId: "act-3", offsetMs: 0 },
        target: { kind: "element", anchorId: "a-checkout" },
        scale: 1.8,
      },
      newId,
    );
    const s = setup(scene);
    const [a, b] = s.model.zooms;
    if (!a || !b) throw new Error("fixture: two zooms");
    expect(a.endAuthored).toBe(true); // guard
    const inside = a.endMs - 200;
    const past = a.endMs + 200;
    // Guards: both clear the start gap, so only the span can refuse one.
    expect(inside - a.startMs).toBeGreaterThanOrEqual(MIN_ZOOM_GAP_MS);
    expect(b.startMs - past).toBeGreaterThanOrEqual(MIN_ZOOM_GAP_MS);
    expect(reason(moveZoom(s, b.id, inside - b.startMs))).toContain(a.id);
    expect(command(moveZoom(s, b.id, past - b.startMs)).kind).toBe(
      "setZoomRange",
    );
  });

  // A pair already tighter than the gap — a document from before the rule,
  // or two zooms an author laid by hand — stays movable away from its
  // neighbour, and only a drag that narrows it further is refused. Away
  // means on its own side: dragged across the neighbour to land inside the
  // gap on the far side, the two swap order closer than a glide, and a
  // wider distance than before does not make that a widening. Red on a
  // "not worse" clause that compares distance alone.
  it("allows a drag that widens a gap already under the minimum, and refuses one that narrows it or crosses inside it", () => {
    const newId = ids();
    let scene = applyCommand(
      readonlyScene(),
      {
        kind: "addZoom",
        marker: { actionId: "act-1", offsetMs: 0 },
        target: { kind: "element", anchorId: "a-row" },
        scale: 1.8,
      },
      newId,
    );
    scene = applyCommand(
      scene,
      {
        kind: "addZoom",
        // A on act-1's tick takes the lead-in (`applyCommand`); B, between
        // ticks, keeps its offset — so this puts B's start 600ms after A's.
        marker: {
          actionId: "act-2",
          offsetMs: CAMERA_DEFAULTS.leadInMs + 600 - 2800,
        },
        target: { kind: "element", anchorId: "a-checkout" },
        scale: 1.8,
      },
      newId,
    );
    const s = setup(scene);
    const [a, b] = s.model.zooms;
    if (!a || !b) throw new Error("fixture: two zooms");
    expect(b.startMs - a.startMs).toBeCloseTo(600, 6); // premise
    expect(command(moveZoom(s, b.id, 200)).kind).toBe("setZoomRange");
    expect(command(moveZoom(s, b.id, 1)).kind).toBe("setZoomRange");
    expect(reason(moveZoom(s, b.id, -1))).toContain(a.id);
    // A across B: 700ms past it is a wider distance than 600, still inside
    // the gap; 1100ms past it clears the gap.
    expect(700).toBeLessThan(MIN_ZOOM_GAP_MS); // guard
    expect(1_100).toBeGreaterThanOrEqual(MIN_ZOOM_GAP_MS); // guard
    expect(reason(moveZoom(s, a.id, 600 + 700))).toContain(b.id);
    expect(command(moveZoom(s, a.id, 600 + 1_100)).kind).toBe("setZoomRange");
  });
});

describe("addMask", () => {
  it("adds a quarter-frame box centred on the cursor, ending at the next tick", () => {
    const s = setup();
    const t2 = s.model.clip.ticks[1];
    const t3 = s.model.clip.ticks[2];
    if (!t2 || !t3) throw new Error("fixture");
    const at = t3.atMs - 500;
    const cmd = command(run(s, { kind: "addMask", atMs: at, snapMs: 0 }));
    if (cmd.kind !== "addMask") throw new Error("kind");
    expect(cmd.start.actionId).toBe(markerAt(s.model, at, 0).actionId);
    expect(landsAt(s, cmd.start)).toBeCloseTo(at, 0);
    expect(cmd.end).toEqual({ actionId: "act-3", sourceOffsetMs: 0 });
    expect(cmd.rect.width).toBe(VIEWPORT.width / 2);
    expect(cmd.rect.height).toBe(VIEWPORT.height / 2);
    expect(cmd.note).toBeUndefined();
  });

  it("ends MASK_DEFAULT_MS later when no tick is that close", () => {
    const s = setup();
    const t1 = s.model.clip.ticks[0];
    if (!t1) throw new Error("fixture");
    const at = t1.atMs + 10;
    const cmd = command(run(s, { kind: "addMask", atMs: at, snapMs: 0 }));
    if (cmd.kind !== "addMask") throw new Error("kind");
    expect(cmd.end.actionId).toBe(
      markerAt(s.model, at + MASK_DEFAULT_MS, 0).actionId,
    );
    expect(landsAt(s, cmd.end)).toBeCloseTo(at + MASK_DEFAULT_MS, 0);
  });

  it("centres the box and says so when the pointer has no sample there", () => {
    const s = setup(readonlyScene(), proceduralBundle({ cursorSamples: [] }));
    const cmd = command(run(s, { kind: "addMask", atMs: 1000, snapMs: 0 }));
    if (cmd.kind !== "addMask") throw new Error("kind");
    expect(cmd.rect.x + cmd.rect.width / 2).toBe(VIEWPORT.width / 2);
    expect(cmd.note).toMatch(/centre/);
  });

  it("refuses with the playhead at the end", () => {
    const s = setup();
    expect(
      reason(
        run(s, { kind: "addMask", atMs: s.model.durationMs - 10, snapMs: 0 }),
      ),
    ).toMatch(/playhead earlier/);
  });

  // F1: with a non-zero snapMs, a playhead inside the magnetic band just
  // before a tick makes the naive start AND end both snap onto that same
  // tick at offset 0 — a zero-length mask that used to reach
  // `SceneDocumentSchema.parse` as a raw ZodError instead of a refusal.
  // Pushing the end onto the NEXT tick (rather than refusing outright) is
  // possible here because act-2 is not the last step.
  it("ends on the next tick when snapping would collapse the mask onto one step", () => {
    const s = setup();
    const t2 = s.model.clip.ticks[1];
    const t3 = s.model.clip.ticks[2];
    if (!t2 || !t3) throw new Error("fixture");
    const at = t2.atMs - 50; // inside the 400ms snap band, just before t2
    const cmd = command(run(s, { kind: "addMask", atMs: at, snapMs: 400 }));
    expect(cmd).toMatchObject({
      kind: "addMask",
      start: { actionId: t2.actionId, sourceOffsetMs: 0 },
      end: { actionId: t3.actionId, sourceOffsetMs: 0 },
    });
  });
});

describe("a mask drawn after a cut (audit run 1)", () => {
  // Red: maskPointAt copying the output offset into sourceOffsetMs — with a
  // piece already removed between the step and the drop, that names a frame
  // later than the one on screen where the mask was dropped.
  it("stores the frame on screen where it was dropped, not the output offset", () => {
    const base = readonlyScene();
    const scene = {
      ...base,
      edits: {
        ...base.edits,
        removed: [
          {
            id: "r-1",
            start: { actionId: "act-1", sourceOffsetMs: 200 },
            end: { actionId: "act-1", sourceOffsetMs: 600 },
          },
        ],
      },
    };
    const s = setup(scene);
    const t1 = s.model.clip.ticks[0];
    if (!t1) throw new Error("fixture");
    const at = t1.atMs + 1000;
    const cmd = command(run(s, { kind: "addMask", atMs: at, snapMs: 0 }));
    if (cmd.kind !== "addMask") throw new Error("kind");
    // Premise: the cut sits between act-1 and the drop, so the output and
    // source offsets differ by its 400 ms.
    expect(markerAt(s.model, at, 0)).toEqual({
      actionId: "act-1",
      offsetMs: 1000,
    });
    expect(cmd.start).toEqual({ actionId: "act-1", sourceOffsetMs: 1400 });
    expect(landsAt(s, cmd.start)).toBeCloseTo(at, 0);
  });
});

describe("mask edges", () => {
  it("moves one end and keeps the other's stored marker", () => {
    const scene = applyCommand(
      readonlyScene(),
      {
        kind: "addMask",
        rect: { x: 0, y: 0, width: 10, height: 10 },
        start: { actionId: "act-1", sourceOffsetMs: 0 },
        end: { actionId: "act-2", sourceOffsetMs: -100 },
      },
      ids(),
    );
    const s = setup(scene);
    const m = s.model.masks[0];
    if (!m) throw new Error("fixture");
    const cmd = command(
      run(s, {
        kind: "maskEdge",
        id: m.id,
        edge: "end",
        toMs: m.endMs + 800,
        snapMs: 0,
      }),
    );
    if (cmd.kind !== "setMaskRange") throw new Error("kind");
    expect(cmd.start).toEqual({ actionId: "act-1", sourceOffsetMs: 0 });
    expect(landsAt(s, cmd.end)).toBeCloseTo(m.endMs + 800, 0);
  });

  it("refuses to move a whole-take mask's ends", () => {
    const scene = {
      ...readonlyScene(),
      edits: {
        ...readonlyScene().edits,
        masks: [{ id: "old", rect: { x: 0, y: 0, width: 9, height: 9 } }],
      },
    };
    const s = setup(scene);
    expect(
      reason(
        run(s, {
          kind: "maskEdge",
          id: "old",
          edge: "end",
          toMs: 100,
          snapMs: 0,
        }),
      ),
    ).toMatch(/whole video/);
  });

  // F1: dragging the end edge into the start's own snap band collapses both
  // markers onto act-1 at offset 0. `maskEdge` (unlike `addMask`) has no
  // "next step" to push to, so this must refuse rather than author a
  // zero-length range the schema would reject with a raw ZodError.
  it("refuses dragging the end into the start's snap band, naming no length", () => {
    const scene = applyCommand(
      readonlyScene(),
      {
        kind: "addMask",
        rect: { x: 0, y: 0, width: 10, height: 10 },
        start: { actionId: "act-1", sourceOffsetMs: 0 },
        end: { actionId: "act-2", sourceOffsetMs: -100 },
      },
      ids(),
    );
    const s = setup(scene);
    const m = s.model.masks[0];
    if (!m) throw new Error("fixture");
    const r = run(s, {
      kind: "maskEdge",
      id: m.id,
      edge: "end",
      toMs: m.startMs + 150,
      snapMs: 400,
    });
    expect(reason(r)).toMatch(/no length/);
  });
});

/**
 * A take whose pace drag has something to measure against.
 *
 * Copied from the old file's `pacedSetup`, mechanically adapted to Task 7's
 * `buildLaneModel`, which now takes `scene` as part of its args.
 */
function pacedSetup() {
  const scene = readonlyScene();
  const bundle = stillCursorBundle({ source: "capture" });
  const resolved = resolvePlan(planScene(scene), bundle, scene);
  const view = buildTimelineView({ scene, bundle, resolved });
  const model = buildLaneModel({
    scene,
    view,
    bundle,
    resolved,
    hoverReport: null,
  });
  return { scene, bundle, model, view, resolved };
}

describe("resolveGap", () => {
  // The inspector's number field ends here, the same way its zoom lead-in
  // field ends in `resolveCameraOffset`: a value the drag would refuse is
  // refused in the same words when it is typed. `input[type=number]` with
  // `min="0"` stops the spinner and not a keystroke, so both of these reach
  // the handler as typed — and before 2026-09-08 they travelled all the way
  // to `SceneDocumentSchema.parse` and came back to the author as a Zod path
  // for their own typo.
  it("refuses a negative pause in the control's own words", () => {
    const { view } = pacedSetup();
    const result = resolveGap(view, "act-2", -500);
    expect(isRefusal(result)).toBe(true);
    const reason = isRefusal(result) ? result.reason : "";
    expect(reason).not.toMatch(/edits|durationMs|nonnegative/);
    expect(reason).toMatch(/shorter than nothing/i);
    // And it names the move that does what a negative was reaching for.
    expect(reason).toMatch(/0/);
  });

  it("refuses a pause that is not a number", () => {
    // `Number("abc")`, which is what the field hands over for typed text.
    const { view } = pacedSetup();
    const result = resolveGap(view, "act-2", Number.NaN);
    expect(isRefusal(result)).toBe(true);
    expect(isRefusal(result) ? result.reason : "").toMatch(/number of millis/i);
  });

  it("authors a zero, which is a value and not a refusal", () => {
    // The control for both of the above: zero is how an author cuts dead
    // air, and a guard that swept it up with the negatives would take that
    // out of reach.
    const { view } = pacedSetup();
    expect(resolveGap(view, "act-2", 0)).toEqual({
      kind: "setGap",
      afterActionId: "act-2",
      durationMs: 0,
    });
  });
});

/**
 * Shift+Delete's measuring half.
 *
 * The command is atomic and knows nothing about rendered time; this is where
 * the span comes from and where every refusal is put in the author's words,
 * exactly as `resolveGap` does for the inspector's number field.
 */

// F6: `markerAt` throws on a take with zero ticks (kept — a take always has
// steps in practice). `resolveGesture` must refuse by name before it ever
// reaches that call, or a take with no steps left to render turns a
// gesture into an uncaught exception instead of a message the author reads.
describe("resolveGesture on a take with no steps", () => {
  it("refuses by name instead of throwing out of markerAt", () => {
    const scene = {
      ...readonlyScene(),
      actions: [],
      camera: [],
      edits: {
        ...readonlyScene().edits,
        masks: [],
        holds: [],
        gaps: [],
      },
    };
    const s = setup(scene as ReturnType<typeof readonlyScene>);
    expect(s.model.clip.ticks.length).toBe(0); // fixture guard
    const r = run(s, { kind: "addZoom", atMs: 0, snapMs: 0 });
    expect(reason(r)).toMatch(/no steps/);
  });
});

// The hover ghost and the zoom a click adds are drawn from `placeZoom`, and
// once added the lane draws the zoom from the document's own smoothness. At
// smoothness 1 the pull-out is 1150ms, not the default's 925, so a fixed
// default length drew the ghost 225ms short of what the click then added.
// Red on a `placeZoom` that reads the default smoothness.
describe("a new zoom's length at the document's smoothness", () => {
  it("places a zoom as long as the lane draws it once added", () => {
    const base = readonlyScene();
    const scene = { ...base, motion: { ...MOTION_DEFAULTS, smoothness: 1 } };
    const longOut = motionTimings(1).zoomOutMs;
    expect(longOut).toBeGreaterThan(CAMERA_DEFAULTS.zoomOutMs); // guard
    const unrendered = (doc: SceneDocument) =>
      buildLaneModel({
        scene: doc,
        view: buildTimelineView({ scene: doc, resolved: null }),
        bundle: null,
        resolved: null,
        hoverReport: null,
      });
    const [act1] = scene.actions;
    if (!act1?.anchorId) throw new Error("fixture: act-1 has an anchor");
    const model = unrendered(scene);
    expect(model.zooms).toEqual([]); // guard: nothing in the way
    const placement = placeZoom(model, act1.timestamp);
    if (placement.kind !== "placed") throw new Error(placement.reason);
    expect(placement.atMs).toBe(act1.timestamp); // guard: not moved
    const added = unrendered(
      applyCommand(
        scene,
        {
          kind: "addZoom",
          marker: { actionId: act1.id, offsetMs: 0 },
          target: { kind: "element", anchorId: act1.anchorId },
          scale: 1.8,
        },
        ids(),
      ),
    );
    const [zoom] = added.zooms;
    if (!zoom) throw new Error("no zoom drawn");
    expect(zoom.endMs).toBeLessThan(added.durationMs); // guard: not clamped
    expect(placement.endMs - placement.startMs).toBe(zoom.endMs - zoom.startMs);
    expect(zoom.endMs - zoom.startMs).toBe(
      CAMERA_DEFAULTS.neutral.zoomHoldMs + longOut,
    );
  });
});

describe("pieceEdge", () => {
  it("hands a piece's dragged edge to the split tool", () => {
    const base = readonlyScene();
    const s = setup({
      ...base,
      edits: {
        ...base.edits,
        splits: [{ id: "s1", at: { actionId: "act-2", sourceOffsetMs: 0 } }],
        removed: [
          {
            id: "r1",
            start: { actionId: "act-2", sourceOffsetMs: 0 },
            end: { actionId: "act-2", sourceOffsetMs: 1000 },
          },
        ],
      },
    });
    expect(
      command(
        run(s, { kind: "pieceEdge", start: null, side: "end", deltaMs: 400 }),
      ),
    ).toEqual({
      kind: "setRemovedEdge",
      id: "r1",
      start: { actionId: "act-2", sourceOffsetMs: 400 },
    });
  });
});

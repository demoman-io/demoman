import {
  type FrameBundle,
  planScene,
  resolvePlan,
  type Timeline,
  toOutputMs,
} from "@demoman/compositor";
import type { SceneDocument, SourcePoint } from "@demoman/scene-schema";
import { describe, expect, it } from "vitest";
import { proceduralBundle } from "../../../../../packages/replay-engine/test/helpers/bundles";
import { readonlyScene } from "../../../../../packages/replay-engine/test/helpers/scenes";
import { isRefusal } from "../../../pages/src/editor/gestures";
import {
  PIECE_MIN_MS,
  piecesOf,
  resolvePieceEdge,
  resolvePieceRemoval,
  resolveSplit,
  sourcePointAt,
} from "../../../pages/src/editor/pieces";

const at = (actionId: string, sourceOffsetMs = 0): SourcePoint => ({
  actionId,
  sourceOffsetMs,
});

function withEdits(
  edits: Partial<SceneDocument["edits"]>,
  base = readonlyScene(),
): SceneDocument {
  return { ...base, edits: { ...base.edits, ...edits } };
}

function timelineOf(scene: SceneDocument, bundle: FrameBundle): Timeline {
  return resolvePlan(planScene(scene), bundle, scene).timeline;
}

/** Output ms of a source point on `timeline`, against `bundle`'s markers. */
function outAt(
  point: SourcePoint,
  bundle: FrameBundle,
  timeline: Timeline,
): number {
  const marker = bundle.markers.find((m) => m.actionId === point.actionId);
  if (marker === undefined) throw new Error(`no marker for ${point.actionId}`);
  return toOutputMs(timeline, marker.sourceTimeMs + point.sourceOffsetMs);
}

describe("the fixture", () => {
  it("is three steps with markers at 400, 3200 and 9000", () => {
    expect(
      proceduralBundle().markers.map((m) => [m.actionId, m.sourceTimeMs]),
    ).toEqual([
      ["act-1", 400],
      ["act-2", 3200],
      ["act-3", 9000],
    ]);
  });
});

describe("sourcePointAt", () => {
  it("names the step before the instant and how far past it", () => {
    const bundle = proceduralBundle();
    const scene = readonlyScene();
    const timeline = timelineOf(scene, bundle);
    const point = sourcePointAt(
      bundle,
      timeline,
      outAt(at("act-2", 700), bundle, timeline),
    );
    expect(point).toEqual(at("act-2", 700));
  });

  it("carries a negative offset from the first step in the lead-in", () => {
    const bundle = proceduralBundle();
    const timeline = timelineOf(readonlyScene(), bundle);
    // Premise: output 100 is before act-1's frame.
    expect(outAt(at("act-1"), bundle, timeline)).toBeGreaterThan(100);
    const point = sourcePointAt(bundle, timeline, 100);
    expect(point?.actionId).toBe("act-1");
    expect(point?.sourceOffsetMs).toBeLessThan(0);
  });

  it("is null for frames with no markers", () => {
    const bundle = { ...proceduralBundle(), markers: [] };
    const timeline = timelineOf(readonlyScene(), proceduralBundle());
    expect(sourcePointAt(bundle, timeline, 500)).toBeNull();
  });
});

describe("piecesOf", () => {
  it("is one piece for a take with no splits", () => {
    const bundle = proceduralBundle();
    const scene = readonlyScene();
    const timeline = timelineOf(scene, bundle);
    const { pieces, joins } = piecesOf(scene, bundle, timeline);
    expect(pieces).toEqual([
      {
        startMs: 0,
        endMs: timeline.outputDurationMs,
        start: null,
        end: null,
        before: null,
        after: null,
      },
    ]);
    expect(joins).toEqual([]);
  });

  it("makes three pieces of two splits", () => {
    const bundle = proceduralBundle();
    const scene = withEdits({
      splits: [
        { id: "s1", at: at("act-1", 1000) },
        { id: "s2", at: at("act-2", 500) },
      ],
    });
    const timeline = timelineOf(scene, bundle);
    const a = outAt(at("act-1", 1000), bundle, timeline);
    const b = outAt(at("act-2", 500), bundle, timeline);
    const { pieces } = piecesOf(scene, bundle, timeline);
    expect(pieces).toEqual([
      {
        startMs: 0,
        endMs: a,
        start: null,
        end: at("act-1", 1000),
        before: null,
        after: null,
      },
      {
        startMs: a,
        endMs: b,
        start: at("act-1", 1000),
        end: at("act-2", 500),
        before: null,
        after: null,
      },
      {
        startMs: b,
        endMs: timeline.outputDurationMs,
        start: at("act-2", 500),
        end: null,
        before: null,
        after: null,
      },
    ]);
  });

  it("leaves a join where a removed piece was, and the pieces either side carry its ends", () => {
    const bundle = proceduralBundle();
    const scene = withEdits({
      splits: [
        { id: "s1", at: at("act-1", 1000) },
        { id: "s2", at: at("act-2", 500) },
      ],
      removed: [{ id: "r1", start: at("act-1", 1000), end: at("act-2", 500) }],
    });
    const timeline = timelineOf(scene, bundle);
    // Premise: the piece really was removed from the output axis.
    expect(timeline.cuts.map((c) => c.ids)).toEqual([["r1"]]);
    const { pieces, joins } = piecesOf(scene, bundle, timeline);
    expect(pieces).toHaveLength(2);
    expect(joins).toEqual([
      {
        removedId: "r1",
        atMs: pieces[0]?.endMs,
        index: 0,
        srcStartMs: 1400,
        srcEndMs: 3700,
      },
    ]);
    expect(pieces[0]?.end).toEqual(at("act-1", 1000));
    expect(pieces[1]?.start).toEqual(at("act-2", 500));
    expect(pieces[1]?.startMs).toBe(pieces[0]?.endMs);
  });

  // Final review C1: the splits a removed piece was cut between stay stored,
  // and the order they were made in must not decide which point the piece
  // after the join starts at — or deleting that piece overlaps the first
  // removal, and restoring the first brings nothing back.
  it("starts the piece after a join at the removal's end, whichever split was made first", () => {
    const bundle = proceduralBundle();
    const scene = withEdits({
      // The right edge split first.
      splits: [
        { id: "s2", at: at("act-2", 500) },
        { id: "s1", at: at("act-1", 1000) },
      ],
      removed: [{ id: "r1", start: at("act-1", 1000), end: at("act-2", 500) }],
    });
    const timeline = timelineOf(scene, bundle);
    const { pieces } = piecesOf(scene, bundle, timeline);
    expect(pieces).toHaveLength(2);
    expect(pieces[0]?.end).toEqual(at("act-1", 1000));
    expect(pieces[1]?.start).toEqual(at("act-2", 500));
  });

  // Review Focus 4: two neighbours removed one after the other.
  it("fans two joins at one instant, one per stored piece", () => {
    const bundle = proceduralBundle();
    const scene = withEdits({
      removed: [
        { id: "r1", start: at("act-1", 1000), end: at("act-2", 0) },
        { id: "r2", start: at("act-2", 0), end: at("act-2", 500) },
      ],
    });
    const timeline = timelineOf(scene, bundle);
    // Premise: the compositor merged the two into one stretch.
    expect(timeline.cuts.map((c) => c.ids)).toEqual([["r1", "r2"]]);
    const { joins, pieces } = piecesOf(scene, bundle, timeline);
    expect(joins.map((j) => [j.removedId, j.index])).toEqual([
      ["r1", 0],
      ["r2", 1],
    ]);
    expect(new Set(joins.map((j) => j.atMs)).size).toBe(1);
    // The merged stretch's outer ends bound the pieces either side.
    expect(pieces[0]?.end).toEqual(at("act-1", 1000));
    expect(pieces[1]?.start).toEqual(at("act-2", 500));
  });

  // Review Focus 1: a split inside a hold lands on the hold's one source
  // instant, so two of them make a piece with no length.
  it("drops the zero-length piece two splits in a hold make", () => {
    const bundle = proceduralBundle();
    const scene = withEdits({
      holds: [
        {
          id: "h1",
          marker: { actionId: "act-2", offsetMs: 1000 },
          durationMs: 2000,
        },
      ],
      splits: [
        { id: "s1", at: at("act-2", 1000) },
        { id: "s2", at: at("act-2", 1000) },
      ],
    });
    const timeline = timelineOf(scene, bundle);
    // Premise: the timeline really has a hold there.
    expect(timeline.segments.some((s) => s.kind === "hold")).toBe(true);
    const { pieces } = piecesOf(scene, bundle, timeline);
    expect(pieces).toHaveLength(2);
    expect(pieces.every((p) => p.endMs > p.startMs)).toBe(true);
  });
});

describe("resolveSplit", () => {
  it("splits at the playhead", () => {
    const bundle = proceduralBundle();
    const scene = readonlyScene();
    const timeline = timelineOf(scene, bundle);
    const result = resolveSplit(
      scene,
      bundle,
      timeline,
      outAt(at("act-2", 700), bundle, timeline),
    );
    expect(result).toEqual({ kind: "split", at: at("act-2", 700) });
  });

  it("refuses with nothing rendered", () => {
    const result = resolveSplit(readonlyScene(), null, null, 1000);
    expect(isRefusal(result)).toBe(true);
    if (isRefusal(result)) expect(result.reason).toMatch(/rendered/);
  });

  it("refuses at either end of the take", () => {
    const bundle = proceduralBundle();
    const scene = readonlyScene();
    const timeline = timelineOf(scene, bundle);
    for (const ms of [0, timeline.outputDurationMs]) {
      const result = resolveSplit(scene, bundle, timeline, ms);
      expect(isRefusal(result), String(ms)).toBe(true);
    }
  });

  // Final review I2: in a hold every instant is one source instant, so a
  // second split there lands where the first did. Refused, by name.
  it("refuses a second split inside one hold, naming the pause", () => {
    const bundle = proceduralBundle();
    const hold = {
      id: "h1",
      marker: { actionId: "act-2", offsetMs: 1000 },
      durationMs: 2000,
    };
    const first = withEdits({ holds: [hold] });
    const timeline = timelineOf(first, bundle);
    const segment = timeline.segments.find((x) => x.kind === "hold");
    // Premise: there is a hold, two seconds of output on one source instant.
    expect(segment?.srcStartMs).toBe(segment?.srcEndMs);
    if (segment === undefined) throw new Error("no hold");
    const inside = (segment.outStartMs + segment.outEndMs) / 2;
    const once = resolveSplit(first, bundle, timeline, inside);
    expect(isRefusal(once)).toBe(false);
    if (once === null || isRefusal(once) || once.kind !== "split")
      throw new Error("no split");
    const second = withEdits({
      holds: [hold],
      splits: [{ id: "s1", at: once.at }],
    });
    const again = resolveSplit(
      second,
      bundle,
      timelineOf(second, bundle),
      inside + 300,
    );
    expect(isRefusal(again)).toBe(true);
    if (isRefusal(again)) expect(again.reason).toMatch(/pause/);
  });

  it("refuses a split exactly where one already is", () => {
    const bundle = proceduralBundle();
    const scene = withEdits({ splits: [{ id: "s1", at: at("act-2", 700) }] });
    const timeline = timelineOf(scene, bundle);
    const result = resolveSplit(
      scene,
      bundle,
      timeline,
      outAt(at("act-2", 700), bundle, timeline),
    );
    expect(isRefusal(result)).toBe(true);
    if (isRefusal(result)) expect(result.reason).toMatch(/already/);
  });
});

describe("resolvePieceRemoval", () => {
  it("removes the piece the selection names", () => {
    const bundle = proceduralBundle();
    const scene = withEdits({ splits: [{ id: "s1", at: at("act-2", 700) }] });
    const timeline = timelineOf(scene, bundle);
    const { pieces } = piecesOf(scene, bundle, timeline);
    const second = pieces[1];
    if (second === undefined) throw new Error("no second piece");
    expect(resolvePieceRemoval(pieces, second.start)).toEqual({
      kind: "removePiece",
      start: at("act-2", 700),
      end: null,
    });
  });

  // Review Focus 3.
  it("refuses to remove the only piece left", () => {
    const bundle = proceduralBundle();
    const scene = readonlyScene();
    const { pieces } = piecesOf(scene, bundle, timelineOf(scene, bundle));
    const result = resolvePieceRemoval(pieces, null);
    expect(isRefusal(result)).toBe(true);
    if (isRefusal(result)) expect(result.reason).toMatch(/nothing/);
  });

  it("refuses a piece that is no longer there", () => {
    const bundle = proceduralBundle();
    const scene = withEdits({ splits: [{ id: "s1", at: at("act-2", 700) }] });
    const { pieces } = piecesOf(scene, bundle, timelineOf(scene, bundle));
    expect(isRefusal(resolvePieceRemoval(pieces, at("act-9", 0)))).toBe(true);
  });
});

// The mockup the author approved on 2026-10-22: every piece's edge drags.
// Inward cuts frames off that piece; outward brings back frames removed
// beside it, never more than were removed.
describe("resolvePieceEdge", () => {
  /** Two splits around act-2's first second, that second removed. */
  function cutScene() {
    const bundle = proceduralBundle();
    const scene = withEdits({
      splits: [
        { id: "s1", at: at("act-2", 0) },
        { id: "s2", at: at("act-2", 1000) },
      ],
      removed: [{ id: "r1", start: at("act-2", 0), end: at("act-2", 1000) }],
    });
    const timeline = timelineOf(scene, bundle);
    const { pieces } = piecesOf(scene, bundle, timeline);
    // Premise: two pieces either side of one join.
    expect(pieces).toHaveLength(2);
    return { bundle, scene, timeline, pieces };
  }

  it("tells each piece what was removed beside it", () => {
    const { pieces } = cutScene();
    const beside = { removedId: "r1", srcStartMs: 3200, srcEndMs: 4200 };
    expect(pieces[0]?.before).toBeNull();
    expect(pieces[0]?.after).toEqual(beside);
    expect(pieces[1]?.before).toEqual(beside);
    expect(pieces[1]?.after).toBeNull();
  });

  it("brings back frames from the range after a piece's end", () => {
    const { bundle, timeline, pieces } = cutScene();
    expect(
      resolvePieceEdge(bundle, timeline, pieces, null, "end", 400),
    ).toEqual({ kind: "setRemovedEdge", id: "r1", start: at("act-2", 400) });
  });

  it("restores the range outright when the end is pulled past it", () => {
    const { bundle, timeline, pieces } = cutScene();
    expect(
      resolvePieceEdge(bundle, timeline, pieces, null, "end", 5000),
    ).toEqual({ kind: "restorePiece", id: "r1" });
  });

  it("brings back frames from the range before a piece's start", () => {
    const { bundle, timeline, pieces } = cutScene();
    const start = pieces[1]?.start ?? null;
    expect(
      resolvePieceEdge(bundle, timeline, pieces, start, "start", -400),
    ).toEqual({ kind: "setRemovedEdge", id: "r1", end: at("act-2", 600) });
    expect(
      resolvePieceEdge(bundle, timeline, pieces, start, "start", -5000),
    ).toEqual({ kind: "restorePiece", id: "r1" });
  });

  it("refuses to stretch an edge with nothing removed beside it", () => {
    const { bundle, timeline, pieces } = cutScene();
    const result = resolvePieceEdge(
      bundle,
      timeline,
      pieces,
      pieces[1]?.start ?? null,
      "end",
      300,
    );
    expect(isRefusal(result)).toBe(true);
    if (isRefusal(result)) expect(result.reason).toMatch(/only move in/);
  });

  it("grows the range beside an edge dragged inward", () => {
    const { bundle, timeline, pieces } = cutScene();
    const first = pieces[0];
    if (first === undefined) throw new Error("no first piece");
    expect(
      resolvePieceEdge(bundle, timeline, pieces, null, "end", -500),
    ).toEqual({
      kind: "setRemovedEdge",
      id: "r1",
      start: sourcePointAt(bundle, timeline, first.endMs - 500),
    });
  });

  it("removes a new stretch where nothing was removed beside the edge", () => {
    const bundle = proceduralBundle();
    const scene = withEdits({ splits: [{ id: "s1", at: at("act-2", 0) }] });
    const timeline = timelineOf(scene, bundle);
    const { pieces } = piecesOf(scene, bundle, timeline);
    const second = pieces[1];
    if (second === undefined) throw new Error("no second piece");
    expect(
      resolvePieceEdge(bundle, timeline, pieces, second.start, "start", 600),
    ).toEqual({
      kind: "removePiece",
      start: at("act-2", 0),
      end: sourcePointAt(bundle, timeline, second.startMs + 600),
    });
  });

  it("never drags a piece shorter than its least length", () => {
    const { bundle, timeline, pieces } = cutScene();
    const first = pieces[0];
    if (first === undefined) throw new Error("no first piece");
    expect(
      resolvePieceEdge(bundle, timeline, pieces, null, "end", -1_000_000),
    ).toEqual({
      kind: "setRemovedEdge",
      id: "r1",
      start: sourcePointAt(bundle, timeline, first.startMs + PIECE_MIN_MS),
    });
  });

  it("does nothing for a drag that went nowhere", () => {
    const { bundle, timeline, pieces } = cutScene();
    expect(resolvePieceEdge(bundle, timeline, pieces, null, "end", 0)).toBe(
      null,
    );
  });
});

// Review 2026-10-22: a removed piece that removed no frames had no join, so
// nothing on the timeline could ever take it back out of the document.
describe("a removed piece that removed no frames", () => {
  it("still gets a join, saying why it removed nothing", () => {
    const full = proceduralBundle();
    const bundle = {
      ...full,
      markers: full.markers.filter((m) => m.actionId !== "act-3"),
    };
    const scene = withEdits({
      removed: [{ id: "r1", start: at("act-2", 0), end: at("act-3", 0) }],
    });
    const timeline = timelineOf(scene, bundle);
    // Premise: the compositor could not place it.
    expect(timeline.unplacedCuts.map((u) => u.ids)).toEqual([["r1"]]);
    const { joins } = piecesOf(scene, bundle, timeline);
    expect(joins).toHaveLength(1);
    expect(joins[0]).toMatchObject({
      removedId: "r1",
      atMs: outAt(at("act-2", 0), bundle, timeline),
    });
    expect(joins[0]?.unplaced).toMatch(/act-3/);
  });
});

// Review 2026-10-22: the "only piece left" refusal counted pieces the trim
// already leaves out of the export.
describe("removing the last piece inside the trim", () => {
  it("is refused, though pieces outside the trim remain", () => {
    const bundle = proceduralBundle();
    const scene = withEdits({ splits: [{ id: "s1", at: at("act-2", 0) }] });
    const { pieces } = piecesOf(scene, bundle, timelineOf(scene, bundle));
    const second = pieces[1];
    if (second === undefined) throw new Error("no second piece");
    // The trim's head inside the second piece: only it is exported.
    const trim = { headMs: second.startMs + 100, tailMs: second.endMs };
    const result = resolvePieceRemoval(pieces, second.start, trim);
    expect(isRefusal(result)).toBe(true);
    if (isRefusal(result)) expect(result.reason).toMatch(/trim/);
    // Positive control: with no trim the same piece is removable.
    expect(isRefusal(resolvePieceRemoval(pieces, second.start))).toBe(false);
  });
});

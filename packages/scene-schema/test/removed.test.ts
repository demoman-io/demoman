import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { SceneDocument, SourcePoint } from "../src/document";
import { migrateToCurrent } from "../src/migrations";
import { stepsInsideRemoved } from "../src/removed";

const base = (): SceneDocument =>
  migrateToCurrent(
    JSON.parse(
      readFileSync(
        join(__dirname, "..", "fixtures", "readonly-scene.json"),
        "utf8",
      ),
    ),
  );

const at = (actionId: string, sourceOffsetMs = 0): SourcePoint => ({
  actionId,
  sourceOffsetMs,
});

function inside(start: SourcePoint | null, end: SourcePoint | null): string[] {
  const doc = base();
  const scene = {
    ...doc,
    edits: { ...doc.edits, removed: [{ id: "r", start, end }] },
  };
  return [...stepsInsideRemoved(scene)].sort();
}

describe("stepsInsideRemoved", () => {
  it("the fixture is four steps, act-1..act-4", () => {
    expect(base().actions.map((a) => a.id)).toEqual([
      "act-1",
      "act-2",
      "act-3",
      "act-4",
    ]);
  });

  it("covers the start step through the step before the end", () => {
    expect(inside(at("act-2"), at("act-4"))).toEqual(["act-2", "act-3"]);
  });

  it("a range starting after a step's own instant leaves that step in", () => {
    expect(inside(at("act-2", 200), at("act-4"))).toEqual(["act-3"]);
  });

  it("a range ending after a step's instant takes that step", () => {
    expect(inside(at("act-2"), at("act-4", 50))).toEqual([
      "act-2",
      "act-3",
      "act-4",
    ]);
  });

  it("a null start runs from the first step", () => {
    expect(inside(null, at("act-3"))).toEqual(["act-1", "act-2"]);
  });

  it("a null end runs through the last step", () => {
    expect(inside(at("act-3"), null)).toEqual(["act-3", "act-4"]);
  });

  it("a range naming a step not in the log takes nothing", () => {
    expect(inside(at("gone"), at("act-4"))).toEqual([]);
  });
});

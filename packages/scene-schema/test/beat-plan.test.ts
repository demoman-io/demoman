import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SceneDocumentSchema } from "../src/index";

// biome-ignore lint/suspicious/noExplicitAny: a raw JSON fixture the tests edit
type Raw = any;

const validDocument = (): Raw =>
  JSON.parse(
    readFileSync(
      join(__dirname, "..", "fixtures", "readonly-scene.json"),
      "utf8",
    ),
  );

const withPlan = (): Raw => {
  const doc = validDocument();
  doc.pacing = {
    beats: [{ beforeActionId: doc.actions[0].id, restMs: 400, arriveMs: 900 }],
    tailMs: 600,
  };
  doc.camera.push({
    id: "cam-plan",
    kind: "zoom",
    anchorId: doc.anchors[0].id,
    marker: { actionId: doc.actions[0].id, offsetMs: 0 },
    arrives: "return",
  });
  return doc;
};

describe("beat plan fields", () => {
  it("parses and round-trips pacing and arrives", () => {
    const doc = SceneDocumentSchema.parse(withPlan());
    // Red if `pacing` is dropped from SceneDocumentSchema (zod strips it).
    expect(doc.pacing?.beats[0]).toEqual(withPlan().pacing.beats[0]);
    expect(doc.pacing?.tailMs).toBe(600);
    // Red if `arrives` is dropped from CameraEvent.
    expect(doc.camera.at(-1)?.arrives).toBe("return");
    expect(SceneDocumentSchema.parse(JSON.parse(JSON.stringify(doc)))).toEqual(
      doc,
    );
  });

  it("parses a document without them to a value with no such key", () => {
    const raw = validDocument();
    // Premise: the fixture carries neither.
    expect("pacing" in raw).toBe(false);
    expect(raw.camera.some((c: Raw) => "arrives" in c)).toBe(false);
    const doc = SceneDocumentSchema.parse(raw);
    // Red if `pacing` gains a default (or is written as undefined).
    expect("pacing" in doc).toBe(false);
    expect(doc.camera.every((c) => !("arrives" in c))).toBe(true);
  });

  it("refuses a negative restMs, arriveMs or tailMs and an unknown arrives", () => {
    const edits: ((d: Raw) => void)[] = [
      (d) => {
        d.pacing.beats[0].restMs = -1;
      },
      (d) => {
        d.pacing.beats[0].arriveMs = -1;
      },
      (d) => {
        d.pacing.tailMs = -1;
      },
      (d) => {
        d.camera.at(-1).arrives = "cut";
      },
    ];
    for (const edit of edits) {
      const doc = withPlan();
      edit(doc);
      // Red if the `.min(0)` / enum on the edited field is removed.
      expect(SceneDocumentSchema.safeParse(doc).success).toBe(false);
    }
    // Premise: the unedited plan is valid, so the refusals above are the edits'.
    expect(SceneDocumentSchema.safeParse(withPlan()).success).toBe(true);
  });
});

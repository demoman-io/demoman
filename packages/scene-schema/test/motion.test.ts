import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CURRENT_SCHEMA_VERSION,
  CURSOR_DEFAULTS,
  CURSOR_POLISH_DEFAULTS,
  CursorSchema,
  DemoScriptSchema,
  MOTION_DEFAULTS,
  MotionSchema,
  migrateToCurrent,
  SCRIPT_VERSION,
  SCRIPT_VERSION_KIT,
  SCRIPT_VERSION_MOTION,
  SceneDocumentSchema,
  scriptFromTake,
} from "../src/index";

const validDocument = () =>
  JSON.parse(
    readFileSync(
      join(__dirname, "..", "fixtures", "readonly-scene.json"),
      "utf8",
    ),
  );

describe("cursor tilt and click bounce", () => {
  it("accepts both ends of each range, and a cursor block with neither", () => {
    expect(CursorSchema.safeParse(CURSOR_DEFAULTS).success).toBe(true);
    for (const tilt of [0, 0.5, 1]) {
      expect(CursorSchema.safeParse({ ...CURSOR_DEFAULTS, tilt }).success).toBe(
        true,
      );
    }
    for (const clickBounce of [0, 1, 2]) {
      expect(
        CursorSchema.safeParse({ ...CURSOR_DEFAULTS, clickBounce }).success,
      ).toBe(true);
    }
  });

  it("refuses a value outside the slider's range", () => {
    for (const bad of [
      { tilt: -0.01 },
      { tilt: 1.01 },
      { clickBounce: -0.01 },
      { clickBounce: 2.01 },
      { tilt: "0.5" },
    ]) {
      expect(
        CursorSchema.safeParse({ ...CURSOR_DEFAULTS, ...bad }).success,
        JSON.stringify(bad),
      ).toBe(false);
    }
  });

  it("keeps the polish defaults out of CURSOR_DEFAULTS, which the v4 -> v5 migration spreads", () => {
    expect(CURSOR_POLISH_DEFAULTS).toEqual({ tilt: 0.5, clickBounce: 1 });
    expect(Object.isFrozen(CURSOR_POLISH_DEFAULTS)).toBe(true);
    expect("tilt" in CURSOR_DEFAULTS).toBe(false);
    expect("clickBounce" in CURSOR_DEFAULTS).toBe(false);
    // The defaults must themselves be values the schema accepts.
    expect(
      CursorSchema.safeParse({ ...CURSOR_DEFAULTS, ...CURSOR_POLISH_DEFAULTS })
        .success,
    ).toBe(true);
  });
});

describe("an agent script's look.cursor", () => {
  // At the version tilt and click bounce need; the version gate has its own
  // cases below.
  const script = (cursor: Record<string, unknown>) => ({
    scriptVersion: SCRIPT_VERSION_MOTION,
    name: "look",
    target: "https://app.example.com/",
    steps: [{ do: "click", on: { stableId: "go" } }],
    look: { cursor },
  });

  // The reason the fields are optional: `look.cursor` IS `CursorSchema`, so
  // a required field would refuse every script written before it.
  it("still accepts a cursor written before tilt and click bounce existed", () => {
    const r = DemoScriptSchema.safeParse(script({ ...CURSOR_DEFAULTS }));
    expect(r.success, JSON.stringify(r.error?.issues)).toBe(true);
  });

  it("carries tilt and click bounce through, and refuses them out of range, naming the path", () => {
    const r = DemoScriptSchema.safeParse(
      script({ ...CURSOR_DEFAULTS, tilt: 0.25, clickBounce: 1.5 }),
    );
    expect(r.data?.look?.cursor).toMatchObject({
      tilt: 0.25,
      clickBounce: 1.5,
    });
    const bad = DemoScriptSchema.safeParse(
      script({ ...CURSOR_DEFAULTS, clickBounce: 3 }),
    );
    expect(bad.error?.issues.map((i) => i.path.join("."))).toEqual([
      "look.cursor.clickBounce",
    ]);
  });
});

describe("the motion block", () => {
  it("defaults to smoothness 0.5, blur 0.5, follow on — frozen, and itself valid", () => {
    expect(MOTION_DEFAULTS).toEqual({
      smoothness: 0.5,
      blur: 0.5,
      follow: true,
    });
    expect(Object.isFrozen(MOTION_DEFAULTS)).toBe(true);
    expect(MotionSchema.safeParse(MOTION_DEFAULTS).success).toBe(true);
  });

  it("accepts both ends of each range", () => {
    for (const motion of [
      { smoothness: 0, blur: 0, follow: false },
      { smoothness: 1, blur: 1, follow: true },
    ]) {
      expect(MotionSchema.safeParse(motion).success).toBe(true);
    }
  });

  it("refuses an out-of-range or missing field", () => {
    for (const bad of [
      { smoothness: -0.1, blur: 0.5, follow: true },
      { smoothness: 1.1, blur: 0.5, follow: true },
      { smoothness: 0.5, blur: -0.1, follow: true },
      { smoothness: 0.5, blur: 1.1, follow: true },
      { smoothness: 0.5, blur: 0.5, follow: "yes" },
      { smoothness: 0.5, blur: 0.5 },
    ]) {
      expect(MotionSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(
        false,
      );
    }
  });

  it("is optional on the document: a document without it still validates, and one with it carries it", () => {
    const old = validDocument();
    // Premise: the fixture is a document written before the block existed.
    expect("motion" in old).toBe(false);
    expect("tilt" in old.cursor).toBe(false);
    expect("clickBounce" in old.cursor).toBe(false);
    const parsed = SceneDocumentSchema.parse(old);
    expect(parsed.motion).toBeUndefined();
    // And it survives the migration door unchanged, at the same version.
    expect(migrateToCurrent(validDocument()).motion).toBeUndefined();

    const withMotion = {
      ...validDocument(),
      motion: { smoothness: 0.2, blur: 0, follow: false },
    };
    expect(SceneDocumentSchema.parse(withMotion).motion).toEqual({
      smoothness: 0.2,
      blur: 0,
      follow: false,
    });
  });

  it("refuses a document whose motion block is out of range — the document door checks it too", () => {
    const doc = {
      ...validDocument(),
      motion: { smoothness: 2, blur: 0.5, follow: true },
    };
    expect(SceneDocumentSchema.safeParse(doc).success).toBe(false);
  });

  it("is a widening, not a new version", () => {
    // 13 is mask ends in source time (audit run 1), not the motion block.
    expect(CURRENT_SCHEMA_VERSION).toBe(13);
  });
});

describe("an agent script's look.motion", () => {
  const TUNED = { smoothness: 0.2, blur: 0, follow: false };
  const script = (scriptVersion: number, look?: Record<string, unknown>) => ({
    scriptVersion,
    name: "motion",
    target: "https://app.example.com/",
    steps: [{ do: "click", on: { stableId: "go" } }],
    ...(look === undefined ? {} : { look }),
  });

  // Premise for every case below: the tuned block is not the defaults, so a
  // carry that fell back to them could not pass for one that kept it.
  it("tunes away from the defaults", () => {
    expect(TUNED).not.toEqual(MOTION_DEFAULTS);
  });

  it("still accepts a script written before motion existed, at every older version", () => {
    for (const r of [
      DemoScriptSchema.safeParse(script(SCRIPT_VERSION)),
      DemoScriptSchema.safeParse(
        script(SCRIPT_VERSION, { canvas: { aspect: "16:9" } }),
      ),
      DemoScriptSchema.safeParse(script(SCRIPT_VERSION_KIT, { kit: "Acme" })),
    ]) {
      expect(r.success, JSON.stringify(r.error?.issues)).toBe(true);
      expect(r.data?.look?.motion).toBeUndefined();
    }
  });

  it("carries a motion block at its own version, and refuses one out of range by path", () => {
    const r = DemoScriptSchema.safeParse(
      script(SCRIPT_VERSION_MOTION, { motion: TUNED }),
    );
    expect(r.success, JSON.stringify(r.error?.issues)).toBe(true);
    expect(r.data?.look?.motion).toEqual(TUNED);
    // The newest thing a script uses sets its version, so a kit rides too.
    expect(
      DemoScriptSchema.safeParse(
        script(SCRIPT_VERSION_MOTION, { kit: "Acme", motion: TUNED }),
      ).success,
    ).toBe(true);
    const bad = DemoScriptSchema.safeParse(
      script(SCRIPT_VERSION_MOTION, { motion: { ...TUNED, blur: 2 } }),
    );
    expect(bad.error?.issues.map((i) => i.path.join("."))).toEqual([
      "look.motion.blur",
    ]);
  });

  // `SCRIPT_VERSION_MOTION`: a build from before 2026-10-08 reads `look`
  // loosely and would drop the block and record the default camera.
  it("refuses a motion block at a version from before it, naming scriptVersion", () => {
    for (const v of [SCRIPT_VERSION, SCRIPT_VERSION_KIT]) {
      const r = DemoScriptSchema.safeParse(script(v, { motion: TUNED }));
      expect(r.error?.issues.map((i) => i.path.join("."))).toEqual([
        "scriptVersion",
      ]);
      expect(r.error?.issues[0]?.message).toMatch(/look\.motion/);
    }
  });

  it("derives a tuned take to a script that keeps its motion, and an untuned one to the version-1 script it always was", () => {
    const tuned = SceneDocumentSchema.parse({
      ...validDocument(),
      motion: TUNED,
    });
    const d = scriptFromTake(tuned);
    if (d.outcome !== "derived") throw new Error(`derived: ${d.outcome}`);
    expect(d.draft.scriptVersion).toBe(SCRIPT_VERSION_MOTION);
    expect(d.draft.look.motion).toEqual(TUNED);
    const parsed = DemoScriptSchema.safeParse(d.draft);
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
    expect(parsed.data?.look?.motion).toEqual(TUNED);

    const plain = scriptFromTake(SceneDocumentSchema.parse(validDocument()));
    if (plain.outcome !== "derived")
      throw new Error(`derived: ${plain.outcome}`);
    expect(plain.draft.scriptVersion).toBe(SCRIPT_VERSION);
    expect("motion" in plain.draft.look).toBe(false);
  });
});

// `look.cursor.tilt` and `clickBounce` came in with `motion`, and a build
// from before them reads `look.cursor` through a non-strict `CursorSchema`:
// it strips both keys and records the default lean and press. So they need
// the same version as `motion`. Red without the gate (a version-1 script with
// a tilt parses), and red on a derive that bumped the version for `motion`
// alone (a take with only its tilt tuned derived a version-1 script).
describe("an agent script's cursor tilt and click bounce", () => {
  const script = (scriptVersion: number, cursor: Record<string, unknown>) => ({
    scriptVersion,
    name: "polish",
    target: "https://app.example.com/",
    steps: [{ do: "click", on: { stableId: "go" } }],
    look: { cursor: { ...CURSOR_DEFAULTS, ...cursor } },
  });

  it("refuses either key at a version from before it, naming scriptVersion", () => {
    for (const v of [SCRIPT_VERSION, SCRIPT_VERSION_KIT]) {
      for (const cursor of [{ tilt: 0 }, { clickBounce: 0 }]) {
        const r = DemoScriptSchema.safeParse(script(v, cursor));
        expect(
          r.error?.issues.map((i) => i.path.join(".")),
          JSON.stringify({ v, cursor }),
        ).toEqual(["scriptVersion"]);
        expect(r.error?.issues[0]?.message).toMatch(/look\.cursor/);
      }
    }
  });

  it("accepts both at their own version, and a cursor with neither at any", () => {
    const r = DemoScriptSchema.safeParse(
      script(SCRIPT_VERSION_MOTION, { tilt: 0, clickBounce: 0 }),
    );
    expect(r.success, JSON.stringify(r.error?.issues)).toBe(true);
    expect(r.data?.look?.cursor).toMatchObject({ tilt: 0, clickBounce: 0 });
    const plain = DemoScriptSchema.safeParse(script(SCRIPT_VERSION, {}));
    expect(plain.success, JSON.stringify(plain.error?.issues)).toBe(true);
  });

  it("derives a take whose tilt was tuned, with no motion block, at the version that keeps it", () => {
    const doc = SceneDocumentSchema.parse(validDocument());
    expect(doc.motion).toBeUndefined(); // guard: no motion to bump it
    const tuned = { ...doc, cursor: { ...doc.cursor, tilt: 0 } };
    const d = scriptFromTake(tuned);
    if (d.outcome !== "derived") throw new Error(`derived: ${d.outcome}`);
    expect(d.draft.scriptVersion).toBe(SCRIPT_VERSION_MOTION);
    expect(d.draft.look.cursor.tilt).toBe(0);
    const parsed = DemoScriptSchema.safeParse(d.draft);
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
  });
});

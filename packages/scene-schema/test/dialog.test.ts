import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CURRENT_SCHEMA_VERSION,
  DemoScriptSchema,
  DIALOG_KINDS,
  type DialogRecord,
  DialogRecordSchema,
  migrateToCurrent,
  minimumScriptVersion,
  SCRIPT_VERSION_INPUTS,
  SceneDocumentSchema,
  ScriptStepSchema,
  scriptFromTake,
} from "../src/index.js";

const click = (dialog: unknown) => ({
  do: "click",
  on: { stableId: "x" },
  dialog,
});

const record = (over: Partial<DialogRecord> = {}): DialogRecord => ({
  kind: "confirm",
  host: "example.com",
  message: "Delete it?",
  answer: "dismiss",
  by: "script",
  beatMs: 900,
  ...over,
});

const fixture = (): Record<string, unknown> =>
  JSON.parse(
    readFileSync(
      join(__dirname, "..", "fixtures", "readonly-scene.json"),
      "utf8",
    ),
  );

/** The fixture with its first click carrying these dialogs. */
const takeWith = (dialogs: DialogRecord[]) => {
  const doc = SceneDocumentSchema.parse(fixture());
  const c = doc.actions.find((a) => a.kind === "click");
  if (c?.kind !== "click") throw new Error("fixture has no click");
  c.dialogs = dialogs;
  const checked = SceneDocumentSchema.safeParse(doc);
  expect(checked.success, JSON.stringify(checked.error?.issues)).toBe(true);
  const d = scriptFromTake(doc);
  if (d.outcome !== "derived") throw new Error(`got ${d.outcome}`);
  const step = d.draft.steps.find(
    (s) => s.do === "click" && s.recorded === c.id,
  );
  return { draft: d.draft, step };
};

describe("a click's dialog", () => {
  it('parses a click with dialog "dismiss", "accept" and { text: "Acme" }', () => {
    for (const dialog of ["dismiss", "accept", { text: "Acme" }]) {
      const r = ScriptStepSchema.safeParse(click(dialog));
      expect(r.success, JSON.stringify(r.error?.issues)).toBe(true);
    }
  });

  it('refuses dialog on a type step and dialog: "maybe"', () => {
    const onType = ScriptStepSchema.safeParse({
      do: "type",
      into: { stableId: "x" },
      text: "t",
      dialog: "dismiss",
    });
    expect(onType.success).toBe(false);
    expect(JSON.stringify(onType.error?.issues)).toContain("dialog");
    const maybe = ScriptStepSchema.safeParse(click("maybe"));
    expect(maybe.success).toBe(false);
    expect(maybe.error?.issues.some((i) => i.path.includes("dialog"))).toBe(
      true,
    );
  });

  it("declares version 9, and a version-8 pin is raised to it", () => {
    const script = {
      name: "n",
      target: "https://example.com",
      steps: [click("dismiss")],
    };
    expect(SCRIPT_VERSION_INPUTS).toBe(9);
    expect(minimumScriptVersion(script as never)).toBe(9);
    // An older build refuses 9 by its own version sentence; here the pin is
    // raised, never kept below what the step needs.
    const r = DemoScriptSchema.safeParse({ ...script, scriptVersion: 8 });
    expect(r.success, JSON.stringify(r.error?.issues)).toBe(true);
    expect(r.data?.scriptVersion).toBe(9);
  });
});

describe("a take's dialogs", () => {
  it("validates at schema 16, with every kind", () => {
    expect(CURRENT_SCHEMA_VERSION).toBe(16);
    expect(DIALOG_KINDS).toHaveLength(4);
    for (const kind of DIALOG_KINDS) {
      expect(DialogRecordSchema.safeParse(record({ kind })).success).toBe(true);
    }
    expect(DialogRecordSchema.safeParse(record({ beatMs: 0 })).success).toBe(
      false,
    );
    const { draft } = takeWith([record()]);
    expect(draft.steps.length).toBeGreaterThan(0);
  });

  it("migrates a schema-15 take to 16 unchanged otherwise", () => {
    const old = { ...fixture(), schemaVersion: 15 };
    const migrated = migrateToCurrent(old);
    expect(migrated.schemaVersion).toBe(16);
    expect(migrated).toEqual({ ...old, schemaVersion: 16 });
  });
});

describe("scriptFromTake writes dialog only when not the default", () => {
  it("writes dismiss at version 9", () => {
    const { draft, step } = takeWith([record({ answer: "dismiss" })]);
    expect(step).toMatchObject({ dialog: "dismiss" });
    expect(draft.scriptVersion).toBe(9);
  });

  it("writes a prompt's text as { text }", () => {
    const { draft, step } = takeWith([
      record({ kind: "prompt", answer: "accept", text: "Acme" }),
    ]);
    expect(step).toMatchObject({ dialog: { text: "Acme" } });
    expect(draft.scriptVersion).toBe(9);
  });

  it("writes nothing for a plain accept, by script or by default", () => {
    const plain = takeWith([]);
    for (const by of ["script", "default"] as const) {
      const { draft, step } = takeWith([record({ answer: "accept", by })]);
      // Premise: the step exists, so its missing key means something.
      expect(step).toBeDefined();
      expect(step).not.toHaveProperty("dialog");
      expect(draft.scriptVersion).toBe(plain.draft.scriptVersion);
    }
  });
});

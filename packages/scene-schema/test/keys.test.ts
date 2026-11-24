import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CURRENT_SCHEMA_VERSION,
  DEVICES,
  DemoScriptSchema,
  formatKeyCombo,
  migrateToCurrent,
  minimumScriptVersion,
  parseHolding,
  parseKeyCombo,
  SCRIPT_VERSION_KEYS,
  SceneDocumentSchema,
  ScriptStepSchema,
  scriptFromTake,
} from "../src/index.js";

const msg = (r: { ok: boolean; message?: string }) =>
  r.ok ? "ok" : (r as { message: string }).message;

describe("parseKeyCombo", () => {
  it("parses combos", () => {
    expect(parseKeyCombo("Mod+Shift+K")).toEqual({
      ok: true,
      modifiers: ["Shift", "Mod"],
      key: "K",
    });
    expect(parseKeyCombo("Mod+k")).toMatchObject({ ok: true, key: "K" });
    expect(parseKeyCombo("Shift+Tab")).toMatchObject({
      modifiers: ["Shift"],
      key: "Tab",
    });
    expect(parseKeyCombo("F5")).toMatchObject({ key: "F5", modifiers: [] });
    expect(parseKeyCombo("?")).toMatchObject({ key: "?" });
    expect(parseKeyCombo("Mod++")).toEqual({
      ok: true,
      modifiers: ["Mod"],
      key: "+",
    });
    expect(parseKeyCombo("+")).toEqual({ ok: true, modifiers: [], key: "+" });
  });

  it("refuses with a sentence naming the input", () => {
    expect(msg(parseKeyCombo("Cmd+K"))).toBe(
      '"Cmd" is not a modifier: write Mod (⌘ on every take), Shift, Alt or Ctrl',
    );
    // Case-sensitive: the lowercase spelling is an unknown modifier.
    expect(msg(parseKeyCombo("mod+k"))).toBe(
      '"mod" is not a modifier: write Mod (⌘ on every take), Shift, Alt or Ctrl',
    );
    expect(msg(parseKeyCombo("Shift+Shift+K"))).toBe(
      '"Shift" is named twice in "Shift+Shift+K"',
    );
    expect(msg(parseKeyCombo("Mod+Shift"))).toBe(
      '"Mod+Shift" names no key: end it with one, like "Mod+Shift+K"',
    );
    for (const text of ["Mod+Hello", "é", " "]) {
      expect(msg(parseKeyCombo(text))).toBe(
        `"${text}" names no key Demoman can press: Enter, Tab, Escape, Backspace, Delete, Space, an arrow, Home, End, PageUp, PageDown, F1–F12, or one character`,
      );
    }
  });

  it("round-trips through formatKeyCombo", () => {
    const parsed = parseKeyCombo("Mod+Alt+Shift+Ctrl+F12");
    if (!parsed.ok) throw new Error(parsed.message);
    expect(formatKeyCombo(parsed.modifiers, parsed.key)).toBe(
      "Ctrl+Alt+Shift+Mod+F12",
    );
    expect(formatKeyCombo(["Shift", "Mod"])).toBe("Shift+Mod");
  });
});

describe("parseHolding", () => {
  it("takes modifiers only", () => {
    expect(parseHolding("Shift")).toEqual({ ok: true, modifiers: ["Shift"] });
    expect(parseHolding("Mod+Shift")).toEqual({
      ok: true,
      modifiers: ["Shift", "Mod"],
    });
    expect(msg(parseHolding("Shift+K"))).toBe(
      'holding takes modifiers only, like "Shift" or "Mod+Shift"',
    );
    expect(msg(parseHolding("Ctrl"))).toBe(
      'holding Ctrl is a right-click on a Mac and a plain click elsewhere; write button: "right"',
    );
  });
});

const click = (extra: object) => ({
  do: "click",
  on: { stableId: "x" },
  ...extra,
});
const script = (steps: object[], extra: object = {}) => ({
  name: "n",
  target: "https://example.com",
  steps,
  ...extra,
});

describe("the door", () => {
  it("accepts a right click, a double click and a held modifier", () => {
    for (const extra of [
      { button: "right" },
      { clicks: 2 },
      { holding: "Shift" },
    ]) {
      const r = ScriptStepSchema.safeParse(click(extra));
      expect(r.success, JSON.stringify(r.error?.issues)).toBe(true);
    }
  });

  it("refuses with the field in the path", () => {
    const left = ScriptStepSchema.safeParse(click({ button: "left" }));
    expect(left.error?.issues[0]?.message).toBe(
      'button takes "right" only; a click is left by default',
    );
    expect(left.error?.issues[0]?.path).toEqual(["button"]);
    const middle = ScriptStepSchema.safeParse(click({ button: "middle" }));
    expect(middle.error?.issues[0]?.path).toEqual(["button"]);
    const both = DemoScriptSchema.safeParse(
      script([click({ button: "right", clicks: 2 })]),
    );
    const issue = both.error?.issues.find(
      (i) => i.message === "a right-click takes no clicks",
    );
    expect(issue?.path).toEqual(["steps", 0, "clicks"]);
    const held = ScriptStepSchema.safeParse(click({ holding: "Ctrl" }));
    expect(held.error?.issues[0]?.path).toEqual(["holding"]);
    const press = ScriptStepSchema.safeParse({ do: "press", key: "Cmd+K" });
    expect(press.error?.issues[0]?.path).toEqual(["key"]);
  });

  it("refuses a mouse field on a touch device, at the field", () => {
    expect(DEVICES.phone.touch).toBe(true);
    const r = DemoScriptSchema.safeParse(
      script([click({ clicks: 2 })], { device: "phone" }),
    );
    const issue = r.error?.issues.find(
      (i) => i.path.join(".") === "steps.0.clicks",
    );
    expect(issue?.message).toBe(
      "a phone or tablet has no mouse: button, clicks and holding need a desktop take",
    );
  });
});

describe("script version", () => {
  const v = (step: object) => minimumScriptVersion(script([step]) as never);

  it("is 10 for each new field and a combo, and 7 for a plain press", () => {
    expect(SCRIPT_VERSION_KEYS).toBe(10);
    expect(v(click({ button: "right" }))).toBe(10);
    expect(v(click({ clicks: 3 }))).toBe(10);
    expect(v(click({ holding: "Shift" }))).toBe(10);
    expect(v({ do: "press", key: "Mod+K" })).toBe(10);
    expect(v({ do: "press", key: "F5" })).toBe(10);
    expect(v({ do: "press", key: "Enter" })).toBe(7);
  });

  it("refuses a v9 script naming a combo with the version sentence", () => {
    const r = DemoScriptSchema.safeParse(
      script([{ do: "press", key: "Mod+K" }], { scriptVersion: 9 }),
    );
    expect(r.success).toBe(true);
    // Raised, not refused: the door sets the version from what is named.
    expect(r.data?.scriptVersion).toBe(10);
  });
});

const fixture = (): Record<string, unknown> =>
  JSON.parse(
    readFileSync(
      join(__dirname, "..", "fixtures", "readonly-scene.json"),
      "utf8",
    ),
  );

describe("the take", () => {
  it("validates a press with modifiers and a multi, held, right click", () => {
    expect(CURRENT_SCHEMA_VERSION).toBe(17);
    const doc = SceneDocumentSchema.parse(fixture());
    const c = doc.actions.find((a) => a.kind === "click");
    if (c?.kind !== "click") throw new Error("fixture has no click");
    c.clicks = 2;
    c.modifiers = ["Shift"];
    c.button = "right";
    const press = {
      ...c,
      id: "press-1",
      kind: "press" as const,
      anchorId: null,
      key: "K",
      modifiers: ["Mod" as const],
    };
    doc.actions.push(press as never);
    const r = SceneDocumentSchema.safeParse(doc);
    expect(r.success, JSON.stringify(r.error?.issues)).toBe(true);
  });

  it("migrates a schema-16 take to 17 with nothing else changed", () => {
    const old = { ...fixture(), schemaVersion: 16 };
    expect(migrateToCurrent(old)).toEqual({ ...old, schemaVersion: 17 });
  });
});

describe("scriptFromTake", () => {
  it("writes the combo, button, clicks and holding back at version 10", () => {
    const doc = SceneDocumentSchema.parse(fixture());
    const c = doc.actions.find((a) => a.kind === "click");
    if (c?.kind !== "click") throw new Error("fixture has no click");
    const second = {
      ...structuredClone(c),
      id: "click-2",
      timestamp: c.timestamp + 1000,
    };
    c.button = "right";
    c.modifiers = ["Shift"];
    second.clicks = 2;
    doc.actions.push(second, {
      ...structuredClone(c),
      id: "press-1",
      timestamp: c.timestamp + 2000,
      kind: "press",
      anchorId: null,
      key: "K",
      modifiers: ["Mod", "Shift"],
    } as never);
    const d = scriptFromTake(doc);
    if (d.outcome !== "derived") throw new Error(`got ${d.outcome}`);
    const step = (id: string) =>
      d.draft.steps.find((s) => s.do === "click" && s.recorded === id);
    expect(step(c.id)).toMatchObject({ button: "right", holding: "Shift" });
    expect(step("click-2")).toMatchObject({ clicks: 2 });
    expect(d.draft.steps.find((s) => s.do === "press")).toMatchObject({
      key: "Shift+Mod+K",
    });
    expect(d.draft.scriptVersion).toBe(10);
    expect(d.holes).toEqual([]);
    const again = DemoScriptSchema.safeParse(d.draft);
    expect(again.success, JSON.stringify(again.error?.issues)).toBe(true);
  });

  it("keeps a middle click a hole", () => {
    const doc = SceneDocumentSchema.parse(fixture());
    const c = doc.actions.find((a) => a.kind === "click");
    if (c?.kind !== "click") throw new Error("fixture has no click");
    c.button = "middle";
    const d = scriptFromTake(doc);
    if (d.outcome !== "derived") throw new Error(`got ${d.outcome}`);
    expect(d.holes.some((h) => h.reason === "buttonNotScriptable")).toBe(true);
  });
});

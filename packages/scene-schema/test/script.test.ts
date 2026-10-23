import { describe, expect, it } from "vitest";
import { BRANDING_DEFAULTS } from "../src/document";
import {
  DemoScriptSchema,
  SCRIPT_VERSION,
  SCRIPT_VERSION_DEVICE,
  SCRIPT_VERSION_DRAG,
  SCRIPT_VERSION_KIT,
  type ScriptTarget,
  targetStrategy,
} from "../src/script";

const ok = {
  scriptVersion: 1 as const,
  name: "Checkout flow",
  target: "https://app.example.com/",
  steps: [
    { do: "click" as const, on: { role: "button", name: "Checkout" } },
    {
      do: "type" as const,
      into: { stableId: "email" },
      text: "ada@example.com",
    },
    { do: "pause" as const, ms: 800 },
  ],
};

describe("DemoScript", () => {
  it("accepts a script naming one strategy per target", () => {
    const parsed = DemoScriptSchema.parse(ok);
    expect(parsed.steps).toHaveLength(3);
    expect(SCRIPT_VERSION).toBe(1);
  });

  // A target that names two strategies is REFUSED, not half-read. Without
  // `.strict()` zod matches the first union member and strips `text`, so the
  // agent asked for one thing and silently got another.
  it("refuses a target naming two strategies, and names the field", () => {
    const two = {
      ...ok,
      steps: [{ do: "click", on: { stableId: "pay", text: "Pay now" } }],
    };
    const result = DemoScriptSchema.safeParse(two);
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain("text");
  });

  // The format has no `button`: the run dispatches a left one and nothing
  // else, so a field offering `right` promised behaviour no door performs. It
  // is REFUSED rather than stripped — an agent that asked for a right click
  // and silently got a left one would have no way to find out. The engine's
  // `unperformableStep` is the second line, for a caller that skipped this
  // parse.
  it("refuses a click naming a mouse button, and names the field", () => {
    const right = {
      ...ok,
      steps: [
        { do: "click", on: { role: "button", name: "Row" }, button: "right" },
      ],
    };
    const result = DemoScriptSchema.safeParse(right);
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain("button");
  });

  // Premise for the case above: the same step WITHOUT the extra key parses, so
  // what that one refuses is the field and not the step.
  it("accepts the same click without it", () => {
    const plain = {
      ...ok,
      steps: [{ do: "click", on: { role: "button", name: "Row" } }],
    };
    expect(DemoScriptSchema.safeParse(plain).success).toBe(true);
  });

  it("refuses a script with no steps", () => {
    expect(DemoScriptSchema.safeParse({ ...ok, steps: [] }).success).toBe(
      false,
    );
  });

  // Review Focus 2: refusesADocumentAsAScript. An agent pasting a document
  // gives valid JSON with a `schemaVersion`, and the two formats must never be
  // confusable. `scriptVersion` is a literal, so nothing document-SHAPED can
  // satisfy it.
  //
  // The fixture below is document-shaped and is deliberately NOT a valid
  // `SceneDocument` (`meta: {}` alone would fail its schema in a dozen
  // places), which is why the comment no longer calls it one. No validity
  // assertion is added: the guarantee this test exists for is that a
  // document-shaped paste is refused NAMING `scriptVersion`, and that holds
  // whether or not the paste would have parsed as a document.
  it("refuses a document-shaped paste as a script, naming scriptVersion", () => {
    const document = { schemaVersion: 9, meta: {}, actions: [], anchors: [] };
    const result = DemoScriptSchema.safeParse(document);
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain("scriptVersion");
  });

  // A step beside the pause, so the ONLY thing that can refuse this script is
  // `ms`. Written as a pause on its own until 2026-09-27, when the pause-only
  // refinement below landed and would have refused it whether or not `ms` was
  // still `.positive()` — a test that passes with and without its
  // implementation.
  it("refuses a pause of zero, and names the field", () => {
    const zero = {
      ...ok,
      steps: [
        { do: "click", on: { stableId: "pay" } },
        { do: "pause", ms: 0 },
      ],
    };
    const result = DemoScriptSchema.safeParse(zero);
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain("ms");
  });

  // A script of nothing but pauses satisfies `steps.min(1)` and declares no
  // work: nothing would be performed, so no take could be assembled. Refused
  // here, at the door, where an agent gets the best error; the runtime
  // `noActions` refusal in `runAuthoredInWindow` stays as the backstop for a
  // caller that skipped this parse.
  it("refuses a script whose every step is a pause, and says why", () => {
    const pauses = {
      ...ok,
      steps: [
        { do: "pause", ms: 500 },
        { do: "pause", ms: 200 },
      ],
    };
    const result = DemoScriptSchema.safeParse(pauses);
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain(
      "at least one step that acts on the page",
    );
  });

  // The premise for the case above: the same pauses WITH one acting step parse,
  // so what it refuses is the absence of work and not the pause itself.
  it("accepts the same pauses beside a step that acts", () => {
    const withWork = {
      ...ok,
      steps: [
        { do: "pause", ms: 500 },
        { do: "click", on: { stableId: "pay" } },
      ],
    };
    expect(DemoScriptSchema.safeParse(withWork).success).toBe(true);
  });

  // Every acting verb counts, not just the ones that click something: a script
  // that only waits for a page to load is odd but it performs a step and
  // produces a take. A refinement that listed too few verbs would refuse it.
  it("accepts a script whose only acting step is a wait", () => {
    for (const step of [
      { do: "waitForLoad" },
      { do: "waitFor", on: { stableId: "pay" }, until: "visible" },
      { do: "hover", on: { stableId: "pay" } },
      { do: "scrollTo", on: { stableId: "pay" } },
      { do: "type", into: { stableId: "pay" }, text: "x" },
    ]) {
      const result = DemoScriptSchema.safeParse({ ...ok, steps: [step] });
      expect(
        result.success,
        `${JSON.stringify(step)} was refused: ${JSON.stringify(result.error?.issues)}`,
      ).toBe(true);
    }
  });

  // A position in the page — what capture measured when nothing nameable was
  // there, which is every scroll into an unnamed section. A derived script
  // carries it so a recorded scroll can be performed rather than left a hole.
  it("accepts a target named by its position in the page", () => {
    const scroll = {
      ...ok,
      steps: [{ do: "scrollTo", on: { treePath: "body:1/main:1/div:3" } }],
    };
    expect(DemoScriptSchema.safeParse(scroll).success).toBe(true);
  });

  it("refuses a position beside a second strategy, and names the field", () => {
    const two = {
      ...ok,
      steps: [
        { do: "click", on: { treePath: "body:1/main:1/div:3", text: "Pay" } },
      ],
    };
    const result = DemoScriptSchema.safeParse(two);
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain("text");
  });

  // Every site that reads a target's shape goes through this, so a shape added
  // to the union and forgotten somewhere cannot fall through to "text" — which
  // is what three separate else-branches did before it existed.
  it("names each target's strategy by its shape, one per member", () => {
    const cases: [ScriptTarget, string][] = [
      [{ stableId: "pay" }, "stableId"],
      [{ role: "button", name: "Pay" }, "roleName"],
      [{ text: "Pay" }, "text"],
      [{ treePath: "body:1/main:1/div:3" }, "treePath"],
    ];
    for (const [target, strategy] of cases) {
      expect(targetStrategy(target), JSON.stringify(target)).toBe(strategy);
    }
  });

  it("accepts a script that asks for the Auto frame", () => {
    const parsed = DemoScriptSchema.safeParse({
      scriptVersion: SCRIPT_VERSION,
      name: "auto",
      target: "https://app.example.com/",
      steps: [{ do: "click", on: { stableId: "go" } }],
      look: { canvas: { aspect: "auto" } },
    });
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
  });

  // Review 2026-10-06: `look.branding` reused BrandingSchema, which v8 made
  // require `padding`, so a script derived before then — `{background,
  // logo}` — was refused at the door. It reads as that branding at the
  // default padding, as the brand kit does. Red if the absent key is
  // refused again, or filled with anything but the default.
  it("reads a look.branding from before padding at the default padding", () => {
    const branding = {
      background: BRANDING_DEFAULTS.background,
      logo: null,
    };
    const parsed = DemoScriptSchema.safeParse({ ...ok, look: { branding } });
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
    expect(parsed.data?.look?.branding).toEqual({
      ...branding,
      padding: BRANDING_DEFAULTS.padding,
    });
  });

  // The absent key is upgraded; a present one is still judged.
  it("still refuses a look.branding padding out of range", () => {
    const parsed = DemoScriptSchema.safeParse({
      ...ok,
      look: { branding: { ...BRANDING_DEFAULTS, padding: 0.5 } },
    });
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues.map((i) => i.path.join("."))).toEqual([
      "look.branding.padding",
    ]);
  });
});

describe("recorded and recordedFrom", () => {
  const base = {
    scriptVersion: 1 as const,
    name: "demo",
    target: "https://app.example.com/",
    steps: [{ do: "click", on: { stableId: "go" } }],
  };

  it("keeps parsing a script written before them", () => {
    expect(DemoScriptSchema.safeParse(base).success).toBe(true);
  });

  it("accepts a step's recorded action and the script's take", () => {
    const linked = {
      ...base,
      recordedFrom: "s-1",
      steps: [{ do: "click", on: { stableId: "go" }, recorded: "act-3" }],
    };
    const parsed = DemoScriptSchema.parse(linked);
    expect(parsed.recordedFrom).toBe("s-1");
    expect((parsed.steps[0] as { recorded?: string }).recorded).toBe("act-3");
  });

  it("refuses an empty recorded, and refuses it on a pause", () => {
    expect(
      DemoScriptSchema.safeParse({
        ...base,
        steps: [{ do: "click", on: { stableId: "go" }, recorded: "" }],
      }).success,
    ).toBe(false);
    expect(
      DemoScriptSchema.safeParse({
        ...base,
        steps: [
          { do: "click", on: { stableId: "go" } },
          { do: "pause", ms: 300, recorded: "act-1" },
        ],
      }).success,
    ).toBe(false);
  });
});

describe("a scroll's landing", () => {
  const base = {
    scriptVersion: 1 as const,
    name: "demo",
    target: "https://app.example.com/",
  };

  it("keeps parsing a scroll written without one", () => {
    const parsed = DemoScriptSchema.parse({
      ...base,
      steps: [{ do: "scrollTo", on: { stableId: "b" } }],
    });
    expect(parsed.steps[0]).toEqual({ do: "scrollTo", on: { stableId: "b" } });
  });

  it("accepts where the scroll left its element's top", () => {
    const parsed = DemoScriptSchema.parse({
      ...base,
      steps: [
        { do: "scrollTo", on: { stableId: "b" }, landing: { top: -420 } },
      ],
    });
    expect(parsed.steps[0]).toEqual({
      do: "scrollTo",
      on: { stableId: "b" },
      landing: { top: -420 },
    });
  });

  it("refuses a landing on anything but a scroll, and one with a stray key", () => {
    // The positive control: the same landing on a scroll parses (above), so
    // each refusal here is the step kind or the key, not the value.
    const onClick = DemoScriptSchema.safeParse({
      ...base,
      steps: [{ do: "click", on: { stableId: "b" }, landing: { top: 280 } }],
    });
    expect(onClick.success).toBe(false);
    const stray = DemoScriptSchema.safeParse({
      ...base,
      steps: [
        {
          do: "scrollTo",
          on: { stableId: "b" },
          landing: { top: 280, height: 40 },
        },
      ],
    });
    expect(stray.success).toBe(false);
    expect(JSON.stringify(stray.error?.issues)).toContain("height");
  });
});

describe("look.kit", () => {
  /** A kit needs scriptVersion 2 (`SCRIPT_VERSION_KIT`), so every case that
   *  is about the kit itself starts from a version-2 script — or the version
   *  check would refuse it whatever the kit said. */
  const v2 = { ...ok, scriptVersion: SCRIPT_VERSION_KIT };
  it("accepts a kit by name, at scriptVersion 2", () => {
    const parsed = DemoScriptSchema.safeParse({ ...v2, look: { kit: "Dark" } });
    expect(parsed.success).toBe(true);
    expect(parsed.data?.look?.kit).toBe("Dark");
  });
  // Review 2026-10-08. Red if the version check goes: a version-1 script
  // naming a kit parses, and an older build (whose look drops `kit`)
  // records it on the default brand.
  it("refuses a kit in a version-1 script, naming scriptVersion", () => {
    const r = DemoScriptSchema.safeParse({ ...ok, look: { kit: "Dark" } });
    expect(r.success).toBe(false);
    expect(r.error?.issues).toHaveLength(1);
    expect(r.error?.issues[0]?.path).toEqual(["scriptVersion"]);
    expect(r.error?.issues[0]?.message).toMatch(
      /names look\.kit declares scriptVersion 2/,
    );
  });
  // Every script written before kits stays valid, and a version-2 script
  // need not name one. Version 3 is `SCRIPT_VERSION_MOTION` since
  // 2026-10-09 and version 4 is `SCRIPT_VERSION_DEVICE` since 2026-10-10,
  // version 5 is `SCRIPT_VERSION_ACCOUNT` since 2026-10-15, so the first version past this build's is 6.
  it("accepts version 1 and version 2 without a kit, and refuses version 7", () => {
    expect(DemoScriptSchema.safeParse(ok).success).toBe(true);
    expect(DemoScriptSchema.safeParse(v2).success).toBe(true);
    const v7 = DemoScriptSchema.safeParse({ ...ok, scriptVersion: 7 });
    expect(v7.success).toBe(false);
    expect(v7.error?.issues[0]?.path).toEqual(["scriptVersion"]);
  });
  it("refuses a kit and a branding together, naming look", () => {
    const r = DemoScriptSchema.safeParse({
      ...v2,
      look: { kit: "Dark", branding: BRANDING_DEFAULTS },
    });
    expect(r.success).toBe(false);
    expect(r.error?.issues[0]?.message).toBe(
      "name a kit or give a branding, not both",
    );
    expect(r.error?.issues[0]?.path).toEqual(["look"]);
  });
  // Red if `look` goes back to stripping: a key silently dropped is how a
  // build that predates it would ignore `kit` and record on the wrong brand.
  it("refuses an unknown key in look, naming it", () => {
    const r = DemoScriptSchema.safeParse({ ...v2, look: { theme: "dark" } });
    expect(r.success).toBe(false);
    expect(JSON.stringify(r.error?.issues)).toMatch(/theme/);
  });
  it("refuses an empty kit name, naming look.kit", () => {
    const r = DemoScriptSchema.safeParse({ ...v2, look: { kit: "  " } });
    expect(r.success).toBe(false);
    expect(r.error?.issues[0]?.path).toEqual(["look", "kit"]);
  });
});

describe("device", () => {
  const v4 = { ...ok, scriptVersion: SCRIPT_VERSION_DEVICE };

  it("accepts a preset id at scriptVersion 4", () => {
    const parsed = DemoScriptSchema.safeParse({ ...v4, device: "phone" });
    expect(parsed.success).toBe(true);
    expect(parsed.data?.device).toBe("phone");
  });

  // Red if the version gate goes: an older build strips the unknown
  // top-level key and records the desktop, reporting success.
  it("refuses a device in a version-3 script, naming scriptVersion", () => {
    const r = DemoScriptSchema.safeParse({
      ...ok,
      scriptVersion: 3,
      device: "phone",
    });
    expect(r.success).toBe(false);
    expect(r.error?.issues[0]?.path).toEqual(["scriptVersion"]);
    expect(r.error?.issues[0]?.message).toMatch(
      /names device declares scriptVersion 4/,
    );
  });

  it("refuses an unknown device, naming the ones there are", () => {
    const r = DemoScriptSchema.safeParse({ ...v4, device: "galaxy" });
    expect(r.success).toBe(false);
    expect(r.error?.issues[0]?.path).toEqual(["device"]);
    expect(JSON.stringify(r.error?.issues[0])).toMatch(/phone.*tablet/);
  });

  it("refuses a device and a viewport together, naming both", () => {
    const r = DemoScriptSchema.safeParse({
      ...v4,
      device: "phone",
      viewport: { width: 390, height: 844 },
    });
    expect(r.success).toBe(false);
    expect(r.error?.issues[0]?.path).toEqual(["device"]);
    expect(r.error?.issues[0]?.message).toMatch(/device.*viewport/);
  });

  it("refuses a hover step under a device, on that step's path", () => {
    // The fixture premise: `ok` holds no hover, so the refusal below can only
    // be about the step this test adds.
    expect(ok.steps.some((s) => (s.do as string) === "hover")).toBe(false);
    const steps = [
      ...ok.steps,
      { do: "hover" as const, on: { stableId: "menu" } },
    ];
    const r = DemoScriptSchema.safeParse({ ...v4, device: "phone", steps });
    expect(r.success).toBe(false);
    expect(r.error?.issues[0]?.path).toEqual(["steps", steps.length - 1]);
    expect(r.error?.issues[0]?.message).toMatch(/no hover/);
    // The same steps without a device are a valid script.
    expect(DemoScriptSchema.safeParse({ ...v4, steps }).success).toBe(true);
  });
});

describe("drag", () => {
  const v6 = (steps: unknown[]) => ({
    ...ok,
    scriptVersion: SCRIPT_VERSION_DRAG,
    steps,
  });
  const issues = (raw: unknown) => {
    const parsed = DemoScriptSchema.safeParse(raw);
    return parsed.success ? [] : parsed.error.issues;
  };

  it("parses a drag from a target to a target, with spots", () => {
    const parsed = DemoScriptSchema.safeParse(
      v6([
        {
          do: "drag",
          from: { on: { role: "button", name: "Card A" } },
          to: { on: { text: "Done" } },
        },
        {
          do: "drag",
          from: { on: { text: "Drawing canvas" }, at: { x: 0.3, y: 0.35 } },
          to: { on: { text: "Drawing canvas" }, at: { x: 0.55, y: 0.6 } },
        },
        {
          do: "drag",
          from: { on: { role: "slider", name: "Opacity" } },
          to: { by: { x: -120, y: 0 } },
        },
      ]),
    );
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
    expect(SCRIPT_VERSION_DRAG).toBe(6);
  });

  // Red if the version gate goes: a build from before drag refuses the step
  // by an unknown `do`, which is a worse sentence than the version's.
  it("refuses a drag in a version-5 script", () => {
    const found = issues({
      ...v6([
        {
          do: "drag",
          from: { on: { text: "A" } },
          to: { on: { text: "B" } },
        },
      ]),
      scriptVersion: 5,
    });
    expect(found.map((i) => i.message).join("\n")).toContain(
      "declares scriptVersion 6",
    );
  });

  it("refuses a spot outside the box", () => {
    const found = issues(
      v6([
        {
          do: "drag",
          from: { on: { text: "A" }, at: { x: 1.2, y: 0 } },
          to: { on: { text: "B" } },
        },
      ]),
    );
    expect(found.map((i) => i.path.join("."))).toContain("steps.0.from.at.x");
  });

  it("refuses a drag whose ends are the same point", () => {
    const still = issues(
      v6([
        {
          do: "drag",
          from: { on: { text: "A" } },
          to: { by: { x: 0, y: 0 } },
        },
      ]),
    );
    const same = issues(
      v6([
        {
          do: "drag",
          from: { on: { text: "A" }, at: { x: 0.5, y: 0.5 } },
          to: { on: { text: "A" }, at: { x: 0.5, y: 0.5 } },
        },
      ]),
    );
    for (const found of [still, same]) {
      expect(found.map((i) => i.message).join("\n")).toContain(
        "starts and ends at the same point",
      );
    }
  });

  // Unlike a hover: a phone drags.
  it("allows a drag on a device", () => {
    const parsed = DemoScriptSchema.safeParse({
      ...v6([
        {
          do: "drag",
          from: { on: { text: "A" } },
          to: { by: { x: 0, y: 200 } },
        },
      ]),
      device: "phone",
    });
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
  });
});

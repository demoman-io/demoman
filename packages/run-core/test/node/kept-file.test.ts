import { DemoScriptSchema } from "@demoman/scene-schema";
import { describe, expect, it } from "vitest";
import {
  judgedOutput,
  type KeptOutput,
  type KeptVideo,
  keptFileName,
  parseKept,
  serializeKept,
} from "../../src/kept/file.js";

const script = DemoScriptSchema.parse({
  scriptVersion: 5,
  name: "add a task",
  target: "http://localhost:4000/",
  steps: [{ do: "waitForLoad" }],
});

const kept: KeptVideo = {
  keptVersion: 1,
  name: "Add a task",
  script,
  scale: 2,
  logo: null,
  outputs: [
    {
      path: "docs/add-task.mp4",
      fileType: "mp4",
      aspect: "auto",
      quality: "share",
    },
  ],
  screens: {
    steps: 3,
    moments: [
      { step: 0, ms: 400 },
      { step: null, ms: 900 },
      { step: 2, ms: 1500 },
    ],
  },
  report: null,
  from: { videoId: "v1", takeId: "t1", recordedRevision: "abc123" },
};

const withChange = (change: Record<string, unknown>) =>
  JSON.stringify({ ...JSON.parse(serializeKept(kept)), ...change });

const refusal = (text: string) => {
  const r = parseKept(text, "x.json");
  if (r.ok) throw new Error("expected a refusal");
  return r.detail;
};

describe("the kept file", () => {
  it("round-trips, and the fixture is a real script", () => {
    expect(script.steps.length).toBeGreaterThan(0);
    const text = serializeKept(kept);
    expect(text.endsWith("}\n")).toBe(true);
    expect(Object.keys(JSON.parse(text))[0]).toBe("keptVersion");
    expect(parseKept(text, "x.json")).toEqual({ ok: true, kept });
  });

  it("refuses another keptVersion, naming it", () => {
    expect(refusal(withChange({ keptVersion: 2 }))).toContain("keptVersion");
  });

  it("names the file when the JSON is invalid", () => {
    expect(refusal("{nope")).toContain("x.json");
  });

  it.each(["/etc/x.mp4", "../x.mp4", "a/../../x.mp4"])(
    "refuses output path %s, naming outputs[0].path",
    (path) => {
      const o = { ...kept.outputs[0], path };
      expect(refusal(withChange({ outputs: [o] }))).toContain(
        "outputs[0].path",
      );
    },
  );

  it("refuses no outputs", () => {
    expect(refusal(withChange({ outputs: [] }))).toContain("outputs");
  });

  it("refuses a script the schema refuses, with the schema's path", () => {
    expect(refusal(withChange({ script: { ...script, steps: [] } }))).toContain(
      "script.steps",
    );
  });

  it("gives one file to names the library treats as equal", () => {
    expect(keptFileName("Add a task!")).toBe("add-task.json");
    expect(keptFileName("add the tasks")).toBe("add-task.json");
    expect(keptFileName("add a task")).toBe("add-task.json");
  });

  it("refuses a file without screens, naming the video and demoman keep", () => {
    const { screens: _s, ...rest } = JSON.parse(serializeKept(kept));
    const d = refusal(JSON.stringify(rest));
    expect(d).toContain("screens");
    expect(d).toContain("`demoman keep Add a task`");
    expect(d).toContain("Add a task");
  });

  const moments = (...m: unknown[]) =>
    withChange({ screens: { steps: 3, moments: m } });
  it.each([
    [
      "a negative ms",
      [
        { step: 0, ms: 5 },
        { step: 1, ms: -1 },
      ],
    ],
    [
      "a fractional step",
      [
        { step: 0, ms: 5 },
        { step: 1.5, ms: 9 },
      ],
    ],
    [
      "a step at or past steps",
      [
        { step: 0, ms: 5 },
        { step: 3, ms: 9 },
      ],
    ],
    [
      "a repeated step",
      [
        { step: 1, ms: 5 },
        { step: 1, ms: 9 },
      ],
    ],
    [
      "ms not increasing",
      [
        { step: 0, ms: 5 },
        { step: 1, ms: 5 },
      ],
    ],
  ])("refuses %s, naming screens.moments[1]", (_n, m) => {
    expect(refusal(moments(...m))).toContain("screens.moments[1]");
  });

  it("refuses no moments and a non-integer steps", () => {
    expect(refusal(moments())).toContain("screens.moments");
    expect(
      refusal(
        withChange({ screens: { steps: 2.5, moments: [{ step: 0, ms: 1 }] } }),
      ),
    ).toContain("screens.steps");
  });

  it("refuses a second final screen, naming screens.moments[1]", () => {
    const text = moments({ step: null, ms: 5 }, { step: null, ms: 9 });
    expect(refusal(text)).toContain("screens.moments[1]");
  });
});

describe("judgedOutput", () => {
  const o = (
    fileType: "mp4" | "gif",
    aspect: KeptOutput["aspect"],
  ): KeptOutput => ({
    path: "a",
    fileType,
    aspect,
    quality: "share",
  });
  it.each([
    [[o("gif", "auto"), o("mp4", "auto")], 1],
    [[o("mp4", "9:16"), o("mp4", "16:9")], 1],
    [[o("gif", "9:16"), o("mp4", "9:16")], 1],
    [[o("gif", "auto")], 0],
  ])("%j -> %i", (outputs, want) => {
    expect(judgedOutput(outputs)).toBe(want);
  });
});

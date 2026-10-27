import { DemoScriptSchema } from "@demoman/scene-schema";
import { describe, expect, it } from "vitest";
import {
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
});

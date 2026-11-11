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
import { isFlowId } from "../../src/served-words.js";

const script = DemoScriptSchema.parse({
  scriptVersion: 5,
  name: "add a task",
  target: "http://localhost:4000/",
  steps: [{ do: "waitForLoad" }],
});

const FLOW = "0b6e1c52-7d3a-4f0e-9a41-2c8d5e6f7a90";

const kept: KeptVideo = {
  keptVersion: 2,
  flow: FLOW,
  name: "Add a task",
  script,
  scale: 2,
  logo: null,
  wallpaper: null,
  deliver: "commit",
  outputs: [
    {
      path: "docs/add-task.mp4",
      fileType: "mp4",
      aspect: "auto",
      quality: "share",
    },
  ],
  report: null,
};

const withChange = (change: Record<string, unknown>) =>
  JSON.stringify({ ...JSON.parse(serializeKept(kept)), ...change });

// The v1 shape (apps/runner/test/refresh-ahead.test.ts): screens and `from`
// lived in the recipe. parseKept still reads it.
const v1 = {
  ...JSON.parse(serializeKept(kept)),
  keptVersion: 1,
  flow: undefined,
  deliver: undefined,
  screens: {
    steps: 3,
    moments: [
      { step: 0, ms: 400 },
      { step: null, ms: 900 },
      { step: 2, ms: 1500 },
    ],
  },
  from: { videoId: FLOW, takeId: "t1", recordedRevision: "r1" },
};
const withV1 = (change: Record<string, unknown>) =>
  JSON.stringify({ ...v1, ...change });

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
    expect(parseKept(text, "x.json")).toEqual({
      ok: true,
      kept,
      migrated: null,
    });
  });

  it("a v1 file reads as a v2 recipe with its receipt migrated", () => {
    expect(isFlowId(v1.from.videoId)).toBe(true);
    // The premise: the fixture is v1 and has no v2 keys.
    expect(v1.keptVersion).toBe(1);
    const text = withV1({});
    expect(JSON.parse(text)).not.toHaveProperty("flow");
    expect(JSON.parse(text)).not.toHaveProperty("deliver");
    const r = parseKept(text, "x.json");
    if (!r.ok) throw new Error(r.detail);
    expect(r.kept).toEqual(kept);
    expect(r.kept.flow).toBe(v1.from.videoId);
    // Premise: the v1 file carries screens, which are not carried over.
    expect(v1.screens.moments).toHaveLength(3);
    expect(r.migrated?.screens).toBeNull();
    expect(r.migrated?.receiptVersion).toBe(1);
    expect(r.migrated?.video).toBe("t1");
    expect(r.migrated?.recordedRevision).toBe("r1");
    expect(r.migrated?.flow).toBe(FLOW);
    expect(r.migrated?.filmedCode).toEqual({
      none: "kept before receipts were recorded",
    });
  });

  it("a v2 file round-trips and carries no screens", () => {
    const text = serializeKept(kept);
    expect(JSON.parse(text)).not.toHaveProperty("screens");
    expect(JSON.parse(text)).not.toHaveProperty("from");
    expect(parseKept(text, "x.json")).toEqual({
      ok: true,
      kept,
      migrated: null,
    });
  });

  it("a files recipe refuses a path with a slash", () => {
    const o = { ...kept.outputs[0], path: "docs/a.mp4" };
    expect(refusal(withChange({ deliver: "files", outputs: [o] }))).toMatch(
      /outputs\[0\]\.path/,
    );
    const bare = { ...kept.outputs[0], path: "a.mp4" };
    const ok = parseKept(
      withChange({ deliver: "files", outputs: [bare], report: "r.json" }),
      "x.json",
    );
    expect(ok.ok).toBe(true);
    expect(
      refusal(withChange({ deliver: "files", outputs: [bare], report: "d/r" })),
    ).toContain("report");
  });

  it("a flow id that is not a uuid is refused", () => {
    expect(refusal(withChange({ flow: "v1" }))).toContain("flow");
    expect(refusal(withV1({ from: { ...v1.from, videoId: "v1" } }))).toContain(
      "from.videoId",
    );
  });

  it("refuses a deliver that is neither commit nor files", () => {
    expect(refusal(withChange({ deliver: "ftp" }))).toContain("deliver");
  });

  // A file kept before wallpapers has no key: it reads as none, and a
  // file with none writes no key, so it stays byte for byte as it was.
  it("reads an absent wallpaper as none, and round-trips one", () => {
    expect(JSON.parse(serializeKept(kept))).not.toHaveProperty("wallpaper");
    const own = { ...kept, wallpaper: ".demoman/videos/wallpapers/w.webp" };
    expect(parseKept(serializeKept(own), "x.json")).toEqual({
      ok: true,
      kept: own,
      migrated: null,
    });
    expect(refusal(withChange({ wallpaper: "../w.webp" }))).toContain(
      "wallpaper must be null or a repo-relative path",
    );
  });

  it("refuses another keptVersion, naming it", () => {
    expect(refusal(withChange({ keptVersion: 3 }))).toContain("keptVersion");
  });

  // DEM-105: a newer file is a reason to update, not a broken file.
  it("tells a newer keptVersion to update Demoman, and only a newer one", () => {
    expect(refusal(withChange({ keptVersion: 3 }))).toContain(
      "keptVersion is 3; this Demoman reads 1 and 2 — it was written by a newer Demoman; update Demoman",
    );
    expect(refusal(withChange({ keptVersion: 0 }))).not.toContain("newer");
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

  // DEM-68: the flow's words as written, as the video's name is.
  it("names the file from the flow's words as written", () => {
    expect(keptFileName("Add a task!")).toBe("add-a-task.json");
    expect(keptFileName("Filter invoices")).toBe("filter-invoices.json");
    expect(keptFileName("Search — results!")).toBe("search-results.json");
    expect(keptFileName("!!!")).toBe("video.json");
  });

  // Its screens are a picture refresh no longer compares: a v1 file is
  // read only for its receipt to be replaced, whatever they held.
  it("reads a v1 file whose screens are missing or malformed, its receipt's screens null", () => {
    const { screens: _s, ...rest } = v1;
    for (const text of [
      JSON.stringify(rest),
      withV1({ screens: { steps: 2.5, moments: [] } }),
    ]) {
      const r = parseKept(text, "x.json");
      if (!r.ok) throw new Error(r.detail);
      expect(r.migrated?.screens).toBeNull();
    }
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

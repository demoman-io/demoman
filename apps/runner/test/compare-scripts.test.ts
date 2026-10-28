// apps/runner/test/compare-scripts.test.ts
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadScript } from "../src/compare/scripts.js";

const DIR = join(import.meta.dirname, "..", "compare", "scripts");
const places = { sample: "http://127.0.0.1:5000" };

describe("film:compare's scripts", () => {
  it("are the eight, and each is a valid DemoScript once its places are filled", () => {
    const files = readdirSync(DIR)
      .filter((f) => f.endsWith(".json"))
      .sort();
    // apps/server's two (its home and a share page) were archived with it
    // on 2026-10-20. Five film third-party apps (scripts/samples.sh), one of
    // them `tremor-filter.json`, its targets copied from `probe` answers
    // (2026-10-27); `button-run.json` the camera's follow through a run
    // (2026-10-22).
    expect(files).toEqual([
      "actual.json",
      "button-run.json",
      "chatbot.json",
      "excalidraw.json",
      "sample-app.json",
      "tremor-filter.json",
      "tremor.json",
      "wikipedia.json",
    ]);
    for (const f of files) {
      const got = loadScript(join(DIR, f), places);
      expect(got, f).toMatchObject({ ok: true });
    }
  });

  it("fills {sample}", () => {
    const got = loadScript(join(DIR, "sample-app.json"), places);
    expect(got.ok && got.script.target).toBe(
      "http://127.0.0.1:5000/index.html",
    );
  });
});

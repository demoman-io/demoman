// apps/runner/test/compare-scripts.test.ts
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadScript } from "../src/compare/scripts.js";

const DIR = join(import.meta.dirname, "..", "compare", "scripts");
const FIXTURES = join(import.meta.dirname, "fixtures");
const places = { sample: "http://127.0.0.1:5000" };

describe("film:compare's scripts", () => {
  it("are the sixteen, and each is a valid DemoScript once its places are filled", () => {
    const files = readdirSync(DIR)
      .filter((f) => f.endsWith(".json"))
      .sort();
    // apps/server's two (its home and a share page) were archived with it
    // on 2026-10-20. Five film third-party apps (scripts/samples.sh), one of
    // them `tremor-filter.json`, its targets copied from `probe` answers
    // (2026-10-27); `button-run.json` the camera's follow through a run
    // (2026-10-22); `video-as-code.json` the script's trim and per-click
    // zoom (2026-11-02); `same-document.json` an address change inside one
    // document (DEM-61, 2026-11-07). Five are input-coverage go/no-gos
    // (DEM-156, 158, 160, 161), against four fixture pages (the two
    // native-select scripts share one). `inputs.json` the key and click
    // marks (DEM-154, 155), which executor-inputs-picture records.
    expect(files).toEqual([
      "actual.json",
      "button-run.json",
      "chatbot.json",
      "confirm-dialog.json",
      "excalidraw.json",
      "inputs.json",
      "keydown-field.json",
      "native-select-click.json",
      "native-select-keys.json",
      "new-tab.json",
      "same-document.json",
      "sample-app.json",
      "tremor-filter.json",
      "tremor.json",
      "video-as-code.json",
      "wikipedia.json",
    ]);
    let served = 0;
    for (const f of files) {
      const got = loadScript(join(DIR, f), places);
      expect(got, f).toMatchObject({ ok: true });
      // A script served from the fixtures folder must name a page that is there.
      const page =
        got.ok &&
        /^http:\/\/127\.0\.0\.1:8130\/(.+)$/.exec(got.script.target)?.[1];
      if (!page) continue;
      served += 1;
      expect(existsSync(join(FIXTURES, page)), `${f}: ${page}`).toBe(true);
    }
    // same-document.json, the five input go/no-gos and inputs.json: the
    // check above ran.
    expect(served).toBe(7);
  });

  it("fills {sample}", () => {
    const got = loadScript(join(DIR, "sample-app.json"), places);
    expect(got.ok && got.script.target).toBe(
      "http://127.0.0.1:5000/index.html",
    );
  });
});

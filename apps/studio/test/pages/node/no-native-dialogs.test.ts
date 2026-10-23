import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The extension's pages ask with `askToConfirm` (src/shell/confirm-dialog.ts),
 * never with the browser's own `confirm`, `alert` or `prompt` — those paint
 * in Chrome's look, name the extension's id as their title, and cannot say
 * which button Enter presses. Replaced on 2026-10-04; this keeps them out.
 */

const ROOT = join(__dirname, "../../../pages");
const NATIVE = /\b(?:window|globalThis|self)\.(confirm|alert|prompt)\s*\(/;

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.(ts|html)$/.test(name) ? [path] : [];
  });
}

describe("native dialogs", () => {
  it("the scan finds one when there is one", () => {
    // Positive control, so a pattern that matches nothing cannot pass the
    // test below.
    expect(NATIVE.test('if (!window.confirm("Delete?")) return;')).toBe(true);
    expect(NATIVE.test("globalThis.alert(message)")).toBe(true);
    // A port named `confirm` on an injected dependency is not the browser's.
    expect(NATIVE.test("await deps.confirm(triage.blocking)")).toBe(false);
  });

  it("no page asks through the browser's confirm, alert or prompt", () => {
    const files = [
      ...sources(join(ROOT, "entrypoints")),
      ...sources(join(ROOT, "src")),
    ];
    // Premise: the walk reached the pages that used to call them.
    expect(files.map((f) => relative(ROOT, f))).toEqual(
      expect.arrayContaining([
        "entrypoints/editor/main.ts",
        "entrypoints/library/main.ts",
        "src/library/view.ts",
      ]),
    );
    const offenders = files.flatMap((file) =>
      readFileSync(file, "utf8")
        .split("\n")
        .flatMap((line, i) =>
          NATIVE.test(line) ? [`${relative(ROOT, file)}:${i + 1}`] : [],
        ),
    );
    expect(offenders).toEqual([]);
  });
});

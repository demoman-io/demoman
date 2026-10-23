import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import * as compositor from "../../src/index";

const SRC = join(__dirname, "..", "..", "src");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return full.endsWith(".ts") ? [full] : [];
  });
}

describe("package boundary", () => {
  // The compositor runs in the extension's offscreen document today and in
  // the desktop app later. An extension API call would break the second.
  it("never reaches for an extension or CDP API", () => {
    const files = sourceFiles(SRC);
    // A green run must mean the boundary held, not that the walk found
    // nothing. `> 0` was too weak to say that: `src/` holds 29 files across
    // four subdirectories, so a walk that stopped at the top level would
    // still have found some and still passed while checking a fraction of
    // the tree. The sibling resolver package guards at 10 for the same
    // reason. 20 leaves room to delete a file without a false failure and
    // no room for a half-broken walk.
    expect(files.length).toBeGreaterThan(20);
    for (const file of files) {
      const source = readFileSync(file, "utf8");
      expect(source, `${file} references chrome.*`).not.toMatch(
        /\bchrome\s*\.\s*[A-Za-z_$]/,
      );
      expect(source, `${file} references browser.*`).not.toMatch(
        /\bbrowser\s*\.\s*(runtime|tabs|scripting|storage|windows|action|webRequest|permissions|devtools)/,
      );
      expect(source, `${file} imports from apps/`).not.toMatch(
        /from\s+["'].*apps\//,
      );
    }
  });

  // The version is stamped on every rendered scene, so it has to be the
  // package's own: a constant that never moves says nothing.
  it("exports the version package.json declares", () => {
    const pkg = JSON.parse(
      readFileSync(join(__dirname, "..", "..", "package.json"), "utf8"),
    ) as { version: string };
    expect(compositor.COMPOSITOR_VERSION).toBe(pkg.version);
  });
});

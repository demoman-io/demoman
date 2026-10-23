import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import * as resolver from "../../src/index";

const SRC = join(__dirname, "..", "..", "src");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return full.endsWith(".ts") ? [full] : [];
  });
}

describe("package boundary", () => {
  // Roadmap boundary rule: the future-open set is apps/extension + packages/*,
  // and resolution must run unchanged in the extension, in replay, and in the
  // phase-2 headless runner. A chrome.* call would break all three.
  it("never reaches for an extension or CDP API", () => {
    const files = sourceFiles(SRC);
    // A green run must mean the boundary held, not that the walk found
    // nothing — guard against a path typo or a broken sourceFiles walk.
    expect(files.length).toBeGreaterThan(10);
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

  it("exports the surface SP4, SP5 and SP8 depend on", () => {
    // Stamped on every scene as `toolchain.resolverVersion`, so it has to be
    // the package's own — package.json said 1.0.0 under a 1.1.0 constant
    // until 2026-09-06.
    const pkg = JSON.parse(
      readFileSync(join(__dirname, "..", "..", "package.json"), "utf8"),
    ) as { version: string };
    expect(resolver.RESOLVER_VERSION).toBe(pkg.version);
    // Value exports only — the surface's twelve types (CapturedAnchor,
    // CaptureContext, etc.) are erased at runtime and can't be checked with
    // toHaveProperty; they're covered by the barrel compiling against
    // src/index.ts's `export type { ... }` list instead.
    for (const name of [
      "captureAnchor",
      "resolveAnchor",
      "resolveAll",
      "anchorHealth",
      "createShadowRegistry",
      "NO_SHADOW",
      "NO_FRAMES",
      "createCanvasMatcher",
      "NO_PATCH",
      "computeRole",
      "computeName",
      "isAuthoredIdentifier",
      "readStableId",
      "readDataKey",
      "buildTreePath",
      "parseTreePath",
      "serializeTreePath",
    ]) {
      expect(resolver, `missing export: ${name}`).toHaveProperty(name);
    }
  });
});

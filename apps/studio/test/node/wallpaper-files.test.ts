import { existsSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { WALLPAPERS, wallpaperFile } from "@demoman/scene-schema";
import { describe, expect, it } from "vitest";

// The generated set, made by scripts/wallpapers/generate.mjs. Red: delete a
// file, or regenerate at another size.
const dir = fileURLToPath(
  new URL("../../pages/public/wallpapers/", import.meta.url),
);

const SIZES = {
  landscape: [9600, 7200],
  portrait: [7200, 9600],
  thumb: [320, 240],
} as const;
const BUDGET = 40_000_000;

/** A WebP's canvas size from its VP8X header. Chrome's encoder writes the
 *  extended format, since it embeds a colour profile. */
function webpSize(b: Buffer): [number, number] | string {
  if (
    b.toString("ascii", 0, 4) !== "RIFF" ||
    b.toString("ascii", 8, 12) !== "WEBP"
  )
    return "not a WebP";
  const chunk = b.toString("ascii", 12, 16);
  if (chunk === "VP8X")
    return [b.readUIntLE(24, 3) + 1, b.readUIntLE(27, 3) + 1];
  return `unexpected first chunk ${JSON.stringify(chunk)}`;
}

describe("the built-in wallpaper files", () => {
  it("has a landscape, portrait and thumb of every wallpaper, at their sizes", () => {
    for (const { id } of WALLPAPERS) {
      for (const [shape, size] of Object.entries(SIZES)) {
        const file = `${dir}${wallpaperFile(id, shape as keyof typeof SIZES)}`;
        expect(existsSync(file), `${file} missing`).toBe(true);
        expect(webpSize(readFileSync(file)), file).toEqual(size);
      }
    }
  });

  it(`fits all of them in ${BUDGET / 1e6} MB`, () => {
    const sizes = WALLPAPERS.flatMap(({ id }) =>
      (Object.keys(SIZES) as (keyof typeof SIZES)[]).map(
        (shape) => statSync(`${dir}${wallpaperFile(id, shape)}`).size,
      ),
    );
    // Thirty files, or the sum below is of fewer than it claims.
    expect(sizes).toHaveLength(30);
    const total = sizes.reduce((a, b) => a + b, 0);
    expect(total, `${total} bytes`).toBeLessThanOrEqual(BUDGET);
  });
});

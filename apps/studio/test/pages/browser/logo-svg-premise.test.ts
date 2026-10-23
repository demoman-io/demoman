import { describe, expect, it } from "vitest";

/**
 * The premise the logo decoder is built on (spec §5): Chrome's
 * `createImageBitmap` does not decode an SVG blob. `addLogo` validated
 * uploads with exactly that call until 2026-09-22, so every SVG was refused
 * with "could not be read as an image" while the file input advertised
 * `image/svg+xml`.
 *
 * If this ever starts passing the other way, `decodeLogo` still routes SVG
 * through `<img>` — rasterising at the export's own height is the reason,
 * not this rejection — but the comment on `decodeLogo` must be corrected.
 */
const SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="40" height="20" viewBox="0 0 40 20"><rect width="40" height="20" fill="#e03131"/></svg>`;

describe("premise: createImageBitmap and SVG", () => {
  it("rejects an SVG blob", async () => {
    const blob = new Blob([SVG], { type: "image/svg+xml" });
    let outcome: string;
    try {
      const bitmap = await createImageBitmap(blob);
      outcome = `decoded ${bitmap.width}x${bitmap.height}`;
      bitmap.close();
    } catch (error) {
      outcome = `rejected: ${error instanceof Error ? error.message : String(error)}`;
    }
    expect(outcome, outcome).toMatch(/^rejected/);
  });

  it("decodes the same SVG through an <img>", async () => {
    // The positive control: the bytes are a valid image, so a rejection
    // above is about the API, not a malformed fixture.
    const url = URL.createObjectURL(new Blob([SVG], { type: "image/svg+xml" }));
    try {
      const img = new Image();
      img.src = url;
      await img.decode();
      expect([img.naturalWidth, img.naturalHeight]).toEqual([40, 20]);
    } finally {
      URL.revokeObjectURL(url);
    }
  });
});

import { URL_SCRUB_PLACEHOLDER } from "@demoman/scene-schema";
import { describe, expect, it } from "vitest";
import { scrubUrl } from "../../src/index.js";

// The base64url token from DEM-130: its `-` and `_` break every run the
// secret sweeps look for, so the sweeps alone leave it whole.
const TOKEN = "Zm9vYmFyYmF6cXV4Zm9v-YmFyYmF6cXV4Zm9vYmFy_enF1eA";

describe("scrubUrl", () => {
  it("writes the placeholder scriptFromTake reads", () => {
    // `url.ts` holds its own copy to keep zod out of the sensor bundle.
    expect(scrubUrl(`https://app.test/x?q=1`)).toBe(
      `https://app.test/x?q=${URL_SCRUB_PLACEHOLDER}`,
    );
  });

  it("replaces a base64url token in the path", () => {
    expect(scrubUrl(`https://app.test/reset/${TOKEN}`)).toBe(
      `https://app.test/reset/${URL_SCRUB_PLACEHOLDER}`,
    );
  });

  it("replaces a 22-character token and keeps the route around it", () => {
    expect(
      scrubUrl("https://app.test/invite/q3Xv9_Lk2mP-wR7tYb4NcA/accept"),
    ).toBe(`https://app.test/invite/${URL_SCRUB_PLACEHOLDER}/accept`);
  });

  it.each([
    ["a UUID", "https://app.test/orders/550e8400-e29b-41d4-a716-446655440000"],
    [
      "a mixed-case UUID",
      "https://app.test/o/550e8400-E29B-41d4-A716-446655440000",
    ],
    ["an ordinary slug", "https://app.test/blog/how-we-ship"],
    [
      "a long lowercase slug with digits",
      "https://app.test/blog/release-notes-2026-11-09-summary",
    ],
    [
      "a long CamelCase word without a digit",
      "https://app.test/w/ProjectSettingsOverview",
    ],
  ])("leaves %s alone", (_, url) => {
    expect(scrubUrl(url)).toBe(url);
  });
});

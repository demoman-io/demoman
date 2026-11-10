import { randomBytes } from "node:crypto";
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
    ["a padded base64url token", "q3Xv9_Lk2mP-wR7tYb4NcA=="],
    ["a Django reset token (base36, then hex)", "c0m2p1-3f8e9a7b6c5d4e3f2a1b"],
    ["a nanoid", "V1StGXR8_Z5jdHi6B-myT"],
    ["a nanoid without a digit", "VStGXR_ZjdHiB-myTqwer"],
  ])("replaces %s", (_, segment) => {
    expect(scrubUrl(`https://app.test/r/${segment}`)).toBe(
      `https://app.test/r/${URL_SCRUB_PLACEHOLDER}`,
    );
  });

  it("replaces nearly every random 16-byte token", () => {
    // The issue's measure: every 22-character token survived before.
    const N = 2000;
    let kept = 0;
    for (let i = 0; i < N; i++) {
      const token = randomBytes(16).toString("base64url");
      if (scrubUrl(`https://app.test/r/${token}`).includes(token)) kept++;
    }
    // Measured at 1.4% over 20,000; 5% leaves room for chance.
    expect(kept, `${kept} of ${N} kept`).toBeLessThan(N * 0.05);
  });

  it.each([
    // Lowercase hex: without the exemption it switches class enough to go.
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
    [
      "a Title_Case article with a year",
      "https://en.wikipedia.org/wiki/2024_United_States_presidential_election",
    ],
    [
      "a CamelCase repo name with a digit",
      "https://github.com/microsoft/TypeScript-Website-v2",
    ],
    [
      "a title slug with a version",
      "https://app.test/blog/Getting-Started-With-React-18",
    ],
  ])("leaves %s alone", (_, url) => {
    expect(scrubUrl(url)).toBe(url);
  });
});

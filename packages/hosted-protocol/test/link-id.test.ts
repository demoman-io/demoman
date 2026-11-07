import { expect, it } from "vitest";
import { isLinkId, newLinkId } from "../src/link-id.js";

it("newLinkId is 22 base62 characters and 1000 are distinct", () => {
  const ids = Array.from({ length: 1000 }, newLinkId);
  for (const id of ids) expect(id).toMatch(/^[0-9A-Za-z]{22}$/);
  expect(new Set(ids).size).toBe(1000);
});

it("isLinkId refuses 21 and 23 characters and a hyphen", () => {
  expect(isLinkId("a".repeat(22))).toBe(true);
  expect(isLinkId("a".repeat(21))).toBe(false);
  expect(isLinkId("a".repeat(23))).toBe(false);
  expect(isLinkId(`${"a".repeat(21)}-`)).toBe(false);
});

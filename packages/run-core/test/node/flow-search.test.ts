import { describe, expect, it } from "vitest";
import {
  hasWords,
  matchedOutsideName,
  phraseHits,
} from "../../src/flow-search.js";

const F = {
  name: "Team onboarding",
  pages: ["http://localhost:3000/team"],
  steps: ["click Invite member", "type Email"],
};

describe("phraseHits", () => {
  it("matches whole words, and prefixes only while typing", () => {
    expect(phraseHits("invite", F)).toBe(1);
    expect(phraseHits("inv", F)).toBe(0);
    expect(phraseHits("inv", F, true)).toBe(1);
    expect(phraseHits("billing", F)).toBe(0);
  });
  it("a trailing space matches whole words, typing or not", () => {
    expect(phraseHits("invite ", F, true)).toBe(phraseHits("invite ", F));
    expect(phraseHits("team inv", F, true)).toBe(2);
    expect(phraseHits("team inv ", F, true)).toBe(1);
  });
  it("keeps a stop word only while typing it", () => {
    const t = { name: "x", pages: [], steps: ["click Token"] };
    expect(phraseHits("to", t, true)).toBe(1);
    expect(phraseHits("to", t, false)).toBe(0);
  });
  it("singularises the typed prefix", () => {
    expect(
      phraseHits("users", { name: "Add user", pages: [], steps: [] }, true),
    ).toBe(1);
  });
});

describe("hasWords", () => {
  it("is false when nothing is left to match", () => {
    expect(hasWords("")).toBe(false);
    expect(hasWords("the ")).toBe(false);
    expect(hasWords("/")).toBe(false);
    expect(hasWords("—", true)).toBe(false);
    expect(hasWords("the")).toBe(false);
  });
  it("is true for a word being typed", () => {
    expect(hasWords("t", true)).toBe(true);
    expect(hasWords("the", true)).toBe(true);
  });
});

describe("matchedOutsideName", () => {
  it("names where the match is when the name does not hold it", () => {
    expect(matchedOutsideName("invite", F)).toEqual({
      step: "click Invite member",
    });
    expect(matchedOutsideName("team", F)).toBeNull();
    expect(matchedOutsideName("localhost", F)).toEqual({
      page: "http://localhost:3000/team",
    });
    expect(matchedOutsideName("billing", F)).toBeNull();
  });
});

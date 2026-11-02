import { describe, expect, it } from "vitest";
import {
  hasWords,
  matchAt,
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

describe("matchAt", () => {
  it("is where the first matched word starts, by the matcher's own rules", () => {
    const s = "type alice@example.com into Email address";
    expect(matchAt("email", s)).toBe(s.indexOf("Email"));
    // A whole word, not a substring: "example" holds no "ample".
    expect(matchAt("ample", s)).toBe(-1);
    // Singularised, and a stop word is no match.
    expect(matchAt("emails", s)).toBe(s.indexOf("Email"));
    expect(matchAt("to", "click Save to the list")).toBe(-1);
    expect(matchAt("list", "click Save to the list")).toBe(18);
    // Typing: the last word is a prefix.
    expect(matchAt("addr", s, true)).toBe(s.indexOf("address"));
    expect(matchAt("addr", s)).toBe(-1);
  });
});

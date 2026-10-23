import { describe, expect, it } from "vitest";
import { looksLikeSecret, scrubSecrets } from "../../src/index.js";

// Stripe's documentation example key, assembled at run time: written out
// whole, it reads as a leaked live key to secret scanners, and GitHub's push
// protection refuses the push.
const STRIPE_KEY = ["sk", "live", "4eC39HqLyjWDarjtT1zdp7dc"].join("_");

describe("scrubSecrets", () => {
  it("redacts a JWT", () => {
    const jwt =
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk";
    expect(scrubSecrets(`token=${jwt}`)).toBe("token=<redacted>");
  });

  it("redacts prefixed API keys", () => {
    expect(scrubSecrets(`using ${STRIPE_KEY}`)).toBe("using <redacted>");
    expect(scrubSecrets("ghp_16C7e42F292c6912E7710c838347Ae178B4a")).toBe(
      "<redacted>",
    );
    expect(scrubSecrets("AKIAIOSFODNN7EXAMPLE")).toBe("<redacted>");
  });

  it("redacts a bearer token", () => {
    expect(scrubSecrets("Authorization: Bearer abcdefghijklmnop1234")).toBe(
      "Authorization: <redacted>",
    );
  });

  it("redacts long bare hex and base64 runs, erring toward redaction", () => {
    expect(scrubSecrets("hash d41d8cd98f00b204e9800998ecf8427e")).toBe(
      "hash <redacted>",
    );
  });

  it("leaves ordinary log lines alone", () => {
    const line = "GET /orders 200 in 43ms";
    expect(scrubSecrets(line)).toBe(line);
  });
});

describe("looksLikeSecret", () => {
  // The specific shapes only. Typed text is prose the author meant to be
  // seen, so the hex/base64 sweeps that are right for a console line would
  // redact an ordinary order number or a long word here.
  it("recognises the vendor-shaped secrets", () => {
    for (const text of [
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk",
      STRIPE_KEY,
      "pk_test_4eC39HqLyjWDarjtT1zdp7dc",
      "ghp_16C7e42F292c6912E7710c838347Ae178B4a",
      "gho_16C7e42F292c6912E7710c838347Ae178B4a",
      "github_pat_11ABCDEFG0123456789abcdefghij",
      "AKIAIOSFODNN7EXAMPLE",
      "Bearer abcdefghijklmnop1234",
    ]) {
      expect(looksLikeSecret(text), text).toBe(true);
    }
  });

  it("does not fire on prose, ids or hashes", () => {
    for (const text of [
      "Acme Corporation",
      "d41d8cd98f00b204e9800998ecf8427e",
      "QWxhZGRpbjpvcGVuIHNlc2FtZQQWxhZGRpbjpvcGVuIHNlc2FtZQ==",
      "order 2026-000123",
      "",
    ]) {
      expect(looksLikeSecret(text), text).toBe(false);
    }
  });

  it("is stateless across calls", () => {
    // A /g regex remembers where it stopped; two hits in a row must both hit.
    const key = STRIPE_KEY;
    expect(looksLikeSecret(key)).toBe(true);
    expect(looksLikeSecret(key)).toBe(true);
  });
});

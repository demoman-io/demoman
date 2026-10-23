import { BRANDING_DEFAULTS } from "@demoman/scene-schema";
import { describe, expect, it } from "vitest";
import { coerceBrandKits, kitsForSnapshot } from "../../src/brand-kit.js";

describe("kitsForSnapshot", () => {
  it("lists every kit by name and marks the default", () => {
    const read = coerceBrandKits(
      [
        { id: "a", name: "Dark", branding: BRANDING_DEFAULTS },
        { id: "b", name: "Light", branding: BRANDING_DEFAULTS },
      ],
      "b",
    );
    // The fixture premise: both kits read as ready.
    expect(read.state).toBe("ready");
    expect(kitsForSnapshot(read)).toEqual({
      ok: true,
      kits: [
        { name: "Dark", default: false, valid: true },
        { name: "Light", default: true, valid: true },
      ],
    });
  });

  it("says why when the list cannot be read, never an empty list", () => {
    const read = coerceBrandKits("not a list", undefined);
    expect(read.state).toBe("invalid");
    const kits = kitsForSnapshot(read);
    expect(kits.ok).toBe(false);
    expect(kits).toHaveProperty(
      "reason",
      expect.stringContaining("not a list"),
    );
  });

  it("marks a kit whose branding is broken as not valid", () => {
    const read = coerceBrandKits(
      [{ id: "a", name: "Broken", branding: { background: 42 } }],
      "a",
    );
    // The fixture premise: the list reads, and the one kit in it does not.
    expect(read.state).toBe("ready");
    const kits = kitsForSnapshot(read);
    expect(kits).toEqual({
      ok: true,
      kits: [{ name: "Broken", default: true, valid: false }],
    });
  });
});

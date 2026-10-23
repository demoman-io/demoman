import { describe, expect, it } from "vitest";
import { checkKitName, nextKitName } from "../../../pages/src/core/brand-kit";

const kit = {
  background: { kind: "solid", color: "#1b2a4a" },
  logo: { ref: "logo:kit", corner: "top-left", size: 0.05, opacity: 1 },
  padding: 0.08,
};

const dark = { id: "kit-dark", name: "Dark", branding: kit };
const light = {
  id: "kit-light",
  name: "Light",
  branding: { ...kit, background: { kind: "solid", color: "#f4f4f4" } },
};

describe("checkKitName", () => {
  const kits = [dark, light];
  it("trims and accepts a new name", () => {
    expect(checkKitName("  Blue ", kits, null)).toEqual({
      ok: true,
      name: "Blue",
    });
  });
  // Review Focus 2.
  it("refuses a name that differs from another kit's only by case or space", () => {
    expect(checkKitName(" dark", kits, null)).toEqual({
      ok: false,
      reason: 'a kit is already named "Dark"',
    });
  });
  it("lets a kit keep its own name in another case", () => {
    expect(checkKitName("DARK", kits, "kit-dark")).toEqual({
      ok: true,
      name: "DARK",
    });
  });
  it("refuses an empty or all-space name", () => {
    expect(checkKitName("   ", kits, null)).toEqual({
      ok: false,
      reason: "a kit needs a name",
    });
  });
  it("refuses a name over 40 characters", () => {
    expect(checkKitName("x".repeat(41), kits, null)).toEqual({
      ok: false,
      reason: "a kit's name is at most 40 characters",
    });
  });
});

describe("nextKitName", () => {
  it("numbers from 2 when the base is taken", () => {
    expect(nextKitName("Untitled kit", [])).toBe("Untitled kit");
    expect(nextKitName("Untitled kit", [{ name: "untitled KIT" }])).toBe(
      "Untitled kit 2",
    );
    expect(
      nextKitName("Dark copy", [
        { name: "Dark copy" },
        { name: "Dark copy 2" },
      ]),
    ).toBe("Dark copy 3");
  });
});

import { BRANDING_DEFAULTS, type SceneBranding } from "@demoman/scene-schema";
import { describe, expect, it } from "vitest";
import {
  brandingForTake,
  coerceBrandKit,
  coerceBrandKits,
  defaultKit,
  kitNamed,
  lookForRun,
} from "../../src/brand-kit.js";

const kit = {
  background: { kind: "solid", color: "#1b2a4a" },
  logo: { ref: "logo:kit", corner: "top-left", size: 0.05, opacity: 1 },
  padding: 0.08,
};

describe("coerceBrandKit", () => {
  it("reads nothing stored as no kit", () => {
    expect(coerceBrandKit(undefined)).toEqual({ state: "missing" });
  });
  it("reads a valid kit", () => {
    expect(coerceBrandKit(kit)).toEqual({ state: "ready", kit });
  });

  // A kit saved before 2026-10-05 has no padding. Red if the read stops
  // upgrading it: every author's working kit would be reported unreadable.
  it("reads a kit saved before padding existed as that kit at 8%", () => {
    const { padding: _p, ...legacy } = kit;
    // Premise: the stored object really has no padding key.
    expect(legacy).not.toHaveProperty("padding");
    expect(coerceBrandKit(legacy)).toEqual({
      state: "ready",
      kit: { ...legacy, padding: 0.08 },
    });
  });

  it("still refuses a kit whose padding is out of range, naming padding", () => {
    const read = coerceBrandKit({ ...kit, padding: 0.5 });
    expect(read.state).toBe("invalid");
    if (read.state === "invalid") expect(read.reason).toMatch(/^padding:/);
  });

  // Reading must not write: the caller's object is left as it was.
  it("does not add padding to the object it was handed", () => {
    const { padding: _p, ...legacy } = kit;
    coerceBrandKit(legacy);
    expect(legacy).not.toHaveProperty("padding");
  });
  it("refuses an invalid kit with the schema's reason, not as missing", () => {
    const read = coerceBrandKit({
      ...kit,
      background: { kind: "solid", color: "navy" },
    });
    expect(read.state).toBe("invalid");
    if (read.state === "invalid") expect(read.reason).toMatch(/background/);
  });
});
const dark = { id: "kit-dark", name: "Dark", branding: kit };
const light = {
  id: "kit-light",
  name: "Light",
  branding: { ...kit, background: { kind: "solid", color: "#f4f4f4" } },
};
const broken = {
  id: "kit-broken",
  name: "Broken",
  branding: { ...kit, background: { kind: "solid", color: "navy" } },
};

describe("coerceBrandKits", () => {
  it("reads nothing stored as an empty list with no default", () => {
    expect(coerceBrandKits(undefined, undefined)).toEqual({
      state: "ready",
      kits: [],
      defaultId: null,
      migrationPending: false,
    });
  });

  // One invalid kit must not hide the others (spec §1).
  it("reads each kit on its own: one invalid kit leaves the others ready", () => {
    const read = coerceBrandKits([dark, broken, light], "kit-dark");
    if (read.state !== "ready") throw new Error(JSON.stringify(read));
    // Premise: the fixture really holds one invalid and two valid kits.
    expect(read.kits.map((k) => k.read.state)).toEqual([
      "ready",
      "invalid",
      "ready",
    ]);
    const bad = read.kits[1]?.read;
    expect(bad?.state === "invalid" && bad.reason).toMatch(/background/);
  });

  it("refuses the whole list when an entry has no id or name, naming the index", () => {
    const read = coerceBrandKits(
      [dark, { name: "x", branding: kit }],
      "kit-dark",
    );
    expect(read).toEqual({
      state: "invalid",
      reason: expect.stringMatching(/^kit 2: /),
    });
  });

  it("refuses a list that is not an array", () => {
    expect(coerceBrandKits({ dark }, "kit-dark").state).toBe("invalid");
  });

  it("keeps a default that names no kit, for the consumers to report", () => {
    const read = coerceBrandKits([dark], "kit-gone");
    expect(read.state === "ready" && read.defaultId).toBe("kit-gone");
    expect(defaultKit(read)).toBeNull();
  });

  it("takes the first kit as the default only when none is stored", () => {
    const read = coerceBrandKits([light, dark], undefined);
    expect(defaultKit(read)?.id).toBe("kit-light");
  });
});

describe("kitNamed", () => {
  it("finds a kit by name, ignoring case and surrounding space", () => {
    const read = coerceBrandKits([dark, light], "kit-dark");
    expect(kitNamed(read, "  dark ")?.id).toBe("kit-dark");
    expect(kitNamed(read, "Blue")).toBeNull();
  });
});

describe("brandingForTake", () => {
  it("starts a take from the default kit, logo ref verbatim", () => {
    const read = coerceBrandKits([light, dark], "kit-dark");
    const { branding, brandKitError } = brandingForTake(read);
    expect(branding).toEqual(kit);
    expect(branding.logo?.ref).toBe("logo:kit");
    expect(brandKitError).toBeNull();
  });
  it("uses the defaults, silently, when there are no kits", () => {
    expect(brandingForTake(coerceBrandKits(undefined, undefined))).toEqual({
      branding: BRANDING_DEFAULTS,
      brandKitError: null,
    });
  });
  // Red if a missing default falls back to the first kit.
  it("says the default kit is missing rather than borrowing another kit", () => {
    const out = brandingForTake(coerceBrandKits([dark], "kit-gone"));
    expect(out.branding).toEqual(BRANDING_DEFAULTS);
    expect(out.brandKitError).toBe(
      "Your default brand kit is missing, so this take uses the default background",
    );
  });
  it("names the default kit that could not be read", () => {
    const out = brandingForTake(coerceBrandKits([broken, dark], "kit-broken"));
    expect(out.branding).toEqual(BRANDING_DEFAULTS);
    expect(out.brandKitError).toMatch(
      /^Your default brand kit "Broken" could not be read, so this take uses the default background: background/,
    );
  });
  it("says the list could not be read", () => {
    expect(
      brandingForTake({ state: "invalid", reason: "storage refused" })
        .brandKitError,
    ).toBe(
      "Your brand kits could not be read, so this take uses the default background: storage refused",
    );
  });
  it("hands out a copy, never the stored kit object itself", () => {
    const read = coerceBrandKits([dark], "kit-dark");
    const stored = defaultKit(read)?.read;
    const out = brandingForTake(read).branding;
    expect(stored?.state === "ready" && stored.kit).toEqual(out);
    expect(stored?.state === "ready" && stored.kit).not.toBe(out);
  });
});

describe("lookForRun", () => {
  const read = coerceBrandKits([dark, light, broken], "kit-dark");
  it("takes the script's own branding first", () => {
    const own = { ...kit, padding: 0.1 } as SceneBranding;
    expect(lookForRun({ look: { branding: own } }, read)).toEqual({
      ok: true,
      startingBranding: kit,
      look: {
        branding: "script",
        kit: null,
        brandKitError: null,
        wallpaperError: null,
      },
    });
  });
  it("takes a named kit, and says which", () => {
    expect(lookForRun({ look: { kit: "light" } }, read)).toEqual({
      ok: true,
      startingBranding: light.branding,
      look: {
        branding: "kit",
        kit: { name: "Light" },
        brandKitError: null,
        wallpaperError: null,
      },
    });
  });
  it("takes the default kit when the script names none, and says which", () => {
    expect(lookForRun({}, read)).toEqual({
      ok: true,
      startingBranding: kit,
      look: {
        branding: "defaultKit",
        kit: { name: "Dark" },
        brandKitError: null,
        wallpaperError: null,
      },
    });
  });
  it("no kits at all is the defaults, and is not a fault", () => {
    expect(lookForRun({}, coerceBrandKits(undefined, undefined))).toEqual({
      ok: true,
      startingBranding: BRANDING_DEFAULTS,
      look: {
        branding: "defaults",
        kit: null,
        brandKitError: null,
        wallpaperError: null,
      },
    });
  });
  // Red if an unknown name falls back to the default.
  it("refuses an unknown kit name, listing the kits there are", () => {
    expect(lookForRun({ look: { kit: "Blue" } }, read)).toEqual({
      ok: false,
      reason: "unknownKit",
      detail:
        'no brand kit is named "Blue" — the kits are "Dark", "Light", "Broken"',
    });
  });
  it("refuses a named kit that cannot be read, with its reason", () => {
    const out = lookForRun({ look: { kit: "Broken" } }, read);
    expect(out.ok).toBe(false);
    expect(!out.ok && out.detail).toMatch(
      /^the brand kit "Broken" could not be read: background/,
    );
  });
  it("refuses a named kit when there are no kits at all", () => {
    expect(
      lookForRun(
        { look: { kit: "Dark" } },
        coerceBrandKits(undefined, undefined),
      ),
    ).toEqual({
      ok: false,
      reason: "unknownKit",
      detail: 'no brand kit is named "Dark" — there are no brand kits',
    });
  });
  // Final review: an unreadable list is not a wrong name. Red if it is
  // refused as `unknownKit`, which tells an agent to fix a name that may be
  // right.
  it("refuses a named kit when the list cannot be read, as kitsUnreadable", () => {
    const out = lookForRun(
      { look: { kit: "Dark" } },
      { state: "invalid", reason: "r" },
    );
    expect(out).toEqual({
      ok: false,
      reason: "kitsUnreadable",
      detail: 'the brand kits could not be read (r), so "Dark" cannot be found',
    });
  });
  it("an unreadable default kit is the defaults, with the reason", () => {
    const out = lookForRun({}, coerceBrandKits([broken], "kit-broken"));
    expect(out.ok && out.startingBranding).toEqual(BRANDING_DEFAULTS);
    expect(out.ok && out.look.branding).toBe("defaults");
    expect(out.ok && out.look.brandKitError).toMatch(
      /^Your default brand kit "Broken" could not be read, so this take uses the default background: /,
    );
  });
  it("reports the default kit's failure even when the script's branding made it moot", () => {
    const out = lookForRun(
      { look: { branding: kit as SceneBranding } },
      coerceBrandKits([broken], "kit-broken"),
    );
    expect(out.ok && out.look.brandKitError).toMatch(
      /^Your default brand kit "Broken" could not be read \(.+\); this take uses the script's own branding$/,
    );
    expect(out.ok && out.look.brandKitError).not.toMatch(/default background/);
  });
});

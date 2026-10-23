import { BRANDING_DEFAULTS, type SceneBranding } from "@demoman/scene-schema";
import { describe, expect, it } from "vitest";
import {
  applyBrandingPatch,
  resolveBrandingPreview,
  sameBranding,
} from "../../../pages/src/editor/branding";

const withLogo: SceneBranding = {
  background: { kind: "solid", color: "#1b2a4a" },
  logo: { ref: "logo:a", corner: "bottom-right", size: 0.06, opacity: 0.9 },
  padding: 0.08,
};

describe("applyBrandingPatch", () => {
  it("replaces the background whole", () => {
    const next = applyBrandingPatch(withLogo, {
      background: {
        kind: "gradient",
        from: "#000000",
        to: "#ffffff",
        angle: 90,
      },
    });
    expect(next.background).toEqual({
      kind: "gradient",
      from: "#000000",
      to: "#ffffff",
      angle: 90,
    });
    expect(next.logo).toBe(withLogo.logo);
  });

  it("adjusts one logo field and keeps the rest", () => {
    expect(
      applyBrandingPatch(withLogo, { logo: { corner: "top-left" } }).logo,
    ).toEqual({
      ...withLogo.logo,
      corner: "top-left",
    });
  });

  it("sets a whole logo when the patch carries a ref", () => {
    const logo = {
      ref: "logo:b",
      corner: "top-right" as const,
      size: 0.1,
      opacity: 1,
    };
    expect(applyBrandingPatch(BRANDING_DEFAULTS, { logo }).logo).toEqual(logo);
  });

  it("removes the logo on null", () => {
    expect(applyBrandingPatch(withLogo, { logo: null }).logo).toBeNull();
  });

  it("refuses to adjust a logo that is not there, and says so", () => {
    expect(() =>
      applyBrandingPatch(BRANDING_DEFAULTS, { logo: { size: 0.1 } }),
    ).toThrow("there is no logo to adjust — upload one first");
  });

  it("adjusts a gradient in place, and swaps its colours", () => {
    const gradient: SceneBranding = {
      background: {
        kind: "gradient",
        from: "#000000",
        to: "#ffffff",
        angle: 40,
      },
      logo: null,
      padding: 0.08,
    };
    expect(
      applyBrandingPatch(gradient, { gradient: { swap: true } }).background,
    ).toEqual({ kind: "gradient", from: "#ffffff", to: "#000000", angle: 40 });
    expect(
      applyBrandingPatch(gradient, { gradient: { angle: 90 } }).background,
    ).toEqual({ kind: "gradient", from: "#000000", to: "#ffffff", angle: 90 });
  });

  it("refuses to adjust a gradient that is not there, and says so", () => {
    expect(() =>
      applyBrandingPatch(withLogo, { gradient: { angle: 90 } }),
    ).toThrow("the background is not a gradient any more");
  });

  it("leaves branding untouched for an empty patch", () => {
    expect(applyBrandingPatch(withLogo, {})).toEqual(withLogo);
  });
});

describe("resolveBrandingPreview", () => {
  const s0 = { branding: withLogo } as never as { branding: SceneBranding };
  const s1 = { branding: BRANDING_DEFAULTS } as never as {
    branding: SceneBranding;
  };
  const red = { background: { kind: "solid" as const, color: "#e03131" } };

  it("layers the preview over the scene it was taken against", () => {
    const out = resolveBrandingPreview({ patch: red, scene: s0 }, s0);
    expect(out.branding.background).toEqual(red.background);
    expect(out.preview).not.toBeNull();
  });

  it("drops a preview for good once the document moves, so undo cannot revive it", () => {
    // Review Focus 2. Undo hands back the PREVIOUS scene object — the very
    // one the preview was taken against. Ignoring a stale preview is not
    // enough; it has to be gone by the time that object comes back.
    const afterCommit = resolveBrandingPreview({ patch: red, scene: s0 }, s1);
    expect(afterCommit.preview).toBeNull();
    expect(afterCommit.branding).toBe(s1.branding);
    const afterUndo = resolveBrandingPreview(afterCommit.preview, s0);
    expect(afterUndo.branding).toBe(s0.branding);
  });

  it("drops a preview that no longer applies, and says why", () => {
    const report: string[] = [];
    const out = resolveBrandingPreview(
      { patch: { logo: { size: 0.1 } }, scene: s1 },
      s1,
      (e) => report.push(e.message),
    );
    expect(out.preview).toBeNull();
    expect(out.branding).toBe(s1.branding);
    expect(report).toEqual(["there is no logo to adjust — upload one first"]);
  });
});

describe("sameBranding", () => {
  it("compares field by field, key order aside", () => {
    const reordered: SceneBranding = {
      logo: { opacity: 0.9, size: 0.06, corner: "bottom-right", ref: "logo:a" },
      padding: 0.08,
      background: { color: "#1b2a4a", kind: "solid" },
    };
    expect(sameBranding(withLogo, reordered)).toBe(true);
  });

  it("tells apart a moved logo, a removed one, and a different background", () => {
    expect(
      sameBranding(
        withLogo,
        applyBrandingPatch(withLogo, { logo: { size: 0.1 } }),
      ),
    ).toBe(false);
    expect(sameBranding(withLogo, { ...withLogo, logo: null })).toBe(false);
    expect(
      sameBranding(withLogo, {
        ...withLogo,
        background: {
          kind: "gradient",
          from: "#1b2a4a",
          to: "#1b2a4a",
          angle: 0,
        },
      }),
    ).toBe(false);
  });
});

describe("applyBrandingPatch keeps padding", () => {
  const branding: SceneBranding = {
    background: {
      kind: "gradient",
      from: "#1b2a4a",
      to: "#3b5bdb",
      angle: 135,
    },
    logo: { ref: "logo:a", corner: "top-left", size: 0.06, opacity: 1 },
    padding: 0.13,
  };
  // Red if the merge rebuilds branding from background and logo alone: every
  // colour, angle or logo edit would then reset the author's padding.
  it.each([
    ["a whole background", { background: { kind: "solid", color: "#000000" } }],
    ["a gradient angle", { gradient: { angle: 10 } }],
    ["a swap", { gradient: { swap: true } }],
    ["a logo adjustment", { logo: { size: 0.1 } }],
    ["removing the logo", { logo: null }],
  ] as const)("through %s", (_name, patch) => {
    expect(applyBrandingPatch(branding, patch as never).padding).toBe(0.13);
  });
});

describe("padding edits", () => {
  const branding: SceneBranding = {
    background: { kind: "solid", color: "#1b2a4a" },
    logo: null,
    padding: 0.08,
  };
  it("a padding patch sets padding and nothing else", () => {
    const next = applyBrandingPatch(branding, { padding: 0.15 });
    expect(next).toEqual({ ...branding, padding: 0.15 });
  });
  // Review Focus 2, the half that lives here: a branding that differs only
  // in padding is a different picture. Red if `sameBranding` ignores it,
  // which turns Reset-to-kit and the slider's commit into no-ops.
  it("sameBranding tells two paddings apart", () => {
    expect(sameBranding(branding, { ...branding, padding: 0.09 })).toBe(false);
    expect(sameBranding(branding, { ...branding })).toBe(true);
  });
});

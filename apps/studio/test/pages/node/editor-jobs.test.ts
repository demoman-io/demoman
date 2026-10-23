import { describe, expect, it } from "vitest";
import {
  beatLabelAt,
  violationReport,
  violationSentence,
} from "../../../pages/src/editor/jobs";

describe("violationSentence", () => {
  // DetailViolation carries outputTimeMs, requestedScale, grantedScale and
  // sourceWidth — and deliberately no actionId. The beat has to be found
  // from the time, which is what `beatAt` is for.
  const violation = {
    outputTimeMs: 4200,
    requestedScale: 1.8,
    grantedScale: 1.31,
    sourceWidth: 1280,
    // A cut that lands exactly on the available detail: sampling 1.0, which
    // is what clamping TO the headroom means. The under-sampled cases below
    // are the ones where this number goes above `sourceWidth`.
    neededWidth: 1280,
  };

  it("names the beat and both scales, because that is the point of reporting it", () => {
    const sentence = violationSentence(violation, () => "Checkout");
    expect(sentence).toContain("Checkout");
    expect(sentence).toContain("1.8");
    expect(sentence).toContain("1.31");
    expect(sentence).toMatch(/source frames/i);
  });

  it("reports the source width, which is the thing the author can change", () => {
    expect(violationSentence(violation, () => "Checkout")).toContain("1280");
  });

  it("falls back to a time when no beat covers the instant", () => {
    expect(violationSentence(violation, () => null)).toContain("4.2");
  });
  /**
   * A cut smaller than two decimals: the source backs 1.797x of a 1.8x
   * zoom. Rounded alike, the two scales printed as "reduced from 1.8x to
   * 1.8x" — a sentence that contradicts itself. The cut is real, so it is
   * still reported; it is printed at the precision that tells them apart.
   * Verified failable: printing both through the two-decimal `scaleText`
   * again fails the first assertion.
   */
  it("never prints a reduction whose two scales read the same", () => {
    const sentence = violationSentence(
      { ...violation, requestedScale: 1.8, grantedScale: 1.7968 },
      () => "Checkout",
    );
    expect(sentence).not.toMatch(/from 1\.8x to 1\.8x/);
    expect(sentence).toContain("reduced from 1.8x to 1.797x");
    // Precision only where it is needed: an ordinary cut keeps two places.
    expect(violationSentence(violation, () => "Checkout")).toContain(
      "reduced from 1.8x to 1.31x",
    );
  });
});

describe("beatLabelAt", () => {
  const beats = [
    { outputMs: 1000, label: "Search" },
    { outputMs: 3000, label: "Row" },
    { outputMs: 7000, label: "Checkout" },
  ];

  it("returns the last beat at or before the instant, not the nearest", () => {
    // 2500 is nearer to Row (500ms) than to Search (1500ms). A
    // nearest-in-either-direction implementation would answer "Row" and
    // name a step the author has not reached yet.
    expect(beatLabelAt(beats)(2500)).toBe("Search");
    expect(beatLabelAt(beats)(6999)).toBe("Row");
    expect(beatLabelAt(beats)(3000)).toBe("Row");
  });

  it("returns null before the first beat, so the sentence falls back to a time", () => {
    expect(beatLabelAt(beats)(0)).toBeNull();
    expect(beatLabelAt(beats)(999)).toBeNull();
  });

  it("ignores beats with no position and survives an unsorted list", () => {
    const messy = [
      { outputMs: 7000, label: "Checkout" },
      { outputMs: null, label: "Unreached" },
      { outputMs: 1000, label: "Search" },
    ];
    expect(beatLabelAt(messy)(5000)).toBe("Search");
    expect(beatLabelAt(messy)(8000)).toBe("Checkout");
  });
});

/**
 * The quiet fault, added 2026-09-21.
 *
 * `clampToSourceDetail` floors its grant at 1.0, so a target that outruns the
 * capture produces violations whose requested and granted scales are both
 * 1.0 — nothing was reduced, and the old sentence would have read "reduced
 * from 1x to 1x". The picture is still upscaled, and saying so is the whole
 * reason the violation now exists.
 */
describe("violationSentence, under-sampled with no zoom cut", () => {
  /** Measured shape: a 2280px motion span against 2368px of drawn output. */
  const undersampled = {
    outputTimeMs: 4200,
    requestedScale: 1,
    grantedScale: 1,
    sourceWidth: 2280,
    neededWidth: 2368,
  };

  // The premise: if this fixture stops under-sampling, every case below
  // passes against a sentence that never had to be written.
  it("is a fixture whose frames really are short of the output", () => {
    expect(undersampled.sourceWidth).toBeLessThan(undersampled.neededWidth);
    expect(undersampled.grantedScale).toBe(undersampled.requestedScale);
  });

  it("does not claim a zoom was reduced", () => {
    const sentence = violationSentence(undersampled, () => "Checkout");
    expect(sentence).not.toMatch(/reduced/i);
    expect(sentence).not.toContain("1x to 1x");
  });

  it("names the beat and both pixel widths", () => {
    const sentence = violationSentence(undersampled, () => "Checkout");
    expect(sentence).toContain("Checkout");
    expect(sentence).toContain("2280");
    expect(sentence).toContain("2368");
  });

  // Rounded. The export panel showed "1.4444444444444444x" on a real render.
  it("rounds the scales it prints", () => {
    const sentence = violationSentence(
      { ...undersampled, requestedScale: 1.8, grantedScale: 4 / 3 },
      () => "Checkout",
    );
    expect(sentence).toContain("1.33");
    expect(sentence).not.toContain("1.3333333333333333");
  });

  // A cut AND short of the output: both facts, one sentence. Reporting only
  // the cut would tell the author the remaining zoom is safe when it is not.
  it("says a cut zoom is still short when it is", () => {
    const sentence = violationSentence(
      { ...undersampled, requestedScale: 1.8, grantedScale: 1.44 },
      () => "Checkout",
    );
    expect(sentence).toMatch(/reduced/i);
    expect(sentence).toContain("2280");
  });
});

describe("violationReport", () => {
  const beat = (label: string) => () => label;
  const cut = {
    outputTimeMs: 0,
    requestedScale: 1.8,
    grantedScale: 1.44,
    sourceWidth: 3420,
    neededWidth: 3420,
  };
  const short = {
    outputTimeMs: 0,
    requestedScale: 1,
    grantedScale: 1,
    sourceWidth: 2280,
    neededWidth: 2368,
  };

  it("heads a cut-only list with the reduction", () => {
    expect(violationReport([cut], beat("Checkout")).heading).toMatch(
      /reduced/i,
    );
  });

  // The old heading was hardcoded to the reduction, so an under-sampled-only
  // export would have been titled for a cut that never happened.
  it("does not head an under-sampled-only list with a reduction", () => {
    const { heading } = violationReport([short], beat("Checkout"));
    expect(heading).not.toMatch(/reduced/i);
    expect(heading).toMatch(/pixels|detail|resolution/i);
  });

  it("covers both when both are present", () => {
    const { lines } = violationReport(
      [cut, { ...short, outputTimeMs: 900 }],
      (ms) => (ms === 0 ? "Checkout" : "Search"),
    );
    expect(lines).toHaveLength(2);
    expect(lines.join(" ")).toContain("Checkout");
    expect(lines.join(" ")).toContain("Search");
  });

  /**
   * The flood this function exists for. Under-sampling is true of EVERY
   * camera key over an affected span, not just the peak one a cut zoom
   * lands on, so the panel would grow a line per key — sixty lines saying
   * one thing. One line per beat per fault, keeping the worst.
   */
  it("collapses repeats on one beat to a single line", () => {
    const many = Array.from({ length: 40 }, (_, i) => ({
      ...short,
      outputTimeMs: i * 10,
    }));
    const { lines } = violationReport(many, beat("Checkout"));
    expect(lines).toHaveLength(1);
  });

  it("keeps the worst sampling when it collapses them", () => {
    const { lines } = violationReport(
      [
        { ...short, sourceWidth: 2300 },
        { ...short, outputTimeMs: 10, sourceWidth: 1500 },
        { ...short, outputTimeMs: 20, sourceWidth: 2200 },
      ],
      beat("Checkout"),
    );
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("1500");
  });

  it("keeps separate beats apart", () => {
    const { lines } = violationReport(
      [short, { ...short, outputTimeMs: 900 }],
      (ms) => (ms === 0 ? "Checkout" : "Search"),
    );
    expect(lines).toHaveLength(2);
  });
});

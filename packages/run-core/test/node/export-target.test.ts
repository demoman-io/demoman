import {
  autoTarget,
  GIF_800,
  GIF_VERTICAL_450,
  HIGH_LANDSCAPE,
  HIGH_MAX_BITRATE,
  HIGH_VERTICAL,
  LANDSCAPE_4K,
  LANDSCAPE_1080P,
  LANDSCAPE_1440P,
  SHARE_LANDSCAPE,
  SHARE_VERTICAL,
  STILL_1440,
  STILL_VERTICAL_1080,
  VERTICAL_1080,
} from "@demoman/compositor";
import { describe, expect, it } from "vitest";
import { proceduralBundle } from "../../../replay-engine/test/helpers/bundles";
import { readonlyScene } from "../../../replay-engine/test/helpers/scenes";
import {
  contentTypeFor,
  exportBaseName,
  exportFileName,
  frameOf,
  stillsFolder,
  targetFor,
} from "../../src/export/target.js";

describe("targetFor", () => {
  const FRAME = { padding: 0.08, viewport: { width: 1512, height: 820 } };

  it("lets the keyframes decide the landscape MP4's resolution", () => {
    expect(targetFor("mp4", "16:9", proceduralBundle(), FRAME)).toEqual(
      LANDSCAPE_4K,
    );
    const small = proceduralBundle({
      keyframes: proceduralBundle().keyframes.map((k) => ({
        ...k,
        width: 1920,
        height: 1200,
      })),
    });
    expect(targetFor("mp4", "16:9", small, FRAME)).toEqual(LANDSCAPE_1080P);
    expect(targetFor("mp4", "16:9", null, FRAME)).toEqual(LANDSCAPE_1080P);
  });

  // The tests-only cap (`ExecutorOptions.mp4MaxTier`): the runner's export
  // lane renders landscape in software, where 4K cost 128 s an export.
  it("caps a landscape MP4 at maxTier, and never raises one", () => {
    const bundle = proceduralBundle();
    // Premise: uncapped, these keyframes back 4K.
    expect(targetFor("mp4", "16:9", bundle, FRAME)).toEqual(LANDSCAPE_4K);
    expect(
      targetFor("mp4", "16:9", bundle, FRAME, { maxTier: LANDSCAPE_1080P }),
    ).toEqual(LANDSCAPE_1080P);
    expect(
      targetFor("mp4", "16:9", bundle, FRAME, { maxTier: LANDSCAPE_4K }),
    ).toEqual(LANDSCAPE_4K);
    const small = proceduralBundle({
      keyframes: bundle.keyframes.map((k) => ({
        ...k,
        width: 1920,
        height: 1200,
      })),
    });
    expect(
      targetFor("mp4", "16:9", small, FRAME, { maxTier: LANDSCAPE_4K }),
    ).toEqual(LANDSCAPE_1080P);
  });

  it("caps Auto's tier but keeps the recording's shape", () => {
    const bundle = proceduralBundle();
    const free = targetFor("mp4", "auto", bundle, FRAME);
    const capped = targetFor("mp4", "auto", bundle, FRAME, {
      maxTier: LANDSCAPE_1080P,
    });
    // Premise: uncapped Auto took a tier wider than the cap.
    expect(Math.max(free.width, free.height)).toBeGreaterThan(1920);
    expect(Math.max(capped.width, capped.height)).toBeLessThanOrEqual(1920);
    expect(capped.width / capped.height).toBeCloseTo(
      free.width / free.height,
      2,
    );
  });

  it("leaves GIF, stills and 9:16 alone under a cap", () => {
    const bundle = proceduralBundle();
    expect(
      targetFor("gif", "16:9", bundle, FRAME, { maxTier: LANDSCAPE_1080P }),
    ).toEqual(GIF_800);
    expect(
      targetFor("stills", "16:9", bundle, FRAME, { maxTier: LANDSCAPE_1080P }),
    ).toEqual(STILL_1440);
    expect(
      targetFor("mp4", "9:16", bundle, FRAME, { maxTier: LANDSCAPE_1080P }),
    ).toEqual(VERTICAL_1080);
  });

  it("turns every file type on end for 9:16", () => {
    const bundle = proceduralBundle();
    expect(targetFor("mp4", "9:16", bundle, FRAME)).toEqual(VERTICAL_1080);
    expect(targetFor("gif", "9:16", bundle, FRAME)).toEqual(GIF_VERTICAL_450);
    expect(targetFor("stills", "9:16", bundle, FRAME)).toEqual(
      STILL_VERTICAL_1080,
    );
  });

  it("keeps today's presets for 16:9 GIF and stills", () => {
    const bundle = proceduralBundle();
    expect(targetFor("gif", "16:9", bundle, FRAME)).toEqual(GIF_800);
    expect(targetFor("stills", "16:9", bundle, FRAME)).toEqual(STILL_1440);
  });

  it("sizes Auto from the recording, the padding and the tier", () => {
    const bundle = proceduralBundle();
    // Premise: the procedural bundle's frames are 1280x800, not the
    // fallback's 1512x820, and back the 4K tier.
    expect(bundle.viewport).toEqual({ width: 1280, height: 800 });
    // Review Focus 2: the frames' viewport wins over the recorded one.
    // 3754x2496, not the formula's 3840x2554: held under H.264 level 5.2
    // (autoTarget). 1512x820 would give 3840x2248.
    expect(targetFor("mp4", "auto", bundle, FRAME)).toMatchObject({
      width: 3754,
      height: 2496,
    });
    expect(targetFor("gif", "auto", bundle, FRAME)).toMatchObject({
      width: 800,
      height: 532,
    });
    expect(targetFor("stills", "auto", bundle, FRAME)).toMatchObject({
      width: 2560,
      height: 1702,
    });
  });

  // Review 2026-10-06: the tier was picked by keyframe WIDTH, but an Auto
  // frame takes the tier's long side, which for a portrait recording is its
  // height — so 4200-tall keyframes backed a 3840-tall frame and got 2560.
  // Red if the Auto tier is measured along the keyframes' width again.
  it("picks a portrait Auto MP4's tier along the keyframes' long side", () => {
    const viewport = { width: 900, height: 1400 };
    const keyframe = { width: 2700, height: 4200 };
    const bundle = proceduralBundle({
      viewport,
      keyframes: proceduralBundle().keyframes.map((k) => ({
        ...k,
        ...keyframe,
      })),
    });
    // Premise: the width alone backs only the 1440 tier, the height 4K.
    expect(keyframe.width).toBeLessThan(LANDSCAPE_4K.width);
    expect(keyframe.width).toBeGreaterThanOrEqual(LANDSCAPE_1440P.width);
    expect(keyframe.height).toBeGreaterThanOrEqual(LANDSCAPE_4K.width);
    const t = targetFor("mp4", "auto", bundle, { ...FRAME, viewport });
    expect(t).toEqual(autoTarget(LANDSCAPE_4K, viewport, FRAME.padding));
    expect(t.height).toBeGreaterThan(LANDSCAPE_1440P.width);
    // 16:9 keeps measuring width: its frame's long side is always its width.
    expect(targetFor("mp4", "16:9", bundle, FRAME)).toEqual(LANDSCAPE_1440P);
  });

  it("sizes Auto from the take's recorded viewport before any frames exist", () => {
    expect(targetFor("mp4", "auto", null, FRAME)).toMatchObject({
      width: 1920,
      height: 1124,
    });
  });

  // Keyframes 1920 wide: what a take filmed at DPR 1.5 of a 1280 window,
  // or any take capped at 1080p, backs.
  const keyframesAt = (width: number, height: number) =>
    proceduralBundle({
      keyframes: proceduralBundle().keyframes.map((k) => ({
        ...k,
        width,
        height,
      })),
    });

  describe("quality", () => {
    it("share picks SHARE_LANDSCAPE for 4K keyframes", () => {
      const bundle = proceduralBundle();
      // Premise: at full quality these keyframes back 4K.
      expect(targetFor("mp4", "16:9", bundle, FRAME)).toEqual(LANDSCAPE_4K);
      const share = targetFor("mp4", "16:9", bundle, FRAME, {
        quality: "share",
      });
      expect(share).toEqual(SHARE_LANDSCAPE);
      // §8's pick, written out: red if the constant drifts from it.
      expect(share).toMatchObject({
        width: 1920,
        height: 1080,
        fps: 30,
        bitrate: 5_000_000,
        encoder: { quality: 0.5 },
        fit: "contain",
      });
    });

    it("share never upscales", () => {
      const small = keyframesAt(1920, 1200);
      // Premise: at full quality these keyframes back only 1080p.
      expect(targetFor("mp4", "16:9", small, FRAME)).toEqual(LANDSCAPE_1080P);
      const share = targetFor("mp4", "16:9", small, FRAME, {
        quality: "share",
      });
      expect(share.width).toBeLessThanOrEqual(LANDSCAPE_1080P.width);
      expect(share.height).toBeLessThanOrEqual(LANDSCAPE_1080P.height);
      // Share's frame rate and encoder, still: the frame is the only thing
      // the keyframes decide.
      expect(share).toMatchObject({ fps: 30, encoder: { quality: 0.5 } });
      // Nor a frame without a bundle, whose floor is 1080p.
      const none = targetFor("mp4", "16:9", null, FRAME, { quality: "share" });
      expect(none.width).toBeLessThanOrEqual(LANDSCAPE_1080P.width);
      // A cap below the share frame is a smaller frame, never a larger one.
      const tiny = { ...LANDSCAPE_1080P, width: 1280, height: 720 };
      const capped = targetFor("mp4", "16:9", proceduralBundle(), FRAME, {
        maxTier: tiny,
        quality: "share",
      });
      expect(capped).toMatchObject({
        width: 1280,
        height: 720,
        fps: 30,
        encoder: { quality: 0.5 },
      });
    });

    it("share Auto keeps the recording's shape", () => {
      const bundle = proceduralBundle();
      const share = targetFor("mp4", "auto", bundle, FRAME, {
        quality: "share",
      });
      const want = autoTarget(SHARE_LANDSCAPE, bundle.viewport, FRAME.padding);
      expect(share).toEqual(want);
      // Premise of the comparison: Auto really reshaped the share frame, so
      // equality with SHARE_LANDSCAPE itself would be the wrong answer.
      expect(share.height).not.toBe(SHARE_LANDSCAPE.height);
      expect(share.width / share.height).toBeCloseTo(
        targetFor("mp4", "auto", bundle, FRAME).width /
          targetFor("mp4", "auto", bundle, FRAME).height,
        2,
      );
      expect(Math.max(share.width, share.height)).toBe(1920);
      expect(share).toMatchObject({ fps: 30, encoder: { quality: 0.5 } });
      // The nominal bitrate scales by area from the share frame's own.
      expect(share.bitrate).toBe(
        Math.round(
          (SHARE_LANDSCAPE.bitrate * share.width * share.height) /
            (1920 * 1080),
        ),
      );
      // A portrait recording takes the long side along its height.
      const viewport = { width: 900, height: 1400 };
      const tall = targetFor(
        "mp4",
        "auto",
        proceduralBundle({
          viewport,
          keyframes: proceduralBundle().keyframes.map((k) => ({
            ...k,
            width: 2700,
            height: 4200,
          })),
        }),
        { ...FRAME, viewport },
        { quality: "share" },
      );
      expect(tall).toEqual(
        autoTarget(SHARE_LANDSCAPE, viewport, FRAME.padding),
      );
      expect(tall.height).toBe(1920);
    });

    it("share 9:16 is SHARE_VERTICAL", () => {
      for (const bundle of [
        proceduralBundle(),
        keyframesAt(1920, 1200),
        null,
      ]) {
        expect(
          targetFor("mp4", "9:16", bundle, FRAME, { quality: "share" }),
        ).toEqual(SHARE_VERTICAL);
      }
      expect(SHARE_VERTICAL).toMatchObject({
        format: "mp4",
        width: 720,
        height: 1280,
        fps: 30,
        bitrate: 2_670_000,
        cornerRadius: 16,
        encoder: { quality: 0.5 },
        fit: "cover",
      });
    });

    it("high is 1440p at 60 fps and 8 Mbps when the keyframes back it", () => {
      const bundle = proceduralBundle();
      // Premise: at full quality these keyframes back 4K, wider than high.
      expect(targetFor("mp4", "16:9", bundle, FRAME)).toEqual(LANDSCAPE_4K);
      const high = targetFor("mp4", "16:9", bundle, FRAME, { quality: "high" });
      expect(high).toEqual(HIGH_LANDSCAPE);
      // The author's pick (2026-10-23), written out: 8 Mbps is 30 MB in
      // 30 s, inside "20-40MB for a 30 second clip".
      expect(high).toMatchObject({
        width: 2560,
        height: 1440,
        fps: 60,
        bitrate: 8_000_000,
        fit: "contain",
      });
      expect((high.bitrate * 30) / 8 / 1_000_000).toBe(30);
      // Encoded by bitrate, so the size follows it: no quality hint.
      expect(high.encoder).toBeUndefined();
    });

    it("high keeps a 1080p tier's frame at its own bitrate", () => {
      const small = keyframesAt(1920, 1200);
      // Premise: at full quality these keyframes back only 1080p.
      expect(targetFor("mp4", "16:9", small, FRAME)).toEqual(LANDSCAPE_1080P);
      expect(
        targetFor("mp4", "16:9", small, FRAME, { quality: "high" }),
      ).toEqual({ ...LANDSCAPE_1080P, bitrate: HIGH_LANDSCAPE.bitrate });
    });

    it("high Auto never asks more than HIGH_MAX_BITRATE", () => {
      // Square keyframes wide enough for the 1440p tier, recorded square.
      const square = proceduralBundle({
        viewport: { width: 1500, height: 1500 },
        keyframes: proceduralBundle().keyframes.map((k) => ({
          ...k,
          width: 3000,
          height: 3000,
        })),
      });
      const shaped = autoTarget(
        HIGH_LANDSCAPE,
        { width: 1500, height: 1500 },
        FRAME.padding,
      );
      // Premise: a square recording's frame scales the bitrate past the cap.
      expect(shaped.bitrate).toBeGreaterThan(HIGH_MAX_BITRATE);
      const high = targetFor("mp4", "auto", square, FRAME, { quality: "high" });
      expect(high).toEqual({ ...shaped, bitrate: HIGH_MAX_BITRATE });
      // 37.5 MB in 30 s: under the author's 40.
      expect((HIGH_MAX_BITRATE * 30) / 8 / 1_000_000).toBeLessThan(40);
    });

    it("high Auto reshapes the high frame, and 9:16 is HIGH_VERTICAL", () => {
      const bundle = proceduralBundle();
      expect(
        targetFor("mp4", "auto", bundle, FRAME, { quality: "high" }),
      ).toEqual(autoTarget(HIGH_LANDSCAPE, bundle.viewport, FRAME.padding));
      expect(
        targetFor("mp4", "9:16", bundle, FRAME, { quality: "high" }),
      ).toEqual(HIGH_VERTICAL);
      expect(HIGH_VERTICAL).toMatchObject({
        width: 1080,
        height: 1920,
        fps: 60,
        bitrate: 8_000_000,
        fit: "cover",
      });
    });

    // Today's answers, written from the constants rather than by calling
    // the code under test: red if absent quality stops meaning "full".
    it("absent quality is today's", () => {
      const k4 = proceduralBundle();
      const k1440 = keyframesAt(2560, 1600);
      const today = {
        k4: LANDSCAPE_4K,
        k1440: LANDSCAPE_1440P,
        auto: autoTarget(LANDSCAPE_4K, k4.viewport, FRAME.padding),
        vertical: VERTICAL_1080,
      };
      for (const options of [undefined, {}, { quality: "full" as const }]) {
        expect(targetFor("mp4", "16:9", k4, FRAME, options)).toEqual(today.k4);
        expect(targetFor("mp4", "16:9", k1440, FRAME, options)).toEqual(
          today.k1440,
        );
        expect(targetFor("mp4", "auto", k4, FRAME, options)).toEqual(
          today.auto,
        );
        expect(targetFor("mp4", "9:16", k4, FRAME, options)).toEqual(
          today.vertical,
        );
      }
      // None of today's targets carries encoder hints.
      expect(targetFor("mp4", "16:9", k4, FRAME).encoder).toBeUndefined();
    });

    it("gif and stills ignore quality", () => {
      const bundle = proceduralBundle();
      for (const aspect of ["16:9", "9:16", "auto"] as const) {
        for (const fileType of ["gif", "stills"] as const) {
          expect(
            targetFor(fileType, aspect, bundle, FRAME, { quality: "share" }),
          ).toEqual(targetFor(fileType, aspect, bundle, FRAME));
        }
      }
      // Premise: the full answer for these is the GIF and stills presets,
      // not an MP4 the share rule could have touched.
      expect(targetFor("gif", "16:9", bundle, FRAME)).toEqual(GIF_800);
      expect(targetFor("stills", "9:16", bundle, FRAME)).toEqual(
        STILL_VERTICAL_1080,
      );
    });
  });

  it("reads the frame facts off the scene", () => {
    const scene = readonlyScene();
    expect(frameOf(scene)).toEqual({
      padding: scene.branding.padding,
      viewport: scene.meta.capture.viewport,
    });
  });
});

describe("export names", () => {
  it("names the file after the take, marking the vertical one", () => {
    expect(exportFileName("mp4", "16:9", "Checkout flow")).toBe(
      "Checkout flow.mp4",
    );
    expect(exportFileName("mp4", "9:16", "Checkout flow")).toBe(
      "Checkout flow (vertical).mp4",
    );
    expect(exportFileName("gif", "16:9", "Checkout flow")).toBe(
      "Checkout flow.gif",
    );
    expect(exportFileName("gif", "9:16", "Checkout flow")).toBe(
      "Checkout flow (vertical).gif",
    );
    expect(stillsFolder("16:9", "Checkout flow")).toBe("Checkout flow stills");
    expect(stillsFolder("9:16", "Checkout flow")).toBe(
      "Checkout flow stills (vertical)",
    );
  });

  // Review Focus 1. Chrome refuses a download whose filename carries a
  // reserved character, so each of these would otherwise be a failed save.
  it("makes any take name safe to save", () => {
    expect(exportBaseName("example.com/checkout")).toBe("example.com-checkout");
    expect(exportBaseName('Q3: "What?" <draft>|final*')).toBe(
      "Q3- -What-- -draft--final-",
    );
    expect(exportBaseName("  .hidden.  ")).toBe("hidden");
    expect(exportBaseName("")).toBe("demoman");
    expect(exportBaseName("...")).toBe("demoman");
    expect(exportBaseName("tab\tand\nnewline")).toBe("tab and newline");
    const long = exportBaseName("x".repeat(300));
    expect(long).toHaveLength(120);
  });

  // Review finding 2. Chrome's downloads API refuses, beyond the reserved
  // punctuation above, a `~`, any Unicode format character (Cf — the ZWJ
  // inside a joined emoji, a soft hyphen, the direction marks RTL titles
  // carry) and a Windows device name, on every platform. Tab titles carry
  // all three.
  it("drops what Chrome's downloads API refuses beyond punctuation", () => {
    expect(exportBaseName("~/draft ~2")).toBe("--draft -2");
    // Premise: the fixture really carries a ZWJ, a soft hyphen and an RLM.
    const title = "\u{1F9D1}\u200D\u{1F4BB} Sprint\u00ADnotes \u200Fv2";
    expect([...title].filter((c) => /\p{Cf}/u.test(c))).toHaveLength(3);
    expect(exportBaseName(title)).toBe("\u{1F9D1}\u{1F4BB} Sprintnotes v2");
    for (const device of ["CON", "nul", "Com1", "LPT9", "aux"]) {
      expect(exportBaseName(device)).toBe(`${device}-`);
    }
    // Not a device name: only the bare word is reserved.
    expect(exportBaseName("Console")).toBe("Console");
  });

  it("cuts a long name on a character, never inside one", () => {
    // Premise: an astral character straddles the 120th code unit.
    const name = `${"x".repeat(119)}\u{1F600}tail`;
    expect(name.charCodeAt(119)).toBeGreaterThanOrEqual(0xd800);
    const cut = exportBaseName(name);
    expect(cut).toBe(`${"x".repeat(119)}\u{1F600}`);
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(cut)).toBe(false);
  });

  it("gives each file type a content type", () => {
    expect(contentTypeFor("mp4")).toBe("video/mp4");
    expect(contentTypeFor("gif")).toBe("image/gif");
    expect(contentTypeFor("stills")).toBe("image/png");
  });

  it("adds no suffix for Auto", () => {
    expect(exportFileName("mp4", "auto", "Checkout flow")).toBe(
      "Checkout flow.mp4",
    );
    expect(stillsFolder("auto", "Checkout flow")).toBe("Checkout flow stills");
  });
});

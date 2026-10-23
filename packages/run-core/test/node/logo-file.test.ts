import { describe, expect, it } from "vitest";
import { checkLogoFile, LOGO_MAX_BYTES } from "../../src/logo-file.js";

const file = (type: string, size = 1000, name = "logo") => ({
  name,
  type,
  size,
});

describe("checkLogoFile", () => {
  it.each(["image/svg+xml", "image/png", "image/webp"])(
    "accepts %s quietly",
    (type) => {
      expect(checkLogoFile(file(type))).toEqual({ ok: true, note: null });
    },
  );

  it("accepts JPEG and says what it costs", () => {
    expect(checkLogoFile(file("image/jpeg"))).toEqual({
      ok: true,
      note: "JPEG has no transparency — the logo shows as a box on the background",
    });
  });

  it("refuses another type, naming it", () => {
    expect(checkLogoFile(file("image/gif", 1000, "logo.gif"))).toEqual({
      ok: false,
      reason:
        'The logo "logo.gif" is a image/gif file — use SVG, PNG, WebP or JPEG',
    });
  });

  it("refuses a file with no type, saying so rather than guessing", () => {
    expect(checkLogoFile(file("", 1000, "logo"))).toEqual({
      ok: false,
      reason: 'The logo "logo" has no file type — use SVG, PNG, WebP or JPEG',
    });
  });

  it("refuses a file over 2 MB, naming its size", () => {
    expect(
      checkLogoFile(file("image/png", LOGO_MAX_BYTES + 1, "big.png")),
    ).toEqual({
      ok: false,
      reason: 'The logo "big.png" is 2.0 MB — logos are limited to 2 MB',
    });
  });
});

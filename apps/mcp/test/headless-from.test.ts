import { describe, expect, it } from "vitest";
import { headlessFrom } from "../src/serve-cli.js";

describe("headlessFrom", () => {
  it("refuses --headed on a Linux machine with no display", () => {
    const got = headlessFrom({ headed: true }, { platform: "linux", env: {} });
    expect(got).toMatchObject({ ok: false });
    if (!got.ok) {
      expect(got.error).toContain("--headed");
      expect(got.error).toContain("DISPLAY and WAYLAND_DISPLAY are unset");
    }
  });

  it("stays headless there, and opens a window where there is a display", () => {
    expect(headlessFrom({}, { platform: "linux", env: {} })).toEqual({
      ok: true,
      headless: true,
    });
    expect(
      headlessFrom(
        { headed: true },
        { platform: "linux", env: { DISPLAY: ":0" } },
      ),
    ).toEqual({ ok: true, headless: false });
  });
});

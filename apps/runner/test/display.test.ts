import { describe, expect, it } from "vitest";
import { readDisplay } from "../src/display.js";

describe("readDisplay", () => {
  it("takes DEMOMAN_DISPLAY outright, in CSS px and a scale", async () => {
    expect(await readDisplay({ DEMOMAN_DISPLAY: "1710x1107@2" })).toEqual({
      width: 1710,
      height: 1107,
      scale: 2,
    });
    expect(await readDisplay({ DEMOMAN_DISPLAY: " 1280x800@1.5 " })).toEqual({
      width: 1280,
      height: 800,
      scale: 1.5,
    });
  });

  it("refuses a DEMOMAN_DISPLAY it cannot read, naming the value and the form", async () => {
    for (const bad of ["1710x1107", "wide", "0x800@2", "1280x800@0"]) {
      expect(await readDisplay({ DEMOMAN_DISPLAY: bad })).toEqual({
        failed: `DEMOMAN_DISPLAY is "${bad}", not <width>x<height>@<scale> such as 1710x1107@2`,
      });
    }
  });

  // Asks the machine itself: macOS answers a real screen, anything else says
  // it cannot, never a guess.
  it("reads this machine's display when nothing names one", async () => {
    const got = await readDisplay({});
    if (process.platform === "darwin") {
      expect(got, JSON.stringify(got)).toMatchObject({
        width: expect.any(Number),
        height: expect.any(Number),
        scale: expect.any(Number),
      });
      if ("width" in got) expect(got.width).toBeGreaterThan(0);
    } else {
      expect(got).toEqual({
        failed: `reading the display is macOS only, and this is ${process.platform}`,
      });
    }
  });
});

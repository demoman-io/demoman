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

  // Asks the machine itself: macOS answers a real screen; elsewhere a
  // screen or why there is none (the Linux cases below), never a throw.
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
      expect(
        "failed" in got || ("width" in got && got.width > 0),
        JSON.stringify(got),
      ).toBe(true);
    }
  });
});

describe("readDisplay on Linux", () => {
  const XRANDR = `Screen 0: minimum 320 x 200, current 4480 x 1440, maximum 16384 x 16384
eDP-1 connected 1920x1080+2560+0 (normal left inverted right x axis y axis) 309mm x 174mm
   1920x1080     60.00*+
HDMI-1 connected primary 2560x1440+0+0 (normal left inverted right x axis y axis) 597mm x 336mm
   2560x1440     59.95*+
DP-1 disconnected (normal left inverted right x axis y axis)
`;
  /** A stand-in for running xrandr, counting its calls. */
  const xrandr = (answer: () => Promise<{ code: number; stdout: string }>) => {
    const calls: string[] = [];
    return {
      calls,
      run: (cmd: string, args: string[]) => {
        calls.push([cmd, ...args].join(" "));
        return answer();
      },
    };
  };
  const answering = (stdout: string) =>
    xrandr(async () => ({ code: 0, stdout }));

  it("reads the primary output's size from xrandr", async () => {
    const x = answering(XRANDR);
    expect(
      await readDisplay({ DISPLAY: ":0" }, { platform: "linux", run: x.run }),
    ).toEqual({ width: 2560, height: 1440, scale: 1 });
    expect(x.calls).toEqual(["xrandr --current"]);
  });

  // The Display is in CSS px, as macOS's points are: GDK_SCALE=2 on a
  // 2560x1440 output is a 1280x720 page screen at 2x.
  it("takes GDK_SCALE as the scale, in CSS px", async () => {
    const x = answering(XRANDR);
    expect(
      await readDisplay(
        { DISPLAY: ":0", GDK_SCALE: "2" },
        { platform: "linux", run: x.run },
      ),
    ).toEqual({ width: 1280, height: 720, scale: 2 });
  });

  it("takes the first connected output when none is primary", async () => {
    const x = answering(XRANDR.replace(" primary", ""));
    // Premise: no output is primary now, and eDP-1 is listed first.
    expect(XRANDR.replace(" primary", "")).not.toContain("primary");
    expect(
      await readDisplay({ DISPLAY: ":0" }, { platform: "linux", run: x.run }),
    ).toEqual({ width: 1920, height: 1080, scale: 1 });
  });

  it("says there is no display, asking nothing, when neither variable is set", async () => {
    const x = answering(XRANDR);
    const got = await readDisplay({}, { platform: "linux", run: x.run });
    expect(got).toMatchObject({ failed: expect.stringContaining("no display") });
    expect(x.calls).toEqual([]);
  });

  it("says xrandr could not read the screen when it is missing", async () => {
    const x = xrandr(async () => {
      throw Object.assign(new Error("spawn xrandr ENOENT"), { code: "ENOENT" });
    });
    const got = await readDisplay(
      { WAYLAND_DISPLAY: "wayland-0" },
      { platform: "linux", run: x.run },
    );
    expect(got).toMatchObject({
      failed: expect.stringContaining("xrandr could not read"),
    });
    if ("failed" in got) expect(got.failed).toContain("ENOENT");
  });

  it("says so when xrandr lists no connected output with a size", async () => {
    const x = answering("Screen 0: minimum 320 x 200\nDP-1 disconnected\n");
    const got = await readDisplay(
      { DISPLAY: ":0" },
      { platform: "linux", run: x.run },
    );
    expect(got).toMatchObject({
      failed: expect.stringContaining("xrandr could not read"),
    });
  });

  it("lets DEMOMAN_DISPLAY win on Linux too", async () => {
    const x = answering(XRANDR);
    expect(
      await readDisplay(
        { DISPLAY: ":0", DEMOMAN_DISPLAY: "1920x1080@1" },
        { platform: "linux", run: x.run },
      ),
    ).toEqual({ width: 1920, height: 1080, scale: 1 });
    expect(x.calls).toEqual([]);
  });
});

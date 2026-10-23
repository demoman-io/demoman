import { describe, expect, it } from "vitest";
import { chooseRunSize, viewportForScreen } from "../../src/replay/run-size.js";

// A 14" MacBook Pro's default scaled resolution, in CSS px — the screen the
// author watches agent runs on.
const MACBOOK = { width: 1512, height: 982 };

describe("viewportForScreen", () => {
  it("is the whole screen under `screen`", () => {
    expect(viewportForScreen(MACBOOK, "screen")).toEqual({
      ok: true,
      viewport: { width: 1512, height: 982 },
    });
  });

  // The width is kept because it is what a page's breakpoints read: a ratio
  // that shrank the width would hand a desktop app its tablet layout.
  it("keeps the screen's width and derives the height for a ratio", () => {
    expect(viewportForScreen(MACBOOK, "16:9")).toEqual({
      ok: true,
      viewport: { width: 1512, height: 851 },
    });
    expect(viewportForScreen(MACBOOK, "16:10")).toEqual({
      ok: true,
      viewport: { width: 1512, height: 945 },
    });
  });

  // `DemoScriptSchema.viewport` is integer CSS px, and so is the take's
  // `meta.capture.viewport` this lands in.
  it("answers whole pixels", () => {
    const answer = viewportForScreen({ width: 1366, height: 768 }, "16:10");
    expect(answer).toEqual({
      ok: true,
      viewport: { width: 1366, height: 854 },
    });
  });

  // Each of these is a screen nobody can film at. Refused with the numbers,
  // so the run that falls back can say what it was given.
  it.each([
    ["missing", undefined],
    ["zero", { width: 0, height: 0 }],
    ["not a number", { width: Number.NaN, height: 982 }],
    ["negative", { width: 1512, height: -1 }],
  ])("refuses a %s screen and says what it read", (_, screen) => {
    const answer = viewportForScreen(screen, "screen");
    expect(answer.ok).toBe(false);
    if (answer.ok) return;
    expect(answer.error).toMatch(/screen/);
    if (screen !== undefined) {
      expect(answer.error).toContain(`${screen.width}x${screen.height}`);
    }
  });
});

describe("chooseRunSize", () => {
  it("films a script's own viewport, whatever the setting", () => {
    expect(
      chooseRunSize({
        scriptViewport: { width: 1280, height: 800 },
        device: undefined,
        setting: "16:9",
        screen: MACBOOK,
      }),
    ).toEqual({
      kind: "fixed",
      size: { width: 1280, height: 800, from: "script", error: null },
    });
  });

  it("films a device at the device's size", () => {
    expect(
      chooseRunSize({
        scriptViewport: undefined,
        device: { width: 393, height: 852 },
        setting: "screen",
        screen: MACBOOK,
      }),
    ).toEqual({
      kind: "fixed",
      size: { width: 393, height: 852, from: "device", error: null },
    });
  });

  // The change itself: a script that names no size films at the author's
  // setting, not at the hidden stage window's 900x519.
  it("films the author's setting when the script names no size", () => {
    expect(
      chooseRunSize({
        scriptViewport: undefined,
        device: undefined,
        setting: "screen",
        screen: MACBOOK,
      }),
    ).toEqual({
      kind: "fixed",
      size: { width: 1512, height: 982, from: "screen", error: null },
    });
    expect(
      chooseRunSize({
        scriptViewport: undefined,
        device: undefined,
        setting: "16:9",
        screen: MACBOOK,
      }),
    ).toEqual({
      kind: "fixed",
      size: { width: 1512, height: 851, from: "16:9", error: null },
    });
  });

  // Forgiven, and said: the run goes ahead at the window's size, and the
  // reason travels with the plan so the report can carry it.
  it("falls back to the window with the reason when the screen is unreadable", () => {
    const plan = chooseRunSize({
      scriptViewport: undefined,
      device: undefined,
      setting: "screen",
      screen: { width: 0, height: 0 },
    });
    expect(plan.kind).toBe("measure");
    if (plan.kind !== "measure") return;
    expect(plan.error).toContain("0x0");
  });

  // The CLI's headless browser when it could not read the display it stands
  // in for: the page's screen is Chrome's stand-in, and the caller's reason
  // goes on the plan in its own words.
  it("falls back to the window with the caller's reason when the screen is known not to be real", () => {
    const why = "Demoman could not read this computer's display (no)";
    expect(
      chooseRunSize({
        scriptViewport: undefined,
        device: undefined,
        setting: "16:9",
        screen: { error: why },
      }),
    ).toEqual({ kind: "measure", error: why });
    // A script's own size never needs the screen, so it is untouched.
    expect(
      chooseRunSize({
        scriptViewport: { width: 1280, height: 800 },
        device: undefined,
        setting: "screen",
        screen: { error: why },
      }).kind,
    ).toBe("fixed");
  });
});

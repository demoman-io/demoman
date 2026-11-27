import { describe, expect, it } from "vitest";
import { isHeld, validateBundle } from "../../src/index.js";
import { proceduralBundle } from "../fixtures/bundle.js";

const realBundle = () => ({ ...proceduralBundle(), timing: "real" as const });
const captureBundle = () => ({
  ...proceduralBundle(),
  source: "capture" as const,
  timing: undefined,
});

describe("FrameBundle.clock", () => {
  it("fixtures say what the cases below rely on", () => {
    expect(realBundle().source).toBe("replay");
    expect(realBundle().timing).toBe("real");
    expect(captureBundle().source).toBe("capture");
    expect(isHeld(validateBundle(realBundle()))).toBe(false);
  });

  it("keeps a held bundle's clock and network stretches", () => {
    const b = validateBundle({
      ...realBundle(),
      clock: "held",
      networkSpans: [{ startMs: 100, endMs: 900, label: "POST /api/chat" }],
    });
    expect(b.clock).toBe("held");
    expect(b.networkSpans).toHaveLength(1);
    expect(isHeld(b)).toBe(true);
  });

  // The take's frame length, kept; absent on an older take.
  it("keeps a held bundle's frame length, and refuses one of 0 ms or less", () => {
    const at = (heldFrameMs: number) =>
      validateBundle({ ...realBundle(), clock: "held", heldFrameMs });
    expect(at(1000 / 60).heldFrameMs).toBe(1000 / 60);
    expect(validateBundle({ ...realBundle(), clock: "held" }).heldFrameMs).toBe(
      undefined,
    );
    expect(() => at(0)).toThrow(/heldFrameMs/);
    expect(() => at(-1)).toThrow(/heldFrameMs/);
  });

  it("refuses a held clock on a capture bundle", () => {
    expect(() => validateBundle({ ...captureBundle(), clock: "held" })).toThrow(
      /held/,
    );
  });

  it("refuses a held clock without real timing", () => {
    expect(() =>
      validateBundle({ ...realBundle(), timing: undefined, clock: "held" }),
    ).toThrow(/held/);
  });

  it("refuses a network stretch that ends before it starts", () => {
    expect(() =>
      validateBundle({
        ...realBundle(),
        clock: "held",
        networkSpans: [{ startMs: 9, endMs: 3, label: "x" }],
      }),
    ).toThrow();
  });
});

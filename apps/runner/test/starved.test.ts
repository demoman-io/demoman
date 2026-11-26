import { SPAN_QUIET_MS } from "@demoman/replay-engine";
import { describe, expect, it } from "vitest";
import { motionKeptAfter } from "./starved.js";

describe("motionKeptAfter", () => {
  // CI, PR #146 run 45759554243: the Spin click at 3360, its act ended at
  // 3956 on the last kept frame, and the span closed 250 ms later.
  it("an act that ended on its span's last moving frame kept no motion after it", () => {
    expect(SPAN_QUIET_MS).toBe(250);
    expect(
      motionKeptAfter(
        [
          { startMs: 3666, endMs: 4206 },
          { startMs: 4576, endMs: 7576 },
        ],
        3956,
      ),
    ).toBe(false);
  });

  it("an act that ended while the span went on moving did", () => {
    expect(motionKeptAfter([{ startMs: 3666, endMs: 4800 }], 3956)).toBe(true);
  });

  it("a span that ended before the act, or began after it, is not across it", () => {
    expect(motionKeptAfter([{ startMs: 3000, endMs: 3500 }], 3956)).toBe(false);
    expect(motionKeptAfter([{ startMs: 4576, endMs: 7576 }], 3956)).toBe(false);
  });
});

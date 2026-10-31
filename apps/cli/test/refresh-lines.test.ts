import type { RefreshResult } from "@demoman/runner/package";
import { describe, expect, it } from "vitest";
import { refreshLines } from "../src/refresh-lines.js";

type Video = RefreshResult["videos"][number];
const video = (name: string, more: Partial<Video>): Video => ({
  name,
  file: `.demoman/videos/${name}.json`,
  outcome: "replaced",
  detail: "docs/x.mp4: 0.200% of the picture changed",
  outputs: [],
  line: null,
  notes: [],
  ...more,
});

// The CI workflow's only failure signal is this exit code.
describe("refreshLines", () => {
  // A "replaced" that cannot say why reads the same as a false one: CI's
  // 22.04 lane replaced an identical re-film and printed nothing more
  // (2026-10-27).
  it("exits 0 when nothing failed, one line per video saying what the comparison found", () => {
    const near = "docs/x.mp4: at most 0.010% of the picture changed";
    expect(
      refreshLines({
        videos: [
          video("a", {}),
          video("b", { outcome: "unchanged", detail: near }),
        ],
      }),
    ).toEqual({
      lines: [
        "a: replaced: docs/x.mp4: 0.200% of the picture changed",
        `b: unchanged: ${near}`,
      ],
      code: 0,
    });
  });
  it("exits 1 when any video failed, saying why", () => {
    expect(
      refreshLines({
        videos: [
          video("a", {}),
          video("b", {
            outcome: "failed",
            detail: "Stopped after step 1 of 2",
          }),
        ],
      }),
    ).toEqual({
      lines: [
        "a: replaced: docs/x.mp4: 0.200% of the picture changed",
        "b: failed: Stopped after step 1 of 2",
      ],
      code: 1,
    });
  });
  it("prints every caveat a video carries, not only failures", () => {
    const notes = [
      "docs/x.mp4 was replaced without a comparison: the committed file could not be decoded (bad)",
      "docs/x.json was not written: its run report is missing",
    ];
    expect(refreshLines({ videos: [video("a", { notes })] })).toEqual({
      lines: [
        `a: replaced: docs/x.mp4: 0.200% of the picture changed (${notes.join("; ")})`,
      ],
      code: 0,
    });
  });
  it("says when nothing is kept", () => {
    expect(refreshLines({ videos: [] })).toEqual({
      lines: ["No flows are kept in .demoman/videos/."],
      code: 0,
    });
  });
});

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
  it("exits 0 when nothing failed, one line per video", () => {
    expect(
      refreshLines({
        videos: [video("a", {}), video("b", { outcome: "unchanged" })],
      }),
    ).toEqual({ lines: ["a: replaced", "b: unchanged"], code: 0 });
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
      lines: ["a: replaced", "b: failed: Stopped after step 1 of 2"],
      code: 1,
    });
  });
  it("prints every caveat a video carries, not only failures", () => {
    const notes = [
      "docs/x.mp4 was replaced without a comparison: the committed file could not be decoded (bad)",
      "docs/x.json was not written: its run report is missing",
    ];
    expect(refreshLines({ videos: [video("a", { notes })] })).toEqual({
      lines: [`a: replaced (${notes.join("; ")})`],
      code: 0,
    });
  });
  it("says when nothing is kept", () => {
    expect(refreshLines({ videos: [] })).toEqual({
      lines: ["No videos are kept in .demoman/videos/."],
      code: 0,
    });
  });
});

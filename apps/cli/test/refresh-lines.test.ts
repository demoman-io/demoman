import type { RefreshResult } from "@demoman/runner/package";
import { describe, expect, it } from "vitest";
import { appRefusal, refreshLines } from "../src/refresh-lines.js";

type Video = RefreshResult["videos"][number];
const video = (name: string, more: Partial<Video>): Video => ({
  name,
  file: `.demoman/videos/${name}.json`,
  flow: null,
  deliver: "commit",
  video: null,
  filmedCode: null,
  sameAs: null,
  files: [],
  screens: null,
  report: null,
  outcome: "changed",
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
        "a: changed: docs/x.mp4: 0.200% of the picture changed",
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
        "a: changed: docs/x.mp4: 0.200% of the picture changed",
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
        `a: changed: docs/x.mp4: 0.200% of the picture changed (${notes.join("; ")})`,
      ],
      code: 0,
    });
  });
  it("names an added and an uncompared video by their own words", () => {
    const fresh = "nothing to compare against; delivered as new";
    expect(
      refreshLines({
        videos: [
          video("a", { outcome: "added", detail: "docs/x.gif is new" }),
          video("b", { outcome: "uncompared", detail: fresh }),
        ],
      }),
    ).toEqual({
      lines: ["a: added: docs/x.gif is new", `b: uncompared: ${fresh}`],
      code: 0,
    });
  });
  it("says when nothing is kept", () => {
    expect(refreshLines({ videos: [] })).toEqual({
      lines: [
        "No flows in .demoman/flows/. Add one with npx demoman add <flow> --to <path>.",
      ],
      code: 0,
    });
  });

  // Red when refreshLines drops its second argument: a reused local app is
  // then not said.
  it("prints what starting the app said first", () => {
    expect(
      refreshLines({ videos: [video("a", {})] }, ["used the app at http://x"])
        .lines[0],
    ).toBe("used the app at http://x");
    expect(refreshLines({ videos: [video("a", {})] }).lines).toHaveLength(1);
  });

  // Red when appRefusal exits 0 or drops the reason or the detail.
  it("fails with the app refusal's reason and detail", () => {
    expect(
      appRefusal({ reason: "appNeverAnswered", detail: "no answer at :3000" }),
    ).toEqual({ line: "appNeverAnswered: no answer at :3000", code: 1 });
  });

  // Red when appRefusal drops the tail: CI's log then says the install
  // failed without the install's own words.
  it("prints the failing command's output tail indented under the refusal", () => {
    expect(
      appRefusal({
        reason: "appInstallFailed",
        detail: "npm ci exited with code 1",
        tail: "npm ERR! missing lockfile\n\nnpm ERR! see log\n",
      }).line,
    ).toBe(
      "appInstallFailed: npm ci exited with code 1\n  npm ERR! missing lockfile\n  npm ERR! see log",
    );
  });
});

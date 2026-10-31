import { describe, expect, it } from "vitest";
import {
  type RefreshListSource,
  refreshListOf,
  serializeRefreshList,
} from "../../src/refresh-list.js";

const COMMIT = "c".repeat(40);
const base = {
  file: ".demoman/videos/a.json",
  name: "A",
  flow: "f1",
  deliver: "files" as const,
  detail: "",
  files: [],
  report: null,
  video: "t-new",
  filmedCode: { commit: COMMIT, tree: "d".repeat(40), dirty: false },
};

describe("refreshListOf", () => {
  it("an unchanged entry carries sameAs with this run's commit", () => {
    const src: RefreshListSource = {
      videos: [
        { ...base, outcome: "unchanged", sameAs: { video: "t-old" } },
        {
          ...base,
          outcome: "unchanged",
          sameAs: { video: "t-old" },
          filmedCode: { none: "x" },
        },
      ],
    };
    const l = refreshListOf(src);
    expect(l.videos[0]?.sameAs).toEqual({ video: "t-old", commit: COMMIT });
    // `{ none }` has no commit to name: null, never a guess.
    expect(l.videos[1]?.sameAs).toEqual({ video: "t-old", commit: null });
    expect(JSON.parse(serializeRefreshList(l)).refreshVersion).toBe(1);
  });

  it("a failed entry carries its detail and no files", () => {
    const l = refreshListOf({
      videos: [
        {
          ...base,
          outcome: "failed",
          detail: "deliver files needs --out-dir",
          sameAs: null,
          video: null,
          filmedCode: null,
        },
      ],
    });
    expect(l.videos[0]).toMatchObject({
      outcome: "failed",
      detail: "deliver files needs --out-dir",
      files: [],
      sameAs: null,
      kept: ".demoman/videos/a.json",
    });
  });
});

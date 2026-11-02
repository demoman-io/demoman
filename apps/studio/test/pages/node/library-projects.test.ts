// apps/studio/test/pages/node/library-projects.test.ts
//
// The library's project model (spec 2026-11-01-library-projects-design).
import type { VideoSummary } from "@demoman/studio-protocol";
import { describe, expect, it } from "vitest";
import { whereOf } from "../../../pages/src/library/list-model";
import {
  narrow,
  type Place,
  parsePlace,
  placeSearch,
  projectKeyOf,
  projectLabel,
  railOf,
  showsTabs,
  tabCounts,
} from "../../../pages/src/library/projects";
import type {
  LibraryModel,
  LibraryRow,
  VideoGroup,
} from "../../../pages/src/library/state";
import { cardsOf } from "../../../pages/src/library/state";

const KEPT = {
  file: ".demoman/videos/a.json",
  root: "/r",
  deliver: "commit",
} as const;

const take = (sceneId: string, extra: Partial<LibraryRow> = {}): LibraryRow =>
  ({
    sceneId,
    name: "",
    label: sceneId,
    origin: "app.test",
    path: "/",
    createdAt: "2026-10-30T10:00:00.000Z",
    when: "when",
    time: "time",
    hosted: false,
    recoverable: false,
    frameBytes: 0,
    outputBytes: 0,
    state: "Complete",
    canRestore: false,
    authored: true,
    servesReshoot: false,
    needsLook: false,
    ...extra,
  }) as LibraryRow;

/** A flow of one take; `kept` is on the video and on the take's row.
 *  `addedTo` is the mark's key, as the runner answers it, unless given. */
const flow = (
  id: string,
  repo: VideoSummary["repo"],
  kept: VideoSummary["kept"] = null,
  addedTo: string | null = kept != null && "key" in kept ? kept.key : null,
): { row: LibraryRow; group: VideoGroup } => {
  const row = take(`t-${id}`, { kept });
  return {
    row,
    group: {
      video: {
        id,
        name: id,
        repo,
        startPage: "https://app.test/",
        versions: 1,
        current: null,
        pages: [],
        steps: [],
        exports: [],
        kept,
        addedTo,
      },
      current: row,
      versions: [row],
    },
  };
};

const modelOf = (
  flows: { row: LibraryRow; group: VideoGroup }[],
  loose: LibraryRow[] = [],
): LibraryModel =>
  ({
    rows: [...flows.map((f) => f.row), ...loose],
    groups: flows.map((f) => f.group),
  }) as unknown as LibraryModel;

const cards = (
  flows: { row: LibraryRow; group: VideoGroup }[],
  loose: LibraryRow[] = [],
) => cardsOf(modelOf(flows, loose));

describe("projectKeyOf", () => {
  it("a kept key beats the recorded one (the Hacker News case)", () => {
    const [c] = cards([
      flow("hn", { unknown: true }, { ...KEPT, key: "github.com/a/b" }),
    ]);
    expect(c?.group?.video.repo).toEqual({ unknown: true }); // premise
    expect(projectKeyOf(c as never)).toBe("github.com/a/b");
  });
  it("an unkeyed kept mark falls back to the recorded key", () => {
    const [c] = cards([
      flow("a", { key: "github.com/x/y" }, { ...KEPT, key: null }),
    ]);
    expect(c?.group?.video.kept).toMatchObject({ key: null }); // premise
    expect(projectKeyOf(c as never)).toBe("github.com/x/y");
  });
  it("none, unknown and no group answer null", () => {
    const cs = cards(
      [flow("n", { none: "no git" }), flow("u", { unknown: true })],
      [take("loose")],
    );
    expect(cs).toHaveLength(3); // premise
    expect(cs.map(projectKeyOf)).toEqual([null, null, null]);
  });
});

describe("projectLabel", () => {
  it("reads a hosted key as owner/name, on any host", () => {
    expect(projectLabel("github.com/demoman-io/demoman", [])).toEqual({
      owner: "demoman-io",
      name: "demoman",
      local: false,
    });
    expect(projectLabel("gitlab.com/g/sub/proj", [])).toEqual({
      owner: "g/sub",
      name: "proj",
      local: false,
    });
  });
  it("adds the host only when two hosts hold the same owner/repo", () => {
    const keys = ["github.com/acme/web", "gitlab.com/acme/web"];
    expect(keys.map((k) => projectLabel(k, keys).owner)).toEqual([
      "github.com/acme",
      "gitlab.com/acme",
    ]);
    // Same owner, different repo: no clash, no host.
    const other = ["github.com/acme/web", "gitlab.com/acme/api"];
    expect(other.map((k) => projectLabel(k, other).owner)).toEqual([
      "acme",
      "acme",
    ]);
  });
  it("reads a local key as its folder with the local marker", () => {
    expect(projectLabel("local:/Users/x/My Repo/.git", [])).toEqual({
      owner: null,
      name: "My Repo",
      local: true,
    });
  });
  it("two local keys with one folder name add the parent folder", () => {
    const keys = ["local:/Users/x/app/.git", "local:/Users/y/app/.git"];
    expect(keys.map((k) => projectLabel(k, keys))).toEqual([
      { owner: "x", name: "app", local: true },
      { owner: "y", name: "app", local: true },
    ]);
  });
});

describe("railOf", () => {
  const fs = [
    flow("1", { key: "github.com/zed/b" }),
    flow("2", { key: "github.com/zed/a" }),
    flow("3", { key: "github.com/zed/a" }),
    flow("4", { key: "github.com/amy/c" }),
    flow("5", { key: "local:/Users/x/loc/.git" }),
    flow("6", { none: "x" }),
  ];
  it("lists hosted A-Z by owner/name, then local, and counts cards", () => {
    const rail = railOf(cards(fs), 2, "all");
    expect(
      rail.projects.map((p) => [p.owner, p.name, p.local, p.count]),
    ).toEqual([
      ["amy", "c", false, 1],
      ["zed", "a", false, 2],
      ["zed", "b", false, 1],
      [null, "loc", true, 1],
    ]);
    expect([rail.all, rail.none, rail.unreadable]).toEqual([6, 1, 2]);
  });
  it("lists the current project with no cards at count 0", () => {
    const place = { project: "github.com/new/empty" };
    expect(cards(fs).some((c) => projectKeyOf(c) === place.project)).toBe(
      false,
    ); // premise
    const rail = railOf(cards(fs), 0, place);
    const empty = rail.projects.find((p) => p.key === place.project);
    expect(empty).toMatchObject({ name: "empty", count: 0 });
  });
});

describe("parsePlace / placeSearch", () => {
  it("round-trips every place", () => {
    const places: Place[] = [
      "all",
      "none",
      "unreadable",
      { project: "local:/Users/x/My Repo/.git" },
      { project: "github.com/a+b/c" },
    ];
    for (const p of places) expect(parsePlace(placeSearch(p))).toEqual(p);
    expect(placeSearch({ project: "local:/Users/x/My Repo/.git" })).toContain(
      "My%20Repo",
    );
  });
  it("answers null for absent or empty", () => {
    expect(parsePlace("")).toBeNull();
    expect(parsePlace("?project=")).toBeNull();
    expect(parsePlace("?other=1")).toBeNull();
  });
});

describe("narrow, tabCounts, showsTabs", () => {
  const inRepo = flow(
    "in",
    { key: "github.com/a/b" },
    { ...KEPT, key: "github.com/a/b" },
  );
  const gone = flow("gone", { key: "github.com/a/b" }); // deleted checkout: kept null
  const other = flow("other", { key: "github.com/c/d" });
  const noProj = flow("np", { none: "x" });
  const model = modelOf([inRepo, gone, other, noProj], [take("loose")]);
  const place = { project: "github.com/a/b" };
  const ids = (m: LibraryModel) => m.rows.map((r) => r.sceneId);

  it("filters by tab inside a project", () => {
    expect(ids(narrow(model, place, "inRepo"))).toEqual(["t-in"]);
    expect(ids(narrow(model, place, "notInRepo"))).toEqual(["t-gone"]);
    expect(ids(narrow(model, place, "all"))).toEqual(["t-in", "t-gone"]);
    expect(narrow(model, place, "all").groups).toHaveLength(2);
  });
  it("a card with a null mark sits under its recorded project, in Not in repo", () => {
    expect(gone.row.kept).toBeNull(); // premise
    expect(tabCounts(cardsOf(model), place)).toEqual({
      inRepo: 1,
      notInRepo: 1,
      all: 2,
    });
  });
  it("a flow added from a since-deleted worktree sits under the added-to project, in Not in repo", () => {
    // Red: projectKeyOf reads kept.key (null once the root is gone) instead
    // of addedTo, and the flow lands under its recorded project.
    const merged = flow(
      "merged",
      { key: "github.com/c/d" },
      null,
      "github.com/a/b",
    );
    expect(merged.row.kept).toBeNull(); // premise: the root is gone
    expect(merged.group.video.repo).toEqual({ key: "github.com/c/d" }); // premise
    const cs = cardsOf(modelOf([inRepo, merged, other]));
    const card = cs.find((c) => c.group?.video.id === "merged");
    expect(projectKeyOf(card as never)).toBe("github.com/a/b");
    expect(tabCounts(cs, place)).toEqual({ inRepo: 1, notInRepo: 1, all: 2 });
    expect(tabCounts(cs, { project: "github.com/c/d" }).all).toBe(1);
  });
  it("none holds the loose takes; unreadable keeps no rows", () => {
    expect(ids(narrow(model, "none", "all"))).toEqual(["t-np", "loose"]);
    expect(narrow(model, "unreadable", "all").rows).toEqual([]);
  });
  it("shows tabs unless it is unreadable, or none with nothing in a repo", () => {
    const cs = cardsOf(model);
    expect(showsTabs(cs, place)).toBe(true);
    expect(showsTabs(cs, "unreadable")).toBe(false);
    expect(showsTabs(cs, "none")).toBe(false);
    const lost = flow("lost", { unknown: true }, { unknown: "unreadable" });
    const withLost = cardsOf(modelOf([noProj, lost]));
    expect(projectKeyOf(withLost[1] as never)).toBeNull(); // premise
    expect(showsTabs(withLost, "none")).toBe(true);
  });
});

describe("whereOf", () => {
  it("drops the repo part without withRepo", () => {
    const [c] = cards([flow("w", { key: "github.com/a/b" })]);
    expect(whereOf(c as never, true)).toBe("a/b · app.test/");
    expect(whereOf(c as never, false)).toBe("app.test/");
  });
});

// apps/studio/test/pages/node/library-list-model.test.ts
//
// The list view's model (spec 2026-10-31-library-list-view §2.1-2.3, §3).
import type { VideoSummary } from "@demoman/studio-protocol";
import { describe, expect, it } from "vitest";
import {
  firstClickDescending,
  flowSize,
  hostLabel,
  type ListSort,
  listEntries,
  nextSort,
  sortCards,
  whereFor,
  whereOf,
} from "../../../pages/src/library/list-model";
import type {
  LibraryModel,
  LibraryRow,
  VideoGroup,
} from "../../../pages/src/library/state";
import { cardsOf } from "../../../pages/src/library/state";

const NOW = new Date(2026, 9, 30, 12);
const MB = 1024 ** 2;

const take = (
  sceneId: string,
  at: Date,
  extra: Partial<LibraryRow> = {},
): LibraryRow => ({
  sceneId,
  name: "",
  label: sceneId,
  origin: "app.example.com",
  path: "/orders",
  createdAt: at.toISOString(),
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
});

const flow = (
  id: string,
  name: string,
  versions: LibraryRow[], // newest first
  repo: VideoSummary["repo"] = { unknown: true },
): VideoGroup => ({
  video: {
    id,
    name,
    repo,
    startPage: "https://app.example.com/",
    versions: versions.length,
    current: null,
    pages: [],
    steps: [],
    exports: [],
    kept: null,
    addedTo: null,
  } as VideoSummary,
  current: versions[0] ?? null,
  versions: versions.map((v, i) => ({ ...v, version: versions.length - i })),
});

const today = new Date(2026, 9, 30, 9);
const yesterday = new Date(2026, 9, 29, 9);
const lastMonth = new Date(2026, 8, 1, 9);

// Flow A: three videos of 1, 2, 4 MB, today. Flow B: one video, yesterday.
// Flow C: one video with no size, last month. One loose take, today.
const a3 = take("a3", today, { sizeBytes: MB });
const a2 = take("a2", new Date(2026, 9, 30, 8), { sizeBytes: 2 * MB });
const a1 = take("a1", new Date(2026, 9, 30, 7), { sizeBytes: 4 * MB });
const b1 = take("b1", yesterday, { sizeBytes: 3 * MB });
const c1 = take("c1", lastMonth);
const loose = take("loose", new Date(2026, 9, 30, 6), { sizeBytes: 9 * MB });
const groups = [
  flow("A", "Flow 10", [a3, a2, a1], { key: "github.com/acme/web" }),
  flow("B", "Flow 2", [b1]),
  flow("C", "", [c1]),
];
const model: LibraryModel = {
  usedBytes: 0,
  budgetBytes: 0,
  fraction: 1,
  chromeNearLimit: false,
  migrating: false,
  migrationFailed: false,
  notice: null,
  rows: [a3, a2, a1, loose, b1, c1].sort((x, y) =>
    y.createdAt.localeCompare(x.createdAt),
  ),
  groups,
};
const RECENT: ListSort = { column: "recorded", descending: true };
const cards = cardsOf(model);
const cardOf = (id: string) =>
  cards.find((c) => c.group?.video.id === id) as (typeof cards)[number];

describe("the fixture", () => {
  it("has the shape the cases below rely on", () => {
    expect(cards.filter((c) => c.group === null)).toHaveLength(1);
    expect(cards).toHaveLength(4);
    expect(c1.sizeBytes).toBeUndefined();
    expect(groups[0]?.versions).toHaveLength(3);
    expect(
      groups.filter((g) => g.versions.every((v) => v.sizeBytes === undefined)),
    ).toHaveLength(1);
  });
});

describe("listEntries", () => {
  it("under Recorded newest-first gives headings, then flows at level 2, then every video at level 3", () => {
    const seq = listEntries(model, RECENT, NOW).map(
      (e) => `${e.kind}:${e.key}:${e.level}`,
    );
    expect(seq).toEqual([
      "heading:h:today:1",
      "flow:f:A:2",
      "video:v:a3:3",
      "video:v:a2:3",
      "video:v:a1:3",
      "flow:t:loose:2",
      "heading:h:yesterday:1",
      "flow:f:B:2",
      "video:v:b1:3",
      "heading:h:month:2026-09:1",
      "flow:f:C:2",
      "video:v:c1:3",
    ]);
  });

  it("under any other sort has no headings and flows at level 1", () => {
    const entries = listEntries(
      model,
      { column: "name", descending: false },
      NOW,
    );
    expect(entries.some((e) => e.kind === "heading")).toBe(false);
    const flows = entries.filter((e) => e.kind === "flow");
    expect(flows.length).toBe(4);
    expect(flows.every((e) => e.level === 1 && e.parent === null)).toBe(true);
    expect(
      entries.filter((e) => e.kind === "video").every((e) => e.level === 2),
    ).toBe(true);
  });

  it("recorded oldest-first is flat too, and says no day", () => {
    const entries = listEntries(
      model,
      { column: "recorded", descending: false },
      NOW,
    );
    expect(entries.some((e) => e.kind === "heading")).toBe(false);
    expect(entries.filter((e) => e.kind === "flow").map((e) => e.key)).toEqual([
      "f:C",
      "f:B",
      "t:loose",
      "f:A",
    ]);
  });

  it("carries the heading's namesDay to its flows", () => {
    const flows = listEntries(model, RECENT, NOW).filter(
      (e) => e.kind === "flow",
    );
    expect(flows.map((e) => e.kind === "flow" && e.namesDay)).toEqual([
      true,
      true,
      true,
      false,
    ]);
  });
});

describe("sortCards", () => {
  const ids = (s: ListSort) =>
    sortCards(cards, s).map((c) => c.group?.video.id ?? c.row.sceneId);

  it("by size puts unknown sizes last in both directions", () => {
    expect(ids({ column: "size", descending: true })).toEqual([
      "loose",
      "A",
      "B",
      "C",
    ]);
    expect(ids({ column: "size", descending: false })).toEqual([
      "B",
      "A",
      "loose",
      "C",
    ]);
  });

  it("by name compares numerically and uses the label for an untitled flow", () => {
    expect(cardOf("C").row.label).toBe("c1");
    // "c1" < "Flow 2" < "Flow 10" < "loose"
    expect(ids({ column: "name", descending: false })).toEqual([
      "C",
      "B",
      "A",
      "loose",
    ]);
  });

  it("ties break by Recorded newest first", () => {
    // Every card here is "app.example.com/orders" except A (repo-led).
    // Fed oldest first, so only the tie-break can put them newest first.
    const same = sortCards(
      cards.filter((c) => c.group?.video.id !== "A").reverse(),
      { column: "where", descending: false },
    ).map((c) => c.group?.video.id ?? c.row.sceneId);
    expect(same).toEqual(["loose", "B", "C"]);
    expect(whereOf(cardOf("B"), true, "whole")).toBe(
      whereOf(cardOf("C"), true, "whole"),
    );
  });
});

describe("sorting rules", () => {
  it("firstClickDescending is false only for name and where", () => {
    expect(
      (["name", "where", "videos", "recorded", "size"] as const).map(
        firstClickDescending,
      ),
    ).toEqual([false, false, true, true, true]);
  });

  it("nextSort on the sorted column reverses it, on another column takes that column's first direction", () => {
    expect(nextSort({ column: "name", descending: false }, "name")).toEqual({
      column: "name",
      descending: true,
    });
    expect(nextSort({ column: "name", descending: true }, "name")).toEqual({
      column: "name",
      descending: false,
    });
    expect(nextSort({ column: "name", descending: false }, "size")).toEqual({
      column: "size",
      descending: true,
    });
    expect(nextSort({ column: "size", descending: true }, "where")).toEqual({
      column: "where",
      descending: false,
    });
  });
});

describe("whereOf", () => {
  it("leads with the repo when known, and not otherwise", () => {
    expect(whereOf(cardOf("A"), true, "whole")).toBe(
      "acme/web · app.example.com/orders",
    );
    expect(whereOf(cardOf("B"), true, "whole")).toBe("app.example.com/orders");
  });
});

// Where names the route (2026-11-02): `localhost:8123` told no flow from
// another. The host shows only where it does.
describe("whereFor", () => {
  const ACME = { key: "github.com/acme/web" };
  const API = { key: "github.com/acme/api" };
  const at = (id: string, url: string, repo: VideoSummary["repo"]) => {
    const u = new URL(url);
    return flow(
      id,
      id,
      [
        take(id, today, {
          origin: u.host,
          path: u.pathname === "/" ? "" : u.pathname,
        }),
      ],
      repo,
    );
  };
  const cardsFrom = (gs: VideoGroup[]) =>
    cardsOf({
      ...model,
      rows: gs.flatMap((g) => g.versions),
      groups: gs,
    });
  const textOf = (
    gs: VideoGroup[],
    withRepo: boolean,
  ): Record<string, string> => {
    const cs = cardsFrom(gs);
    const where = whereFor(cs, withRepo);
    return Object.fromEntries(
      cs.map((c) => [c.group?.video.id, where(c).text]),
    );
  };

  it("names the route alone in a project on one host, the home page as /", () => {
    const gs = [
      at("pay", "http://localhost:8123/checkout", ACME),
      at("home", "http://localhost:8123/", ACME),
    ];
    expect(textOf(gs, false)).toEqual({ pay: "/checkout", home: "/" });
    expect(textOf(gs, true)).toEqual({
      pay: "acme/web · /checkout",
      home: "acme/web · /",
    });
  });

  it("names the host in a project on more than one, a loopback one by its port", () => {
    const gs = [
      at("app", "http://localhost:3000/settings", ACME),
      at("admin", "http://localhost:3001/settings", ACME),
      at("prod", "https://app.acme.com/checkout", ACME),
      // Another project's one host does not count toward acme/web's.
      at("api", "http://localhost:4000/docs", API),
    ];
    expect(textOf(gs, true)).toEqual({
      app: "acme/web · :3000/settings",
      admin: "acme/web · :3001/settings",
      prod: "acme/web · app.acme.com/checkout",
      api: "acme/api · /docs",
    });
  });

  it("names the host under No project, where the site is what tells flows apart", () => {
    const gs = [
      at("wiki", "https://en.wikipedia.org/wiki/Cat", { none: "no repo" }),
      at("lost", "http://localhost:8123/x", { unknown: true }),
    ];
    expect(textOf(gs, true)).toEqual({
      wiki: "no repo · en.wikipedia.org/wiki/Cat",
      lost: ":8123/x",
    });
  });

  it("titles every card with its whole host", () => {
    const [c] = cardsFrom([at("pay", "http://localhost:8123/checkout", ACME)]);
    expect(whereFor([c as never], false)(c as never)).toEqual({
      text: "/checkout",
      title: "localhost:8123/checkout",
    });
  });

  it("hostLabel shortens a loopback host with a port, and only that", () => {
    expect(
      [
        "localhost:3001",
        "127.0.0.1:5173",
        "[::1]:8080",
        "localhost",
        "app.acme.com:8443",
        "localhost.example.com:80",
      ].map(hostLabel),
    ).toEqual([
      ":3001",
      ":5173",
      ":8080",
      "localhost",
      "app.acme.com:8443",
      "localhost.example.com:80",
    ]);
  });

  it("sorts by project, then route, then host", () => {
    const cs = cardsFrom([
      at("prod", "https://app.acme.com/checkout", ACME),
      at("bill", "http://localhost:3000/billing", ACME),
      at("pay", "http://localhost:3000/checkout", ACME),
      at("docs", "http://localhost:4000/a", API),
    ]);
    expect(
      sortCards(cs, { column: "where", descending: false }).map(
        (c) => c.group?.video.id,
      ),
    ).toEqual(["docs", "bill", "prod", "pay"]);
  });
});

describe("flowSize", () => {
  it("sums every video", () => {
    expect(flowSize(cardOf("A"))).toEqual({
      kind: "known",
      bytes: 7 * MB,
      unmeasured: 0,
    });
  });
  it("with one unmeasured video is the known sum and unmeasured 1", () => {
    const g = flow("X", "X", [a3, take("x2", yesterday)]);
    expect(flowSize({ row: a3, group: g })).toEqual({
      kind: "known",
      bytes: MB,
      unmeasured: 1,
    });
  });
  it("with none measured is unknown", () => {
    expect(flowSize(cardOf("C"))).toEqual({ kind: "unknown" });
  });
});

// apps/studio/test/pages/node/library-search.test.ts
//
// The library's search model: the agent's matcher on a card's text.
import { phraseHits } from "@demoman/run-core";
import type { VideoSummary } from "@demoman/studio-protocol";
import { describe, expect, it } from "vitest";
import {
  cardHits,
  elsewhere,
  searching,
  searchModel,
  typingOf,
  whyOf,
} from "../../../pages/src/library/search";
import type {
  LibraryModel,
  LibraryRow,
  VideoGroup,
} from "../../../pages/src/library/state";
import { cardsOf } from "../../../pages/src/library/state";

const take = (sceneId: string, label: string): LibraryRow =>
  ({
    sceneId,
    name: "",
    label,
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
  }) as LibraryRow;

const flow = (
  id: string,
  name: string,
  pages: string[],
  steps: string[],
  addedTo: string | null,
): VideoGroup => {
  const row = { ...take(`${id}1`, name), version: 1 };
  return {
    video: {
      id,
      name,
      repo: { unknown: true },
      startPage: pages[0] ?? "",
      versions: 1,
      current: null,
      pages,
      steps,
      exports: [],
      kept: null,
      addedTo,
    } as VideoSummary,
    current: row,
    versions: [row],
  };
};

const invite = flow(
  "I",
  "Invite a teammate",
  ["https://app.test/team"],
  [],
  "github.com/acme/web",
);
const onboarding = flow(
  "O",
  "Team onboarding",
  ["https://app.test/"],
  ["click Invite member"],
  "github.com/acme/web",
);
const billing = flow(
  "B",
  "Update billing",
  ["https://app.test/settings/billing"],
  [],
  "github.com/acme/api",
);
const draft = take("draft", "Invite draft");
const groups = [invite, onboarding, billing];
const model: LibraryModel = {
  usedBytes: 0,
  budgetBytes: 0,
  fraction: 1,
  chromeNearLimit: false,
  migrating: false,
  migrationFailed: false,
  notice: null,
  rows: [...groups.flatMap((g) => g.versions), draft],
  groups,
} as LibraryModel;
const cards = cardsOf(model);
const cardOf = (name: string) =>
  cards.find(
    (c) => (c.group?.video.name ?? c.row.label) === name,
  ) as (typeof cards)[number];
const names = (m: LibraryModel) =>
  cardsOf(m).map((c) => c.group?.video.name ?? c.row.label);

describe("the fixture", () => {
  it("is three flows and one loose take, with the text the cases search", () => {
    expect(cards).toHaveLength(4);
    expect(cards.filter((c) => c.group === null)).toHaveLength(1);
    expect(onboarding.video.steps).toEqual(["click Invite member"]);
    expect(billing.video.pages).toEqual(["https://app.test/settings/billing"]);
    expect(names(model).sort()).toEqual(
      [
        "Invite a teammate",
        "Team onboarding",
        "Update billing",
        "Invite draft",
      ].sort(),
    );
  });
});

describe("the query's mode", () => {
  it("types unless it ends in whitespace", () => {
    expect(typingOf("inv")).toBe(true);
    expect(typingOf("inv ")).toBe(false);
  });
  it("a stop word is a search only while it is being typed", () => {
    expect(searching("the")).toBe(true);
    expect(searching("the ")).toBe(false);
    expect(searching("")).toBe(false);
  });
});

describe("cardHits", () => {
  it("equals the agent's phraseHits on the flow's own text", () => {
    for (const g of groups) {
      const flowText = {
        name: g.video.name,
        pages: g.video.pages,
        steps: g.video.steps,
      };
      expect(cardHits(cardOf(g.video.name), "invite ")).toBe(
        phraseHits("invite ", flowText),
      );
    }
    // The case would pass at all-zero; one card must hold the word only in a step.
    expect(cardHits(cardOf("Team onboarding"), "invite ")).toBeGreaterThan(0);
  });
});

describe("searchModel", () => {
  it("keeps what matches, by name, step or label", () => {
    expect(names(searchModel(model, "inv")).sort()).toEqual(
      ["Invite a teammate", "Team onboarding", "Invite draft"].sort(),
    );
    expect(names(searchModel(model, "billing"))).toEqual(["Update billing"]);
  });
  it("returns every card for a stop word with a space, or nothing", () => {
    expect(searchModel(model, "the ")).toBe(model);
    expect(searchModel(model, "")).toBe(model);
    expect(cards).toHaveLength(4);
  });
});

describe("whyOf", () => {
  it("names the step, or the page, but not a name match", () => {
    expect(whyOf(cardOf("Team onboarding"), "invite")).toBe(
      "step: click Invite member",
    );
    expect(whyOf(cardOf("Invite a teammate"), "invite")).toBeNull();
    expect(whyOf(cardOf("Update billing"), "settings")).toBe(
      "page: /settings/billing",
    );
    expect(whyOf(cardOf("Team onboarding"), "")).toBeNull();
  });
});

describe("elsewhere", () => {
  const web = { project: "github.com/acme/web" };
  it("counts the other places' matches, No project last, never here", () => {
    expect(elsewhere(cards, web, "all", "inv")).toEqual([
      { place: "none", count: 1 },
    ]);
    expect(elsewhere(cards, "none", "all", "inv")).toEqual([
      { place: web, count: 2 },
    ]);
    expect(elsewhere(cards, web, "all", "billing")).toEqual([
      { place: { project: "github.com/acme/api" }, count: 1 },
    ]);
  });
  it("is empty under All, and for a query with no word", () => {
    expect(elsewhere(cards, "all", "all", "inv")).toEqual([]);
    expect(elsewhere(cards, web, "all", "")).toEqual([]);
  });
});

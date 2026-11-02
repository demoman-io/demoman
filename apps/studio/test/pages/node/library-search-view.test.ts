// apps/studio/test/pages/node/library-search-view.test.ts
//
// The library's search box, its address and its results (spec 2026-11-02
// library-search-design). The real entrypoint over the memory platform.
import type { SceneDocument } from "@demoman/scene-schema";
import {
  DEFAULT_LIBRARY_VIEW,
  type LibraryViewChoice,
  type VideoSummary,
} from "@demoman/studio-protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cardText } from "../../../pages/src/library/search";
import { buildLibraryModel, cardsOf } from "../../../pages/src/library/state";
import { deleteFlows } from "../../../pages/src/shell/confirm-dialog";
import {
  createMemoryPlatform,
  type MemoryPlatform,
  type MemorySeed,
} from "../helpers/memory-platform";

const state = vi.hoisted(() => ({ memory: null as MemoryPlatform | null }));
vi.mock("#platform", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  createPlatform: () => state.memory,
}));
const confirmDialog = vi.hoisted(() => ({
  ask: vi.fn<(question: unknown) => Promise<boolean>>(),
}));
vi.mock("../../../pages/src/shell/confirm-dialog", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  askToConfirm: (question: unknown) => confirmDialog.ask(question),
}));

const WEB = "github.com/acme/web";
const API = "github.com/acme/api";
const AT_WEB = `?project=${encodeURIComponent(WEB)}`;
const AT_API = `?project=${encodeURIComponent(API)}`;

const take = (id: string, day: number, name = `Take ${id}`): SceneDocument =>
  ({
    meta: {
      id,
      name,
      createdAt: `2026-10-${String(day).padStart(2, "0")}T10:00:00Z`,
      capture: { originUrl: "https://app.test/orders" },
    },
  }) as unknown as SceneDocument;

const video = (
  id: string,
  name: string,
  key: string,
  pages: string[],
  steps: string[],
): VideoSummary => ({
  id,
  name,
  repo: { key },
  startPage: pages[0] ?? "https://app.test/",
  versions: 1,
  current: {
    version: 1,
    takeId: `t-${id}`,
    recordedAt: "2026-10-01T00:00:00Z",
    expired: false,
  },
  pages,
  steps,
  exports: [],
  kept: null,
  addedTo: null,
});

// Three flows in acme/web whose names and steps differ, one in acme/api, and
// a take in no flow; `day` is the take's date, newest first in the list.
const FLOWS: [VideoSummary, number][] = [
  [
    video(
      "invite",
      "Invite a teammate",
      WEB,
      ["https://app.test/team"],
      ["click Send invite"],
    ),
    25,
  ],
  [
    video(
      "billing",
      "Update billing",
      WEB,
      ["https://app.test/settings/billing"],
      ["click Save"],
    ),
    24,
  ],
  [
    video(
      "onboard",
      "Team onboarding",
      WEB,
      ["https://app.test/"],
      ["type Ada", "click Invite member"],
    ),
    22,
  ],
  [
    video(
      "token",
      "Rotate API token",
      API,
      ["https://app.test/keys"],
      ["click Rotate"],
    ),
    21,
  ],
];
const seed = (libraryView?: LibraryViewChoice): MemorySeed => ({
  scenes: [
    ...FLOWS.map(([v, day]) => take(`t-${v.id}`, day)),
    take("loose", 10, "Token notes"),
  ],
  videos: FLOWS.map(([v]) => v),
  videoOf: Object.fromEntries(
    FLOWS.map(([v]) => [
      `t-${v.id}`,
      {
        videoId: v.id,
        version: 1,
        expired: false,
        exports: [],
        filmedCode: null,
      },
    ]),
  ),
  ...(libraryView === undefined ? {} : { libraryView }),
});

const $ = (s: string) => document.querySelector<HTMLElement>(s);
const $$ = (s: string) => [...document.querySelectorAll<HTMLElement>(s)];
const box = () => $("[data-search]") as HTMLInputElement;
const railItem = (search: string) =>
  $(`[data-rail] [data-place="${CSS.escape(search)}"]`);
const flowsDrawn = () =>
  $$("[data-list] [data-scene]:not([data-video-row])").map(
    (r) => r.dataset.scene,
  );
const rowOf = (scene: string) =>
  $(`[data-list] [data-scene="${scene}"]:not([data-video-row])`);
const writes = () =>
  state.memory?.calls.filter(
    (c) => c.member === "libraryView" && c.method === "write",
  ) ?? [];
const sortedBy = () =>
  $$("[data-list-head] [aria-sort]").map(
    (h) => `${h.dataset.col} ${h.getAttribute("aria-sort")}`,
  );

/** What a person typing does: the field's value, then its `input`. */
function type(text: string): void {
  const input = box();
  input.value = text;
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

async function boot(url = "/", libraryView?: LibraryViewChoice) {
  window.history.replaceState({}, "", url);
  state.memory = createMemoryPlatform(seed(libraryView));
  await import("../../../pages/entrypoints/library/main");
  await vi.waitFor(() => {
    if ($("[data-rail] [data-place]") === null) throw new Error("no rail yet");
  });
}

describe("library main — search", () => {
  beforeEach(() => {
    vi.resetModules();
    confirmDialog.ask.mockReset().mockResolvedValue(true);
    document.body.innerHTML = `
      <div id="notice" class="hidden" role="alert"></div>
      <main id="root"></main>
    `;
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
    window.history.replaceState({}, "", "/");
  });

  it("the fixture's names and steps differ where the cases need them to", () => {
    const s = seed();
    const model = buildLibraryModel({
      videos: s.videos,
      videoOf: s.videoOf,
      scenes: s.scenes ?? [],
      migrating: false,
      migrationFailed: false,
      notice: null,
      needsLook: new Set(),
    } as never);
    const texts = cardsOf(model).map(cardText);
    const of = (name: string) => texts.find((t) => t.name === name);
    // "Team onboarding" holds "invite" only in a step; the take in no flow
    // is its label, "Token notes".
    expect(of("Team onboarding")?.steps).toContain("click Invite member");
    expect(of("Invite a teammate")).toBeDefined();
    expect(of("Rotate API token")).toBeDefined();
    expect(of("Token notes")).toEqual({
      name: "Token notes",
      pages: [],
      steps: [],
    });
  });

  it("draws the box in the tab row, between the tabs and the toggle", async () => {
    await boot(`/${AT_WEB}`);
    const row = $("[data-tabs-row]") as HTMLElement;
    const field = row.querySelector("label.search-field") as HTMLElement;
    expect(field).not.toBeNull();
    expect([...row.children].map((c) => c.className.split(" ")[0])).toEqual([
      "place-tabs",
      "search-field",
      "layout-toggle",
    ]);
    const input = field.querySelector("input") as HTMLInputElement;
    expect(input).toBe(box());
    expect(input.type).toBe("search");
    expect(input.getAttribute("aria-label")).toBe("Search flows");
    expect(input.placeholder).toBe("Search");
    expect(field.querySelector("kbd")?.textContent).toBe("/");
    expect(field.querySelector("svg[data-icon='search']")).not.toBeNull();
    expect(field.hidden).toBe(false);
  });

  it("typing narrows to the flows that match, names the step, and writes q into the address", async () => {
    await boot(`/${AT_WEB}`);
    // Premise: every flow of acme/web is drawn before a word is typed.
    expect(flowsDrawn()).toEqual(["t-invite", "t-billing", "t-onboard"]);
    const entries = history.length;
    type("inv");
    expect(flowsDrawn().sort()).toEqual(["t-invite", "t-onboard"]);
    expect(location.search).toBe(`${AT_WEB}&q=inv`);
    // Replaced, not pushed: Back leaves the search as a whole.
    expect(history.length).toBe(entries);
    expect(
      rowOf("t-onboard")?.querySelector("[data-match-why]")?.textContent,
    ).toBe("step: click Invite member");
    // A flow matched by its name says nothing more.
    expect(rowOf("t-invite")?.querySelector("[data-match-why]")).toBeNull();
    // Each tab says what it would show.
    expect($('[data-tab="all"] .side-count')?.textContent).toBe("2");
    // Emptied, the address drops q.
    type("");
    expect(location.search).toBe(AT_WEB);
    expect(flowsDrawn()).toHaveLength(3);
  });

  it("orders by matches, most first, with no date headings", async () => {
    await boot(`/${AT_WEB}`);
    // Premise: unsearched, the newer flow leads, under a date heading.
    expect(flowsDrawn().indexOf("t-invite")).toBeLessThan(
      flowsDrawn().indexOf("t-onboard"),
    );
    expect($$("[data-list] [data-heading]").length).toBeGreaterThan(0);
    // "invite" and "member" both in onboarding's step; invite has one.
    type("invite member");
    expect(flowsDrawn()).toEqual(["t-onboard", "t-invite"]);
    expect($$("[data-list] [data-heading]")).toHaveLength(0);
    expect(sortedBy()).toEqual([]);
  });

  it("a heading click sorts this search only; clearing the box restores the saved sort", async () => {
    await boot(`/${AT_WEB}`);
    type("invite member");
    expect(flowsDrawn()).toEqual(["t-onboard", "t-invite"]); // premise
    $('[data-list-head] [data-sort="name"]')?.click();
    expect(flowsDrawn()).toEqual(["t-invite", "t-onboard"]);
    expect(sortedBy()).toEqual(["name ascending"]);
    expect(writes()).toHaveLength(0);
    // Again: the search's own sort turns, still unsaved.
    $('[data-list-head] [data-sort="name"]')?.click();
    expect(flowsDrawn()).toEqual(["t-onboard", "t-invite"]);
    expect(sortedBy()).toEqual(["name descending"]);
    expect(writes()).toHaveLength(0);
    type("");
    expect(sortedBy()).toEqual(["recorded descending"]);
    expect($$("[data-list] [data-heading]").length).toBeGreaterThan(0);
    expect(flowsDrawn()).toEqual(["t-invite", "t-billing", "t-onboard"]);
    // A heading click with nothing searched saves, as before.
    $('[data-list-head] [data-sort="name"]')?.click();
    expect(writes()).toHaveLength(1);
  });

  it("a layout change during a search saves the layout, and the grid draws one run in the same order", async () => {
    await boot(`/${AT_WEB}`);
    type("invite member");
    $('[data-layout="grid"]')?.click();
    expect(writes().map((c) => c.args[0])).toEqual([
      { ...DEFAULT_LIBRARY_VIEW, layout: "grid" },
    ]);
    expect($$("article[data-video]").map((a) => a.dataset.video)).toEqual([
      "onboard",
      "invite",
    ]);
    expect($$("[data-section]")).toHaveLength(0);
    // On a card the why takes Where's place on the meta line.
    const meta = $('article[data-video="onboard"] [data-meta]');
    expect(meta?.querySelector("[data-match-why]")?.textContent).toBe(
      "step: click Invite member",
    );
    expect(meta?.textContent).not.toContain("app.test");
    // Premise for that: a card matched by name still says where.
    expect($('article[data-video="invite"] [data-meta]')?.textContent).toMatch(
      /\//,
    );
    type("");
    expect($$("[data-section]").length).toBeGreaterThan(0);
  });

  it("a Shift-click in the grid's results ranges over the run", async () => {
    await boot(`/${AT_WEB}`, { ...DEFAULT_LIBRARY_VIEW, layout: "grid" });
    // Every flow here has a "click" step: three results, billing between.
    type("click");
    expect($$("article[data-video]").map((a) => a.dataset.video)).toEqual([
      "invite",
      "billing",
      "onboard",
    ]);
    $('[data-select="invite"]')?.click();
    $('[data-select="onboard"]')?.dispatchEvent(
      new MouseEvent("click", { bubbles: true, shiftKey: true }),
    );
    expect(
      $$("[data-select]")
        .filter((b) => (b as HTMLInputElement).checked)
        .map((b) => b.dataset.select),
    ).toEqual(["invite", "billing", "onboard"]);
  });

  it("puts an encoded q from the address in the box", async () => {
    await boot(`/${AT_WEB}&q=a%26b%20%23c%20caf%C3%A9`);
    expect(box().value).toBe("a&b #c café");
  });

  it("a stop word with a space after it shows every flow", async () => {
    await boot(`/${AT_WEB}`);
    type("the ");
    expect(box().value).toBe("the ");
    expect(flowsDrawn()).toHaveLength(3);
    expect($("[data-none-here]")).toBeNull();
  });

  it("a rail click keeps the query in the address and the box", async () => {
    await boot(`/${AT_WEB}`);
    type("token");
    railItem(AT_API)?.click();
    expect(location.search).toBe(`${AT_API}&q=token`);
    expect(box().value).toBe("token");
    expect(flowsDrawn()).toEqual(["t-token"]);
  });

  it("None here names the places that do match, and each goes there", async () => {
    await boot(`/${AT_WEB}`);
    type("token");
    expect(flowsDrawn()).toEqual([]);
    const none = $("[data-none-here]") as HTMLElement;
    expect(none.textContent).toBe("None here. 1 in acme/api, 1 in No project.");
    // Not the empty library's card.
    expect($("[data-empty]")).toBeNull();
    const links = [
      ...none.querySelectorAll<HTMLAnchorElement>("a[data-place]"),
    ];
    expect(links.map((a) => a.textContent)).toEqual([
      "1 in acme/api",
      "1 in No project",
    ]);
    links[0]?.click();
    expect(location.search).toBe(`${AT_API}&q=token`);
    expect(flowsDrawn()).toEqual(["t-token"]);
    expect(box().value).toBe("token");
  });

  it("a search that hides a ticked flow drops it: Delete names only what shows", async () => {
    await boot(`/${AT_WEB}`);
    $('[data-select="invite"]')?.click();
    $('[data-select="billing"]')?.click();
    // Premise: both ticks took.
    expect($("[data-selection-bar]")?.textContent).toContain("2");
    type("inv");
    expect(flowsDrawn()).not.toContain("t-billing"); // premise: it hid
    ($('[data-action="delete-selected"]') as HTMLButtonElement).click();
    await vi.waitFor(() => {
      if (confirmDialog.ask.mock.calls.length === 0) throw new Error("not yet");
    });
    expect(confirmDialog.ask).toHaveBeenCalledWith(deleteFlows(1, 1));
  });

  it("Esc in the box clears it", async () => {
    await boot(`/${AT_WEB}&q=inv`);
    expect(flowsDrawn()).toHaveLength(2); // premise
    box().dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );
    expect(box().value).toBe("");
    expect(location.search).toBe(AT_WEB);
    expect(flowsDrawn()).toHaveLength(3);
  });

  it("Back after a rail click restores the earlier query", async () => {
    await boot(`/${AT_WEB}`);
    type("inv");
    railItem(AT_API)?.click();
    type("token");
    expect(location.search).toBe(`${AT_API}&q=token`); // premise
    history.back();
    await vi.waitFor(() => {
      if (box().value !== "inv") throw new Error("not back yet");
    });
    expect(location.search).toBe(`${AT_WEB}&q=inv`);
    expect(flowsDrawn().sort()).toEqual(["t-invite", "t-onboard"]);
  });

  it("Couldn't read has no box", async () => {
    await boot("/?project=unreadable&q=inv");
    expect($("label.search-field")?.hidden).toBe(true);
    expect($("[data-none-here]")).toBeNull();
  });
});

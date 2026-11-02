// apps/studio/test/pages/node/library-projects-view.test.ts
//
// The library's rail, title band and tab row (spec 2026-11-01
// library-projects-design, "The page", "Where the Studio lands", "Failure
// paths"). The real entrypoint over the memory platform.
import type { SceneDocument } from "@demoman/scene-schema";
import {
  DEFAULT_LIBRARY_VIEW,
  type LibraryViewChoice,
  type VideoSummary,
} from "@demoman/studio-protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { railOf } from "../../../pages/src/library/projects";
import { buildLibraryModel, cardsOf } from "../../../pages/src/library/state";
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

const WEB = "github.com/acme/web";
const APP = "github.com/zeta/app";
const SCRATCH = "local:/Users/me/scratch";

const take = (id: string, day: number): SceneDocument =>
  ({
    meta: {
      id,
      name: `Take ${id}`,
      createdAt: `2026-10-${String(day).padStart(2, "0")}T10:00:00Z`,
      capture: { originUrl: "https://app.test/orders" },
    },
  }) as unknown as SceneDocument;

const video = (
  id: string,
  repo: VideoSummary["repo"],
  kept: VideoSummary["kept"] = null,
): VideoSummary => ({
  id,
  name: `Flow ${id}`,
  repo,
  startPage: "https://app.test/",
  versions: 1,
  current: {
    version: 1,
    takeId: `t-${id}`,
    recordedAt: "2026-10-01T00:00:00Z",
    expired: false,
  },
  pages: [],
  steps: [],
  exports: [],
  kept,
  addedTo: kept != null && "key" in kept ? kept.key : null,
});

// The mockup's spread: two owners (acme with a kept and a plain flow, zeta),
// a Local repo, a flow in no repo, a take in no flow, one unreadable folder.
const VIDEOS = [
  video(
    "kept",
    { key: WEB },
    {
      file: ".demoman/videos/kept.json",
      root: "/r",
      deliver: "commit",
      key: WEB,
    },
  ),
  video("plain", { key: WEB }),
  video("app", { key: APP }),
  video("scratch", { key: SCRATCH }),
  video("outside", { none: "not a git repository" }),
];
const seed = (libraryView?: LibraryViewChoice): MemorySeed => ({
  scenes: [
    ...VIDEOS.map((v, i) => take(`t-${v.id}`, 20 + i)),
    take("loose", 10),
  ],
  videos: VIDEOS,
  videoOf: Object.fromEntries(
    VIDEOS.map((v) => [
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
  unreadable: [{ folder: "broken", reason: "not JSON", kind: "take" }],
  ...(libraryView === undefined ? {} : { libraryView }),
});

const pick = (project: string | null): LibraryViewChoice => ({
  ...DEFAULT_LIBRARY_VIEW,
  sort: { ...DEFAULT_LIBRARY_VIEW.sort },
  project,
});

const $ = (s: string) => document.querySelector<HTMLElement>(s);
const $$ = (s: string) => [...document.querySelectorAll<HTMLElement>(s)];
const railItem = (search: string) =>
  $(`[data-rail] [data-place="${CSS.escape(search)}"]`);
const current = () =>
  $$('[data-rail] [aria-current="true"]').map((a) => a.dataset.place);
const title = () => $("[data-place-title]")?.textContent;
const tab = (t: string) => $(`[data-tabs-row] [data-tab="${t}"]`);
const flowsDrawn = () =>
  $$("[data-list] [data-scene]:not([data-video-row])").map(
    (r) => r.dataset.scene,
  );
/** The tabs shown: a hidden group keeps its buttons. */
const tabsShown = () =>
  $$("[data-tabs-row] [data-tab]").filter(
    (b) => b.closest("[hidden]") === null,
  );
const calls = (member: string, method: string) =>
  state.memory?.calls.filter(
    (c) => c.member === member && c.method === method,
  ) ?? [];

async function boot(url = "/", libraryView?: LibraryViewChoice) {
  window.history.replaceState({}, "", url);
  state.memory = createMemoryPlatform(seed(libraryView));
  await import("../../../pages/entrypoints/library/main");
  await vi.waitFor(() => {
    if ($("[data-rail] [data-place]") === null) throw new Error("no rail yet");
  });
}

describe("library main — the project rail, title band and tab row", () => {
  beforeEach(() => {
    vi.resetModules();
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

  it("the fixture holds the mockup's spread", () => {
    const s = seed();
    const model = buildLibraryModel({
      videos: s.videos,
      videoOf: s.videoOf,
      scenes: s.scenes ?? [],
      unreadable: s.unreadable,
      migrating: false,
      migrationFailed: false,
      notice: null,
      needsLook: new Set(),
    } as never);
    const rail = railOf(cardsOf(model), (s.unreadable ?? []).length, "all");
    expect(rail.owners.map((o) => o.owner)).toEqual(["acme", "zeta", "Local"]);
    // The flow outside a repo and the take in no flow.
    expect(rail.none).toBe(2);
    expect(rail.unreadable).toBe(1);
  });

  it("the rail lists All flows, each owner's projects, No project, then Couldn't read", async () => {
    await boot();
    const labels = $$("[data-rail] .side-owner, [data-rail] .side-label").map(
      (e) => e.textContent,
    );
    expect(labels).toEqual([
      "All flows",
      "acme",
      "web",
      "zeta",
      "app",
      "Local",
      "scratch",
      "No project",
      "Couldn't read",
    ]);
    const count = (search: string) =>
      railItem(search)?.querySelector(".side-count")?.textContent;
    expect(count("?project=all")).toBe("6");
    expect(count(`?project=${encodeURIComponent(WEB)}`)).toBe("2");
    expect(count("?project=none")).toBe("2");
    expect(count("?project=unreadable")).toBe("1");
    // Every item is a side-item, a link to its own address.
    for (const a of $$("[data-rail] [data-place]")) {
      expect(a.classList.contains("side-item")).toBe(true);
      expect(a.getAttribute("href")).toBe(a.dataset.place);
    }
  });

  it("aria-current is on the place drawn, and only there", async () => {
    await boot();
    expect(current()).toEqual(["?project=all"]);
    railItem(`?project=${encodeURIComponent(APP)}`)?.click();
    expect(current()).toEqual([`?project=${encodeURIComponent(APP)}`]);
  });

  it("the title band names a project by its owner and name, and All flows by those words", async () => {
    await boot();
    expect(title()).toBe("All flows");
    railItem(`?project=${encodeURIComponent(WEB)}`)?.click();
    expect($("[data-place-title] [data-place-owner]")?.textContent).toBe(
      "acme",
    );
    expect($("[data-place-title] [data-place-name]")?.textContent).toBe("web");
    railItem("?project=none")?.click();
    expect(title()).toBe("No project");
  });

  it("the layout toggle sits in the tab row and nowhere else", async () => {
    await boot();
    const toggles = $$("[data-layout-toggle]");
    expect(toggles).toHaveLength(1);
    expect(toggles[0]?.closest("[data-tabs-row]")).not.toBeNull();
    expect(toggles[0]?.hidden).toBe(false);
  });

  it("tabs are hidden under No project; present with counts under a project, All pressed", async () => {
    await boot(`/?project=${encodeURIComponent(WEB)}`);
    const text = (t: string) => tab(t)?.textContent;
    expect(text("inRepo")).toBe("In repo1");
    expect(text("notInRepo")).toBe("Not in repo1");
    expect(text("all")).toBe("All2");
    expect(
      ["inRepo", "notInRepo", "all"].map((t) =>
        tab(t)?.getAttribute("aria-pressed"),
      ),
    ).toEqual(["false", "false", "true"]);
    for (const t of ["inRepo", "notInRepo", "all"]) {
      expect(tab(t)?.classList.contains("btn-quiet")).toBe(true);
    }
    expect(flowsDrawn()).toEqual(["t-plain", "t-kept"]);
    expect(tabsShown()).toHaveLength(3);

    tab("inRepo")?.click();
    expect(flowsDrawn()).toEqual(["t-kept"]);
    expect(tab("inRepo")?.getAttribute("aria-pressed")).toBe("true");
    expect(tab("all")?.getAttribute("aria-pressed")).toBe("false");

    railItem("?project=none")?.click();
    expect(tabsShown()).toHaveLength(0);
    // The toggle stays.
    expect($("[data-tabs-row] [data-layout-toggle]")?.hidden).toBe(false);
  });

  it("a rail click resets the tab to All", async () => {
    await boot(`/?project=${encodeURIComponent(WEB)}`);
    tab("notInRepo")?.click();
    expect(flowsDrawn()).toEqual(["t-plain"]); // premise: a tab narrowed
    railItem("?project=all")?.click();
    expect(tab("all")?.getAttribute("aria-pressed")).toBe("true");
    expect(flowsDrawn()).toHaveLength(6);
  });

  it("under a project the Where cells drop owner/name; under All flows they keep it", async () => {
    await boot();
    const where = () =>
      $(`[data-list] [data-scene="t-plain"] [data-col="where"]`)?.textContent;
    // Positive control: All flows names the repo.
    expect(where()).toContain("acme/web");
    railItem(`?project=${encodeURIComponent(WEB)}`)?.click();
    expect(where()).not.toContain("acme/web");
    expect(where()).toContain("app.test/orders");
  });

  it("switching place with a selection clears it, and Delete names no hidden flow", async () => {
    await boot(`/?project=${encodeURIComponent(WEB)}`);
    $('[data-select="plain"]')?.click();
    // Premise: the tick took.
    expect($("[data-selection-bar]")).not.toBeNull();

    railItem(`?project=${encodeURIComponent(APP)}`)?.click();
    expect($("[data-selection-bar]")).toBeNull();
    expect(
      document.querySelector("#root")?.hasAttribute("data-selecting"),
    ).toBe(false);
    // Back where it was ticked, nothing is.
    railItem(`?project=${encodeURIComponent(WEB)}`)?.click();
    expect($('[data-select="plain"]')).not.toBeNull();
    expect(($('[data-select="plain"]') as HTMLInputElement).checked).toBe(
      false,
    );
    expect($("[data-selection-bar]")).toBeNull();
    expect(calls("videos", "remove")).toHaveLength(0);
  });

  it("a tab click with a selection clears it too", async () => {
    await boot(`/?project=${encodeURIComponent(WEB)}`);
    $('[data-select="plain"]')?.click();
    expect($("[data-selection-bar]")).not.toBeNull(); // premise
    tab("inRepo")?.click();
    tab("all")?.click();
    expect(($('[data-select="plain"]') as HTMLInputElement).checked).toBe(
      false,
    );
    expect($("[data-selection-bar]")).toBeNull();
  });

  it("a rail click puts the place in the address and saves the pick", async () => {
    await boot();
    railItem(`?project=${encodeURIComponent(APP)}`)?.click();
    expect(location.search).toBe(`?project=${encodeURIComponent(APP)}`);
    expect(calls("libraryView", "write").map((c) => c.args[0])).toEqual([
      { ...DEFAULT_LIBRARY_VIEW, project: APP },
    ]);
    expect(flowsDrawn()).toEqual(["t-app"]);
  });

  it("a pick that was not saved is said on the console", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await boot();
    state.memory?.answer("libraryView.write", async () => {
      throw new Error("the disk is full");
    });
    railItem("?project=none")?.click();
    await vi.waitFor(() => {
      if (!warn.mock.calls.flat().join(" ").includes("the disk is full")) {
        throw new Error("nothing said yet");
      }
    });
    expect(warn.mock.calls.flat().join(" ")).toContain("not saved");
  });

  it("Back in the browser repaints the place it left", async () => {
    await boot();
    railItem(`?project=${encodeURIComponent(APP)}`)?.click();
    expect(current()).toEqual([`?project=${encodeURIComponent(APP)}`]);
    history.back();
    await vi.waitFor(() => {
      if (current()[0] !== "?project=all") throw new Error("not back yet");
    });
    expect(flowsDrawn()).toHaveLength(6);
  });

  it("the page applies ?project= on load", async () => {
    await boot(`/?project=${encodeURIComponent(APP)}`, pick("none"));
    expect(current()).toEqual([`?project=${encodeURIComponent(APP)}`]);
    expect(flowsDrawn()).toEqual(["t-app"]);
    expect(calls("libraryView", "write")).toHaveLength(0);
  });

  it("the saved pick opens when the address names none", async () => {
    await boot("/", pick(APP));
    expect(current()).toEqual([`?project=${encodeURIComponent(APP)}`]);
  });

  it("a saved pick that is gone opens All flows", async () => {
    await boot("/", pick("github.com/gone/away"));
    expect(current()).toEqual(["?project=all"]);
    expect(
      railItem(`?project=${encodeURIComponent("github.com/gone/away")}`),
    ).toBeNull();
  });

  it("a stored pick of '' is no pick", async () => {
    await boot("/", pick(""));
    expect(current()).toEqual(["?project=all"]);
  });

  it("a URL key with no flows opens that project empty", async () => {
    const key = "github.com/acme/new";
    await boot(`/?project=${encodeURIComponent(key)}`);
    expect(current()).toEqual([`?project=${encodeURIComponent(key)}`]);
    expect(
      railItem(`?project=${encodeURIComponent(key)}`)?.querySelector(
        ".side-count",
      )?.textContent,
    ).toBe("0");
    expect($("[data-place-name]")?.textContent).toBe("new");
    expect(tab("all")?.textContent).toBe("All0");
    expect(flowsDrawn()).toEqual([]);
    expect($("[data-empty]")).toBeNull();
  });

  it("Couldn't read shows the unreadable rows and their Delete; no project shows them", async () => {
    await boot();
    // Positive control below; All flows draws none of them.
    expect($('[data-unreadable-row="broken"]')).toBeNull();
    railItem("?project=unreadable")?.click();
    expect(title()).toBe("Couldn't read");
    expect(
      $('[data-unreadable-row="broken"] [data-action="delete"]'),
    ).not.toBeNull();
    expect(tabsShown()).toHaveLength(0);
    railItem(`?project=${encodeURIComponent(WEB)}`)?.click();
    expect($('[data-unreadable-row="broken"]')).toBeNull();
  });

  it("a saved pick is kept by a sort click and a layout toggle", async () => {
    await boot("/", pick(APP));
    $('[data-sort="size"]')?.click();
    $('[data-layout="grid"]')?.click();
    expect(
      calls("libraryView", "write").map(
        (c) => (c.args[0] as LibraryViewChoice).project,
      ),
    ).toEqual([APP, APP]);
    // Premise: both wrote what they changed.
    expect(calls("libraryView", "write").map((c) => c.args[0])).toEqual([
      { ...pick(APP), sort: { column: "size", descending: true } },
      {
        layout: "grid",
        sort: { column: "size", descending: true },
        project: APP,
      },
    ]);
  });

  it("from=<takeId> lands on that take's flow's project and saves no pick", async () => {
    await boot("/?from=t-app", pick("none"));
    expect(location.search).toBe(`?project=${encodeURIComponent(APP)}`);
    expect(current()).toEqual([`?project=${encodeURIComponent(APP)}`]);
    expect(calls("libraryView", "write")).toHaveLength(0);
  });

  it("from= a take in no flow lands on No project", async () => {
    await boot("/?from=loose", pick(APP));
    expect(location.search).toBe("?project=none");
    expect(current()).toEqual(["?project=none"]);
  });

  it("from= an unknown take falls back to the saved pick", async () => {
    await boot("/?from=nope", pick(APP));
    expect(current()).toEqual([`?project=${encodeURIComponent(APP)}`]);
    expect(location.search).not.toContain("from=");
    expect(calls("libraryView", "write")).toHaveLength(0);
  });
});

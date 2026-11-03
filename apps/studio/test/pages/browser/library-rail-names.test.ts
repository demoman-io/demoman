import { page } from "@vitest/browser/context";
import { afterAll, describe, expect, it } from "vitest";
// The page's own markup and rules, the studio's sheet the build links
// beside them, and the real view: the names measured are the ones the
// studio paints.
import studioCss from "../../../pages/assets/studio.css?raw";
import shell from "../../../pages/entrypoints/library/index.html?raw";
import {
  type Place,
  placeSearch,
  type Rail,
} from "../../../pages/src/library/projects";
import type { LibraryModel } from "../../../pages/src/library/state";
import { renderLibrary } from "../../../pages/src/library/view";
import { mountShell, node, pageParts } from "../helpers/shell-css";

/**
 * A project's name in the rail and the narrow switcher (2026-11-02): the
 * author's `ytesfazgi/demoman-pr-check` painted as `ytesfazgi/...`, the
 * label's ellipsis taking the whole repo name. The owner gives way first.
 */

const { css, body } = pageParts(shell, "article.card:hover");

const LONG = "github.com/ytesfazgi/demoman-pr-check";
const LONGER = "github.com/acme/an-extremely-long-repository-name-for-a-rail";
const RAIL: Rail = {
  all: 4,
  projects: [
    {
      key: "github.com/acme/web",
      owner: "acme",
      name: "web",
      local: false,
      count: 1,
    },
    {
      key: LONGER,
      owner: "acme",
      name: LONGER.split("/")[2] as string,
      local: false,
      count: 1,
    },
    {
      key: LONG,
      owner: "ytesfazgi",
      name: "demoman-pr-check",
      local: false,
      count: 1,
    },
    {
      key: "local:/r/scratch",
      owner: null,
      name: "scratch",
      local: true,
      count: 1,
    },
  ],
  none: 0,
  unreadable: 0,
};

const MODEL: LibraryModel = {
  usedBytes: 0,
  budgetBytes: 4 * 1024 ** 3,
  fraction: 0,
  chromeNearLimit: false,
  migrating: false,
  migrationFailed: false,
  notice: null,
  rows: [
    {
      sceneId: "one",
      name: "",
      label: "localhost:4000/checkout",
      origin: "localhost:4000",
      path: "/checkout",
      createdAt: "2026-09-13T14:15:03Z",
      when: "Sep 13, 2:15 PM",
      time: "2:15 PM",
      hosted: true,
      recoverable: false,
      frameBytes: 1024,
      outputBytes: 1024,
      state: "Complete",
      canRestore: false,
      authored: false,
      servesReshoot: false,
      needsLook: false,
    },
  ],
};

const noop = {
  reclaim() {},
  setBudget() {},
  edit() {},
  restore() {},
  backToRecording() {},
  remove() {},
  preview() {},
  rename() {},
  renameVideo() {},
  openReview() {},
};

/** The page as the studio serves it: dark, `data-studio`, studio.css. */
function mount(place: Place) {
  mountShell("dark", `${css}\n${studioCss}`);
  document.documentElement.setAttribute("data-studio", "");
  document.body.innerHTML = body;
  renderLibrary(
    node("#root"),
    MODEL,
    noop,
    new Map(),
    new Date(2026, 8, 13, 20),
    undefined,
    undefined,
    undefined,
    { place, tab: "all", rail: RAIL, tabs: null },
  );
}

/** A part's text at its full width, cut or not, inline or not. */
function natural(e: Element): number {
  const r = document.createRange();
  r.selectNodeContents(e);
  return r.getBoundingClientRect().width;
}

/** A project's label as painted: its parts' boxes and whether each shows
 *  all of its text. */
function label(scope: string) {
  const box = node(scope);
  const part = (sel: string) => {
    const e = box.querySelector<HTMLElement>(sel);
    if (e === null) return null;
    const r = e.getBoundingClientRect();
    return {
      left: r.left,
      right: r.right,
      width: r.width,
      whole: e.scrollWidth <= e.clientWidth,
    };
  };
  const r = box.getBoundingClientRect();
  return {
    left: r.left,
    right: r.right,
    owner: part("[data-place-owner]"),
    name: part("[data-place-name]"),
  };
}
const railLabel = (key: string) =>
  label(
    `[data-rail] [data-place="${placeSearch({ project: key })}"] .side-label`,
  );

afterAll(async () => {
  await page.viewport(414, 896);
});

describe("a project's name in the rail", () => {
  it("keeps a repo name whole when the owner and the name do not both fit", async () => {
    await page.viewport(1280, 900);
    mount("all");
    const l = railLabel(LONG);
    // Premise: the two together are wider than the label, or there is
    // nothing to give way.
    const ownerNatural = natural(
      node(`[data-rail] [title="${LONG}"] [data-place-owner]`),
    );
    const nameNatural = natural(
      node(`[data-rail] [title="${LONG}"] [data-place-name]`),
    );
    expect(
      ownerNatural + nameNatural,
      `premise: ytesfazgi/demoman-pr-check overflows its label ${JSON.stringify(l)}`,
    ).toBeGreaterThan(l.right - l.left);
    expect(l.name?.whole, `the repo name is whole ${JSON.stringify(l)}`).toBe(
      true,
    );
    expect(l.name?.right).toBeLessThanOrEqual(l.right + 0.5);
    expect(l.owner?.whole, `the owner gave way ${JSON.stringify(l)}`).toBe(
      false,
    );
    await page.screenshot({
      path: "__screenshots__/library-rail-names/rail-1280x900.png",
    });
  });

  it("cuts a repo name longer than the rail with its own ellipsis, inside the label", async () => {
    await page.viewport(1280, 900);
    mount("all");
    const l = railLabel(LONGER);
    expect(
      l.name?.whole,
      `premise: the name alone overflows ${JSON.stringify(l)}`,
    ).toBe(false);
    expect(l.name?.left).toBeGreaterThanOrEqual(l.left - 0.5);
    expect(l.name?.right).toBeLessThanOrEqual(l.right + 0.5);
    // Most of the label is the name, not an owner and a lone ellipsis.
    expect(l.name?.width ?? 0).toBeGreaterThan((l.right - l.left) * 0.8);
  });

  it("leaves a short name and its owner whole, and the space before local", async () => {
    await page.viewport(1280, 900);
    mount("all");
    const short = railLabel("github.com/acme/web");
    expect(short.owner?.whole).toBe(true);
    expect(short.name?.whole).toBe(true);
    expect(short.name?.left).toBeCloseTo(short.owner?.right ?? 0, 0);
    // A flex item drops its leading space unless it keeps it: the space
    // before "local" paints a width of its own.
    const local = node(
      `[data-rail] [title="local:/r/scratch"] [data-place-local]`,
    );
    expect(local.textContent).toBe(" local");
    const space = document.createRange();
    space.setStart(local.firstChild as Text, 0);
    space.setEnd(local.firstChild as Text, 1);
    expect(space.getBoundingClientRect().width).toBeGreaterThan(2);
  });
});

describe("a project's name in the narrow switcher", () => {
  it("keeps the repo name whole when the owner and the name do not both fit", async () => {
    // Sized from the title's own glyphs: room for the name and half the
    // owner, whatever face the machine resolves.
    await page.viewport(1000, 900);
    mount({ project: LONG });
    const scope = "[data-place-switch] .place-switch-name";
    const owner = natural(node(`${scope} [data-place-owner]`));
    const name = natural(node(`${scope} [data-place-name]`));
    // The button grows to its title's row; the chevron and its gap beside
    // the name are what the row gives up besides.
    const row = (node("[data-place-switch]").parentElement as HTMLElement)
      .clientWidth;
    const chevron =
      node("[data-place-switch]").getBoundingClientRect().width - owner - name;
    const room = name + owner / 2 + chevron;
    await page.viewport(Math.round(1000 - (row - room)), 900);
    const l = label(scope);
    // Premise: the switcher is the title drawn, and it is too narrow for both.
    expect(node("[data-place-switch]").checkVisibility()).toBe(true);
    expect(
      l.right - l.left,
      `premise: room for the name, not both`,
    ).toBeLessThan(owner + name);
    expect(l.right - l.left).toBeGreaterThanOrEqual(name);
    expect(l.owner?.whole, `the owner gave way ${JSON.stringify(l)}`).toBe(
      false,
    );
    expect(l.name?.whole, `the repo name is whole ${JSON.stringify(l)}`).toBe(
      true,
    );
  });
});

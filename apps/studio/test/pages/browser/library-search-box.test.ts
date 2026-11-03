import type { SceneDocument } from "@demoman/scene-schema";
import type { VideoSummary } from "@demoman/studio-protocol";
import { page, userEvent } from "@vitest/browser/context";
import { afterAll, describe, expect, it, vi } from "vitest";
import studioCss from "../../../pages/assets/studio.css?raw";
import shell from "../../../pages/entrypoints/library/index.html?raw";
import { WHY_WHOLE } from "../../../pages/src/library/search";
import {
  createMemoryPlatform,
  type MemoryPlatform,
} from "../helpers/memory-platform";
import { mountShell, node, pageParts, parse } from "../helpers/shell-css";

const state = vi.hoisted(() => ({ memory: null as MemoryPlatform | null }));
vi.mock("#platform", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  createPlatform: () => state.memory,
}));

/**
 * The library's search box as the studio paints it (spec 2026-11-02
 * library-search-design): dark, `data-studio`, studio.css, the real
 * `main.ts` over the memory platform, so a keystroke repaints the page the
 * way the studio does. Booted once: module state cannot be re-imported.
 */

const { css, body } = pageParts(shell, "article.card:hover");

const WEB = "github.com/acme/web";
const take = (id: string, day: number): SceneDocument =>
  ({
    meta: {
      id,
      name: `Take ${id}`,
      createdAt: `2026-10-${String(day).padStart(2, "0")}T10:00:00Z`,
      capture: { originUrl: "https://app.test/orders" },
    },
  }) as unknown as SceneDocument;
const video = (id: string, name: string, steps: string[]): VideoSummary => ({
  id,
  name,
  repo: { key: WEB },
  startPage: "https://app.test/",
  versions: 1,
  current: {
    version: 1,
    takeId: `t-${id}`,
    recordedAt: "2026-10-01T00:00:00Z",
    expired: false,
  },
  pages: ["https://app.test/"],
  steps,
  exports: [],
  kept: null,
  addedTo: null,
});
const VIDEOS = [
  video("invite", "Invite a teammate", ["click Send invite"]),
  video("billing", "Update billing", ["click Save", "tap OK"]),
  video("onboard", "Team onboarding", ["click Invite member"]),
  video("signup", "Sign up a new customer", [
    "type alice@example.com into Email address",
  ]),
];

const originalUrl = location.href;
afterAll(async () => {
  history.replaceState({}, "", originalUrl);
  await page.viewport(414, 896);
});

let booted: Promise<void> | null = null;
function bootOnce(): Promise<void> {
  booted ??= (async () => {
    const url = new URL(location.href);
    url.search = `?project=${encodeURIComponent(WEB)}`;
    history.replaceState({}, "", url.href);
    await page.viewport(1440, 900);
    mountShell("dark", `${css}\n${studioCss}`);
    document.documentElement.setAttribute("data-studio", "");
    document.body.innerHTML = body;
    state.memory = createMemoryPlatform({
      scenes: VIDEOS.map((v, i) => take(`t-${v.id}`, 20 + i)),
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
    });
    await import("../../../pages/entrypoints/library/main");
    await vi.waitFor(() => {
      if (document.querySelectorAll("[data-list] [data-flow]").length !== 4) {
        throw new Error("four flows not drawn yet");
      }
    });
  })();
  return booted;
}

const input = () => node("[data-search]") as HTMLInputElement;
const flows = () =>
  [...document.querySelectorAll<HTMLElement>("[data-list] [data-flow]")].map(
    (r) => r.dataset.flow,
  );
const rect = (e: Element) => e.getBoundingClientRect();
/** How many near-white pixels Chrome painted inside `r` (CSS px). */
async function brightIn(r: {
  left: number;
  top: number;
  right: number;
  bottom: number;
}): Promise<number> {
  // Unsaved, the provider answers with the base64 string itself
  // (library-list-shell.test.ts).
  const shot: unknown = await page.screenshot({ base64: true, save: false });
  const base64 =
    typeof shot === "string" ? shot : (shot as { base64: string }).base64;
  const image = new Image();
  image.src = base64.startsWith("data:")
    ? base64
    : `data:image/png;base64,${base64}`;
  await image.decode();
  const canvas = document.createElement("canvas");
  canvas.width = image.width;
  canvas.height = image.height;
  const context = canvas.getContext("2d") as CanvasRenderingContext2D;
  context.drawImage(image, 0, 0);
  const k = image.width / window.innerWidth;
  const x = Math.ceil(r.left * k);
  const y = Math.ceil(r.top * k);
  const data = context.getImageData(
    x,
    y,
    Math.floor(r.right * k) - x,
    Math.floor(r.bottom * k) - y,
  ).data;
  let n = 0;
  for (let i = 0; i < data.length; i += 4) {
    if (Math.min(data[i] ?? 0, data[i + 1] ?? 0, data[i + 2] ?? 0) > 140) n++;
  }
  return n;
}

/** A flow row's why in its name cell or its Where cell. */
const why = (flow: string, slot: "name" | "where") =>
  node(`[data-flow="${flow}"] [data-col="${slot}"] > [data-match-why]`);
/** Its text as painted: drawn, whole inside its cell (not cut by the
 *  cell's ellipsis), and on top at its middle. */
function paintedWhole(e: HTMLElement): { shown: boolean; whole: boolean } {
  if (!e.checkVisibility()) return { shown: false, whole: false };
  const cell = e.parentElement as HTMLElement;
  const text = document.createRange();
  text.selectNodeContents(e);
  const r = text.getBoundingClientRect();
  const c = rect(cell);
  const hit = document.elementFromPoint(
    r.left + r.width / 2,
    (r.top + r.bottom) / 2,
  );
  return {
    shown: hit !== null && e.contains(hit),
    whole:
      r.width > 0 &&
      r.right <= c.right + 0.5 &&
      cell.scrollWidth <= cell.clientWidth,
  };
}

/** A row's name beside its why, as painted: the name's width against its
 *  floor (35% of the cell, index.html), and the matched word
 *  inside the part of the why that is drawn (short of a cut why's "…"). */
function floorAndWord(flow: string, word: string) {
  const cell = node(`[data-flow="${flow}"] [data-col="name"]`);
  const name = node(`[data-flow="${flow}"] [data-name-text]`);
  const w = why(flow, "name");
  const style = getComputedStyle(cell);
  const content =
    cell.clientWidth -
    Number.parseFloat(style.paddingLeft) -
    Number.parseFloat(style.paddingRight);
  const probe = document.createElement("span");
  probe.className = "match-why";
  probe.style.cssText = "position: absolute; max-width: none";
  cell.append(probe);
  probe.textContent = w.title;
  const full = rect(probe).width;
  probe.textContent = "…";
  const ellipsis = rect(probe).width;
  probe.remove();
  const floor = 0.35 * content;
  const n = rect(name);
  const mid = (n.top + n.bottom) / 2;
  const nameHit = document.elementFromPoint(n.left + floor - 2, mid);
  const text = w.firstChild as Text;
  const at = (text.data ?? "").indexOf(word);
  const range = document.createRange();
  range.setStart(text, Math.max(at, 0));
  range.setEnd(text, Math.max(at, 0) + word.length);
  const r = range.getBoundingClientRect();
  const cut = w.scrollWidth > w.clientWidth;
  const drawnTo = rect(w).right - (cut ? ellipsis : 0);
  const wordHit = document.elementFromPoint(
    r.left + r.width / 2,
    (r.top + r.bottom) / 2,
  );
  return {
    evidence: JSON.stringify({
      text: text.data,
      title: w.title,
      cell: content,
      full,
      floor,
      name: n.width,
      word: [r.left, r.right],
      drawnTo,
      cut,
      fonts: [...document.fonts].map((f) => `${f.family} ${f.status}`),
    }),
    cell: content,
    /** Premise: the whole sentence would not fit the cell. */
    fullWiderThanCell: full > content,
    nameAtFloor:
      n.width >= floor - 0.5 && nameHit !== null && name.contains(nameHit),
    wordPainted:
      at >= 0 &&
      r.width > 0 &&
      r.right <= drawnTo + 0.5 &&
      wordHit !== null &&
      w.contains(wordHit),
  };
}

describe("the library's search box", () => {
  it("sits in the tab row, right of the tabs and left of the toggle, on one line", async () => {
    await bootOnce();
    await page.viewport(1440, 900);
    const box = rect(input());
    const tabs = rect(node(".place-tabs"));
    const toggle = rect(node("[data-layout-toggle]"));
    const field = rect(node(".search-field"));
    expect(field.width, "the field is drawn").toBeGreaterThan(120);
    expect(tabs.right).toBeLessThanOrEqual(field.left);
    expect(field.right).toBeLessThanOrEqual(toggle.left);
    // One line: each one's middle inside the others' band.
    for (const r of [tabs, toggle]) {
      const mid = (r.top + r.bottom) / 2;
      expect(mid).toBeGreaterThan(field.top);
      expect(mid).toBeLessThan(field.bottom);
    }
    // Painted, not covered.
    expect(
      document.elementFromPoint(
        box.left + box.width / 2,
        box.top + box.height / 2,
      ),
    ).toBe(input());
    await page.screenshot({
      path: "__screenshots__/library-search-box/row-1440x900.png",
    });
  });

  it("/ from the page focuses it, and / inside it types a /", async () => {
    await bootOnce();
    (document.activeElement as HTMLElement | null)?.blur();
    expect(document.activeElement).not.toBe(input()); // premise
    await userEvent.keyboard("/");
    expect(document.activeElement).toBe(input());
    expect(input().value).toBe("");
    await userEvent.keyboard("/");
    expect(input().value).toBe("/");
    await userEvent.keyboard("{Backspace}");
    expect(input().value).toBe("");
  });

  it("keeps focus, value and caret through the repaint a keystroke makes", async () => {
    await bootOnce();
    await userEvent.click(input());
    const before = document.querySelector("[data-list]");
    await userEvent.keyboard("inv");
    // Premise: the list was drawn again under the box.
    expect(document.querySelector("[data-list]")).not.toBe(before);
    expect(flows().sort()).toEqual(["invite", "onboard"]);
    expect(document.activeElement).toBe(input());
    expect(input().value).toBe("inv");
    expect(input().selectionStart).toBe(3);
    expect(input().selectionEnd).toBe(3);
    // Each keystroke: still where the next character goes.
    await userEvent.keyboard("i");
    expect(input().value).toBe("invi");
    expect(input().selectionStart).toBe(4);
    // Wide, the why follows the name, and Where keeps the route.
    const wide = floorAndWord("onboard", "Invite");
    expect(
      { nameAtFloor: wide.nameAtFloor, wordPainted: wide.wordPainted },
      wide.evidence,
    ).toEqual({ nameAtFloor: true, wordPainted: true });
    expect(rect(why("onboard", "name")).left).toBeGreaterThanOrEqual(
      rect(node('[data-flow="onboard"] [data-name-text]')).right,
    );
    expect(why("onboard", "where").checkVisibility()).toBe(false);
    expect(
      node('[data-flow="onboard"] [data-where-text]').checkVisibility(),
    ).toBe(true);
    // Chrome's own clear button (a white ✕ at the field's right end while
    // it holds text) is not drawn: Esc clears. Premise: the sampler sees
    // the typed text's white ink at the field's left.
    const f = rect(input());
    const band = { top: f.top + 4, bottom: f.bottom - 4 };
    expect(
      await brightIn({ ...band, left: f.left + 28, right: f.left + 70 }),
      "the typed text's ink",
    ).toBeGreaterThan(10);
    expect(
      await brightIn({ ...band, left: f.right - 44, right: f.right - 4 }),
      "a clear button's ink",
    ).toBe(0);
    await page.screenshot({
      path: "__screenshots__/library-search-box/typed-1440x900.png",
    });
  });

  it("a long why keeps the name's floor and paints its matched word, 1440 to 830", async () => {
    await bootOnce();
    // 830 is where the name column sits at its 160px minimum, the least
    // room a why beside the name has (asserted below).
    for (const width of [1440, 900, 830]) {
      await page.viewport(width, 900);
      await userEvent.fill(input(), "email");
      await vi.waitFor(() => {
        if (flows().join() !== "signup") throw new Error("not narrowed yet");
      });
      const at = floorAndWord("signup", "Email");
      expect(at.fullWiderThanCell, `${width}: premise ${at.evidence}`).toBe(
        true,
      );
      if (width === 830) {
        expect(at.cell, `premise: the narrowest cell ${at.evidence}`).toBe(160);
      }
      expect(
        { nameAtFloor: at.nameAtFloor, wordPainted: at.wordPainted },
        `${width}: ${at.evidence}`,
      ).toEqual({ nameAtFloor: true, wordPainted: true });
      expect(why("signup", "where").checkVisibility()).toBe(false);
      await page.screenshot({
        path: `__screenshots__/library-search-box/long-why-${width}x900.png`,
      });
    }
    // And a why short enough to stay whole (`WHY_WHOLE`) is whole there.
    await userEvent.fill(input(), "ok");
    await vi.waitFor(() => {
      if (flows().join() !== "billing") throw new Error("not narrowed yet");
    });
    const short = why("billing", "name");
    expect(short.textContent, "premise: whole, at the threshold").toBe(
      "step: tap OK",
    );
    expect(short.textContent?.length).toBe(WHY_WHOLE);
    expect(paintedWhole(short), short.textContent ?? "").toEqual({
      shown: true,
      whole: true,
    });
    await page.viewport(1440, 900);
  });

  it("Esc in the box clears it and keeps a ticked flow ticked", async () => {
    await bootOnce();
    await userEvent.fill(input(), "inv");
    expect(flows().sort()).toEqual(["invite", "onboard"]); // premise
    (node('[data-select="invite"]') as HTMLInputElement).click();
    expect((node('[data-select="invite"]') as HTMLInputElement).checked).toBe(
      true,
    );
    await userEvent.click(input());
    await userEvent.keyboard("{Escape}");
    expect(input().value).toBe("");
    expect(flows()).toHaveLength(4);
    expect(
      (node('[data-select="invite"]') as HTMLInputElement).checked,
      "the tick Esc in the box left",
    ).toBe(true);
    expect(document.querySelector("[data-selection-bar]")).not.toBeNull();
    // Esc again, outside the box, is the page's: it clears the selection.
    input().blur();
    await userEvent.keyboard("{Escape}");
    expect(document.querySelector("[data-selection-bar]")).toBeNull();
  });

  it("the grid draws the results as one run, the why on the card's line", async () => {
    await bootOnce();
    await page.viewport(1440, 900);
    await userEvent.fill(input(), "invite member");
    node('[data-layout="grid"]').click();
    await vi.waitFor(() => {
      if (document.querySelector("article[data-video]") === null) {
        throw new Error("no cards yet");
      }
    });
    expect(
      [...document.querySelectorAll<HTMLElement>("article[data-video]")].map(
        (a) => a.dataset.video,
      ),
    ).toEqual(["onboard", "invite"]);
    expect(document.querySelectorAll("[data-section]")).toHaveLength(0);
    const why = node(
      'article[data-video="onboard"] [data-meta] [data-match-why]',
    );
    expect(why.textContent).toBe("step: …Invite member");
    expect(why.title).toBe("step: click Invite member");
    expect(rect(why).width).toBeGreaterThan(40);
    await page.screenshot({
      path: "__screenshots__/library-search-box/grid-1440x900.png",
    });
    node('[data-layout="list"]').click();
    await vi.waitFor(() => {
      if (document.querySelector("[data-list]") === null) {
        throw new Error("no list yet");
      }
    });
  });

  // Red: Where kept at a phone's width, 31px of "/or…", the why in it.
  it("drops Where on a phone, the why back beside the name, and keeps it at 560", async () => {
    await bootOnce();
    await userEvent.fill(input(), "email");
    await vi.waitFor(() => {
      if (flows().join() !== "signup") throw new Error("not narrowed yet");
    });
    await page.viewport(560, 640);
    const where = node('[data-flow="signup"] [data-col="where"]');
    expect(where.checkVisibility(), "premise: Where shows at 560").toBe(true);
    expect(why("signup", "where").checkVisibility()).toBe(true);
    await page.viewport(390, 640);
    const head = node('[data-list-head] [data-col="where"]');
    expect({
      cell: where.checkVisibility(),
      head: head.checkVisibility(),
    }).toEqual({
      cell: false,
      head: false,
    });
    const at = floorAndWord("signup", "Email");
    expect(
      { nameAtFloor: at.nameAtFloor, wordPainted: at.wordPainted },
      at.evidence,
    ).toEqual({ nameAtFloor: true, wordPainted: true });
    // The name's cell reaches Recorded: no empty track between them.
    const name = rect(node('[data-flow="signup"] [data-col="name"]'));
    const recorded = rect(node('[data-flow="signup"] [data-col="recorded"]'));
    expect(
      recorded.left - name.right,
      JSON.stringify({ name, recorded }),
    ).toBeLessThanOrEqual(12.5);
    const html = document.documentElement;
    expect(html.scrollWidth).toBeLessThanOrEqual(html.clientWidth);
    await page.screenshot({
      path: "__screenshots__/library-search-box/phone-why-390x640.png",
    });
  });

  it("fits a 720px window with no sideways scroll, the box still drawn", async () => {
    await bootOnce();
    await page.viewport(720, 900);
    await userEvent.fill(input(), "invite");
    await vi.waitFor(() => {
      if (flows().length !== 2) throw new Error("not narrowed yet");
    });
    const html = document.documentElement;
    expect(html.scrollWidth).toBeLessThanOrEqual(html.clientWidth);
    const box = rect(input());
    expect(box.width).toBeGreaterThan(100);
    expect(box.right).toBeLessThanOrEqual(html.clientWidth);
    expect(
      document.elementFromPoint(
        box.left + box.width / 2,
        box.top + box.height / 2,
      ),
    ).toBe(input());
    // Narrow, the why takes Where's place whole, over Videos and Length,
    // and the name cell's copy goes; a row found by name is as it was.
    const narrow = paintedWhole(why("onboard", "where"));
    expect(narrow, why("onboard", "where").textContent ?? "").toEqual({
      shown: true,
      whole: true,
    });
    expect(why("onboard", "name").checkVisibility()).toBe(false);
    expect(
      node('[data-flow="onboard"] [data-where-text]').checkVisibility(),
    ).toBe(false);
    expect(
      node('[data-flow="onboard"] [data-col="videos"]').checkVisibility(),
    ).toBe(false);
    expect(
      node('[data-flow="invite"] [data-col="videos"]').checkVisibility(),
    ).toBe(true);
    // Recorded stays on the row's one line.
    expect(
      rect(node('[data-flow="onboard"] [data-col="recorded"]')).top,
    ).toBeCloseTo(rect(node('[data-flow="onboard"] [data-col="name"]')).top, 0);
    await page.screenshot({
      path: "__screenshots__/library-search-box/typed-720x900.png",
    });
  });
});

/** The page's pixels, as Chrome painted them; `at(x, y)` in CSS px. */
async function paintOf(): Promise<(x: number, y: number) => number[]> {
  const shot: unknown = await page.screenshot({ base64: true, save: false });
  const base64 =
    typeof shot === "string" ? shot : (shot as { base64: string }).base64;
  const image = new Image();
  image.src = base64.startsWith("data:")
    ? base64
    : `data:image/png;base64,${base64}`;
  await image.decode();
  const canvas = document.createElement("canvas");
  canvas.width = image.width;
  canvas.height = image.height;
  const context = canvas.getContext("2d") as CanvasRenderingContext2D;
  context.drawImage(image, 0, 0);
  const k = image.width / window.innerWidth;
  return (x, y) => [
    ...context.getImageData(Math.floor(x * k), Math.floor(y * k), 1, 1).data,
  ];
}

// Under a 600px list (spec 2026-11-02 search-narrow §1): the box folds to
// its glyph while empty and unfocused, opens across the tab row while
// focused, and holding a query stays open beside the tabs (560) or over
// them (390, a phone's list). Each state measured against the tabs and the
// toggle, never fixed positions: the runner's fonts are not these.
describe("the search box on a narrow list", () => {
  const field = () => node(".search-field");
  const tabsRow = () => node("[data-tabs-row]");
  const pills = () => [
    ...document.querySelectorAll<HTMLElement>(".place-tabs [data-tab]"),
  ];
  const toggles = () =>
    [
      ...document.querySelectorAll<HTMLElement>(
        "[data-layout-toggle] [data-layout]",
      ),
    ].filter((b) => b.checkVisibility());
  const hits = (e: Element) => {
    const r = rect(e);
    const hit = document.elementFromPoint(
      r.left + r.width / 2,
      r.top + r.height / 2,
    );
    return hit !== null && e.contains(hit);
  };
  const toggleBox = () => rect(node("[data-layout-toggle]"));
  const pillsRight = () => Math.max(...pills().map((p) => rect(p).right));
  const said = (at: string) =>
    `${at}: ${JSON.stringify({
      list: document.querySelector("[data-list]")?.getBoundingClientRect()
        .width,
      row: rect(tabsRow()),
      field: rect(field()),
      pills: pills().map((p) => [rect(p).left, rect(p).top, rect(p).right]),
      toggles: toggles().map((b) => [b.dataset.layout, rect(b).left]),
      value: input().value,
      focused: document.activeElement === input(),
      fonts: [...document.fonts].map((f) => `${f.family} ${f.status}`),
    })}`;

  /** Types `q` (the list answering it) and leaves the box focused or not. */
  async function hold(q: string, focused: boolean) {
    await userEvent.fill(input(), q);
    const n = q === "" ? 4 : 2;
    await vi.waitFor(() => {
      if (flows().length !== n) throw new Error(`not ${n} flows yet`);
    });
    if (!focused) input().blur();
    expect(document.activeElement === input(), "premise: focus").toBe(focused);
  }

  /** What every narrow state keeps: nothing sideways, the tabs on one
   *  line with one-line labels, and no `/` hint. */
  function rowHolds(at: string) {
    const html = document.documentElement;
    expect(html.scrollWidth, said(at)).toBeLessThanOrEqual(html.clientWidth);
    // Nothing past the row's end, into the page's margin.
    expect(toggleBox().right, `${said(at)}: the toggle`).toBeLessThanOrEqual(
      rect(tabsRow()).right + 0.5,
    );
    const tops = new Set(pills().map((p) => Math.round(rect(p).top)));
    expect(tops.size, `${said(at)}: the tabs on one line`).toBe(1);
    for (const p of pills()) {
      const label = document.createRange();
      label.selectNodeContents(p.firstChild as Text);
      expect(
        label.getClientRects().length,
        `${said(at)}: "${p.textContent}" on one line`,
      ).toBe(1);
    }
    expect(
      node(".search-field > kbd").checkVisibility(),
      `${said(at)}: the / hint`,
    ).toBe(false);
  }

  /** Folded: a pill-high square between the tabs and the toggle, the
   *  input itself on top, and no ink in it but the glyph's. */
  async function folded(at: string) {
    const f = rect(field());
    const pill = rect(pills()[0] as HTMLElement);
    expect(Math.abs(f.width - 32), said(at)).toBeLessThanOrEqual(0.5);
    expect(Math.abs(f.height - pill.height), said(at)).toBeLessThanOrEqual(0.5);
    expect(f.left, said(at)).toBeGreaterThanOrEqual(pillsRight() + 7.5);
    // Beside the toggle, one row gap from it (the approved mockup).
    const gap = Number.parseFloat(getComputedStyle(tabsRow()).columnGap);
    expect(
      Math.abs(toggleBox().left - f.right - gap),
      `${said(at)}: one ${gap}px gap from the toggle`,
    ).toBeLessThanOrEqual(0.5);
    expect(Math.abs(f.top - pill.top), said(at)).toBeLessThanOrEqual(0.5);
    expect(hits(input()), said(at)).toBe(true);
    const glyph = rect(node(".search-field > svg"));
    const ground = parse(getComputedStyle(input()).backgroundColor);
    // Premise: the field's ground is opaque, so it is what paints.
    expect(ground[3], said(at)).toBe(1);
    const paint = await paintOf();
    let inGlyph = 0;
    const stray: string[] = [];
    for (let y = f.top + 10; y < f.bottom - 10; y++) {
      for (let x = f.left + 2; x < f.right - 2; x++) {
        const p = paint(x + 0.5, y + 0.5);
        const off = [0, 1, 2].some(
          (i) => Math.abs((p[i] ?? 0) - (ground[i] ?? 0)) > 8,
        );
        if (!off) continue;
        const inside =
          x >= glyph.left - 1 &&
          x < glyph.right + 1 &&
          y >= glyph.top - 1 &&
          y < glyph.bottom + 1;
        if (inside) inGlyph++;
        else stray.push(`${x},${y}:${p.slice(0, 3)}`);
      }
    }
    expect(inGlyph, `${said(at)}: premise: the glyph's ink`).toBeGreaterThan(
      10,
    );
    expect(stray, `${said(at)}: ink beside the glyph`).toEqual([]);
    // And the input is the square: past its right edge the page's own
    // ground, not the field's (a step lighter) or its ring.
    const page_ = paint(f.left + f.width / 2, f.top - 6);
    const past: string[] = [];
    for (let x = f.right + 1; x <= f.right + 6; x++) {
      const p = paint(x + 0.5, f.top + f.height / 2);
      if ([0, 1, 2].some((i) => Math.abs((p[i] ?? 0) - (page_[i] ?? 0)) > 2)) {
        past.push(`${x}:${p.slice(0, 3)}`);
      }
    }
    expect(past, `${said(at)}: the field past its square (${page_})`).toEqual(
      [],
    );
  }

  /** The query, painted in the box: its ink, the input on top, the whole
   *  query inside the box. */
  async function queryShown(at: string) {
    const f = rect(input());
    const glyph = rect(node(".search-field > svg"));
    expect(hits(input()), said(at)).toBe(true);
    expect(
      input().scrollWidth,
      `${said(at)}: the query whole`,
    ).toBeLessThanOrEqual(input().clientWidth);
    expect(
      await brightIn({
        top: f.top + 4,
        bottom: f.bottom - 4,
        left: glyph.right + 2,
        right: f.right - 4,
      }),
      `${said(at)}: the query's ink`,
    ).toBeGreaterThan(10);
  }

  // Red: today's wrap (`flex-wrap: wrap` on the row, the field's 180px
  // floor), which put the box on a line of its own under the tabs.
  it("at 560: folded to its glyph between the tabs and the toggle, and a press opens it", async () => {
    await bootOnce();
    await page.viewport(560, 640);
    await hold("", false);
    // Premise: the list is under 600 and over 480 (a phone's).
    const list = rect(node("[data-list]")).width;
    expect(list, said("560")).toBeLessThan(600);
    expect(list, said("560")).toBeGreaterThan(480);
    expect(toggles(), said("560")).toHaveLength(2);
    rowHolds("560 folded");
    await folded("560 folded");
    await page.screenshot({
      path: "__screenshots__/library-search-box/narrow-folded-560.png",
    });
    await userEvent.click(field());
    expect(document.activeElement, said("560 pressed")).toBe(input());
  });

  // Red: the focused box left in the row's flow, between the tabs and the
  // toggle, with no room for what is typed.
  it("at 560: focused, it opens across the row over the tabs, and the toggle still answers", async () => {
    await bootOnce();
    await page.viewport(560, 640);
    await hold("inv", true);
    rowHolds("560 focused");
    const f = rect(field());
    const t = toggleBox();
    expect(
      Math.abs(f.left - rect(tabsRow()).left),
      said("560 focused"),
    ).toBeLessThanOrEqual(0.5);
    expect(f.right, said("560 focused")).toBeLessThanOrEqual(t.left);
    expect(t.left - f.right, said("560 focused")).toBeLessThanOrEqual(12.5);
    for (const p of pills()) {
      const r = rect(p);
      const hit = document.elementFromPoint(
        r.left + r.width / 2,
        r.top + r.height / 2,
      );
      expect(
        hit !== null && field().contains(hit),
        `${said("560 focused")}: over ${p.textContent}`,
      ).toBe(true);
    }
    expect(toggles(), said("560 focused")).toHaveLength(2);
    for (const b of toggles()) expect(hits(b), said("560 focused")).toBe(true);
    await queryShown("560 focused");
    await page.screenshot({
      path: "__screenshots__/library-search-box/narrow-focused-560.png",
    });
    // Pressed from the open box, Grid answers, and List brings the rows back.
    await userEvent.click(node('[data-layout="grid"]'));
    await vi.waitFor(() => {
      if (document.querySelector("article[data-video]") === null) {
        throw new Error("no cards yet");
      }
    });
    await userEvent.click(node('[data-layout="list"]'));
    await vi.waitFor(() => {
      if (flows().length !== 2) throw new Error("no list yet");
    });
  });

  // Red: the box folding whenever it is unfocused, a query or not.
  it("at 560: holding a query, it stays open between the tabs and the toggle", async () => {
    await bootOnce();
    await page.viewport(560, 640);
    await hold("invite", false);
    rowHolds("560 held");
    const f = rect(field());
    expect(f.left, said("560 held")).toBeGreaterThanOrEqual(pillsRight() + 7.5);
    expect(f.right, said("560 held")).toBeLessThanOrEqual(
      toggleBox().left - 7.5,
    );
    expect(f.width, said("560 held")).toBeGreaterThan(64);
    expect(hits(pills()[0] as HTMLElement), said("560 held")).toBe(true);
    await queryShown("560 held");
    await page.screenshot({
      path: "__screenshots__/library-search-box/narrow-held-560.png",
    });
    // Esc clears it; unfocused, it folds again.
    await userEvent.click(input());
    await userEvent.keyboard("{Escape}");
    await vi.waitFor(() => {
      if (flows().length !== 4) throw new Error("not cleared yet");
    });
    input().blur();
    await folded("560 cleared");
  });

  // Red: both layout buttons kept on a phone's list, which leaves the
  // tabs no room.
  it("at 390: folded beside one layout button, the one not shown, and / opens it", async () => {
    await bootOnce();
    await page.viewport(390, 640);
    await hold("", false);
    // Premise: a phone's list, under 480.
    expect(rect(node("[data-list]")).width, said("390")).toBeLessThan(480);
    rowHolds("390 folded");
    await folded("390 folded");
    const shown = toggles();
    expect(
      shown.map((b) => b.getAttribute("aria-pressed")),
      said("390"),
    ).toEqual(["false"]);
    expect(shown[0]?.dataset.layout, said("390")).toBe("grid");
    expect(hits(shown[0] as HTMLElement), said("390")).toBe(true);
    await page.screenshot({
      path: "__screenshots__/library-search-box/narrow-folded-390.png",
    });
    await userEvent.keyboard("/");
    expect(document.activeElement, said("390 /")).toBe(input());
  });

  it("at 390: focused, it opens over the tabs, and the one button switches the layout", async () => {
    await bootOnce();
    await page.viewport(390, 640);
    await hold("inv", true);
    rowHolds("390 focused");
    const f = rect(field());
    const t = toggleBox();
    expect(
      Math.abs(f.left - rect(tabsRow()).left),
      said("390 focused"),
    ).toBeLessThanOrEqual(0.5);
    expect(f.right, said("390 focused")).toBeLessThanOrEqual(t.left);
    expect(t.left - f.right, said("390 focused")).toBeLessThanOrEqual(8.5);
    await queryShown("390 focused");
    await page.screenshot({
      path: "__screenshots__/library-search-box/narrow-focused-390.png",
    });
    // The one button is the layout not shown: Grid, then List.
    expect(
      toggles().map((b) => b.dataset.layout),
      said("390 focused"),
    ).toEqual(["grid"]);
    expect(hits(node('[data-layout="grid"]')), said("390 focused")).toBe(true);
    await userEvent.click(node('[data-layout="grid"]'));
    await vi.waitFor(() => {
      if (document.querySelector("article[data-video]") === null) {
        throw new Error("no cards yet");
      }
    });
    expect(
      toggles().map((b) => b.dataset.layout),
      said("390 grid"),
    ).toEqual(["list"]);
    await userEvent.click(node('[data-layout="list"]'));
    await vi.waitFor(() => {
      if (flows().length !== 2) throw new Error("no list yet");
    });
    expect(
      toggles().map((b) => b.dataset.layout),
      said("390 list"),
    ).toEqual(["grid"]);
  });

  // Red: the 560 rule alone at 390, a held query squeezed between the
  // tabs and the toggle with no room to show it.
  it("at 390: holding a query, it stays open over the tabs until cleared", async () => {
    await bootOnce();
    await page.viewport(390, 640);
    await hold("invite", false);
    rowHolds("390 held");
    const f = rect(field());
    const t = toggleBox();
    expect(
      Math.abs(f.left - rect(tabsRow()).left),
      said("390 held"),
    ).toBeLessThanOrEqual(0.5);
    expect(f.right, said("390 held")).toBeLessThanOrEqual(t.left);
    for (const p of pills()) {
      const r = rect(p);
      const hit = document.elementFromPoint(
        r.left + r.width / 2,
        r.top + r.height / 2,
      );
      expect(
        hit !== null && field().contains(hit),
        `${said("390 held")}: over ${p.textContent}`,
      ).toBe(true);
    }
    await queryShown("390 held");
    await page.screenshot({
      path: "__screenshots__/library-search-box/narrow-held-390.png",
    });
    await hold("", false);
    await folded("390 cleared");
    await page.viewport(1440, 900);
  });

  // Red: the held box left open over the tabs while one of them holds the
  // keys, its ring and its tab painted under the box.
  it("at 390: holding a query, Shift+Tab to a tab steps the box aside, the tab's ring painted", async () => {
    await bootOnce();
    await page.viewport(390, 640);
    await hold("invite", true);
    await userEvent.keyboard("{Shift>}{Tab}{/Shift}");
    const tab = document.activeElement as HTMLElement;
    // Premise: the keys are on a tab, the query still held in the box.
    expect(tab.closest(".place-tabs"), said("390 shift-tab")).not.toBeNull();
    expect(tab.matches(":focus-visible"), said("390 shift-tab")).toBe(true);
    expect(input().value, said("390 shift-tab")).toBe("invite");
    expect(hits(tab), `${said("390 shift-tab")}: the tab on top`).toBe(true);
    await folded("390 shift-tab");
    const ink = parse(getComputedStyle(tab).outlineColor);
    const t = rect(tab);
    const paint = await paintOf();
    const sides = [
      [t.left - 3, t.top + t.height / 2],
      [t.right + 3, t.top + t.height / 2],
      [t.left + t.width / 2, t.top - 3],
      [t.left + t.width / 2, t.bottom + 3],
    ].map(([x, y]) => paint(x as number, y as number));
    expect(
      sides.map((p) =>
        [0, 1, 2].every((i) => Math.abs((p[i] ?? 0) - (ink[i] ?? 0)) <= 24),
      ),
      `${said("390 shift-tab")}: the ring ${JSON.stringify(sides)} vs ${ink}`,
    ).toEqual([true, true, true, true]);
    await page.screenshot({
      path: "__screenshots__/library-search-box/narrow-tab-focused-390.png",
    });
    // Tab goes back into the box, which opens again with its query.
    await userEvent.keyboard("{Tab}");
    expect(document.activeElement, said("390 tab back")).toBe(input());
    await queryShown("390 tab back");
  });

  // Red: no hand-off in view.ts's update, so the pressed button, hidden
  // now, drops the focus to the body.
  for (const key of ["Enter", "Space"]) {
    it(`at 390: ${key} on the one layout button switches it and keeps the focus on the one shown`, async () => {
      await bootOnce();
      await page.viewport(390, 640);
      await hold("", false);
      const press = key === "Space" ? " " : "{Enter}";
      for (const [from, to] of [
        ["grid", "list"],
        ["list", "grid"],
      ] as const) {
        const button = node(`[data-layout="${from}"]`);
        // Premise: it is the one shown.
        expect(toggles(), said(`390 ${key} ${from}`)).toEqual([button]);
        button.focus();
        await userEvent.keyboard(press);
        await vi.waitFor(() => {
          const drawn =
            from === "grid"
              ? document.querySelector("article[data-video]")
              : document.querySelector("[data-list]");
          if (drawn === null) throw new Error(`no ${from} yet`);
        });
        expect(
          document.activeElement,
          `${said(`390 ${key} ${from}`)}: focus on ${document.activeElement?.outerHTML.slice(0, 60)}`,
        ).toBe(node(`[data-layout="${to}"]`));
        expect(toggles(), said(`390 ${key} ${from}`)).toEqual([
          document.activeElement,
        ]);
      }
    });
  }

  // Red: the open box's right hard-coded to the toggle's width, short of
  // the row's end when there is no toggle.
  it("with no toggle the open box runs to the row's end, at 560 and 390", async () => {
    await bootOnce();
    for (const [w, q, focused] of [
      [560, "inv", true],
      [390, "inv", true],
      [390, "invite", false],
    ] as const) {
      const at = `${w} no toggle ${q} ${focused}`;
      await page.viewport(w, 640);
      await hold(q, focused);
      // The view hides it where the page has no layouts to switch; set
      // here, as the next render would leave it (none comes before the
      // reads below).
      node("[data-layout-toggle]").hidden = true;
      expect(node("[data-layout-toggle]").checkVisibility(), at).toBe(false);
      const f = rect(field());
      const r = rect(tabsRow());
      expect(Math.abs(f.left - r.left), said(at)).toBeLessThanOrEqual(0.5);
      expect(Math.abs(f.right - r.right), said(at)).toBeLessThanOrEqual(0.5);
      await queryShown(at);
      node("[data-layout-toggle]").hidden = false;
    }
    await hold("", false);
    await page.viewport(1440, 900);
  });
});

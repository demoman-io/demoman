import type { SceneDocument } from "@demoman/scene-schema";
import type { VideoSummary } from "@demoman/studio-protocol";
import { page, userEvent } from "@vitest/browser/context";
import { afterAll, describe, expect, it, vi } from "vitest";
import studioCss from "../../../pages/assets/studio.css?raw";
import shell from "../../../pages/entrypoints/library/index.html?raw";
import {
  createMemoryPlatform,
  type MemoryPlatform,
} from "../helpers/memory-platform";
import { mountShell, node, pageParts } from "../helpers/shell-css";

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
  video("billing", "Update billing", ["click Save"]),
  video("onboard", "Team onboarding", ["click Invite member"]),
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
      if (document.querySelectorAll("[data-list] [data-flow]").length !== 3) {
        throw new Error("three flows not drawn yet");
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
    expect(
      paintedWhole(why("onboard", "name")),
      why("onboard", "name").textContent ?? "",
    ).toEqual({ shown: true, whole: true });
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
    expect(flows()).toHaveLength(3);
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
    expect(why.textContent).toBe("step: click Invite member");
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

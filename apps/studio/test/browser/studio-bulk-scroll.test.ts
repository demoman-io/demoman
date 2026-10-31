// apps/studio/test/browser/studio-bulk-scroll.test.ts
//
// Ticking flows far down the library must not move the page (the author,
// 2026-10-30: "selecting more would make it jump up to where the first
// ones I selected were"). The real server and the built pages, a library
// tall enough to scroll, ticks made at its foot.
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createLibrary, createVideoStore } from "@demoman/runner/studio";
import type { Page } from "playwright";
import { afterEach, describe, expect, it } from "vitest";
import type { PlainTake } from "./painted-take.js";
import { api, type Studio, sizeWindow, startStudio } from "./studio-harness.js";
import { seedHome } from "./studio-pages.js";

const LANE_MS = 120_000;
/** The shots lane's folder (studio-shots.test.ts), where the author looks. */
const SHOTS = fileURLToPath(
  new URL("./__screenshots__/studio/", import.meta.url),
);
// Flows over several days and two past months, like a library in use: the
// jump needs a page several screens tall with many sections above the ticks.
const OLD: PlainTake[] = Array.from({ length: 30 }, (_, i) => {
  const at = new Date();
  at.setDate(at.getDate() - (i < 10 ? 2 + (i % 5) : 40 + i * 2));
  at.setHours(11, i, 0, 0);
  return {
    id: `old-${i}`,
    name: `Old flow ${i}`,
    createdAt: at.toISOString(),
    ground: ["#fee2e2", "#e0e7ff", "#ccfbf1", "#fde68a"][i % 4] as string,
  };
});

/** Each of `takes` a flow of its own. */
async function flowsOf(home: string, takes: PlainTake[]): Promise<void> {
  const library = createLibrary(home);
  const store = createVideoStore(home, library);
  for (const t of takes) {
    const made = await store.create({
      name: t.name,
      repo: { key: "github.com/acme/web" },
      startPage: "https://app.example.com/",
    });
    if (!made.ok) throw new Error(`${t.name} could not be made a flow`);
    await library.putJson(t.id, "status.json", { outcome: "complete" });
    const read = await library.getSceneRead(t.id);
    if (read === null) throw new Error(`${t.id} was not seeded`);
    await store.join(t.id, {
      videoId: made.video.id,
      made: {
        repo: { none: "seeded" },
        agent: { none: "seeded" },
        by: { none: "seeded" },
        door: "mcp",
      },
      recordedRevision: read.revision,
    });
  }
}

const homes: string[] = [];
let running: Studio | null = null;
afterEach(async () => {
  await running?.stop();
  running = null;
  for (const h of homes.splice(0))
    await rm(h, { recursive: true, force: true });
});

describe("ticking flows at the foot of the library", () => {
  it.runIf(process.platform === "darwin")(
    "leaves the page where it was",
    async () => {
      const home = await mkdtemp(join(tmpdir(), "studio-bulk-scroll-"));
      homes.push(home);
      await seedHome(home, OLD);
      await flowsOf(home, OLD);
      const studio = await startStudio(home, join(home, "out"));
      running = studio;
      const opened = await api(studio, "/api/window", {
        method: "POST",
        body: {},
      });
      expect(opened.status, opened.text).toBe(200);
      const context = studio.context();
      const page = context.pages()[0] as Page;
      await sizeWindow(context, page, 1280, 720);
      await page.goto(`${studio.origin}/`);
      await page.waitForFunction(
        (n) => document.querySelectorAll("[data-select]").length >= n,
        OLD.length,
        { timeout: 10_000 },
      );
      // The old month starts folded; the author opened it to reach them.
      await page.evaluate(() => {
        for (const d of document.querySelectorAll("details.section")) {
          (d as HTMLDetailsElement).open = true;
        }
      });
      if (process.env.CSS_PROBE) {
        await page.evaluate((css) => {
          const sheet = new CSSStyleSheet();
          sheet.replaceSync(css);
          document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
        }, process.env.CSS_PROBE);
      }
      if (process.env.STOP_HANDLER) {
        await page.evaluate(() =>
          document.addEventListener(
            "click",
            (e) => {
              if ((e.target as Element).matches("[data-select]"))
                e.stopImmediatePropagation();
            },
            true,
          ),
        );
      }
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      const boxes = OLD.map((t) => `article[data-row="${t.id}"] [data-select]`);
      /** Where `sel`'s card sits in the window, and how far down the page is. */
      const where = (sel: string) =>
        page.evaluate((s) => {
          const card = document.querySelector(s)?.closest("article");
          return {
            top: Math.round(card?.getBoundingClientRect().top ?? Number.NaN),
            y: Math.round(window.scrollY),
          };
        }, sel);
      const trail: {
        tick: string;
        before: { top: number; y: number };
        after: { top: number; y: number };
      }[] = [];
      for (const sel of boxes.slice(-4)) {
        await page.locator(sel).scrollIntoViewIfNeeded();
        const before = await where(sel);
        await page.locator(sel).click();
        await page
          .waitForFunction(
            (s) =>
              (document.querySelector(s) as HTMLInputElement | null)
                ?.checked === true,
            sel,
            { timeout: 5_000 },
          )
          .catch(async () => {
            throw new Error(
              `${sel} never ticked: ${JSON.stringify({ trail, now: await where(sel) })}`,
            );
          });
        // Two frames: the jump this guards against landed in the frame
        // after the click's handler.
        await page.evaluate(
          () =>
            new Promise((r) =>
              requestAnimationFrame(() => requestAnimationFrame(r)),
            ),
        );
        trail.push({ tick: sel, before, after: await where(sel) });
      }
      // Premise: the page scrolls, and the ticks were made far down it.
      expect(trail[0]?.before.y ?? 0, JSON.stringify(trail)).toBeGreaterThan(
        1000,
      );
      // Every tick leaves the card just ticked where it was in the window.
      // (The first raises the bar over the list, above the window, and the
      // browser keeps what is on screen in place.)
      for (const t of trail) {
        expect(t.after.top, JSON.stringify(trail)).toBe(t.before.top);
      }
      // Cancel, in the bar held over the list, puts the ticks away with
      // the last card where it was.
      const last = boxes.at(-1) as string;
      const beforeCancel = await where(last);
      await page.locator('[data-action="cancel-selection"]').click();
      await page.waitForFunction(
        () => document.querySelector("[data-selection-bar]") === null,
      );
      expect(await where(last), "Cancel").toMatchObject({
        top: beforeCancel.top,
      });
      // A clean bulk delete says so in a toast, painted at the foot of the
      // window, and the toast goes by itself; the notice line stays empty.
      await page.locator(boxes.at(-1) as string).click();
      await page.locator('[data-action="delete-selected"]').click();
      await page.locator("[data-confirm-go]").click();
      const toast = page.locator("[data-toast]");
      await toast.waitFor({ timeout: 5_000 });
      expect(await toast.locator("[data-toast-text]").textContent()).toBe(
        "Deleted 1 flow",
      );
      // Measured at rest: it slides in from 12px to the right.
      await page.waitForFunction(() =>
        document.getAnimations().every((a) => a.playState !== "running"),
      );
      const painted = await page.evaluate(() => {
        const t = document.querySelector("[data-toast]") as HTMLElement;
        const r = t.getBoundingClientRect();
        const hit = document.elementFromPoint(
          r.left + r.width / 2,
          r.top + r.height / 2,
        );
        return {
          // Top right, clear of the 56px header.
          topRight:
            Math.abs(innerWidth - r.right - 16) <= 1 &&
            r.top >= 56 &&
            r.top < 100,
          checkTinted:
            getComputedStyle(t.querySelector("svg") as Element).color !==
            getComputedStyle(t).color,
          inWindow: r.top >= 0 && r.bottom <= innerHeight && r.width > 0,
          onTop: hit !== null && t.contains(hit),
          notice: !document
            .querySelector("#notice")
            ?.classList.contains("hidden"),
        };
      });
      const geo = await page.evaluate(() => {
        const r = (
          document.querySelector("[data-toast]") as HTMLElement
        ).getBoundingClientRect();
        return {
          right: r.right,
          top: r.top,
          innerWidth,
          client: document.documentElement.clientWidth,
        };
      });
      expect(painted, JSON.stringify(geo)).toEqual({
        topRight: true,
        checkTinted: true,
        inWindow: true,
        onTop: true,
        notice: false,
      });
      await mkdir(SHOTS, { recursive: true });
      await page.screenshot({
        path: join(SHOTS, "library-toast-1280x720-dark.png"),
      });
      await toast.waitFor({ state: "detached", timeout: 8_000 });
    },
    LANE_MS,
  );
});

import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { kitNamed, lookForRun } from "@demoman/run-core";
import { readKits, readLogo } from "@demoman/runner/studio";
import type { WindowAnswer } from "@demoman/studio-protocol";
import type { Page } from "playwright";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  api,
  PAGES,
  pageEvidence,
  type Studio,
  sizeWindow,
  startStudio,
  watchConsole,
} from "./studio-harness.js";

// A kit made with the studio's Brand kit page, in a real window, is the kit
// an agent's `look.kit` gets: the page is reached through the top bar's tab
// (`nav.kits`), the kit is made with the page's own controls, and then
// `readKits` and `lookForRun` (what `executor.ts` runs for a script's
// `look.kit`) are asked about it. A kit written into `kits.json` by hand then
// reaches the open page through the `kits` feed, without a reload.
//
// Measured locally (2026-10-17, M-series Mac, headless, six runs): the
// whole case 1.2-1.7 s, of which the studio's start and window are
// 0.37-0.45 s, each kit edit is on disk by the first 50 ms poll, and the
// hand-written kit's tile appears 0.28-0.79 s after the write (the feed's
// 250 ms settle, then a re-read; the slower runs are macOS delivering the
// fs event late). x5 for CI is 8.5 s; the lane's 60 s leaves room for a
// cold Chromium start.
const LANE_MS = 60_000;
/** One kit edit, a control's commit to the file holding it: inside the
 *  first 50 ms poll here, so x5 with a great deal of room. */
const EDIT_MS = 10_000;
/** The hand-written kit's tile: 0.28-0.79 s here (above). x5 is 4 s; the
 *  room on top is for a loaded runner's fs events. */
const FEED_MS = 15_000;

const LOGO = fileURLToPath(
  new URL("../../../runner/test/fixtures/frame.jpg", import.meta.url),
);
const BACKGROUND = { kind: "solid", color: "#1f6feb" } as const;
const HAND = {
  id: "kit-hand",
  name: "Hand",
  branding: {
    background: { kind: "solid", color: "#22aa55" },
    logo: null,
    padding: 0.08,
  },
};

/** How long each `waitForKit` waited, for the lane's closing line. */
const editMs: number[] = [];

let running: Studio | null = null;
const homes: string[] = [];

afterEach(async () => {
  const studio = running;
  running = null;
  try {
    if (studio !== null) await studio.stop();
  } finally {
    for (const home of homes.splice(0)) {
      await rm(home, { recursive: true, force: true });
    }
  }
});

/** The kit list as the page shows it: each tile's name, and the field. */
async function kitPage(page: Page): Promise<string> {
  const tiles = await page
    .locator("[data-kit-tile] .kit-tile-name")
    .allInnerTexts()
    .catch((e: unknown) => [`(unreadable: ${String(e)})`]);
  const name = await page
    .locator("[data-kit-name]")
    .inputValue({ timeout: 500 })
    .catch(() => null);
  return JSON.stringify({ url: page.url(), tiles, name }).concat(
    ` ${await pageEvidence(page)}`,
  );
}

/** Waits for `kits.json` to hold what `ok` asks of the "Launch" kit (or of
 *  the first kit, before it is named), saying what it held if it never does. */
async function waitForKit(
  home: string,
  page: Page,
  what: string,
  ok: (kit: ReturnType<typeof kitNamed>) => boolean,
  name = "Launch",
): Promise<void> {
  const from = Date.now();
  await vi.waitFor(
    async () => {
      const read = await readKits(home);
      const kit = kitNamed(read, name);
      if (!ok(kit)) {
        throw new Error(
          `${what}: kits.json reads ${JSON.stringify(read)}; page: ${await kitPage(page)}`,
        );
      }
    },
    { timeout: EDIT_MS, interval: 50 },
  );
  editMs.push(Date.now() - from);
}

/** Selects everything in a focused field and types `text`, then Enter. */
async function retype(page: Page, selector: string, text: string) {
  await page.locator(selector).focus();
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.type(text);
  await page.keyboard.press("Enter");
}

describe("the Studio's Brand kit page, in a real window", () => {
  it(
    "makes a kit an agent's look.kit resolves, and shows a kit written by hand without a reload",
    async () => {
      const started = Date.now();
      const home = await mkdtemp(join(tmpdir(), "studio-kits-"));
      homes.push(home);
      expect(
        existsSync(join(PAGES, "settings.html")),
        `the Studio pages are built at ${PAGES} (run \`pnpm -r build\`)`,
      ).toBe(true);
      expect(
        existsSync(join(home, "kits.json")),
        "the premise: the home has no kits yet",
      ).toBe(false);

      const studio = await startStudio(home, join(home, "out"));
      running = studio;
      const opened = await api(studio, "/api/window", {
        method: "POST",
        body: {},
      });
      expect(opened.status, `${opened.text}\n${studio.logs.join("\n")}`).toBe(
        200,
      );
      expect((opened.json() as WindowAnswer).path).toBe("/");
      const context = studio.context();
      const page = context.pages()[0] as Page;
      const console_ = watchConsole(page);
      await sizeWindow(context, page, 1440, 900);
      const windowed = Date.now();

      // 1. The Brand kit page, through the top bar's tab: the link is the
      // platform's `nav.kits`, so a wrong one opens some other page.
      await page.locator('a[data-tab="settings"]').click();
      try {
        await page.waitForURL(`${studio.origin}/settings.html`, {
          timeout: EDIT_MS,
        });
      } catch {
        throw new Error(
          `the Settings tab did not open /settings.html: the window is at ${page.url()}`,
        );
      }
      await page.locator("[data-kit-new]").waitFor({ timeout: EDIT_MS });
      expect(
        await page.locator("[data-kit-tile]").count(),
        "the premise: the page lists no kit",
      ).toBe(0);

      // 2. New kit, renamed "Launch" with the keyboard.
      await page.locator("[data-kit-new]").click();
      await waitForKit(
        home,
        page,
        "New kit saved an Untitled kit",
        (k) => k !== null,
        "Untitled kit",
      );
      await expect
        .poll(() => page.locator("[data-kit-name]").inputValue(), {
          timeout: EDIT_MS,
        })
        .toBe("Untitled kit");
      await retype(page, "[data-kit-name]", "Launch");
      await waitForKit(home, page, "the rename saved", (k) => k !== null);

      // The background, through its own control: Solid, then the colour
      // typed into its box. A new kit starts on the default wallpaper, shown
      // as its pressed tile with no colour fields, so both steps change
      // what is stored.
      const before = kitNamed(await readKits(home), "Launch");
      expect(
        before?.read.state === "ready" && before.read.kit.background.kind,
        `the premise: a new kit is the default wallpaper (${JSON.stringify(before)})`,
      ).toBe("wallpaper");
      const colourFields = page.locator(
        '[data-group="background"] [data-colour-text]',
      );
      await expect
        .poll(
          () =>
            page
              .locator(
                '[data-group="background"] [data-wallpaper-id="vivid-1"]',
              )
              .getAttribute("aria-pressed"),
          {
            timeout: EDIT_MS,
            message:
              "the premise: the page shows the default wallpaper pressed",
          },
        )
        .toBe("true");
      expect(
        await colourFields.count(),
        "the premise: a wallpaper shows no colour fields",
      ).toBe(0);
      await page
        .locator('[data-group="background"] [data-bg-kind="solid"]')
        .click();
      await waitForKit(
        home,
        page,
        "Solid saved",
        (k) =>
          k?.read.state === "ready" && k.read.kit.background.kind === "solid",
      );
      // The file is written before the page re-reads it and redraws, so
      // the page may still show the wallpaper's grid; type into the solid's
      // one field only once it is drawn.
      await expect
        .poll(() => colourFields.count(), {
          timeout: EDIT_MS,
          message: "the page shows the solid's one colour field",
        })
        .toBe(1);
      await retype(
        page,
        '[data-group="background"] [data-colour-text]',
        BACKGROUND.color,
      );
      await waitForKit(
        home,
        page,
        "the colour saved",
        (k) =>
          k?.read.state === "ready" &&
          JSON.stringify(k.read.kit.background) === JSON.stringify(BACKGROUND),
      );

      // The logo, through the file input. A JPEG is taken, with its note.
      await page
        .locator('[data-group="logo"] input[type="file"]')
        .setInputFiles(LOGO);

      // 3. The page shows the logo: its thumb holds a decoded picture.
      const thumb = page.locator('[data-logo-thumb="ready"] img');
      try {
        await thumb.waitFor({ timeout: EDIT_MS });
        await expect
          .poll(
            () =>
              thumb.evaluate((img) => (img as HTMLImageElement).naturalWidth),
            { timeout: EDIT_MS },
          )
          .toBeGreaterThan(0);
      } catch (error) {
        throw new Error(
          `no logo thumb: ${String(error)}; page: ${await kitPage(page)}; console: ${console_.lines.join("\n")}`,
        );
      }
      expect(
        await page.locator("[data-logo-notes]").innerText(),
        "the JPEG's note",
      ).toContain("JPEG has no transparency");

      // 4. The kit as `readKits` reads it: named, with the background set.
      const read = await readKits(home);
      const kit = kitNamed(read, "Launch");
      if (kit === null || kit.read.state !== "ready") {
        throw new Error(`no ready "Launch" kit: ${JSON.stringify(read)}`);
      }
      expect(kit.read.kit.background).toEqual(BACKGROUND);

      // 5. Its logo, under the home's assets, read as an export reads it.
      const logo = kit.read.kit.logo;
      if (logo === null) throw new Error(`no logo: ${JSON.stringify(kit)}`);
      expect(logo.ref.startsWith("assets/"), logo.ref).toBe(true);
      const loaded = await readLogo(home, logo.ref);
      if (!loaded.ok) throw new Error(`readLogo: ${loaded.error}`);
      expect(loaded.contentType).toBe("image/jpeg");
      expect(Buffer.from(loaded.bytes).equals(await readFile(LOGO))).toBe(true);

      // 6. What an agent's `look.kit: "Launch"` resolves to.
      const look = lookForRun(
        { look: { kit: "Launch" } },
        await readKits(home),
      );
      if (!look.ok) throw new Error(`lookForRun: ${JSON.stringify(look)}`);
      expect(look.look).toEqual({
        branding: "kit",
        kit: { name: "Launch" },
        brandKitError: null,
      });
      expect(look.startingBranding.background).toEqual(BACKGROUND);
      expect(look.startingBranding.logo?.ref).toBe(logo.ref);

      // 7. A kit written into kits.json by hand reaches the open page: its
      // tile appears, and the page was not reloaded (the mark set on this
      // document is still there).
      await page.evaluate(() => {
        (window as unknown as { __sameDocument: boolean }).__sameDocument =
          true;
      });
      const file = JSON.parse(
        await readFile(join(home, "kits.json"), "utf8"),
      ) as { kits: unknown[]; default: string | null };
      expect(file.kits, "the premise: one kit on disk").toHaveLength(1);
      const written = Date.now();
      await writeFile(
        join(home, "kits.json"),
        `${JSON.stringify({ ...file, kits: [...file.kits, HAND] }, null, 2)}\n`,
      );
      const handTile = page.locator("[data-kit-tile] .kit-tile-name", {
        hasText: /^Hand$/,
      });
      try {
        await handTile.waitFor({ timeout: FEED_MS });
      } catch {
        throw new Error(
          `the hand-written kit's tile did not appear within ${FEED_MS / 1000} s: ${await kitPage(page)}; studio log: ${studio.logs.join("\n")}`,
        );
      }
      const feedMs = Date.now() - written;
      expect(
        await page.evaluate(
          () =>
            (window as unknown as { __sameDocument?: boolean })
              .__sameDocument === true,
        ),
        "the tile came without a reload",
      ).toBe(true);
      expect(
        await page.locator("[data-kit-tile] .kit-tile-name").allInnerTexts(),
      ).toEqual(["Launch", "Hand"]);

      expect(console_.faults(), console_.lines.join("\n")).toEqual([]);
      running = null;
      expect(await studio.stop(), studio.logs.join("\n")).toBe(0);
      console.info(
        `studio kits lane: window ${windowed - started} ms, edits ${editMs.join("/")} ms, hand kit's tile ${feedMs} ms after the write, total ${Date.now() - started} ms`,
      );
    },
    LANE_MS,
  );
});

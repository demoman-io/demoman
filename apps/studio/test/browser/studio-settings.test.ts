import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { WindowAnswer } from "@demoman/studio-protocol";
import type { Page } from "playwright";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  api,
  pageEvidence,
  type Studio,
  sizeWindow,
  startStudio,
  watchConsole,
} from "./studio-harness.js";

// The Pull requests setting on the studio's Settings page, in a real window:
// a `segmented` radiogroup of Off, Ask and Attach. With nothing saved Off is
// checked; choosing Attach PUTs `attach` into `<home>/settings.json` beside
// the keys already there; an unreadable file is said, with nothing checked
// (Off is never painted over a file nobody could read).
//
// Measured locally (2026-10-18, M-series Mac, headless): the whole file runs
// in about 3 s, a choice is on disk by the first 50 ms poll. x5 for CI is
// 15 s; the lane's 60 s leaves room for a cold Chromium start.
const LANE_MS = 60_000;
const EDIT_MS = 10_000;

const SHOTS = fileURLToPath(
  new URL("./__screenshots__/studio/", import.meta.url),
);

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

async function openSettings(home: string): Promise<{
  studio: Studio;
  page: Page;
  console_: ReturnType<typeof watchConsole>;
}> {
  const studio = await startStudio(home, join(home, "out"));
  running = studio;
  const opened = await api(studio, "/api/window", {
    method: "POST",
    body: {},
  });
  expect(opened.status, `${opened.text}\n${studio.logs.join("\n")}`).toBe(200);
  expect((opened.json() as WindowAnswer).path).toBe("/");
  const context = studio.context();
  const page = context.pages()[0] as Page;
  const console_ = watchConsole(page);
  await sizeWindow(context, page, 1280, 900);
  await page.locator('a[data-tab="settings"]').click();
  await page.waitForURL(`${studio.origin}/settings.html`, {
    timeout: EDIT_MS,
  });
  await page.locator("[data-kit-new]").waitFor({ timeout: EDIT_MS });
  return { studio, page, console_ };
}

/** The group's segments as the page shows them: label and checked state. */
async function segments(
  page: Page,
  group = "Pull requests",
): Promise<Array<{ label: string; checked: string | null }>> {
  return page
    .locator(`[role="radiogroup"][aria-label="${group}"] [role="radio"]`)
    .evaluateAll((nodes) =>
      nodes.map((n) => ({
        label: (n.textContent ?? "").trim(),
        checked: n.getAttribute("aria-checked"),
      })),
    );
}

describe("the Studio's Pull requests setting, in a real window", () => {
  it(
    "offers Off, Ask and Attach, checks Ask with nothing set, and saves Attach",
    async () => {
      const home = await mkdtemp(join(tmpdir(), "studio-settings-"));
      homes.push(home);
      // The premise: a file with other keys, none of them pullRequests, so
      // the save has something to keep and "nothing set" is not "no file".
      await writeFile(
        join(home, "settings.json"),
        `${JSON.stringify({ theme: "light", exportQuality: "full" })}\n`,
      );
      const { page, console_ } = await openSettings(home);

      await page
        .locator('[role="radiogroup"][aria-label="Pull requests"]')
        .waitFor({ timeout: EDIT_MS });
      const first = await segments(page);
      expect(first, await pageEvidence(page)).toEqual([
        { label: "Off", checked: "false" },
        { label: "Ask", checked: "true" },
        { label: "Attach", checked: "false" },
      ]);

      await page
        .locator('[aria-label="Pull requests"] [role="radio"]', {
          hasText: "Attach",
        })
        .click();
      await vi.waitFor(
        async () => {
          const saved = JSON.parse(
            await readFile(join(home, "settings.json"), "utf8"),
          ) as Record<string, unknown>;
          if (saved.pullRequests !== "attach") {
            throw new Error(
              `settings.json holds ${JSON.stringify(saved)}; page: ${await pageEvidence(page)}`,
            );
          }
          expect(saved).toEqual({
            theme: "light",
            exportQuality: "full",
            pullRequests: "attach",
          });
        },
        { timeout: EDIT_MS, interval: 50 },
      );
      await vi.waitFor(
        async () => {
          const now = await segments(page);
          if (now.find((s) => s.checked === "true")?.label !== "Attach") {
            throw new Error(`the page shows ${JSON.stringify(now)}`);
          }
        },
        { timeout: EDIT_MS, interval: 50 },
      );
      expect(console_.faults(), console_.lines.join("\n")).toEqual([]);
    },
    LANE_MS,
  );

  it(
    "says why it cannot read the file and checks nothing, then shoots the section below full screen in dark",
    async () => {
      const home = await mkdtemp(join(tmpdir(), "studio-settings-bad-"));
      homes.push(home);
      await writeFile(join(home, "settings.json"), "{");
      const { page } = await openSettings(home);
      const group = page.locator(
        '[role="radiogroup"][aria-label="Pull requests"]',
      );
      await group.waitFor({ timeout: EDIT_MS });
      const shown = await segments(page);
      expect(shown.map((s) => s.label)).toEqual(["Off", "Ask", "Attach"]);
      expect(
        shown.filter((s) => s.checked === "true"),
        `an unreadable file must check nothing: ${JSON.stringify(shown)}`,
      ).toEqual([]);
      const notice = await page
        .locator('[data-section="pullRequests"] [data-notice]')
        .innerText({ timeout: EDIT_MS });
      expect(notice).toContain("settings.json is not valid JSON");
      // The same file costs Export quality its choice too, with its own say.
      const exported = await segments(page, "Export quality");
      expect(exported.map((e) => e.label)).toEqual(["Sharing", "Full"]);
      expect(
        exported.filter((e) => e.checked === "true"),
        `an unreadable file must check nothing: ${JSON.stringify(exported)}`,
      ).toEqual([]);
      expect(
        await page
          .locator('[data-section="export"] [data-notice]')
          .innerText({ timeout: EDIT_MS }),
      ).toContain("settings.json is not valid JSON");

      // Below full screen, in the studio's one theme (dark, by build).
      await mkdir(SHOTS, { recursive: true });
      await vi.waitFor(
        async () => {
          const theme = await page.evaluate(
            () => document.documentElement.dataset.theme ?? null,
          );
          if (theme !== "dark") throw new Error(`theme is ${theme}`);
        },
        { timeout: EDIT_MS, interval: 50 },
      );
      // Choose a value, which replaces the unreadable file, so the shot
      // shows a checked segment rather than the notice.
      await page
        .locator('[aria-label="Pull requests"] [role="radio"]', {
          hasText: "Ask",
        })
        .click();
      await vi.waitFor(
        async () => {
          const now = await segments(page);
          if (now.find((s) => s.checked === "true")?.label !== "Ask") {
            throw new Error(`the page shows ${JSON.stringify(now)}`);
          }
        },
        { timeout: EDIT_MS, interval: 50 },
      );
      await page
        .locator('[aria-label="Export quality"] [role="radio"]', {
          hasText: "Full",
        })
        .click();
      await vi.waitFor(
        async () => {
          const now = await segments(page, "Export quality");
          if (now.find((s) => s.checked === "true")?.label !== "Full") {
            throw new Error(`the page shows ${JSON.stringify(now)}`);
          }
        },
        { timeout: EDIT_MS, interval: 50 },
      );
      const section = page.locator('[data-section="pullRequests"]');
      const paint = () =>
        section.evaluate((node) => {
          const bg = (sel: string) => {
            const e = node.querySelector<HTMLElement>(sel);
            return e === null ? null : getComputedStyle(e).backgroundColor;
          };
          return {
            checkedBg: bg('[role="radio"][aria-checked="true"]'),
            uncheckedBg: bg('[role="radio"][aria-checked="false"]'),
            innerHeight,
          };
        });
      // The segments transition their colour: wait for the settled paint,
      // then assert on it (a rect would not say the checked one is lit).
      let painted = await paint();
      await vi.waitFor(
        async () => {
          painted = await paint();
          if (painted.checkedBg === painted.uncheckedBg) {
            throw new Error(
              `the checked segment is painted as the others: ${JSON.stringify(painted)}`,
            );
          }
        },
        { timeout: EDIT_MS, interval: 100 },
      );
      // The Export quality group is painted like its neighbour, not left as
      // bare buttons: a shell.css rule scoped to `.pull-requests` alone once
      // left it so, under green assertions on its labels and checked state.
      const exportPaint = await page
        .locator('[data-section="export"]')
        .evaluate((node) => {
          const bg = (sel: string) => {
            const e = node.querySelector<HTMLElement>(sel);
            return e === null ? null : getComputedStyle(e).backgroundColor;
          };
          const group = node.querySelector<HTMLElement>(".segmented");
          return {
            checkedBg: bg('[role="radio"][aria-checked="true"]'),
            uncheckedBg: bg('[role="radio"][aria-checked="false"]'),
            groupRadius:
              group === null ? null : getComputedStyle(group).borderRadius,
          };
        });
      expect(
        exportPaint.checkedBg,
        `the checked Export segment is painted as the other: ${JSON.stringify(exportPaint)}`,
      ).not.toBe(exportPaint.uncheckedBg);
      expect(
        exportPaint.groupRadius,
        `the Export group has the segmented ring: ${JSON.stringify(exportPaint)}`,
      ).not.toBe("0px");
      expect(painted.innerHeight).toBeLessThanOrEqual(900);
      await page.screenshot({
        path: join(SHOTS, "settings-pull-requests-1280x900-dark.png"),
      });
      await section.screenshot({
        path: join(SHOTS, "settings-pull-requests-section-dark.png"),
      });
    },
    LANE_MS,
  );
});

describe("the Studio's Export quality setting, in a real window", () => {
  it(
    "offers Sharing and Full, checks Sharing with nothing set, and saves Full",
    async () => {
      const home = await mkdtemp(join(tmpdir(), "studio-export-quality-"));
      homes.push(home);
      // The premise: a file with other keys and no exportQuality, so the
      // save has something to keep and "nothing set" is not "no file".
      await writeFile(
        join(home, "settings.json"),
        `${JSON.stringify({ theme: "light", pullRequests: "ask" })}\n`,
      );
      const { page, console_ } = await openSettings(home);
      const group = page.locator(
        '[role="radiogroup"][aria-label="Export quality"]',
      );
      await group.waitFor({ timeout: EDIT_MS });
      expect(
        await segments(page, "Export quality"),
        await pageEvidence(page),
      ).toEqual([
        { label: "Sharing", checked: "true" },
        { label: "Full", checked: "false" },
      ]);

      await group.locator('[role="radio"]', { hasText: "Full" }).click();
      await vi.waitFor(
        async () => {
          const saved = JSON.parse(
            await readFile(join(home, "settings.json"), "utf8"),
          ) as Record<string, unknown>;
          if (saved.exportQuality !== "full") {
            throw new Error(
              `settings.json holds ${JSON.stringify(saved)}; page: ${await pageEvidence(page)}`,
            );
          }
          expect(saved).toEqual({
            theme: "light",
            pullRequests: "ask",
            exportQuality: "full",
          });
        },
        { timeout: EDIT_MS, interval: 50 },
      );
      await vi.waitFor(
        async () => {
          const now = await segments(page, "Export quality");
          if (now.find((s) => s.checked === "true")?.label !== "Full") {
            throw new Error(`the page shows ${JSON.stringify(now)}`);
          }
        },
        { timeout: EDIT_MS, interval: 50 },
      );
      expect(console_.faults(), console_.lines.join("\n")).toEqual([]);
    },
    LANE_MS,
  );

  it(
    "says a replaced file as a warning after the write",
    async () => {
      const home = await mkdtemp(join(tmpdir(), "studio-export-quality-bad-"));
      homes.push(home);
      await writeFile(join(home, "settings.json"), "{");
      const { page } = await openSettings(home);
      await page
        .locator('[aria-label="Export quality"] [role="radio"]', {
          hasText: "Full",
        })
        .click();
      await vi.waitFor(
        async () => {
          const text = await page.locator("body").innerText();
          if (!text.includes("other settings were not kept")) {
            throw new Error(`no warning yet: ${await pageEvidence(page)}`);
          }
        },
        { timeout: EDIT_MS, interval: 50 },
      );
      expect(
        JSON.parse(await readFile(join(home, "settings.json"), "utf8")),
      ).toEqual({ exportQuality: "full" });
    },
    LANE_MS,
  );
});

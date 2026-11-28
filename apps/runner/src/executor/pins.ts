// apps/runner/src/executor/pins.ts
//
// What a run's page sees of the machine, pinned so one script records the
// same video on the Mac and in CI (author's ruling 2026-11-28): the time zone
// and locale of the machine that first recorded the flow, carried by its take
// and kept file; hidden scrollbars; and a seeded `Math.random`.
// `crypto.getRandomValues` is left alone: apps make ids with it.
//
// shortcut: the pins reach the stage's own target, so a frame of another
// origin (its own process) and a worker keep the machine's time zone, locale
// and an unseeded Math.random; pin them per target if an app shows it.

import type { CdpSession } from "@demoman/replay-engine";
import { messageOf, type RunRegion } from "@demoman/run-core";

/** A time zone and locale as a take records them (`meta.capture`). */
export interface Region {
  timeZone: string;
  locale: string;
}

/** Whose time zone and locale a run pins its page to, decided at the door
 *  (`flowRegionOf`): the flow's recorded ones, this machine's (a flow with
 *  none recorded yet), or none (a flow recorded before the pins). */
export type RegionPlan =
  | { pin: Region }
  | { pin: "thisMachine"; why?: string }
  | { pin: "none"; why: string };

/** Said of a flow whose video was recorded before the pins. */
export const NOT_PINNED_WHY =
  "the flow's video was recorded before Demoman pinned the time zone and locale, so it records in this machine's, as it always has";

/** What `Math.random` starts from in every document. */
export const RANDOM_SEED = 0x64656d6f;

/**
 * The script, installed on the stage before its first navigation, that
 * replaces `Math.random` with a seeded generator (mulberry32). The seed is
 * mixed with the document's address and its place in the tab's history, so
 * two documents of one take do not deal the same numbers (an id one made in
 * `localStorage` is not made again by the next), while the same script deals
 * the same ones on every run.
 *
 * shortcut: a reload of the same address deals the same numbers again, and an
 * id the app stored on its server is dealt again on the next run; seed per
 * load if an app shows it.
 */
export function seededRandomSource(seed: number = RANDOM_SEED): string {
  if (!Number.isInteger(seed))
    throw new Error(`seed ${seed} is not an integer`);
  return `(() => {
  if (Math.random.__demomanSeeded) return;
  const key = location.href + " " + history.length;
  let a = ${seed >>> 0};
  for (let i = 0; i < key.length; i++) a = Math.imul(a ^ key.charCodeAt(i), 16777619) >>> 0;
  function random() {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  Object.defineProperty(random, "__demomanSeeded", { value: true });
  Object.defineProperty(Math, "random", { value: random, writable: true, configurable: true });
})();`;
}

/** The script that answers `navigator.language(s)` with the pinned locale:
 *  `Emulation.setLocaleOverride` moves `Intl` and `toLocaleString` but not
 *  these (measured on Chromium 151, 2026-11-28). */
export function languageSource(locale: string): string {
  const said = JSON.stringify(locale);
  return `(() => {
  const languages = Object.freeze([${said}]);
  Object.defineProperty(Navigator.prototype, "language", { get: () => ${said}, configurable: true });
  Object.defineProperty(Navigator.prototype, "languages", { get: () => languages, configurable: true });
})();`;
}

/** This machine's time zone and locale, as the stage's page sees them before
 *  any pin: what a take recorded before the pins saw too. */
async function machineRegion(cdp: CdpSession): Promise<Region> {
  const out = (await cdp.send("Runtime.evaluate", {
    expression:
      "({ timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone, locale: navigator.language })",
    returnByValue: true,
  })) as { result?: { value?: { timeZone?: unknown; locale?: unknown } } };
  const { timeZone, locale } = out.result?.value ?? {};
  if (typeof timeZone !== "string" || timeZone === "")
    throw new Error(
      `the page named no time zone (${JSON.stringify(timeZone)})`,
    );
  if (typeof locale !== "string" || locale === "")
    throw new Error(`the page named no locale (${JSON.stringify(locale)})`);
  return { timeZone, locale };
}

/**
 * Pins the stage's page before its first navigation: scrollbars hidden and
 * `Math.random` seeded on every run, and the time zone and locale `plan`
 * names (`Intl`, `Date`'s strings, `navigator.language` and the
 * `Accept-Language` every request sends). A pin Chrome refuses stops the
 * run, in words: a video recorded unpinned would be compared with pinned
 * ones and read as changed.
 */
export async function pinStage(
  cdp: CdpSession,
  plan: RegionPlan,
): Promise<{ ok: true; region: RunRegion } | { ok: false; detail: string }> {
  let region: RunRegion;
  if (typeof plan.pin === "object") {
    // The flow's own: this machine's are not asked, so a page that cannot
    // say them does not stop a run that never needed them.
    region = { ...plan.pin, from: "flow" };
  } else {
    let machine: Region;
    try {
      machine = await machineRegion(cdp);
    } catch (error) {
      return {
        ok: false,
        detail: `the page's time zone and locale could not be read (${messageOf(error)})`,
      };
    }
    region =
      plan.pin === "none"
        ? { ...machine, from: "notPinned", why: plan.why }
        : {
            ...machine,
            from: "thisMachine",
            ...(plan.why === undefined ? {} : { why: plan.why }),
          };
  }
  const steps: [string, string, Record<string, unknown>][] = [
    // A script for new documents runs only on a session with Page enabled
    // (measured on Chromium 151); the walk enables it too.
    ["its page events could not be enabled", "Page.enable", {}],
    // Headless hides them already (Playwright launches it with
    // --hide-scrollbars); said here so a visible window hides them too and
    // the decision is Demoman's own.
    [
      "its scrollbars could not be hidden",
      "Emulation.setScrollbarsHidden",
      { hidden: true },
    ],
    [
      "Math.random could not be seeded",
      "Page.addScriptToEvaluateOnNewDocument",
      { source: seededRandomSource() },
    ],
  ];
  if (region.from !== "notPinned") {
    const pinned = `it could not be pinned to the time zone ${region.timeZone} and the locale ${region.locale}`;
    steps.push(
      [
        pinned,
        "Emulation.setTimezoneOverride",
        { timezoneId: region.timeZone },
      ],
      [pinned, "Emulation.setLocaleOverride", { locale: region.locale }],
      [
        pinned,
        "Page.addScriptToEvaluateOnNewDocument",
        { source: languageSource(region.locale) },
      ],
      [pinned, "Network.enable", {}],
      [
        pinned,
        "Network.setExtraHTTPHeaders",
        { headers: { "Accept-Language": region.locale } },
      ],
    );
  }
  for (const [what, method, params] of steps) {
    try {
      await cdp.send(method, params);
    } catch (error) {
      return {
        ok: false,
        detail: `the page could not be prepared: ${what} (${method}: ${messageOf(error)})`,
      };
    }
  }
  return { ok: true, region };
}

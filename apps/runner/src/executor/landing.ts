// Whether a page a run or snapshot landed on is a sign-in page (launch C,
// spec 2026-10-15 §3.3). The facts are read off the page; the verdict is
// pure, so every rule is a unit test.
import { seenNow } from "@demoman/replay-engine/page";
import { landedElsewhere } from "@demoman/run-core";
import type { Page } from "playwright";
import { withinDeadline } from "../page-deadline.js";
import { type SessionFile, samePage, siteOf } from "./sessions.js";

/** How long a read waits for the page to stop loading first. */
export const SETTLE_MS = 5000;

/**
 * Waits, bounded, for the page to go quiet before it is read: an app that
 * sends a signed-out browser to its sign-in page from script does so after
 * `load`, and a read straight after `load` would see the page it left
 * (final review 4). A page that never goes quiet (a poll, a stream) is read
 * as it is — that is expected, not a fault, and costs at most SETTLE_MS. A
 * page that closed meanwhile is not forgiven here: the read that follows
 * throws, and its caller says so.
 */
export async function settle(page: Page): Promise<void> {
  try {
    await page.waitForLoadState("networkidle", { timeout: SETTLE_MS });
  } catch {
    // Said by the read that follows when it is a fault (above).
  }
}

export const DEFAULT_SIGNIN_COMMAND = "npx --prefix ~/ demoman signin";

export interface LandingFacts {
  askedUrl: string;
  landedUrl: string;
  passwordFieldVisible: boolean;
}

export type LandingVerdict =
  | {
      kind: "go";
      site: string | null;
      saved: boolean;
      startedElsewhere: boolean;
    }
  | { kind: "signedOut"; site: string | null; detail: string };

/** What the page shows. Throws when it cannot be read: the caller says so,
 *  never answers "no password field" in place of "could not look". */
export async function readLandingFacts(
  page: Page,
  askedUrl: string,
): Promise<LandingFacts> {
  // The URL is read in the same evaluate as the field, so both describe one
  // document: `page.url()` after it could already name the next page.
  const { landedUrl, passwordFieldVisible } = await withinDeadline(
    // A string, not a function: `seenNow` is sent as source (it is
    // self-contained for that), and a string runs where a page's CSP would
    // refuse an `eval` of it.
    page.evaluate<{
      landedUrl: string;
      passwordFieldVisible: boolean;
    }>(`(() => {
      const seenNow = ${seenNow.toString()};
      return {
        landedUrl: location.href,
        passwordFieldVisible: [
          ...document.querySelectorAll('input[type="password" i]'),
        ].some((el) => {
          if (!seenNow(el)) return false;
          const r = el.getBoundingClientRect();
          return (
            r.bottom > 0 &&
            r.right > 0 &&
            r.top < innerHeight &&
            r.left < innerWidth
          );
        }),
      };
    })()`),
    "checking the page for a sign-in form",
  );
  return { askedUrl, landedUrl, passwordFieldVisible };
}

const where = (raw: string): { host: string; path: string } => {
  try {
    const u = new URL(raw);
    return { host: u.host, path: u.pathname };
  } catch {
    // An unparseable landed URL still gets a sentence: its raw text is the host.
    return { host: raw, path: "/" };
  }
};

/** Quoted only when a shell would read it as more than one word or a glob. */
const forShell = (url: string): string =>
  /^[A-Za-z0-9:/._~%-]*$/.test(url) ? url : `'${url.replaceAll("'", "'\\''")}'`;

/** The file a landing belongs to: one whose recorded sign-in page this is
 *  (any site: an identity provider's page lives on another site than the
 *  app) — the asked site's own first, since several apps can share one
 *  provider's page — else the file for the landed page's own site. */
export function fileForLanding(
  facts: LandingFacts,
  files: readonly SessionFile[],
): SessionFile | undefined {
  const recorded = files.filter(
    (f) => f.signInUrl !== null && samePage(facts.landedUrl, f.signInUrl),
  );
  const asked = siteOf(facts.askedUrl);
  const own = recorded.find((f) => f.site === asked) ?? recorded[0];
  if (own !== undefined) return own;
  const site = siteOf(facts.landedUrl);
  return site === null ? undefined : files.find((f) => f.site === site);
}

/** Whether `file` speaks for this landing's site: the site asked for or the
 *  one landed on. A file reached only through a shared sign-in page belongs
 *  to another app, and says nothing about whether this one was signed in. */
export function fileIsForLanding(
  facts: LandingFacts,
  file: SessionFile,
): boolean {
  return (
    file.site === siteOf(facts.askedUrl) ||
    file.site === siteOf(facts.landedUrl)
  );
}

/**
 * Signed out when the app sent the browser somewhere other than where it was
 * asked (a page asked for directly is never a sign-in wall) AND that
 * somewhere is the site's recorded sign-in page, or shows a visible password
 * field. The second rule is what catches a site never signed in, and a
 * second local app on another port.
 *
 * One page asked for directly is a sign-in wall: the start page of a session
 * whose sign-in form was shown in place (`signInUrl` null), when it shows a
 * password field again. `signin` checked that page showed none once signed
 * in, so the form means that session no longer signs it in.
 */
export function landingVerdict(
  facts: LandingFacts,
  files: readonly SessionFile[],
  signinCommand: string,
): LandingVerdict {
  const site = siteOf(facts.landedUrl);
  const file = fileForLanding(facts, files);
  const elsewhere = landedElsewhere(facts.askedUrl, facts.landedUrl);
  const onRecorded =
    file?.signInUrl != null && samePage(facts.landedUrl, file.signInUrl);
  const formInPlace =
    !elsewhere &&
    facts.passwordFieldVisible &&
    file !== undefined &&
    file.signInUrl === null &&
    fileIsForLanding(facts, file) &&
    samePage(facts.landedUrl, file.startUrl);
  if (formInPlace) {
    const { host, path } = where(facts.landedUrl);
    return {
      kind: "signedOut",
      site,
      detail: `${host} shows its sign-in form at ${path}: the session saved ${file.savedAt.slice(0, 10)} for ${file.site} has expired. Run \`${signinCommand} ${forShell(facts.askedUrl)}\`, then run again.`,
    };
  }
  if (elsewhere && (onRecorded || facts.passwordFieldVisible)) {
    const { host, path } = where(facts.landedUrl);
    const run = `Run \`${signinCommand} ${forShell(facts.askedUrl)}\`, then run again.`;
    const saved = file?.savedAt.slice(0, 10);
    // A file reached only through a sign-in page another app shares (one
    // identity provider) is not this site's session: the site has none.
    const unsaved = file === undefined || !fileIsForLanding(facts, file);
    const detail = unsaved
      ? `${host} sent this browser to ${path}, a sign-in page, and no session was ever saved for ${siteOf(facts.askedUrl) ?? site ?? host}. ${run}`
      : onRecorded
        ? `${host} sent this browser to ${path}, its sign-in page: the session saved ${saved} for ${file.site} has expired. ${run}`
        : `${host} sent this browser to ${path}, a sign-in page, and the session saved ${saved} for ${file.site} (at ${file.startUrl}) does not sign it in. ${run}`;
    return { kind: "signedOut", site, detail };
  }
  return {
    kind: "go",
    site,
    saved: file !== undefined && fileIsForLanding(facts, file),
    startedElsewhere: elsewhere,
  };
}

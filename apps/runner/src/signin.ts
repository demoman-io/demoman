// apps/runner/src/signin.ts
//
// `demoman signin <url>` (launch C, spec 2026-10-15 §3.2): the author signs
// in to their own app in a real window; Demoman saves the session, never the
// password, and checks it before saying so.
import { stat } from "node:fs/promises";
import { isHttpUrl, landedElsewhere, messageOf } from "@demoman/run-core";
import type { BrowserContext } from "playwright";
import { signInAccount } from "./executor/account-signin.js";
import { findAccounts } from "./executor/accounts.js";
import { classifyLaunchError } from "./executor/browser.js";
import {
  landingVerdict,
  readLandingFacts,
  settle,
} from "./executor/landing.js";
import { createSecretSweep } from "./executor/secrets-env.js";
import {
  createSessionStore,
  filesFor,
  mergeStates,
  type SessionFile,
  samePage,
  siteOf,
  sliceForSite,
} from "./executor/sessions.js";
import { type Launched, launch } from "./launch.js";

export interface SigninDeps {
  home: string;
  out(line: string): void;
  /** Resolves when the author presses Enter. */
  enter(): { done: Promise<void>; cancel(): void };
  /** Tests only: the author's window is always visible. */
  headless?: boolean;
  executablePath?: string;
  installCommand?: string;
  launchFn?: typeof launch;
  now?: () => Date;
}

type StateArg = Parameters<BrowserContext["setStorageState"]>[0];

/** One line a terminal prints as text: accounts.json and the page reach
 *  these lines, and a control character in them could erase a line, forge a
 *  success or plant a link (audit run 1). The rule export/report.ts's
 *  `quoted` applies to a page's names. */
const printable = (line: string): string =>
  line.replace(/[\p{Cc}\p{Cf}]+/gu, " ");

export async function signin(url: string, deps: SigninDeps): Promise<number> {
  const out = (line: string) => deps.out(printable(line));
  const say = (line: string) => out(`demoman signin: ${line}`);
  if (!isHttpUrl(url)) {
    say(`${url} is not an http(s) URL`);
    return 2;
  }
  const site = siteOf(url);
  if (site === null) {
    say(`${url} names no site`);
    return 2;
  }
  const store = createSessionStore(deps.home);
  let saved: SessionFile[];
  try {
    saved = (await store.read()).files;
  } catch (error) {
    say(messageOf(error));
    return 1;
  }
  const launchFn = deps.launchFn ?? launch;
  const exe =
    deps.executablePath === undefined
      ? {}
      : { executablePath: deps.executablePath };
  const start = async (headless: boolean): Promise<Launched | null> => {
    try {
      return await launchFn({ headless, ...exe });
    } catch (error) {
      const failed = classifyLaunchError(error);
      say(
        failed.reason === "browserMissing" && deps.installCommand !== undefined
          ? `Demoman's browser is not installed — run \`${deps.installCommand}\` once, then run this again`
          : failed.detail,
      );
      return null;
    }
  };

  const window = await start(deps.headless ?? false);
  if (window === null) return 1;
  let file: SessionFile;
  let path: string;
  // The URL given was itself the sign-in form: it showed a password field
  // where it was asked for, with no redirect. Verified by that field going
  // away, since there is no other page to recognise (final review 3).
  let inPlace = false;
  try {
    try {
      await window.context.setStorageState(
        mergeStates(filesFor(saved, null)) as StateArg,
      );
    } catch (error) {
      // Signing in again is the repair for a saved state that cannot load,
      // so carry on with an empty context, and say so.
      say(
        `the sessions already saved in ${store.dir} could not be loaded (${messageOf(error)}); signing in from a fresh browser instead`,
      );
    }
    try {
      await window.page.goto(url, { waitUntil: "load" });
    } catch (error) {
      say(
        window.page.isClosed() || !window.browser.isConnected()
          ? `the window was closed before ${url} finished loading`
          : `${url} did not load (${messageOf(error)}) — check that the app is running at that address`,
      );
      return 1;
    }
    let facts: Awaited<ReturnType<typeof readLandingFacts>> | null = null;
    try {
      await settle(window.page);
      facts = await readLandingFacts(window.page, url);
    } catch (error) {
      out(
        `the page could not be checked for a sign-in form (${messageOf(error)}); sign in in the window if you need to, then press Enter here (or close the window).`,
      );
    }
    // Manual sessions only: an account's file for this site carries its own
    // sign-in page, which is not this session's.
    const existing = filesFor(saved, null).find((f) => f.site === site);
    let signInUrl: string | null;
    if (facts === null) {
      signInUrl = existing?.signInUrl ?? null;
    } else if (
      landedElsewhere(url, facts.landedUrl) ||
      facts.passwordFieldVisible
    ) {
      inPlace = !landedElsewhere(url, facts.landedUrl);
      // Origin and path only: a sign-in redirect's query can carry an
      // identity provider's state, nonce or login hint. None for a form
      // shown in place: recording the page asked for as the sign-in page
      // would call that page signed out however the sign-in went.
      const landed = new URL(facts.landedUrl);
      signInUrl = inPlace ? null : `${landed.origin}${landed.pathname}`;
      out(
        `Sign in to ${site} in the window that opened, then press Enter here (or close the window).`,
      );
    } else {
      signInUrl = existing?.signInUrl ?? null;
      out(
        `${url} opened with no sign-in page, so this browser may already be signed in to ${site}. Sign in again in the window if you need to, then press Enter here (or close the window).`,
      );
    }
    const closed = new Promise<void>((resolve) => {
      window.page.once("close", () => resolve());
      window.browser.once("disconnected", () => resolve());
      if (window.page.isClosed() || !window.browser.isConnected()) resolve();
    });
    const enter = deps.enter();
    await Promise.race([enter.done, closed]);
    enter.cancel();
    let state: Awaited<ReturnType<BrowserContext["storageState"]>>;
    try {
      state = await window.context.storageState({ indexedDB: true });
    } catch (error) {
      say(
        `the session could not be read from the browser (${messageOf(error)}) — run this again, and press Enter here instead of quitting the browser`,
      );
      return 1;
    }
    file = {
      sessionVersion: 1,
      site,
      savedAt: (deps.now?.() ?? new Date()).toISOString(),
      refreshedAt: null,
      startUrl: url,
      signInUrl,
      state: sliceForSite(state, site),
    };
    try {
      path = await store.save(file);
    } catch (error) {
      say(messageOf(error));
      return 1;
    }
  } finally {
    await window.close();
  }

  // Checked before success is said: a sign-in that saved a signed-out state
  // must not read as one that worked.
  const check = await start(true);
  if (check === null) {
    say(`saved ${path}, but a browser to check it would not start`);
    return 1;
  }
  try {
    await check.context.setStorageState(file.state as StateArg);
    await check.page.goto(url, { waitUntil: "load" });
    await settle(check.page);
    const facts = await readLandingFacts(check.page, url);
    const onSignIn =
      file.signInUrl !== null && samePage(facts.landedUrl, file.signInUrl);
    const stillInPlace =
      inPlace &&
      !landedElsewhere(url, facts.landedUrl) &&
      facts.passwordFieldVisible;
    if (
      onSignIn ||
      stillInPlace ||
      landingVerdict(facts, [file], "").kind === "signedOut"
    ) {
      say(
        `saved, but ${url} still lands on ${facts.landedUrl}: not signed in${
          stillInPlace
            ? " — give signin a page behind the login (the app's home, say), not the sign-in page itself"
            : ""
        }`,
      );
      return 1;
    }
    out(`Signed in to ${site}; saved ${path}`);
    return 0;
  } catch (error) {
    say(
      `saved ${path}, but checking it failed (${messageOf(error)}), so it may not be signed in`,
    );
    return 1;
  } finally {
    await check.close();
  }
}

export interface SigninAccountDeps {
  home: string;
  projectDir: string;
  /** Only needed when two sites in the file have an account of that name. */
  site?: string;
  env: NodeJS.ProcessEnv;
  out(line: string): void;
  executablePath?: string;
  installCommand?: string;
}

const originOf = (site: string): string => {
  try {
    return new URL(site).origin;
  } catch {
    return site;
  }
};

/**
 * `demoman signin --account <name>` (launch C2 §4.4): sign in as a repo demo
 * account in a hidden browser, always fresh (it is a check, not a cache), and
 * say where the session was saved. 0 signed in, 1 the sign-in failed, 2 the
 * request names nothing the repo holds.
 */
export async function signinAccount(
  name: string,
  deps: SigninAccountDeps,
): Promise<number> {
  const out = (line: string) => deps.out(printable(line));
  const say = (line: string) => out(`demoman signin: ${line}`);
  // A --project that is not a folder is refused, never walked past to a
  // parent's accounts file (final review M7).
  const isFolder = await stat(deps.projectDir).then(
    (s) => s.isDirectory(),
    () => false,
  );
  if (!isFolder) {
    say(
      `--project ${deps.projectDir} is not a folder: give the repo folder that holds .demoman/accounts.json`,
    );
    return 2;
  }
  const found = await findAccounts(deps.projectDir);
  if (found.kind === "none") {
    say(`no .demoman/accounts.json found from ${found.searchedFrom}`);
    return 2;
  }
  if (found.kind === "invalid") {
    say(found.detail);
    return 2;
  }
  const { file } = found;
  const wanted = deps.site === undefined ? null : originOf(deps.site);
  const holders = [...file.sites.values()].filter(
    (s) => (wanted === null || s.origin === wanted) && s.accounts.has(name),
  );
  if (holders.length === 0) {
    const have = [...file.sites.values()]
      .map((s) => `${s.origin}: ${[...s.accounts.keys()].join(", ")}`)
      .join("; ");
    say(
      `no site in ${file.path} has an account "${name}"${
        wanted === null ? "" : ` at ${wanted}`
      }; it has ${have}`,
    );
    return 2;
  }
  const [site, ...others] = holders;
  if (site === undefined || others.length > 0) {
    say(
      `"${name}" is an account on ${holders.map((s) => s.origin).join(", ")}; add --site <origin>`,
    );
    return 2;
  }
  const account = site.accounts.get(name);
  if (account === undefined) {
    say(`no site in ${file.path} has an account "${name}"`);
    return 2;
  }
  const result = await signInAccount(
    { file, site, account },
    {
      store: createSessionStore(deps.home),
      env: deps.env,
      sweep: createSecretSweep(),
      log: (l) => say(l),
      ...(deps.executablePath === undefined
        ? {}
        : { executablePath: deps.executablePath }),
      ...(deps.installCommand === undefined
        ? {}
        : { installCommand: deps.installCommand }),
    },
  );
  if (!result.ok) {
    say(result.detail);
    return 1;
  }
  out(`Signed in to ${site.origin} as ${name}; saved ${result.path}`);
  return 0;
}

// apps/runner/src/executor/account-signin.ts
//
// Signing in as one of the repo's demo accounts (launch C2 §4): the steps
// from `.demoman/accounts.json`, run unfilmed in a hidden browser through
// the run's own target resolution, proven at `checkUrl` with C's landing
// check, then saved per origin and account. The filming window never sees
// a password typed.
import { mkdir, open, rm, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { landedElsewhere } from "@demoman/run-core";
import type { Page } from "playwright";
import { EXECUTOR_ENTRY_GLOBAL, SIGN_IN_MARK } from "../entry-globals.js";
import { launch } from "../launch.js";
import { installResolver } from "../page-agent.js";
import { messageOf } from "../report.js";
import type {
  Account,
  AccountsFile,
  AccountsSite,
  SignInStep,
} from "./accounts.js";
import { accountDefinition } from "./accounts.js";
import { classifyLaunchError } from "./browser.js";
import { landingVerdict, readLandingFacts, settle } from "./landing.js";
import { installExecutorEntry } from "./page-ops.js";
import {
  readSecretsFile,
  resolveSecrets,
  SecretError,
  type SecretSweep,
} from "./secrets-env.js";
import {
  SessionError,
  type SessionFile,
  type SessionStore,
  samePage,
  sliceForSite,
} from "./sessions.js";

export const SIGN_IN_DEADLINE_MS = 60_000;
export const LOCK_STALE_MS = 120_000;
const POLL_MS = 200;
const LOCK_POLL_MS = 250;
/** How long one step waits for its element: a field that never appears
 *  fails its step in seconds, not at the whole sign-in's bound. */
export const STEP_WAIT_MS = 10_000;

/** The main frame's navigations since the step that sets the sign-in going:
 *  requests started, documents loaded, requests failed. */
interface Nav {
  documents: number;
  loaded: number;
  failed: number;
}

export type AccountSignInFailure = {
  ok: false;
  reason:
    | "signInFailed"
    | "secretMissing"
    | "secretTooShort"
    | "secretUnbound"
    | "secretOffOrigin"
    | "secretsFileNotIgnored"
    | "secretsFileInvalid"
    | "browserMissing";
  detail: string;
};
export type AccountSignIn =
  | {
      ok: true;
      file: SessionFile;
      path: string;
      steps: number;
      ms: number;
      reused: boolean;
    }
  | AccountSignInFailure;

export interface AccountSignInDeps {
  store: SessionStore;
  env: NodeJS.ProcessEnv;
  /** Why the environment's secrets are not used for this account (see
   *  `resolveSecrets`); absent, they are. */
  envWithheld?: string;
  sweep: SecretSweep;
  log: (line: string) => void;
  executablePath?: string;
  installCommand?: string;
  now?: () => Date;
  deadlineMs?: number;
  /** A session saved at or after this instant (another caller's sign-in,
   *  while this one waited for the lock) is used instead of signing in. */
  reuseSavedSince?: Date;
  /** Tests only: sees the sign-in's page before its first step, so a case
   *  can slow its renderer the way CI's machine does. */
  onSignInPage?: (page: Page) => Promise<void>;
}

/** A step as a sentence: a secret by its name, never by its value. */
export function describeStep(step: SignInStep): string {
  switch (step.do) {
    case "goto":
      return `goto ${step.url}`;
    case "click":
      return `click ${JSON.stringify(step.on)}`;
    case "type":
      return `type ${step.text} into ${JSON.stringify(step.into)}`;
    case "waitFor":
      return `waitFor ${step.until} ${JSON.stringify(step.on)}`;
    case "waitForLoad":
      return "waitForLoad";
    case "pause":
      return `pause ${step.ms} ms`;
  }
}

class StepFailed extends Error {
  constructor(
    readonly reason: "signInFailed" | "secretOffOrigin",
    message: string,
  ) {
    super(message);
  }
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Marked = { found: boolean; visible?: boolean; why?: string };

/** Asks the page entry to mark `target`, until it is there (and visible,
 *  unless `hidden` is wanted) or `until` passes. */
async function mark(
  page: Page,
  target: unknown,
  id: string,
  want: "visible" | "hidden",
  until: number,
): Promise<void> {
  let last = "not tried";
  while (Date.now() < until) {
    const answer: Marked = await page
      .evaluate(
        ([global, t, m]) => {
          const e = (globalThis as Record<string, unknown>)[global as string] as
            | { markHere(t: unknown, m: string): Promise<Marked> }
            | undefined;
          return e === undefined
            ? { found: false, why: "the page has no Demoman entry" }
            : e.markHere(t, m as string);
        },
        [EXECUTOR_ENTRY_GLOBAL, target, id] as const,
      )
      .catch((error: unknown) => ({ found: false, why: messageOf(error) }));
    const shown = answer.found && answer.visible === true;
    if (want === "visible" ? shown : !shown) return;
    last = answer.found ? "found but not shown" : (answer.why ?? "not found");
    await wait(POLL_MS);
  }
  throw new StepFailed(
    "signInFailed",
    want === "visible"
      ? `its element never appeared (${last})`
      : "its element never went away",
  );
}

async function runSteps(
  page: Page,
  steps: SignInStep[],
  origin: string,
  resolve: (text: string) => string,
  until: number,
  nav: Nav,
): Promise<void> {
  // The step that sets the sign-in going: the last one that acts on the
  // page. Waits after it (a waitForLoad, a pause) must not discard the
  // navigation it started (review 2026-10-16).
  let lastAction = -1;
  for (const [i, s] of steps.entries()) {
    if (s.do === "goto" || s.do === "click" || s.do === "type") lastAction = i;
  }
  for (const [i, step] of steps.entries()) {
    const at = `step ${i + 1} (${describeStep(step)})`;
    const left = () => Math.max(1, until - Date.now());
    // Counted from here, so a page that moved on earlier steps (a two-page
    // sign-in) does not stand in for the navigation the last step sets going.
    if (i === lastAction) {
      nav.documents = 0;
      nav.loaded = 0;
      nav.failed = 0;
    }
    const stepUntil = Math.min(until, Date.now() + STEP_WAIT_MS);
    try {
      switch (step.do) {
        case "goto":
          await page.goto(step.url, { waitUntil: "load", timeout: left() });
          break;
        case "waitForLoad":
          await page.waitForLoadState("load", { timeout: left() });
          break;
        case "pause":
          await wait(step.ms);
          break;
        case "waitFor":
          await mark(page, step.on, String(i), step.until, stepUntil);
          break;
        case "click":
          await mark(page, step.on, String(i), "visible", stepUntil);
          await page
            .locator(`[${SIGN_IN_MARK}="${i}"]`)
            .click({ timeout: left() });
          break;
        case "type": {
          await mark(page, step.into, String(i), "visible", stepUntil);
          // A handle, not the selector: the origin is read from the very
          // element that is filled, and a handle detaches on navigation, so
          // a page that moved in between fails the step instead of being
          // typed into.
          const handle = await page
            .locator(`[${SIGN_IN_MARK}="${i}"]`)
            .elementHandle({ timeout: left() });
          try {
            const here = await handle.evaluate(
              (e) => e.ownerDocument.location.origin,
            );
            if (here !== origin && /\{secret:/.test(step.text)) {
              throw new StepFailed(
                "secretOffOrigin",
                `the page is on ${here}, not ${origin}, so the secret was not typed — a sign-in never types a secret off its own site`,
              );
            }
            await handle.fill(resolve(step.text), { timeout: left() });
          } finally {
            await handle.dispose().catch(() => undefined);
          }
          break;
        }
      }
    } catch (error) {
      if (error instanceof StepFailed) {
        throw new StepFailed(error.reason, `${at}: ${error.message}`);
      }
      throw new StepFailed("signInFailed", `${at}: ${messageOf(error)}`);
    }
  }
}

/** Where in a storage state a known secret sits, named without the value;
 *  null when none does. */
function secretIn(
  state: SessionFile["state"],
  sweep: SecretSweep,
): string | null {
  const named = (text: string): string | null => {
    const clean = sweep.scrub(text);
    return clean === text
      ? null
      : (/\{secret:[A-Z0-9_]+\}/.exec(clean)?.[0] ?? null);
  };
  for (const c of state.cookies) {
    const n = named(c.value);
    if (n !== null) return `${n} in its cookie ${c.name}`;
  }
  for (const o of state.origins) {
    for (const item of o.localStorage) {
      const n = named(item.value);
      if (n !== null)
        return `${n} in its localStorage key ${item.name} (${o.origin})`;
    }
  }
  const whole = JSON.stringify(state);
  const n = named(whole);
  return n === null ? null : `${n} in its browser storage`;
}

const originAndPath = (raw: string): string => {
  const u = new URL(raw);
  return `${u.origin}${u.pathname}`;
};

export async function signInAccount(
  chosen: { file: AccountsFile; site: AccountsSite; account: Account },
  deps: AccountSignInDeps,
): Promise<AccountSignIn> {
  const { account, site } = chosen;
  const name = account.name;
  const origin = site.origin;
  const now = deps.now ?? (() => new Date());
  const fail = (
    reason: AccountSignInFailure["reason"],
    detail: string,
  ): AccountSignInFailure => ({
    ok: false,
    reason,
    detail: deps.sweep.scrub(detail),
  });

  // 1. Secrets first, before any browser opens or any lock is taken: a
  // missing or too-short secret, or a secrets file git would commit, is
  // named while nothing has been touched.
  const resolved = new Map<string, string>();
  try {
    const source = await readSecretsFile(chosen.file.dir);
    for (const step of account.signIn) {
      if (step.do !== "type") continue;
      const r = resolveSecrets(step.text, deps.env, source, {
        origin,
        ...(deps.envWithheld === undefined
          ? {}
          : { envWithheld: deps.envWithheld }),
      });
      for (const u of r.used) deps.sweep.add(u.name, u.value);
      resolved.set(step.text, r.text);
    }
  } catch (error) {
    if (error instanceof SecretError) {
      return fail(
        error.reason,
        `signing in as ${name} on ${origin}: ${error.message}`,
      );
    }
    return fail(
      "signInFailed",
      `signing in as ${name} on ${origin}: the secrets could not be read (${messageOf(error)})`,
    );
  }

  // 2. The lock: one sign-in per account at a time, across processes.
  const lock = `${deps.store.pathOfAccount(origin, name)}.lock`;
  try {
    await mkdir(dirname(lock), { recursive: true, mode: 0o700 });
  } catch (error) {
    return fail(
      "signInFailed",
      `signing in as ${name} on ${origin}: ${dirname(lock)} could not be created (${messageOf(error)})`,
    );
  }
  const waitedFrom = Date.now();
  for (;;) {
    try {
      await (await open(lock, "wx")).close();
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        return fail(
          "signInFailed",
          `signing in as ${name} on ${origin}: ${lock} could not be taken (${messageOf(error)})`,
        );
      }
    }
    try {
      if (Date.now() - (await stat(lock)).mtimeMs > LOCK_STALE_MS) {
        await rm(lock, { force: true });
        continue;
      }
    } catch (error) {
      // The holder released it between our open and our stat: try again.
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      return fail(
        "signInFailed",
        `signing in as ${name} on ${origin}: ${lock} could not be inspected (${messageOf(error)})`,
      );
    }
    if (Date.now() - waitedFrom > LOCK_STALE_MS) {
      return fail(
        "signInFailed",
        `another sign-in as ${name} has held ${lock} for over ${LOCK_STALE_MS / 1000} s — remove it if no other Demoman is running`,
      );
    }
    await wait(LOCK_POLL_MS);
  }
  try {
    // 3. Reuse: a session another caller saved while this one waited.
    if (deps.reuseSavedSince !== undefined) {
      try {
        const { files } = await deps.store.read();
        const saved = files.find(
          (f) =>
            f.account?.origin === origin &&
            f.account.name === name &&
            f.account.definition === accountDefinition(account) &&
            f.savedAt >= (deps.reuseSavedSince as Date).toISOString(),
        );
        if (saved !== undefined) {
          return {
            ok: true,
            file: saved,
            path: deps.store.pathOfAccount(origin, name),
            steps: 0,
            ms: 0,
            reused: true,
          };
        }
      } catch (error) {
        return fail(
          "signInFailed",
          `signing in as ${name} on ${origin}: the saved sessions could not be read (${messageOf(error)})`,
        );
      }
    }

    // 4. The hidden browser.
    const start = Date.now();
    let launched: Awaited<ReturnType<typeof launch>>;
    try {
      launched = await launch({
        headless: true,
        ...(deps.executablePath === undefined
          ? {}
          : { executablePath: deps.executablePath }),
      });
    } catch (error) {
      const c = classifyLaunchError(error);
      if (c.reason === "browserMissing") {
        return fail(
          "browserMissing",
          deps.installCommand === undefined
            ? c.detail
            : `Demoman's browser is not installed — run \`${deps.installCommand}\` once, then call this again`,
        );
      }
      return fail("signInFailed", c.detail);
    }
    try {
      await installResolver(launched.context);
      await installExecutorEntry(launched.context);
      const page = launched.page;
      await deps.onSignInPage?.(page);
      const deadline = start + (deps.deadlineMs ?? SIGN_IN_DEADLINE_MS);
      const left = () => Math.max(1, deadline - Date.now());
      /** Everything after the steps is bound by the same deadline. */
      const bounded = async <T>(work: Promise<T>, what: string): Promise<T> => {
        let timer: NodeJS.Timeout | undefined;
        const late = new Promise<never>((_, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new Error(
                  `the ${(deps.deadlineMs ?? SIGN_IN_DEADLINE_MS) / 1000} s sign-in bound passed while waiting for ${what}`,
                ),
              ),
            left(),
          );
        });
        try {
          return await Promise.race([work, late]);
        } finally {
          clearTimeout(timer);
        }
      };
      // 4b. Where checkUrl sends a browser signed in to nothing: that page
      // is the account's sign-in page, whatever the steps start from. A
      // dev route (`/dev/sign-in-as/…`) or a magic-link app shows no
      // password field there, so without it neither the proof below nor a
      // later run's landing check could tell signed out from signed in.
      let wall: string | null;
      try {
        await page.goto(account.checkUrl, {
          waitUntil: "load",
          timeout: left(),
        });
        await bounded(settle(page), `${account.checkUrl} to go quiet`);
        const out = await bounded(
          readLandingFacts(page, account.checkUrl),
          `${account.checkUrl} to be read`,
        );
        if (landedElsewhere(out.askedUrl, out.landedUrl)) {
          wall = originAndPath(out.landedUrl);
        } else if (out.passwordFieldVisible) {
          wall = null; // the form in place: C's in-place rule
        } else {
          return fail(
            "signInFailed",
            `${account.checkUrl} (checkUrl for ${name}) opens for a browser that is not signed in — no redirect to a sign-in page, no password field — so it cannot show whether the steps signed in. Set checkUrl to a page only a signed-in user can open`,
          );
        }
      } catch (error) {
        return fail(
          "signInFailed",
          `signing in as ${name} on ${origin}: ${account.checkUrl} (checkUrl) could not be opened signed out (${messageOf(error)})`,
        );
      }

      // New main-frame documents since the last step began (not same-
      // document changes such as replaceState, which are not a submit): a
      // form that submits from script after its click lands after the last
      // step returns.
      const nav: Nav = { documents: 0, loaded: 0, failed: 0 };
      const mainNavigation = (request: import("playwright").Request) =>
        request.isNavigationRequest() && request.frame() === page.mainFrame();
      page.on("request", (request) => {
        if (mainNavigation(request)) nav.documents += 1;
      });
      page.on("requestfailed", (request) => {
        if (mainNavigation(request)) nav.failed += 1;
      });
      page.on("load", () => {
        nav.loaded += 1;
      });

      // 5. The steps.
      try {
        await runSteps(
          page,
          account.signIn,
          origin,
          (t) => resolved.get(t) ?? t,
          deadline,
          nav,
        );
      } catch (error) {
        if (error instanceof StepFailed) {
          return fail(
            error.reason,
            `signing in as ${name} on ${origin} failed at ${error.message}`,
          );
        }
        return fail(
          "signInFailed",
          `signing in as ${name} on ${origin} failed (${messageOf(error)})`,
        );
      }

      // 6. Settle, then prove it at checkUrl.
      const candidate: SessionFile = {
        sessionVersion: 1,
        site: site.site,
        savedAt: now().toISOString(),
        refreshedAt: null,
        startUrl: account.checkUrl,
        signInUrl: wall,
        account: { origin, name, definition: accountDefinition(account) },
        state: { cookies: [], origins: [] },
      };
      try {
        // A page already quiet satisfies "network idle" at once, which would
        // cancel a form still about to submit; wait for the navigation the
        // last step set going, bounded, and say so when none comes.
        const navUntil = Math.min(deadline, Date.now() + STEP_WAIT_MS);
        while (nav.documents === 0 && Date.now() < navUntil) await wait(50);
        // Then for that navigation to land: a document loaded, or the
        // request failed. Until then the page is the OLD one, and "network
        // idle" — long true of it — answers at once, so checkUrl's goto
        // raced the form's own navigation and lost, "interrupted by another
        // navigation" (CI, 2026-10-17, on a renderer slower than this one).
        while (
          nav.documents > 0 &&
          nav.loaded === 0 &&
          nav.failed === 0 &&
          Date.now() < navUntil
        ) {
          await wait(50);
        }
        if (nav.documents > 0 && nav.loaded === 0 && nav.failed === 0) {
          deps.log(
            deps.sweep.scrub(
              `signing in as ${name}: the navigation the last step set going had not loaded a page within ${STEP_WAIT_MS / 1000} s; checking ${account.checkUrl} now`,
            ),
          );
        }
        if (nav.documents === 0) {
          deps.log(
            deps.sweep.scrub(
              `signing in as ${name}: no page navigation followed the last click, type or goto within ${STEP_WAIT_MS / 1000} s; checking ${account.checkUrl} now`,
            ),
          );
        }
        await bounded(settle(page), "the page to go quiet after the steps");
        await page.goto(account.checkUrl, {
          waitUntil: "load",
          timeout: left(),
        });
        await bounded(settle(page), `${account.checkUrl} to go quiet`);
        const facts = await bounded(
          readLandingFacts(page, account.checkUrl),
          `${account.checkUrl} to be read`,
        );
        const stillSignIn =
          candidate.signInUrl !== null &&
          samePage(facts.landedUrl, candidate.signInUrl);
        // No recorded wall: the form was shown in place signed out (final
        // review I1), so a password field now is still the sign-in form,
        // whatever the URL says.
        if (facts.passwordFieldVisible && wall === null) {
          return fail(
            "signInFailed",
            `the steps for ${name} ran, but ${account.checkUrl} (checkUrl) shows a password field at ${facts.landedUrl}: it is the sign-in form, so they did not sign in — check the account exists, its password, and that checkUrl is a page only a signed-in user can open`,
          );
        }
        if (
          stillSignIn ||
          landingVerdict(facts, [candidate], "").kind === "signedOut"
        ) {
          return fail(
            "signInFailed",
            `the steps for ${name} ran, but ${account.checkUrl} (checkUrl) still lands on ${facts.landedUrl}: they did not sign in — check the account exists, its password, and that the last step submits the form`,
          );
        }
        // Signed out, checkUrl redirected to `wall`; now it does not, so the
        // steps signed in and the field is the page's own (a change-password
        // page). It cannot tell signed in from signed out on a later run.
        if (facts.passwordFieldVisible) {
          return fail(
            "signInFailed",
            `the steps for ${name} signed in (${account.checkUrl} no longer sends this browser to ${wall}), but ${facts.landedUrl} shows a password field, so it cannot tell signed in from signed out later — set checkUrl to a page behind the login with no password field, not a change-password page`,
          );
        }
      } catch (error) {
        return fail(
          "signInFailed",
          `signing in as ${name} on ${origin}: ${account.checkUrl} (checkUrl) could not be checked (${messageOf(error)})`,
        );
      }

      // 7. Save.
      try {
        const state = sliceForSite(
          await bounded(
            launched.context.storageState({ indexedDB: true }),
            "the browser's storage to be read",
          ),
          site.site,
        );
        // A secret the app stored after signing in must not reach the file.
        const where = secretIn(state, deps.sweep);
        if (where !== null) {
          return fail(
            "signInFailed",
            `signing in as ${name} on ${origin}: the app stored ${where} after signing in, so the session was not saved — a saved session never holds a password`,
          );
        }
        // Stamped at the save, not when the steps ended: a caller that began
        // waiting on the lock while this one proved and saved compares its
        // start with this, and must reuse the session it waited for.
        const file: SessionFile = {
          ...candidate,
          savedAt: now().toISOString(),
          state,
        };
        const path = await deps.store.save(file);
        const ms = Date.now() - start;
        deps.log(
          deps.sweep.scrub(
            `signed in as ${name} on ${origin} (${account.signIn.length} steps, ${ms} ms)`,
          ),
        );
        return {
          ok: true,
          file,
          path,
          steps: account.signIn.length,
          ms,
          reused: false,
        };
      } catch (error) {
        return fail(
          "signInFailed",
          `signing in as ${name} on ${origin}: the session could not be saved (${error instanceof SessionError ? error.message : messageOf(error)})`,
        );
      }
    } finally {
      const closed = await launched.close().catch((error: unknown) => ({
        crashed: false,
        failed: messageOf(error),
      }));
      if ("failed" in closed) {
        deps.log(
          deps.sweep.scrub(
            `the hidden browser did not close cleanly (${closed.failed})`,
          ),
        );
      }
    }
  } finally {
    await rm(lock, { force: true });
  }
}

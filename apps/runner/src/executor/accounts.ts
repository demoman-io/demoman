// apps/runner/src/executor/accounts.ts
//
// `.demoman/accounts.json` (launch C2, spec 2026-10-15 §2): each origin's
// demo accounts and the steps that sign in as each. Committed in the app's
// repo, so a local run and a CI run read the same file. Secret VALUES are
// never here: `{secret:NAME}` names them (secrets-env.ts).
import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  ACCOUNT_NAME,
  ACCOUNT_NAME_RULE,
  type ScriptTarget,
  ScriptTargetSchema,
} from "@demoman/scene-schema";
import { z } from "zod";
import { messageOf } from "../report.js";
import { SECRET_ORIGIN_SUFFIX, SECRET_PREFIX } from "./secrets-env.js";
import { siteOf } from "./sessions.js";

export const ACCOUNTS_VERSION = 1;
export const ACCOUNTS_PATH = join(".demoman", "accounts.json");
const SECRET_REF = /\{secret:([^}]*)\}/g;
const SECRET_NAME = /^[A-Z0-9_]+$/;

const StepSchema = z.discriminatedUnion("do", [
  z.object({ do: z.literal("goto"), url: z.string().min(1) }).strict(),
  z.object({ do: z.literal("click"), on: ScriptTargetSchema }).strict(),
  z
    .object({
      do: z.literal("type"),
      into: ScriptTargetSchema,
      text: z.string(),
    })
    .strict(),
  z
    .object({
      do: z.literal("waitFor"),
      on: ScriptTargetSchema,
      until: z.enum(["visible", "hidden"]),
    })
    .strict(),
  z.object({ do: z.literal("waitForLoad") }).strict(),
  z
    .object({ do: z.literal("pause"), ms: z.number().positive().max(10_000) })
    .strict(),
]);
const AccountSchema = z
  .object({
    about: z.string().trim().min(1),
    checkUrl: z.string().min(1),
    signIn: z.array(StepSchema).min(1),
  })
  .strict();
const FileSchema = z
  .object({
    accountsVersion: z.number().int(),
    sites: z.record(
      z.string(),
      z
        .object({
          default: z.string().optional(),
          accounts: z.record(z.string().regex(ACCOUNT_NAME), AccountSchema),
        })
        .strict(),
    ),
  })
  .strict();

export type SignInStep =
  | { do: "goto"; url: string }
  | { do: "click"; on: ScriptTarget }
  | { do: "type"; into: ScriptTarget; text: string }
  | { do: "waitFor"; on: ScriptTarget; until: "visible" | "hidden" }
  | { do: "waitForLoad" }
  | { do: "pause"; ms: number };
export interface Account {
  name: string;
  about: string;
  checkUrl: string;
  signIn: SignInStep[];
}
/**
 * What an account signs in with — its checkUrl and steps — as a short hash,
 * saved with its session. A session saved under another definition is not
 * this account's any more: the agent edited it (another email, other
 * steps), and filming with it would film the previous user (review
 * 2026-10-16).
 */
export function accountDefinition(
  account: Pick<Account, "checkUrl" | "signIn">,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify({ checkUrl: account.checkUrl, signIn: account.signIn }),
    )
    .digest("hex")
    .slice(0, 16);
}

export interface AccountsSite {
  origin: string;
  site: string;
  defaultAccount: string | null;
  accounts: Map<string, Account>;
}
export interface AccountsFile {
  path: string;
  /** The `.demoman` folder: `secrets.env` lives here. */
  dir: string;
  sites: Map<string, AccountsSite>;
}
export type AccountsFound =
  | { kind: "none"; searchedFrom: string }
  | { kind: "found"; file: AccountsFile }
  | { kind: "invalid"; path: string; detail: string; field: string };
export type AccountChoice =
  | { kind: "manual" }
  | {
      kind: "account";
      file: AccountsFile;
      site: AccountsSite;
      account: Account;
    }
  | {
      kind: "refused";
      reason: "accountsInvalid" | "unknownAccount";
      detail: string;
      field: string;
    };

/** Each `{secret:NAME}` in a text, once each, in order. */
export function secretNamesIn(text: string): string[] {
  return [...new Set([...text.matchAll(SECRET_REF)].map((m) => m[1] ?? ""))];
}

/** `raw` (a path or an absolute URL) as an absolute URL on `origin`, or null
 *  when it is somewhere else or does not parse. */
function onOrigin(raw: string, origin: string): string | null {
  try {
    const u = new URL(raw, origin);
    return u.origin === origin ? u.href : null;
  } catch {
    return null;
  }
}

export function parseAccounts(
  path: string,
  text: string,
):
  | { ok: true; file: AccountsFile }
  | { ok: false; detail: string; field: string } {
  const no = (field: string, why: string) => ({
    ok: false as const,
    field,
    detail: `${path}: ${field === "" ? "" : `${field}: `}${why}`,
  });
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    return no("", `not JSON (${messageOf(error)})`);
  }
  const version = (raw as { accountsVersion?: unknown } | null)
    ?.accountsVersion;
  if (typeof version === "number" && version > ACCOUNTS_VERSION) {
    return no(
      "accountsVersion",
      `version ${version} was written by a newer Demoman; this one reads ${ACCOUNTS_VERSION} — update Demoman`,
    );
  }
  const parsed = FileSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    // zod 4 reports an unknown key at its parent's path with the keys in the
    // issue; the agent has to see which key, so it joins the field.
    const keys =
      issue?.code === "unrecognized_keys" ? issue.keys : ([] as string[]);
    const path0 = (issue?.path ?? []).map(String);
    const field = [...path0, ...keys].join(".");
    // The only record keys with a rule are account names; zod's own text
    // ("Invalid key in record") names neither the key nor the rule.
    const why =
      keys.length > 0
        ? `unknown key ${keys.map((k) => `"${k}"`).join(", ")}`
        : issue?.code === "invalid_key"
          ? `account name "${path0.at(-1) ?? ""}" is not allowed: an account name is ${ACCOUNT_NAME_RULE}`
          : (issue?.message ?? "not an accounts file");
    return no(field, why);
  }
  if (parsed.data.accountsVersion !== ACCOUNTS_VERSION) {
    return no("accountsVersion", `must be ${ACCOUNTS_VERSION}`);
  }
  const sites = new Map<string, AccountsSite>();
  for (const [key, entry] of Object.entries(parsed.data.sites)) {
    let origin: string;
    try {
      origin = new URL(key).origin;
    } catch {
      origin = "";
    }
    const site = origin === key ? siteOf(origin) : null;
    if (site === null) {
      return no(
        `sites.${key}`,
        "a site is keyed by its origin, like http://localhost:4000 (no path, no trailing slash)",
      );
    }
    const accounts = new Map<string, Account>();
    for (const [name, a] of Object.entries(entry.accounts)) {
      const at = `sites.${key}.accounts.${name}`;
      const checkUrl = onOrigin(a.checkUrl, origin);
      if (checkUrl === null) {
        return no(`${at}.checkUrl`, `must be a page on ${origin}`);
      }
      if (a.signIn[0]?.do !== "goto") {
        return no(`${at}.signIn`, "must start with a goto to the sign-in page");
      }
      const signIn: SignInStep[] = [];
      for (const [i, step] of a.signIn.entries()) {
        if (step.do === "goto") {
          const url = onOrigin(step.url, origin);
          if (url === null) {
            return no(
              `${at}.signIn.${i}.url`,
              `must be a page on ${origin}: a sign-in never leaves its site`,
            );
          }
          signIn.push({ do: "goto", url });
          continue;
        }
        if (step.do === "type") {
          const bad = secretNamesIn(step.text).find(
            (n) => !SECRET_NAME.test(n),
          );
          if (bad !== undefined) {
            return no(
              `${at}.signIn.${i}.text`,
              `{secret:${bad}} is not a secret name: use capital letters, digits and _`,
            );
          }
          // DEMOMAN_SECRET_KL_ORIGIN is KL's site, so KL_ORIGIN cannot also
          // be a secret of its own (rc.3).
          const reserved = secretNamesIn(step.text).find((n) =>
            n.endsWith(SECRET_ORIGIN_SUFFIX),
          );
          if (reserved !== undefined) {
            return no(
              `${at}.signIn.${i}.text`,
              `{secret:${reserved}} ends in ${SECRET_ORIGIN_SUFFIX}, which names another secret's site (${SECRET_PREFIX}${reserved.slice(0, -SECRET_ORIGIN_SUFFIX.length)}${SECRET_ORIGIN_SUFFIX}): choose a name that does not end in ${SECRET_ORIGIN_SUFFIX}`,
            );
          }
        }
        signIn.push(step);
      }
      accounts.set(name, { name, about: a.about, checkUrl, signIn });
    }
    const defaultAccount = entry.default ?? null;
    if (defaultAccount !== null && !accounts.has(defaultAccount)) {
      return no(
        `sites.${key}.default`,
        `names "${defaultAccount}", which is not one of this site's accounts (${[...accounts.keys()].join(", ")})`,
      );
    }
    sites.set(origin, { origin, site, defaultAccount, accounts });
  }
  return { ok: true, file: { path, dir: dirname(path), sites } };
}

const exists = (p: string) =>
  stat(p).then(
    () => true,
    () => false,
  );

export type DemomanFileFound =
  | { kind: "none"; searchedFrom: string }
  | { kind: "found"; path: string; text: string }
  | { kind: "unreadable"; path: string; detail: string };

/** Looks in `from` and each parent for `.demoman/<name>`, stopping at the
 *  first folder holding `.git` (the repo's root) or the filesystem's. Read
 *  fresh on every call: an agent edits the file between calls. An error other
 *  than ENOENT is `unreadable`, never "none". */
export async function findDemomanFile(
  from: string,
  name: string,
): Promise<DemomanFileFound> {
  let dir = from;
  for (;;) {
    const path = join(dir, ".demoman", name);
    try {
      return { kind: "found", path, text: await readFile(path, "utf8") };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        return { kind: "unreadable", path, detail: messageOf(error) };
      }
    }
    if (await exists(join(dir, ".git"))) break;
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return { kind: "none", searchedFrom: from };
}

/** Looks for `.demoman/accounts.json` the way findDemomanFile does. */
export async function findAccounts(from: string): Promise<AccountsFound> {
  const file = await findDemomanFile(from, "accounts.json");
  if (file.kind === "none") return file;
  if (file.kind === "unreadable") {
    return {
      kind: "invalid",
      path: file.path,
      field: "",
      detail: `${file.path} could not be read (${file.detail})`,
    };
  }
  const parsed = parseAccounts(file.path, file.text);
  return parsed.ok
    ? { kind: "found", file: parsed.file }
    : {
        kind: "invalid",
        path: file.path,
        detail: parsed.detail,
        field: parsed.field,
      };
}

export function chooseAccount(
  found: AccountsFound,
  target: string,
  named: string | undefined,
): AccountChoice {
  const refuse = (
    reason: "accountsInvalid" | "unknownAccount",
    detail: string,
    field: string,
  ): AccountChoice => ({ kind: "refused", reason, detail, field });
  if (found.kind === "invalid") {
    return refuse(
      "accountsInvalid",
      `${found.detail} — fix the file and run again`,
      found.field === "" ? "accounts.json" : found.field,
    );
  }
  let origin: string;
  try {
    origin = new URL(target).origin;
  } catch {
    return { kind: "manual" };
  }
  if (found.kind === "none") {
    return named === undefined
      ? { kind: "manual" }
      : refuse(
          "unknownAccount",
          `the script names account "${named}", and no ${ACCOUNTS_PATH} was found from ${found.searchedFrom} up to its git root`,
          "account",
        );
  }
  const site = found.file.sites.get(origin);
  if (site === undefined) {
    return named === undefined
      ? { kind: "manual" }
      : refuse(
          "unknownAccount",
          `${found.file.path} has no accounts for ${origin}; the script names "${named}"`,
          "account",
        );
  }
  const name = named ?? site.defaultAccount;
  const names = [...site.accounts.keys()].join(", ");
  if (name === null) {
    return refuse(
      "unknownAccount",
      `${origin} has no default account in ${found.file.path}: name one of ${names} in the script's account`,
      "account",
    );
  }
  const account = site.accounts.get(name);
  if (account === undefined) {
    return refuse(
      "unknownAccount",
      `${origin} has no account "${name}" in ${found.file.path}; it has ${names}`,
      "account",
    );
  }
  return { kind: "account", file: found.file, site, account };
}

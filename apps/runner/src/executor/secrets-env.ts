// apps/runner/src/executor/secrets-env.ts
//
// Secret values for accounts' sign-in steps (launch C2 §3). `{secret:NAME}`
// reads DEMOMAN_SECRET_NAME from the environment (CI), else the same line in
// a git-ignored `.demoman/secrets.env` (local). The prefix is the boundary:
// a script can never ask Demoman to type an arbitrary variable. An
// environment secret also names its site, DEMOMAN_SECRET_NAME_ORIGIN, and is
// typed nowhere else (rc.3): the agent writes accounts.json, so the site an
// account names is the agent's word, and Demoman's environment may hold
// secrets the agent's own cannot read (a CI job). secrets.env values stay
// unbound: the agent writes that file too, so they are its own already.
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { messageOf } from "../report.js";

export const SECRET_PREFIX = "DEMOMAN_SECRET_";
/** `${SECRET_PREFIX}NAME${SECRET_ORIGIN_SUFFIX}` holds the site NAME's
 *  environment value may be typed on. */
export const SECRET_ORIGIN_SUFFIX = "_ORIGIN";
export const SECRET_MIN_LENGTH = 8;
export const SECRETS_FILE = "secrets.env";
const REF = /\{secret:([A-Z0-9_]+)\}/g;
const LINE = /^DEMOMAN_SECRET_([A-Z0-9_]+)=(.*)$/;

export type SecretReason =
  | "secretMissing"
  | "secretTooShort"
  | "secretUnbound"
  | "secretOffOrigin"
  | "secretsFileNotIgnored"
  | "secretsFileInvalid";

export class SecretError extends Error {
  constructor(
    readonly reason: SecretReason,
    message: string,
  ) {
    super(message);
  }
}

export interface SecretsSource {
  path: string;
  /** absent: no file. ignored: git ignores it. notGit: read, but no git
   *  repository could say whether it would be committed. */
  status: "absent" | "ignored" | "notGit";
  values: Map<string, string>;
}

/** git check-ignore: exit 0 ignored, 1 not ignored (a tracked file is never
 *  ignored). Not a repository is answered only when git says so; any other
 *  failure (exit 128 on dubious ownership or a corrupt repository, git
 *  missing) is returned as `failed` with git's own words, never read as "no
 *  repository" (final review I3). */
function gitIgnores(
  dir: string,
  file: string,
): Promise<"ignored" | "notIgnored" | "notGit" | { failed: string }> {
  return new Promise((resolve) => {
    execFile(
      "git",
      ["check-ignore", "-q", "--", file],
      { cwd: dir },
      (error, _stdout, stderr) => {
        if (error === null) return resolve("ignored");
        const code = (error as { code?: unknown }).code;
        if (code === 1) return resolve("notIgnored");
        const said = String(stderr ?? "").trim();
        if (/not a git repository/i.test(said)) return resolve("notGit");
        resolve({
          failed: said === "" ? messageOf(error) : said,
        });
      },
    );
  });
}

export async function readSecretsFile(dir: string): Promise<SecretsSource> {
  const path = join(dir, SECRETS_FILE);
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { path, status: "absent", values: new Map() };
    }
    throw new SecretError(
      "secretsFileInvalid",
      `${path} could not be read (${messageOf(error)})`,
    );
  }
  const git = await gitIgnores(dir, SECRETS_FILE);
  if (typeof git === "object") {
    throw new SecretError(
      "secretsFileNotIgnored",
      `git could not say whether ${path} is ignored: ${git.failed} — so it was not read, in case it could be committed; fix that (or add the line .demoman/secrets.env to the repo's .gitignore once git works), then run again`,
    );
  }
  if (git === "notIgnored") {
    throw new SecretError(
      "secretsFileNotIgnored",
      `${path} holds passwords and git does not ignore it, so it could be committed — add the line .demoman/secrets.env to the repo's .gitignore (and \`git rm --cached .demoman/secrets.env\` if it was ever added), then run again`,
    );
  }
  const values = new Map<string, string>();
  for (const [i, raw] of text.split(/\r?\n/).entries()) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const m = LINE.exec(line);
    if (m === null) {
      throw new SecretError(
        "secretsFileInvalid",
        `${path} line ${i + 1} is not DEMOMAN_SECRET_NAME=value (NAME in capital letters, digits and _); only those lines, comments and blank lines belong in it`,
      );
    }
    const value = (m[2] ?? "").replace(/^(["'])(.*)\1$/, "$2");
    values.set(m[1] as string, value);
  }
  return { path, status: git === "ignored" ? "ignored" : "notGit", values };
}

/** `raw` as the origin it names, or null unless it is exactly an origin
 *  (a trailing `/` and the case of scheme and host aside): no path, query,
 *  fragment or credentials. */
function originNamed(raw: string): string | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  const bare =
    u.origin !== "null" &&
    u.pathname === "/" &&
    u.search === "" &&
    u.hash === "" &&
    u.username === "" &&
    u.password === "" &&
    !raw.endsWith("?") &&
    !raw.endsWith("#");
  return bare ? u.origin : null;
}

export interface SecretScope {
  /** The account's site: an environment secret is typed only on the one
   *  its `_ORIGIN` names. */
  origin: string;
  /** Why the environment's secrets are not consulted at all: an
   *  accounts.json the caller pointed at (`project`), whose own secrets.env
   *  still answers. Absent, they are. */
  envWithheld?: string;
}

export function resolveSecrets(
  text: string,
  env: NodeJS.ProcessEnv,
  file: SecretsSource,
  scope: SecretScope,
): { text: string; used: Array<{ name: string; value: string }> } {
  const { origin, envWithheld } = scope;
  const used: Array<{ name: string; value: string }> = [];
  const out = text.replace(REF, (_all, name: string) => {
    const variable = `${SECRET_PREFIX}${name}`;
    // An empty variable is an unset one: CI expands a secret it lacks to "".
    const raw = env[variable];
    const inEnv = raw !== undefined && raw !== "";
    if (envWithheld === undefined && inEnv) {
      // Never a fall back to secrets.env here: a set variable the author
      // meant to be used would be passed over without a word.
      const binding = `${variable}${SECRET_ORIGIN_SUFFIX}`;
      const declared = env[binding];
      if (declared === undefined || declared === "") {
        throw new SecretError(
          "secretUnbound",
          `{secret:${name}} comes from ${variable} in Demoman's environment, which names no site for it, so it was not typed — set ${binding} to the one site it may be typed on (this sign-in is for ${origin}) where ${variable} is set, or unset ${variable} to use ${file.path}`,
        );
      }
      const site = originNamed(declared);
      if (site === null) {
        throw new SecretError(
          "secretUnbound",
          `${binding} is ${JSON.stringify(declared)}, which is not an origin: give a scheme, host and port only, like http://localhost:4000 — so {secret:${name}} was not typed`,
        );
      }
      if (site !== origin) {
        throw new SecretError(
          "secretOffOrigin",
          `{secret:${name}} is for ${site} (${binding}), and this sign-in is for ${origin}, so it was not typed — an environment secret is typed only on its own site`,
        );
      }
    }
    const fromEnv = envWithheld === undefined && inEnv ? raw : undefined;
    const value = fromEnv ?? file.values.get(name);
    if (value === undefined && envWithheld !== undefined && inEnv) {
      throw new SecretError(
        "secretMissing",
        `{secret:${name}} has no value in ${file.path}: ${variable} is set in Demoman's environment, but ${envWithheld} — add ${variable}=… to ${file.path}`,
      );
    }
    if (value === undefined) {
      throw new SecretError(
        "secretMissing",
        `{secret:${name}} has no value: set ${variable} (and ${variable}${SECRET_ORIGIN_SUFFIX}, its site) in the environment (an agent may pass Demoman only part of its environment — Codex does — so the file is the sure place), or add ${variable}=… to ${file.path}`,
      );
    }
    if (value.length < SECRET_MIN_LENGTH) {
      throw new SecretError(
        "secretTooShort",
        `{secret:${name}} is under ${SECRET_MIN_LENGTH} characters: use a longer generated password (Demoman removes every occurrence of a secret from what it writes, and a short one would shred ordinary text)`,
      );
    }
    used.push({ name, value });
    return value;
  });
  return { text: out, used };
}

export interface SecretSweep {
  add(name: string, value: string): void;
  scrub(text: string): string;
  /** Every string inside a JSON-shaped value, scrubbed; other values kept. */
  scrubValue<T>(value: T): T;
}

/** What every reply, log line and file passes before it leaves Demoman:
 *  each value resolved so far becomes `{secret:NAME}` again. Longest first,
 *  so a value that contains another is replaced whole. */
/**
 * A value as an app may keep it: as typed, URL-encoded (a cookie), JSON-
 * escaped (a stored object, the storage scan's JSON), and base64 or
 * base64url (a token). The sweep knows each, so neither a reply nor a saved
 * session carries a password in any of them (review 2026-10-16). A whole
 * token that merely contains the password is not caught.
 */
function formsOf(value: string): Set<string> {
  const b64 = Buffer.from(value, "utf8").toString("base64");
  return new Set(
    [
      value,
      encodeURIComponent(value),
      JSON.stringify(value).slice(1, -1),
      b64,
      b64.replace(/=+$/, ""),
      Buffer.from(value, "utf8").toString("base64url"),
    ].filter((f) => f.length >= SECRET_MIN_LENGTH),
  );
}

export function createSecretSweep(): SecretSweep {
  const known = new Map<string, string>();
  const scrub = (text: string): string => {
    let out = text;
    for (const [value, name] of [...known].sort(
      (a, b) => b[0].length - a[0].length,
    )) {
      out = out.split(value).join(`{secret:${name}}`);
    }
    return out;
  };
  const scrubValue = <T>(value: T): T => {
    if (known.size === 0) return value;
    if (typeof value === "string") return scrub(value) as T;
    if (Array.isArray(value)) return value.map(scrubValue) as T;
    if (value !== null && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(([k, v]) => [
          k,
          scrubValue(v),
        ]),
      ) as T;
    }
    return value;
  };
  return {
    add: (name, value) => {
      for (const form of formsOf(value)) known.set(form, name);
    },
    scrub,
    scrubValue,
  };
}

/** A progress sink that sees only swept values: progress goes to the agent
 *  and to hub peers, and its notes carry thrown text. Absent stays absent. */
export function sweptSink<T>(
  sweep: SecretSweep,
  sink: ((value: T) => void) | undefined,
): ((value: T) => void) | undefined {
  return sink === undefined ? undefined : (v) => sink(sweep.scrubValue(v));
}

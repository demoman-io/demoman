// Which GitHub secrets the repo's flows and app need, where their values are
// read from locally, and setting them: the value on stdin, never in argv, a
// log line or an answer.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseEnv } from "node:util";
import { type AppSpec, scrubSecrets } from "@demoman/run-core";
import {
  chooseAccount,
  findAccounts,
  readKeptFlows,
  readSecretsFile,
  SECRET_ORIGIN_SUFFIX,
  SECRET_PREFIX,
  secretNamesIn,
} from "@demoman/runner/package";
import type { Gh } from "./gh-run.js";

export type NeededSecret = {
  name: string;
  for: "account" | "app";
  why: string;
};

export async function neededSecrets(
  root: string,
  app: AppSpec | null,
): Promise<{ needed: NeededSecret[] } | { refused: string }> {
  const needed = new Map<string, NeededSecret>();
  const found = await findAccounts(root);
  for (const entry of (await readKeptFlows(root)).entries) {
    if ("unreadable" in entry) return { refused: entry.unreadable };
    const { script } = entry.kept;
    const target = String(script.target);
    const choice = chooseAccount(
      found,
      target,
      typeof script.account === "string" ? script.account : undefined,
    );
    if (choice.kind === "refused") return { refused: choice.detail };
    if (choice.kind === "manual") continue;
    const why = `account ${choice.account.name} on ${choice.site.origin}`;
    const texts = choice.account.signIn.flatMap((s) =>
      s.do === "type" ? [s.text] : [],
    );
    for (const n of texts.flatMap(secretNamesIn)) {
      for (const suffix of ["", SECRET_ORIGIN_SUFFIX]) {
        const name = `${SECRET_PREFIX}${n}${suffix}`;
        if (!needed.has(name)) needed.set(name, { name, for: "account", why });
      }
    }
  }
  for (const name of app?.secrets ?? []) {
    if (!needed.has(name))
      needed.set(name, { name, for: "app", why: "app.json" });
  }
  return { needed: [...needed.values()] };
}

/** Never logged, never returned to a door. */
export type SecretValues = Map<string, string>;

/** The environment, else `.demoman/secrets.env` (read only when git ignores
 *  it; a refusal to read it throws, as it does for a run). */
export async function localValues(
  root: string,
  needed: NeededSecret[],
  env: NodeJS.ProcessEnv,
): Promise<{ values: SecretValues; missing: string[] }> {
  const values: SecretValues = new Map();
  const absent = needed.filter((n) => !env[n.name]);
  for (const n of needed) {
    const v = env[n.name];
    if (v) values.set(n.name, v);
  }
  if (absent.length > 0) {
    const file = await readSecretsFile(join(root, ".demoman"));
    for (const n of absent) {
      const v = n.name.startsWith(SECRET_PREFIX)
        ? file.values.get(n.name.slice(SECRET_PREFIX.length))
        : undefined;
      if (v) values.set(n.name, v);
    }
  }
  return {
    values,
    missing: needed.filter((n) => !values.has(n.name)).map((n) => n.name),
  };
}

export async function envFileNames(
  path: string,
  needed: NeededSecret[],
): Promise<string[]> {
  const names = Object.keys(parseEnv(await readFile(path, "utf8")));
  return names.filter((n) => needed.some((s) => s.name === n));
}

export async function envFileValues(
  path: string,
  chosen: string[],
): Promise<SecretValues> {
  const all = parseEnv(await readFile(path, "utf8"));
  const values: SecretValues = new Map();
  for (const n of chosen) {
    const v = all[n];
    if (v !== undefined) values.set(n, v);
  }
  return values;
}

export async function existingSecrets(
  gh: Gh,
  slug: string,
): Promise<string[] | { failed: string }> {
  const r = await gh(["secret", "list", "--repo", slug, "--json", "name"]);
  if (r.code !== 0) {
    return { failed: scrubSecrets((r.stderr || r.stdout).trim()) };
  }
  try {
    return (JSON.parse(r.stdout) as Array<{ name: string }>).map((s) => s.name);
  } catch {
    return { failed: "gh secret list did not answer with JSON" };
  }
}

export type SecretsSet = {
  set: string[];
  kept: string[];
  failed: Array<{ name: string; said: string }>;
};

export async function setSecrets(
  gh: Gh,
  slug: string,
  values: SecretValues,
  replace: string[],
  existing: string[],
): Promise<SecretsSet> {
  const out: SecretsSet = { set: [], kept: [], failed: [] };
  let stoppedAt: string | null = null;
  for (const [name, value] of values) {
    if (stoppedAt !== null) {
      out.failed.push({
        name,
        said: `not attempted: setup stopped at ${stoppedAt}`,
      });
    } else if (existing.includes(name) && !replace.includes(name)) {
      out.kept.push(name);
    } else {
      const r = await gh(["secret", "set", name, "--repo", slug], {
        input: value,
      });
      if (r.code === 0) out.set.push(name);
      else {
        stoppedAt = name;
        const said = (r.stderr || r.stdout).trim() || `gh exited ${r.code}`;
        out.failed.push({ name, said: scrubSecrets(said) });
      }
    }
  }
  return out;
}

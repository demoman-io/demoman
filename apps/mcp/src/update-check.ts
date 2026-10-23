// apps/mcp/src/update-check.ts
//
// Whether a newer `demoman` is on npm (launch B). At most once a day, 3 s at
// most, cached in <home>/update-check.json; a failure is said as a failure
// and asked again after an hour. It contacts the npm registry only — never
// demoman.io — and DEMOMAN_NO_UPDATE_CHECK=1 turns it off.
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

export type UpdateAnswer =
  | { current: string; latest: string; newer: boolean }
  | { current: string; check: string };

export const UPDATE_TIMEOUT_MS = 3_000;
const DAY_MS = 24 * 60 * 60 * 1000;
const RETRY_MS = 60 * 60 * 1000;

interface Cached {
  checkedAt: number;
  latest?: string;
  failed?: string;
}

const messageOf = (e: unknown): string =>
  e instanceof Error ? e.message : String(e);

/** Semver order for x.y.z with an optional prerelease; a release outranks
 *  its own prereleases, and rc.10 outranks rc.9. */
export function isNewer(latest: string, current: string): boolean {
  const parse = (v: string) => {
    const dash = v.indexOf("-");
    const core = dash === -1 ? v : v.slice(0, dash);
    const pre = dash === -1 ? undefined : v.slice(dash + 1);
    return { n: core.split(".").map(Number), pre };
  };
  const a = parse(latest);
  const b = parse(current);
  for (let i = 0; i < 3; i++) {
    const x = a.n[i] ?? 0;
    const y = b.n[i] ?? 0;
    if (x !== y) return x > y;
  }
  if (a.pre === b.pre) return false;
  if (a.pre === undefined) return true;
  if (b.pre === undefined) return false;
  return a.pre.localeCompare(b.pre, "en", { numeric: true }) > 0;
}

async function registryLatest(
  name: string,
  timeoutMs: number,
): Promise<string> {
  const res = await fetch(`https://registry.npmjs.org/${name}/latest`, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`the npm registry answered ${res.status}`);
  const body = (await res.json()) as { version?: unknown };
  if (typeof body.version !== "string") {
    throw new Error("the npm registry's answer names no version");
  }
  return body.version;
}

export function createUpdateCheck(o: {
  name: string;
  current: string;
  home: string;
  log: (line: string) => void;
  env?: NodeJS.ProcessEnv;
  fetchLatest?: (name: string, timeoutMs: number) => Promise<string>;
  now?: () => number;
}): () => Promise<UpdateAnswer> {
  const env = o.env ?? process.env;
  const now = o.now ?? Date.now;
  const fetchLatest = o.fetchLatest ?? registryLatest;
  const file = join(o.home, "update-check.json");
  const said = (c: Cached): UpdateAnswer =>
    c.latest !== undefined
      ? {
          current: o.current,
          latest: c.latest,
          newer: isNewer(c.latest, o.current),
        }
      : { current: o.current, check: `failed: ${c.failed}` };

  async function read(): Promise<Cached | null> {
    let text: string;
    try {
      text = await readFile(file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      o.log(`${file} could not be read (${messageOf(error)}); asking npm`);
      return null;
    }
    try {
      const c = JSON.parse(text) as Cached;
      if (typeof c.checkedAt !== "number") {
        throw new Error("it names no checkedAt");
      }
      // Exactly one answer, as text: anything else would say "failed:
      // undefined" for an hour, or throw out of isNewer inside status.
      if ((typeof c.latest === "string") === (typeof c.failed === "string")) {
        throw new Error("it holds neither a latest version nor a failure");
      }
      return c;
    } catch (error) {
      o.log(`${file} could not be read (${messageOf(error)}); asking npm`);
      return null;
    }
  }

  /** Beside, then renamed over: two sessions never leave half a file. */
  async function write(c: Cached): Promise<void> {
    try {
      await mkdir(o.home, { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      await writeFile(tmp, JSON.stringify(c));
      await rename(tmp, file);
    } catch (error) {
      o.log(
        `the update check's answer was not saved to ${file} (${messageOf(error)}); the next status asks npm again`,
      );
    }
  }

  return async () => {
    if (env.DEMOMAN_NO_UPDATE_CHECK === "1") {
      return { current: o.current, check: "off: DEMOMAN_NO_UPDATE_CHECK=1" };
    }
    const t = now();
    const cached = await read();
    if (cached !== null) {
      const fresh = cached.latest !== undefined ? DAY_MS : RETRY_MS;
      if (t - cached.checkedAt < fresh) return said(cached);
    }
    let next: Cached;
    try {
      next = {
        checkedAt: t,
        latest: await fetchLatest(o.name, UPDATE_TIMEOUT_MS),
      };
    } catch (error) {
      next = { checkedAt: t, failed: messageOf(error) };
    }
    await write(next);
    return said(next);
  };
}

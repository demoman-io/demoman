// A small adapter around the GitHub CLI. Every reason `gh` cannot be used is a
// named GhRefusal carrying the words to show the author; nothing here throws,
// and a refusal never reads like success.
import { execFile } from "node:child_process";

export type GhResult =
  | { code: number; stdout: string; stderr: string }
  | { spawnError: NodeJS.ErrnoException }
  /** The call did not answer within the `timeoutMs` it was given, and the
   *  process was stopped. */
  | { timedOut: true };

export type GhRun = (
  args: readonly string[],
  /** `timeoutMs`: stop the call after this long. Every call is given one: a
   *  check a few seconds, an upload ten minutes. */
  opts: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs?: number },
) => Promise<GhResult>;

export type GhRefusal = {
  reason:
    | "ghMissing"
    | "ghOutdated"
    | "ghSignedOut"
    | "notGitHub"
    | "prNotFound";
  detail: string;
};

/** The first gh that can attach a file to a pull request. */
export const MIN_GH_VERSION = [2, 99, 0] as const;

/** How long a check (`--version`, `auth status`, `pr view`) may take. A
 *  `gh auth status` waiting on a keychain prompt would otherwise hold the
 *  call, and the slot with it, for ever. */
export const GH_CHECK_TIMEOUT_MS = 20_000;

/** gh's answer to `pr view` in a checkout with no remote on a GitHub host
 *  it knows. "no git remotes found" (no remote at all) is not this. */
const NOT_GITHUB_REMOTES =
  /none of the git remotes configured for this repository point to a known GitHub host/;

// Large enough for a pull request's whole comment thread.
const MAX_BUFFER = 64 * 1024 * 1024;

/** The codes with which gh could not be started at all. Any other string
 *  code (a buffer overflow, say) came from a gh that ran. */
const SPAWN_CODES = new Set(["ENOENT", "EACCES", "ENOEXEC"]);

export const defaultGhRun: GhRun = (args, opts) =>
  new Promise((resolve) => {
    execFile(
      "gh",
      [...args],
      {
        cwd: opts.cwd,
        env: opts.env,
        maxBuffer: MAX_BUFFER,
        // SIGKILL: a gh that ignores SIGTERM must not linger past its limit.
        ...(opts.timeoutMs === undefined
          ? {}
          : { timeout: opts.timeoutMs, killSignal: "SIGKILL" as const }),
      },
      (error, stdout, stderr) => {
        if (error === null) {
          resolve({ code: 0, stdout, stderr });
          return;
        }
        const e = error as NodeJS.ErrnoException & { killed?: boolean };
        // Stopped by execFile's own timeout: not an exit gh chose. An
        // overflowing answer is killed too, and is not a timeout.
        if (
          opts.timeoutMs !== undefined &&
          e.killed === true &&
          e.code !== "ERR_CHILD_PROCESS_STDIO_MAXBUFFER"
        ) {
          resolve({ timedOut: true });
          return;
        }
        // A numeric code is gh's own exit status; a spawn code means gh never
        // started; anything else (another string code, a signal, an
        // overflow) is a gh that ran and failed, said with its message.
        if (typeof e.code === "number") {
          resolve({ code: e.code, stdout, stderr });
        } else if (typeof e.code === "string" && SPAWN_CODES.has(e.code)) {
          resolve({ spawnError: e });
        } else {
          resolve({
            code: 1,
            stdout,
            stderr: `${stderr}${stderr === "" ? "" : "\n"}${e.message}`,
          });
        }
      },
    );
  });

function firstLine(text: string): string {
  return (
    text
      .split("\n")
      .find((l) => l.trim() !== "")
      ?.trim() ?? ""
  );
}

function atLeast(found: readonly number[], min: readonly number[]): boolean {
  for (let i = 0; i < min.length; i++) {
    const a = found[i] ?? 0;
    const b = min[i] ?? 0;
    if (a !== b) return a > b;
  }
  return true;
}

/** What `readBack` reads: a PR's description and its comments. */
export type PullRequestText = {
  body: string;
  comments: { body: string; createdAt: string }[];
};

/** The longest an upload may take: ten minutes. */
export const GH_UPLOAD_TIMEOUT_MS = 10 * 60_000;

export type Gh = ReturnType<typeof createGh>;

export function createGh(
  run: GhRun,
  cwd: string,
  env: NodeJS.ProcessEnv,
  /** Tests only: a shorter `GH_CHECK_TIMEOUT_MS`. */
  checkTimeoutMs: number = GH_CHECK_TIMEOUT_MS,
  /** Tests only: a shorter `GH_UPLOAD_TIMEOUT_MS`. */
  uploadTimeoutMs: number = GH_UPLOAD_TIMEOUT_MS,
) {
  /** Answers `timedOut` after `ms` whether or not the runner honours
   *  `timeoutMs` itself, so no call can hold the slot. */
  const within = async (
    args: readonly string[],
    ms: number,
    grace: number,
  ): Promise<GhResult> => {
    let timer: NodeJS.Timeout | undefined;
    const late = new Promise<GhResult>((resolve) => {
      timer = setTimeout(() => resolve({ timedOut: true }), ms + grace);
    });
    try {
      return await Promise.race([run(args, { cwd, env, timeoutMs: ms }), late]);
    } finally {
      clearTimeout(timer);
    }
  };
  /** An upload: a large video may take minutes, so the ceiling is long, but
   *  a stalled gh must not hold the slot for ever. */
  const call = (args: readonly string[]) =>
    within(args, uploadTimeoutMs, 1_000);
  /** A check. */
  const check = (args: readonly string[]) =>
    within(args, checkTimeoutMs, 1_000);
  const duration = (ms: number) =>
    ms >= 1000 ? `${Math.round(ms / 1000)} s` : `${ms} ms`;
  const seconds = duration(checkTimeoutMs);
  const timedOut = (
    reason: GhRefusal["reason"],
    command: string,
    then: string,
  ): GhRefusal => ({
    reason,
    detail: `${command} timed out: gh did not answer within ${seconds}. ${then}`,
  });

  const missing = (e: NodeJS.ErrnoException): GhRefusal => ({
    reason: "ghMissing",
    detail:
      e.code === "ENOENT"
        ? `gh is not installed, or not on PATH (PATH is ${env.PATH ?? "unset"}). Install it with: brew install gh`
        : `gh could not be started (${e.code}: ${e.message}); PATH is ${env.PATH ?? "unset"}.`,
  });

  async function ready(): Promise<null | GhRefusal> {
    const v = await check(["--version"]);
    if ("timedOut" in v) {
      return timedOut(
        "ghMissing",
        "gh --version",
        "Check that gh runs in a terminal.",
      );
    }
    if ("spawnError" in v) return missing(v.spawnError);
    const need = MIN_GH_VERSION.join(".");
    if (v.code !== 0) {
      return {
        reason: "ghOutdated",
        detail: `gh --version failed (exit ${v.code}): ${firstLine(v.stderr) || firstLine(v.stdout)}. Attaching a video needs gh ${need} or newer.`,
      };
    }
    const m = /gh version (\d+)\.(\d+)\.(\d+)/.exec(v.stdout);
    if (m === null) {
      return {
        reason: "ghOutdated",
        detail: `could not read a version from gh --version ("${firstLine(v.stdout)}"). Attaching a video needs gh ${need} or newer.`,
      };
    }
    const found = [Number(m[1]), Number(m[2]), Number(m[3])];
    if (!atLeast(found, MIN_GH_VERSION)) {
      return {
        reason: "ghOutdated",
        detail: `gh ${found.join(".")} cannot attach a video; it needs ${need} or newer. Update it with: brew upgrade gh`,
      };
    }
    const a = await check(["auth", "status", "--hostname", "github.com"]);
    if ("timedOut" in a) {
      // A keychain prompt waiting for the user looks exactly like this.
      return timedOut(
        "ghSignedOut",
        "gh auth status --hostname github.com",
        "It may be waiting on a keychain prompt; run it in a terminal, or run: gh auth login",
      );
    }
    if ("spawnError" in a) return missing(a.spawnError);
    if (a.code !== 0) {
      return {
        reason: "ghSignedOut",
        detail: `gh is not signed in to github.com (${firstLine(a.stderr) || firstLine(a.stdout) || `exit ${a.code}`}). Run: gh auth login`,
      };
    }
    return null;
  }

  async function pr(
    n?: number,
  ): Promise<{ number: number; url: string; host: string } | GhRefusal> {
    const args = ["pr", "view", ...(n === undefined ? [] : [String(n)])];
    const r = await check([...args, "--json", "number,url"]);
    if ("timedOut" in r) {
      return timedOut(
        "prNotFound",
        `${["gh", ...args].join(" ")} --json number,url`,
        "Check that gh can reach github.com.",
      );
    }
    if ("spawnError" in r) return missing(r.spawnError);
    if (r.code !== 0) {
      const said = firstLine(r.stderr) || firstLine(r.stdout) || "no message";
      // A checkout whose remotes are all elsewhere (GitLab, Bitbucket, a
      // GitHub Enterprise host gh is not signed in to) is not "no pull
      // request": it is notGitHub, so the agent offers the file by hand.
      // Matched on gh's own words (2.102.0); if gh rewords them, this falls
      // back to prNotFound, which still quotes what gh said.
      if (NOT_GITHUB_REMOTES.test(said)) {
        return {
          reason: "notGitHub",
          detail: `this checkout has no remote on github.com, and video attachments work only there (gh: ${said})`,
        };
      }
      return {
        reason: "prNotFound",
        detail: `gh pr view failed (exit ${r.code}): ${said}`,
      };
    }
    let parsed: { number?: unknown; url?: unknown };
    try {
      parsed = JSON.parse(r.stdout) as typeof parsed;
    } catch {
      return {
        reason: "prNotFound",
        detail: `gh pr view answered something that is not JSON: ${firstLine(r.stdout)}`,
      };
    }
    if (typeof parsed.number !== "number" || typeof parsed.url !== "string") {
      return {
        reason: "prNotFound",
        detail: `gh pr view did not answer a number and a url: ${r.stdout.slice(0, 200)}`,
      };
    }
    let host: string;
    try {
      host = new URL(parsed.url).hostname;
    } catch {
      return {
        reason: "prNotFound",
        detail: `gh pr view answered a url that cannot be read: ${parsed.url}`,
      };
    }
    if (host !== "github.com") {
      return {
        reason: "notGitHub",
        detail: `this pull request lives on ${host}; video attachments work only on github.com.`,
      };
    }
    return { number: parsed.number, url: parsed.url, host };
  }

  // gh's own answer is the caller's to judge; a spawn failure is shown as a
  // non-zero exit carrying its reason, never as success.
  async function attached(args: readonly string[]) {
    const r = await call(args);
    if ("spawnError" in r) {
      return { code: 127, stdout: "", stderr: missing(r.spawnError).detail };
    }
    // An upload that outran its ceiling is stopped and said as a failed
    // exit (124, as timeout(1) does), never as success. What landed is for
    // the read-back to say.
    if ("timedOut" in r) {
      return {
        code: 124,
        stdout: "",
        stderr: `gh did not finish within ${duration(uploadTimeoutMs)} and was stopped`,
      };
    }
    return r;
  }

  return {
    ready,
    pr,
    attachToDescription: (n: number, file: string) =>
      attached(["pr", "edit", String(n), "--attach", file]),
    attachToComment: (n: number, file: string, body: string) =>
      attached(["pr", "comment", String(n), "--body", body, "--attach", file]),
    /** The PR's description and comments, or `{ unreadable }` saying why
     *  they could not be read — never "nothing there". A read, so it is
     *  timed like a check. */
    async readBack(
      n: number,
    ): Promise<PullRequestText | { unreadable: string }> {
      const command = `gh pr view ${n} --json body,comments`;
      const r = await check([
        "pr",
        "view",
        String(n),
        "--json",
        "body,comments",
      ]);
      if ("timedOut" in r) {
        return {
          unreadable: `${command} timed out: gh did not answer within ${seconds}`,
        };
      }
      if ("spawnError" in r) {
        return { unreadable: missing(r.spawnError).detail };
      }
      if (r.code !== 0) {
        return {
          unreadable: `${command} failed (exit ${r.code}): ${firstLine(r.stderr) || firstLine(r.stdout) || "no message"}`,
        };
      }
      let j: {
        body?: unknown;
        comments?: { body?: unknown; createdAt?: unknown }[];
      };
      try {
        j = JSON.parse(r.stdout) as typeof j;
      } catch {
        return {
          unreadable: `${command} answered something that is not JSON: ${firstLine(r.stdout)}`,
        };
      }
      if (typeof j.body !== "string" || !Array.isArray(j.comments)) {
        return {
          unreadable: `${command} did not answer a body and a list of comments: ${r.stdout.slice(0, 200)}`,
        };
      }
      return {
        body: j.body,
        comments: j.comments.map((c) => ({
          body: String(c.body ?? ""),
          createdAt: String(c.createdAt ?? ""),
        })),
      };
    },
  };
}

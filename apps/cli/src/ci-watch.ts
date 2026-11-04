// Follow the setup pull request's run to its verdict. An outcome we could not read is
// `unknown`, never `failed` and never `passed`.
import { scrubSecrets } from "@demoman/run-core";
import type { Gh } from "./gh-run.js";

export type Watched =
  | { passed: { runUrl: string; artifactUrl: string; lines: string[] } }
  | {
      failed: {
        runUrl: string;
        step: string;
        tail: string;
        failedRuns: number | null;
        gaveUp: boolean;
        note?: string;
      };
    }
  | { cancelled: { runUrl: string } }
  | { unknown: { runUrl: string | null; why: string } };

const POLL_MS = 10_000;
const BLIPS = 5;
type Step = { name: string; status?: string; conclusion?: string | null };
type View = {
  status: string;
  conclusion: string | null;
  jobs?: { steps?: Step[] }[];
};

export async function watchSetupRun(
  a: {
    slug: string;
    branch: string;
    sha: string;
    timeoutMs?: number;
    appearMs?: number;
  },
  deps: {
    gh: Gh;
    sleep(ms: number): Promise<void>;
    now(): number;
    progress(line: string): void;
  },
): Promise<Watched> {
  const { gh, sleep, now, progress } = deps;
  const start = now();
  const settings = `https://github.com/${a.slug}/settings/actions`;
  const read = async (args: string[]) => {
    const r = await gh(args);
    return r.code === 0 ? r.stdout : null;
  };

  // Find the run for our commit.
  let run: { id: number; url: string } | null = null;
  let errors = 0;
  while (!run) {
    const out = await read([
      "run",
      "list",
      "--repo",
      a.slug,
      "--workflow",
      "demoman.yml",
      "--branch",
      a.branch,
      "--event",
      "pull_request",
      "--json",
      "databaseId,headSha,status,conclusion,url",
    ]);
    if (out === null) errors += 1;
    else {
      errors = 0;
      try {
        const hit = (
          JSON.parse(out) as {
            databaseId: number;
            headSha: string;
            url: string;
          }[]
        ).find((r) => r.headSha === a.sha);
        if (hit) run = { id: hit.databaseId, url: hit.url };
      } catch {
        errors += 1;
      }
    }
    if (run) break;
    if (errors >= BLIPS) {
      return {
        unknown: {
          runUrl: null,
          why: `GitHub could not be read ${BLIPS} times in a row, so whether a run started is unknown, not failed. Open ${a.slug}'s Actions tab to see it.`,
        },
      };
    }
    if (now() - start >= (a.appearMs ?? 180_000)) {
      return {
        unknown: {
          runUrl: null,
          why: `No run of demoman.yml started on ${a.branch}. The workflow's pull_request paths or Actions being off are the likely reasons: check ${settings}, then push again.`,
        },
      };
    }
    await sleep(POLL_MS);
  }

  // Follow it.
  const lines: string[] = [];
  const say = (l: string) => {
    lines.push(l);
    progress(l);
  };
  const watchStart = now();
  let last = "";
  errors = 0;
  for (;;) {
    const out = await read([
      "run",
      "view",
      String(run.id),
      "--repo",
      a.slug,
      "--json",
      "status,conclusion,jobs",
    ]);
    let v: View | null = null;
    try {
      v = out === null ? null : (JSON.parse(out) as View);
    } catch {
      v = null;
    }
    if (!v) {
      errors += 1;
      if (errors >= BLIPS) {
        return {
          unknown: {
            runUrl: run.url,
            why: `GitHub could not be read ${BLIPS} times in a row, so its outcome is unknown, not failed. See ${run.url}.`,
          },
        };
      }
    } else {
      errors = 0;
      const steps = (v.jobs ?? []).flatMap((j) => j.steps ?? []);
      const now_ =
        steps.find((s) => s.status === "in_progress") ??
        steps.find((s) => s.conclusion === "failure");
      const label = now_ ? now_.name : v.status;
      if (label !== last) {
        say(label);
        last = label;
      }
      if (v.status === "completed") {
        if (v.conclusion === "success")
          return {
            passed: {
              runUrl: run.url,
              artifactUrl: `${run.url}#artifacts`,
              lines,
            },
          };
        if (v.conclusion === "cancelled")
          return { cancelled: { runUrl: run.url } };
        if (v.conclusion === "failure" || v.conclusion === "timed_out") {
          const step =
            steps.find((s) => s.conclusion === "failure")?.name ??
            "unknown step";
          const log = await read([
            "run",
            "view",
            String(run.id),
            "--repo",
            a.slug,
            "--log-failed",
          ]);
          const tail = scrubSecrets(
            (log ?? "(the log could not be read)")
              .trimEnd()
              .split("\n")
              .slice(-40)
              .join("\n"),
          );
          // The count is read like the watch is: a blip is retried, an unreadable list is null.
          let failedRuns: number | null = null;
          for (let n = 0; n < BLIPS && failedRuns === null; n++) {
            if (n > 0) await sleep(POLL_MS);
            const counted = await read([
              "run",
              "list",
              "--repo",
              a.slug,
              "--workflow",
              "demoman.yml",
              "--branch",
              a.branch,
              "--event",
              "pull_request",
              "--limit",
              "50",
              "--json",
              "conclusion",
            ]);
            try {
              const rows = counted
                ? (JSON.parse(counted) as { conclusion: string }[])
                : null;
              // This run failed even if the list lags behind it.
              if (rows)
                failedRuns = Math.max(
                  1,
                  rows.filter(
                    (r) =>
                      r.conclusion === "failure" ||
                      r.conclusion === "timed_out",
                  ).length,
                );
            } catch {
              // unreadable: retried, then reported as unknown below
            }
          }
          return {
            failed: {
              runUrl: run.url,
              step,
              tail,
              failedRuns,
              gaveUp: failedRuns !== null && failedRuns >= 3,
              ...(failedRuns === null && {
                note: `How many setup runs have failed is unknown (the list could not be read), so the three-run stop was not applied. See ${run.url}.`,
              }),
            },
          };
        }
        return {
          unknown: {
            runUrl: run.url,
            why: `The run ended as "${v.conclusion}", which setup does not read as pass or fail. See ${run.url}.`,
          },
        };
      }
    }
    if (now() - watchStart >= (a.timeoutMs ?? 30 * 60_000)) {
      return {
        unknown: {
          runUrl: run.url,
          why: `The run was still running after ${Math.round((a.timeoutMs ?? 30 * 60_000) / 60_000)} minutes, so its outcome is unknown, not failed. Follow it at ${run.url}.`,
        },
      };
    }
    await sleep(POLL_MS);
  }
}

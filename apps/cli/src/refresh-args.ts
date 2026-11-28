import { parseArgs } from "node:util";

/** What `--deliver` says now that delivery runs in a job of its own. */
export const DELIVER_MOVED =
  "--deliver now runs in a job of its own, apart from the app. Delete .github/workflows/demoman.yml on the default branch and run `npx demoman setup --ci` again.";

export type RefreshArgs = {
  only: string[];
  /** `--hand-off`: the folder the files and result are left in for `demoman deliver`. */
  handOff?: string;
  baseUrl?: string;
  outDir?: string;
  previous?: string;
  /** `--failures`: where each failed run's report and last still are kept. */
  failures?: string;
  /** `--check`: say whether anything is new since the last refresh. */
  check?: true;
  /** With `--check`: the commit the last successful refresh ran at. */
  since?: string;
};

/** `demoman refresh`'s arguments, or why they are refused. */
export function parseRefreshArgs(
  args: string[],
): RefreshArgs | { error: string } {
  let values: {
    "base-url"?: string;
    deliver?: string;
    "hand-off"?: string;
    "out-dir"?: string;
    previous?: string;
    failures?: string;
    check?: boolean;
    since?: string;
  };
  let positionals: string[];
  try {
    ({ values, positionals } = parseArgs({
      args,
      options: {
        "base-url": { type: "string" },
        deliver: { type: "string" },
        "hand-off": { type: "string" },
        "out-dir": { type: "string" },
        previous: { type: "string" },
        failures: { type: "string" },
        check: { type: "boolean" },
        since: { type: "string" },
      },
      allowPositionals: true,
      strict: true,
    }));
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
  if (values.deliver !== undefined) return { error: DELIVER_MOVED };
  if (
    values.check === true &&
    (positionals.length > 0 ||
      values["hand-off"] !== undefined ||
      values["base-url"] !== undefined ||
      values["out-dir"] !== undefined ||
      values.failures !== undefined)
  )
    return { error: "--check takes only --previous and --since" };
  if (values.since !== undefined && values.check !== true)
    return { error: "--since goes only with --check" };
  if (values.since !== undefined && !/^[0-9a-f]{7,40}$/.test(values.since))
    return { error: `--since is a commit sha, not "${values.since}"` };
  let baseUrl: string | undefined;
  const given = values["base-url"];
  if (given !== undefined) {
    const url = URL.canParse(given) ? new URL(given) : null;
    if (url === null || !/^https?:$/.test(url.protocol))
      return {
        error: `--base-url is an http(s) origin such as http://localhost:3000, not "${given}"`,
      };
    baseUrl = url.origin;
  }
  return {
    only: positionals,
    ...(values["hand-off"] === undefined
      ? {}
      : { handOff: values["hand-off"] }),
    ...(baseUrl === undefined ? {} : { baseUrl }),
    ...(values["out-dir"] === undefined ? {} : { outDir: values["out-dir"] }),
    ...(values.previous === undefined ? {} : { previous: values.previous }),
    ...(values.failures === undefined ? {} : { failures: values.failures }),
    ...(values.check === true ? { check: true as const } : {}),
    ...(values.since === undefined ? {} : { since: values.since }),
  };
}

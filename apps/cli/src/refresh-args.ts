import { parseArgs } from "node:util";

export type RefreshArgs = {
  only: string[];
  route?: "pr" | "main";
  baseUrl?: string;
  outDir?: string;
  previous?: string;
};

/** `demoman refresh`'s arguments, or why they are refused. */
export function parseRefreshArgs(
  args: string[],
): RefreshArgs | { error: string } {
  let values: {
    "base-url"?: string;
    deliver?: string;
    "out-dir"?: string;
    previous?: string;
  };
  let positionals: string[];
  try {
    ({ values, positionals } = parseArgs({
      args,
      options: {
        "base-url": { type: "string" },
        deliver: { type: "string" },
        "out-dir": { type: "string" },
        previous: { type: "string" },
      },
      allowPositionals: true,
      strict: true,
    }));
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
  if (values.deliver !== undefined && !/^(pr|main)$/.test(values.deliver))
    return { error: `--deliver is pr or main, not "${values.deliver}"` };
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
    ...(values.deliver === undefined
      ? {}
      : { route: values.deliver as "pr" | "main" }),
    ...(baseUrl === undefined ? {} : { baseUrl }),
    ...(values["out-dir"] === undefined ? {} : { outDir: values["out-dir"] }),
    ...(values.previous === undefined ? {} : { previous: values.previous }),
  };
}

// apps/runner/src/executor/pr-hook.ts
//
// The answer `demoman hook post-tool-use` prints for Claude Code's
// PostToolUse hook: after a tool call opened a pull request, remind the agent
// of the repo's pullRequests setting. The PR URL in the call's output is the
// evidence (Bash's tool_response carries no exit code): a `--web` create
// prints none, but one refused because the PR already exists prints that
// PR's URL, so the answer says the call named a PR and leaves "opened now"
// to the agent. Never silence on a failure: the answer says it
// could not check (docs/superpowers/specs/2026-10-25-pr-reminder-and-verdict-design.md).
import { resolvePullRequests } from "./pull-requests.js";

/** A pull request's URL on any host, so one opened on a GitHub Enterprise
 *  host is answered rather than read as an `off` repo. */
export const PR_URL = /https:\/\/([^/\s"]+)\/[^/\s"]+\/[^/\s"]+\/pull\/\d+/;

const GH_PR_CREATE = /\bgh\s+pr\s+create\b/;
const MCP_CREATE = /^mcp__.*github.*__create_pull_request$/i;

/** The URL's hostname, lowercased, without port or `www.`. */
function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

function answer(text: string): string {
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PostToolUse",
      additionalContext: text,
    },
  });
}

export function couldNotCheck(why: string): string {
  return answer(
    `Demoman could not check this repo's pull-request video setting (${why}). Call the demoman status tool and follow the recipe's Pull requests section.`,
  );
}

export async function postToolUseAnswer(
  stdin: string,
  home: string,
): Promise<string | null> {
  let call: {
    cwd?: unknown;
    tool_name?: unknown;
    tool_input?: { command?: unknown };
    tool_response?: unknown;
  };
  try {
    call = JSON.parse(stdin);
  } catch (error) {
    return couldNotCheck(
      `the hook's input is not JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (call === null || typeof call !== "object")
    return couldNotCheck("the hook's input is not an object");
  const opens =
    (call.tool_name === "Bash" &&
      typeof call.tool_input?.command === "string" &&
      GH_PR_CREATE.test(call.tool_input.command)) ||
    (typeof call.tool_name === "string" && MCP_CREATE.test(call.tool_name));
  if (!opens) return null;
  // A github.com URL wins over another host's the output merely mentions.
  const found = [
    ...JSON.stringify(call.tool_response ?? null).matchAll(
      new RegExp(PR_URL, "g"),
    ),
  ].map((m) => ({ url: m[0], host: hostOf(m[0]) }));
  const pick = found.find((f) => f.host === "github.com") ?? found[0];
  if (pick === undefined) return null;
  const { url, host } = pick;
  if (typeof call.cwd !== "string")
    return couldNotCheck("the hook's input names no cwd");
  let setting: Awaited<ReturnType<typeof resolvePullRequests>>;
  try {
    setting = await resolvePullRequests(call.cwd, home);
  } catch (error) {
    return couldNotCheck(
      error instanceof Error ? error.message : String(error),
    );
  }
  if ("unreadable" in setting) {
    return answer(
      `Demoman: that call names pull request ${url}, but this repo's Demoman pullRequests setting could not be read (${setting.unreadable}). That is not "off": tell the user. If that pull request was opened now, follow the recipe's Pull requests section.`,
    );
  }
  if (setting.value === "off") return null;
  if (host !== "github.com") {
    return answer(
      `Demoman: that call names pull request ${url}, on ${host}, and this repo's Demoman pullRequests setting is "${setting.value}", but attach works only on github.com. If that pull request was opened now, follow the recipe's Pull requests section with export({ videoId, maxMB: 9.5 }) in place of attach, giving the user its file.path to drag into the PR (call the recipe tool if it is not in context).`,
    );
  }
  return answer(
    `Demoman: that call names pull request ${url}, and this repo's Demoman pullRequests setting is "${setting.value}". If that pull request was opened now, follow the recipe's Pull requests section (call the recipe tool if it is not in context).`,
  );
}

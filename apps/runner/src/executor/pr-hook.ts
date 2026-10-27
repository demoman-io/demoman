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

export const PR_URL = /https:\/\/github\.com\/[^/\s"]+\/[^/\s"]+\/pull\/\d+/;

const GH_PR_CREATE = /\bgh\s+pr\s+create\b/;
const MCP_CREATE = /^mcp__.*github.*__create_pull_request$/i;

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
  const url = JSON.stringify(call.tool_response ?? null).match(PR_URL)?.[0];
  if (url === undefined) return null;
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
  return answer(
    `Demoman: that call names pull request ${url}, and this repo's Demoman pullRequests setting is "${setting.value}". If that pull request was opened now, follow the recipe's Pull requests section (call the recipe tool if it is not in context).`,
  );
}

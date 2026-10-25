#!/bin/sh
# Claude Code's PostToolUse hook (hooks.json): after a call that opened a
# pull request, `demoman hook post-tool-use` reminds the agent of the repo's
# pullRequests setting. $1 is the plugin's own Demoman version.
#
# The matcher sees only the tool name, so this runs on every Bash call: a
# call that cannot have opened a PR leaves here without starting node. One
# literal per pattern: `*gh*"pr create"*` rescans the rest of the input at
# every "gh", which took 45 s on a megabyte of output (final review I-1).
# shortcut: `gh  pr create` with two spaces skips the reminder, widen the
# pattern if agents write it so.
input=$(cat)
case "$input" in
  *create_pull_request*) ;;
  *"pr create"*) ;;
  *) exit 0 ;;
esac
# DEMOMAN_HOOK_COMMAND is for dev builds and tests, set in the environment
# Claude Code runs hooks in. `--prefix ~/` as in .mcp.json: the opened repo
# does not choose what runs.
if [ -n "$DEMOMAN_HOOK_COMMAND" ]; then
  set -- $DEMOMAN_HOOK_COMMAND
else
  set -- npx --prefix ~/ -y "demoman@$1"
fi
# Our own deadline, under hooks.json's 30 s: a hook Claude Code kills says
# nothing to anyone, so a CLI still running at it (npx fetching a new
# version, a hang) is stopped here and said as could-not-check.
limit=${DEMOMAN_HOOK_DEADLINE:-25}
out=$(mktemp "${TMPDIR:-/tmp}/demoman-hook.XXXXXX") || out=
if [ -z "$out" ]; then
  why="no temporary file could be made"
else
  # Both streams to the file: a child still holding our stderr would keep
  # Claude Code waiting past the kill.
  # shortcut: the kill stops the CLI's own process, not children it
  # started (npx's), which finish on their own; kill the group if one hangs.
  printf '%s' "$input" | "$@" hook post-tool-use >"$out" 2>&1 &
  cli=$!
  (sleep "$limit"; kill "$cli") >/dev/null 2>&1 &
  watch=$!
  wait "$cli"
  code=$?
  kill "$watch" >/dev/null 2>&1
  wait "$watch" 2>/dev/null # reaped quietly: no "Terminated" on stderr
  if [ "$code" -eq 0 ]; then
    # The CLI prints nothing when there is nothing to say (an `off` repo,
    # no PR URL), so only its exit says it failed. Its stderr is in the
    # file too; only a line of JSON is its answer.
    grep '^{' "$out"
    rm -f "$out"
    exit 0
  fi
  rm -f "$out"
  if [ "$code" -gt 128 ]; then
    why="the demoman hook did not answer within $limit s"
  else
    why="the demoman hook did not answer: exit $code"
  fi
fi
printf '%s\n' "{\"hookSpecificOutput\":{\"hookEventName\":\"PostToolUse\",\"additionalContext\":\"Demoman could not check this repo's pull-request video setting ($why). Call the demoman status tool and follow the recipe's Pull requests section.\"}}"
exit 0

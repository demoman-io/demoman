#!/bin/sh
# Claude Code's PostToolUse hook (hooks.json): after a call that opened a
# pull request, `demoman hook post-tool-use` reminds the agent of the repo's
# pullRequests setting. $1 is the plugin's own Demoman version.
#
# The matcher sees only the tool name, so this runs on every Bash call: a
# call that cannot have opened a PR leaves here without starting node.
# shortcut: `gh  pr create` with two spaces skips the reminder, widen the
# pattern if agents write it so.
input=$(cat)
case "$input" in
  *create_pull_request*) ;;
  *gh*"pr create"*) ;;
  *) exit 0 ;;
esac
# DEMOMAN_HOOK_COMMAND is for dev builds and tests; it comes from the user's
# environment, never from the repo. `--prefix ~/` as in .mcp.json: the
# opened repo does not choose what runs.
if [ -n "$DEMOMAN_HOOK_COMMAND" ]; then
  answer=$(printf '%s' "$input" | $DEMOMAN_HOOK_COMMAND hook post-tool-use)
else
  answer=$(printf '%s' "$input" | npx --prefix ~/ -y "demoman@$1" hook post-tool-use)
fi
code=$?
# The CLI prints nothing when there is nothing to say (an `off` repo, no PR
# URL), so only its exit says it failed. A hook that fails is shown to no
# one: say so to the agent instead, and still exit 0.
if [ "$code" -ne 0 ]; then
  printf '%s\n' "{\"hookSpecificOutput\":{\"hookEventName\":\"PostToolUse\",\"additionalContext\":\"Demoman could not check this repo's pull-request video setting (the demoman hook did not answer: exit $code). Call the demoman status tool and follow the recipe's Pull requests section.\"}}"
  exit 0
fi
[ -n "$answer" ] && printf '%s\n' "$answer"
exit 0

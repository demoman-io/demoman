#!/bin/sh
# Updating a CI install in one pull request (DEM-241), end to end, with this
# checkout's build: a throwaway private GitHub repo whose default branch
# already holds the workflow an older release wrote (0.9.8, rendered from
# that release's own source) with a push trigger, the main route and the
# artifact, none of them setup's default. This checkout's `setup --ci --yes`
# runs there with no flag, and the trial reads what it opened.
#
#   ci-update-trial.sh <owner>
#
# Build first (`pnpm -r build`). setup's check records the repo's one flow
# in Demoman's own headless browser. Prints setup's lines, then one line per
# check, each "ok" or "WRONG": the pull request's title, that it changes
# the workflow alone, and that the new workflow keeps the trigger, route and
# artifact and names this release. Exits 1 when any is WRONG. The repo is
# deleted at the end unless KEEP=1; deleting needs gh's delete_repo scope
# (`gh auth refresh -h github.com -s delete_repo`), and the line says so
# when it is missing.
set -eu
[ $# -eq 1 ] || { echo "usage: ci-update-trial.sh <owner>" >&2; exit 2; }
owner=$1
from=8a4ccc20 # release: demoman 0.9.8
here=$(cd "$(dirname "$0")/../../.." && pwd)
pkg="$here/apps/cli/pkg"
work=$(mktemp -d "${TMPDIR:-/tmp}/ci-update-trial.XXXXXX")
slug="$owner/demoman-ci-update-trial-$(date +%Y%m%d%H%M%S)"
version=$(node -p "require('$pkg/package.json').version")
say() { echo "ci-update-trial: $*"; }
wrong=0
check() { # <what> <0 when it holds>
  if [ "$2" -eq 0 ]; then say "ok: $1"; else say "WRONG: $1"; wrong=1; fi
}

# The bundle leaves its dependencies external: installed beside it, again
# whenever its package.json changes, with dev-demoman.sh's own stamp.
stamp="$pkg/node_modules/.dev-demoman-package.json"
if ! cmp -s "$pkg/package.json" "$stamp"; then
  say "installing the bundle's dependencies into $pkg"
  (cd "$pkg" && npm install --omit=dev --no-package-lock --workspaces=false \
    --no-audit --no-fund >/dev/null) || { say "npm install in $pkg failed" >&2; exit 1; }
  cp "$pkg/package.json" "$stamp"
fi

# 0.9.8's workflow, from 0.9.8's source; its packages resolve from apps/cli.
mkdir "$work/old"
git -C "$here" archive "$from" apps/cli/src | tar -x -C "$work/old"
cat >"$work/render.ts" <<EOF
import { ciWorkflow } from "$work/old/apps/cli/src/ci-workflow.ts";
process.stdout.write(ciWorkflow({
  version: "0.9.8",
  trigger: "push",
  route: "main",
  branch: "main",
  artifact: true,
  app: { appVersion: 1, install: [], start: "python3 -m http.server 4173", url: "http://localhost:4173", timeoutSeconds: 120, env: {}, secrets: [], services: {} },
  secrets: { accounts: [], app: [] },
}));
EOF
render="$here/apps/cli/node_modules/.ci-update-trial-render.mjs"
"$here/apps/cli/node_modules/.bin/esbuild" "$work/render.ts" --bundle --platform=node --format=esm \
  --packages=external --log-level=warning --outfile="$render"
mkdir -p "$work/repo/.github/workflows" "$work/repo/.demoman/flows"
node "$render" >"$work/repo/.github/workflows/demoman.yml"
rm -f "$render"
old="$work/repo/.github/workflows/demoman.yml"
grep -q 'demoman@0.9.8 refresh --deliver main --out-dir demoman-out' "$old" || {
  say "the rendered 0.9.8 workflow has no refresh line for main with the artifact:" >&2
  grep -n refresh "$old" >&2
  exit 1
}

cat >"$work/repo/index.html" <<'EOF'
<!doctype html>
<html><head><meta charset="utf-8"><title>Trial</title>
<style>body{font:16px system-ui;margin:40px}button{font:inherit;padding:8px 16px}</style>
</head><body><h1>Invoices</h1><p id="said">Nothing saved yet.</p>
<button onclick="document.getElementById('said').textContent='Saved.'">Save</button>
</body></html>
EOF
cat >"$work/repo/.demoman/app.json" <<'EOF'
{ "appVersion": 1, "install": [], "start": "python3 -m http.server 4173", "url": "http://localhost:4173" }
EOF
cat >"$work/repo/.demoman/flows/save.json" <<'EOF'
{
  "keptVersion": 2,
  "flow": "3f0b6c1e-2a4d-4e7b-9c1a-5d6e7f8a9b0c",
  "name": "Save an invoice",
  "script": {
    "scriptVersion": 1,
    "name": "Save an invoice",
    "target": "http://localhost:4173/",
    "steps": [{ "do": "waitForLoad" }, { "do": "click", "on": { "role": "button", "name": "Save" } }, { "do": "pause", "ms": 600 }]
  },
  "scale": 2,
  "logo": null,
  "deliver": "commit",
  "outputs": [{ "path": "docs/save.mp4", "fileType": "mp4", "aspect": "auto", "quality": "share" }],
  "report": null
}
EOF

cd "$work/repo"
git init -q -b main
git add -A
# [skip demoman]: the old workflow's push run would record and commit to main.
git -c user.name=trial -c user.email=trial@example.com commit -q -m "trial: a page, a flow and 0.9.8's workflow [skip demoman]"
say "creating $slug (private)"
gh repo create "$slug" --private --source . --push >/dev/null

say "running this checkout's setup --ci --yes ($version)"
# Its exit is said, not hidden: the checks below then read what it opened.
node "$pkg/dist/demoman.mjs" setup --ci --yes >"$work/setup.log" 2>&1 && code=0 || code=$?
cat "$work/setup.log"
say "setup --ci exited $code"

echo "--- the pull request"
pr=$(gh pr view demoman/setup -R "$slug" --json title,files --jq '.title + "\t" + ([.files[].path] | join(","))' 2>/dev/null || echo "")
title=$(printf '%s' "$pr" | cut -f1)
files=$(printf '%s' "$pr" | cut -f2)
say "title: $title; files: $files"
[ "$title" = "Update Demoman's workflow" ]; check "titled as an update" $?
[ "$files" = ".github/workflows/demoman.yml" ]; check "changes the workflow alone" $?
new="$work/new.yml"
gh api "repos/$slug/contents/.github/workflows/demoman.yml?ref=demoman/setup" --jq .content 2>/dev/null |
  base64 --decode >"$new" 2>/dev/null || : >"$new"
grep -q '^  push:$' "$new"; check "keeps the push trigger" $?
grep -q "demoman@$version refresh --deliver main --out-dir demoman-out" "$new"; check "keeps the main route and the artifact, at $version" $?
grep -q "^Updates .github/workflows/demoman.yml, already on main (written by 0.9.8), to $version's.$" "$work/setup.log"
check "the plan said what it updates" $?

cd "$here"
if [ "${KEEP:-}" = 1 ]; then
  say "kept $slug and $work"
elif gh repo delete "$slug" --yes >/dev/null 2>&1; then
  rm -rf "$work"
  say "deleted $slug"
else
  say "could not delete $slug (gh needs delete_repo: gh auth refresh -h github.com -s delete_repo, then gh repo delete $slug --yes); $work kept"
fi
exit "$wrong"

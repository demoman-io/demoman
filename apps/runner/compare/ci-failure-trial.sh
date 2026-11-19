#!/bin/sh
# A failed flow in CI, end to end, with this checkout's build and no release
# (DEM-118, 146, 147): a throwaway private GitHub repo holding a static page
# and two hand-written flows, one whose target the page does not have. The
# workflow is the one `setup --ci` writes (push trigger, pr route), rendered
# from this checkout's source, with every `npx demoman@<version>` pointed at
# the packed `apps/cli/pkg` committed beside it.
#
#   ci-failure-trial.sh <owner>
#
# Build first (`pnpm -r build`). Prints the refresh's failed line, the files
# in the run's demoman-failed artifact (the still's size read from its PNG
# header) and the refresh pull request's "Not refreshed:" entry. The repo is
# deleted at the end unless KEEP=1; deleting needs gh's delete_repo scope
# (`gh auth refresh -h github.com -s delete_repo`), and the line says so when
# it is missing.
set -eu
[ $# -eq 1 ] || { echo "usage: ci-failure-trial.sh <owner>" >&2; exit 2; }
owner=$1
here=$(cd "$(dirname "$0")/../../.." && pwd)
work=$(mktemp -d "${TMPDIR:-/tmp}/ci-failure-trial.XXXXXX")
slug="$owner/demoman-ci-failure-trial-$(date +%Y%m%d%H%M%S)"
version=$(node -p "require('$here/apps/cli/pkg/package.json').version")
say() { echo "ci-failure-trial: $*"; }

say "packing $here/apps/cli/pkg ($version)"
(cd "$here/apps/cli/pkg" && npm pack --silent --pack-destination "$work" >/dev/null)
mkdir "$work/repo"
mv "$work/demoman-$version.tgz" "$work/repo/demoman.tgz"

# The workflow as setup writes it, from this checkout's source.
cat >"$work/render.ts" <<EOF
import { ciWorkflow } from "$here/apps/cli/src/ci-workflow.ts";
process.stdout.write(ciWorkflow({
  version: "$version",
  trigger: "push",
  route: "pr",
  app: { appVersion: 1, install: [], start: "python3 -m http.server 4173", url: "http://localhost:4173", timeoutSeconds: 120, env: {}, secrets: [], services: {} },
  secrets: { accounts: [], app: [] },
}));
EOF
# Its packages stay external, read from apps/cli's own node_modules.
render="$here/apps/cli/node_modules/.ci-failure-trial-render.mjs"
"$here/apps/cli/node_modules/.bin/esbuild" "$work/render.ts" --bundle --platform=node --format=esm \
  --packages=external --log-level=warning --outfile="$render"
mkdir -p "$work/repo/.github/workflows" "$work/repo/.demoman/flows"
# Every npx line runs the packed build instead of the release.
node "$render" |
  sed "s|-y demoman@$version|-y --package=\"\$GITHUB_WORKSPACE/demoman.tgz\" demoman|" \
    >"$work/repo/.github/workflows/demoman.yml"
rm -f "$render"
grep -q 'demoman.tgz" demoman refresh --deliver pr --failures demoman-failed$' "$work/repo/.github/workflows/demoman.yml" || {
  say "the rendered workflow has no packed refresh line with --failures:" >&2
  grep -n "refresh" "$work/repo/.github/workflows/demoman.yml" >&2
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
# One flow that works and one whose link the page never had: the run stops
# with unresolvedAnchor, which a new recording fixes.
flow() { # <file> <name> <uuid> <mp4> <step>
  cat >"$work/repo/.demoman/flows/$1.json" <<EOF
{
  "keptVersion": 2,
  "flow": "$3",
  "name": "$2",
  "script": {
    "scriptVersion": 1,
    "name": "$2",
    "target": "http://localhost:4173/",
    "steps": [{ "do": "waitForLoad" }, $5, { "do": "pause", "ms": 600 }]
  },
  "scale": 2,
  "logo": null,
  "deliver": "commit",
  "outputs": [{ "path": "$4", "fileType": "mp4", "aspect": "auto", "quality": "share" }],
  "report": null
}
EOF
}
flow save "Save an invoice" 3f0b6c1e-2a4d-4e7b-9c1a-5d6e7f8a9b0c docs/save.mp4 \
  '{ "do": "click", "on": { "role": "button", "name": "Save" } }'
flow reports "Open the reports" 7a1c2b3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d docs/reports.mp4 \
  '{ "do": "click", "on": { "role": "link", "name": "Reports" } }'

cd "$work/repo"
git init -q -b main
git add -A
git -c user.name=trial -c user.email=trial@example.com commit -q -m "trial: a page and two flows"
say "creating $slug (private)"
gh repo create "$slug" --private --source . --push >/dev/null
# setup --ci asks for this: the workflow's token opens the refresh PR.
gh api -X PUT "repos/$slug/actions/permissions/workflow" \
  -f default_workflow_permissions=write -F can_approve_pull_request_reviews=true

say "waiting for the push's run"
run=""
for _ in $(seq 1 30); do
  run=$(gh run list -R "$slug" --workflow demoman.yml --json databaseId --jq '.[0].databaseId // ""')
  [ -n "$run" ] && break
  sleep 5
done
[ -n "$run" ] || { say "no run started on $slug" >&2; exit 1; }
gh run watch "$run" -R "$slug" --exit-status >/dev/null 2>&1 && code=0 || code=$?
say "run https://github.com/$slug/actions/runs/$run ended $(gh run view "$run" -R "$slug" --json conclusion --jq .conclusion) (watch exit $code)"

echo "--- the refresh's lines"
gh run view "$run" -R "$slug" --log | grep -E ': (failed|added|uncompared|changed|unchanged)(: |$)|delivered: ' |
  sed -E 's/^[^\t]*\t[^\t]*\t[0-9TZ:.-]+ //' || say "no refresh line in the log"

echo "--- the demoman-failed artifact"
if gh run download "$run" -R "$slug" --name demoman-failed --dir "$work/failed" 2>/dev/null; then
  (cd "$work/failed" && find . -type f | sort)
  for png in "$work"/failed/*/final-still.png; do
    [ -f "$png" ] && node -e "const b=require('fs').readFileSync(process.argv[1]);console.log(process.argv[1].split('/').slice(-2).join('/')+': PNG '+b.readUInt32BE(16)+'x'+b.readUInt32BE(20))" "$png"
  done
  for r in "$work"/failed/*/report.json; do
    [ -f "$r" ] && node -e "const r=require(process.argv[1]);console.log('report: outcome '+r.outcome+', stopped '+(r.stopped&&r.stopped.reason)+', still '+JSON.stringify(r.still)+', '+(r.frames&&r.frames.spans)+' span(s): '+r.summary)" "$r"
  done
else
  say "the run has no demoman-failed artifact"
fi

echo "--- the refresh pull request's body"
gh pr view demoman/refresh -R "$slug" --json body --jq .body 2>/dev/null || say "no refresh pull request"

cd "$here"
if [ "${KEEP:-}" = 1 ]; then
  say "kept $slug and $work"
elif gh repo delete "$slug" --yes >/dev/null 2>&1; then
  rm -rf "$work"
  say "deleted $slug"
else
  say "could not delete $slug (gh needs delete_repo: gh auth refresh -h github.com -s delete_repo, then gh repo delete $slug --yes); $work kept"
fi

#!/bin/sh
# A demo account's own files, never committed, carried by setup,
# end to end, with this checkout's build: a throwaway private GitHub repo
# whose app signs its demo account in through a dev-only page the agent
# wrote and nobody committed. setup's check runs from a clean checkout, so
# that page is not there unless setup carries it.
#
#   account-files-trial.sh <owner>
#
# Build first (`pnpm -r build`). Runs this checkout's `setup --ci --yes`
# twice, each check recording the repo's one flow in Demoman's own headless
# browser: first with the account listing no `files` (the check fails, and
# its stop names the account), then listing the page (the check passes, and
# the pull request carries the page). The setup run CI then starts pins the
# release this build calls itself: one from before `files` (0.9.9 or older)
# refuses accounts.json, so that run is red and the trial does not read it.
# Prints setup's lines, then one line
# per check, each "ok" or "WRONG"; exits 1 when any is WRONG. The repo is
# deleted at the end unless KEEP=1; deleting needs gh's delete_repo scope
# (`gh auth refresh -h github.com -s delete_repo`), and the line says so
# when it is missing.
set -eu
[ $# -eq 1 ] || { echo "usage: account-files-trial.sh <owner>" >&2; exit 2; }
owner=$1
here=$(cd "$(dirname "$0")/../../.." && pwd)
pkg="$here/apps/cli/pkg"
work=$(mktemp -d "${TMPDIR:-/tmp}/account-files-trial.XXXXXX")
slug="$owner/demoman-account-files-trial-$(date +%Y%m%d%H%M%S)"
say() { echo "account-files-trial: $*"; }
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

repo="$work/repo"
mkdir -p "$repo/.demoman/flows" "$repo/dev"
# The app: a dashboard behind a cookie, a sign-in page with a password field.
cat >"$repo/dashboard.html" <<'EOF'
<!doctype html>
<html><head><meta charset="utf-8"><title>Dashboard</title>
<script>if (!document.cookie.includes("user=seller")) location.replace("/login.html");</script>
<style>body{font:16px system-ui;margin:40px}button{font:inherit;padding:8px 16px}</style>
</head><body><h1>Invoices</h1><p id="said">Nothing saved yet.</p>
<button onclick="document.getElementById('said').textContent='Saved.'">Save</button>
</body></html>
EOF
cat >"$repo/login.html" <<'EOF'
<!doctype html>
<html><head><meta charset="utf-8"><title>Sign in</title></head><body>
<h1>Sign in</h1><form><label>Password <input type="password" name="p"></label></form>
</body></html>
EOF
cat >"$repo/.demoman/app.json" <<'EOF'
{ "appVersion": 1, "install": [], "start": "python3 -m http.server 4174", "url": "http://localhost:4174" }
EOF
cat >"$repo/.demoman/flows/save.json" <<'EOF'
{
  "keptVersion": 2,
  "flow": "7a1c2e3d-4b5f-4c6a-8d7e-9f0a1b2c3d4e",
  "name": "Save an invoice",
  "script": {
    "scriptVersion": 1,
    "name": "Save an invoice",
    "target": "http://localhost:4174/dashboard.html",
    "account": "seller",
    "steps": [{ "do": "waitForLoad" }, { "do": "click", "on": { "role": "button", "name": "Save" } }, { "do": "pause", "ms": 600 }]
  },
  "scale": 2,
  "logo": null,
  "deliver": "commit",
  "outputs": [{ "path": "docs/save.mp4", "fileType": "mp4", "aspect": "auto", "quality": "share" }],
  "report": null
}
EOF

cd "$repo"
git init -q -b main
git add -A
git -c user.name=trial -c user.email=trial@example.com commit -q -m "trial: an app behind a sign-in, and a flow"
say "creating $slug (private)"
# The repo goes at any exit from here, set -e's included.
cleanup() {
  cd "$here"
  if [ "${KEEP:-}" = 1 ]; then
    say "kept $slug and $work"
  elif gh repo delete "$slug" --yes >/dev/null 2>&1; then
    rm -rf "$work"
    say "deleted $slug"
  else
    say "could not delete $slug (gh needs delete_repo: gh auth refresh -h github.com -s delete_repo, then gh repo delete $slug --yes); $work kept"
  fi
}
trap cleanup EXIT
gh repo create "$slug" --private --source . --push >/dev/null

# What the agent wrote and left uncommitted: the dev-only sign-in page and
# the account that signs in through it.
cat >"$repo/dev/sign-in-as.html" <<'EOF'
<!doctype html>
<html><head><meta charset="utf-8"><title>Dev sign-in</title>
<script>document.cookie = "user=seller; path=/"; location.replace("/dashboard.html");</script>
</head><body></body></html>
EOF
accounts() { # [files JSON]
  files=""
  [ $# -eq 0 ] || files=", \"files\": $1"
  cat >"$repo/.demoman/accounts.json" <<EOF
{
  "accountsVersion": 1,
  "sites": {
    "http://localhost:4174": {
      "default": "seller",
      "accounts": {
        "seller": {
          "about": "A seller with no invoices saved",
          "checkUrl": "/dashboard.html",
          "signIn": [{ "do": "goto", "url": "/dev/sign-in-as.html" }]$files
        }
      }
    }
  }
}
EOF
}
setup() { # <log>
  node "$pkg/dist/demoman.mjs" setup --ci --yes >"$1" 2>&1 && code=0 || code=$?
  cat "$1"
  say "setup --ci exited $code"
}

echo "--- 1. the account lists no files"
accounts
setup "$work/setup-1.log"
# Each test as `cmd && r=0 || r=1`: under set -e a bare failing grep would
# end the trial before the repo is deleted.
grep -q "the files that make account seller (a seed, a sign-in route) must be committed" "$work/setup-1.log" && r=0 || r=1
check "the failed check names the account and its files" $r
gh pr view demoman/setup -R "$slug" >/dev/null 2>&1 && r=1 || r=0
check "nothing was opened" $r

echo "--- 2. the account lists its sign-in page"
accounts '["dev/sign-in-as.html"]'
setup "$work/setup-2.log"
files=$(gh pr view demoman/setup -R "$slug" --json files --jq '[.files[].path] | sort | join(",")' 2>/dev/null || echo "")
say "pull request files: $files"
printf '%s' "$files" | grep -q 'dev/sign-in-as.html' && r=0 || r=1
check "the pull request carries the sign-in page" $r
printf '%s' "$files" | grep -q '.demoman/accounts.json' && r=0 || r=1
check "the pull request carries accounts.json" $r
grep -q "dev/sign-in-as.html" "$work/setup-2.log" && r=0 || r=1
check "the plan named the page" $r

exit "$wrong"

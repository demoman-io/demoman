#!/bin/sh
# A house app's refresh trial on this machine with the repo's own build: no
# release, no CI (DEM-176 was reproduced and fixed this way).
#
#   house-trial.sh <app checkout> <rounds> [flow…]
#
# Records the flows once and commits the result as a local baseline on a
# detached HEAD (the branch is left as it was), then refreshes <rounds> times
# against it, putting the baseline back after each round. Each round prints
# one verdict line per flow; the last line counts the unchanged ones. Logs and
# each round's receipts are kept in <checkout>/.house-trial/.
#
# DEMOMAN is the command to run (default `demoman`, which on the author's PATH
# is internal/tools/dev-demoman.sh, the main checkout's build). COLD=1 wipes
# the app's build caches before every refresh, as a fresh CI checkout starts.
set -eu
[ $# -ge 2 ] || { echo "usage: house-trial.sh <app checkout> <rounds> [flow…]" >&2; exit 2; }
app=$1; rounds=$2; shift 2
dm=${DEMOMAN:-demoman}
cd "$app"
out=.house-trial
exclude=$(git rev-parse --git-path info/exclude)
mkdir -p "$out" "$(dirname "$exclude")"
grep -qx "$out/" "$exclude" 2>/dev/null || echo "$out/" >> "$exclude"
# The baseline commits everything the refresh wrote, and each round ends in
# `git reset --hard`: nothing of the author's may be uncommitted or untracked.
if [ -n "$(git status --porcelain)" ]; then
  echo "house-trial: $app has uncommitted or untracked files; commit, stash or ignore them first" >&2
  git status --short >&2
  exit 1
fi

cold() { [ "${COLD:-}" = 1 ] && rm -rf node_modules/.cache node_modules/.vite .nuxt .next/cache || true; }
# One line per flow: `<name>: <outcome>[: <detail>]` (apps/cli/src/refresh-lines.ts).
verdicts() { grep -E '^[^ ].*: (changed|added|uncompared|unchanged|failed)(: |$)' "$1" || true; }

echo "house-trial: $($dm --version) on $(uname -sm), $(git rev-parse --short HEAD)"
git switch -q --detach
cold; $dm refresh "$@" >"$out/baseline.log" 2>&1 || echo "house-trial: baseline refresh exited $? (see $out/baseline.log)"
verdicts "$out/baseline.log" | sed 's/^/baseline: /'
git add -A
if git diff --cached --quiet; then
  echo "house-trial: the baseline left the receipts as they were"
else
  git commit -q -m "house-trial: local baseline (do not push)" || {
    echo "house-trial: the baseline could not be committed (above), so there is nothing to compare against" >&2
    exit 1
  }
fi
base=$(git rev-parse HEAD)

total=0; same=0; i=1
while [ "$i" -le "$rounds" ]; do
  code=0
  cold; $dm refresh "$@" >"$out/round-$i.log" 2>&1 || code=$?
  [ "$code" -eq 0 ] || echo "round $i: refresh exited $code (see $out/round-$i.log)"
  v=$(verdicts "$out/round-$i.log")
  if [ -z "$v" ]; then
    echo "round $i: no verdict at all (see $out/round-$i.log)"
  else
    echo "$v" | sed "s/^/round $i: /"
    total=$((total + $(echo "$v" | wc -l)))
    same=$((same + $(echo "$v" | grep -cE ': unchanged(: |$)' || true)))
  fi
  if [ -d .demoman/receipts ]; then
    rm -rf "$out/round-$i.receipts" && cp -R .demoman/receipts "$out/round-$i.receipts"
  else
    echo "round $i: wrote no receipts"
  fi
  git reset -q --hard "$base"
  i=$((i + 1))
done
echo "house-trial: $same of $total unchanged over $rounds round(s); the checkout is detached at the baseline (\`git switch -\` goes back)"

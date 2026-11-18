#!/usr/bin/env bash
# The gate's `changes` step, one copy for ci-ts.yml and linux.yml: does this
# event touch product code, the paths the workflow's own `push` filters on?
# Writes product=true|false to $GITHUB_OUTPUT. A failed `gh api` or `yq`
# fails the step, rather than reading as "no product change".
#
# usage: changes.sh <workflow file>; reads EVENT, PR, GITHUB_REPOSITORY.
# scripts/ci-changes.test.mjs runs it against stub `gh` and `yq`.
set -euo pipefail
workflow=$1
product=true
summary="not a pull request"
if [ "$EVENT" = pull_request ]; then
  product=false
  pages=$(gh api --paginate --slurp "repos/$GITHUB_REPOSITORY/pulls/$PR/files")
  total=$(gh api "repos/$GITHUB_REPOSITORY/pulls/$PR" --jq .changed_files)
  listed=$(jq '[.[][]] | length' <<<"$pages")
  files=$(jq -r '.[][] | .filename, (.previous_filename // empty)' <<<"$pages")
  globs=$(yq '.on.push.paths[]' "$workflow")
  [ -n "$globs" ] || { echo "::error::no on.push.paths in $workflow"; exit 1; }
  [ -n "$files" ] || { echo "::error::the PR's file list came back empty"; exit 1; }
  while IFS= read -r f; do
    while IFS= read -r g; do
      # Unquoted on purpose: in [[ ]] the glob's * also crosses /.
      if [[ $f == $g ]]; then product=true; fi
    done <<<"$globs"
  done <<<"$files"
  summary="$listed of the PR's $total files listed"
  # The files API stops at 3,000, and a push between the two reads moves
  # the count. A short list could read as touching no product path, so it
  # runs everything instead (DEM-225).
  if [ "$listed" != "$total" ]; then
    echo "::warning::the files API listed $listed of the PR's $total changed files (it stops at 3,000, or a push landed between the two reads), so every product job runs"
    product=true
  fi
fi
echo "changes: product=$product ($summary)"
echo "product=$product" >> "$GITHUB_OUTPUT"

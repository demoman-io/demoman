#!/usr/bin/env bash
# Third-party sample apps for filming, kept outside this repo.
#
#   scripts/samples.sh setup [app…]   clone at the pinned commit, install, prepare
#   scripts/samples.sh start <app>     run it in the foreground on its port
#
# Apps live in $DEMOMAN_SAMPLES (default ~/Code/demoman-samples). Each one's
# compare script is apps/runner/compare/scripts/<app>.json.
set -euo pipefail

ROOT="${DEMOMAN_SAMPLES:-$HOME/Code/demoman-samples}"
PATCHES="$(cd "$(dirname "$0")" && pwd)/samples"
APPS=(tremor excalidraw chatbot actual)

# app  repo  commit  port  license
spec() {
  case "$1" in
    tremor)     echo "tremorlabs/template-dashboard ac673531b124244b75fef5c750df1fa9ee783d4a 4301 MIT" ;;
    excalidraw) echo "excalidraw/excalidraw 1d4dc2c0e6e476911d0760e9c3cf3694f2d43384 4302 MIT" ;;
    chatbot)    echo "vercel/chatbot c2f8235e1f3ea903ad8b7f61447c4f74164b5c58 4303 Apache-2.0" ;;
    # Actual hard-codes 3001 in packages/desktop-client/bin/watch-browser.
    actual)     echo "actualbudget/actual 9e80790d6813de89304dad3a7452d7ee31dea816 3001 MIT" ;;
    *) echo "unknown app '$1' (one of: ${APPS[*]})" >&2; exit 2 ;;
  esac
}

clone() { # app repo commit
  local dir="$ROOT/$1"
  if [ ! -d "$dir/.git" ]; then
    git init -q "$dir"
    git -C "$dir" remote add origin "https://github.com/$2.git"
  fi
  if [ "$(git -C "$dir" rev-parse HEAD 2>/dev/null)" != "$3" ]; then
    git -C "$dir" fetch -q --depth 1 origin "$3"
    git -C "$dir" checkout -q --detach FETCH_HEAD
  fi
}

setup() {
  local app=$1 repo commit port license s
  s=$(spec "$app") # a bare assignment, so an unknown app stops the script under set -e
  read -r repo commit port license <<<"$s"
  echo "== $app ($repo @ ${commit:0:8}, $license)"
  clone "$app" "$repo" "$commit"
  cd "$ROOT/$app"
  case "$app" in
    # pnpm 11 fails on skipped dependency builds; the ones skipped here are lint-only.
    tremor) pnpm install --frozen-lockfile --config.strict-dep-builds=false ;;
    excalidraw) corepack yarn install --frozen-lockfile ;;
    actual) yarn install --immutable ;;
    chatbot)
      pnpm install --frozen-lockfile --config.strict-dep-builds=false
      # Every model goes to the mock, and its weather answer streams long enough to film.
      git apply --reverse --check "$PATCHES/chatbot.patch" 2>/dev/null || git apply "$PATCHES/chatbot.patch"
      if [ ! -f .env.local ]; then
        # PLAYWRIGHT switches lib/ai/providers.ts to its mock models: no API key, same answer every run.
        cat >.env.local <<EOF
AUTH_SECRET=$(openssl rand -base64 32)
POSTGRES_URL=postgres://localhost:5432/demoman_chatbot
PLAYWRIGHT=1
EOF
      fi
      psql -lqt | cut -d'|' -f1 | grep -qw demoman_chatbot || createdb demoman_chatbot
      set -a; . ./.env.local; set +a
      pnpm db:migrate
      ;;
  esac
}

start() {
  local app=$1 repo commit port license s
  s=$(spec "$app") # a bare assignment, so an unknown app stops the script under set -e
  read -r repo commit port license <<<"$s"
  cd "$ROOT/$app" || { echo "$app is not set up: scripts/samples.sh setup $app" >&2; exit 1; }
  echo "$app on http://localhost:$port"
  case "$app" in
    tremor) exec pnpm exec next dev -p "$port" ;;
    excalidraw) VITE_APP_PORT=$port exec corepack yarn start ;;
    chatbot) exec pnpm exec next dev --turbo -p "$port" ;;
    actual) exec yarn start ;;
  esac
}

case "${1:-}" in
  setup)
    shift
    [ $# -gt 0 ] || set -- "${APPS[@]}"
    for app in "$@"; do (setup "$app"); done
    ;;
  start) [ -n "${2:-}" ] || { echo "usage: $0 start <${APPS[*]// /|}>" >&2; exit 2; }; start "$2" ;;
  *) echo "usage: $0 setup [app…] | start <app>" >&2; exit 2 ;;
esac

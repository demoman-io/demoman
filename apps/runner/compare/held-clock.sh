#!/bin/sh
# A house app's kept flows on a held clock, measured on this machine with this
# checkout's build (`pnpm -r build` first): no release, no CI.
#
#   held-clock.sh <app checkout> <out dir> [flow…]
#
# Records each flow held twice and once in real time (today's capture),
# exports every recording to <out dir>/{held-1,held-2,real}/<flow>.mp4 and
# prints per flow: held frames, step frames, change frames, network
# stretches (label, ms), record time and video length, and whether the two
# held runs' timing matches outside network stretches. The app must already
# be serving at its app.json url (`pnpm dev` there); its `reset` (app.json,
# or RESET=…) runs before each recording. Nothing in the checkout is written.
set -eu
[ $# -ge 2 ] || { echo "usage: held-clock.sh <app checkout> <out dir> [flow…]" >&2; exit 2; }
app=$1; out=$2; shift 2
here=$(cd "$(dirname "$0")" && pwd)
mjs="$here/held-clock.mjs"
for pass in held-1 held-2 real; do
  case $pass in held-*) held=1 ;; *) held=0 ;; esac
  echo "held-clock: $pass" >&2
  DEMOMAN_HELD_CLOCK=$held node "$mjs" record --app "$app" --out "$out/$pass" "$@" ||
    echo "held-clock: $pass: a flow did not record (its json says why)" >&2
done
node "$mjs" compare "$out/held-1" "$out/held-2" "$out/real"

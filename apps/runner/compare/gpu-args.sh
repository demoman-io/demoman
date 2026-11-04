#!/usr/bin/env bash
# gpu-args.mjs on a Linux machine that is not one of our CI runners: a free
# Colab or Kaggle notebook with an NVIDIA T4. In a notebook cell:
#   !git clone https://github.com/demoman-io/demoman && bash demoman/apps/runner/compare/gpu-args.sh
# Installs only what is missing (Node 24, pnpm, Chromium and its libraries,
# and NVIDIA's Vulkan userspace when nvidia-smi answers), builds, and runs
# gpu-args.mjs on the public fixture app. ROUNDS=2 for a second round; one by
# default, since a notebook's 2 CPUs make each CPU-drawn export slow.
#
# The lines that answer the question: "GPU:" and "vulkan:" say what the
# machine offers, and gpu-args.mjs's summary says what each flag set did to
# the render. A Vulkan set that renders like `none` drew on the CPU, whatever
# its WebGL line says.
set -euo pipefail
cd "$(dirname "$0")/../../.."
say() { echo "[gpu-args.sh] $*"; }
[ "$(uname -s)" = Linux ] || { say "Linux only; on a Mac run gpu-args.mjs directly"; exit 2; }
SUDO=""
[ "$(id -u)" = 0 ] || SUDO=sudo

if ! node -v 2>/dev/null | grep -qE '^v(2[4-9]|[3-9][0-9])\.'; then
  say "installing Node 24 (found $(node -v 2>/dev/null || echo none))"
  curl -fsSL https://deb.nodesource.com/setup_24.x | $SUDO bash -
  $SUDO apt-get install -y -qq nodejs
fi
pnpm_version=$(node -p "require('./package.json').packageManager.split('@')[1]")
pnpm -v 2>/dev/null | grep -qx "$pnpm_version" || $SUDO npm install -g --silent "pnpm@$pnpm_version"

if command -v nvidia-smi >/dev/null; then
  nvidia-smi --query-gpu=name,driver_version --format=csv,noheader | sed 's/^/[gpu-args.sh] GPU: /'
  major=$(nvidia-smi --query-gpu=driver_version --format=csv,noheader | head -1 | cut -d. -f1)
  # Chrome's Vulkan backend needs NVIDIA's userspace Vulkan driver, which a
  # notebook image may not ship (Chrome for Developers' Colab write-up had to
  # install it before Chrome saw the T4).
  $SUDO apt-get update -qq
  $SUDO apt-get install -y -qq vulkan-tools "libnvidia-gl-$major" \
    || say "could not install libnvidia-gl-$major: Chrome's Vulkan backend may not find the GPU"
  vulkaninfo --summary 2>/dev/null | grep -E 'deviceName|driverName' | sed 's/^ */[gpu-args.sh] vulkan: /' \
    || say "vulkan: no device listed"
else
  say "GPU: none (no nvidia-smi)"
fi

pnpm install --frozen-lockfile
pnpm -r build
pnpm --filter @demoman/compositor exec playwright install --with-deps chromium

node apps/runner/compare/gpu-args.mjs --repo . \
  --script apps/runner/compare/fixture-clicks.json \
  --sample packages/compositor/scripts/fixture-app.html \
  --rounds "${ROUNDS:-1}"

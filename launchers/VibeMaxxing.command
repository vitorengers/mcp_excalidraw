#!/bin/sh
# VibeMaxxing — double-click in Finder to start the board. See docs/launchers.md.
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js 20 or newer is required. Install it from https://nodejs.org, then run this again."
  printf 'Press Return to close this window. '
  read -r _
  exit 1
fi
npx -y @vitorengers/vibemaxxing@latest || {
  printf 'VibeMaxxing exited with an error. Press Return to close this window. '
  read -r _
  exit 1
}

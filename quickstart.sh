#!/usr/bin/env bash
# One-line setup: clone, install, build, run.
# Usage:
#   git clone <repo-url> simple-vpn && cd simple-vpn && ./quickstart.sh
#   — or —
#   curl -sL <repo-url>/raw/branch/main/quickstart.sh | bash -s -- <repo-url>

set -euo pipefail

REPO_URL="${1:-}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# If piped via curl, clone first
if [ ! -f "$SCRIPT_DIR/package.json" ]; then
  if [ -z "$REPO_URL" ]; then
    echo "ERROR: Run from repo root or pass repo URL: curl ... | bash -s -- <repo-url>"
    exit 1
  fi
  git clone "$REPO_URL" simple-vpn
  cd simple-vpn
  SCRIPT_DIR="$(pwd)"
fi

cd "$SCRIPT_DIR"

echo ""
echo "  simple-vpn quickstart"
echo "  ════════════════════"
echo ""

# Check Node.js
NODE_MAJOR=$(node -e "console.log(parseInt(process.version.replace(/^v/,'').split('.')[0]))" 2>/dev/null || echo "0")
if [ "$NODE_MAJOR" -lt 20 ]; then
  echo "ERROR: Node.js >= 20 required."
  echo "  Install from: https://nodejs.org/"
  exit 1
fi
echo "  Node.js ${NODE_MAJOR}.x detected."

# Install deps
echo "  Installing dependencies..."
npm install --silent

# Build
echo "  Compiling TypeScript..."
npm run build --silent

# Check/install WireGuard
if ! command -v wg &>/dev/null; then
  echo "  WireGuard not found. Installing..."
  if command -v apt-get &>/dev/null; then
    sudo apt-get update -qq && sudo apt-get install -y -qq wireguard-tools
  elif command -v dnf &>/dev/null; then
    sudo dnf install -y wireguard-tools
  elif command -v pacman &>/dev/null; then
    sudo pacman -S --noconfirm wireguard-tools
  elif command -v brew &>/dev/null; then
    brew install wireguard-tools
  else
    echo "ERROR: Could not install WireGuard automatically."
    echo "  Install from: https://www.wireguard.com/install/"
    exit 1
  fi
fi
echo "  WireGuard ready."

# Start daemon
echo ""
echo "  Starting simple-vpn daemon (will prompt for sudo)..."
echo ""
exec sudo node dist/src/index.js

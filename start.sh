#!/usr/bin/env bash

# Start the local Quantogral dashboard from any working directory.
set -euo pipefail

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

cleanup() {
  kill "$api_pid" 2>/dev/null || true
}

PYTHONPATH="$project_root/src" QUANTOGRAL_ROOT="$project_root" python3 -u -m quantogral.api.server &
api_pid=$!
trap cleanup EXIT INT TERM

cd "$project_root/dashboard"

if [[ ! -d node_modules ]]; then
  echo "Installing dashboard dependencies..."
  npm install
fi

npm run dev -- --host 127.0.0.1

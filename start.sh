#!/usr/bin/env bash

# Start the local Quantogral dashboard from any working directory.
set -euo pipefail

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

cleanup() {
  kill "$api_pid" 2>/dev/null || true
}

api_python="$project_root/.venv/bin/python"
if [[ ! -x "$api_python" ]]; then
  api_python="$(command -v python3)"
fi

PYTHONPATH="$project_root/src" QUANTOGRAL_ROOT="$project_root" "$api_python" -u -m quantogral.api.server &
api_pid=$!
trap cleanup EXIT INT TERM

api_ready=false
for _ in {1..40}; do
  if "$api_python" -c 'import urllib.request; urllib.request.urlopen("http://127.0.0.1:8000/api/health", timeout=0.3)' >/dev/null 2>&1; then
    api_ready=true
    break
  fi
  sleep 0.25
done
if [[ "$api_ready" != true ]]; then
  echo "Quantogral's local API did not start on 127.0.0.1:8000. Another process may already be using that port; stop the other Quantogral server and try again."
  exit 1
fi

cd "$project_root/dashboard"

if [[ ! -d node_modules ]]; then
  echo "Installing dashboard dependencies..."
  npm install
fi

npm run dev -- --host 127.0.0.1

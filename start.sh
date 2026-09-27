#!/usr/bin/env bash

# Start the local Quantogral dashboard from any working directory.
set -euo pipefail

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$project_root/dashboard"

if [[ ! -d node_modules ]]; then
  echo "Installing dashboard dependencies..."
  npm install
fi

exec npm run dev -- --host 127.0.0.1

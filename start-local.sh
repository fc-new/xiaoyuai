#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
if ! command -v node >/dev/null 2>&1; then
  echo 'Install Node.js 24 LTS (including npm): https://nodejs.org/en/download'
  exit 1
fi
exec node scripts/local.mjs

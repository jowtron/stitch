#!/usr/bin/env bash
# Build dist/ with the current git short-hash substituted into index.html.
# Usage:
#   ./build.sh             # creates dist/ ready for `wrangler pages deploy dist`
#   ./build.sh --deploy    # also runs the deploy
set -euo pipefail

cd "$(dirname "$0")"

if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  HASH=$(git rev-parse --short HEAD 2>/dev/null || echo "dev")
  if ! git diff --quiet HEAD -- index.html app.js style.css 2>/dev/null; then
    HASH="${HASH}+dirty"
  fi
else
  HASH="dev"
fi

mkdir -p dist dist/icons
# Substitute {{GIT_HASH}} → real hash. sed delimiter '|' avoids escaping '/' in hashes.
sed "s|{{GIT_HASH}}|${HASH}|g" index.html > dist/index.html
cp app.js style.css manifest.json dist/
cp icons/*.png dist/icons/

echo "Built dist/ with hash: ${HASH}"

if [[ "${1:-}" == "--deploy" ]]; then
  : "${CLOUDFLARE_ACCOUNT_ID:?must export CLOUDFLARE_ACCOUNT_ID}"
  wrangler pages deploy dist --project-name=stitch --commit-dirty=true --branch=main
fi

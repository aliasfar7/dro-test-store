#!/usr/bin/env bash
# Deploy the test store to GitHub Pages.
# Usage: npm run deploy   (after editing data/products.json)
# Publishes https://aliasfar7.github.io/dro-test-store/ from the gh-pages branch.
set -euo pipefail

REPO_URL="${DEPLOY_REPO_URL:-https://github.com/aliasfar7/dro-test-store.git}"
BASE_PATH="${BASE_PATH:-/dro-test-store}"   # set to "" for a root/custom-domain host
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

cd "$ROOT"
BASE_PATH="$BASE_PATH" node scripts/build.mjs
touch public/.nojekyll

TMP="$(mktemp -d)"
cp -r public/. "$TMP/"
cd "$TMP"
git init -q
git checkout -q -b gh-pages
git -c user.email=noreply@paperclip.ing -c user.name=GrowthEng add -A
git -c user.email=noreply@paperclip.ing -c user.name=GrowthEng commit -q -m "Deploy test-store

Co-Authored-By: Paperclip <noreply@paperclip.ing>"
git remote add origin "$REPO_URL"
git push -q -f origin gh-pages
echo "Deployed -> https://aliasfar7.github.io/dro-test-store/"
rm -rf "$TMP"

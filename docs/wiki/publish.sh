#!/usr/bin/env bash
# Publish every page in docs/wiki/ to the GitHub Wiki in one shot.
#
# PREREQUISITE (one time): the wiki must exist. In the repo on github.com →
# Settings → Features → enable "Wikis", then open the Wiki tab and create the
# first page (any content) so the `…wiki.git` repo is initialized. After that,
# just run this script whenever docs/wiki/ changes.
#
#   bash docs/wiki/publish.sh
set -euo pipefail

WIKI_URL="https://github.com/schady4/quorum.wiki.git"
SRC="$(cd "$(dirname "$0")" && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "Cloning wiki…"
git clone "$WIKI_URL" "$TMP/wiki"

echo "Copying pages…"
cp "$SRC"/*.md "$TMP/wiki"/
rm -f "$TMP/wiki/README.md"   # this how-to isn't a wiki page

cd "$TMP/wiki"
git add -A
if git diff --cached --quiet; then
  echo "Wiki already up to date."
  exit 0
fi
git commit -m "Sync wiki from docs/wiki/"
git push
echo "✓ Published: https://github.com/schady4/quorum/wiki"

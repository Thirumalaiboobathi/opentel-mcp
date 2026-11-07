#!/usr/bin/env bash
# Resolve a workspace package's version, verify it matches the pushed tag, and check whether that exact
# version is already on the npm registry. Writes version= and publish= to $GITHUB_OUTPUT.
# Inputs (env): EVENT_NAME, REF_NAME, PKG_DIR, TAG_PREFIX
set -euo pipefail
name=$(node -p 'require(process.argv[1]).name' "./$PKG_DIR/package.json")
version=$(node -p 'require(process.argv[1]).version' "./$PKG_DIR/package.json")
if [ "$EVENT_NAME" = "push" ] && [ "$REF_NAME" != "${TAG_PREFIX}${version}" ]; then
  echo "::error::Tag '$REF_NAME' does not match $PKG_DIR/package.json version '$version' (expected ${TAG_PREFIX}${version})"
  exit 1
fi
code=$(curl -s -o /dev/null -w '%{http_code}' "https://registry.npmjs.org/${name}/${version}")
case "$code" in
  200) echo "::notice::${name}@${version} is already published on npm - skipping publish"; publish=false ;;
  404) publish=true ;;
  *) echo "::error::Unexpected HTTP $code from the npm registry"; exit 1 ;;
esac
{
  echo "version=$version"
  echo "publish=$publish"
} >> "$GITHUB_OUTPUT"

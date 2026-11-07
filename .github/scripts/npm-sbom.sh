#!/usr/bin/env bash
# Generate a CycloneDX SBOM for a packed npm tarball: the tarball's own name/version as the
# described component, and its production dependency tree (as a consumer would install it).
# Usage: npm-sbom.sh <package.tgz> <output.cdx.json>
# Source: https://docs.npmjs.com/cli/v11/commands/npm-sbom
set -euo pipefail
tgz=$(realpath "$1")
out=$(realpath -m "$2")
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
tar -xzf "$tgz" -C "$work"
# npm sbom names the root component after its directory, so use the package name as the directory name.
name=$(node -p 'require(process.argv[1]).name' "$work/package/package.json")
mv "$work/package" "$work/$name"
cd "$work/$name"
# The SBOM describes what this package installs for a consumer: drop devDependencies and the
# optional peers (the consumer's own MCP SDK) from this throwaway copy so npm doesn't report them missing.
node -e '
const fs = require("fs");
const j = JSON.parse(fs.readFileSync("package.json", "utf8"));
delete j.devDependencies;
for (const [k, v] of Object.entries(j.peerDependenciesMeta || {})) if (v.optional) delete (j.peerDependencies || {})[k];
delete j.peerDependenciesMeta;
fs.writeFileSync("package.json", JSON.stringify(j, null, 2));
'
# Install production dependencies only, without running any install scripts.
npm install --omit=dev --ignore-scripts --no-audit --no-fund --no-package-lock >/dev/null
npm sbom --sbom-format cyclonedx --sbom-type library --omit dev > "$out"

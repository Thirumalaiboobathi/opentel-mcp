#!/usr/bin/env node
// prepack: removes the `workspaces` field from the published manifest.
// `workspaces` points at examples/ directories that `files` correctly
// excludes from the tarball, but npm still writes `workspaces` itself into
// the packed package.json, leaking a dev-only detail to consumers.
//
// The original file is preserved in package.json.workspaces-backup so
// postpack (restore-workspaces.js) can put it back byte-for-byte. Designed
// to be idempotent and safe to re-run after a failed/interrupted pack.

import { readFileSync, writeFileSync, existsSync, unlinkSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const rootDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkgPath = join(rootDir, 'package.json');
const backupPath = join(rootDir, 'package.json.workspaces-backup');

const raw = readFileSync(pkgPath, 'utf8');
const pkg = JSON.parse(raw);

if (!('workspaces' in pkg)) {
  // Already stripped by a prior run that didn't get to postpack, or there
  // was never a workspaces field to begin with. Either way, nothing to do
  // — and if a backup exists, leave it for postpack to restore.
  process.exit(0);
}

if (existsSync(backupPath)) {
  // Stale backup left over from an unrelated run where package.json was
  // never actually stripped (we only reach this branch when the current
  // file still has `workspaces`, so the backup can't hold anything the
  // current file doesn't already have). Safe to discard and start fresh.
  unlinkSync(backupPath);
}

writeFileSync(backupPath, raw, 'utf8');

const indentMatch = raw.match(/^\{\r?\n(\s+)"/);
const indent = indentMatch ? indentMatch[1] : '  ';
const trailingNewline = raw.endsWith('\n');

delete pkg.workspaces;

const stripped = JSON.stringify(pkg, null, indent) + (trailingNewline ? '\n' : '');
writeFileSync(pkgPath, stripped, 'utf8');

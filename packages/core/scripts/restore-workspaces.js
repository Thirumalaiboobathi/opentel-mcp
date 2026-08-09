#!/usr/bin/env node
// postpack: restores package.json to exactly what it was before
// strip-workspaces.js (prepack) ran, byte-for-byte — including formatting.
// A no-op if there's no backup (e.g. prepack never ran, or a previous
// postpack already restored it).

import { readFileSync, writeFileSync, existsSync, unlinkSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const rootDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkgPath = join(rootDir, 'package.json');
const backupPath = join(rootDir, 'package.json.workspaces-backup');

if (!existsSync(backupPath)) {
  process.exit(0);
}

const original = readFileSync(backupPath, 'utf8');
writeFileSync(pkgPath, original, 'utf8');
unlinkSync(backupPath);

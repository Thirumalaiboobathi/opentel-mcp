#!/usr/bin/env node
// Release gate: packs core and ui, installs both tarballs together into an
// empty temp project (as a consumer would) and fails if npm prints any
// "deprecated" warning for anything in the resulting runtime tree. Needs
// network access (deprecation notices come from registry metadata).
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const work = mkdtempSync(join(tmpdir(), 'opentel-deprecations-'));
try {
  const tarballs = ['core', 'ui'].map((pkg) => {
    const out = execFileSync('npm', ['pack', '--silent', '--pack-destination', work], {
      cwd: join(root, 'packages', pkg),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    return join(work, out.trim().split('\n').pop());
  });
  const project = join(work, 'consumer');
  execFileSync('mkdir', [project]);
  writeFileSync(join(project, 'package.json'), JSON.stringify({ name: 'consumer', version: '0.0.0', private: true }));
  const r = spawnSync(
    'npm',
    ['install', '--no-audit', '--no-fund', '--cache', join(work, 'cache'), '--loglevel', 'warn', ...tarballs, '@opentelemetry/api@1.9.1'],
    { cwd: project, encoding: 'utf8' },
  );
  const output = `${r.stdout}${r.stderr}`;
  console.log(`npm install output (exit ${r.status}):\n${output.trim() || '(empty)'}`);
  if (r.status !== 0) process.exit(1);
  if (/deprecated/i.test(output)) {
    console.error('\nFAIL: npm reported deprecated packages in the runtime dependency tree.');
    process.exit(1);
  }
  console.log('\nOK: no deprecation warnings.');
} finally {
  rmSync(work, { recursive: true, force: true });
}

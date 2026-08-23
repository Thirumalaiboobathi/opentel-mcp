import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import * as topAttrs from '../../src/attributes.js';
import * as fingerprintAttrs from '../../src/fingerprint/attributes.js';
import * as thrashAttrs from '../../src/thrash/attributes.js';
import * as schemaDriftAttrs from '../../src/schema-drift/attributes.js';

/**
 * Consistency check for docs/recipes/tail-sampling.yaml (v0.12.0). This is
 * what would have caught the recipe's own predecessor bug automatically:
 * the README, before this release, recommended
 * `mcp.tool.schema_drift.detected` as a `boolean_attribute` policy target —
 * but that string was only ever a span EVENT name / metric counter name
 * (schema-drift/attributes.js's SPAN_EVENT_NAME_SCHEMA_DRIFT_DETECTED,
 * never passed to span.setAttribute() anywhere in src/), so the policy, as
 * documented, could never have matched anything.
 *
 * What this test does NOT verify — see the YAML file's own header comment
 * and packages/core/README.md's "Cost-aware trace sampling" section: that
 * the tailsamplingprocessor itself, running for real, honors these policy
 * types/semantics the way public Collector Contrib docs describe. No
 * Collector is run here. This only confirms the ATTRIBUTE NAMES the recipe
 * references are real, exported, span-level attribute keys — the part
 * verifiable without a running Collector, and the part that was actually
 * wrong.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../../../..');
const RECIPE_PATH = path.resolve(REPO_ROOT, 'docs/recipes/tail-sampling.yaml');
const SRC_DIR = path.resolve(__dirname, '../../src');

/** Recursively lists every .js file under `dir`. */
function listJsFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listJsFiles(full));
    } else if (entry.isFile() && entry.name.endsWith('.js')) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Every identifier passed as span.setAttribute()'s (or trace.setAttribute()-
 * shaped) first argument anywhere under src/ — e.g. `ATTR_MCP_TOOL_COST_USD`
 * from `span.setAttribute(ATTR_MCP_TOOL_COST_USD, costUsd)`. Deliberately a
 * plain regex over source text, not an AST parse — this only needs to catch
 * "was this constant ever handed to .setAttribute(...) as its key", not
 * understand full JS semantics, and a regex is enough to have caught the
 * actual bug (addEvent(...) vs setAttribute(...) are textually distinct
 * call names).
 */
function findSetAttributeIdentifiers(files) {
  const identifiers = new Set();
  const pattern = /\.setAttribute\(\s*([A-Za-z_$][A-Za-z0-9_$]*)/g;
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    for (const match of text.matchAll(pattern)) {
      identifiers.add(match[1]);
    }
  }
  return identifiers;
}

/** All named string exports across the attribute-constant modules, as [exportName, value]. */
function allAttributeExports() {
  const modules = [topAttrs, fingerprintAttrs, thrashAttrs, schemaDriftAttrs];
  const entries = [];
  for (const mod of modules) {
    for (const [name, value] of Object.entries(mod)) {
      if (typeof value === 'string') entries.push([name, value]);
    }
  }
  return entries;
}

/** Extracts { policyName, type, key } for every attribute-matching policy in the recipe's tail_sampling processor. */
function extractAttributePolicies(config) {
  const policies = config?.processors?.tail_sampling?.policies ?? [];
  const results = [];
  for (const policy of policies) {
    for (const type of ['numeric_attribute', 'boolean_attribute', 'string_attribute']) {
      const spec = policy[type];
      if (spec?.key) results.push({ policyName: policy.name, type, key: spec.key });
    }
  }
  return results;
}

describe('docs/recipes/tail-sampling.yaml — attribute cross-check', () => {
  const raw = readFileSync(RECIPE_PATH, 'utf8');
  const config = yaml.load(raw);
  const attributePolicies = extractAttributePolicies(config);
  const exportEntries = allAttributeExports();
  const setAttributeIdentifiers = findSetAttributeIdentifiers(listJsFiles(SRC_DIR));

  it('parses as valid YAML with at least one attribute-based policy', () => {
    expect(config).toBeTruthy();
    expect(attributePolicies.length).toBeGreaterThan(0);
  });

  it.each(attributePolicies.map((p) => [p.policyName, p.key, p.type]))(
    'policy "%s" keys on %s (%s), a real, exported, span-level attribute',
    (_policyName, key) => {
      const matches = exportEntries.filter(([, value]) => value === key);

      // The key must correspond to at least one exported constant — catches
      // a typo'd or renamed attribute string in the YAML.
      expect(matches.length, `no exported attribute constant has the value "${key}"`).toBeGreaterThan(0);

      // At least one of the matching constants must actually be passed to
      // span.setAttribute() somewhere in src/ — catches a key that's real
      // but is only ever used as a span-event name or a metric name (the
      // exact shape of this recipe's own predecessor bug).
      const usedAsSpanAttribute = matches.some(([name]) => setAttributeIdentifiers.has(name));
      expect(usedAsSpanAttribute, `"${key}" (${matches.map(([n]) => n).join(', ')}) is exported but never passed to span.setAttribute() in src/`).toBe(
        true,
      );
    },
  );

  it('regression: the schema-drift SPAN EVENT name is confirmed NOT usable as a boolean_attribute policy target', () => {
    // Documents the exact mechanism the bug this file's own header comment
    // describes: SPAN_EVENT_NAME_SCHEMA_DRIFT_DETECTED and
    // ATTR_MCP_TOOL_SCHEMA_DRIFT_DETECTED are deliberately different strings
    // (schema-drift/attributes.js) — the event name must never satisfy the
    // "used as a span attribute" check above, or this test (and the check
    // it documents) would be meaningless.
    expect(schemaDriftAttrs.SPAN_EVENT_NAME_SCHEMA_DRIFT_DETECTED).not.toBe(schemaDriftAttrs.ATTR_MCP_TOOL_SCHEMA_DRIFT_DETECTED);

    const eventNameExports = exportEntries.filter(([, value]) => value === schemaDriftAttrs.SPAN_EVENT_NAME_SCHEMA_DRIFT_DETECTED);
    expect(eventNameExports.some(([name]) => setAttributeIdentifiers.has(name))).toBe(false);
  });
});

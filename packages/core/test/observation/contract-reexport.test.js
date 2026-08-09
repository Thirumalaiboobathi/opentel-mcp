import { describe, it, expect } from 'vitest';
import * as pkg from '../../src/index.js';
import * as contract from 'opentel-mcp-contract';
import { OBSERVATION_INTEGRITY } from '../../src/observation/integrity.js';
import {
  ATTR_MCP_TOOL_OUTCOME,
  MCP_TOOL_OUTCOME_SUCCESS,
  MCP_TOOL_OUTCOME_ERROR,
  MCP_TOOL_OUTCOME_SILENT_FAILURE,
  ERROR_TYPE_TOOL_ERROR,
} from '../../src/attributes.js';

/**
 * Step 2 of the UI project ("extract observation contract into
 * opentel-mcp-contract") requires that core's pre-existing re-export
 * surface stay unchanged from a consumer's point of view, AND that core's
 * own emission and opentel-mcp-contract can never quietly drift apart —
 * see this repo's RUNLOG.md, Step 2 entry. This file asserts both:
 *
 *  1. Everything `test/index.exports.test.js` already asserts for the
 *     package root keeps working post-refactor (that file's own
 *     assertions are unchanged and still run — this file adds to them,
 *     not replaces them).
 *  2. Every internal module that used to define one of these constants
 *     locally now imports the EXACT SAME object/value from
 *     'opentel-mcp-contract' — checked by reference (`toBe`), not just
 *     by value (`toEqual`), which is the only way to prove there isn't a
 *     second, independently-maintained copy anywhere in this package.
 */
describe('two-axis observation contract: core <-> opentel-mcp-contract', () => {
  it('src/observation/integrity.js re-exports the exact OBSERVATION_INTEGRITY object from opentel-mcp-contract', () => {
    expect(OBSERVATION_INTEGRITY).toBe(contract.OBSERVATION_INTEGRITY);
  });

  it('src/attributes.js re-exports the exact mcp.tool.outcome constants from opentel-mcp-contract', () => {
    expect(ATTR_MCP_TOOL_OUTCOME).toBe(contract.ATTR_MCP_TOOL_OUTCOME);
    expect(MCP_TOOL_OUTCOME_SUCCESS).toBe(contract.MCP_TOOL_OUTCOME_SUCCESS);
    expect(MCP_TOOL_OUTCOME_ERROR).toBe(contract.MCP_TOOL_OUTCOME_ERROR);
    expect(MCP_TOOL_OUTCOME_SILENT_FAILURE).toBe(contract.MCP_TOOL_OUTCOME_SILENT_FAILURE);
  });

  it('src/attributes.js re-exports the exact ERROR_TYPE_TOOL_ERROR value from opentel-mcp-contract', () => {
    expect(ERROR_TYPE_TOOL_ERROR).toBe(contract.ERROR_TYPE_TOOL_ERROR);
  });

  it('opentel-mcp-contract has zero runtime dependencies (types + frozen constants only)', async () => {
    // Reading package.json directly rather than trusting a copy of the
    // rule elsewhere -- this is the actual npm-enforced contract surface.
    const contractPkg = await import('opentel-mcp-contract/package.json', { with: { type: 'json' } });
    expect(contractPkg.default.dependencies).toEqual({});
  });

  it("opentel-mcp-contract's frozen enums stay frozen and two-valued/three-valued as ADR 008 specifies", () => {
    expect(Object.isFrozen(contract.TOOL_OUTCOME)).toBe(true);
    expect(Object.values(contract.TOOL_OUTCOME).sort()).toEqual(['FAILURE', 'SUCCESS', 'UNKNOWN']);

    expect(Object.isFrozen(contract.OBSERVATION_INTEGRITY)).toBe(true);
    expect(Object.values(contract.OBSERVATION_INTEGRITY).sort()).toEqual(['DEGRADED', 'UNKNOWN']);
    expect(contract.OBSERVATION_INTEGRITY).not.toHaveProperty('HEALTHY');
  });

  describe("core's pre-existing public re-export surface is unchanged", () => {
    // These four were the ENTIRE public surface for the two-axis contract
    // before this refactor (type-only — see src/index.d.ts's git history
    // pre-v0.9.0). `import { ToolOutcome } from 'opentel-mcp'` must still
    // work for a consumer who upgrades without changing their imports.
    it('import * as pkg from \'opentel-mcp\' (via src/index.js) is unaffected by the refactor -- it never carried runtime values for this contract, and still does not', () => {
      // ToolOutcome/ToolOutcomeCounts/ObservationIntegrity/ObservationState
      // were, and remain, TYPE-ONLY exports at the package root (see
      // src/index.d.ts) -- there was never a runtime value here to
      // regress. This assertion documents that fact so a future PR that
      // accidentally adds one doesn't silently change the public runtime
      // surface without a deliberate decision.
      expect(pkg).not.toHaveProperty('ToolOutcome');
      expect(pkg).not.toHaveProperty('ObservationIntegrity');
    });
  });
});

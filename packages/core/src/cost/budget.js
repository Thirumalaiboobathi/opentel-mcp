/**
 * @module cost/budget
 * In-memory, best-effort budget guardrails for cost attribution.
 *
 * Observability only — this module never blocks a tool call and never
 * throws. It exists so `applyCostAttribution()` (src/instrument.js) can
 * flag a span when cumulative spend crosses a configured limit; enforcing
 * that limit (denying the call, alerting, etc.) is left entirely to
 * whatever consumes the resulting `mcp.tool.cost.budget_exceeded` span
 * attribute (see src/attributes.js).
 *
 * v0.12.0 (docs/known-gaps.md entry 9): a call whose model doesn't resolve
 * to a price (`mcp.tool.pricing_status: "unknown"`) never reaches
 * `recordAndCheck()` below at all — `applyCostAttribution()` only calls it
 * when `costUsd !== null`. That's not new behavior here, and this release
 * does not change it (see that entry's "confidently wrong number" reasoning
 * for why inventing a fallback price would trade one silent-failure shape
 * for another, not fix it) — it only adds two diagnostics so the gap is
 * visible instead of silent: a construction-time warning that a configured
 * budget won't see unpriced spend, and a first-occurrence warning naming
 * the model the first time it actually happens. Both are pure
 * `diag.warn()` calls; neither changes `BudgetCheckResult`, adds a span
 * attribute, or alters `recordAndCheck()`'s existing behavior in any way.
 */

import { diag } from '@opentelemetry/api';

/**
 * @typedef {Object} BudgetConfig
 * @property {number} [perSessionUsd] - Cumulative-cost limit per MCP session id. Calls with no session id
 *   (e.g. stdio transport, which has none) are never tracked against this limit — see accumulate() below.
 * @property {number} [perToolUsd] - Cumulative-cost limit per tool name.
 */

/**
 * @typedef {Object} BudgetCheckResult
 * @property {boolean} exceeded
 * @property {'session' | 'tool' | null} scope - Which limit tripped on *this* call. null when `exceeded` is
 *   false. When both scopes are over budget on the same call, "session" wins — matches
 *   ATTR_MCP_TOOL_COST_BUDGET_SCOPE's documented precedence in src/attributes.js.
 */

/**
 * @param {unknown} value
 * @returns {value is string}
 */
function isNonEmptyString(value) {
  return typeof value === 'string' && value !== '';
}

/**
 * @param {unknown} value
 * @returns {value is number}
 */
function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * Adds `amount` to `map.get(key)` (defaulting the prior total to 0) and
 * returns the new running total. No-op — returns null — when `key` isn't
 * a non-empty string or `amount` isn't a finite number, so a bad call
 * neither throws nor silently poisons the map with NaN.
 *
 * @param {Map<string, number>} map
 * @param {unknown} key
 * @param {number} amount
 * @returns {number | null}
 */
function accumulate(map, key, amount) {
  if (!isNonEmptyString(key) || !isFiniteNumber(amount)) return null;
  const total = (map.get(key) ?? 0) + amount;
  map.set(key, total);
  return total;
}

/**
 * Creates a budget tracker scoped to one instrumented server (one call per
 * `instrumentMcpServer()` invocation — see src/instrument.js). Holds two
 * independent, unbounded-lifetime in-memory Maps: one keyed by MCP session
 * id, one keyed by tool name. Neither is ever cleared within that call's
 * lifetime.
 *
 * NOT necessarily process-lifetime: this tracker is constructed fresh
 * inside every `instrumentMcpServer()` call, with no state shared across
 * calls. That's only equivalent to "process-lifetime" when a host
 * instruments one long-lived `Server`/`McpServer` once. Under a
 * fresh-`Server`-per-request deployment (e.g. stateless Streamable HTTP),
 * a new tracker is constructed per request and these totals reset to zero
 * every time — a confirmed gap, not a hypothetical. See ADR 012,
 * docs/adr/012-tracker-lifecycle-and-shared-state.md. Restart the process
 * (or, for a long-lived server, build your own eviction on top) to reset
 * intentionally. **The two v0.12.0 warnings below inherit this exact same
 * granularity** — both live in this same closure, so both re-arm on every
 * fresh construction. Under the default (no `instanceKey`), a
 * fresh-server-per-request deployment re-warns on *every request* for
 * both — the identical inherited-caveat shape `docs/known-gaps.md` entry 6
 * documents for `thrashSessionState`'s fallback-session warning. Unlike
 * that entry's gap, though, `instrument.js` already constructs this
 * tracker via `getOrCreateTracker(resolved.instanceKey, 'budget', ...)` —
 * so a caller who *does* set a stable `instanceKey` shares one tracker
 * (and therefore one already-armed warning flag) across calls, the same as
 * every other registry-backed tracker; only the no-`instanceKey` default
 * case gets the repeated warning.
 *
 * @param {BudgetConfig | undefined} budget - costTracking.budget from config.js. Omitted/undefined limits
 *   mean that scope is never tracked or checked — recordAndCheck() becomes a pure no-op for it, and neither
 *   new v0.12.0 warning below ever fires.
 * @returns {{
 *   recordAndCheck: (sessionId: unknown, toolName: unknown, costUsd: number) => BudgetCheckResult,
 *   recordUnpriced: (model: unknown) => void,
 * }}
 */
export function createBudgetTracker(budget) {
  const perSessionUsd = isFiniteNumber(budget?.perSessionUsd) ? budget.perSessionUsd : undefined;
  const perToolUsd = isFiniteNumber(budget?.perToolUsd) ? budget.perToolUsd : undefined;
  const budgetConfigured = perSessionUsd !== undefined || perToolUsd !== undefined;

  // v0.12.0, docs/known-gaps.md entry 9: fires at most once per tracker
  // construction (see this function's own docblock for exactly what "once"
  // means here) — a proactive heads-up that this budget, once configured,
  // will silently ignore any call whose model never resolves to a price.
  // Unconditional on whether that ever actually happens; see
  // recordUnpriced() below for the reactive counterpart that fires only
  // when it does.
  if (budgetConfigured) {
    try {
      diag.warn(
        'opentel-mcp: a costTracking.budget guardrail is configured, but it only accounts for calls whose model ' +
          'resolves to a known price. A call whose usage is extracted but whose model is unrecognized or unpriced ' +
          '(mcp.tool.pricing_status: "unknown") is never counted toward perSessionUsd/perToolUsd, regardless of its ' +
          'real token cost — see docs/known-gaps.md entry 9.',
      );
    } catch {
      // Never throw — see module docblock.
    }
  }

  /** @type {Map<string, number>} */
  const sessionCostMap = new Map();
  /** @type {Map<string, number>} */
  const toolCostMap = new Map();
  let warnedUnpriced = false;

  return {
    recordAndCheck(sessionId, toolName, costUsd) {
      try {
        let sessionExceeded = false;
        let toolExceeded = false;

        if (perSessionUsd !== undefined) {
          const total = accumulate(sessionCostMap, sessionId, costUsd);
          // total is null when sessionId isn't usable (e.g. a stdio-transport
          // call with no session id at all) — skip that scope silently
          // rather than tracking against a made-up key.
          if (total !== null) sessionExceeded = total > perSessionUsd;
        }

        if (perToolUsd !== undefined) {
          const total = accumulate(toolCostMap, toolName, costUsd);
          if (total !== null) toolExceeded = total > perToolUsd;
        }

        if (sessionExceeded) return { exceeded: true, scope: 'session' };
        if (toolExceeded) return { exceeded: true, scope: 'tool' };
        return { exceeded: false, scope: null };
      } catch {
        // Never throw — see module docblock. A tracking failure here must
        // read as "no budget signal this call", not break the span.
        return { exceeded: false, scope: null };
      }
    },

    /**
     * v0.12.0, docs/known-gaps.md entry 9: the reactive counterpart to the
     * construction-time warning above. Called from `applyCostAttribution()`
     * (src/instrument.js) in the branch where a call's usage was extracted
     * but its cost never resolved (`costUsd === null`, the same condition
     * that sets `mcp.tool.pricing_status: "unknown"`) — i.e. exactly the
     * calls `recordAndCheck()` above is never invoked for. No-op, silently,
     * when no budget scope is configured (nothing to warn about) or once
     * this tracker has already warned once (see this module's own
     * granularity docblock on `createBudgetTracker()` for what "once"
     * means here). Never throws, matching every other public method here.
     *
     * @param {unknown} model - usage.model from the extractor's result, possibly undefined (no model detected at all).
     */
    recordUnpriced(model) {
      if (!budgetConfigured || warnedUnpriced) return;
      warnedUnpriced = true;

      try {
        const scopes = [perSessionUsd !== undefined ? 'perSessionUsd' : null, perToolUsd !== undefined ? 'perToolUsd' : null]
          .filter(Boolean)
          .join(', ');
        const modelDescription = isNonEmptyString(model) ? `"${model}"` : '(no model detected)';
        diag.warn(
          `opentel-mcp: a tool call using model ${modelDescription} did not resolve to a price and was not counted ` +
            `toward the configured budget guardrail (${scopes}). Real spend may be higher than ` +
            'mcp.tool.cost.budget_exceeded/budget_scope report. This warning fires once per tracker instance — see ' +
            "this function's own docblock for what that means under a fresh-server-per-request deployment — and " +
            'only when a budget is configured. See docs/known-gaps.md entry 9.',
        );
      } catch {
        // Never throw — see module docblock.
      }
    },
  };
}

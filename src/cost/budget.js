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
 */

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
 * intentionally.
 *
 * @param {BudgetConfig | undefined} budget - costTracking.budget from config.js. Omitted/undefined limits
 *   mean that scope is never tracked or checked — recordAndCheck() becomes a pure no-op for it.
 * @returns {{ recordAndCheck: (sessionId: unknown, toolName: unknown, costUsd: number) => BudgetCheckResult }}
 */
export function createBudgetTracker(budget) {
  const perSessionUsd = isFiniteNumber(budget?.perSessionUsd) ? budget.perSessionUsd : undefined;
  const perToolUsd = isFiniteNumber(budget?.perToolUsd) ? budget.perToolUsd : undefined;

  /** @type {Map<string, number>} */
  const sessionCostMap = new Map();
  /** @type {Map<string, number>} */
  const toolCostMap = new Map();

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
  };
}

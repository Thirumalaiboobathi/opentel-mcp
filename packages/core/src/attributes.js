/**
 * @module attributes
 * Semantic attribute constants for opentel-mcp spans.
 *
 * Names follow the MCP semantic conventions published by the OTel GenAI
 * SIG in open-telemetry/semantic-conventions-genai (the conventions moved
 * there from the main semantic-conventions repo, where they're now marked
 * deprecated). That spec's status is Development, not Stable — see ADR 004
 * for what that means for this package and why we're aligning to it now
 * anyway.
 */

// --- Spec attributes (MCP semconv, server span) ---

/** Required. The JSON-RPC method name, e.g. "tools/call". */
export const ATTR_MCP_METHOD_NAME = 'mcp.method.name';

/**
 * Conditionally Required (when the operation targets a specific tool).
 * Sourced from the OTel GenAI semantic conventions (`gen_ai.tool.name`),
 * not invented by this package — MCP tool calls are GenAI `execute_tool`
 * calls under the hood, so the MCP server span conventions reuse the
 * existing `gen_ai.*` namespace rather than defining their own tool-name
 * attribute. Contrast with the "Custom (non-spec) attributes" section
 * below, where every entry explicitly says it's NOT part of the spec.
 */
export const ATTR_GEN_AI_TOOL_NAME = 'gen_ai.tool.name';

/** Conditionally Required (when the client executes a request with a non-null id). */
export const ATTR_JSONRPC_REQUEST_ID = 'jsonrpc.request.id';

/**
 * Conditionally Required iff the operation fails — either a thrown
 * exception or a successful JSON-RPC response whose CallToolResult carries
 * isError: true, in which case this is set to ERROR_TYPE_TOOL_ERROR.
 */
export const ATTR_ERROR_TYPE = 'error.type';

/**
 * Recommended. SHOULD be "execute_tool" for tool calls, SHOULD NOT be set
 * otherwise. Lets consumers treat MCP tool-call spans like other GenAI
 * tool-call spans.
 */
export const ATTR_GEN_AI_OPERATION_NAME = 'gen_ai.operation.name';

/**
 * A real OTel GenAI semantic convention attribute ("the name of the model
 * that generated the response") — but co-emitted here as a *pragmatic
 * dashboard-compatibility* choice, not a spec-pure one. This span is an
 * MCP tool-call span (`gen_ai.operation.name: execute_tool`), not a
 * dedicated GenAI request/response span, so strictly speaking this
 * attribute describes a model used *inside* the tool's implementation
 * rather than the model that produced *this* span's own response. It's
 * set to the same value as ATTR_MCP_TOOL_MODEL below, whenever
 * applyCostAttribution() (instrument.js) detects one, purely so
 * off-the-shelf GenAI dashboards (Grafana, SigNoz, Honeycomb) that filter
 * or group by `gen_ai.response.model` pick these spans up without any
 * opentel-mcp-specific configuration. See README's "Cost & Token
 * Attribution" section for the full rationale.
 */
export const ATTR_GEN_AI_RESPONSE_MODEL = 'gen_ai.response.model';

/**
 * Well-known error.type value for a JSON-RPC call that succeeded but whose
 * CallToolResult has isError: true — a tool-level failure, not a transport
 * or protocol error.
 */
export const ERROR_TYPE_TOOL_ERROR = 'tool_error';

/** Well-known gen_ai.operation.name value for tool execution. */
export const GEN_AI_OPERATION_NAME_EXECUTE_TOOL = 'execute_tool';

/** Well-known mcp.method.name value for a tools/call request. */
export const MCP_METHOD_NAME_TOOLS_CALL = 'tools/call';

/** Well-known mcp.method.name value for a tools/list request (ADR 010, schema drift detection). */
export const MCP_METHOD_NAME_TOOLS_LIST = 'tools/list';

// --- Custom (non-spec) attributes ---

/**
 * NOT part of the MCP semantic conventions. Our own addition: a
 * privacy-preserving alternative to the spec's opt-in
 * gen_ai.tool.call.arguments attribute (which captures full argument
 * values and is therefore Opt-In due to sensitivity). Recording just the
 * count gives shape/anomaly signal (e.g. "this call suddenly has 0 args")
 * without capturing any argument content. See ADR 004 and the README's
 * "Semantic conventions" section.
 */
export const ATTR_MCP_TOOL_ARGUMENT_COUNT = 'mcp.tool.argument_count';

export const ATTR_MCP_SERVER_NAME = 'mcp.server.name';
export const ATTR_MCP_SERVER_VERSION = 'mcp.server.version';

/**
 * NOT part of the MCP semantic conventions. Our own addition, on the
 * mcp.tool.duration histogram (see src/metrics.js): which of the three
 * call outcomes a given duration measurement belongs to. The spec's
 * mcp.server.operation.duration metric (not yet implemented here — see
 * README roadmap) expresses failure only via error.type; this attribute
 * additionally distinguishes "thrown/protocol error" from "silent failure"
 * (isError: true) so both are visible on the same histogram without
 * requiring a join against error.type, which silent failures don't set
 * on the duration metric.
 */
export const ATTR_MCP_TOOL_OUTCOME = 'mcp.tool.outcome';

/** Well-known mcp.tool.outcome value: the call succeeded. */
export const MCP_TOOL_OUTCOME_SUCCESS = 'success';

/** Well-known mcp.tool.outcome value: the handler threw or its promise rejected. */
export const MCP_TOOL_OUTCOME_ERROR = 'error';

/** Well-known mcp.tool.outcome value: isError: true (see ERROR_TYPE_TOOL_ERROR above). */
export const MCP_TOOL_OUTCOME_SILENT_FAILURE = 'silent_failure';

// --- Cost & token attribution attributes (v0.5.0, non-spec) ---
//
// NOT part of the MCP semantic conventions — there is no spec-defined way
// to report LLM token usage or cost on an MCP tool-call span. These are
// opentel-mcp's own addition, populated by src/cost/extractor.js and
// src/cost/calculator.js when a tool result carries recognizable usage
// data (see instrument.js's applyCostAttribution()). All four token/model
// attributes are set together or not at all; the two cost attributes are
// only set when a model was detected *and* it resolves in the configured
// pricing table (see calculateCost() in src/cost/calculator.js).

/** Input tokens consumed by the tool call, as reported by the underlying model/provider. */
export const ATTR_MCP_TOOL_TOKENS_INPUT = 'mcp.tool.tokens.input';

/** Output tokens produced by the tool call. */
export const ATTR_MCP_TOOL_TOKENS_OUTPUT = 'mcp.tool.tokens.output';

/** input + output tokens for the tool call. */
export const ATTR_MCP_TOOL_TOKENS_TOTAL = 'mcp.tool.tokens.total';

/** Model name detected for the tool call (e.g. "claude-sonnet-5"), when the extractor found one. */
export const ATTR_MCP_TOOL_MODEL = 'mcp.tool.model';

/** Estimated cost of the tool call in ATTR_MCP_TOOL_COST_CURRENCY, from calculateCost(). */
export const ATTR_MCP_TOOL_COST_USD = 'mcp.tool.cost.usd';

/** Currency of ATTR_MCP_TOOL_COST_USD. Always MCP_TOOL_COST_CURRENCY_USD today. */
export const ATTR_MCP_TOOL_COST_CURRENCY = 'mcp.tool.cost.currency';

/** Well-known mcp.tool.cost.currency value — the only currency DEFAULT_PRICING and calculateCost() support. */
export const MCP_TOOL_COST_CURRENCY_USD = 'USD';

/**
 * Set to true when this call's cost pushed a configured budget
 * (costTracking.budget — see src/cost/budget.js) over its limit. Only set
 * on the call that crosses the threshold and every call after — not
 * retroactively on earlier, under-budget calls. Observability only: this
 * package never blocks or throws on a budget overrun.
 */
export const ATTR_MCP_TOOL_COST_BUDGET_EXCEEDED = 'mcp.tool.cost.budget_exceeded';

/**
 * Which budget scope tripped: MCP_TOOL_COST_BUDGET_SCOPE_SESSION or
 * MCP_TOOL_COST_BUDGET_SCOPE_TOOL. Only present alongside
 * ATTR_MCP_TOOL_COST_BUDGET_EXCEEDED === true. When both scopes are over
 * budget on the same call, session wins (see src/cost/budget.js).
 */
export const ATTR_MCP_TOOL_COST_BUDGET_SCOPE = 'mcp.tool.cost.budget_scope';

/** Well-known mcp.tool.cost.budget_scope value: costTracking.budget.perSessionUsd was exceeded. */
export const MCP_TOOL_COST_BUDGET_SCOPE_SESSION = 'session';

/** Well-known mcp.tool.cost.budget_scope value: costTracking.budget.perToolUsd was exceeded. */
export const MCP_TOOL_COST_BUDGET_SCOPE_TOOL = 'tool';

// --- Pricing provenance (v0.11.0, non-spec, ADR 016) ---
//
// docs/adr/016-pricing-override-and-staleness.md. Lets a dashboard answer
// "what fraction of spend/tokens is unpriced" as a direct query instead of
// an inference from missing mcp.tool.cost.* attributes.

/**
 * Whether the model detected for this tool call resolved to a known price.
 * Set whenever token usage was extracted at all (same gating as
 * ATTR_MCP_TOOL_TOKENS_INPUT/OUTPUT/TOTAL) — present even when no model was
 * detected, unlike ATTR_MCP_TOOL_MODEL/ATTR_MCP_TOOL_COST_USD. One of
 * MCP_TOOL_PRICING_STATUS_KNOWN / _UNKNOWN / _USER_OVERRIDE.
 */
export const ATTR_MCP_TOOL_PRICING_STATUS = 'mcp.tool.pricing_status';

/** Well-known mcp.tool.pricing_status value: no model was detected, or the detected model has no pricing entry. */
export const MCP_TOOL_PRICING_STATUS_UNKNOWN = 'unknown';

/** Well-known mcp.tool.pricing_status value: priced against an unmodified DEFAULT_PRICING entry. */
export const MCP_TOOL_PRICING_STATUS_KNOWN = 'known';

/** Well-known mcp.tool.pricing_status value: priced against a caller-supplied costTracking.pricing/pricingTable entry. */
export const MCP_TOOL_PRICING_STATUS_USER_OVERRIDE = 'user_override';

/**
 * Attribute keys safe to attach to mcp.tool.tokens.total / mcp.tool.cost.total
 * metric labels, for the cost/pricing domain specifically. Mirrors the
 * governance pattern fingerprint/attributes.js's METRIC_SAFE_ATTRIBUTES and
 * schema-drift/attributes.js's own same-named export already established
 * for their domains — this domain gets its own list rather than borrowing
 * either of those (mixing an unrelated domain's cardinality reasoning in
 * here would obscure which ADR covers which attribute). Not re-exported
 * from index.js, same as schema-drift's — internal governance, not public
 * API. mcp.tool.model remains governed the way it already was, an inline
 * cardinality comment in metrics.js, not a list entry here — see ADR 016
 * point 4 for why that attribute's boundedness argument doesn't fit a
 * fixed-enum list cleanly the way this one does.
 *
 * @type {readonly string[]}
 */
export const COST_METRIC_SAFE_ATTRIBUTES = Object.freeze([ATTR_MCP_TOOL_PRICING_STATUS]);

/** Resource attribute (setupNodeSdk: true only) naming DEFAULT_PRICING's lastVerified date. See ADR 016 point 3. */
export const ATTR_MCP_PRICING_DEFAULT_TABLE_LAST_VERIFIED = 'mcp.pricing.default_table_last_verified';

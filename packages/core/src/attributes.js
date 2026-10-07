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

// ADR 026 (v0.16.0, opt-in `coverage`): the five resource/prompt methods.
// mcp.method.name only ever takes these fixed string constants, never a
// value read from a request, so its value space stays bounded (7 total).

/** Well-known mcp.method.name value for a resources/read request (ADR 026). */
export const MCP_METHOD_NAME_RESOURCES_READ = 'resources/read';
/** Well-known mcp.method.name value for a resources/list request (ADR 026). */
export const MCP_METHOD_NAME_RESOURCES_LIST = 'resources/list';
/** Well-known mcp.method.name value for a resources/templates/list request (ADR 026). */
export const MCP_METHOD_NAME_RESOURCES_TEMPLATES_LIST = 'resources/templates/list';
/** Well-known mcp.method.name value for a prompts/get request (ADR 026). */
export const MCP_METHOD_NAME_PROMPTS_GET = 'prompts/get';
/** Well-known mcp.method.name value for a prompts/list request (ADR 026). */
export const MCP_METHOD_NAME_PROMPTS_LIST = 'prompts/list';

/**
 * gen_ai.prompt.name — the prompt a prompts/get span requested (ADR 026).
 * Span attribute only, never a metric label. Capped at
 * MAX_PROMPT_NAME_LENGTH, since the value comes from the request.
 */
export const ATTR_GEN_AI_PROMPT_NAME = 'gen_ai.prompt.name';
export const MAX_PROMPT_NAME_LENGTH = 128;

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
 * API. mcp.tool.model is not a member of THIS list — it isn't a
 * cost/pricing-domain attribute — see METRIC_SAFE_ATTRIBUTES below, where
 * it's now a documented (not silently ungoverned) entry.
 *
 * @type {readonly string[]}
 */
export const COST_METRIC_SAFE_ATTRIBUTES = Object.freeze([ATTR_MCP_TOOL_PRICING_STATUS]);

/**
 * Attribute keys from THIS file (spec + custom, non-cost) safe to attach to
 * mcp.tool.calls / mcp.tool.errors / mcp.tool.silent_failures /
 * mcp.tool.duration metric labels. Added by docs/adr/021-tool-name-cardinality.md
 * to close a mechanism gap that ADR found: none of this file's own
 * governance lists (this one, COST_METRIC_SAFE_ATTRIBUTES above,
 * fingerprint/attributes.js's and schema-drift/attributes.js's
 * same-named exports) were ever actually consulted by any metric
 * call site — src/metrics.js, src/thrash/emitter.js, and
 * src/schema-drift/emitter.js each attached labels without checking
 * against any list. A dev-time cross-check test now enforces membership
 * here for every future attribute; see that test for the current file
 * list it covers.
 *
 * ATTR_GEN_AI_TOOL_NAME's presence here is a deliberate, documented
 * acceptance of the status quo ADR 021 Decision 3 argues for (document
 * only, do not validate or bucket unrecognized tool names) — NOT a fresh
 * safety claim that the value space is bounded. It isn't: see ADR 021's
 * Context section and docs/known-gaps.md entry 11, which corrects two
 * earlier ADR passages (010, 012) that asserted this attribute was
 * already a bounded, metric-safe value without having verified the value
 * space itself, only that the label mechanism worked.
 *
 * ATTR_ERROR_TYPE's presence here is a documented, explicit call, made
 * after ADR 021 Decision 5 surfaced it as "the one genuinely awkward
 * entry" — not an oversight and not a precedent for adding a value
 * without checking its boundedness first. Its value space is bounded by
 * construction, not by an enforced runtime check: on the isError path
 * it's the fixed constant ERROR_TYPE_TOOL_ERROR; on the thrown path it's
 * `err?.name`, capped at MAX_ERROR_CLASS_LENGTH (128 characters) in
 * src/instrument.js. That cap bounds the length and shape of any ONE
 * value; it does not bound the SIZE of the set of distinct values a
 * codebase's own error class names can produce — the same "well-behaved
 * code, not an enforced property" framing ADR 004 already applies to this
 * attribute. Tellingly, the identical underlying value — err.name,
 * length-capped the same way — is mcp.failure.error_class
 * (ATTRIBUTE_KEYS.ERROR_CLASS, fingerprint/attributes.js), and THAT
 * attribute is deliberately excluded from fingerprint/attributes.js's own
 * METRIC_SAFE_ATTRIBUTES for exactly this reason. error.type reaching a
 * label here is that same value arriving by a different route (spec
 * attribute governance in this file, not fingerprint domain governance) —
 * recorded here, not silently allowed, per docs/known-gaps.md entry 11
 * and ADR 021 Decision 5.
 *
 * ATTR_MCP_TOOL_MODEL's presence here is likewise a documented call, not
 * a default. It passes isValidModelId() (src/cost/calculator.js, ADR 019
 * Part 2) before ever reaching a label — a shape/length gate
 * (`/^[A-Za-z0-9._:/@-]{1,256}$/`) — but that gate bounds what any ONE
 * value can look like, not how many distinct values a deployment can
 * produce; a 256-character identifier pattern still admits an effectively
 * unbounded set. See ADR 016 and ADR 019 Part 2 for this attribute's own
 * mitigation lineage, and docs/known-gaps.md entry 11 for the
 * unbounded-set caveat this list is recording, not re-deciding — nothing
 * about those documents' conclusions changes here.
 *
 * Neither entry above is evidence that an unbounded value is fine on a
 * metric label. Both are shape/length-bounded, not set-bounded, and both
 * are here because that specific gap was weighed and accepted
 * (gen_ai.tool.name: ADR 021 Decision 3; error.type and mcp.tool.model:
 * this docblock), not because listing two imperfect entries makes a
 * third easier to wave through. A genuinely unbounded value — arbitrary
 * request or response content with no cap at all — belongs on a span,
 * never here, regardless of what's already in this array.
 *
 * @type {readonly string[]}
 */
export const METRIC_SAFE_ATTRIBUTES = Object.freeze([
  ATTR_GEN_AI_TOOL_NAME,
  ATTR_MCP_METHOD_NAME,
  ATTR_MCP_TOOL_OUTCOME,
  ATTR_ERROR_TYPE,
  ATTR_MCP_TOOL_MODEL,
]);

/** Resource attribute (setupNodeSdk: true only) naming DEFAULT_PRICING's lastVerified date. See ADR 016 point 3. */
export const ATTR_MCP_PRICING_DEFAULT_TABLE_LAST_VERIFIED = 'mcp.pricing.default_table_last_verified';

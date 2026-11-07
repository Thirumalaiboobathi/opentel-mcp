/**
 * @module security-events
 *
 * The one place that decides which span EVENTS the dashboard retains (ADR 033). `SerializedSpan` historically
 * carried attributes only. The v0.18 security signals include span events (tool definition integrity on
 * `tools/list` spans, sensitive tool audit on `tools/call` spans), so a small, fixed whitelist of events and of
 * attribute keys per event is kept, and nothing else: unknown events and keys are dropped, values must be a
 * string (capped), a finite number or a boolean, and a span keeps at most {@link MAX_EVENTS_PER_SPAN} events.
 * The whitelist mirrors what opentel-mcp core is allowed to emit (core ADRs 029 and 032); hostile or buggy
 * senders therefore cannot make the buffer hold more than that.
 */

/** @typedef {{ name: string, timeMs?: number, attributes: Record<string, string | number | boolean> }} SerializedSpanEvent */

export const MAX_EVENTS_PER_SPAN = 32;
export const MAX_EVENT_STRING_LENGTH = 256;

const TOOL = 'gen_ai.tool.name';

/** @type {ReadonlyMap<string, ReadonlySet<string>>} event name -> allowed attribute keys */
export const SECURITY_EVENT_ATTRIBUTES = new Map([
  ['mcp.tool.integrity.changed', new Set([TOOL, 'mcp.tool.integrity.old_hash', 'mcp.tool.integrity.new_hash'])],
  [
    'mcp.tool.integrity.pin_mismatch',
    new Set([TOOL, 'mcp.tool.integrity.expected_hash', 'mcp.tool.integrity.actual_hash', 'mcp.tool.integrity.severity']),
  ],
  ['mcp.tool.integrity.added', new Set([TOOL, 'mcp.tool.integrity.new_hash'])],
  ['mcp.tool.integrity.removed', new Set([TOOL, 'mcp.tool.integrity.old_hash'])],
  ['mcp.audit.sensitive_call', new Set([TOOL, 'mcp.tool.outcome', 'mcp.tool.duration_ms', 'mcp.failure.category'])],
]);

/**
 * @param {unknown} value
 * @returns {string | number | boolean | undefined}
 */
function sanitizeValue(value) {
  if (typeof value === 'string') return value.length > MAX_EVENT_STRING_LENGTH ? value.slice(0, MAX_EVENT_STRING_LENGTH) : value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'boolean') return value;
  return undefined;
}

/**
 * Keeps only whitelisted events and attributes. Never throws.
 *
 * @param {unknown} rawEvents - `ReadableSpan.events`-shaped: `{ name, time?, attributes? }[]`, with `attributes`
 *   already a plain object, and `timeMs` supplied by the caller's decoder when known.
 * @returns {SerializedSpanEvent[]} possibly empty.
 */
export function sanitizeSpanEvents(rawEvents) {
  /** @type {SerializedSpanEvent[]} */
  const out = [];
  try {
    if (!Array.isArray(rawEvents)) return out;
    for (const raw of rawEvents) {
      if (out.length >= MAX_EVENTS_PER_SPAN) break;
      const allowed = typeof raw?.name === 'string' ? SECURITY_EVENT_ATTRIBUTES.get(raw.name) : undefined;
      if (!allowed) continue;
      /** @type {Record<string, string | number | boolean>} */
      const attributes = {};
      const source = raw.attributes && typeof raw.attributes === 'object' ? raw.attributes : {};
      for (const key of allowed) {
        const value = sanitizeValue(source[key]);
        if (value !== undefined) attributes[key] = value;
      }
      /** @type {SerializedSpanEvent} */
      const event = { name: raw.name, attributes };
      if (typeof raw.timeMs === 'number' && Number.isFinite(raw.timeMs)) event.timeMs = raw.timeMs;
      out.push(event);
    }
  } catch {
    return out;
  }
  return out;
}

/** True when a span's name is `tools/list` and it carries at least one retained security event. */
export function isSecurityListSpan(name, events) {
  return typeof name === 'string' && (name === 'tools/list' || name.startsWith('tools/list ')) && Array.isArray(events) && events.length > 0;
}

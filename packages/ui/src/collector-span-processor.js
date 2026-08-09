/**
 * @module collector-span-processor
 *
 * The ingestion hook: a standard OTel `SpanProcessor`
 * (`@opentelemetry/sdk-trace`'s `SpanProcessor` interface -- the same
 * extension point `SimpleSpanProcessor`/`BatchSpanProcessor` implement,
 * NOT something opentel-mcp core invented or needed to add). Registering
 * one more processor on the same `TracerProvider` opentel-mcp core's spans
 * already flow through is how this package observes them -- see
 * `with-ui.js`'s docblock for exactly how it's attached, and why this
 * counts as "the existing hook," not a new emission path: opentel-mcp
 * core's own `wrapToolCallHandler` (`instrument.js`) is completely
 * unaware this processor exists and does not change what it emits by one
 * byte.
 *
 * Filters to `tools/call`-shaped spans only (see `TOOLS_CALL_METHOD` in
 * opentel-mcp core's `instrument.js`) -- `tools/list` spans (schema drift,
 * ADR 010) aren't part of this contract and would otherwise pollute the
 * buffer with entries `SerializedSpan`'s `toolName` field can't
 * meaningfully describe.
 */

import { SpanBuffer } from './span-buffer.js';
import { serializeSpan } from './serialize-span.js';

/** @typedef {import('@opentelemetry/sdk-trace').SpanProcessor} SpanProcessor */
/** @typedef {import('./types.d.ts').SerializedSpan} SerializedSpan */

/**
 * @implements {SpanProcessor}
 */
export class CollectorSpanProcessor {
  /** @type {SpanBuffer} */
  #buffer;
  /** @type {Set<(span: SerializedSpan) => void>} */
  #listeners = new Set();

  /**
   * @param {{ capacity?: number }} [options]
   */
  constructor({ capacity } = {}) {
    this.#buffer = new SpanBuffer({ capacity });
  }

  get buffer() {
    return this.#buffer;
  }

  /**
   * Subscribes to every span as it's ingested (used by the SSE route to
   * push live updates and assign each event a monotonic id for
   * `Last-Event-ID` reconnect support). Returns an unsubscribe function.
   *
   * @param {(span: SerializedSpan, seq: number) => void} listener
   * @returns {() => void}
   */
  subscribe(listener) {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** @param {import('@opentelemetry/sdk-trace').Span} _span */
  /** @param {import('@opentelemetry/api').Context} _parentContext */
  onStart(_span, _parentContext) {
    // Nothing to do at start -- this dashboard is a post-hoc viewer, not a
    // live-progress tracker. Required by the SpanProcessor interface.
  }

  /**
   * @param {import('@opentelemetry/sdk-trace').ReadableSpan} span
   * @returns {void}
   */
  onEnd(span) {
    if (!span.name.startsWith('tools/call')) return;
    this.ingestSerializedSpan(serializeSpan(span));
  }

  /**
   * Ingests an already-serialised span directly, bypassing `onEnd()`'s
   * `ReadableSpan` conversion. Two real callers: the standalone CLI's
   * OTLP/HTTP JSON receiver (`otlp-json-receiver.js`), which parses OTLP's
   * wire format straight into `SerializedSpan` without ever constructing a
   * fake `ReadableSpan`; and this package's own tests, for which
   * constructing a `SerializedSpan` by hand is far simpler than a
   * spec-accurate fake `ReadableSpan`.
   *
   * @param {SerializedSpan} serialized
   * @returns {number} the sequence number assigned to this span.
   */
  ingestSerializedSpan(serialized) {
    this.#buffer.push(serialized);
    // totalPushed was just incremented by the push() above -- using it
    // directly as the sequence number means "seq N" and "the Nth span
    // ever pushed" are the same number, with no separate counter to keep
    // in sync.
    const seq = this.#buffer.totalPushed;
    for (const listener of this.#listeners) {
      try {
        listener(serialized, seq);
      } catch {
        // A broken SSE client write must never take down span ingestion
        // for every other listener -- same discipline opentel-mcp core
        // itself applies to every diag.warn call site.
      }
    }
    return seq;
  }

  async forceFlush() {
    // Nothing buffered upstream of the in-memory ring buffer -- pushes
    // are synchronous. Required by the SpanProcessor interface.
  }

  async shutdown() {
    this.#listeners.clear();
  }
}

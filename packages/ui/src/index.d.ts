import type { Server as HttpServer, IncomingMessage, ServerResponse } from 'node:http';
import type { SerializedSpan } from 'opentel-mcp-contract';

export interface WithUIOptions {
  /** @default 4319 */
  port?: number;
  /** Auto-open the dashboard in the default browser once listening. @default false */
  open?: boolean;
  /** Ring buffer capacity. @default 1000 */
  bufferCapacity?: number;
  /**
   * Asserts the deployment's transport topology when known, instead of
   * relying on best-effort structural detection — see `meta.js`'s
   * docblock (ADR 012) for why auto-detection can't always tell.
   * @default 'auto'
   */
  statelessTransport?: boolean | 'auto';
  /** Overrides the served `/` HTML (the SPA bundle, wired in Step 4). */
  spaHtml?: string;
  /** Seeds a realistic fixture (src/demo-fixture.js) for reviewing the UI with no live MCP server. @default false */
  demo?: boolean;
}

export interface WithUIHandle {
  server: HttpServer;
  collector: CollectorSpanProcessor;
  url: string;
  close: () => Promise<void>;
}

/**
 * In-process integration: attaches a `CollectorSpanProcessor` to whatever
 * `TracerProvider` opentel-mcp core's spans already flow through, and
 * starts the dashboard HTTP/SSE server. See `with-ui.js` for the full
 * docblock on why this needs no changes to opentel-mcp core.
 */
export function withUI(instrumentedServer: unknown, options?: WithUIOptions): Promise<WithUIHandle>;

export const DEFAULT_SPAN_BUFFER_CAPACITY: number;

/**
 * Fixed-capacity ring buffer of `SerializedSpan`s — bounded memory, O(1)
 * push, oldest-evicted-first. See `span-buffer.js`.
 */
export class SpanBuffer {
  constructor(options?: { capacity?: number });
  readonly capacity: number;
  readonly size: number;
  readonly totalPushed: number;
  push(span: SerializedSpan): void;
  toArray(): SerializedSpan[];
  clear(): void;
}

/**
 * The OTel `SpanProcessor` this package registers to observe spans — see
 * `collector-span-processor.js`.
 */
export class CollectorSpanProcessor {
  constructor(options?: { capacity?: number });
  readonly buffer: SpanBuffer;
  subscribe(listener: (span: SerializedSpan, seq: number) => void): () => void;
  onStart(span: unknown, parentContext: unknown): void;
  onEnd(span: unknown): void;
  ingestSerializedSpan(serialized: SerializedSpan): number;
  forceFlush(): Promise<void>;
  shutdown(): Promise<void>;
}

// Re-exported purely so a consumer writing their own request middleware
// (e.g. embedding this dashboard's routes inside a larger app) can type
// against the same handler shape `createServer()`/`createRequestHandler()`
// use internally, without reaching into server.js directly.
export type RequestHandler = (req: IncomingMessage, res: ServerResponse) => void;

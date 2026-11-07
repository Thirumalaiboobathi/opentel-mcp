/**
 * Test-only stand-in for the deprecated `@opentelemetry/sdk-trace-node`
 * `NodeTracerProvider`: the supported `@opentelemetry/sdk-trace`
 * `TracerProvider` has no `register()`, which the suite uses to install the
 * global tracer provider (and optionally a context manager / propagator).
 * Same semantics as the old `register()`: `undefined` installs the default,
 * `null` skips it.
 */
import { trace, context, propagation } from '@opentelemetry/api';
import {
  TracerProvider,
  SimpleSpanProcessor as BaseSimpleSpanProcessor,
  BatchSpanProcessor as BaseBatchSpanProcessor,
} from '@opentelemetry/sdk-trace';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { CompositePropagator, W3CTraceContextPropagator, W3CBaggagePropagator } from '@opentelemetry/core';

export class NodeTracerProvider extends TracerProvider {
  register(config = {}) {
    trace.setGlobalTracerProvider(this);
    if (config.contextManager !== null) {
      const cm = config.contextManager ?? new AsyncLocalStorageContextManager();
      cm.enable();
      context.setGlobalContextManager(cm);
    }
    if (config.propagator !== null) {
      propagation.setGlobalPropagator(
        config.propagator ??
          new CompositePropagator({ propagators: [new W3CTraceContextPropagator(), new W3CBaggagePropagator()] }),
      );
    }
  }
}

// The old sdk-trace-base processors took a bare exporter; the sdk-trace ones
// take `{ exporter }`. Accept both so the suite's call sites stay terse.
const asOptions = (x) => (x && typeof x.export === 'function' ? { exporter: x } : x);
export class SimpleSpanProcessor extends BaseSimpleSpanProcessor {
  constructor(x) {
    super(asOptions(x));
  }
}
export class BatchSpanProcessor extends BaseBatchSpanProcessor {
  constructor(x, ...rest) {
    super(rest.length ? { ...rest[0], exporter: x } : asOptions(x));
  }
}

export { InMemorySpanExporter } from '@opentelemetry/sdk-trace';

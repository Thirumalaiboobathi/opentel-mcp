import { expectTypeOf } from 'vitest';
import { instrumentMcpServer } from '../src/index.js';
import type { InstrumentOptions, ThrashConfig, ThrashSummary, ThrashOffender } from '../src/index.js';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';

// A consumer can construct options with a PARTIAL thrash config — every
// field individually optional, matching resolveThrashConfig()'s actual
// runtime behavior (src/thrash/config.js), not requiring the full
// ThrashConfig shape.
const partialThrash: InstrumentOptions = {
  thrashDetection: {
    threshold: 5,
    assumeSingleSession: true,
  },
};
expectTypeOf(partialThrash).toMatchTypeOf<InstrumentOptions>();

// ...and fingerprinting, which is just a boolean flag (not an object), so
// "partial" here means it's fine to omit entirely or supply on its own.
const partialFingerprinting: InstrumentOptions = {
  fingerprinting: false,
};
expectTypeOf(partialFingerprinting).toMatchTypeOf<InstrumentOptions>();

// Both together, alongside other top-level options — the case Phase 6 was
// actually about: none of this compiled before fingerprinting/thrashDetection
// were declared on InstrumentOptions.
const combined: InstrumentOptions = {
  serviceName: 'svc',
  fingerprinting: true,
  thrashDetection: {
    enabled: true,
    assumeSingleSession: true,
  },
};
expectTypeOf(combined).toMatchTypeOf<InstrumentOptions>();

// An empty thrashDetection object is also valid (every field defaults).
const emptyThrash: InstrumentOptions = { thrashDetection: {} };
expectTypeOf(emptyThrash).toMatchTypeOf<InstrumentOptions>();

// A fully-specified ThrashConfig (as resolveThrashConfig() returns) is
// assignable where a Partial<ThrashConfig> is expected.
const fullThrashConfig: ThrashConfig = {
  enabled: true,
  threshold: 3,
  windowMs: 60_000,
  maxTrackedKeys: 1000,
  entryTtlMs: 900_000,
  reEmitAfter: 3,
  assumeSingleSession: false,
};
expectTypeOf(fullThrashConfig).toMatchTypeOf<Partial<ThrashConfig>>();

// Negative check: an unknown field on thrashDetection must NOT type-check —
// guards against this test suite silently passing if ThrashConfig's fields
// ever stop being enforced. @ts-expect-error only suppresses the very next
// line, so it has to sit directly above the object literal, not the outer
// statement.
const invalidThrash: InstrumentOptions = {
  // @ts-expect-error -- "notARealField" is not a key of ThrashConfig
  thrashDetection: { notARealField: true },
};
void invalidThrash;

// instrumentMcpServer()'s returned object gets an optional
// getThrashSummary() (v0.6.0, additive — see index.d.ts's docblock on
// why it's optional: never attached when options.enabled is false).
declare const someServer: Server;
const instrumented = instrumentMcpServer(someServer);
expectTypeOf(instrumented.getThrashSummary).toEqualTypeOf<
  ((options?: { topOffendersLimit?: number }) => ThrashSummary) | undefined
>();

// A ThrashSummary/ThrashOffender a consumer builds by hand (e.g. in a
// mock, or a health-check response type) must match the real shape
// getThrashSummary() returns.
const summary: ThrashSummary = {
  activeLoops: 2,
  totalLoopsDetected: 5,
  totalWastedCostUsd: 0.42,
  totalWastedTokensIn: 1000,
  totalWastedTokensOut: 500,
  topOffenders: [],
};
expectTypeOf(summary).toEqualTypeOf<ThrashSummary>();

const offender: ThrashOffender = {
  toolName: 'search',
  fingerprint: 'fp-abc',
  loops: 3,
  wastedCostUsd: 0.03,
  wastedTokensIn: 30,
  wastedTokensOut: 15,
};
expectTypeOf(offender).toEqualTypeOf<ThrashOffender>();
expectTypeOf<ThrashSummary['topOffenders']>().toEqualTypeOf<readonly ThrashOffender[]>();

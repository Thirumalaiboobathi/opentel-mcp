import { expectTypeOf } from 'vitest';
import { instrumentMcpServer } from '../src/index.js';
import type { InstrumentOptions, ThrashConfig, ThrashSummary, ThrashOffender, FailureChannel } from '../src/index.js';
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

// ADR 007 Phase 3's per-channel thresholds (inputThreshold,
// notFoundThreshold) are individually optional on Partial<ThrashConfig>,
// same as every other thrashDetection field — a consumer must be able to
// set just one without supplying the rest.
const partialInputThreshold: InstrumentOptions = {
  thrashDetection: {
    inputThreshold: 8,
  },
};
expectTypeOf(partialInputThreshold).toMatchTypeOf<InstrumentOptions>();

const partialNotFoundThreshold: InstrumentOptions = {
  thrashDetection: {
    notFoundThreshold: 2,
  },
};
expectTypeOf(partialNotFoundThreshold).toMatchTypeOf<InstrumentOptions>();

// Both per-channel thresholds together, alongside the pre-existing
// threshold field — all three are independent, not mutually exclusive.
const partialAllThresholds: InstrumentOptions = {
  thrashDetection: {
    threshold: 3,
    inputThreshold: 8,
    notFoundThreshold: 2,
  },
};
expectTypeOf(partialAllThresholds).toMatchTypeOf<InstrumentOptions>();

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
  inputThreshold: 5,
  notFoundThreshold: 1,
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

// Same negative check, specifically for a typo'd per-channel threshold
// field name — guards against inputThreshold/notFoundThreshold silently
// stopping being enforced the same way notARealField above guards the
// rest of ThrashConfig.
const invalidPerChannelThrash: InstrumentOptions = {
  // @ts-expect-error -- "inputThresholdTypo" is not a key of ThrashConfig
  thrashDetection: { inputThresholdTypo: 5 },
};
void invalidPerChannelThrash;

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

// FailureChannel (ADR 007, v0.7.0 Phase 4): the exact six-member union
// classifyFailureChannel() can produce, importable from the package root
// without reaching into src/fingerprint/classify/channel.js directly.
expectTypeOf<FailureChannel>().toEqualTypeOf<
  'execution' | 'protocol.not_found' | 'protocol.input' | 'protocol.output' | 'protocol.other' | 'unknown'
>();

// Each individual literal must be assignable -- if any one of these six
// weren't a real member of FailureChannel, the corresponding line below
// would fail to compile.
const execution: FailureChannel = 'execution';
const notFound: FailureChannel = 'protocol.not_found';
const input: FailureChannel = 'protocol.input';
const output: FailureChannel = 'protocol.output';
const other: FailureChannel = 'protocol.other';
const unknownChannel: FailureChannel = 'unknown';
void execution;
void notFound;
void input;
void output;
void other;
void unknownChannel;

// Negative check: an arbitrary string is not a valid FailureChannel — this
// is a closed union, not `string`. Guards against FailureChannel silently
// widening.
// @ts-expect-error -- "protocol.something_else" is not a member of FailureChannel
const invalidChannel: FailureChannel = 'protocol.something_else';
void invalidChannel;

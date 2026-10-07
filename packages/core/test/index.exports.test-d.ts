import { expectTypeOf } from 'vitest';
import { instrumentMcpServer } from '../src/index.js';
import type {
  InstrumentOptions,
  ThrashConfig,
  ThrashSummary,
  ThrashOffender,
  FailureChannel,
  SchemaDriftConfig,
  SchemaDriftKind,
  SchemaDriftEvent,
  ToolOutcome,
  ToolOutcomeCounts,
  ObservationIntegrity,
  ObservationState,
  DuckTypedServer,
  DuckTypedMcpServer,
  ErrorRecordingConfig,
  ErrorRecordingRedactor,
  ErrorRecordingRedactorFields,
} from '../src/index.js';
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

// instanceKey (ADR 012, Phase 2/3): a plain optional string, same shape as
// fingerprinting above — no nested config object, so this is the whole
// surface a consumer sees for it. Omittable...
const noInstanceKey: InstrumentOptions = {};
expectTypeOf(noInstanceKey).toMatchTypeOf<InstrumentOptions>();

// ...or supplied on its own, alongside other top-level options.
const withInstanceKey: InstrumentOptions = {
  serviceName: 'svc',
  instanceKey: 'my-service',
};
expectTypeOf(withInstanceKey).toMatchTypeOf<InstrumentOptions>();
expectTypeOf<InstrumentOptions['instanceKey']>().toEqualTypeOf<string | undefined>();

// Negative check: a non-string instanceKey must NOT type-check — guards
// against this field silently widening to `any`/`unknown` later. Same
// negative-check discipline as invalidThrash/invalidSchemaDrift below.
const invalidInstanceKey: InstrumentOptions = {
  // @ts-expect-error -- instanceKey must be a string, not a number
  instanceKey: 12345,
};
void invalidInstanceKey;

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

// Tool schema drift detection (ADR 010, v0.8.0): a consumer can construct
// options with a PARTIAL schemaDrift config — every field individually
// optional, matching resolveSchemaDriftConfig()'s actual runtime behavior
// (src/schema-drift/config.js), not requiring the full SchemaDriftConfig
// shape. Same pattern as partialThrash above.
const partialSchemaDrift: InstrumentOptions = {
  schemaDrift: {
    maxTrackedTools: 500,
  },
};
expectTypeOf(partialSchemaDrift).toMatchTypeOf<InstrumentOptions>();

// enabled alone, omitting maxTrackedTools entirely.
const partialSchemaDriftEnabled: InstrumentOptions = {
  schemaDrift: {
    enabled: false,
  },
};
expectTypeOf(partialSchemaDriftEnabled).toMatchTypeOf<InstrumentOptions>();

// An empty schemaDrift object is also valid (every field defaults) — same
// as emptyThrash above.
const emptySchemaDrift: InstrumentOptions = { schemaDrift: {} };
expectTypeOf(emptySchemaDrift).toMatchTypeOf<InstrumentOptions>();

// Both together, alongside other top-level options.
const combinedSchemaDrift: InstrumentOptions = {
  serviceName: 'svc',
  thrashDetection: { enabled: true },
  schemaDrift: { enabled: true, maxTrackedTools: 2000 },
};
expectTypeOf(combinedSchemaDrift).toMatchTypeOf<InstrumentOptions>();

// A fully-specified SchemaDriftConfig (as resolveSchemaDriftConfig()
// returns) is assignable where a Partial<SchemaDriftConfig> is expected.
const fullSchemaDriftConfig: SchemaDriftConfig = {
  enabled: true,
  maxTrackedTools: 1000,
};
expectTypeOf(fullSchemaDriftConfig).toMatchTypeOf<Partial<SchemaDriftConfig>>();

// Negative check: an unknown field on schemaDrift must NOT type-check —
// guards against this test suite silently passing if SchemaDriftConfig's
// fields ever stop being enforced. Same discipline as invalidThrash above.
const invalidSchemaDrift: InstrumentOptions = {
  // @ts-expect-error -- "notARealField" is not a key of SchemaDriftConfig
  schemaDrift: { notARealField: true },
};
void invalidSchemaDrift;

// SchemaDriftKind (ADR 010): the exact six-member union diffSchemas()
// (src/schema-drift/diff.js) can produce, importable from the package
// root without reaching into src/schema-drift/diff.js directly.
// Deliberately does NOT include 'description_changed' — see diff.js's own
// docblock for why that would be an unreachable member.
expectTypeOf<SchemaDriftKind>().toEqualTypeOf<
  'field_added' | 'field_removed' | 'type_changed' | 'required_changed' | 'multiple' | 'unknown'
>();

// Each individual literal must be assignable -- if any one of these six
// weren't a real member of SchemaDriftKind, the corresponding line below
// would fail to compile.
const fieldAdded: SchemaDriftKind = 'field_added';
const fieldRemoved: SchemaDriftKind = 'field_removed';
const typeChanged: SchemaDriftKind = 'type_changed';
const requiredChanged: SchemaDriftKind = 'required_changed';
const multiple: SchemaDriftKind = 'multiple';
const unknownKind: SchemaDriftKind = 'unknown';
void fieldAdded;
void fieldRemoved;
void typeChanged;
void requiredChanged;
void multiple;
void unknownKind;

// Negative check: an arbitrary string is not a valid SchemaDriftKind —
// this is a closed union, not `string`. Guards against SchemaDriftKind
// silently widening.
// @ts-expect-error -- "description_changed" is not a member of SchemaDriftKind
const invalidKind: SchemaDriftKind = 'description_changed';
void invalidKind;

// A SchemaDriftEvent a consumer builds by hand (e.g. typing their own
// span-event processing code) must match the real shape
// schemaDriftEmitter.emit() consumes (src/schema-drift/emitter.js).
const driftEvent: SchemaDriftEvent = {
  scope: 'server',
  toolName: 'search',
  previousHash: 'aaaaaaaaaaaaaaaa',
  currentHash: 'bbbbbbbbbbbbbbbb',
  kind: 'field_added',
  addedFields: ['limit'],
  removedFields: [],
  changedFields: [],
  requiredChanged: false,
};
expectTypeOf(driftEvent).toEqualTypeOf<SchemaDriftEvent>();
expectTypeOf<SchemaDriftEvent['kind']>().toEqualTypeOf<SchemaDriftKind>();
expectTypeOf<SchemaDriftEvent['addedFields']>().toEqualTypeOf<readonly string[]>();

// Two-axis observation contract (ADR 008 "Update (2026-08-05)"): ToolOutcome
// is the exact three-member union the ADR specifies, importable from the
// package root without reaching into src/observation/types.d.ts directly.
expectTypeOf<ToolOutcome>().toEqualTypeOf<'SUCCESS' | 'FAILURE' | 'UNKNOWN'>();

const success: ToolOutcome = 'SUCCESS';
const failure: ToolOutcome = 'FAILURE';
const unknownOutcome: ToolOutcome = 'UNKNOWN';
void success;
void failure;
void unknownOutcome;

// Negative check: an arbitrary string is not a valid ToolOutcome — a
// closed union, not `string`.
// @ts-expect-error -- "SUCCEEDED" is not a member of ToolOutcome
const invalidOutcome: ToolOutcome = 'SUCCEEDED';
void invalidOutcome;

// ToolOutcomeCounts is the cumulative counts breakdown
// getObservationState().toolOutcome actually returns (a raw breakdown,
// not a single collapsed ToolOutcome verdict — see observation/types.d.ts).
const counts: ToolOutcomeCounts = { success: 2, failure: 1, unknown: 0 };
expectTypeOf(counts).toEqualTypeOf<ToolOutcomeCounts>();

// ObservationIntegrity: the exact two-member union ADR 008's Finding 1
// concluded — HEALTHY is unreachable in every configuration and must NOT
// be part of the type at all, not merely unused at runtime. This is the
// core assertion this phase asks for: the type system enforces what the
// ADR concluded, not just documentation saying so.
expectTypeOf<ObservationIntegrity>().toEqualTypeOf<'DEGRADED' | 'UNKNOWN'>();

const degraded: ObservationIntegrity = 'DEGRADED';
const integrityUnknown: ObservationIntegrity = 'UNKNOWN';
void degraded;
void integrityUnknown;

// Negative check: 'HEALTHY' must not be assignable to ObservationIntegrity
// — this is the one @ts-expect-error in this file that isn't guarding
// against a typo, it's guarding against ADR 008's own conclusion being
// silently relaxed later (e.g. someone adding HEALTHY back without
// revisiting Finding 1's reasoning).
// @ts-expect-error -- "HEALTHY" is not, and must never become, a member of ObservationIntegrity
const invalidIntegrity: ObservationIntegrity = 'HEALTHY';
void invalidIntegrity;

// Also guard against the union silently widening to `string` in general
// (a broader version of the same mistake).
// @ts-expect-error -- an arbitrary string is not a valid ObservationIntegrity
const arbitraryIntegrity: ObservationIntegrity = 'not-a-real-value';
void arbitraryIntegrity;

// ObservationState is exactly what getObservationState() returns — a
// consumer typing their own health-check response, or a mock, must match
// this shape.
const observationState: ObservationState = {
  toolOutcome: { success: 10, failure: 2, unknown: 0 },
  observationIntegrity: 'DEGRADED',
};
expectTypeOf(observationState).toEqualTypeOf<ObservationState>();
expectTypeOf<ObservationState['observationIntegrity']>().toEqualTypeOf<ObservationIntegrity>();
expectTypeOf<ObservationState['toolOutcome']>().toEqualTypeOf<ToolOutcomeCounts>();

// instrumentMcpServer()'s returned object gets an optional
// getObservationState() (v0.8.0, additive — see index.d.ts's docblock on
// why it's optional: never attached when options.enabled is false), same
// pattern as the existing getThrashSummary assertion above.
const instrumentedForObservation = instrumentMcpServer(someServer);
expectTypeOf(instrumentedForObservation.getObservationState).toEqualTypeOf<(() => ObservationState) | undefined>();

// ADR 015 Phase 2/4: instrumentMcpServer() must accept v2-shaped objects
// too, WITHOUT this package (or this test file) ever importing
// @modelcontextprotocol/server's actual types — it's an optional peer
// dependency, and referencing its types directly from index.d.ts breaks
// type-checking for every consumer who only has @modelcontextprotocol/sdk
// installed (confirmed empirically during Phase 4, not assumed — see
// DuckTypedServer's own docblock in index.d.ts). These two values are
// PURELY STRUCTURAL — no import of @modelcontextprotocol/server anywhere
// in this file — deliberately, to prove the DuckTypedServer/DuckTypedMcpServer
// fallback types alone are sufficient, the same way a real v1/v2 object
// would be at runtime.
declare const v2LowLevelShaped: { setRequestHandler(method: string, handler: (...args: unknown[]) => unknown): void };
expectTypeOf(v2LowLevelShaped).toMatchTypeOf<DuckTypedServer>();
const v2LowLevelInstrumented = instrumentMcpServer(v2LowLevelShaped);
expectTypeOf(v2LowLevelInstrumented.getThrashSummary).toEqualTypeOf<
  ((options?: { topOffendersLimit?: number }) => ThrashSummary) | undefined
>();

declare const v2McpServerShaped: {
  server: { setRequestHandler(method: string, handler: (...args: unknown[]) => unknown): void };
  registerTool(name: string, config: unknown, handler: (...args: unknown[]) => unknown): void;
};
expectTypeOf(v2McpServerShaped).toMatchTypeOf<DuckTypedMcpServer>();
const v2McpServerInstrumented = instrumentMcpServer(v2McpServerShaped);
expectTypeOf(v2McpServerInstrumented.getObservationState).toEqualTypeOf<(() => ObservationState) | undefined>();

// Negative check: an object with neither a low-level nor a high-level
// shape must still be rejected — DuckTypedServer/DuckTypedMcpServer widen
// what's accepted to cover v2, but must not widen all the way to
// accepting arbitrary objects.
// @ts-expect-error -- {} has neither setRequestHandler nor a .server property
instrumentMcpServer({});

// errorRecording.redactor (ADR 020, docs/adr/020-redactor-hook.md,
// v0.14.0 Phase 3): a consumer can write a typed redactor as a STANDALONE
// value, via the exported ErrorRecordingRedactor function type, then pass
// it straight into config — the same ergonomics UsageExtractor/Classifier
// already give their own function-shaped hooks (rather than only being
// typeable inline on ErrorRecordingConfig.redactor itself).
const myRedactor: ErrorRecordingRedactor = ({ message, stack }) => ({
  message: message.replace('SECRET', '[REDACTED]'),
  stack,
});
const withRedactor: InstrumentOptions = {
  errorRecording: { mode: 'normalized', redactor: myRedactor },
};
expectTypeOf(withRedactor).toMatchTypeOf<InstrumentOptions>();

// A redactor that spreads its input and only overrides `message` is also
// valid — confirms the required `stack` key (see the negative check
// below) doesn't burden ordinary idiomatic code, just code that forgets
// the field entirely.
const spreadRedactor: ErrorRecordingRedactor = (input) => ({
  ...input,
  message: input.message.toUpperCase(),
});
expectTypeOf(spreadRedactor).toMatchTypeOf<ErrorRecordingRedactor>();

// errorRecording.redactor is optional — omitting it (or the whole
// errorRecording option) is still valid, matching
// resolveErrorRecordingConfig()'s actual runtime default (no redactor
// configured).
const noRedactor: InstrumentOptions = { errorRecording: { mode: 'normalized' } };
expectTypeOf(noRedactor).toMatchTypeOf<InstrumentOptions>();

// A fully-specified ErrorRecordingConfig (as resolveErrorRecordingConfig()
// returns) is assignable where a Partial<ErrorRecordingConfig> is
// expected — same pattern as fullThrashConfig/fullSchemaDriftConfig
// above. `redactor` may legitimately be omitted even in this "resolved"
// shape (see ErrorRecordingConfig's own docblock — there's no default
// function to fall back to).
const fullErrorRecordingConfig: ErrorRecordingConfig = { mode: 'full' };
expectTypeOf(fullErrorRecordingConfig).toMatchTypeOf<Partial<ErrorRecordingConfig>>();

const fullErrorRecordingConfigWithRedactor: ErrorRecordingConfig = { mode: 'normalized', redactor: myRedactor };
expectTypeOf(fullErrorRecordingConfigWithRedactor).toMatchTypeOf<Partial<ErrorRecordingConfig>>();

// ErrorRecordingRedactorFields is the exact { message, stack } shape a
// redactor both receives and must return (ADR 020 Decision 1: one hook,
// one call, both fields together) — importable and usable on its own,
// e.g. for a consumer's own helper function's parameter/return type.
const fields: ErrorRecordingRedactorFields = { message: 'boom', stack: undefined };
expectTypeOf(fields).toEqualTypeOf<ErrorRecordingRedactorFields>();
expectTypeOf<ErrorRecordingRedactor>().toEqualTypeOf<(input: ErrorRecordingRedactorFields) => ErrorRecordingRedactorFields>();

// Negative check: a redactor returning a non-string message must NOT
// type-check — guards against ErrorRecordingRedactor silently widening to
// accept `any`/`unknown` return shapes.
const invalidRedactorReturn: ErrorRecordingRedactor = ({ message, stack }) => ({
  // @ts-expect-error -- message must be a string, not a number
  message: 42,
  stack,
});
void invalidRedactorReturn;

// Negative check: a redactor missing the `stack` key on its return value
// must NOT type-check — the required (non-optional) key forces explicit
// handling (pass it through, or deliberately set it to `undefined`)
// rather than silently dropping stack content by omission. ADR 020's own
// "a message-only redactor can just return `stack` unchanged" guidance
// means passthrough, not omission — see ErrorRecordingRedactorFields'
// own docblock.
// @ts-expect-error -- return value is missing the required `stack` key
const missingStackRedactor: ErrorRecordingRedactor = ({ message }) => ({ message: message.toUpperCase() });
void missingStackRedactor;

// Negative check: a redactor with the wrong parameter shape (a bare
// string instead of { message, stack }) must NOT type-check.
// @ts-expect-error -- parameter must be { message, stack }, not a bare string
const wrongParamRedactor: ErrorRecordingRedactor = (rawMessage: string) => ({ message: rawMessage, stack: undefined });
void wrongParamRedactor;

// Negative check: an async (Promise-returning) redactor must NOT
// type-check — ADR 020's Constraints section explicitly rejects
// async/Promise support (no motivating use case needs I/O, and every
// other step in this pipeline is synchronous by design; see the ADR's
// "Timing" section on why a synchronous hook has no enforceable timeout
// either).
// @ts-expect-error -- ErrorRecordingRedactor must return synchronously, not a Promise
const asyncRedactor: ErrorRecordingRedactor = async ({ message, stack }) => {
  return { message, stack };
};
void asyncRedactor;

// Negative check: an unknown field on errorRecording must NOT type-check —
// guards against this suite silently passing if ErrorRecordingConfig's
// fields ever stop being enforced. Same discipline as invalidThrash/
// invalidSchemaDrift above.
const invalidErrorRecording: InstrumentOptions = {
  // @ts-expect-error -- "notARealField" is not a key of ErrorRecordingConfig
  errorRecording: { notARealField: true },
};
void invalidErrorRecording;

// ADR 024: flushOnExit accepts a boolean or { timeoutMs }.
const flushOnExitOn: InstrumentOptions = { serviceName: 's', setupNodeSdk: true, flushOnExit: true };
const flushOnExitOff: InstrumentOptions = { serviceName: 's', setupNodeSdk: true, flushOnExit: false };
const flushOnExitTimeout: InstrumentOptions = { serviceName: 's', setupNodeSdk: true, flushOnExit: { timeoutMs: 500 } };
void flushOnExitOn;
void flushOnExitOff;
void flushOnExitTimeout;
// @ts-expect-error -- timeoutMs must be a number
const flushOnExitBad: InstrumentOptions = { flushOnExit: { timeoutMs: '500' } };
void flushOnExitBad;

// ADR 026: opt-in resources/prompts coverage.
const coverageBoth: InstrumentOptions = { coverage: { resources: true, prompts: true } };
const coverageOne: InstrumentOptions = { coverage: { prompts: true } };
void coverageBoth;
void coverageOne;
// @ts-expect-error -- coverage flags are booleans
const coverageBad: InstrumentOptions = { coverage: { resources: 'yes' } };
void coverageBad;

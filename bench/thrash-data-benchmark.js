/**
 * Agent Thrash Detection — DATA benchmark (v0.6.0, Phase 8).
 *
 * Separate from test/thrash/benchmark.test.js (which measures CPU/memory
 * performance of the detection code itself). This script measures a
 * different question: given a configured mix of healthy and genuinely
 * broken tool calls, how often does thrash detection actually fire, and
 * what does it say the wasted tokens/cost were? Its output is meant to be
 * published, so read the "IMPORTANT" block below before trusting any
 * number it prints.
 *
 * How to run:
 *   node bench/thrash-data-benchmark.js
 *   node bench/thrash-data-benchmark.js --sessions=5000 --brokenRate=0.2 --seed=42
 *   node bench/thrash-data-benchmark.js --out=bench/results/my-run
 *   node bench/thrash-data-benchmark.js --sweep --seed=42
 *   node bench/thrash-data-benchmark.js --sweep --sweepRates=0.05,0.10,0.20 --out=bench/results/my-sweep
 *
 * All flags (see DEFAULT_CONFIG below for the full list and defaults):
 *   --sessions=N          number of simulated agent sessions
 *   --brokenRate=0..1     fraction of sessions whose tool is genuinely broken (ignored in --sweep mode)
 *   --minAttempts=N       fewest retries a broken session makes before giving up
 *   --maxAttempts=N       most retries a broken session makes before giving up
 *   --baseTokensIn=N      input tokens on a session's first attempt
 *   --baseTokensOut=N     output tokens on every attempt (held constant — see IMPORTANT)
 *   --tokensInGrowth=N    additional input tokens on each retry beyond the first (context accumulation)
 *   --model=name          must be a key in DEFAULT_PRICING (src/cost/pricing.js)
 *   --toolName=name       tool name used for every simulated call
 *   --seed=N              PRNG seed — same seed + same flags = bit-identical results
 *   --out=path/prefix     output file path prefix, extension(s) appended. Default: see writeReports()/
 *                         writeSweepReports() below. Only appears in the printed reproduce command when
 *                         you actually pass it — the default path isn't part of what makes a run reproducible.
 *   --sweep               sweep mode: run once per brokenToolRate in --sweepRates instead of a single run
 *   --sweepRates=a,b,c    comma-separated brokenToolRate list for --sweep. Default: 0.02,0.05,0.10,0.15,0.25
 *
 * IMPORTANT — read before citing any number this script prints:
 *
 *   1. Sessions are REAL, but retries are NOT. Each simulated session gets
 *      a real, distinct MCP session (see "Session isolation" below) and
 *      every tool call is a real JSON-RPC round trip through a real
 *      instrumentMcpServer()-wrapped Server, over a real (in-process)
 *      transport. But the DECISION to retry, how many times, and how much
 *      the context grows per retry, is a scripted policy in this file —
 *      not a real LLM agent loop. This benchmark measures "if failures and
 *      retries look like THIS, what does the detector report," not "this
 *      is how often real agents thrash."
 *   2. brokenToolRate and the retry range are CONFIGURED INPUTS, not
 *      numbers measured from production traffic. Treat any run as
 *      illustrative of the mechanism, not a claim about real-world
 *      prevalence. Re-run with your own observed rates for a number you
 *      can defend for your own deployment. In --sweep mode this is worth
 *      repeating even more directly: brokenToolRate is an INPUT the reader
 *      supplies (a whole list of them, here), not a measured property of
 *      any real deployment — the table shows sensitivity to that input,
 *      not a prediction of which row describes you.
 *   3. Every simulated retry happens back-to-back with no delay, so every
 *      retry always lands inside thrashDetection's default 60s window.
 *      Real agents may pace retries further apart (backoff, human review,
 *      waiting on a timeout) — if the real spacing exceeds the window,
 *      real-world detection rates would be LOWER than what this script
 *      shows. This assumption inflates the detected-loop rate.
 *   4. Every simulated failure returns byte-identical error text, so its
 *      v0.4 fingerprint is perfectly stable across every retry. A real
 *      broken tool's error message may vary in ways fingerprint
 *      normalization doesn't fully collapse (see src/fingerprint/normalize/),
 *      which would fragment retries across multiple fingerprints and
 *      suppress detection. This assumption also inflates the detected-loop
 *      rate.
 *   5. Only ONE tool/failure mode is simulated. Real deployments run many
 *      tools with different failure characteristics; these percentages and
 *      dollar totals do not directly transfer to a multi-tool deployment.
 *   6. The "standard OTel" counterfactual (see COUNTERFACTUAL below) is
 *      zero BY CONSTRUCTION, not an empirical finding: every simulated
 *      failure returns `isError: true` rather than throwing, because that
 *      is the exact scenario this whole feature targets (see the
 *      project's own "Tool-level failures" story). It is not a surprising
 *      discovery about real tool-call traffic.
 *   7. Output tokens are held constant per attempt in this model; only
 *      input tokens grow (linearly) with retry count, modeling context
 *      accumulation. A real agent's output length could also grow or
 *      shrink per retry — not modeled here.
 *   8. "Mean loop length" reflects each session's LAST EMITTED
 *      ThrashDetectedEvent, not its raw attempt count. Because detection
 *      re-emits every reEmitAfter calls past threshold (default: every 3),
 *      a session that gave up between re-emit points (e.g. 5 attempts,
 *      with threshold 3 and reEmitAfter 3 — events fire at 3, not again at
 *      5) shows loopLength 3, not 5. This is the same number a real
 *      production dashboard would show for that session, not a benchmark
 *      artifact — but it means mean loop length is systematically <= mean
 *      attempts among detected sessions.
 *
 * Session isolation: every simulated session is assigned its own distinct,
 * real extra.sessionId. This script does NOT call the request handler
 * directly (unlike this project's own test suite) — it drives a real
 * @modelcontextprotocol/sdk Client against a real, instrumentMcpServer()-
 * wrapped Server, connected via InMemoryTransport.createLinkedPair(). The
 * SDK has no built-in multi-session support for InMemoryTransport (each
 * linked pair is inherently a single connection), so this script sets the
 * server-side InMemoryTransport's own public `sessionId` property before
 * each simulated session's calls. That is not a workaround specific to
 * this script: per @modelcontextprotocol/sdk's shared/protocol.js,
 * `_onrequest()` reads `capturedTransport.sessionId` (the currently-
 * connected transport's own sessionId property, captured fresh per
 * request) to populate `extra.sessionId` for every request handler — the
 * same mechanism a real stateful transport (e.g. StreamableHTTPServerTransport)
 * uses internally. This script exercises that mechanism directly rather
 * than reimplementing or bypassing it. The number of distinct session
 * keys actually observed (across both ThrashDetector.record() and
 * .clearOnSuccess() — record() alone only sees sessions with at least one
 * failure) is asserted equal to the number of sessions simulated before
 * any result is reported, on every run (single or per sweep row) — see
 * assertSessionIsolation() below, which aborts (non-zero exit) if not.
 *
 * Sweep mode additionally sanity-checks each row's empirical detected-loop
 * rate against the closed-form expectation
 * (brokenToolRate x P(attempts >= threshold)) and aborts rather than
 * shipping a row that deviates beyond normal sampling noise — see
 * sanityCheckAgainstClosedForm() below.
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve as resolvePath } from 'node:path';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { instrumentMcpServer } from '../src/instrument.js';
import { ThrashDetector } from '../src/thrash/detector.js';
import { resolveThrashConfig } from '../src/thrash/config.js';
import { DEFAULT_PRICING } from '../src/cost/pricing.js';

// Referenced by nothing at runtime except to anchor relative default output
// paths to this file's own directory's parent (the repo root) — see
// resolveOutputPrefix() below, which resolves --out relative to CWD
// instead, matching normal CLI conventions (this repo's own examples/ and
// docs consistently assume `node bench/thrash-data-benchmark.js` is run
// from the repo root).
const __filename = fileURLToPath(import.meta.url);

const DEFAULT_CONFIG = {
  sessionCount: 5000,
  brokenToolRate: 0.15,
  minAttempts: 1,
  maxAttempts: 6,
  baseTokensIn: 800,
  baseTokensOut: 150,
  tokensInGrowthPerRetry: 250,
  model: 'claude-sonnet-5',
  toolName: 'lookup_customer_record',
  seed: 20260802,
  outPrefix: null, // null = "not explicitly set" — see resolveConfig()/reproduce-string builder below
};

const DEFAULT_SWEEP_RATES = [0.02, 0.05, 0.1, 0.15, 0.25];

const STATIC_FAILURE_TEXT = 'invalid input: missing required field "customer_id"';

/**
 * Minimal CLI parser: `--key=value` pairs, plus bare `--key` (no `=`) as a
 * boolean true (needed for `--sweep`). No new dependency — matches this
 * repo's zero-dependency stance.
 */
function parseArgs(argv) {
  const out = {};
  for (const raw of argv) {
    const withValue = /^--([^=]+)=(.*)$/.exec(raw);
    if (withValue) {
      out[withValue[1]] = withValue[2];
      continue;
    }
    const bare = /^--([^=]+)$/.exec(raw);
    if (bare) out[bare[1]] = true;
  }
  return out;
}

// Single source of truth mapping each config field to its CLI flag name —
// used both to parse argv and to print a working "reproduce this exact
// run" command. Keeping these in one place (rather than duplicated between
// resolveConfig() and the reproduce-string builder) is what makes the
// printed repro command actually correct instead of just plausible-looking.
const CLI_FLAG_BY_CONFIG_KEY = {
  sessionCount: 'sessions',
  brokenToolRate: 'brokenRate',
  minAttempts: 'minAttempts',
  maxAttempts: 'maxAttempts',
  baseTokensIn: 'baseTokensIn',
  baseTokensOut: 'baseTokensOut',
  tokensInGrowthPerRetry: 'tokensInGrowth',
  model: 'model',
  toolName: 'toolName',
  seed: 'seed',
  outPrefix: 'out',
};

const NUMERIC_CONFIG_KEYS = new Set([
  'sessionCount',
  'brokenToolRate',
  'minAttempts',
  'maxAttempts',
  'baseTokensIn',
  'baseTokensOut',
  'tokensInGrowthPerRetry',
  'seed',
]);

/** @param {Record<string, string | true>} flags — already-parsed CLI flags (see parseArgs). */
function resolveConfig(flags) {
  const config = {};
  for (const [configKey, flagName] of Object.entries(CLI_FLAG_BY_CONFIG_KEY)) {
    const raw = flags[flagName];
    if (raw === undefined) {
      config[configKey] = DEFAULT_CONFIG[configKey];
    } else {
      config[configKey] = NUMERIC_CONFIG_KEYS.has(configKey) ? Number(raw) : raw;
    }
  }
  return config;
}

/**
 * Builds the flag list for a "reproduce this exact run" command from a
 * resolved config, via the same CLI_FLAG_BY_CONFIG_KEY mapping
 * resolveConfig() uses. outPrefix is the one exception: included only when
 * it was actually set (config.outPrefix !== null, the only way it becomes
 * non-null — see DEFAULT_CONFIG above), since the output file location
 * isn't part of what makes a run's DATA reproducible, and always printing
 * the default would make copy-pasted repro commands overwrite whatever the
 * previous run wrote.
 */
function buildReproduceFlags(config) {
  return Object.entries(CLI_FLAG_BY_CONFIG_KEY)
    .filter(([configKey]) => configKey !== 'outPrefix' || config.outPrefix !== null)
    .map(([configKey, flagName]) => `--${flagName}=${config[configKey]}`);
}

/**
 * mulberry32 — a small, public-domain, deterministic PRNG. Used (not
 * Math.random()) so a given --seed reproduces bit-identical results;
 * required for "defend every number" reproducibility.
 *
 * @param {number} seed
 * @returns {() => number} in [0, 1)
 */
function mulberry32(seed) {
  let state = seed | 0;
  return function () {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Uniform random integer in [min, max], inclusive. */
function randomIntInclusive(rng, min, max) {
  return min + Math.floor(rng() * (max - min + 1));
}

function percentile(sortedAscending, p) {
  if (sortedAscending.length === 0) return 0;
  const idx = Math.min(sortedAscending.length - 1, Math.floor(sortedAscending.length * p));
  return sortedAscending[idx];
}

function mean(values) {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

/**
 * Wires up one real Server, instruments it, connects it to one real Client
 * over InMemoryTransport, and registers the single simulated tool. The
 * tool's behavior (fail or succeed, exact token counts) is read from the
 * call's own `arguments` — no shared mutable state, so this stays correct
 * even if a future version of this script parallelizes calls.
 *
 * @param {ReturnType<typeof resolveConfig>} config
 * @returns {Promise<{ client: Client, server: Server, serverTransport: InMemoryTransport }>}
 */
async function setUpRealClientServerPair(config) {
  const server = new Server({ name: 'thrash-data-benchmark-server', version: '0.0.0' }, { capabilities: { tools: {} } });

  instrumentMcpServer(server, {
    serviceName: 'thrash-data-benchmark',
    costTracking: { pricingTable: DEFAULT_PRICING },
    // thrashDetection left at its real defaults (threshold 3, windowMs 60s,
    // reEmitAfter 3, ...) deliberately — this benchmark measures what a
    // default deployment would report, not a tuned scenario.
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { shouldFail, tokensIn, tokensOut } = request.params.arguments;
    return {
      isError: Boolean(shouldFail),
      content: [{ type: 'text', text: shouldFail ? STATIC_FAILURE_TEXT : 'ok' }],
      usage: { input_tokens: tokensIn, output_tokens: tokensOut },
      model: config.model,
    };
  });

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'thrash-data-benchmark-client', version: '0.0.0' });

  await server.connect(serverTransport);
  await client.connect(clientTransport);

  return { client, server, serverTransport };
}

/**
 * Monkey-patches both ThrashDetector.prototype.record AND .clearOnSuccess
 * to observe every call the real detector instance inside
 * instrumentMcpServer() receives. Both are needed for the session-isolation
 * check: record() only fires on the failure path (see
 * src/instrument.js's wrapToolCallHandler) — a session that succeeds on
 * its first attempt (every non-broken session in this benchmark) never
 * calls record() at all, only clearOnSuccess(). Taking the union of
 * sessionIds seen by both is what actually corresponds to "every session
 * this benchmark simulated," not record() alone.
 *
 * Also groups, per record() call that returns a ThrashDetectedEvent, which
 * sessionId that event belongs to — read directly off event.sessionId now
 * that ThrashDetectedEvent carries one, rather than needing to capture
 * input.sessionId at the call site separately (the two are always the same
 * value; reading it off the event is simpler and matches how any other
 * consumer of the return value would do it). Reads the same data the
 * emitter turns into metrics/span events, captured at the source — this
 * script does not stand up a MeterProvider/SpanExporter, since nothing
 * here reads OTel output.
 *
 * @returns {{ observedSessionIds: Set<string>, detectedEventsBySessionId: Map<string, object[]>, restore: () => void }}
 */
function observeThrashDetector() {
  const originalRecord = ThrashDetector.prototype.record;
  const originalClearOnSuccess = ThrashDetector.prototype.clearOnSuccess;
  const observedSessionIds = new Set();
  const detectedEventsBySessionId = new Map();

  ThrashDetector.prototype.record = function (input) {
    observedSessionIds.add(input?.sessionId);
    const event = originalRecord.call(this, input);
    if (event) {
      const eventsForSession = detectedEventsBySessionId.get(event.sessionId) ?? [];
      eventsForSession.push(event);
      detectedEventsBySessionId.set(event.sessionId, eventsForSession);
    }
    return event;
  };

  ThrashDetector.prototype.clearOnSuccess = function (sessionId, toolName) {
    observedSessionIds.add(sessionId);
    return originalClearOnSuccess.call(this, sessionId, toolName);
  };

  return {
    observedSessionIds,
    detectedEventsBySessionId,
    restore() {
      ThrashDetector.prototype.record = originalRecord;
      ThrashDetector.prototype.clearOnSuccess = originalClearOnSuccess;
    },
  };
}

/**
 * Aborts the whole run (non-zero exit) if the number of distinct session
 * keys the real detector observed doesn't match the number of sessions
 * this script simulated — a mismatch here would mean the session-isolation
 * mechanism silently failed, invalidating every other number below it.
 */
function assertSessionIsolation(observedSessionIds, expectedSessionCount) {
  if (observedSessionIds.size !== expectedSessionCount) {
    console.error(
      `ABORT: session isolation check failed. Expected ${expectedSessionCount} distinct session keys, ` +
        `ThrashDetector actually observed ${observedSessionIds.size}. Refusing to report results — they ` +
        'would not be trustworthy. This means the InMemoryTransport sessionId-injection technique this ' +
        'script relies on (see the "Session isolation" comment at the top of this file) did not work as ' +
        'expected, possibly due to an @modelcontextprotocol/sdk version change.',
    );
    process.exit(1);
  }
}

function resolvePricingOrAbort(config) {
  const pricing = DEFAULT_PRICING[config.model];
  if (!pricing) {
    console.error(`ABORT: --model=${config.model} is not a key in DEFAULT_PRICING (src/cost/pricing.js).`);
    process.exit(1);
  }
  return pricing;
}

/**
 * Runs one full simulation for one resolved config: sets up a real
 * client/server pair, replays config.sessionCount simulated sessions
 * (each broken with probability config.brokenToolRate, retrying a
 * uniform-random number of times in [minAttempts, maxAttempts] if so),
 * verifies session isolation, and computes results. Used by both
 * single-run mode and once per row in --sweep mode.
 *
 * @param {ReturnType<typeof resolveConfig>} config
 * @returns {Promise<{ results: object }>}
 */
async function runOneSimulation(config) {
  const rng = mulberry32(config.seed);
  const { client, server, serverTransport } = await setUpRealClientServerPair(config);
  const observer = observeThrashDetector();

  let totalCallsMade = 0;
  let thrownCallCount = 0; // the counterfactual: calls a bare try/catch span would have flagged as ERROR
  let brokenSessionCount = 0;

  for (let s = 0; s < config.sessionCount; s++) {
    const sessionId = `session-${s}`;
    serverTransport.sessionId = sessionId;

    const isBroken = rng() < config.brokenToolRate;
    const attempts = isBroken ? randomIntInclusive(rng, config.minAttempts, config.maxAttempts) : 1;
    if (isBroken) brokenSessionCount++;

    for (let attempt = 1; attempt <= attempts; attempt++) {
      const shouldFail = isBroken; // a genuinely broken tool never recovers mid-retry — see IMPORTANT #1
      const tokensIn = config.baseTokensIn + (shouldFail ? config.tokensInGrowthPerRetry * (attempt - 1) : 0);
      const tokensOut = config.baseTokensOut;

      try {
        await client.callTool({
          name: config.toolName,
          arguments: { shouldFail, tokensIn, tokensOut },
        });
      } catch {
        thrownCallCount++;
      }
      totalCallsMade++;
    }
  }

  await client.close();
  await server.close();
  observer.restore();

  assertSessionIsolation(observer.observedSessionIds, config.sessionCount);

  // A session can cross the threshold once and re-cross it again at
  // higher retry counts if reEmitAfter divides evenly (see
  // src/thrash/detector.js) — take each session's LAST detected event as
  // its final, fullest-extent loop measurement (see IMPORTANT #8).
  const sessionsInDetectedLoop = observer.detectedEventsBySessionId.size;
  const finalEvents = [...observer.detectedEventsBySessionId.values()].map((events) => events[events.length - 1]);
  const loopLengths = finalEvents.map((e) => e.loopLength).sort((a, b) => a - b);
  const totalWastedTokensIn = finalEvents.reduce((sum, e) => sum + e.wastedTokensIn, 0);
  const totalWastedTokensOut = finalEvents.reduce((sum, e) => sum + e.wastedTokensOut, 0);
  const totalWastedCostUsd = finalEvents.reduce((sum, e) => sum + e.wastedCostUsd, 0);

  const results = {
    sessionsSimulated: config.sessionCount,
    brokenSessionsSimulated: brokenSessionCount,
    totalCallsMade,
    sessionsInDetectedLoop,
    sessionsInDetectedLoopPercent: (100 * sessionsInDetectedLoop) / config.sessionCount,
    loopLength: {
      mean: mean(loopLengths),
      p50: percentile(loopLengths, 0.5),
      p95: percentile(loopLengths, 0.95),
    },
    totalWastedTokensIn,
    totalWastedTokensOut,
    totalWastedCostUsd,
    meanCostPerLoop: sessionsInDetectedLoop > 0 ? totalWastedCostUsd / sessionsInDetectedLoop : 0,
    counterfactualStandardOtelErrorCount: thrownCallCount,
    distinctSessionKeysObserved: observer.observedSessionIds.size,
    sessionIsolationVerified: observer.observedSessionIds.size === config.sessionCount,
  };

  return { results };
}

/**
 * Closed-form expected fraction of sessions that enter a detected loop:
 * brokenToolRate x P(attempts >= threshold), where attempts is uniform on
 * [minAttempts, maxAttempts]. Independent of reEmitAfter (that only
 * affects re-emission after the first crossing, not whether one happens)
 * and of windowMs (every simulated retry happens back-to-back, always
 * inside the window — see IMPORTANT #3).
 *
 * @param {ReturnType<typeof resolveConfig>} config
 * @param {number} threshold
 * @returns {number} in [0, 1]
 */
function computeExpectedLoopRate(config, threshold) {
  const { minAttempts, maxAttempts, brokenToolRate } = config;
  if (threshold > maxAttempts) return 0;
  const attemptValuesAtOrAboveThreshold = maxAttempts - Math.max(minAttempts, threshold) + 1;
  const totalAttemptValues = maxAttempts - minAttempts + 1;
  return brokenToolRate * (attemptValuesAtOrAboveThreshold / totalAttemptValues);
}

/**
 * Compares one sweep row's empirical detected-loop rate against the
 * closed-form expectation (computeExpectedLoopRate above) and aborts the
 * whole sweep (non-zero exit, no output written) if the deviation exceeds
 * what pure sampling noise would explain — a deviating row means a bug in
 * this harness, not something to publish. Tolerance: 4 standard errors of
 * a binomial proportion (~99.99% band under the null hypothesis "the
 * harness is correct"), floored at 0.5 percentage points so a very
 * small/large expected rate at moderate sessionCount doesn't produce a
 * near-zero tolerance and false-trigger on ordinary noise.
 *
 * @param {ReturnType<typeof resolveConfig>} rowConfig
 * @param {object} results
 * @param {number} threshold
 * @returns {{ expectedRatePercent: number, empiricalRatePercent: number, deviationPercentagePoints: number, toleranceUsedPercentagePoints: number }}
 */
function sanityCheckAgainstClosedForm(rowConfig, results, threshold) {
  const expectedRate = computeExpectedLoopRate(rowConfig, threshold);
  const empiricalRate = results.sessionsInDetectedLoopPercent / 100;
  const n = rowConfig.sessionCount;
  const standardError = Math.sqrt((expectedRate * (1 - expectedRate)) / n);
  const toleranceBands = 4;
  const tolerance = Math.max(0.005, toleranceBands * standardError);
  const deviation = Math.abs(empiricalRate - expectedRate);

  const diagnostic = {
    expectedRatePercent: expectedRate * 100,
    empiricalRatePercent: empiricalRate * 100,
    deviationPercentagePoints: deviation * 100,
    toleranceUsedPercentagePoints: tolerance * 100,
  };

  if (deviation > tolerance) {
    console.error(
      `ABORT: sweep sanity check failed for brokenToolRate=${rowConfig.brokenToolRate}. Closed form expects ~` +
        `${diagnostic.expectedRatePercent.toFixed(3)}% of sessions to enter a detected loop ` +
        `(brokenToolRate x P(attempts >= threshold=${threshold})), but this run observed ` +
        `${diagnostic.empiricalRatePercent.toFixed(3)}% — a deviation of ` +
        `${diagnostic.deviationPercentagePoints.toFixed(3)} percentage points, outside the ` +
        `${diagnostic.toleranceUsedPercentagePoints.toFixed(3)}-point tolerance (4 standard errors under the ` +
        'binomial model). This suggests a bug in the harness, not normal sampling noise. Refusing to ship ' +
        'this row — investigate before re-running.',
    );
    process.exit(1);
  }

  return diagnostic;
}

function buildLimitations() {
  return [
    'Retries happen back-to-back with no delay, so every retry always lands inside the 60s detection ' +
      'window; real agents pacing retries further apart could see LOWER real-world detection rates.',
    'Every simulated failure has a perfectly stable fingerprint (identical error text every time); real ' +
      'failures with more message variance than fingerprint normalization collapses would fragment across ' +
      'multiple fingerprints, LOWERING real-world detection rates.',
    'brokenToolRate and the retry range are assumed configuration, not measured from production telemetry.',
    'Only one tool/failure mode is simulated; results do not directly transfer to a multi-tool deployment.',
    'The "standard OTel would show zero errors" counterfactual is true by construction (every simulated ' +
      'failure returns isError: true, never throws) — it demonstrates the mechanism, not an empirical ' +
      'discovery about real tool-call traffic.',
    'Mean loop length reflects each session\'s last EMITTED event, which can undercount raw attempts when ' +
      'a session gives up between reEmitAfter-aligned re-emission points (see IMPORTANT #8).',
  ];
}

function buildMethodology(config, pricing) {
  return {
    sessionIsolation:
      'Each simulated session was assigned its own distinct, real extra.sessionId by setting the ' +
      "server-side InMemoryTransport's own `sessionId` property before that session's calls, driving a " +
      'real @modelcontextprotocol/sdk Client against a real instrumentMcpServer()-wrapped Server over ' +
      'InMemoryTransport.createLinkedPair(). This mirrors how a real stateful transport (e.g. ' +
      "StreamableHTTPServerTransport) populates extra.sessionId internally (protocol.js's _onrequest() " +
      'reads capturedTransport.sessionId). Verified post-run: the number of distinct session keys the ' +
      'real ThrashDetector instance observed (across both record() and clearOnSuccess()) was asserted ' +
      'equal to the number of sessions simulated; the run aborts with a non-zero exit code otherwise.',
    retriesAreSimulated:
      'Retries are SIMULATED by a scripted policy in this file, not driven by a real LLM agent loop. ' +
      'Each session is independently marked "broken" with probability brokenToolRate (a configured input, ' +
      'not a number measured from production traffic); a broken session then makes a uniform-random ' +
      `integer number of attempts in [minAttempts, maxAttempts] = [${config.minAttempts}, ${config.maxAttempts}], ` +
      'all of which fail with byte-identical error text (see IMPORTANT #4 in this file\'s header), then gives up.',
    tokenGrowthAssumption:
      `Input tokens: ${config.baseTokensIn} on the first attempt, +${config.tokensInGrowthPerRetry} on each ` +
      'subsequent retry (linear growth, modeling context accumulation from including prior failed attempts ' +
      `in the prompt). Output tokens: held constant at ${config.baseTokensOut} tokens on every attempt ` +
      '(see IMPORTANT #7 — not modeled as growing or shrinking).',
    modelAndPrice:
      `model=${config.model}, from DEFAULT_PRICING (src/cost/pricing.js): $${pricing.inputPer1M}/1M input ` +
      `tokens, $${pricing.outputPer1M}/1M output tokens, ${pricing.currency}. That pricing table's own ` +
      'disclaimer applies here too: verify current pricing independently before citing dollar figures.',
    seed: config.seed,
    reproduce: `node bench/thrash-data-benchmark.js ${buildReproduceFlags(config).join(' ')}`,
    knownLimitationsThatCouldInflateResults: buildLimitations(),
  };
}

function formatTextSummary(config, results, methodology) {
  const lines = [];
  lines.push('Agent Thrash Detection — data benchmark');
  lines.push('='.repeat(60));
  lines.push('');
  lines.push('ILLUSTRATIVE, NOT A PRODUCTION CLAIM: brokenToolRate and the retry');
  lines.push('policy below are configured inputs, not measured from real traffic.');
  lines.push('See "Known limitations" at the end before citing any number here.');
  lines.push('');
  lines.push(`Sessions simulated:            ${results.sessionsSimulated}`);
  lines.push(`Broken-tool sessions simulated: ${results.brokenSessionsSimulated} (brokenToolRate=${config.brokenToolRate})`);
  lines.push(`Total tool calls made:          ${results.totalCallsMade}`);
  lines.push('');
  lines.push(
    `Sessions that entered a detected loop: ${results.sessionsInDetectedLoop} / ${results.sessionsSimulated} ` +
      `(${results.sessionsInDetectedLoopPercent.toFixed(2)}%)`,
  );
  lines.push(
    `Loop length — mean: ${results.loopLength.mean.toFixed(2)}  p50: ${results.loopLength.p50}  p95: ${results.loopLength.p95}`,
  );
  lines.push('');
  lines.push(`Total wasted input tokens:  ${results.totalWastedTokensIn.toLocaleString()}`);
  lines.push(`Total wasted output tokens: ${results.totalWastedTokensOut.toLocaleString()}`);
  lines.push(`Total wasted cost:          $${results.totalWastedCostUsd.toFixed(4)}`);
  lines.push(`Mean cost per detected loop: $${results.meanCostPerLoop.toFixed(4)}`);
  lines.push('');
  lines.push(
    `Counterfactual — calls a standard (throw-only) OTel error span would have flagged: ${results.counterfactualStandardOtelErrorCount}`,
  );
  lines.push('(See "Known limitations": this is zero by construction, not an empirical discovery.)');
  lines.push('');
  lines.push(`Session isolation verified: ${results.sessionIsolationVerified} (${results.distinctSessionKeysObserved} distinct keys observed)`);
  lines.push('');
  lines.push('--- Methodology ---');
  lines.push(`Session isolation: ${methodology.sessionIsolation}`);
  lines.push('');
  lines.push(`Retries are simulated: ${methodology.retriesAreSimulated}`);
  lines.push('');
  lines.push(`Token growth assumption: ${methodology.tokenGrowthAssumption}`);
  lines.push('');
  lines.push(`Model and price: ${methodology.modelAndPrice}`);
  lines.push('');
  lines.push(`Reproduce this exact run: ${methodology.reproduce}`);
  lines.push('');
  lines.push('--- Known limitations that could inflate these numbers ---');
  for (const limitation of methodology.knownLimitationsThatCouldInflateResults) {
    lines.push(`  - ${limitation}`);
  }
  lines.push('');
  return lines.join('\n');
}

/**
 * Resolves an --out prefix (or the given default when unset) to absolute
 * `${prefix}.${ext}` paths, relative to CWD (not this script's own
 * directory) — matching normal CLI-tool path conventions, and matching
 * how this file's own header documents invocation (`node
 * bench/thrash-data-benchmark.js ...` from the repo root). Creates the
 * containing directory if needed.
 */
function resolveOutputPaths(outPrefix, defaultPrefix, extensions) {
  const prefix = outPrefix ?? defaultPrefix;
  const absolutePrefix = resolvePath(process.cwd(), prefix);
  mkdirSync(dirname(absolutePrefix), { recursive: true });
  return extensions.map((ext) => `${absolutePrefix}.${ext}`);
}

function writeReports(config, results, methodology) {
  const [jsonPath, textPath] = resolveOutputPaths(config.outPrefix, 'bench/thrash-data-benchmark-results', [
    'json',
    'txt',
  ]);

  const jsonReport = {
    generatedAt: new Date().toISOString(),
    config,
    results,
    methodology,
  };

  writeFileSync(jsonPath, JSON.stringify(jsonReport, null, 2) + '\n');

  const textSummary = formatTextSummary(config, results, methodology);
  writeFileSync(textPath, textSummary);

  console.log(textSummary);
  console.log(`Wrote ${jsonPath}`);
  console.log(`Wrote ${textPath}`);
}

async function runSingle(flags) {
  const config = resolveConfig(flags);
  const pricing = resolvePricingOrAbort(config);
  const { results } = await runOneSimulation(config);
  const methodology = buildMethodology(config, pricing);
  writeReports(config, results, methodology);
}

function parseSweepRates(flags) {
  if (flags.sweepRates === undefined) return DEFAULT_SWEEP_RATES;
  return String(flags.sweepRates)
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n));
}

function formatSweepMarkdown(baseConfig, sweepRates, rows, diagnostics, methodology, threshold) {
  const lines = [];
  lines.push('# Agent Thrash Detection — sweep benchmark');
  lines.push('');
  lines.push(
    '**ILLUSTRATIVE, NOT A PRODUCTION CLAIM.** `brokenToolRate` is an INPUT the reader supplies — every ' +
      'value in the first column below is a configured assumption for that row, not a measured property of ' +
      'any real deployment. This table shows sensitivity to that input, not a prediction of which row ' +
      'describes your deployment. See "Known limitations" below before citing any number here.',
  );
  lines.push('');
  lines.push(
    `Fixed across every row: sessions=${baseConfig.sessionCount}, retries=[${baseConfig.minAttempts}, ` +
      `${baseConfig.maxAttempts}] (uniform random), model=${baseConfig.model}, seed=${baseConfig.seed}, ` +
      `detection threshold=${threshold} (thrashDetection default).`,
  );
  lines.push('');
  lines.push('| brokenToolRate | % sessions in detected loop | mean loop length | wasted cost / 1,000 sessions | mean cost / loop |');
  lines.push('|---:|---:|---:|---:|---:|');
  for (const row of rows) {
    lines.push(
      `| ${row.brokenToolRate} | ${row.sessionsInDetectedLoopPercent.toFixed(2)}% | ` +
        `${row.meanLoopLength.toFixed(2)} | $${row.wastedCostPer1000Sessions.toFixed(2)} | $${row.meanCostPerLoop.toFixed(4)} |`,
    );
  }
  lines.push('');
  lines.push('### Sanity check: empirical vs. closed-form expected detection rate');
  lines.push('');
  lines.push('Expected rate = brokenToolRate x P(attempts >= threshold). Every row below passed within tolerance (4 standard errors of a binomial proportion) — see sanityCheckAgainstClosedForm() in this script; a row outside tolerance aborts the whole run instead of being shown here.');
  lines.push('');
  lines.push('| brokenToolRate | expected % | empirical % | deviation (pp) | tolerance used (pp) |');
  lines.push('|---:|---:|---:|---:|---:|');
  for (let i = 0; i < rows.length; i++) {
    const d = diagnostics[i];
    lines.push(
      `| ${rows[i].brokenToolRate} | ${d.expectedRatePercent.toFixed(3)}% | ${d.empiricalRatePercent.toFixed(3)}% | ` +
        `${d.deviationPercentagePoints.toFixed(3)} | ${d.toleranceUsedPercentagePoints.toFixed(3)} |`,
    );
  }
  lines.push('');
  lines.push('## Methodology');
  lines.push('');
  lines.push(`**Session isolation:** ${methodology.sessionIsolation}`);
  lines.push('');
  lines.push(`**Retries are simulated:** ${methodology.retriesAreSimulated}`);
  lines.push('');
  lines.push(`**Token growth assumption:** ${methodology.tokenGrowthAssumption}`);
  lines.push('');
  lines.push(`**Model and price:** ${methodology.modelAndPrice}`);
  lines.push('');
  lines.push(`**Sweep rates used:** ${sweepRates.join(', ')}`);
  lines.push('');
  lines.push(`**Reproduce this exact sweep:** \`${methodology.reproduce}\``);
  lines.push('');
  lines.push('## Known limitations that could inflate these numbers');
  lines.push('');
  for (const limitation of methodology.knownLimitationsThatCouldInflateResults) {
    lines.push(`- ${limitation}`);
  }
  lines.push('');
  return lines.join('\n');
}

async function runSweepMode(flags) {
  const baseConfig = resolveConfig(flags);
  const pricing = resolvePricingOrAbort(baseConfig);
  const sweepRates = parseSweepRates(flags);
  const threshold = resolveThrashConfig().threshold;

  const rows = [];
  const diagnostics = [];

  for (const brokenToolRate of sweepRates) {
    const rowConfig = { ...baseConfig, brokenToolRate };
    // eslint-disable-next-line no-await-in-loop -- rows must run sequentially: shared monkey-patched ThrashDetector.prototype state
    const { results } = await runOneSimulation(rowConfig);
    const diagnostic = sanityCheckAgainstClosedForm(rowConfig, results, threshold);
    diagnostics.push(diagnostic);
    rows.push({
      brokenToolRate,
      sessionsInDetectedLoopPercent: results.sessionsInDetectedLoopPercent,
      meanLoopLength: results.loopLength.mean,
      wastedCostPer1000Sessions: results.totalWastedCostUsd * (1000 / rowConfig.sessionCount),
      meanCostPerLoop: results.meanCostPerLoop,
    });
    console.log(`  brokenToolRate=${brokenToolRate}: ${results.sessionsInDetectedLoopPercent.toFixed(2)}% detected (sanity check passed)`);
  }

  const methodology = buildMethodology(baseConfig, pricing);
  methodology.reproduce = `node bench/thrash-data-benchmark.js --sweep --sweepRates=${sweepRates.join(',')} ${buildReproduceFlags(
    baseConfig,
  )
    .filter((f) => !f.startsWith('--brokenRate=')) // brokenToolRate is swept, not fixed — see --sweepRates instead
    .join(' ')}`;

  const markdown = formatSweepMarkdown(baseConfig, sweepRates, rows, diagnostics, methodology, threshold);

  const [mdPath, jsonPath] = resolveOutputPaths(baseConfig.outPrefix, 'bench/thrash-data-benchmark-sweep-results', [
    'md',
    'json',
  ]);

  writeFileSync(mdPath, markdown);
  writeFileSync(
    jsonPath,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        baseConfig,
        sweepRates,
        threshold,
        rows,
        sanityCheck: diagnostics,
        methodology,
      },
      null,
      2,
    ) + '\n',
  );

  console.log('');
  console.log(markdown);
  console.log(`Wrote ${mdPath}`);
  console.log(`Wrote ${jsonPath}`);
}

async function main() {
  const flags = parseArgs(process.argv.slice(2));
  if (flags.sweep) {
    await runSweepMode(flags);
  } else {
    await runSingle(flags);
  }
}

main().catch((err) => {
  console.error('ABORT: benchmark run failed with an unexpected error:', err);
  process.exit(1);
});

/**
 * @module observation/integrity
 *
 * `ObservationIntegrity` detection (ADR 008,
 * docs/adr/008-observation-liveness.md — "Update (2026-08-05): The
 * two-axis reframe", Findings 1-2). Phase 2 of the two-axis rollout:
 * detection logic only — no `getObservationState()` accessor, no wiring
 * into `instrumentMcpServer()` (both later phases).
 *
 * Two, and only two, reachable values: `DEGRADED | UNKNOWN`. `HEALTHY` is
 * deliberately absent from the type entirely (Finding 1): no code path in
 * this library, in any `setupNodeSdk` configuration, can positively
 * confirm telemetry is flowing — the one lead (SDK self-observability
 * metrics) is a write-only `Counter` with no synchronous read-back API.
 * Including a `HEALTHY` value that could never be produced would repeat
 * the exact "unreachable enum member" mistake the original four-state
 * contract's `LIVENESS_INDETERMINATE` was introduced to avoid — see the
 * ADR's own "a three-value enum where one value is unreachable should be
 * a two-value enum" standard, now applied to this axis.
 *
 * `DEGRADED` is reachable, but ONLY under `setupNodeSdk: false` (Finding
 * 2): a fragile reference-equality trick against `@opentelemetry/api`'s
 * `ProxyTracerProvider` can confirm "no delegate set" — genuine positive
 * evidence of absence, which is exactly what `DEGRADED` means. Under
 * `setupNodeSdk: true`, `instrument.js`'s `setupTracer()` calls
 * `provider.register()` itself — it knows, with certainty, not by
 * inference, that a delegate is registered, so absence can never be
 * confirmed there. This module returns `UNKNOWN` immediately in that
 * configuration, without even attempting the check — there is nothing
 * left to detect.
 *
 * The check is fragile on two independent axes, both already documented
 * by the ADR's original investigation: it depends on a class
 * (`ProxyTracerProvider`) `@opentelemetry/api`'s own maintainers have
 * announced for removal in a future major version (confirmed still
 * present, with the same `// TODO: Remove ... in the next major version`
 * comment, in the installed `@opentelemetry/api@1.9.1`), and its
 * comparison singleton (`NOOP_TRACER_PROVIDER`) is a plain per-module
 * `const`, not registered via the `globalThis`-keyed mechanism
 * (`Symbol.for('opentelemetry.js.api.<major>')`) this same API otherwise
 * uses specifically to survive multiple installed copies of itself —
 * meaning this check is itself susceptible to the dual-package-hazard
 * class of bug this project already guards against elsewhere (ADR 001's
 * `detectServerKind()`). Both fragilities mean this must degrade to
 * `UNKNOWN` — never throw, and never claim `DEGRADED` on a shaky signal —
 * if the check itself throws or the SDK's shape ever looks different
 * than expected.
 *
 * v0.9.0: the `OBSERVATION_INTEGRITY` frozen enum object moved to the
 * standalone `opentel-mcp-contract` package (re-exported below) so this
 * module's emission and any consumer share the exact same object — only
 * the detection logic below, which needs `@opentelemetry/api`, stays
 * here (contract has zero runtime dependencies).
 */

import { trace, ProxyTracerProvider } from '@opentelemetry/api';
import { OBSERVATION_INTEGRITY } from 'opentel-mcp-contract';

export { OBSERVATION_INTEGRITY };

/**
 * Detects `ObservationIntegrity` for one instrumented server. Never
 * throws.
 *
 * @param {boolean} setupNodeSdk - `resolved.setupNodeSdk` (src/config.js)
 *   — whether opentel-mcp constructed and registered its own
 *   `NodeTracerProvider` for this instrumented server.
 * @returns {ObservationIntegrity}
 */
export function detectObservationIntegrity(setupNodeSdk) {
  if (setupNodeSdk) {
    // opentel-mcp registered a delegate itself — absence can never be
    // confirmed here, and there is no positive-presence signal available
    // either (Finding 1). Nothing to detect; always UNKNOWN. Skipping
    // the check entirely (rather than running it and discarding a
    // DEGRADED result) keeps this branch honest about there being
    // nothing to detect, not just nothing detected.
    return OBSERVATION_INTEGRITY.UNKNOWN;
  }

  try {
    const registered = trace.getTracerProvider();

    if (typeof registered?.getDelegate !== 'function') {
      // The registered provider isn't shaped like a ProxyTracerProvider
      // at all -- a future @opentelemetry/api version could change this
      // shape entirely, or a dual-package-hazard scenario could hand
      // back a provider from a different copy of the API. Never guess;
      // this is exactly the "SDK shape looks unexpected" case that must
      // fall back safely rather than calling a method that might not
      // exist.
      return OBSERVATION_INTEGRITY.UNKNOWN;
    }

    // A throwaway ProxyTracerProvider's own getDelegate() resolves to
    // the same module-scoped, unexported NOOP_TRACER_PROVIDER singleton
    // that `registered.getDelegate()` resolves to when no real delegate
    // has ever been set -- by reference equality, without needing to
    // import that singleton itself (it isn't exported). Cheap: no
    // constructor logic, no side effects.
    const noopDelegate = new ProxyTracerProvider().getDelegate();

    return registered.getDelegate() === noopDelegate ? OBSERVATION_INTEGRITY.DEGRADED : OBSERVATION_INTEGRITY.UNKNOWN;
  } catch {
    // The check itself failed to run confidently -- never a wrong
    // confident answer.
    return OBSERVATION_INTEGRITY.UNKNOWN;
  }
}

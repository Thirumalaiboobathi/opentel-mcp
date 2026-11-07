# Threat model

Scope: `opentel-mcp` (npm, [`packages/core`](../../packages/core)), `opentel-mcp` (PyPI,
[`packages/python`](../../packages/python)) and `opentel-mcp-ui` ([`packages/ui`](../../packages/ui)). This is a
maintainer-written model, not an audit. Each mitigation names the file that implements it and the test that checks it;
"designed to" means the tests cover the cases listed, not that no other case exists. Last reviewed against the code on
2026-11-07 (core 0.17.0, ui 0.3.0, python 0.1.0).

## Components and trust boundaries

```
 MCP client ──(MCP protocol; out of scope)──▶ ┌──────────── MCP server process ─────────────┐
                                              │ tool handlers  ◀─ wrapped by ─ opentel-mcp   │
                                              │ (your code)                    instrumentation│
                                              └──────────────────────────┬───────────────────┘
                                         spans / metrics (OpenTelemetry API)│
                                                                           ▼
                                     OTel SDK + exporters you configure ──▶ your OTLP backend
                                                       │ (dev mode only, optional)
                                                       ▼  HTTP to 127.0.0.1
                                  opentel-mcp-ui: OTLP/HTTP JSON receiver + dashboard  ◀── developer's browser
```

| Component | Trust | Notes |
| --- | --- | --- |
| MCP server process, tool handlers | Trusted (the host application). Handles untrusted client input. | opentel-mcp runs inside this process with its privileges. |
| opentel-mcp instrumentation | Trusted code, runs in-process. Must not become a leak or a crash source. | Reads call metadata, results and errors; emits derived signals only. |
| OTel SDK, exporters, backends | Configured and owned by the user. | opentel-mcp has no exporter of its own that talks to the maintainer. Dev mode can export to the local dashboard. |
| `opentel-mcp-ui` receiver and dashboard | Local developer tool, **no authentication**. Boundary: loopback only. | Listens on `127.0.0.1`. |
| Developer's browser | Untrusted web content can run in it (other tabs/sites). | The dashboard must not be readable or writable by other sites. |
| Maintainer's publish credentials and CI | Trusted, high value. | See supply-chain threats; [`releasing.md`](releasing.md). |

## Assets

1. Tool arguments and results (may hold user data, credentials, business data).
2. Secrets that appear inside error messages and stack traces.
3. Telemetry data (names, ids, timings, counts, hashes) and the backends' capacity.
4. Availability of the host MCP server.
5. The maintainer's npm / PyPI / GitHub publish credentials and the integrity of published artifacts.

## Threats

STRIDE letters: **S**poofing, **T**ampering, **R**epudiation, **I**nformation disclosure, **D**enial of service,
**E**levation of privilege. Core test paths are under `packages/core/test/`, UI under `packages/ui/test/`, Python
under `packages/python/tests/`.

| # | Threat (STRIDE) | Mitigation | Implemented in | Proven by |
| --- | --- | --- | --- | --- |
| 1 | Tool arguments, result content, resource URIs or prompt arguments leak into spans, metrics or logs (**I**) | Only derived signals are read: argument *count*, text *lengths*, booleans, hashes, fixed categories. Content is never attached to a span or label. | [`packages/core/src/instrument.js`](../../packages/core/src/instrument.js), [`unactionable.js`](../../packages/core/src/unactionable.js), [`staleness.js`](../../packages/core/src/staleness.js); Python [`_recorder.py`](../../packages/python/src/opentel_mcp/_recorder.py), [`_adapters.py`](../../packages/python/src/opentel_mcp/_adapters.py) | Canary strings in every input, with all features on: [`security.canary-all-features.test.js`](../../packages/core/test/security.canary-all-features.test.js), [`coverage-resources-prompts.test.js`](../../packages/core/test/coverage-resources-prompts.test.js); Python [`test_privacy_and_safety.py`](../../packages/python/tests/instrumentation/test_privacy_and_safety.py) (argument values never read) |
| 2 | Secrets inside thrown errors reach telemetry (**I**) | Default mode `full` scrubs recognizable credential shapes to `<SECRET>` and caps message (4096), stack (16384) and type (128); `normalized` strips more; `none` records status only; a `redactor` hook runs first in `normalized`. Pattern-based: unusual formats and non-secret personal text are **not** caught (see [`data-handling.md`](data-handling.md)). | [`fingerprint/normalize/secrets.js`](../../packages/core/src/fingerprint/normalize/secrets.js), [`error-recording/`](../../packages/core/src/error-recording), [`instrument.js`](../../packages/core/src/instrument.js) (`recordThrownException`); Python [`_secrets.py`](../../packages/python/src/opentel_mcp/_secrets.py), [`_recording.py`](../../packages/python/src/opentel_mcp/_recording.py) | [`security.secrets.test.js`](../../packages/core/test/security.secrets.test.js), [`instrument.error-recording.test.js`](../../packages/core/test/instrument.error-recording.test.js), [`instrument.error-recording.redactor.test.js`](../../packages/core/test/instrument.error-recording.redactor.test.js); Python [`test_thrown_and_recording.py`](../../packages/python/tests/instrumentation/test_thrown_and_recording.py); regex parity JS↔Python [`test_regex_source_parity.py`](../../packages/python/tests/conformance/test_regex_source_parity.py) |
| 3 | High-cardinality labels overload a metrics backend (**D**) | Metric labels come from allowlists (`METRIC_SAFE_ATTRIBUTES` and per-domain lists); a test fails when a new label is not on the list. **Limit:** the tool name, `error.type` (≤128 chars) and model id are shape/length-bounded, not set-bounded; a server that registers unboundedly many tool names can still produce unbounded series (recorded in [`docs/known-gaps.md`](../known-gaps.md) §11 and [ADR 021](../adr/021-tool-name-cardinality.md)). | [`attributes.js`](../../packages/core/src/attributes.js), [`metrics.js`](../../packages/core/src/metrics.js); Python [`_contract.py`](../../packages/python/src/opentel_mcp/_contract.py) | "metric-label allowlist cross-check (ADR 021)" in [`metrics.test.js`](../../packages/core/test/metrics.test.js); [`test_contract.py`](../../packages/python/tests/test_contract.py) |
| 4 | A web page in the developer's browser reads dashboard data or injects fake spans (cross-site request) (**I**, **T**, **S**) | Requests with a foreign `Origin`, or without `Origin` but `Sec-Fetch-Site: cross-site`, get 403; no CORS headers are sent. Server-to-server OTLP (no browser headers) is accepted. | [`packages/ui/src/request-guard.js`](../../packages/ui/src/request-guard.js), [`server.js`](../../packages/ui/src/server.js) | [`security.test.js`](../../packages/ui/test/security.test.js) "B5: cross-site requests are refused" |
| 5 | DNS rebinding to reach the loopback dashboard (**I**, **T**, **S**) | The server binds `127.0.0.1` only (no option to change it) and answers only `Host` of `localhost`, `127.0.0.1`, `[::1]` on its own port. | [`request-guard.js`](../../packages/ui/src/request-guard.js), [`server.js`](../../packages/ui/src/server.js) | [`security.test.js`](../../packages/ui/test/security.test.js) "B4: binds to loopback only", "B6: DNS rebinding" |
| 6 | Oversized or malformed OTLP payloads exhaust memory or crash the receiver (**D**) | 8 MiB body limit enforced for declared and chunked bodies (413, with bounded draining of the rest); JSON only (415); malformed/empty bodies yield an empty result; the in-memory span buffer is a fixed-capacity ring (default 1000 spans); aborted requests don't crash the server. | [`request-guard.js`](../../packages/ui/src/request-guard.js), [`otlp-json-receiver.js`](../../packages/ui/src/otlp-json-receiver.js), [`span-buffer.js`](../../packages/ui/src/span-buffer.js) | [`security.test.js`](../../packages/ui/test/security.test.js) "B7: OTLP receiver limits"; [`otlp-json-receiver.test.js`](../../packages/ui/test/otlp-json-receiver.test.js); [`span-buffer.test.js`](../../packages/ui/test/span-buffer.test.js) |
| 7 | Script injection through span data shown in the dashboard (**T**, **E**) | Strict hash-based CSP (no `unsafe-inline`, `frame-ancestors 'none'`), `X-Frame-Options: DENY`, `nosniff`, `Cross-Origin-Resource-Policy: same-origin`, `Referrer-Policy: no-referrer`, `Cache-Control: no-store`; span data is rendered as text. | [`csp.js`](../../packages/ui/src/csp.js), [`server.js`](../../packages/ui/src/server.js) | [`security.test.js`](../../packages/ui/test/security.test.js) "B9: Content-Security-Policy" (CSP and headers). "Rendered as text" is by design of the web app; no dedicated test is cited here (not yet verified). |
| 8 | A malicious MCP tool or client sends hostile `_meta` (huge, cyclic, throwing getters, wrong types) to break or poison telemetry (**D**, **T**) | Staleness reads exactly one namespaced `_meta` key and only its three freshness fields, never enumerates `_meta`; malformed values yield an `unknown` verdict and one content-free warning; reads are wrapped so they never throw. Trace-context propagation reads `params._meta` for W3C headers only. | [`staleness.js`](../../packages/core/src/staleness.js), [`tracecontext/`](../../packages/core/src/tracecontext) | [`staleness.test.js`](../../packages/core/test/staleness.test.js) ("never throws", "warning never contains the malformed value"); [`tracecontext/extract.test.js`](../../packages/core/test/tracecontext/extract.test.js) |
| 9 | Instrumentation crashes or alters the host server (**D**) | Never-throw invariant: instrumentation code paths are wrapped, errors degrade to one diagnostic, and the original handler result / exception is returned untouched. | [`instrument.js`](../../packages/core/src/instrument.js); Python [`_recorder.py`](../../packages/python/src/opentel_mcp/_recorder.py) | [`instrument.test.js`](../../packages/core/test/instrument.test.js) (original error rethrown, result returned unchanged), [`staleness.test.js`](../../packages/core/test/staleness.test.js) ("never throws"), [`tracecontext/extract.test.js`](../../packages/core/test/tracecontext/extract.test.js); Python `test_broken_inputs_never_change_the_result_or_raise`, `test_hostile_exception_is_reraised_untouched` in [`test_privacy_and_safety.py`](../../packages/python/tests/instrumentation/test_privacy_and_safety.py) |
| 10 | Data sent to the maintainer or a third party without consent (**I**) | The packages contain no telemetry/phone-home code; spans and metrics go only to OpenTelemetry exporters the user configures. The Python dev mode makes an HTTP request only to the dashboard URL the user gives it. A repo-wide check of `packages/core/src` for `fetch`, `http(s).request`, `net.connect` finds none. | [`packages/core/src`](../../packages/core/src), [`_dev/otlp_json.py`](../../packages/python/src/opentel_mcp/_dev/otlp_json.py) | Static search (re-run before each release); no dedicated automated test (not yet verified by a test) |
| 11 | Compromised maintainer account or stolen publish token (**S**, **T**) | Releases use npm / PyPI trusted publishing (OIDC, no stored publish token), run in a GitHub Environment `release` with required reviewers, from protected tags; provenance and attestations are generated. 2FA on the three accounts is the maintainer's responsibility (to be confirmed, see [`security-faq.md`](security-faq.md)). | [`.github/workflows/release.yml`](../../.github/workflows/release.yml), [`releasing.md`](releasing.md) | Workflow linted with actionlint and zizmor (see [run report](../run-reports/security-posture.md)). Effective only once the one-time setup in `releasing.md` is done. |
| 12 | Compromised dependency (**T**, **E**) | Runtime dependency surface is small (core: four `@opentelemetry/*` packages; ui: none; Python: `opentelemetry-api`). Lockfiles are committed, CI audits the *packed* production dependency trees (`npm audit --omit=dev --audit-level=high`), Dependabot proposes weekly grouped updates, CodeQL and Scorecard run on the repo, actions are pinned to commit SHAs. `pip-audit` is run on the Python lock in the run report. | [`ci.yml`](../../.github/workflows/ci.yml) `dependency-audit`, [`dependabot.yml`](../../.github/dependabot.yml), [`codeql.yml`](../../.github/workflows/codeql.yml), [`scorecard.yml`](../../.github/workflows/scorecard.yml) | CI jobs themselves; no unit test. Consumers can additionally use the SBOM and `npm audit signatures`. |
| 13 | Tampered release artifact (**T**) | The published tarball/wheel is the exact artifact built and tested in an earlier job (uploaded and downloaded as a workflow artifact); published with provenance / PEP 740 attestations and a GitHub attestation; consumers verify with `npm audit signatures`, `pypi-attestations`, `gh attestation verify`. | [`release.yml`](../../.github/workflows/release.yml), [`releasing.md`](releasing.md) | `verify:tarball` ([core](../../packages/core/scripts/verify-tarball.js), [ui](../../packages/ui/scripts/verify-tarball.js)) in the build job. Versions released before this workflow have no provenance. |

## Out of scope

- Securing the MCP server itself: authentication/authorization of MCP clients, validation of tool arguments, what
  your tool handlers do with them.
- Network egress control and the security of the transport between the process and your OTLP backend (TLS is whatever
  your exporter configuration uses).
- The security, retention and access control of your telemetry backends.
- Protection against a malicious host application or other code in the same process (opentel-mcp runs with the
  host's privileges).
- Authentication on the local dashboard: it is a loopback-only developer tool. Anyone who can already reach
  `127.0.0.1:<port>` on your machine (another local user or process) can read it. Don't expose it with a tunnel or
  proxy.
- Content in error messages that is not a recognizable credential (for example a customer name in an exception
  message) unless you choose mode `normalized`, `none` or a redactor.
- Vulnerabilities in the MCP SDKs or OpenTelemetry packages themselves.

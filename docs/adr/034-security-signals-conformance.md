# ADR 034: Conformance status of the v0.18 security signals

**Status:** Accepted (core 0.18.0, Python unchanged at 0.1.0).

## Context

ADR 028 defines `conformance/contract.json` as the language-neutral contract
generated from core by `packages/core/scripts/gen-conformance.mjs` and checked
by both test suites. Its metrics list is a curated four
(`CORE_METRIC_NAMES`, `gen-conformance.mjs:114`) and its deferred-in-Python
mechanism today covers one span attribute (`span.deferredInPython`,
`gen-conformance.mjs:186-187`, asserted at `packages/python/tests/test_contract.py:36`).
ADR 028's deferral table lists staleness, thrash and schema drift by omission,
not by name in the contract. The Python port stays at 0.1.0 in this release and
implements none of ADRs 027's amendment or 029 to 032.

## Decision

Core's new span attributes, span events and metrics are recorded explicitly in
a new `jsOnly` section of `contract.json`, generated from exported constants
in core (not hand-written), so a name cannot silently change:

```json
"jsOnly": {
  "since": "core 0.18.0",
  "spanAttributes": [...],
  "spanEvents": [...],
  "metrics": [...]
}
```

- It lists every attribute, event and metric introduced by ADRs 029 to 032 and
  the 027 amendment (`mcp.tool.integrity.*`, `mcp.tool.secret_leak.*`,
  `mcp.tool.sensitive`, `mcp.audit.sensitive_call`,
  `mcp.tool.freshness.clock_skew_ms`, `mcp.tool.integrity_violations`,
  `mcp.tool.secret_leaks`, `mcp.tool.auth_failures`).
- Existing conformance data does not change: `metrics` stays the curated four,
  `allowlists.metricSafeAttributes` is unchanged (this release adds no label
  key), `patterns.json` is unchanged (secret `type` is not exported).
- JS test (`test/conformance.contract.test.js`) asserts the section equals
  what core exports. A Python test asserts the section exists and that none of
  its names appears in the Python package, so a future partial port cannot
  claim conformance by accident. Python code is not modified.
- `conformance/README.md` and ADR 028's deferral table get a pointer.

## Alternatives considered

- **Add the metrics to the contract's `metrics` list.** Rejected: the Python
  suite asserts equality with that list (`test_contract.py:54`, `:120`), so it
  would force false conformance work.
- **Document only in prose.** Rejected: unenforced.
- **Port the signals to Python now.** Out of scope for this release.

## Consequences

Anyone porting a signal later moves its names from `jsOnly` into the contract
proper in the same change.

## Amendment (contract version, Python 0.2.0 work)

`contract.json` used to embed `"contract": "core <version>"` and the Python suite asserted equality, so every core
patch release forced an edit in `packages/python`. The contract now has its own version:

- `contractVersion`: an integer constant (`CONTRACT_VERSION` in `gen-conformance.mjs`), bumped by hand only when the
  contract itself changes. Both suites assert it equals their own constant (`opentel_mcp._contract.CONTRACT_VERSION`).
- `coreVersion`: the core package version, informational only; nothing asserts it.
- The `contract` key is removed.

Version 1 is the contract as of core 0.18.1 (jsOnly section present). Version 2 moves the four security features to
the shared contract (see the amendment below).

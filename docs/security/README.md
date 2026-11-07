# Security documentation

**Summary for reviewers.** `opentel-mcp` instruments MCP servers with OpenTelemetry. It is designed to record only
derived signals (counts, lengths, hashes, fixed categories) and never tool arguments, tool results, resource URIs or
prompt arguments; the one free-text exception is thrown-error messages, which are credential-scrubbed by default and
can be reduced to nothing. It has no telemetry to the maintainer, a small runtime dependency set, and instrumentation
code that is designed never to throw into the host. The optional local dashboard (`opentel-mcp-ui`) binds to loopback
only and is hardened against cross-site and DNS-rebinding access, oversized payloads and script injection. Releases made
by the repository's workflow carry npm provenance / PyPI attestations and a CycloneDX SBOM. This is a single-maintainer
project: nothing here is a warranty, a certification, or a promise of response times, and every claim cites the code or
test that supports it.

| Document | Read it for |
| --- | --- |
| [threat-model.md](threat-model.md) | Components, trust boundaries, assets, 13 threats with mitigation, code location and proving test; out-of-scope list |
| [data-handling.md](data-handling.md) | Exactly what each package records, where it goes, retention, error-recording modes, scrubbing limits, how to record less |
| [security-faq.md](security-faq.md) | Answers to common vendor-questionnaire questions with evidence links |
| [releasing.md](releasing.md) | How releases are built, signed and attested; maintainer setup; how to verify; SBOMs; emergency fallback |
| [../../SECURITY.md](../../SECURITY.md) | Supported versions and how to report a vulnerability |
| [../run-reports/security-posture.md](../run-reports/security-posture.md) | What was changed in the security-posture change set and what remains for the maintainer |

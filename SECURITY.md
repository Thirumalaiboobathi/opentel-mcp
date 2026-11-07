# Security policy

Reviewing `opentel-mcp` for use in your organisation? Start at [`docs/security/`](docs/security/README.md): threat
model, data handling, a vendor-questionnaire FAQ and the release process.

## Reporting a vulnerability

Please report security issues privately, not in a public issue or pull request.

Use GitHub's private vulnerability reporting: open the repository's **Security** tab and choose **Report a
vulnerability** (<https://github.com/Thirumalaiboobathi/opentel-mcp/security/advisories/new>). Only the maintainer can
see the report.

Include what you can of:

- the package and version (`opentel-mcp` on npm or PyPI, or `opentel-mcp-ui`),
- what an attacker can do, and what they need to already have,
- steps or a small script to reproduce it.

### What to expect

This is a single-maintainer project. These are **goals, not guarantees or service-level commitments**:

- acknowledge a report within **5 business days**,
- give an initial assessment (accepted, needs more information, or declined, with reasons) within **14 days**,
- aim to ship a fix for a confirmed high-severity issue within **30 days**, and to coordinate disclosure timing with
  you; lower-severity issues are fixed on a best-effort basis.

If a goal is missed, a polite follow-up on the advisory is welcome.

### How fixes are released

A confirmed issue is fixed in a patch release of the affected package(s) and announced with a published GitHub Security
Advisory (with a CVE where applicable), crediting you unless you'd rather not be named. Release notes and the package
`CHANGELOG.md` link to the advisory. Releases follow [`docs/security/releasing.md`](docs/security/releasing.md). Provenance and SBOMs apply only to releases published through the release workflow, starting with `opentel-mcp` 0.18.1 and `opentel-mcp-ui` 0.4.1; earlier versions (including 0.18.0 and 0.4.0) were published manually and are not signed or attested.

## Supported versions

Both npm packages and the Python package are pre-1.0. **Policy: the latest minor release of each package receives
security fixes; older minors do not.** Upgrade to the latest minor to receive a fix.

| Package | Supported |
| --- | --- |
| `opentel-mcp` (npm) | 0.18.x |
| `opentel-mcp-ui` (npm) | 0.4.x |
| `opentel-mcp` (PyPI) | 0.1.x |

## Scope

In scope: the code in this repository and the packages published from it. Out of scope: vulnerabilities in the MCP SDKs
or OpenTelemetry packages (report those upstream), the security of your MCP server or telemetry backend, and the items
listed under "Out of scope" in the [threat model](docs/security/threat-model.md#out-of-scope).

## What the library captures, and what it doesn't

`opentel-mcp` instruments an MCP server and emits OpenTelemetry spans and
metrics. Where that telemetry goes is up to your OpenTelemetry setup.

**Recorded:**

- Tool, prompt and method names, request ids, durations, argument *counts*,
  outcomes, and failure fingerprints (hashes and fixed categories).
- For a thrown error, by default (`errorRecording.mode: 'full'`): the
  error's type, message and stack. Recognizable credentials (Bearer and
  Basic tokens, AWS key ids, `sk-`/`ghp_`/`xox…` API keys, JWTs, passwords
  in URLs, `token=`/`api_key=`/`password=` values) are replaced with
  `<SECRET>`, and the message and stack are length-capped. Any other text
  an error contains, such as a customer's name, is still recorded. Use
  `errorRecording.mode: 'normalized'` (ids, paths, URLs and numbers
  stripped too), `'none'`, or a `redactor` to record less.
- A model name and token counts that a tool result declares, for cost
  attribution. The cost extractor looks for them in `usage`/`model`, in
  `_meta.usage`/`_meta.model`, or in a first text block that parses as
  JSON. Only the counts and a shape-checked model name are recorded.

**Never recorded:**

- Tool arguments (only how many there are).
- Tool result text, `structuredContent`, or any other `_meta` field.
  Unactionable-error detection reads only text *lengths*, and staleness
  detection reads only the three freshness fields under its own `_meta`
  key and records derived numbers, not the values.
- Resource URIs, prompt arguments, or the message of a failed resource or
  prompt request.

Tests with canary strings in every input check that none of the
"never recorded" content reaches spans, metrics or diagnostic logs.
Details: [`docs/security/data-handling.md`](docs/security/data-handling.md) and
[`packages/core/README.md`](packages/core/README.md).

## The local dashboard (`opentel-mcp-ui`)

The dashboard has no authentication, so it's built to be reachable only
from your own machine:

- It listens on `127.0.0.1` only, with no option to listen elsewhere.
- It answers only requests addressed to `localhost`, `127.0.0.1` or
  `[::1]` on its own port, which blocks DNS-rebinding attacks.
- Browser requests to its API and its OTLP endpoint must come from the
  dashboard itself, so other websites can't read your spans or send fake
  ones.
- The OTLP endpoint accepts JSON only, up to 8 MiB per request.
- The page is served with a strict Content-Security-Policy, and span data
  is always rendered as text.

See the [threat model](docs/security/threat-model.md) for the test that covers each of these.

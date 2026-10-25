# Run report: Python port v0.1.0 (ADR 028)

Branch `feat/python-port`. Nothing was committed, pushed or published (not to TestPyPI either).
Source of truth: `docs/adr/028-python-port.md` (Accepted). No ADR conflicts blocked work; deviations and
interpretations are listed under "Decisions I made".

## 1. Per task

### Task 1: package skeleton, done
`packages/python/`: `pyproject.toml` (hatchling, `src/` layout, version 0.1.0, `requires-python >=3.10`,
`opentelemetry-api>=1.28`, extra `dev` = `opentelemetry-sdk>=1.28`), `src/opentel_mcp/`, `tests/`, `README.md`,
`CHANGELOG.md`, `LICENSE` (copy of the repo's MIT), `py.typed`, `uv.lock`. pytest + anyio plugin, `mypy --strict`,
ruff (lint + format). `.gitignore` gained Python entries.

### Task 2: shared conformance suite, done
`conformance/` at the repo root: `contract.json`, `patterns.json`, `cases/{normalize,tool-error,channel,classify,error-recording}.json`
(generated from the **unmodified** core by `packages/core/scripts/gen-conformance.mjs`, `--check` mode for CI),
`cases/thrown.py.json` (Python-only, hand-written by `conformance/gen_thrown_py.py`), `README.md`.
JS: `test/conformance.test.js` and `test/conformance.contract.test.js` load the fixtures and assert core matches;
a regex edit or contract change in core fails them until regenerated. No file under `packages/core/src` changed.
Tests: 10 new JS tests, all pass.

### Task 3: normalization, fingerprinting, classification, scrubbing, done
Private modules `_jsre`, `_secrets`, `_normalize`, `_coerce`, `_classify`, `_stack`, `_compose`. Regexes are kept as the
**JS source text** and translated by one function (ASCII classes, explicit JS `\s`, `.`/`$` rules, ASCII case folding,
`$1` -> `\g<1>`), so a regex-source parity test can compare them to `patterns.json`. Strings are processed in a UTF-16
representation (astral characters as surrogate pairs), which also reproduces `{4,}`-style counting in negated classes
and lone surrogates; hashing replaces lone surrogates with U+FFFD. Python stack signatures follow the ADR
(frames innermost-first, `co_name`, `site-packages/<pkg>/...`, stdlib / frozen / `<string>` / own frames skipped,
5 user frames, site-packages fallback and the internal -> dependency rule). Tests: all 430 shared `js` cases are
mirrored by 443 `py` cases, all pass, plus regex-source and classifier-table parity and translation-rule unit tests.

### Task 4: instrumentation, done
`instrument_mcp_server()` for low-level `Server`, `FastMCP` (1.x) and `MCPServer` (2.x): `ToolCallRecorder` owns span,
attributes, fingerprint and metrics; mcp 1.x wraps `request_handlers[CallToolRequest]` through a `dict` subclass
(registration order irrelevant); mcp 2.x re-registers the `tools/call` entry with a wrapper (bad params and
pre-initialize requests never reach it), `sdk_tracing="replace"` (default) swaps the SDK middleware for a delegating
one that skips only `tools/call` (with fallback to enrich + one warning, never throws), `"enrich"`, runtime
one-span guard, and cause capture for `UnexpectedToolError`. Error recording modes `full`/`normalized`/`none`,
redactor, scrubbing, caps, env var; four metrics with the allowlist; `mcp.tool.argument_count`; W3C `_meta` parenting.
Tests per SDK build (below): silent failure -> ERROR + `error.type=tool_error`; exceptions (class name, not qualname);
bad params and pre-initialize produce no span (replace) and the documented SDK span (enrich); exactly one
`tools/call` span in every mode and flavour; canary test (arguments and result content never reach spans, metrics,
logs or stdout); never-throw tests (hostile inputs/results/exceptions, broken tracer/span/metrics, unsupported
servers); sync tools see the current span; contract pins for the SDK's private surface. 1.25, latest 1.x and
latest 2.x all pass.

### Task 5: dev mode and JSON exporter, done
`setup_sdk=True`: TracerProvider + MeterProvider (registered unless already set, then warn and reuse), stderr span
exporter (hex ids), stderr metrics every 5 s, private OTLP/HTTP JSON exporter (`opentel_mcp._dev.otlp_json`:
hex ids, decimal-string integers/timestamps, `Content-Type: application/json`, stdlib only), flush on exit via
`atexit` + SIGTERM/SIGINT handlers that flush and chain (2 s default). Unit test for id encoding (exact hex strings,
not base64), exporter POST test against a local HTTP server, real-process tests for stderr-only output, flush on
normal exit, SIGTERM and `force_flush()`.

### Task 6: end-to-end with the real UI, done
`tests/e2e/test_ui_roundtrip.py` starts the real `packages/ui/bin/opentel-mcp-ui.js` on a free port per test, runs an
instrumented server in a child process (`setup_sdk=True`, `exporter_url` at the UI), and asserts via
`/api/spans/history` and `/api/summary`: exactly one `tools/call` span, `ERROR`, `silentFailure == 1`, tool name,
`tool_error`, category/channel, the `mcp.failure.fingerprint` equal to the conformance-suite value, and the span/trace
ids equal to the hex ids the child's exporter printed. Variants: mcp 1.x FastMCP, 1.x low-level, 2.x replace
(plus: SDK `tools/list` span still produced), 2.x enrich, 2.x SDK middleware removed, 2.x crashing tool
(`error_class == RuntimeError`, replace and enrich), 2.x success. Waits are on conditions (poll until true), all
processes are terminated in fixtures; no leftover `node` or child processes were found afterwards. They skip when
node or the monorepo's `node_modules` is missing.

### Task 7: CI, docs, release prep, done (CI not executed)
- `.github/workflows/ci.yml`: job `python` (13 explicit `include:` legs, as in the ADR) and job `conformance`.
  I could not run GitHub Actions; the commands were run locally (see section 4).
- `packages/python/README.md`: what/why, install, FastMCP and low-level quickstarts, production providers,
  dev mode + `npx opentel-mcp-ui`, `sdk_tracing` replace vs enrich with the raw-exception warning, what is recorded,
  `error_recording`, privacy, differences from JS, v0.1 scope and deferred features.
- `CONTRIBUTING.md`: "Releasing the Python package" (build, `twine check`, TestPyPI, clean-venv smoke test, PyPI,
  project-scoped token, first-upload caveat) and two PR checklist lines.
- Root `README.md`: Python package row, conformance suite mention, Python dev snippet.
- **Stranger test, passed.** Fresh venv outside the repo (`/tmp/.../stranger`), built wheel installed with
  `pip install "<wheel>[dev]" mcp` (mcp 2.3.0), `server.py` written from the README quickstart + dev-mode snippet,
  the **published** dashboard started with `npx opentel-mcp-ui`, a stdio MCP client called the tool: the span
  `tools/call lookup` reached the dashboard as a silent failure (`/api/summary`: `silentFailure: 1`;
  category `internal`, `error_class RuntimeError`, hex ids), and spans and metrics (`mcp.tool.calls`, `.duration`,
  `.silent_failures`) were printed on stderr. The README's production-provider snippet and the 1.x/low-level
  snippets were also executed. README fixes found: absolute GitHub URL for the conformance link (a relative link
  breaks on PyPI); dropped the redundant `License ::` classifier (PEP 639 with `license = "MIT"`).

## 2. Decisions I made

Conservative choices when the ADR was silent or something was ambiguous:

1. **Extra conformance files.** Besides the five in the ADR, added `cases/classify.json` (stack-less thrown records,
   to pin the classifier name/code/status tables) and `conformance/gen_thrown_py.py`; `patterns.json` also carries the
   module-private classifier regexes and tables (read from core's source text) so they are drift-checked too.
2. **Fallback-enrich starts a span if none is current.** ADR: enrich "never starts a span". For the `replace` ->
   `enrich` *fallback* only, if no recording SDK `tools/call` span is current I start our own for that call, so spans
   cannot silently vanish (the one-span guard still prevents duplicates). Explicit `sdk_tracing="enrich"` never starts one.
3. **Cause capture in enrich mode records the original through `error_recording`** on the SDK span. The ADR says cause
   capture applies to both modes and that the span records the original, but also that enrich adds no exception
   event of its own on the *thrown* path; here the SDK never sees the crash (MCPServer turned it into an isError
   result), so there is no duplicate and the event is scrubbed.
4. **No per-job coverage gate.** ADR: "90% (to confirm)". Per job, coverage is 80% (mcp 1.25) to 87% (mcp 2.3) because
   half the adapter code is SDK-line specific and child-process tests are not measured; across the three SDK builds
   it is 92%. `fail_under` is not set; CI prints coverage only. Decide whether to add a combining job.
5. **e2e runs the server in a child process** (ADR: in-process with `force_flush()`), because OpenTelemetry's global
   providers can be set once per process and the variants need fresh ones. The child exits normally, which exercises
   flush-on-exit; `force_flush()` has its own real-process test.
6. **Public additions** beyond the ADR's signature: `opentel_mcp.force_flush()`, `opentel_mcp.shutdown()` and a
   `server.shutdown` attribute (JS parity), needed by the e2e description.
7. **Dev-mode metrics** go to stderr every 5 s via the SDK's `ConsoleMetricExporter` (mirrors JS ADR 023); the ADR only
   listed the span exporters.
8. **Flush timeout default 2000 ms** (ADR) vs JS's 1000 ms cap; `timeout_ms` is not capped.
9. **Startup warnings are once per instrumented server** (not per process), except the redactor-ignored warning,
   which is once per process as in JS.
10. **`error.type` for a thrown exception without a name** cannot happen in Python, so the one JS case with an
    `undefined` error name is `js`-only in `error-recording.json`.
11. **Unsupported / unknown inputs never raise**: unsupported server objects, a missing `tools/call` handler on
    mcp 2.x, unknown option names and invalid option values all warn once and carry on. `sdk_tracing` is silently
    ignored on mcp 1.x.
12. **MCP errors** are coerced with the JSON-RPC code as `code` and the raw message (no JS-style "MCP error N:" prefix),
    so `classify_failure_channel` works on them; the channel recovery regex for the prefix is still ported.
13. **Environment:** the machine had no `pip`/`uv`; I installed `uv` into a scratch venv and used it to fetch Pythons
    3.10-3.14. `uv.lock` was generated with that uv. Everything outside the repo lives under the session scratchpad.
14. **`gen-conformance.mjs` exports `recordedException`/`buildAll`** for the JS tests; it is a script, not shipped
    (core's `files` allowlist excludes `scripts/`).

## 3. Conformance results

| File | Cases | asserted in JS | asserted in Python |
|---|---:|---:|---:|
| `normalize.json` | 122 | 122 | 122 |
| `tool-error.json` | 161 | 161 | 161 |
| `channel.json` | 42 | 42 | 42 |
| `classify.json` | 51 | 51 | 51 |
| `error-recording.json` | 54 | 54 | 51 |
| `thrown.py.json` (Python only) | 16 | 0 | 16 |
| **Total** | **446** | **430** | **443** |

All pass in both (JS: `conformance.test.js` 7 tests + `conformance.contract.test.js` 3 tests; Python: on mcp 1.25 / 1.30 / 2.3).
Also: `patterns.json` regex sources/flags/replacements (8 secret steps, 13 normalize steps, 9 private regexes, 9 tables)
equal the Python tables exactly; `contract.json` equals both core's live exports (JS test) and the Python
`_contract` module (Python mirror test), including the four metrics' names/kind/unit/description/label keys and both
allowlists, plus the ADR 021 style cross-check on the Python recorder.

Documented differences: (a) `mcp.failure.validation_paths` is deferred (`contract.json` -> `span.deferredInPython`);
(b) 3 `error-recording` cases for a JS error with no `name` are `js`-only; (c) thrown fingerprints/stack signatures
differ by design and live in `thrown.py.json`.

Extra evidence (not committed): a one-off differential fuzz of **16,000** random adversarial strings (Unicode digits and
letters, exotic whitespace, line separators, lone and astral surrogates, secrets, ids, addresses, cap-boundary
lengths) through core's `computeFingerprint`/`classifyFailureChannel`/`scrubSecrets` and the Python port:
**0 mismatches** on fingerprint, category, normalized message, channel and scrubbed text.

## 4. Final results

| Check | Result |
|---|---|
| pytest, Python 3.10.22 + **mcp 1.25.0** | 630 passed, 61 skipped (2.x-only tests) |
| pytest, Python 3.12.3 + **mcp 1.30.0** (latest 1.x) | 630 passed, 61 skipped |
| pytest, Python 3.12.3 + **mcp 2.3.0** (latest 2.x) | 705 passed, 13 skipped (1.x-only tests, and 3 where a 2.x low-level handler's exception propagates) |
| Also run locally with the CI recipe (`uv sync --locked --group test` + `uv pip install mcp...`) | 3.14 + mcp 2.3: 705 passed; 3.14 + mcp 1.30: 630; 3.11 + mcp 2.3: 705; 3.13 + mcp 1.30: 630 (each with ruff and mypy clean) |
| `mypy --strict` (21 source files) | clean on 3.10 and 3.12 |
| `ruff check` / `ruff format --check` (46 files) | clean |
| Coverage (line+branch) | 80% (1.25 alone), 87% (2.3 alone), **92% across the three SDK builds** |
| JS suite, once at the end (`npm test`, core + ui) | core 68 files / 1311 passed, 4 skipped; ui 23 files / 230 passed; `npm run typecheck` clean |
| Build | `uv build` -> `opentel_mcp-0.1.0-py3-none-any.whl` (44,505 B) and `opentel_mcp-0.1.0.tar.gz` (63,534 B) |
| `twine check dist/*` | PASSED (wheel and sdist) |

Note on the JS suite: a first full run, executed while my Python runs were loading the machine, failed one
timing-sensitive real-process test (`flush-on-exit.test.js` "control: SIGTERM with flushOnExit: false", 15 s fixture
timeout). It is unrelated to my changes (no runtime JS file was touched) and the whole suite passed on the re-run on
an idle machine; the numbers above are from that run.

Not verified: the GitHub Actions workflow itself (never executed), the macOS and Windows legs (signal handling,
Windows path handling are covered only by synthetic stack cases).

## 5. git status --short

```
 M .github/workflows/ci.yml
 M .gitignore
 M CONTRIBUTING.md
 M README.md
?? conformance/
?? docs/adr/028-python-port.md
?? docs/run-reports/python-v0.1.0.md
?? packages/core/scripts/gen-conformance.mjs
?? packages/core/test/conformance.contract.test.js
?? packages/core/test/conformance.test.js
?? packages/python/
```

## 6. Follow-ups

- Decide on the coverage gate (see decision 4): add a combining job, or keep reporting only.
- Commit the differential fuzz (JS vs Python, seeded) as an optional script next to the conformance suite.
- Open the upstream python-sdk issue (ADR follow-up): an option to turn off `OpenTelemetryMiddleware`'s exception
  recording; revisit the `sdk_tracing` default if it lands.
- Reserve the `opentel-mcp` name on PyPI promptly (first upload needs an account-wide token, then replace it with a
  project-scoped one and revoke the account-wide one).
- First CI run: watch the 13 legs (especially macOS/Windows signal and path behaviour, and `astral-sh/setup-uv@v5`
  with `python-version`), and the e2e leg's `npm ci` + UI build.
- Dependabot: add the `pip`/`uv` ecosystem for `packages/python` and the new action pins.
- Roadmap items per ADR 028 (0.2 validation paths ... 0.8 cost), protobuf ingestion in the UI, standalone `fastmcp`,
  proposed shared classifier additions (`JSONDecodeError`, httpx timeouts, `CancelledError`, pydantic `ValidationError`).
- Pre-existing and unrelated: `flush-on-exit.test.js` can time out under heavy machine load.

## 7. Commands for you

Commit and push (from the repo root, on `feat/python-port`):

```bash
cd /home/thiru/projects/opentel-mcp
git add .gitignore .github/workflows/ci.yml CONTRIBUTING.md README.md conformance docs/adr/028-python-port.md docs/run-reports/python-v0.1.0.md \
  packages/core/scripts/gen-conformance.mjs packages/core/test/conformance.test.js packages/core/test/conformance.contract.test.js packages/python
git status --short   # nothing outside this list should remain; dist/, caches and .coverage are git-ignored
git commit -m "feat(python): opentel-mcp for Python v0.1.0 and shared conformance suite (ADR 028)" \
  -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
git push -u origin feat/python-port
```

Open the PR: https://github.com/Thirumalaiboobathi/opentel-mcp/compare/main...feat/python-port?expand=1

After the merge, publish by hand (from `packages/python`, tokens in `~/.pypirc` or `TWINE_USERNAME=__token__` +
`TWINE_PASSWORD`; the first PyPI upload needs an account-wide token, then create a project-scoped one and revoke it):

```bash
cd /home/thiru/projects/opentel-mcp && git switch main && git pull
cd packages/python
rm -rf dist && uv build                         # or: python -m build
twine check dist/*

# TestPyPI
twine upload -r testpypi dist/*

# test-install from TestPyPI into a clean venv outside the repo, then run the README dev-mode quickstart
python3 -m venv /tmp/otm-testpypi && source /tmp/otm-testpypi/bin/activate
pip install --index-url https://test.pypi.org/simple/ --extra-index-url https://pypi.org/simple/ "opentel-mcp[dev]==0.1.0" "mcp>=2,<3"
python -c "import opentel_mcp; print(opentel_mcp.__version__)"      # 0.1.0
pip install --index-url https://test.pypi.org/simple/ --extra-index-url https://pypi.org/simple/ --force-reinstall "opentel-mcp[dev]==0.1.0" "mcp<2"   # and the 1.x line
deactivate

# PyPI
twine upload dist/*
git tag python-v0.1.0 && git push --tags
```

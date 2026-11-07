# Run report: Python 0.2.0, security observability (ports ADRs 029 to 032)

Branch `release/python-0.2.0-security` (from `main` at `b30512f`). Nothing was pushed, tagged or published (no
`twine upload`, not to TestPyPI either). Local commits only, one per task, plus two small follow-ups (Decisions 14 and 15).

## 1. Commits, in order

| # | Commit | Task |
|---|---|---|
| 1 | `81c7f54` chore(conformance): version the contract independently of core | 1 |
| 2 | `c718eda` chore(conformance): shared fixtures for v0.18 security signals | 2 |
| 3 | `6f5d896` feat(python): auth failure counter | 3 |
| 4 | `c8f4765` feat(python): sensitive tool audit events | 4 |
| 5 | `34618ec` feat(python): opt-in secret leak detection in tool outputs | 5 |
| 6 | `3426177` feat(python): tool definition integrity and hash pinning | 6 |
| 7 | `b0a15b7` test(python): security signals end to end with the dashboard | 7 |
| 8 | `fdc1972` docs(python): security observability | 8 |
| 9 | `96544cd` chore(release): python 0.2.0 | 9 |
| 10 | `c6d3e71` test(python): build the 50 MB scan input outside the timer | follow-up to 5 (a timing test failed once, see 6) |
| 11 | `35671e3` fix(release): install the mcp SDK in the python build job | **release.yml fix, please review** (section 5) |
| 12 | (this report) docs(run-reports): python 0.2.0 security | report |

## 2. Cross-language parity

Contract version is now **2** (`contractVersion` in `conformance/contract.json`; Python `_contract.CONTRACT_VERSION`).
All `expect` values come from the unmodified JS implementation (the only hand-set expectations are the two
"not an error result" auth cases, whose `category` is `null`; the JS test runs them through a real server too).

| Feature | Fixture file(s) | Fixtures | JS | Python |
|---|---|---|---|---|
| Tool definition hash | `tool-hash.json` | 93 | all assert, 1 test | 93 parametrized (+1 size check) pass |
| Integrity tracker (edge-triggered findings) | `integrity-tracker.json` | 28 | all assert, 1 test | 28 parametrized pass |
| Secret type detection | `secret-types.json` | 52 | all assert, 1 test | 52 pass |
| Secret result scan (UTF-16 budget, windows, caps) | `secret-scan.json` | 47 | all assert, 1 test | 47 pass |
| Auth classification | `auth.json` | 46 | all 46 through a really instrumented v1 `Server`, 1 test | 46 pass (+1) |
| Sensitive tool matching | `sensitive-tools.json` | 33 | all assert, 1 test | 33 pass (+1) |
| **Total new** | 6 files | **299** | 3 vitest files / 19 tests green | Python conformance dir: 770 passed **without the mcp SDK installed** (the CI `conformance` job's setup) |

The 93 hash vectors include key order, nested objects, arrays, astral characters in descriptions and in keys (UTF-16
vs code-point order), `1` vs `1.0` vs `1e0`, `-0`, `2^53+1`, 20/30-digit integers, `1e21`, `1e-7`, `5e-324`, `1e999`,
booleans/null, empty objects/arrays, `__proto__` (also as a sorted sibling), optional fields present vs absent, null
description, lone surrogates, escapes, depth 256 vs 300, non-objects. Every one matches byte for byte.

Documented differences (none affect a shared fixture):
- Clock skew is `jsOnly` (Python has no staleness).
- A Python `Tool` model's `None` top-level fields are treated as absent (they are omitted on the wire); a mapping's
  `None` is kept as `null`, exactly like JS `undefined` vs `null`.
- The dev-mode `pins` snippet is printed in Python syntax (`tool_integrity={...}`), not JS syntax.
- On mcp 1.x (and 2.x without the SDK middleware) opentel-mcp starts a minimal `tools/list` span for the events
  (JS always spans `tools/list` when integrity is on). Only when the option is on.

## 3. Per feature

**Auth failure counter (ADR 031).** `mcp.tool.auth_failures`, label `gen_ai.tool.name` only, +1 per silent or raised
failure classified `auth`; always on; zero with `fingerprinting=False`; obeys `enable_metrics`. Tests: both SDK lines,
FastMCP/MCPServer and low-level `Server`, `replace` and `enrich`, silent, `build_raising` (genuinely thrown),
accumulation, fingerprinting/metrics off, canary on labels, 46 fixtures. No deviation.

**Sensitive tool auditing (ADR 032).** `sensitive_tools=[...]` compiled once; linear glob (split on `*`, anchored ends,
`find` for the middle), UTF-16 lengths via `to_u16` so a name matches in Python exactly when it matches in JS; invalid
entries warn once (never echoing a value) and are skipped; >1000 ignored; `mcp.tool.sensitive` at span start,
`mcp.audit.sensitive_call` on success / silent failure / thrown with outcome, `mcp.tool.duration_ms` (JS rounding) and
the category only when computed. Tests: 33 fixtures plus adversarial patterns (1000 hostile globs, regex
metacharacters, 1025-char names), all outcomes on both SDK lines, mixed sessions, one event per call, canary. Deviation:
also accepts a `tuple`.

**Secret leak detection (ADR 030).** `secret_leak_detection={"enabled","max_scan_bytes"}`, reusing `_secrets`; new
`detect_secret_types_u16`; text items of success and `isError` results, UTF-16 budget (`to_u16`), 4096/256 windows,
10,000 items, 1000-match cap, all taken from the contract; span attributes + `mcp.tool.secret_leaks`; never changes
status. Tests: 99 fixtures, per type end to end on every flavour, truncation at the same unit as JS, 18 pathological
inputs at the cap (measured worst 0.07 s; asserted < 3 s), a 50 MB item cut in 8 ms, hostile shapes (throwing getters,
generators, wrong types), detector failure injected, canary across spans/events/metrics/logs. Deviation: accepts an
integral float for `max_scan_bytes` (JS `Number.isInteger(4096.0)`).

**Tool definition integrity (ADR 029).** `tool_integrity={"enabled","pins"}`; `compute_tool_definition_hash()` exported;
`server.get_tool_integrity_hashes()` (always attached, `{}` when off, like JS); events on the `tools/list` span;
`mcp.tool.integrity_violations`; dev-mode snippet once on stderr. Hashing reproduces JS (UTF-16 key sort, ECMAScript
number format, `JSON.stringify` escaping, array-hashes-as-`{}` quirk, depth 256). Wrapped on 1.x (`request_handlers`
dict subclass, now generalized) and 2.x (`add_request_handler`). Tests: 121 fixtures, pins match/mismatch, change +
pin = one violation, added/removed, pagination (page is not a listing; hashes still checked), disabled default, metrics
off, tracker failure injected, subprocess dev-mode snippet test, canary (incl. `IGNORE PREVIOUS INSTRUCTIONS`).

**End to end (Task 7).** `tests/e2e/test_security_roundtrip.py` against the real `packages/ui`: pin mismatch (hashes,
severity `high`, on the `tools/list` span), secret-leak signal (key assembled at runtime; asserted absent from the
dashboard data and the child's stderr), auth failure, sensitive calls with outcomes; once with `sdk_tracing="enrich"`.
A JS reference server (`_js_server.mjs`) and the Python server serving the same 9 tool definitions report **identical
`actual_hash` values in the dashboard for all 9 tools**, equal to `compute_tool_definition_hash`.

**Docs (Task 8).** README "Security observability" (runnable example + limits), threat model rows 14 to 18, data
handling, FAQ, ADR 028 amendment, ADR 034 amendments, conformance README.

## 4. Decisions I made

1. **Contract version = a hand-bumped integer** (`CONTRACT_VERSION` in `gen-conformance.mjs`), not semver; `contract`
   key removed, `coreVersion` kept informational. Version 1 = core 0.18.1 as shipped, 2 = this work.
2. **Moved the three counters into `metrics`** (now 7) and added a `security` section; `jsOnly` keeps clock skew only.
   This reverses ADR 034's rejected alternative, recorded in the amendment.
3. **Added two fixture files you did not list**: `secret-scan.json` (the only way to prove both languages truncate at
   the same UTF-16 unit) and `integrity-tracker.json` (edge-triggering parity).
4. **`definitionJson` carries JSON text**, so `1.0`, `-0`, `1e0` and `__proto__` reach each parser as written.
5. **Touched core `src` minimally**: four `export` keywords (`CHUNK_SIZE`, `CHUNK_OVERLAP`, `MAX_CONTENT_ITEMS`,
   `MAX_MATCHED_NAME_LENGTH`) so the contract is generated from the constants, not copies. Plus `type` on the secret
   steps in `patterns.json` (source/flags/replacement unchanged). Full core suite green.
6. **Hash the wire form of an mcp `Tool` model** (None = absent), field by field, rather than `model_dump`: pydantic's
   `exclude_none` could drop a legitimate `null` inside a schema.
7. **JS array quirk reproduced** (an array hashes like `{}`), because a shared fixture pins it.
8. **`tools/list` span**: reuse the SDK's on 2.x; start a minimal one on 1.x / without middleware. Default unchanged.
9. **Auth/sensitive conformance tests live in `tests/conformance/`** (not `instrumentation/`), because the CI
   `conformance` job runs without the mcp SDK; verified in a venv with no mcp.
10. **Removed `Set` nondeterminism**: the tracker uses insertion-ordered dicts (`removed` events were order-flaky
    under hash randomization until caught by a fixture).
11. **README example is a single script for mcp 1.x and 2.x** (`try/except ImportError`); the failing tool raises
    `"401 Unauthorized"` (a first draft containing "invalid" classified as `validation`, which the stranger-style
    check caught).
12. **Release docs**: `SECURITY.md`, `releasing.md` and the FAQ say PyPI 0.2.0 is the first release with attestations.
    That is only true once the tag run succeeds; revert those lines if it does not.
13. **Shared e2e helpers** moved to `tests/e2e/ui_support.py`; the old e2e tests are otherwise unchanged.
14. **One extra commit** (`c6d3e71`) beyond "one per task": a timing test (50 MB string built inside the timer) failed
    once and never again in 15 reruns; the input is now built outside the timer. Not squashed to avoid rewriting history.
15. **Edited `.github/workflows/release.yml`** (one step, `35671e3`), which you did not ask for: while checking the tag path I
    reproduced that the python build job runs the suite with **no `mcp` installed** (`uv.lock` deliberately omits it;
    `uv sync --locked --group test` then pytest fails at collection with `PackageNotFoundError: mcp`). That would have
    failed every `python-v*` run. The step now also does `uv pip install --python .venv "mcp>=2,<3"`, exactly as the CI
    python job does; verified locally by the same two commands (1231 passed). The build job holds no publish credentials.
    Revert that commit if you would rather fix it differently.
16. Did not check the Security panel in a browser (no browser here). Verified its data through the dashboard's HTTP
    API and that the live published UI 0.4.1 serves the panel bundle.

## 5. What a `python-v0.2.0` tag triggers, and first-run risks

`release.yml` (`on: push: tags: python-v*`):

1. **plan**: sets `python=true` (the tag matches `python-v*`).
2. **build-python** (no publish credentials, Python 3.12, uv): reads `pyproject.toml` (0.2.0) and fails unless the tag is
   `python-v0.2.0` (matches); asks PyPI for 0.2.0 (404 expected, otherwise it skips publishing);
   `uv sync --locked --group test` and, since the fix in Decisions 15, `uv pip install "mcp>=2,<3"` (lock is current: `uv lock --check` passes); `ruff check`, `ruff format --check`,
   `mypy`, full `pytest` (e2e skips itself: no root `node_modules`); `uv build`; `twine check --strict` (passes locally,
   twine 7.0.0); CycloneDX SBOM via `uv export --preview` (works locally); uploads wheel + sdist + SBOM as `dist-python`.
3. **publish-python**: waits for approval of the `release` environment, downloads that exact artifact, stages wheel and
   sdist only, publishes with `pypa/gh-action-pypi-publish` via OIDC trusted publishing with PEP 740 attestations, then
   `actions/attest` for the wheel with the SBOM.
4. **github-release**: creates release `python-v0.2.0` (tag exists; `--target` is ignored), attaches wheel, sdist, SBOM.

First-run risks, most likely first:
- **(Found and fixed here) no `mcp` in the build job**, see Decisions 15. Without that commit the tag run fails in
  build-python, before anything is published.
- **PyPI trusted publisher not configured.** It must exist for project `opentel-mcp` with owner/repo
  `Thirumalaiboobathi/opentel-mcp`, workflow `release.yml`, environment `release`. 0.1.0 was uploaded by hand, so this
  is the first OIDC publish for the project. Missing or mismatched -> the publish step fails with an
  invalid-publisher error after you approve; nothing is published; fix it on PyPI and re-run the failed job (same
  artifact). A wrong environment name also breaks the attestation identity.
- **`release` environment** must exist with the required reviewer, or the job sits waiting / fails.
- **Partial success**: if `actions/attest` fails after the upload, 0.2.0 is already on PyPI (the release job still runs,
  `published` is set before the attest step) but the GitHub attestation / SBOM predicate is missing. PyPI files cannot
  be re-uploaded; the fix would be 0.2.1.
- The release job tests **one** SDK line (the newest mcp 2.x it installs) on Python 3.12 only; the 1.x / 3.10 / 3.14 /
  macOS / Windows coverage is the CI `python` matrix, which should be green on the PR first. I could not run the
  macOS and Windows legs. CI's ubuntu legs now also run the new JS-vs-Python e2e (needs the root `npm ci`, which that
  job already does).
- Timing assertions (secret scan, matcher) have 10x to 100x headroom locally; a very slow runner is the only way they flake.
- Version/tag mismatch fails the build step by design (they match now).

## 6. Final verification (run once, on the final tree)

| Check | Result |
|---|---|
| Python 3.10 + mcp 1.25.0 | 1124 passed, 64 skipped |
| Python 3.10 + mcp 2.3.0 | 1231 passed, 14 skipped |
| Python 3.12 + mcp 1.30.0 / 2.3.0 | 1124 passed / 1231 passed |
| Python 3.14 + mcp 1.30.0 / 2.3.0 | 1124 passed / 1231 passed |
| `ruff check`, `ruff format --check`, `mypy` (strict) | clean (3.12 both SDKs, 3.10 + 1.25, 3.14 + 2.x) |
| Conformance: `gen-conformance.mjs --check` | up to date |
| Conformance: JS vitest `test/conformance` | 3 files, 19 tests passed |
| Conformance: Python without the mcp SDK (the CI job's command) | 770 passed |
| JS core, full suite (nothing in JS changed behavior) | 75 files / 1543 tests passed, 4 skipped (pre-existing); `tsc --noEmit` clean |
| `pip-audit` on `uv.lock` (all groups, 71 pinned) | no known vulnerabilities |
| `uv build` + `twine check --strict` (sdist + wheel) | PASSED; SBOM export works |
| Stranger test | fresh venv outside the repo, built wheel `[dev]` + mcp, **live `npx opentel-mcp-ui` 0.4.1**, README's Try-it block extracted verbatim: on mcp 2.3.0 and 1.30.0 the dashboard received the pin mismatch (high), the `aws_access_key_id` leak signal, 5 `auth` failures and 5 sensitive calls (`silent_failure`); the key text is in neither the dashboard data nor stderr. No README fix was needed beyond one sentence warning that dev mode is noisy on stderr. All README python blocks of the section also execute. |

Two notes: a pre-existing `ResourceWarning` (unclosed pipe) shows on Python 3.10 in `test_sigterm_flushes...` only with
`-W default`; and one run of `test_secret_leak.py` had a timing failure that did not reproduce (fixed as above).

## 7. Commands for you

```sh
git push -u origin release/python-0.2.0-security
# open the PR:
#   https://github.com/Thirumalaiboobathi/opentel-mcp/compare/main...release/python-0.2.0-security?expand=1
# wait for CI (python matrix incl. macOS/Windows, conformance, CodeQL) to be green, then merge.

# after merge
git switch main && git pull
git tag python-v0.2.0          # on the merge commit; the version in pyproject.toml is 0.2.0
git push origin python-v0.2.0
# GitHub -> Actions -> Release: when build-python is green, approve the "release" environment for publish-python.

# verify
python3 -m venv /tmp/v && /tmp/v/bin/pip install opentel-mcp==0.2.0 && /tmp/v/bin/python -c "import opentel_mcp; print(opentel_mcp.__version__)"
# PyPI file page for the wheel shows the PEP 740 attestation / provenance; or:
pip install pypi-attestations
pypi-attestations verify pypi --repository https://github.com/Thirumalaiboobathi/opentel-mcp <direct wheel URL on files.pythonhosted.org>
gh attestation verify <downloaded wheel> --repo Thirumalaiboobathi/opentel-mcp
```

Before tagging, confirm PyPI -> opentel-mcp -> Publishing has the trusted publisher described in section 5.

**Reminder:** a manual `twine upload` produces **no attestations** (no PEP 740 provenance, no GitHub attestation, no
SBOM). Use it only if the workflow cannot be fixed, and then revise the "first release with attestations" lines in
`SECURITY.md`, `docs/security/releasing.md` and the FAQ.

# Run report: security posture (branch `chore/security-posture`)

Date: 2026-11-07. No runtime code changed (`git diff` under `packages/core/src`, `packages/ui/src`, `packages/ui/web`,
`packages/python/src` is empty). Nothing was committed, pushed, tagged or published; nothing was changed on npmjs.com,
pypi.org or GitHub.

## 1. What was added, per task

**Task A: signed releases** — [`.github/workflows/release.yml`](../../.github/workflows/release.yml),
[`.github/scripts/npm-meta.sh`](../../.github/scripts/npm-meta.sh), [`docs/security/releasing.md`](../security/releasing.md).
One workflow file with jobs `plan` → `build-core/ui/python` (no credentials; full tests, typecheck, `verify:tarball`,
`twine check`, SBOM; uploads the tested artifact) → `publish-core` → `publish-ui` (needs core), `publish-python`
(`environment: release`, `id-token: write` only there) → `github-release` (`contents: write` only there). Triggers: tags
`core-v*`, `ui-v*`, `python-v*` and `workflow_dispatch` (core/ui/python/all, main only). Registry/PyPI existence check
with a skip notice; the tag must match the package version. All actions pinned to SHAs; env-passed inputs; no
`pull_request_target`; `persist-credentials: false`.

**Task E: security docs** — [`docs/security/README.md`](../security/README.md), `threat-model.md`, `data-handling.md`,
`security-faq.md`, expanded [`SECURITY.md`](../../SECURITY.md) (supported versions, reporting, goals, fix process).
Every claim cites a file and, where one exists, a test.

**Task C: scanning/hardening** — [`codeql.yml`](../../.github/workflows/codeql.yml) (javascript-typescript, python, actions;
push/PR/weekly), [`scorecard.yml`](../../.github/workflows/scorecard.yml), [`dependabot.yml`](../../.github/dependabot.yml)
(added `uv` for `packages/python`, grouped Actions updates), hardened [`ci.yml`](../../.github/workflows/ci.yml)
(SHA pins at the same major versions as before, top-level `contents: read`, `persist-credentials: false`, the one
`${{ matrix.mcp }}` in a `run:` moved to an env var; tested matrix unchanged).

**Task B: SBOM** — CycloneDX per package generated in the build jobs (`.github/scripts/npm-sbom.sh` for npm;
`uv export --format cyclonedx1.5 --no-dev --frozen --preview` for Python), attached to the GitHub release and attested
with `actions/attest` (`sbom-path`; this is the current replacement for `attest-sbom`). Documented in `releasing.md`.

**Task D: audit** — see §5. `npm audit`: 16 findings → 0. Files: `package-lock.json`, `packages/core/package.json`,
`packages/ui/package.json` (dev dependencies `vitest` ^2.1.8 → ^5.1.0, `@vitest/coverage-v8` ^2.1.9 → ^5.1.0),
`packages/core/vitest.config.js` (`testTimeout: 20_000`, see decisions).

**Task F: READMEs** — "Security" section with badges in the root README; "Security and privacy" paragraph (absolute
GitHub URLs) in the core, ui and python package READMEs.

## 2. Decisions I made

1. One release workflow file (npm and PyPI each pin one workflow filename; "all" needs core→ui ordering). Per-job
   least privilege instead of per-ecosystem files.
2. Build and test with no credentials, publish the uploaded artifact in a separate job (so no `npm ci`/test code runs
   with the OIDC token). `npm publish <tarball>`; `--provenance` also passed explicitly.
3. Node 22.14.0 and npm CLI pinned to 11.21.2 in publish jobs (docs: npm ≥ 11.5.1, Node ≥ 22.14.0); the exact-pinned
   `npm install -g` is flagged by zizmor `adhoc-packages` and kept deliberately.
4. No TestPyPI path (a second publisher and workflow to maintain; an unattested dry run adds little).
5. `workflow_dispatch` releases are allowed from `main` only; tags are created by the release job for dispatch runs.
6. GitHub release created with the preinstalled `gh` CLI instead of a third-party release action.
7. CI actions pinned at their current major (checkout 4.4.0, setup-node 4.4.0, setup-uv 5.4.2) rather than jumping
   majors, to avoid behaviour changes in a matrix I can't run here (setup-uv v5 venv behaviour is documented in the
   existing CI comments). Release/CodeQL/Scorecard use current versions. Dependabot will propose bumps.
8. Vitest 2 → 5: the only route to a clean audit (vitest ≤ 4.1.10, tinypool, vite, esbuild chain; the fix is a major).
   Dev dependencies only, published file lists and runtime dependencies verified identical. Vitest 5 made the thrash
   benchmark exceed the 5 s default timeout under full-suite load (it passes alone), so I raised `testTimeout` in
   `packages/core/vitest.config.js`; no assertion was changed.
9. Response-time goals in `SECURITY.md`: acknowledge 5 business days, assess 14 days, high-severity fix target 30 days,
   all labelled goals.
10. Metric cardinality is documented honestly: the allowlist is enforced by a test, but tool name / `error.type` /
    model id are shape-bounded, not set-bounded ([`docs/known-gaps.md`](../known-gaps.md) §11), so the docs don't claim
    "bounded cardinality" without that caveat.
11. Python features other than the basics (staleness, thrash, cost, schema drift) are marked "not verified for Python".
12. `npm audit fix` also refreshed the lockfile (nested vite/esbuild copies for vitest 2 removed); lockfile only.
13. The prompt named `normalize/secrets.js`; the real path is `packages/core/src/fingerprint/normalize/secrets.js`.

## 3. One-time setup for you, in order

Full detail: [`docs/security/releasing.md`](../security/releasing.md).

1. **Merge this branch to `main`** (workflow files must be on `main` for CodeQL/Scorecard, and for the trusted publisher to match).
2. **GitHub → Settings**
   1. Environments → New → `release`; Required reviewers: yourself; deployment branches/tags: `main`, `core-v*`, `ui-v*`, `python-v*`.
   2. Rules → Rulesets: tag ruleset for `core-v*`, `ui-v*`, `python-v*` (restrict create/update/delete to maintainers); branch ruleset for `main` (PRs + required CI checks, no force push).
   3. Code security: enable Private vulnerability reporting, Dependency graph, Dependabot alerts + security updates, Code scanning.
   4. Actions → General: default workflow permissions read-only.
3. **npmjs.com**, for `opentel-mcp` then `opentel-mcp-ui`: Package → Settings → Trusted Publisher → GitHub Actions: owner `Thirumalaiboobathi`, repo `opentel-mcp`, workflow `release.yml`, environment `release`. Do this within days of your first release (unused configs expire after 2 days per the npm docs).
4. **pypi.org**: `opentel-mcp` → Publishing → add GitHub publisher: owner `Thirumalaiboobathi`, repo `opentel-mcp`, workflow `release.yml`, environment `release`.
5. **First release**: bump versions (the current ones are already published, so the workflow will skip them), push a tag such as `core-v0.17.1`, approve in the `release` environment, check provenance on the npm page, then run `npm audit signatures`.
6. **After a successful OIDC publish**: npm package Settings → Publishing access → "Require two-factor authentication and disallow tokens"; revoke old npm and PyPI tokens.
7. **2FA checks** (I could not verify any of these): GitHub (prefer a security key/passkey), npm (authorization *and* publishing), PyPI.
8. Optional: add the Scorecard results (first run after merge) and decide on thresholds.

## 4. Decisions I need from you

- Response-time goals in `SECURITY.md` (5 / 14 / 30 days) — keep or change.
- Whether to disallow npm tokens after the first OIDC release (recommended) and drop PyPI API tokens.
- Whether to require "Prevent self-review" on the `release` environment (only when there's a second maintainer).
- Whether to keep vitest 5 (my choice for a clean audit) or revert to vitest 2 and accept 11 dev-only advisories.
- Scorecard: whether to set a score target or fail-on-score gate (none configured).
- Confirm the "to be confirmed" 2FA items in `security-faq.md`.
- Tag history: leave `v0.17.0`/`python-v0.1.0` as is (documented), or add `core-v0.17.0` aliases.
- Consider a second maintainer; Scorecard will penalise single-maintainer review and branch-protection gaps.

## 5. Verification results

| Check | Result |
| --- | --- |
| actionlint (all 5 workflows) | clean |
| zizmor (default persona) | 0 high/medium; 2 low `adhoc-packages` in `ci.yml` (intentional: the dependency-audit job installs the packed tarballs it audits; in-script `npm install` of the tarball, not a registry package) and the exact-pinned npm install in `release.yml` carries an inline ignore. `--pedantic` adds only: unnamed jobs, missing concurrency groups on ci/codeql/scorecard (cosmetic), 1 undocumented permission |
| Diff in runtime code | none |
| `npm pack --dry-run` file lists (core 73 files, ui 23 files) | identical before/after; runtime `dependencies`/`peerDependencies` unchanged (diff touches only `devDependencies`) |
| JS tests | core 1311 passed, 4 skipped; ui 230 passed. Before adding `testTimeout`, the thrash benchmark timed out under load (passes alone). The `flush-on-exit` "capped at 1000 ms" test is timing-sensitive on this WSL machine and failed intermittently both before and after my changes (passes alone) |
| typecheck / build / `verify:tarball` | pass (core and ui) |
| Conformance | fixtures up to date (`gen-conformance.mjs --check`); JS conformance 10 passed; Python conformance + contract 465 passed |
| Python (3.12, mcp 2.x latest, uv.lock) | ruff + mypy clean; pytest 715 passed, 13 skipped, **1 failed**: `tests/dev/test_dev_mode.py::test_exporter_url_gets_otlp_json_with_hex_ids_flushed_on_normal_exit` — passes when that file runs alone (twice); I did not change Python code, so I treat it as load-related flakiness but did not root-cause it |
| `npm audit` (root, all workspaces incl. dev and examples) | **0 vulnerabilities** (was 16: 3 critical, 4 high, 9 moderate). Fixed by `npm audit fix` (body-parser, fast-uri, ip-address, qs, undici, zod: lockfile only) and the vitest 5 upgrade (vitest, @vitest/coverage-v8, tinypool, vite, vite-node, esbuild, glob, minimatch, test-exclude: dev-only). None were in the published packages' runtime dependency trees (CI `dependency-audit` already gates that) |
| `pip-audit` on `uv.lock` (runtime + all groups + extras, 27 pins) | no known vulnerabilities |
| Links in new docs/SECURITY.md/README | all resolve (after this report was written); absolute README links point at paths that exist on `main` once merged, since the docs are new on this branch |
| Not run | the workflows themselves (they can't be exercised without GitHub); `uv export --preview` and `npm-sbom.sh` were run locally and produce valid CycloneDX (npm: 24 components for core) |

Caveats to know: the release and attestation steps are untested until the first real run; npm trusted publishing
cannot be validated until configured; `uv export --format cyclonedx1.5` is a preview feature; the Scorecard and
CodeQL badges show nothing until their first runs on `main`; the npm "provenance" has no dedicated badge, so the
README uses text.

## 6. What's left

Nothing cut. Follow-ups (not done by design): runtime changes none needed; consider bounding the tool-name metric label
(runtime, [known gaps §11](../known-gaps.md)); decide on python features' privacy review (staleness/thrash/cost); root-cause
the flaky Python dev-mode test and the timing-sensitive flush-on-exit test; add `concurrency` groups to ci/codeql/scorecard.

## 7. `git status --short`

See the terminal output when this report was generated (printed below the report).

## 8. Commit and push commands

```sh
git add -A
git status --short   # review
git commit -m "chore: security posture (release workflow with provenance and SBOM, scanning, security docs, clean audit)"
git push -u origin chore/security-posture
# then open a PR; do not tag until the one-time setup in section 3 is done
```

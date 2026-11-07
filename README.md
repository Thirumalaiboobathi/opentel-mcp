# opentel-mcp (monorepo)

This repository is an npm-workspaces monorepo for the `opentel-mcp` project.

| Package | Path | Description |
|---|---|---|
| [`opentel-mcp`](packages/core/README.md) | `packages/core` | OpenTelemetry instrumentation for MCP servers — the published library. |
| [`opentel-mcp-ui`](packages/ui/README.md) | `packages/ui` | Zero-infrastructure local dashboard for the observation contract — the published CLI (`npx opentel-mcp-ui --demo`). |
| [`opentel-mcp` (Python)](packages/python/README.md) | `packages/python` | The Python port for servers built on the official `mcp` SDK (1.x and 2.x), on PyPI as `opentel-mcp`. Emits the same spans and metrics as the JS package, so the same dashboard works. Not an npm workspace. |

The two implementations are held to one contract by a shared, language-neutral
[conformance suite](conformance/README.md) generated from the JS package.

Runnable usage examples live under [`examples/`](examples/), and design docs
(including all ADRs) live under [`docs/`](docs/).

## Security

[![OpenSSF Scorecard](https://api.scorecard.dev/projects/github.com/Thirumalaiboobathi/opentel-mcp/badge)](https://scorecard.dev/viewer/?uri=github.com/Thirumalaiboobathi/opentel-mcp)
[![CodeQL](https://github.com/Thirumalaiboobathi/opentel-mcp/actions/workflows/codeql.yml/badge.svg)](https://github.com/Thirumalaiboobathi/opentel-mcp/actions/workflows/codeql.yml)
[![CI](https://github.com/Thirumalaiboobathi/opentel-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/Thirumalaiboobathi/opentel-mcp/actions/workflows/ci.yml)

The instrumentation is designed to record only derived signals, never tool arguments or result content, and sends
nothing to the maintainer. Releases published by the [release workflow](.github/workflows/release.yml) carry npm
provenance / PyPI attestations and a CycloneDX SBOM (check with `npm audit signatures`).

- [Security documentation](docs/security/README.md): [threat model](docs/security/threat-model.md),
  [data handling](docs/security/data-handling.md), [vendor FAQ](docs/security/security-faq.md),
  [release and verification process](docs/security/releasing.md)
- [Security policy and how to report a vulnerability](SECURITY.md)

## Dev setup

```bash
npm install
npm test
```

`npm install` at the repo root installs and links every workspace. Each
package's own README/CONTRIBUTING doc has package-specific details — start
with [`packages/core/README.md`](packages/core/README.md) for the library
itself.

### Python package

```bash
cd packages/python
uv sync --group test                 # dev environment (uv.lock is committed)
uv pip install "mcp>=2,<3"           # or "mcp>=1.25,<2" / "mcp==1.25.*": the SDK under test
uv run --no-sync pytest              # also: ruff check ., ruff format --check ., mypy
```

See [`CONTRIBUTING.md`](CONTRIBUTING.md#releasing-the-python-package) for how the Python package is released.

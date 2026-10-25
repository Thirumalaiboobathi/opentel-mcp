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

# opentel-mcp (monorepo)

This repository is an npm-workspaces monorepo for the `opentel-mcp` project.

| Package | Path | Description |
|---|---|---|
| [`opentel-mcp`](packages/core/README.md) | `packages/core` | OpenTelemetry instrumentation for MCP servers — the published library. |
| `opentel-mcp-ui` | `packages/ui` | Zero-infrastructure local dashboard for the observation contract (scaffold). |

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

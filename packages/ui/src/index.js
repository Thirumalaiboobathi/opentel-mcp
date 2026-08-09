/**
 * @module opentel-mcp-ui
 *
 * Scaffold only — no implementation yet. This package will become a
 * zero-infrastructure local dashboard (one command, no Docker/Prometheus/
 * Grafana/config file) that renders opentel-mcp's two-axis observation
 * contract. Declares a peer dependency RANGE on `opentel-mcp` (see
 * package.json), not a pinned version — core stays independently
 * versionable. Core itself must never gain a dependency on this package
 * or on React.
 */

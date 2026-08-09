/**
 * @module opentel-mcp-ui
 *
 * Zero-infrastructure local dashboard for opentel-mcp's two-axis
 * observation contract. `withUI()` is the in-process integration mode —
 * see its own docblock (`with-ui.js`) for how it hooks into spans without
 * opentel-mcp core needing any changes. The standalone mode is
 * `npx opentel-mcp-ui` (`bin/opentel-mcp-ui.js`), not exported here.
 */

export { withUI } from './with-ui.js';
export { SpanBuffer, DEFAULT_SPAN_BUFFER_CAPACITY } from './span-buffer.js';
export { CollectorSpanProcessor } from './collector-span-processor.js';

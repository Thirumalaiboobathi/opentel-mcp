/**
 * Demonstrates deep-failure fingerprinting (v0.4.0+) in isolation, without
 * needing a running MCP server: computeFingerprint() is a pure function
 * over an error/CallToolResult and a small context object, so it can be
 * called directly. See docs/adr/005-deep-failure-fingerprinting.md and the
 * README's "Failure Fingerprinting" section for the full picture — in a
 * real, instrumented server this all happens automatically inside
 * wrapToolCallHandler (src/instrument.js).
 *
 * How to run:
 *   node examples/fingerprint-demo.js
 */

import { randomUUID } from 'node:crypto';
import { computeFingerprint } from '../src/fingerprint/compose.js';

// Two distinct call sites with the same *shape* of error, so the demo can
// show that varying an id embedded in the message doesn't change the
// fingerprint, but varying the call site does.
function lookupUser() {
  throw new Error(`user ${randomUUID()} not found`);
}

function lookupOrder() {
  throw new Error(`user ${randomUUID()} not found`);
}

const ctx = { toolName: 'lookupUser', origin: 'thrown', cwd: process.cwd() };

console.log('--- Same call site, 3 calls, different UUIDs each time ---');
const sameSiteFingerprints = [];
for (let i = 1; i <= 3; i++) {
  try {
    lookupUser();
  } catch (err) {
    const result = computeFingerprint(err, ctx);
    sameSiteFingerprints.push(result.fingerprint);
    console.log(`  call ${i}: fingerprint=${result.fingerprint}  message="${err.message}"`);
  }
}
console.log(`  all 3 fingerprints match: ${sameSiteFingerprints.every((f) => f === sameSiteFingerprints[0])}`);

console.log('\n--- Same error shape, different call site ---');
let differentSiteFingerprint;
try {
  lookupOrder();
} catch (err) {
  const result = computeFingerprint(err, ctx);
  differentSiteFingerprint = result.fingerprint;
  console.log(`  fingerprint=${result.fingerprint}  message="${err.message}"`);
}
console.log(`  differs from the same-site fingerprint: ${differentSiteFingerprint !== sameSiteFingerprints[0]}`);

console.log('\n--- CallToolResult { isError: true } (tool-level failure, nothing thrown) ---');
const toolResult = {
  isError: true,
  content: [{ type: 'text', text: `Invalid request: id ${randomUUID()} rejected` }],
};
const toolCtx = { toolName: 'submitOrder', origin: 'tool_error', cwd: process.cwd() };
const toolFingerprint = computeFingerprint(toolResult, toolCtx);
console.log(
  `  fingerprint=${toolFingerprint.fingerprint}  category=${toolFingerprint.category}  ` +
    `signature=${toolFingerprint.signature}`,
);

/*
Expected output (fingerprints are stable hashes of the normalized message +
stack shape + category + origin — yours will match exactly, since none of
those inputs vary between runs on this file):

--- Same call site, 3 calls, different UUIDs each time ---
  call 1: fingerprint=f14bcc8c7e8329ad  message="user 491f4a4d-b40e-4c24-bb32-646fe93ed975 not found"
  call 2: fingerprint=f14bcc8c7e8329ad  message="user eb2de8df-ba1f-4ce4-9121-7ea0444f97b2 not found"
  call 3: fingerprint=f14bcc8c7e8329ad  message="user bb7408ee-32fc-4db8-b5d6-525e13ff0e4c not found"
  all 3 fingerprints match: true

--- Same error shape, different call site ---
  fingerprint=8fbb8239c67b9a7a  message="user fd5d3235-f631-4561-b438-c01761dab320 not found"
  differs from the same-site fingerprint: true

--- CallToolResult { isError: true } (tool-level failure, nothing thrown) ---
  fingerprint=f616b44ae0099c3b  category=validation  signature=MCPToolError@anon:?
*/

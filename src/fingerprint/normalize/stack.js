/**
 * @module fingerprint/normalize/stack
 *
 * Parses a V8 `Error.stack` string into normalized, low-cardinality
 * frames and a joinable signature, for fingerprinting.
 *
 * V8 frame lines come in two shapes:
 *   "    at fnName (path/to/file.js:12:34)"
 *   "    at path/to/file.js:12:34"
 * (plus native-code variants like "at Array.forEach (native)" and
 * "at process.processTicksAndRejections (node:internal/process/task_queues.js:95:5)").
 *
 * Only the frame lines matter for identity — the leading "Error: message"
 * line and anything that doesn't parse as a frame is silently skipped, and
 * native frames (node: internals, V8 builtins) are dropped entirely since
 * they're implementation noise rather than signal about where the failure
 * originated.
 */

/** @typedef {import('../types.d.ts').NormalizedStackFrame} NormalizedStackFrame */

const DEFAULT_MAX_FRAMES = 5;

const FRAME_LINE_RE = /^\s*at\s+(.*)$/;
const CALL_SITE_RE = /^(.*?)\s+\((.*)\)$/;
const LOCATION_RE = /^(.*):(\d+):(\d+)$/;
const NODE_MODULES_RE = /node_modules\//;

/**
 * @param {string} p
 * @returns {string}
 */
function normalizeSlashes(p) {
  return p.replace(/\\/g, '/');
}

/**
 * `node_modules/foo@1.2.3/lib/a.js` -> `node_modules/foo/lib/a.js`
 * `node_modules/@org/pkg/lib/a.js` -> `node_modules/@org/pkg/lib/a.js`
 *
 * @param {string} file
 * @returns {string}
 */
function normalizeNodeModulesPath(file) {
  const marker = 'node_modules/';
  const idx = file.lastIndexOf(marker);
  const after = file.slice(idx + marker.length);
  const segments = after.split('/');

  let pkg;
  let restSegments;
  if (segments[0]?.startsWith('@')) {
    pkg = `${segments[0]}/${segments[1] ?? ''}`;
    restSegments = segments.slice(2);
  } else {
    pkg = segments[0].split('@')[0];
    restSegments = segments.slice(1);
  }

  const rest = restSegments.join('/');
  return rest ? `${marker}${pkg}/${rest}` : `${marker}${pkg}`;
}

/**
 * @param {string} file
 * @param {string} cwd
 * @returns {string}
 */
function normalizeCwdPath(file, cwd) {
  if (cwd && file.startsWith(`${cwd}/`)) {
    return file.slice(cwd.length + 1);
  }
  return file;
}

/**
 * @param {string} line
 * @param {string} cwd
 * @returns {NormalizedStackFrame | null}
 */
function parseLine(line, cwd) {
  const frameMatch = FRAME_LINE_RE.exec(line);
  if (!frameMatch) return null;

  const rest = frameMatch[1].trim();
  if (!rest) return null;

  let fn = '';
  let location = rest;

  const callSite = CALL_SITE_RE.exec(rest);
  if (callSite) {
    fn = callSite[1].trim();
    location = callSite[2].trim();
  }
  if (!location) return null;

  const isNativeMarker = location === 'native';

  let rawFile = location;
  let lineNumber = null;
  if (!isNativeMarker) {
    const locationMatch = LOCATION_RE.exec(location);
    if (locationMatch) {
      rawFile = locationMatch[1];
      lineNumber = Number(locationMatch[2]);
    }
  }
  rawFile = normalizeSlashes(rawFile);

  const isNative = isNativeMarker || rawFile.startsWith('node:') || rawFile.includes('internal/');
  const isNodeModules = !isNative && NODE_MODULES_RE.test(rawFile);

  const file = isNative
    ? rawFile
    : isNodeModules
      ? normalizeNodeModulesPath(rawFile)
      : normalizeCwdPath(rawFile, cwd);

  return {
    fn,
    file,
    line: lineNumber,
    isNative,
    isUserCode: !isNative && !isNodeModules,
  };
}

/**
 * Parses and normalizes an `Error.stack` string.
 *
 * @param {string | undefined} stackString
 * @param {{ cwd?: string, maxFrames?: number }} [opts]
 * @returns {{ frames: NormalizedStackFrame[], signature: string }}
 */
export function parseAndNormalizeStack(stackString, opts = {}) {
  if (!stackString) {
    return { frames: [], signature: '' };
  }

  try {
    const cwd = normalizeSlashes(opts.cwd ?? process.cwd());
    const maxFrames = opts.maxFrames ?? DEFAULT_MAX_FRAMES;

    const userFrames = [];
    const otherFrames = [];

    for (const line of stackString.split('\n')) {
      const frame = parseLine(line, cwd);
      if (!frame || frame.isNative) continue;

      if (frame.isUserCode) {
        if (userFrames.length < maxFrames) userFrames.push(frame);
      } else if (otherFrames.length < maxFrames) {
        otherFrames.push(frame);
      }
    }

    const frames = userFrames.length > 0 ? userFrames : otherFrames;
    const signature = frames.map((f) => `${f.fn}@${f.file}:${f.line ?? '?'}`).join('|');
    return { frames, signature };
  } catch {
    return { frames: [], signature: '' };
  }
}

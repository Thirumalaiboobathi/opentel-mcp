/**
 * @module request-guard
 *
 * v0.3.0 security hardening for the local dashboard server. The server
 * binds to 127.0.0.1 only and has no authentication, so the remaining
 * attackers are web pages open in the user's own browser:
 *
 * - **DNS rebinding:** a page on `evil.example` re-points its own name at
 *   127.0.0.1 and then reads `/api/*` as "same-origin". Defeated by
 *   checking the Host header: only loopback names, on the port this server
 *   is actually listening on.
 * - **Cross-site requests (CSRF / drive-by):** a page POSTs fake spans to
 *   `/v1/traces` as a "simple" `text/plain` request (no preflight), or
 *   reads `/api/*`. Defeated by rejecting any request whose `Origin` isn't
 *   this server's own, or, with no Origin, whose `Sec-Fetch-Site` says
 *   cross-site; and by accepting only `application/json` on `/v1/traces`.
 *
 * Server-to-server OTLP export (opentel-mcp core's exporter, curl) sends
 * no Origin and no Sec-Fetch-* headers, so it's unaffected.
 */

/** Hostnames that mean "this machine", as they appear in a Host or Origin header. */
const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]']);

/** Largest OTLP request body accepted: 8 MiB, far above a normal batch (~1 KB per span). */
export const MAX_OTLP_BODY_BYTES = 8 * 1024 * 1024;

/**
 * After a 413, the rest of an oversized upload is read and thrown away (so
 * the sender can read the 413 instead of hitting a reset mid-write), up to
 * this many bytes in total. Past it, the connection is cut.
 */
export const MAX_DISCARDED_BODY_BYTES = 64 * 1024 * 1024;

/**
 * Splits a Host header value (`name[:port]`, IPv6 in brackets).
 *
 * @param {string} host
 * @returns {{ hostname: string, port: number | null } | null}
 */
function parseHost(host) {
  const match = /^(\[[0-9a-fA-F:.]+\]|[^:[\]]+)(?::(\d{1,5}))?$/.exec(host.trim());
  if (!match) return null;
  return { hostname: match[1].toLowerCase(), port: match[2] === undefined ? null : Number(match[2]) };
}

/**
 * True when `host` names this machine on `localPort`. A Host without a
 * port means port 80. A missing Host header is allowed: browsers always
 * send one, so its absence can't be a rebinding attack.
 *
 * @param {string | undefined} host
 * @param {number | undefined} localPort
 * @returns {boolean}
 */
export function isAllowedHost(host, localPort) {
  if (host === undefined || host === '') return true;
  const parsed = parseHost(host);
  if (!parsed || !LOOPBACK_HOSTNAMES.has(parsed.hostname)) return false;
  return (parsed.port ?? 80) === localPort;
}

/**
 * True when `origin` is this server's own origin (`http://<loopback>:<localPort>`).
 *
 * @param {string} origin
 * @param {number | undefined} localPort
 * @returns {boolean}
 */
export function isSameOrigin(origin, localPort) {
  let url;
  try {
    url = new URL(origin);
  } catch {
    return false; // includes the opaque origin "null"
  }
  if (url.protocol !== 'http:') return false;
  const port = url.port === '' ? 80 : Number(url.port);
  return LOOPBACK_HOSTNAMES.has(url.hostname.toLowerCase()) && port === localPort;
}

/**
 * Decides whether to serve a request. `null` means go ahead; otherwise the
 * status and a short explanation to send back.
 *
 * - Every route: the Host header must be loopback on this port.
 * - `/api/*` and `/v1/traces`: a browser request must come from this
 *   dashboard's own origin. `/` is exempt, so following a link to the
 *   dashboard from anywhere still works.
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {string} pathname
 * @returns {{ status: number, error: string } | null}
 */
export function checkRequest(req, pathname) {
  const localPort = req.socket?.localPort;
  if (!isAllowedHost(req.headers.host, localPort)) {
    return {
      status: 403,
      error: 'opentel-mcp-ui only answers requests addressed to localhost, 127.0.0.1 or [::1] on its own port.',
    };
  }

  const isDataRoute = pathname === '/v1/traces' || pathname.startsWith('/api/');
  if (!isDataRoute) return null;

  const origin = req.headers.origin;
  if (typeof origin === 'string') {
    if (!isSameOrigin(origin, localPort)) {
      return { status: 403, error: 'Cross-origin requests to opentel-mcp-ui are not allowed.' };
    }
  } else if (req.headers['sec-fetch-site'] === 'cross-site') {
    return { status: 403, error: 'Cross-site requests to opentel-mcp-ui are not allowed.' };
  }
  return null;
}

/**
 * OTLP/HTTP JSON only. `null` when acceptable.
 *
 * @param {string | undefined} contentType
 * @returns {{ status: number, error: string } | null}
 */
export function checkOtlpContentType(contentType) {
  const mediaType = (contentType ?? '').split(';')[0].trim().toLowerCase();
  if (mediaType === 'application/json') return null;
  return {
    status: 415,
    error:
      `opentel-mcp-ui accepts OTLP/HTTP JSON only (Content-Type: application/json), got ${JSON.stringify(mediaType || 'none')}. ` +
      'opentel-mcp core’s exporterUrl sends JSON by default.',
  };
}

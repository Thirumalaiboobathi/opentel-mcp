/**
 * @module fingerprint/classify/auth
 *
 * Classifies authn/authz failures: 401/403 status codes, known
 * auth-related error names, Node's own OS-level permission error codes,
 * and message wording covering both HTTP-style ("unauthorized",
 * "forbidden") and OS/CLI-style ("permission denied", "access denied")
 * phrasing — the latter verified against real tool output, not guessed:
 *
 * - Node's `fs` module: a permission-denied filesystem operation throws
 *   with `err.code === 'EACCES'` and `err.message === "EACCES: permission
 *   denied, <syscall> '<path>'"` (confirmed directly against the
 *   installed Node runtime — `fs.writeFileSync()`/`readFileSync()` against
 *   a path without permission). `EPERM` ("operation not permitted") is
 *   Node's other OS-level permission error code, used e.g. when an
 *   operation needs elevated privileges.
 * - git: an SSH-auth failure prints OpenSSH's own literal wording,
 *   `Permission denied (publickey)`; an HTTPS push without access prints
 *   `remote: Permission to <owner>/<repo>.git denied to <user>.`.
 * - AWS: IAM's standard explicit-deny message is "User: ... is *not
 *   authorized to perform*: <action> on resource: ..."; S3 and many other
 *   services instead return an `AccessDenied` error code/name with
 *   message "Access Denied".
 * - GCP: the standard gRPC/REST status is literally `PERMISSION_DENIED`,
 *   with messages like "Permission '...' denied on resource ..." or
 *   "The caller does not have permission".
 *
 * "insufficient permission(s)" is included as its own phrase — common,
 * distinct wording (SQL Server, Salesforce, Windows UAC-style messages)
 * that doesn't contain "denied" at all.
 *
 * DELIBERATELY NOT matching bare "authorized" or "permission" alone:
 * both are common in non-error application text ("user is authorized to
 * proceed", "permission granted", "user denied the permission request" —
 * that last one is application semantics about a permission *prompt*,
 * not an auth failure, and must NOT match here). Every message pattern
 * below requires the specific denial phrase as a unit ("not authorized",
 * "permission(s) denied", "access denied", "insufficient permission(s)"),
 * not just the presence of an auth-adjacent word.
 */

/** @typedef {import('../types.d.ts').Classifier} Classifier */

const KNOWN_STATUSES = new Set([401, 403]);
const KNOWN_NAMES = new Set(['UnauthorizedError', 'ForbiddenError', 'AuthError']);
const KNOWN_CODES = new Set(['EACCES', 'EPERM']);
const MESSAGE_RE =
  /\bunauthorized\b|\bforbidden\b|\bauthenticat|\bnot authorized\b|\bpermissions? denied\b|\baccess denied\b|\binsufficient permissions?\b/i;

/** @type {Classifier} */
export default {
  name: 'auth',
  match(err, _ctx) {
    if (KNOWN_STATUSES.has(err?.status) || KNOWN_STATUSES.has(err?.statusCode)) return 'auth';

    const name = err?.name;
    if (typeof name === 'string' && KNOWN_NAMES.has(name)) return 'auth';

    const code = err?.code;
    if (typeof code === 'string' && KNOWN_CODES.has(code)) return 'auth';

    const message = err?.message ?? '';
    if (typeof message === 'string' && MESSAGE_RE.test(message)) return 'auth';

    return null;
  },
};

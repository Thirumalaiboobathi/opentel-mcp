/**
 * @module fingerprint/classify/dependency
 *
 * Classifies failures surfaced by a known downstream datastore/service
 * client (Mongo, Postgres, MySQL, Redis, Elastic, ...) by error name.
 *
 * node_modules-origin detection from normalized stack frames is deferred
 * to the composer (Phase 5), which re-checks after stack normalization —
 * this classifier only has the raw error to go on.
 */

/** @typedef {import('../types.d.ts').Classifier} Classifier */

const KNOWN_NAMES = new Set(['MongoError', 'PostgresError', 'MySQLError', 'RedisError']);
const KNOWN_PREFIXES = ['Mongo', 'Postgres', 'MySQL', 'Redis', 'Elastic'];

/** @type {Classifier} */
export default {
  name: 'dependency',
  match(err, _ctx) {
    const name = err?.name;
    if (typeof name !== 'string') return null;

    if (KNOWN_NAMES.has(name)) return 'dependency';

    if (name.endsWith('Error') && KNOWN_PREFIXES.some((prefix) => name.startsWith(prefix))) {
      return 'dependency';
    }

    return null;
  },
};

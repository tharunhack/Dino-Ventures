import fp from 'fastify-plugin';
import pg from 'pg';

const { Pool, types } = pg;

// int8/bigint arrives as a JS string. Keep it that way: balances can exceed
// Number.MAX_SAFE_INTEGER and we do all arithmetic in BigInt. (This is pg's
// default, set explicitly so an upstream change cannot silently lose precision.)
types.setTypeParser(types.builtins.INT8, (value) => value);

// numeric likewise stays a string.
types.setTypeParser(types.builtins.NUMERIC, (value) => value);

/**
 * Exposes `fastify.db` — the pg Pool — and closes it on shutdown.
 */
const dbPlugin = async (fastify, options) => {
  const pool = new Pool({
    connectionString: options.connectionString,
    max: options.max,
    idleTimeoutMillis: options.idleTimeoutMillis,
    connectionTimeoutMillis: options.connectionTimeoutMillis,
    application_name: 'wallet-service',
  });

  // An idle client erroring out must not take the process down.
  pool.on('error', (err) => {
    fastify.log.error({ err }, 'idle postgres client error');
  });

  // Fail fast at boot if the database is unreachable or unmigrated.
  const probe = await pool.connect();
  try {
    const { rows } = await probe.query(
      `SELECT to_regclass('public.ledger_entries') IS NOT NULL AS migrated`,
    );
    if (!rows[0].migrated) {
      throw new Error(
        'database is reachable but not migrated — run `npm run db:setup`',
      );
    }
  } finally {
    probe.release();
  }

  fastify.decorate('db', pool);
  fastify.addHook('onClose', async () => {
    await pool.end();
  });
};

export default fp(dbPlugin, { name: 'db' });

/**
 * Health, reference data, and the reconciliation check that proves the ledger
 * and the cached balances agree.
 */
const systemRoutes = async (fastify) => {
  fastify.get(
    '/health',
    { schema: { summary: 'Liveness', tags: ['system'] } },
    async (_request, reply) => reply.send({ status: 'ok', uptime: process.uptime() }),
  );

  fastify.get(
    '/ready',
    { schema: { summary: 'Readiness (database round-trip)', tags: ['system'] } },
    async (_request, reply) => {
      await fastify.db.query('SELECT 1');
      return reply.send({ status: 'ready' });
    },
  );

  fastify.get(
    '/v1/assets',
    { schema: { summary: 'Configured asset types', tags: ['system'] } },
    async (_request, reply) => {
      const { rows } = await fastify.db.query(
        `SELECT code, name, scale, is_active FROM assets ORDER BY code`,
      );
      return reply.send({
        assets: rows.map((r) => ({
          code: r.code,
          name: r.name,
          scale: r.scale,
          isActive: r.is_active,
        })),
      });
    },
  );

  fastify.get(
    '/v1/admin/accounts/system',
    { schema: { summary: 'System account balances', tags: ['system'] } },
    async (_request, reply) => {
      const { rows } = await fastify.db.query(
        `SELECT acc.id, acc.name, ast.code AS asset, bal.balance, acc.allow_negative
           FROM accounts acc
           JOIN assets ast           ON ast.id = acc.asset_id
           JOIN account_balances bal ON bal.account_id = acc.id
          WHERE acc.kind = 'system'
          ORDER BY ast.code, acc.name`,
      );
      return reply.send({
        accounts: rows.map((r) => ({
          accountId: String(r.id),
          name: r.name,
          asset: r.asset,
          balance: r.balance,
          allowNegative: r.allow_negative,
        })),
      });
    },
  );

  /**
   * Two invariants, checked against live data:
   *
   *   1. no drift  — for every account, the cached balance equals the sum of
   *                  its ledger entries;
   *   2. zero sum  — across the whole system, every asset's entries net to
   *                  zero, i.e. no credits were conjured or destroyed.
   *
   * Returns 200 when both hold, 500 when either does not, so it can be wired
   * straight into monitoring.
   */
  fastify.get(
    '/v1/admin/reconcile',
    { schema: { summary: 'Ledger integrity check', tags: ['system'] } },
    async (_request, reply) => {
      const drift = await fastify.db.query(
        `SELECT b.account_id, acc.name, ast.code AS asset,
                b.balance AS cached, l.balance AS ledger
           FROM account_balances b
           JOIN ledger_balances l ON l.account_id = b.account_id
           JOIN accounts acc      ON acc.id = b.account_id
           JOIN assets ast        ON ast.id = b.asset_id
          WHERE b.balance <> l.balance`,
      );

      const sums = await fastify.db.query(
        `SELECT ast.code AS asset,
                COALESCE(SUM(e.amount), 0) AS net,
                COUNT(e.id)                AS entries
           FROM assets ast
           LEFT JOIN ledger_entries e ON e.asset_id = ast.id
          GROUP BY ast.code
          ORDER BY ast.code`,
      );

      const unbalanced = sums.rows.filter((r) => r.net !== '0');
      const healthy = drift.rowCount === 0 && unbalanced.length === 0;

      return reply.code(healthy ? 200 : 500).send({
        healthy,
        checkedAt: new Date().toISOString(),
        cacheDrift: drift.rows.map((r) => ({
          accountId: String(r.account_id),
          account: r.name,
          asset: r.asset,
          cachedBalance: r.cached,
          ledgerBalance: r.ledger,
        })),
        assetTotals: sums.rows.map((r) => ({
          asset: r.asset,
          netAcrossAllAccounts: r.net,
          entryCount: r.entries,
          balanced: r.net === '0',
        })),
      });
    },
  );
};

export default systemRoutes;

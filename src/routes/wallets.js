import { errors } from '../lib/errors.js';
import { getBalancesSchema, getStatementSchema } from '../schemas/transactions.js';

/**
 * Read-only wallet endpoints. These never take row locks — they read the
 * cached balance, which is written only inside the same transaction as the
 * entries that moved it and therefore cannot be stale-by-drift, only
 * stale-by-a-few-milliseconds.
 */
const walletRoutes = async (fastify) => {
  fastify.get(
    '/users/:userId/wallets',
    { schema: getBalancesSchema },
    async (request, reply) => {
      const { userId } = request.params;

      const user = await fastify.db.query(
        `SELECT id, display_name, status FROM users WHERE id = $1`,
        [userId],
      );
      if (!user.rows[0]) throw errors.userNotFound(userId);

      const { rows } = await fastify.db.query(
        `SELECT acc.id          AS account_id,
                ast.code        AS asset,
                ast.name        AS asset_name,
                ast.scale,
                bal.balance,
                bal.version,
                bal.updated_at
           FROM accounts acc
           JOIN assets ast           ON ast.id = acc.asset_id
           JOIN account_balances bal ON bal.account_id = acc.id
          WHERE acc.kind = 'user' AND acc.owner_id = $1
          ORDER BY ast.code`,
        [userId],
      );

      return reply.send({
        userId: user.rows[0].id,
        displayName: user.rows[0].display_name,
        status: user.rows[0].status,
        wallets: rows.map((r) => ({
          accountId: String(r.account_id),
          asset: r.asset,
          assetName: r.asset_name,
          scale: r.scale,
          balance: r.balance,
          version: r.version,
          updatedAt: r.updated_at.toISOString(),
        })),
      });
    },
  );

  fastify.get(
    '/users/:userId/wallets/:asset/statement',
    { schema: getStatementSchema },
    async (request, reply) => {
      const { userId, asset } = request.params;
      const { before } = request.query;
      const limit = Math.min(Number(request.query.limit ?? 50), 200);

      const account = await fastify.db.query(
        `SELECT acc.id, bal.balance
           FROM accounts acc
           JOIN assets ast           ON ast.id = acc.asset_id
           JOIN account_balances bal ON bal.account_id = acc.id
          WHERE acc.kind = 'user' AND acc.owner_id = $1 AND ast.code = $2`,
        [userId, asset],
      );
      if (!account.rows[0]) {
        throw errors.accountNotFound(`${asset} wallet for user ${userId}`);
      }

      const accountId = account.rows[0].id;

      // Fetch one extra row to decide whether another page exists.
      const { rows } = await fastify.db.query(
        `SELECT e.id, e.transaction_id, e.amount, e.balance_after, e.created_at,
                t.kind, t.reference, t.metadata
           FROM ledger_entries e
           JOIN transactions t ON t.id = e.transaction_id
          WHERE e.account_id = $1
            AND ($2::bigint IS NULL OR e.id < $2::bigint)
          ORDER BY e.id DESC
          LIMIT $3`,
        [accountId, before ?? null, limit + 1],
      );

      const page = rows.slice(0, limit);

      return reply.send({
        accountId: String(accountId),
        asset,
        balance: account.rows[0].balance,
        entries: page.map((r) => ({
          entryId: String(r.id),
          transactionId: r.transaction_id,
          kind: r.kind,
          amount: r.amount,
          balanceAfter: r.balance_after,
          reference: r.reference,
          metadata: r.metadata,
          createdAt: r.created_at.toISOString(),
        })),
        nextBefore: rows.length > limit ? String(page.at(-1).id) : null,
      });
    },
  );
};

export default walletRoutes;

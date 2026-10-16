import { withRetryableTransaction } from '../lib/tx.js';
import { withIdempotency } from '../lib/idempotency.js';
import {
  findAsset,
  findUser,
  findSystemAccount,
  findOrCreateWallet,
  postTransaction,
} from '../lib/ledger.js';
import { errors } from '../lib/errors.js';
import {
  topupSchema,
  bonusSchema,
  spendSchema,
  getTransactionSchema,
} from '../schemas/transactions.js';

const toBigInt = (value) => BigInt(value);

/**
 * The three write flows differ only in which accounts move and what the
 * transaction is called, so they share one pipeline:
 *
 *   retryable transaction
 *     └─ idempotency claim  (first lock)
 *         └─ resolve asset / user / accounts
 *             └─ postTransaction  (locks balances in ascending id order)
 *
 * `plan` returns { kind, wallet, counterparty, direction, reference }.
 */
const executeWrite = async (fastify, request, reply, { endpoint, plan }) => {
  const key = request.headers['idempotency-key'];
  const body = request.body;
  const { config } = fastify;

  const result = await withRetryableTransaction(
    fastify.db,
    async (client) =>
      withIdempotency(
        client,
        { key, endpoint, payload: body },
        async () => {
          const asset = await findAsset(client, body.asset);
          const user = await findUser(client, body.userId);

          if (user.status !== 'active') throw errors.userNotActive(user.status);

          const amount = toBigInt(body.amount);
          const wallet = await findOrCreateWallet(client, user, asset);

          const { kind, systemAccountName, direction, reference, metadata } =
            plan(body);

          const systemAccount = await findSystemAccount(
            client,
            asset.id,
            systemAccountName,
          );

          // direction 'credit' moves credits into the wallet, 'debit' out of it.
          const walletDelta = direction === 'credit' ? amount : -amount;

          const posted = await postTransaction(client, {
            kind,
            asset,
            amount,
            reference,
            metadata: { ...(body.metadata ?? {}), ...metadata },
            insufficientFundsAccountId:
              direction === 'debit' ? wallet.id : systemAccount.id,
            legs: [
              { accountId: wallet.id, amount: walletDelta },
              { accountId: systemAccount.id, amount: -walletDelta },
            ],
          });

          const byAccount = new Map(
            posted.balances.map((b) => [b.accountId, b.balance]),
          );

          return {
            statusCode: 201,
            transactionId: posted.transaction.id,
            body: {
              transactionId: posted.transaction.id,
              kind: posted.transaction.kind,
              asset: asset.code,
              amount: amount.toString(),
              reference: posted.transaction.reference,
              userId: user.id,
              walletBalance: byAccount.get(String(wallet.id)),
              entries: [
                {
                  accountId: String(wallet.id),
                  accountName: 'wallet',
                  accountKind: 'user',
                  amount: walletDelta.toString(),
                  balanceAfter: byAccount.get(String(wallet.id)),
                },
                {
                  accountId: String(systemAccount.id),
                  accountName: systemAccount.name,
                  accountKind: 'system',
                  amount: (-walletDelta).toString(),
                  balanceAfter: byAccount.get(String(systemAccount.id)),
                },
              ],
              createdAt: posted.transaction.created_at.toISOString(),
            },
          };
        },
      ),
    {
      ...config.retry,
      lockTimeoutMs: config.db.lockTimeoutMs,
      statementTimeoutMs: config.db.statementTimeoutMs,
      logger: request.log,
    },
  );

  const { __statusCode: statusCode, ...payload } = result;
  // A replay reports 200: the original creation already returned 201.
  return reply.code(payload.replayed ? 200 : statusCode).send(payload);
};

const transactionRoutes = async (fastify) => {
  // 1. Wallet top-up — a real-money purchase has already settled upstream, so
  //    credits flow out of TREASURY into the user's wallet.
  fastify.post('/topup', { schema: topupSchema }, (request, reply) =>
    executeWrite(fastify, request, reply, {
      endpoint: 'POST /v1/transactions/topup',
      plan: (body) => ({
        kind: 'topup',
        systemAccountName: 'TREASURY',
        direction: 'credit',
        reference: body.paymentReference,
        metadata: { paymentReference: body.paymentReference },
      }),
    }),
  );

  // 2. Bonus / incentive — free credits, sourced from PROMO so that granted
  //    credits are never confused with purchased ones in reporting.
  fastify.post('/bonus', { schema: bonusSchema }, (request, reply) =>
    executeWrite(fastify, request, reply, {
      endpoint: 'POST /v1/transactions/bonus',
      plan: (body) => ({
        kind: 'bonus',
        systemAccountName: 'PROMO',
        direction: 'credit',
        reference: body.campaignId ?? body.reason,
        metadata: { reason: body.reason, campaignId: body.campaignId ?? null },
      }),
    }),
  );

  // 3. Spend — credits leave the wallet and land in REVENUE. This is the only
  //    flow that can fail on insufficient funds.
  fastify.post('/spend', { schema: spendSchema }, (request, reply) =>
    executeWrite(fastify, request, reply, {
      endpoint: 'POST /v1/transactions/spend',
      plan: (body) => ({
        kind: 'spend',
        systemAccountName: 'REVENUE',
        direction: 'debit',
        reference: body.orderReference,
        metadata: { orderReference: body.orderReference },
      }),
    }),
  );

  fastify.get(
    '/:transactionId',
    { schema: getTransactionSchema },
    async (request, reply) => {
      const { transactionId } = request.params;

      const { rows } = await fastify.db.query(
        `SELECT t.id, t.kind, t.amount, t.reference, t.metadata, t.created_at,
                a.code AS asset,
                e.account_id, e.amount AS entry_amount, e.balance_after,
                acc.kind AS account_kind, acc.name AS account_name,
                acc.owner_id
           FROM transactions t
           JOIN assets a ON a.id = t.asset_id
           JOIN ledger_entries e ON e.transaction_id = t.id
           JOIN accounts acc ON acc.id = e.account_id
          WHERE t.id = $1
          ORDER BY e.id`,
        [transactionId],
      );

      if (rows.length === 0) throw errors.transactionNotFound(transactionId);

      const head = rows[0];
      const walletRow = rows.find((r) => r.account_kind === 'user');

      return reply.send({
        transactionId: head.id,
        kind: head.kind,
        asset: head.asset,
        amount: head.amount,
        reference: head.reference,
        userId: walletRow?.owner_id ?? undefined,
        walletBalance: walletRow?.balance_after ?? undefined,
        entries: rows.map((r) => ({
          accountId: String(r.account_id),
          accountName: r.account_kind === 'user' ? 'wallet' : r.account_name,
          accountKind: r.account_kind,
          amount: r.entry_amount,
          balanceAfter: r.balance_after,
        })),
        createdAt: head.created_at.toISOString(),
      });
    },
  );
};

export default transactionRoutes;

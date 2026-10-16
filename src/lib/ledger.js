import { errors } from './errors.js';

/**
 * The ledger core. Every balance change in the system goes through
 * `postTransaction`; nothing else writes account_balances or ledger_entries.
 *
 * DEADLOCK AVOIDANCE
 * ------------------
 * A deadlock needs two transactions to acquire the same locks in opposite
 * orders. We make that impossible by giving every transaction one global lock
 * order and never deviating from it:
 *
 *   1. the idempotency_keys row (one per request, taken first)
 *   2. account_balances rows, strictly ascending by account_id
 *
 * Locks are taken one row at a time in that order rather than in a single
 * multi-row `FOR UPDATE`, because a multi-row statement's locking order
 * follows the query plan, which Postgres is free to change.
 */

// --------------------------------------------------------------------------
// Lookups
// --------------------------------------------------------------------------

export const findAsset = async (client, code) => {
  const { rows } = await client.query(
    `SELECT id, code, name, scale FROM assets WHERE code = $1 AND is_active`,
    [code],
  );
  if (!rows[0]) throw errors.assetNotFound(code);
  return rows[0];
};

export const findUser = async (client, userId) => {
  const { rows } = await client.query(
    `SELECT id, external_ref, display_name, status FROM users WHERE id = $1`,
    [userId],
  );
  if (!rows[0]) throw errors.userNotFound(userId);
  return rows[0];
};

export const findSystemAccount = async (client, assetId, name) => {
  const { rows } = await client.query(
    `SELECT id, name, allow_negative
       FROM accounts
      WHERE kind = 'system' AND asset_id = $1 AND name = $2`,
    [assetId, name],
  );
  if (!rows[0]) {
    throw errors.accountNotFound(`system account ${name} for asset ${assetId}`);
  }
  return rows[0];
};

/**
 * A user's wallet for an asset, provisioned on first use. Provisioning happens
 * before any balance row is locked, so it cannot extend a lock-holding window.
 * The matching account_balances row is created by a trigger on `accounts`.
 */
export const findOrCreateWallet = async (client, user, asset) => {
  const select = `SELECT id, allow_negative
                    FROM accounts
                   WHERE kind = 'user' AND owner_id = $1 AND asset_id = $2`;

  const existing = await client.query(select, [user.id, asset.id]);
  if (existing.rows[0]) return existing.rows[0];

  const created = await client.query(
    `INSERT INTO accounts (asset_id, kind, owner_id, name)
     VALUES ($1, 'user', $2, $3)
     ON CONFLICT DO NOTHING
     RETURNING id, allow_negative`,
    [asset.id, user.id, `${user.display_name} · ${asset.code}`],
  );

  // A concurrent request may have won the insert; re-read in that case.
  return (
    created.rows[0] ?? (await client.query(select, [user.id, asset.id])).rows[0]
  );
};

// --------------------------------------------------------------------------
// Locking
// --------------------------------------------------------------------------

/**
 * Lock the given accounts' balance rows in ascending id order and return their
 * current balances as BigInt, keyed by account id.
 */
export const lockBalances = async (client, accountIds) => {
  const ordered = [...new Set(accountIds.map(String))].sort(
    (a, b) => (BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0),
  );

  const balances = new Map();

  for (const accountId of ordered) {
    const { rows } = await client.query(
      `SELECT account_id, balance, allow_negative
         FROM account_balances
        WHERE account_id = $1
          FOR UPDATE`,
      [accountId],
    );
    if (!rows[0]) throw errors.accountNotFound(`balance row for account ${accountId}`);

    balances.set(String(rows[0].account_id), {
      balance: BigInt(rows[0].balance),
      allowNegative: rows[0].allow_negative,
    });
  }

  return balances;
};

// --------------------------------------------------------------------------
// Posting
// --------------------------------------------------------------------------

/**
 * Post a balanced set of ledger entries.
 *
 * @param client   a pg client already inside a transaction
 * @param spec.legs  [{ accountId, amount }] with signed BigInt amounts that
 *                   must sum to 0n. Positive credits, negative debits.
 * @param spec.insufficientFundsAccountId  which leg to blame in the 422 when
 *                   an overdraft is rejected (the spender, not the treasury).
 */
export const postTransaction = async (client, spec) => {
  const {
    kind,
    asset,
    amount,
    legs,
    reference = null,
    metadata = {},
    insufficientFundsAccountId = null,
  } = spec;

  if (legs.length < 2) {
    throw new Error('postTransaction requires at least two legs');
  }

  const net = legs.reduce((sum, leg) => sum + leg.amount, 0n);
  if (net !== 0n) {
    throw new Error(`postTransaction legs do not balance: net ${net}`);
  }

  const balances = await lockBalances(
    client,
    legs.map((leg) => leg.accountId),
  );

  // Net each account's movement first, so a transaction touching the same
  // account twice is validated against its final balance.
  const movements = new Map();
  for (const leg of legs) {
    const id = String(leg.accountId);
    movements.set(id, (movements.get(id) ?? 0n) + leg.amount);
  }

  const applied = new Map();
  for (const [accountId, delta] of movements) {
    const current = balances.get(accountId);
    const next = current.balance + delta;

    if (next < 0n && !current.allowNegative) {
      if (accountId === String(insufficientFundsAccountId)) {
        throw errors.insufficientFunds({
          accountId,
          asset: asset.code,
          balance: current.balance.toString(),
          requested: (-delta).toString(),
          shortfall: (-next).toString(),
        });
      }
      throw errors.insufficientFunds({
        accountId,
        asset: asset.code,
        balance: current.balance.toString(),
        shortfall: (-next).toString(),
      });
    }

    applied.set(accountId, next);
  }

  const { rows: txRows } = await client.query(
    `INSERT INTO transactions (kind, asset_id, amount, reference, metadata)
     VALUES ($1, $2, $3, $4, $5::jsonb)
     RETURNING id, kind, amount, reference, metadata, created_at`,
    [kind, asset.id, amount.toString(), reference, JSON.stringify(metadata)],
  );
  const transaction = txRows[0];

  // Write the new balances in the same ascending order the locks were taken.
  for (const accountId of [...applied.keys()].sort((a, b) =>
    BigInt(a) < BigInt(b) ? -1 : 1,
  )) {
    await client.query(
      `UPDATE account_balances
          SET balance = $2, version = version + 1, updated_at = now()
        WHERE account_id = $1`,
      [accountId, applied.get(accountId).toString()],
    );
  }

  // One multi-row INSERT, so the deferred balance trigger sees a complete,
  // balanced transaction at COMMIT. `balance_after` is known up front from the
  // locked balances — the ledger is append-only, so it cannot be patched later.
  const values = legs
    .map((_, i) => `($1, $${i * 4 + 2}, $${i * 4 + 3}, $${i * 4 + 4}, $${i * 4 + 5})`)
    .join(', ');

  const params = [transaction.id];
  for (const leg of legs) {
    params.push(
      String(leg.accountId),
      asset.id,
      leg.amount.toString(),
      applied.get(String(leg.accountId)).toString(),
    );
  }

  await client.query(
    `INSERT INTO ledger_entries
       (transaction_id, account_id, asset_id, amount, balance_after)
     VALUES ${values}`,
    params,
  );

  return {
    transaction,
    balances: [...applied.entries()].map(([accountId, balance]) => ({
      accountId,
      balance: balance.toString(),
    })),
  };
};

export default postTransaction;

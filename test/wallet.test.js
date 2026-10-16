/**
 * Integration tests. They run against a real, migrated Postgres — the
 * guarantees under test are database guarantees, so mocking the database would
 * test nothing worth testing.
 *
 *   DATABASE_URL=postgres://wallet:wallet@localhost:5432/wallet npm test
 *
 * Each test provisions its own user, so runs do not interfere with each other
 * or with the seed data.
 */
import test, { before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import { buildApp } from '../src/app.js';

let app;

before(async () => {
  app = await buildApp({ logLevel: 'silent', prettyLogs: false });
  await app.ready();
});

after(async () => {
  await app?.close();
});

// --------------------------------------------------------------------------
// helpers
// --------------------------------------------------------------------------

const makeUser = async () => {
  const id = randomUUID();
  await app.db.query(
    `INSERT INTO users (id, external_ref, display_name) VALUES ($1, $2, $3)`,
    [id, `test-${id}`, `Test ${id.slice(0, 8)}`],
  );
  return id;
};

const key = () => `test-${randomUUID()}`;

const call = (path, body, idempotencyKey = key()) =>
  app.inject({
    method: 'POST',
    url: path,
    headers: { 'idempotency-key': idempotencyKey },
    payload: body,
  });

const topup = (userId, amount, extra = {}, k) =>
  call('/v1/transactions/topup',
    { userId, asset: 'GOLD', amount, paymentReference: `pay-${randomUUID()}`, ...extra }, k);

const bonus = (userId, amount, extra = {}, k) =>
  call('/v1/transactions/bonus',
    { userId, asset: 'GOLD', amount, reason: 'referral', ...extra }, k);

const spend = (userId, amount, extra = {}, k) =>
  call('/v1/transactions/spend',
    { userId, asset: 'GOLD', amount, orderReference: `order-${randomUUID()}`, ...extra }, k);

const balance = async (userId, asset = 'GOLD') => {
  const res = await app.inject({ method: 'GET', url: `/v1/users/${userId}/wallets` });
  const wallet = res.json().wallets.find((w) => w.asset === asset);
  return wallet ? BigInt(wallet.balance) : 0n;
};

// --------------------------------------------------------------------------

describe('seed data', () => {
  test('asset types, system accounts and users are present', async () => {
    const assets = await app.inject({ method: 'GET', url: '/v1/assets' });
    const codes = assets.json().assets.map((a) => a.code);
    assert.ok(codes.includes('GOLD'), 'GOLD asset is seeded');
    assert.ok(codes.includes('DIAMOND'));
    assert.ok(codes.includes('LOYALTY'));

    const system = await app.inject({ method: 'GET', url: '/v1/admin/accounts/system' });
    const names = new Set(system.json().accounts.map((a) => a.name));
    assert.deepEqual([...names].sort(), ['PROMO', 'REVENUE', 'TREASURY']);

    const alice = await app.inject({
      method: 'GET',
      url: '/v1/users/11111111-1111-4111-8111-111111111111/wallets',
    });
    assert.equal(alice.statusCode, 200);
    assert.ok(alice.json().wallets.length >= 3);
  });
});

describe('the three core flows', () => {
  test('earn 100 then spend 30 leaves exactly 70', async () => {
    const user = await makeUser();

    const earned = await bonus(user, 100, { reason: 'achievement' });
    assert.equal(earned.statusCode, 201);
    assert.equal(earned.json().walletBalance, '100');

    const spent = await spend(user, 30);
    assert.equal(spent.statusCode, 201);
    assert.equal(spent.json().walletBalance, '70');

    assert.equal(await balance(user), 70n);
  });

  test('top-up credits the wallet and debits TREASURY', async () => {
    const user = await makeUser();
    const res = await topup(user, 250);

    assert.equal(res.statusCode, 201);
    const body = res.json();
    assert.equal(body.kind, 'topup');
    assert.equal(body.walletBalance, '250');

    const system = body.entries.find((e) => e.accountKind === 'system');
    assert.equal(system.accountName, 'TREASURY');
    assert.equal(system.amount, '-250');
  });

  test('bonus credits the wallet and debits PROMO', async () => {
    const user = await makeUser();
    const res = await bonus(user, 40, { campaignId: 'welcome-2026' });

    assert.equal(res.statusCode, 201);
    const system = res.json().entries.find((e) => e.accountKind === 'system');
    assert.equal(system.accountName, 'PROMO');
    assert.equal(res.json().reference, 'welcome-2026');
  });

  test('spend debits the wallet and credits REVENUE', async () => {
    const user = await makeUser();
    await topup(user, 100);
    const res = await spend(user, 60);

    const system = res.json().entries.find((e) => e.accountKind === 'system');
    assert.equal(system.accountName, 'REVENUE');
    assert.equal(system.amount, '60');
    assert.equal(res.json().walletBalance, '40');
  });

  test('every transaction writes exactly two balanced ledger entries', async () => {
    const user = await makeUser();
    const res = await topup(user, 10);
    const txId = res.json().transactionId;

    const { rows } = await app.db.query(
      `SELECT amount FROM ledger_entries WHERE transaction_id = $1`,
      [txId],
    );
    assert.equal(rows.length, 2);
    assert.equal(rows.reduce((sum, r) => sum + BigInt(r.amount), 0n), 0n);
  });
});

describe('balance protection', () => {
  test('a spend beyond the balance is rejected with 422 and changes nothing', async () => {
    const user = await makeUser();
    await topup(user, 50);

    const res = await spend(user, 51);
    assert.equal(res.statusCode, 422);
    assert.equal(res.json().error.code, 'INSUFFICIENT_FUNDS');
    assert.equal(res.json().error.details.shortfall, '1');

    assert.equal(await balance(user), 50n, 'balance is untouched by the failed spend');
  });

  test('spending the exact balance is allowed', async () => {
    const user = await makeUser();
    await topup(user, 77);

    const res = await spend(user, 77);
    assert.equal(res.statusCode, 201);
    assert.equal(await balance(user), 0n);
  });

  test('the database refuses a negative balance even if logic were bypassed', async () => {
    const user = await makeUser();
    await topup(user, 5);
    const { rows } = await app.db.query(
      `SELECT acc.id FROM accounts acc JOIN assets a ON a.id = acc.asset_id
        WHERE acc.owner_id = $1 AND a.code = 'GOLD'`,
      [user],
    );

    await assert.rejects(
      () =>
        app.db.query(`UPDATE account_balances SET balance = -1 WHERE account_id = $1`, [
          rows[0].id,
        ]),
      (err) => err.code === '23514',
      'CHECK constraint blocks a negative user balance',
    );
  });
});

describe('idempotency', () => {
  test('replaying a key returns the original transaction and does not double-post', async () => {
    const user = await makeUser();
    const k = key();

    const first = await topup(user, 100, { paymentReference: 'pay-fixed' }, k);
    const second = await topup(user, 100, { paymentReference: 'pay-fixed' }, k);

    assert.equal(first.statusCode, 201);
    assert.equal(first.json().replayed, false);

    assert.equal(second.statusCode, 200);
    assert.equal(second.json().replayed, true);
    assert.equal(second.json().transactionId, first.json().transactionId);

    assert.equal(await balance(user), 100n, 'credited once, not twice');
  });

  test('reusing a key with a different body is a 409', async () => {
    const user = await makeUser();
    const k = key();

    await topup(user, 100, { paymentReference: 'pay-fixed' }, k);
    const res = await topup(user, 500, { paymentReference: 'pay-fixed' }, k);

    assert.equal(res.statusCode, 409);
    assert.equal(res.json().error.code, 'IDEMPOTENCY_KEY_REUSE');
    assert.equal(await balance(user), 100n);
  });

  test('key order within the body does not affect the fingerprint', async () => {
    const user = await makeUser();
    const k = key();

    const first = await call('/v1/transactions/topup',
      { userId: user, asset: 'GOLD', amount: 10, paymentReference: 'p1' }, k);
    const second = await call('/v1/transactions/topup',
      { paymentReference: 'p1', amount: 10, asset: 'GOLD', userId: user }, k);

    assert.equal(second.statusCode, 200);
    assert.equal(second.json().transactionId, first.json().transactionId);
  });

  test('a missing Idempotency-Key is rejected before any write', async () => {
    const user = await makeUser();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/transactions/topup',
      payload: { userId: user, asset: 'GOLD', amount: 10, paymentReference: 'p' },
    });

    assert.equal(res.statusCode, 400);
    assert.equal(res.json().error.code, 'VALIDATION_ERROR');
    assert.equal(await balance(user), 0n);
  });
});

describe('concurrency', () => {
  test('40 concurrent spends against funds for 20 settle at exactly 20', async () => {
    const user = await makeUser();
    await topup(user, 20);

    const results = await Promise.all(
      Array.from({ length: 40 }, () => spend(user, 1)),
    );

    const ok = results.filter((r) => r.statusCode === 201).length;
    const rejected = results.filter((r) => r.statusCode === 422).length;

    assert.equal(ok, 20, 'exactly the funded number of spends succeeded');
    assert.equal(rejected, 20, 'the rest were cleanly rejected');
    assert.equal(await balance(user), 0n, 'no overdraft, no stranded credits');
  });

  test('a retry storm on one key posts exactly one transaction', async () => {
    const user = await makeUser();
    const k = key();

    const results = await Promise.all(
      Array.from({ length: 30 }, () =>
        topup(user, 100, { paymentReference: 'storm' }, k),
      ),
    );

    const created = results.filter((r) => r.statusCode === 201);
    const replayed = results.filter((r) => r.statusCode === 200);

    assert.equal(created.length, 1, 'one and only one creation');
    assert.equal(replayed.length, 29);
    assert.equal(
      new Set(results.map((r) => r.json().transactionId)).size,
      1,
      'all responses name the same transaction',
    );
    assert.equal(await balance(user), 100n);
  });

  test('interleaved credits and debits on two wallets do not deadlock', async () => {
    const [left, right] = await Promise.all([makeUser(), makeUser()]);
    await Promise.all([topup(left, 100), topup(right, 100)]);

    const jobs = Array.from({ length: 80 }, (_, i) => {
      const user = i % 2 === 0 ? left : right;
      return i % 4 < 2 ? spend(user, 1) : topup(user, 1);
    });

    const results = await Promise.all(jobs);
    const serverErrors = results.filter((r) => r.statusCode >= 500);

    assert.equal(serverErrors.length, 0,
      `expected no 5xx, got ${JSON.stringify(serverErrors.map((r) => r.json()))}`);
  });
});

describe('ledger integrity', () => {
  test('ledger entries cannot be updated or deleted', async () => {
    const user = await makeUser();
    const res = await topup(user, 15);
    const txId = res.json().transactionId;

    await assert.rejects(
      () => app.db.query(`UPDATE ledger_entries SET amount = 1 WHERE transaction_id = $1`, [txId]),
      (err) => err.code === '2F003' || /append-only/.test(err.message),
    );
    await assert.rejects(
      () => app.db.query(`DELETE FROM ledger_entries WHERE transaction_id = $1`, [txId]),
      (err) => err.code === '2F003' || /append-only/.test(err.message),
    );
  });

  test('an unbalanced transaction is rejected at commit', async () => {
    const user = await makeUser();
    await topup(user, 1);

    const client = await app.db.connect();
    try {
      await client.query('BEGIN');
      const { rows: acct } = await client.query(
        `SELECT acc.id, acc.asset_id FROM accounts acc
           JOIN assets a ON a.id = acc.asset_id
          WHERE acc.owner_id = $1 AND a.code = 'GOLD'`,
        [user],
      );
      const { rows: tx } = await client.query(
        `INSERT INTO transactions (kind, asset_id, amount)
         VALUES ('adjustment', $1, 10) RETURNING id`,
        [acct[0].asset_id],
      );

      // A single leg: credits out of nowhere. The deferred trigger must stop it.
      await client.query(
        `INSERT INTO ledger_entries (transaction_id, account_id, asset_id, amount, balance_after)
         VALUES ($1, $2, $3, 10, 10)`,
        [tx[0].id, acct[0].id, acct[0].asset_id],
      );

      await assert.rejects(
        () => client.query('COMMIT'),
        (err) => /double-entry|does not balance/.test(err.message),
        'commit is refused for a one-legged transaction',
      );
    } finally {
      await client.query('ROLLBACK').catch(() => {});
      client.release();
    }
  });

  test('reconciliation reports no drift and a zero sum per asset', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/admin/reconcile' });

    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.healthy, true);
    assert.deepEqual(body.cacheDrift, []);
    assert.ok(body.assetTotals.every((t) => t.balanced && t.netAcrossAllAccounts === '0'));
  });
});

describe('lookups and errors', () => {
  test('a transaction can be fetched back with its entries', async () => {
    const user = await makeUser();
    const created = await topup(user, 33);
    const txId = created.json().transactionId;

    const res = await app.inject({ method: 'GET', url: `/v1/transactions/${txId}` });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().transactionId, txId);
    assert.equal(res.json().entries.length, 2);
  });

  test('the statement lists entries newest first with running balances', async () => {
    const user = await makeUser();
    await topup(user, 100);
    await spend(user, 30);

    const res = await app.inject({
      method: 'GET',
      url: `/v1/users/${user}/wallets/GOLD/statement?limit=10`,
    });

    const { entries, balance: bal } = res.json();
    assert.equal(bal, '70');
    assert.equal(entries[0].kind, 'spend');
    assert.equal(entries[0].balanceAfter, '70');
    assert.equal(entries[1].kind, 'topup');
    assert.equal(entries[1].balanceAfter, '100');
  });

  test('unknown user, asset and transaction all return 404', async () => {
    const ghost = randomUUID();

    const user = await app.inject({ method: 'GET', url: `/v1/users/${ghost}/wallets` });
    assert.equal(user.statusCode, 404);
    assert.equal(user.json().error.code, 'USER_NOT_FOUND');

    const asset = await call('/v1/transactions/topup', {
      userId: '11111111-1111-4111-8111-111111111111',
      asset: 'NOPE',
      amount: 1,
      paymentReference: 'p',
    });
    assert.equal(asset.statusCode, 404);
    assert.equal(asset.json().error.code, 'ASSET_NOT_FOUND');

    const tx = await app.inject({ method: 'GET', url: `/v1/transactions/${ghost}` });
    assert.equal(tx.statusCode, 404);
  });

  test('malformed amounts are rejected by the schema', async () => {
    const user = await makeUser();

    for (const amount of [0, -5, 1.5, 'abc', '0']) {
      const res = await topup(user, amount);
      assert.equal(res.statusCode, 400, `amount ${JSON.stringify(amount)} must be rejected`);
    }
    assert.equal(await balance(user), 0n);
  });

  test('amounts beyond IEEE-754 safe range survive as digit strings', async () => {
    const user = await makeUser();
    const huge = '9007199254740993'; // 2^53 + 1

    const res = await topup(user, huge);
    assert.equal(res.statusCode, 201);
    assert.equal(res.json().walletBalance, huge);
  });
});

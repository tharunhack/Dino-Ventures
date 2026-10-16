#!/usr/bin/env node
/**
 * Concurrency harness — proves the two hard requirements against a running
 * service rather than asserting them in prose.
 *
 *   BASE_URL=http://localhost:3000 node scripts/load-test.js
 *
 * Scenario 1  Oversell:  N concurrent spends against a wallet funded for
 *             exactly N/2 of them. Expect exactly N/2 successes, N/2 rejections,
 *             final balance 0, and no negative balance at any point.
 * Scenario 2  Retry storm: N concurrent requests sharing ONE Idempotency-Key.
 *             Expect exactly one posted transaction and N-1 replays of it.
 * Scenario 3  Deadlock bait: credits and debits interleaved across two wallets
 *             in opposing orders. Expect zero deadlock-driven failures.
 *
 * Exits non-zero if any invariant is violated.
 */

const BASE_URL = process.env.BASE_URL ?? 'http://127.0.0.1:3000';
const CONCURRENCY = Number(process.env.CONCURRENCY ?? 120);

const USERS = {
  alice: '11111111-1111-4111-8111-111111111111',
  bob: '22222222-2222-4222-8222-222222222222',
};

const uid = () =>
  `lt-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

const post = async (path, body, idempotencyKey) => {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'idempotency-key': idempotencyKey,
    },
    body: JSON.stringify(body),
  });
  // Carry the request along so a shed response can be replayed verbatim.
  return {
    status: res.status,
    body: await res.json(),
    request: { path, body, key: idempotencyKey },
  };
};

const get = async (path) => {
  const res = await fetch(`${BASE_URL}${path}`);
  return { status: res.status, body: await res.json() };
};

const balanceOf = async (userId, asset) => {
  const { body } = await get(`/v1/users/${userId}/wallets`);
  return BigInt(body.wallets.find((w) => w.asset === asset).balance);
};

const failures = [];
const check = (label, condition, detail) => {
  if (condition) {
    console.log(`  PASS  ${label}`);
  } else {
    console.log(`  FAIL  ${label} — ${detail}`);
    failures.push(label);
  }
};

const drain = async (userId, asset) => {
  const balance = await balanceOf(userId, asset);
  if (balance === 0n) return;
  await post(
    '/v1/transactions/spend',
    {
      userId,
      asset,
      amount: balance.toString(),
      orderReference: 'loadtest-drain',
    },
    uid(),
  );
};

// --------------------------------------------------------------------------

const scenarioOversell = async () => {
  const asset = 'GOLD';
  const user = USERS.alice;
  const spendUnit = 1;
  const funded = Math.floor(CONCURRENCY / 2);

  console.log(`\n[1] Oversell — ${CONCURRENCY} concurrent spends, funded for ${funded}`);

  await drain(user, asset);
  await post(
    '/v1/transactions/topup',
    { userId: user, asset, amount: funded, paymentReference: uid() },
    uid(),
  );

  const started = Date.now();
  const results = await Promise.all(
    Array.from({ length: CONCURRENCY }, () =>
      post(
        '/v1/transactions/spend',
        { userId: user, asset, amount: spendUnit, orderReference: uid() },
        uid(),
      ),
    ),
  );
  const elapsed = Date.now() - started;

  const ok = results.filter((r) => r.status === 201).length;
  const rejected = results.filter(
    (r) => r.status === 422 && r.body.error?.code === 'INSUFFICIENT_FUNDS',
  ).length;
  const other = results.filter((r) => r.status !== 201 && r.status !== 422);

  const final = await balanceOf(user, asset);

  console.log(
    `  ${ok} succeeded, ${rejected} rejected, ${other.length} unexpected, ${elapsed}ms ` +
      `(${Math.round((CONCURRENCY / elapsed) * 1000)} req/s)`,
  );

  check('exactly the funded number of spends succeeded', ok === funded, `got ${ok}, want ${funded}`);
  check('every other request was a clean 422', rejected === CONCURRENCY - funded,
    `got ${rejected}, want ${CONCURRENCY - funded}`);
  check('no unexpected status codes', other.length === 0,
    JSON.stringify(other.slice(0, 3)));
  check('final balance is exactly zero', final === 0n, `balance ${final}`);
};

const scenarioRetryStorm = async () => {
  const asset = 'GOLD';
  const user = USERS.bob;
  const amount = 500;
  const sharedKey = uid();

  console.log(`\n[2] Retry storm — ${CONCURRENCY} concurrent requests, one shared key`);

  const before = await balanceOf(user, asset);

  const results = await Promise.all(
    Array.from({ length: CONCURRENCY }, () =>
      post(
        '/v1/transactions/topup',
        { userId: user, asset, amount, paymentReference: 'retry-storm' },
        sharedKey,
      ),
    ),
  );

  const after = await balanceOf(user, asset);

  const created = results.filter((r) => r.status === 201);
  const replayed = results.filter((r) => r.status === 200 && r.body.replayed === true);
  const inProgress = results.filter((r) => r.body.error?.code === 'REQUEST_IN_PROGRESS');
  const ids = new Set(
    results.filter((r) => r.body.transactionId).map((r) => r.body.transactionId),
  );

  console.log(
    `  ${created.length} created, ${replayed.length} replayed, ` +
      `${inProgress.length} in-progress, ${ids.size} distinct transaction id(s)`,
  );

  check('exactly one transaction was created', created.length === 1,
    `got ${created.length}`);
  check('all responses refer to a single transaction', ids.size === 1,
    `got ${ids.size} distinct ids`);
  check('balance moved exactly once', after - before === BigInt(amount),
    `moved ${after - before}, want ${amount}`);
  check('no request was left unresolved', inProgress.length === 0,
    `${inProgress.length} got REQUEST_IN_PROGRESS`);
};

const scenarioDeadlockBait = async () => {
  console.log(`\n[3] Deadlock bait — interleaved credits and debits on two wallets`);

  await Promise.all([
    post(
      '/v1/transactions/topup',
      { userId: USERS.alice, asset: 'GOLD', amount: CONCURRENCY, paymentReference: uid() },
      uid(),
    ),
    post(
      '/v1/transactions/topup',
      { userId: USERS.bob, asset: 'GOLD', amount: CONCURRENCY, paymentReference: uid() },
      uid(),
    ),
  ]);

  // Alternating direction and alternating wallet: if accounts were locked in
  // request order rather than id order, this is where cycles would appear.
  const jobs = Array.from({ length: CONCURRENCY * 2 }, (_, i) => {
    const user = i % 2 === 0 ? USERS.alice : USERS.bob;
    const spend = i % 4 < 2;
    return spend
      ? post(
          '/v1/transactions/spend',
          { userId: user, asset: 'GOLD', amount: 1, orderReference: uid() },
          uid(),
        )
      : post(
          '/v1/transactions/topup',
          { userId: user, asset: 'GOLD', amount: 1, paymentReference: uid() },
          uid(),
        );
  });

  const results = await Promise.all(jobs);

  const contended = results.filter((r) => r.body.error?.code === 'WALLET_CONTENDED');
  // Load shedding is a correct response, not a failure: the transaction never
  // began. It is reported, then retried below to prove it resolves.
  const shed = results.filter((r) => r.body.error?.code === 'SERVICE_BUSY');
  const internal = results.filter(
    (r) => r.status >= 500 && !['SERVICE_BUSY', 'WALLET_CONTENDED'].includes(r.body.error?.code),
  );

  console.log(
    `  ${results.filter((r) => r.status === 201).length} posted, ` +
      `${contended.length} exhausted retries, ${shed.length} shed (503), ` +
      `${internal.length} internal errors`,
  );

  check('no request exhausted its retries', contended.length === 0,
    `${contended.length} returned WALLET_CONTENDED`);
  check('no internal (500) errors', internal.length === 0,
    JSON.stringify(internal.slice(0, 3).map((r) => r.body)));

  // A shed request carries the same Idempotency-Key on retry. This is the
  // whole point of the key: backpressure costs latency, never correctness.
  if (shed.length > 0) {
    console.log(`  retrying ${shed.length} shed request(s) with their original keys`);
    const retried = [];
    for (const original of shed) {
      retried.push(await post(original.request.path, original.request.body, original.request.key));
    }
    const resolved = retried.filter((r) => r.status === 201 || r.status === 200);
    check('every shed request succeeded on retry', resolved.length === shed.length,
      `${resolved.length}/${shed.length} resolved`);
  }
};

const verifyIntegrity = async () => {
  console.log('\n[4] Ledger integrity after the storm');
  const { status, body } = await get('/v1/admin/reconcile');

  check('reconciliation reports healthy', status === 200 && body.healthy === true,
    JSON.stringify(body.cacheDrift ?? body));
  check('every asset nets to zero across all accounts',
    (body.assetTotals ?? []).every((t) => t.balanced),
    JSON.stringify(body.assetTotals));
};

// --------------------------------------------------------------------------

const main = async () => {
  console.log(`wallet-service load test → ${BASE_URL} (concurrency ${CONCURRENCY})`);

  const ready = await fetch(`${BASE_URL}/ready`).catch(() => null);
  if (!ready?.ok) {
    console.error(`\nService is not reachable at ${BASE_URL}. Start it first.`);
    process.exit(1);
  }

  await scenarioOversell();
  await scenarioRetryStorm();
  await scenarioDeadlockBait();
  await verifyIntegrity();

  console.log(
    failures.length === 0
      ? '\nAll invariants held.\n'
      : `\n${failures.length} invariant(s) violated: ${failures.join(', ')}\n`,
  );
  process.exit(failures.length === 0 ? 0 : 1);
};

main().catch((err) => {
  console.error('load test crashed:', err);
  process.exit(1);
});

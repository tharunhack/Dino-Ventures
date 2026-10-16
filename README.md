# Internal Wallet Service

A closed-loop wallet service for application credits ("Gold Coins", "Diamonds",
"Loyalty Points"). Credits exist only inside the application: they are minted
from system accounts, spent back into system accounts, and never transferred
between users.

Built with **Fastify** (plain functions, no classes) on **PostgreSQL**, with a
**double-entry ledger**, per-request **idempotency**, and a locking discipline
that makes **deadlocks structurally impossible** rather than merely unlikely.

---

## Quick start

One command brings up the database, applies migrations, loads seed data, and
starts the API:

```bash
docker compose up --build
```

That is it. The `app` container waits for `migrate` and `seed` to exit
successfully, so the service is never reachable before the schema and seed data
are in place. The API is on <http://localhost:3000>.

```bash
curl http://localhost:3000/ready
# {"status":"ready"}
```

> If port 5432 or 3000 is already in use on your machine (a local Postgres is a
> common culprit), override them:
> `POSTGRES_PORT=55432 APP_PORT=3200 docker compose up --build`

**Tear down**, including the data volume:

```bash
docker compose down -v
```

### Without Docker

Needs Node 20+ and a reachable PostgreSQL 14+.

```bash
cp .env.example .env          # then edit DATABASE_URL
./setup.sh --local            # installs deps, migrates, seeds
npm start
```

`./setup.sh` on its own starts Postgres in Docker and then migrates and seeds
from the host — handy when you want to run the Node process locally with
`npm run dev` but not maintain a local Postgres.

Individual steps, if you prefer them explicit:

```bash
npm install
npm run db:migrate            # apply db/migrations/*.sql
npm run db:seed               # apply db/seed.sql
npm run db:reset              # drop schema, re-migrate, re-seed
```

`db/seed.sql` is plain SQL and can equally be piped through `psql`:

```bash
psql "$DATABASE_URL" -f db/migrations/001_init.sql
psql "$DATABASE_URL" -f db/seed.sql
```

---

## Seed data

| What | Detail |
| --- | --- |
| **Assets** | `GOLD` (Gold Coins), `DIAMOND` (Diamonds), `LOYALTY` (Loyalty Points) |
| **System accounts** | `TREASURY`, `PROMO`, `REVENUE` — one set per asset, 9 in total |
| **Users** | Alice, Bob, Carol, with fixed UUIDs so the examples below work verbatim |
| **Opening balances** | Alice 1 000 GOLD + 75 DIAMOND, Bob 500 GOLD + 2 500 LOYALTY, Carol 250 GOLD |

```
Alice  11111111-1111-4111-8111-111111111111
Bob    22222222-2222-4222-8222-222222222222
Carol  33333333-3333-4333-8333-333333333333
```

The three system accounts exist per asset and serve distinct purposes:

- **`TREASURY`** — source of *purchased* credits. Runs negative by design: its
  balance is the exact negative of all purchased credits in circulation.
- **`PROMO`** — source of *free* credits. Kept separate from `TREASURY` so
  "credits we sold" and "credits we gave away" never mix in reporting.
- **`REVENUE`** — destination of spends. Its balance is credits consumed in-app.

Opening balances are not written straight into a balance column; the seed posts
them as real double-entry transactions out of `TREASURY`/`PROMO`. The ledger is
therefore internally consistent from its very first row, and the seed script
fails loudly if it ever leaves drift behind.

---

## Verify it in 60 seconds

The scenario from the brief — earn 100, spend 30, expect 70:

```bash
BASE=http://localhost:3000
CAROL=33333333-3333-4333-8333-333333333333

# 1. Bonus: 100 free points for completing a level
curl -s -X POST $BASE/v1/transactions/bonus \
  -H 'content-type: application/json' \
  -H 'idempotency-key: demo-bonus-001' \
  -d "{\"userId\":\"$CAROL\",\"asset\":\"LOYALTY\",\"amount\":100,\"reason\":\"achievement\"}"
# -> 201 ... "walletBalance":"100"

# 2. Spend 30 on an in-game item
curl -s -X POST $BASE/v1/transactions/spend \
  -H 'content-type: application/json' \
  -H 'idempotency-key: demo-spend-001' \
  -d "{\"userId\":\"$CAROL\",\"asset\":\"LOYALTY\",\"amount\":30,\"orderReference\":\"item_sword_01\"}"
# -> 201 ... "walletBalance":"70"

# 3. Retry the spend with the same key — nothing double-charges
curl -s -X POST $BASE/v1/transactions/spend \
  -H 'content-type: application/json' \
  -H 'idempotency-key: demo-spend-001' \
  -d "{\"userId\":\"$CAROL\",\"asset\":\"LOYALTY\",\"amount\":30,\"orderReference\":\"item_sword_01\"}"
# -> 200 ... "walletBalance":"70","replayed":true   (same transactionId)

# 4. The ledger agrees with itself
curl -s $BASE/v1/admin/reconcile
# -> {"healthy":true,"cacheDrift":[], ... all assets net to zero}
```

---

## API

All write endpoints **require an `Idempotency-Key` header** (8–255 chars).
Amounts are whole numbers of minor units, sent as a JSON integer or as a digit
string, and always returned as strings.

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/v1/transactions/topup` | Credit a wallet after a real-money purchase has settled (`TREASURY` → wallet) |
| `POST` | `/v1/transactions/bonus` | Issue free credits: referral, welcome, compensation (`PROMO` → wallet) |
| `POST` | `/v1/transactions/spend` | Spend credits on an in-app service (wallet → `REVENUE`) |
| `GET` | `/v1/transactions/:transactionId` | One transaction with both its ledger entries |
| `GET` | `/v1/users/:userId/wallets` | All of a user's balances |
| `GET` | `/v1/users/:userId/wallets/:asset/statement` | Paginated ledger statement with running balances |
| `GET` | `/v1/assets` | Configured asset types |
| `GET` | `/v1/admin/accounts/system` | System account balances |
| `GET` | `/v1/admin/reconcile` | Integrity check — 200 healthy, 500 if drift is found |
| `GET` | `/health`, `/ready` | Liveness, and readiness including a DB round-trip |

### Request bodies

```jsonc
// POST /v1/transactions/topup
{ "userId": "uuid", "asset": "GOLD", "amount": 100,
  "paymentReference": "pay_abc123",       // required: id from the payment provider
  "metadata": {} }                        // optional

// POST /v1/transactions/bonus
{ "userId": "uuid", "asset": "GOLD", "amount": 50,
  "reason": "referral",                   // referral|welcome|promotion|compensation|achievement
  "campaignId": "ref-q4" }                // optional

// POST /v1/transactions/spend
{ "userId": "uuid", "asset": "GOLD", "amount": 30,
  "orderReference": "item_sword_01" }     // required: what is being bought
```

### Responses

`201` on a fresh write, `200` when an idempotent replay is served:

```jsonc
{
  "transactionId": "f42603bf-51fc-4aba-a89e-fab3244f6b99",
  "kind": "topup",
  "asset": "GOLD",
  "amount": "100",
  "reference": "pay_abc123",
  "userId": "1111...",
  "walletBalance": "1100",
  "entries": [
    { "accountId": "10", "accountName": "wallet",   "accountKind": "user",   "amount": "100",  "balanceAfter": "1100"  },
    { "accountId": "1",  "accountName": "TREASURY", "accountKind": "system", "amount": "-100", "balanceAfter": "-1600" }
  ],
  "createdAt": "2026-10-16T14:58:22.832Z",
  "replayed": false
}
```

Errors share one envelope, `{ "error": { "code", "message", "details"? } }`:

| Status | Code | When |
| --- | --- | --- |
| 400 | `VALIDATION_ERROR` | Schema violation, including a missing `Idempotency-Key` |
| 404 | `USER_NOT_FOUND` / `ASSET_NOT_FOUND` / `TRANSACTION_NOT_FOUND` | Unknown entity |
| 409 | `IDEMPOTENCY_KEY_REUSE` | Key replayed with a **different** body |
| 409 | `REQUEST_IN_PROGRESS` | An earlier attempt on this key is unresolved; retry shortly |
| 422 | `INSUFFICIENT_FUNDS` | Spend exceeds the balance; `details` carries balance, requested, shortfall |
| 422 | `USER_NOT_ACTIVE` | User is suspended or closed |
| 503 | `WALLET_CONTENDED` | Retries exhausted under extreme contention; safe to retry with the same key |
| 503 | `SERVICE_BUSY` | Every pooled connection is in use. The transaction never began, so nothing was written; retry with the same key |

Both 503s carry a `Retry-After` header and are safe to retry with the **same**
`Idempotency-Key` — that is precisely what the key is for.

---

## Technology choices, and why

**PostgreSQL.** The requirement is data integrity under concurrency, which is
exactly what a relational database with real ACID transactions is for. Postgres
specifically because this design leans on four of its features directly:
`SELECT … FOR UPDATE` for pessimistic row locks, `DEFERRABLE` constraint
triggers to enforce the double-entry invariant at commit time, partial unique
indexes to keep the user-wallet and system-account namespaces independent, and
`ON CONFLICT DO NOTHING` on a primary key as a free, race-proof mutex for
idempotency. A document store would push every one of these invariants into
application code, which is precisely where money bugs live.

**Node.js + Fastify.** This is an I/O-bound service: nearly all of its wall
clock is spent waiting on Postgres. Node's event loop handles that shape well,
and Fastify adds schema-compiled validation and serialization, so a malformed
request is rejected before it ever reaches a database connection. It is also
unopinionated enough to keep the whole codebase plain functions.

**No ORM.** Every statement here is deliberate — lock mode, lock order, the
exact shape of the `ON CONFLICT`. An ORM's job is to hide those decisions. The
`pg` driver is used directly, and `BIGINT` is read as a string and handled with
`BigInt` so no balance can ever round through a float.

**Functional composition, no classes.** Routes, plugins, and the ledger core are
all plain `async` functions. State lives in two places only: the Fastify
instance (via `decorate`) and the database. There is nothing to instantiate and
no `this` to bind, so every function can be read — and tested — in isolation.

---

## Data model

```
assets            GOLD / DIAMOND / LOYALTY, each with a scale (decimal places)
users             the application's users
accounts          one per (owner, asset); system accounts have no owner
account_balances  cached balance per account, with a CHECK that forbids
                  negatives unless the account is explicitly allowed them
transactions      one row per business event (topup / bonus / spend)
ledger_entries    append-only, ≥2 signed rows per transaction, summing to zero
idempotency_keys  one row per client key, holding the stored response
```

### Why a ledger *and* a balance column

A pure ledger is perfectly auditable but makes every read and every overdraft
check an aggregate over the account's full history — which grows without bound.
A pure balance column is fast but destroys history and cannot be audited.

This service keeps both, with a strict rule: **`account_balances` is only ever
written in the same database transaction as the `ledger_entries` that move it.**
They cannot drift, because no code path exists that touches one without the
other. The ledger stays authoritative; the balance column is a cache that
happens to be exactly correct. `GET /v1/admin/reconcile` recomputes balances
from the ledger and compares, so the claim is checkable at any time rather than
merely asserted.

### Invariants the database enforces on its own

These do not depend on application code being correct:

1. **Transactions balance.** A `DEFERRABLE INITIALLY DEFERRED` constraint
   trigger rejects, at commit, any transaction whose entries do not sum to zero
   or that has fewer than two legs. Credits cannot be conjured from nothing.
2. **Wallets cannot go negative.** `CHECK (allow_negative OR balance >= 0)`.
   Only system source accounts carry `allow_negative`. If a bug ever bypassed
   the application's overdraft check, the write still fails — and the error
   handler maps that constraint back to the same `422 INSUFFICIENT_FUNDS` the
   logic would have returned.
3. **The ledger is append-only.** `UPDATE` and `DELETE` on `ledger_entries` are
   rejected by trigger. Corrections are posted as reversing entries.
4. **One wallet per user per asset**, and unique system account names per asset,
   via partial unique indexes.

Both the overdraft constraint and the append-only trigger are tested by trying
to violate them with raw SQL — see `test/wallet.test.js`.

---

## Concurrency strategy

### The write path

Every write flows through one pipeline:

```
withRetryableTransaction          BEGIN; SET LOCAL lock_timeout; retry on 40001 / 40P01 / 55P03
  └─ withIdempotency              INSERT … ON CONFLICT DO NOTHING  ← first lock
      └─ resolve asset / user / accounts
          └─ postTransaction      SELECT … FOR UPDATE, ascending account id
              └─ write balances, INSERT entries
                                  COMMIT  ← deferred balance trigger fires here
```

### Pessimistic row locks, not read-modify-write

The naive version of this service reads a balance, checks it in application
code, and writes the new value back. Two concurrent spends both read 100, both
decide 80 is affordable, and both write — one update is lost and the wallet is
oversold.

Instead, `postTransaction` takes `SELECT … FOR UPDATE` on every
`account_balances` row it is about to move. A second transaction touching the
same wallet blocks at that `SELECT` until the first commits, then reads the
*new* balance and re-runs its overdraft check against reality. The check and the
write are inside one lock, so no window exists between them.

`FOR UPDATE` was chosen over `SERIALIZABLE` isolation deliberately. Under
`SERIALIZABLE`, contention on one hot wallet surfaces as repeated serialization
failures and retry storms — work is done, thrown away, and done again. Blocking
is the cheaper behaviour for a row that many requests legitimately queue on, and
it keeps the throughput predictable.

Locks are only ever held across in-transaction work. User wallets are
provisioned on first use *before* any lock is taken, so no lock window is
stretched by an avoidable insert.

### Deadlock avoidance

A deadlock requires two transactions to take the same locks in opposite orders.
The service removes that possibility by giving every transaction **one global
lock order** and never deviating:

1. the `idempotency_keys` row — one per request, always taken first;
2. `account_balances` rows, **strictly ascending by `account_id`**.

Because every transaction sorts its accounts the same way, no cycle can form.
A spend on wallet 10 against `REVENUE` 3 and a top-up on wallet 10 from
`TREASURY` 1 both lock the lower id first, so one simply waits for the other.

Two implementation details matter here:

- **Locks are taken one row at a time**, in a loop over the sorted ids, rather
  than with a single multi-row `SELECT … WHERE id = ANY(…) ORDER BY id FOR
  UPDATE`. In a multi-row statement, the order in which rows are actually locked
  follows the query plan, which the planner is free to change; a loop makes the
  order explicit and guaranteed.
- **`lock_timeout` is set per transaction** (3 s by default). A request that
  somehow ends up queueing pathologically long fails fast and is retried,
  instead of occupying a pool connection indefinitely.

Belt and braces, `withRetryableTransaction` still replays `40001`
(serialization failure), `40P01` (deadlock detected) and `55P03` (lock timeout)
up to 5 times with exponential backoff and full jitter. In practice the counter
never moves — the ordering rule means there is nothing to recover from — but if
a future contributor adds a code path that violates the ordering, the service
degrades into retries rather than into 500s.

Deliberately **not** retried: `57014` (statement timeout) and connection loss.
There the commit outcome is unknown, so replaying could double-post. Those
surface to the client, whose retry is made safe by the idempotency key instead.

`docker-compose.yml` runs Postgres with `log_lock_waits=on` and
`deadlock_timeout=200ms`, so the claim above can be checked rather than trusted:
`docker compose logs postgres | grep -i deadlock` stays empty under load.

### Idempotency

Every write endpoint requires a client-generated `Idempotency-Key`. The
guarantee: **for a given key, at most one transaction is ever posted**, however
many times the request arrives and however those arrivals overlap.

The mechanism is one `INSERT … ON CONFLICT DO NOTHING` against the
`idempotency_keys` primary key, issued **in the same transaction as the ledger
writes**. That detail is what makes it airtight:

- A duplicate request issues the same `INSERT`, which **blocks on the unique
  index** until the first transaction resolves. Postgres supplies the mutual
  exclusion — there is no separate lock table, and no gap between "check whether
  this key was used" and "record that it was".
- If the first request **commits**, the duplicate's insert conflicts; it reads
  the stored response body and replays it verbatim with status `200` and
  `"replayed": true`.
- If the first request **rolls back**, the row vanishes with it, the duplicate's
  insert succeeds, and it does the work. A failed request never burns its key.

The key is also fingerprinted against a canonical (key-sorted) hash of the
request body, so a key replayed with *different* arguments is rejected as
`409 IDEMPOTENCY_KEY_REUSE` rather than being silently answered with the wrong
transaction's response. Reordering the JSON keys of an otherwise identical
body is correctly treated as the same request.

Because the claim is taken before any account lock, it is also the first link in
the global lock order described above.

---

## Testing

```bash
npm test          # 24 integration tests against a real Postgres
npm run loadtest  # concurrency harness against a running service
```

The tests run against a real, migrated database — the guarantees under test are
database guarantees, so mocking Postgres would test nothing worth testing. Each
test provisions its own user, so runs do not interfere with each other.

Coverage includes the 100-earn/30-spend/70-remaining scenario from the brief,
all three flows and their system-account legs, overdraft rejection leaving the
balance untouched, idempotent replay, key reuse with a mismatched body, 40
concurrent spends against funds for 20, a 30-request retry storm on a single
key, interleaved credits and debits across two wallets, amounts above 2^53, and
direct SQL attempts to violate the append-only and non-negative constraints.

`scripts/load-test.js` proves the hard requirements against a live service and
exits non-zero if any invariant breaks. Measured on this machine at
`CONCURRENCY=200`:

```
[1] Oversell — 200 concurrent spends, funded for 100
  100 succeeded, 100 rejected, 0 unexpected, 2246ms (89 req/s)
  PASS  exactly the funded number of spends succeeded
  PASS  every other request was a clean 422
  PASS  final balance is exactly zero

[2] Retry storm — 200 concurrent requests, one shared key
  1 created, 199 replayed, 0 in-progress, 1 distinct transaction id(s)
  PASS  exactly one transaction was created
  PASS  balance moved exactly once

[3] Deadlock bait — interleaved credits and debits on two wallets
  400 posted, 0 exhausted retries, 0 server errors
  PASS  no request exhausted its retries

[4] Ledger integrity after the storm
  PASS  reconciliation reports healthy
  PASS  every asset nets to zero across all accounts
```

200 concurrent spends against a wallet funded for exactly 100 settle at exactly
100 successes and a final balance of zero: no oversell, no stranded credits, and
no deadlock recorded by Postgres.

---

## Deployment

See **[DEPLOY.md](DEPLOY.md)** for step-by-step instructions.

- **Container host (Render / Railway / Fly.io)** — the natural fit. The
  `Dockerfile` needs no changes.
- **Vercel + Neon** — supported via `api/index.js` and `vercel.json`. The
  service detects `VERCEL` and adapts its pool size and lock timeouts for a
  serverless runtime on its own.

Either way, correctness is unaffected by how many instances run: every
concurrency guarantee lives in Postgres — the row locks, the lock ordering, the
idempotency primary key — not in the Node process. Multiple instances behave
exactly like multiple threads of a single server.

## Project layout

```
api/index.js                Vercel serverless entrypoint (see DEPLOY.md)
db/
  migrations/001_init.sql   schema, constraints, triggers, reconciliation view
  seed.sql                  assets, system accounts, users, opening balances
scripts/
  migrate.js                forward-only runner, checksums applied files
  seed.js                   applies db/seed.sql
  load-test.js              concurrency harness
src/
  server.js                 listen + graceful shutdown
  app.js                    Fastify assembly, error envelope
  config.js                 environment configuration
  plugins/db.js             pg pool; fails fast if unmigrated
  lib/
    ledger.js               the only code that writes balances or entries
    idempotency.js          claim / replay / complete
    tx.js                   transaction wrapper + retry classification
    errors.js               error codes and HTTP mapping
  routes/                   transactions, wallets, system
  schemas/                  JSON Schema for every request and response
test/wallet.test.js         integration suite
setup.sh                    one-shot database setup
```

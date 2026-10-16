# Deployment

## Which host to pick

| | Vercel (serverless) | Container host (Render / Railway / Fly.io) |
| --- | --- | --- |
| Setup here | `api/index.js` + `vercel.json`, already included | `Dockerfile`, already included |
| Fit for this service | Workable, with caveats below | Natural fit |
| Connection handling | Needs an external pooler; 1 connection per instance | One process, one real pool of 20 |
| Throughput per instance | 1 request at a time | Hundreds |
| Cold starts | Yes — pool + boot probe on each | No |
| Cost at idle | Free | Free tier, or a few dollars |

**Honest recommendation: a container host suits this service better.** It holds
pessimistic row locks inside database transactions and keeps a warm connection
pool — the two things serverless is structurally worst at. The `Dockerfile` is
already production-ready, so that path is genuinely less work.

That said, Vercel does work, and everything it needs is in the repo. Both paths
are below.

---

## Option A — Vercel + Neon Postgres

Vercel runs functions, not databases, so Postgres comes from Neon (Vercel's own
Postgres offering is Neon underneath). Free tiers are sufficient.

### 1. Create the database

Sign up at [neon.tech](https://neon.tech), create a project, and copy **both**
connection strings from the dashboard:

```
# Pooled — used by the running app. Note the "-pooler" in the host.
postgres://user:pass@ep-xxx-pooler.region.aws.neon.tech/wallet?sslmode=verify-full

# Direct — used for migrations only (no "-pooler").
postgres://user:pass@ep-xxx.region.aws.neon.tech/wallet?sslmode=verify-full
```

Use `sslmode=verify-full` rather than `sslmode=require`. Today `pg` treats them
identically (full certificate verification, which Neon's publicly-signed certs
satisfy), but `require` is deprecated and will weaken to libpq semantics in
`pg` v9. Spelling it out keeps the behaviour pinned and silences a startup
warning.

### 2. Create the schema and seed data

Run this **from your machine**, against the **direct** (non-pooled) string.
Migrations are DDL and belong on a direct session, not through PgBouncer:

```bash
DATABASE_URL="postgres://...@ep-xxx.region.aws.neon.tech/wallet?sslmode=verify-full" \
  npm run db:setup
```

Expect:

```
[migrate] applying 001_init.sql
[migrate] applied 1 migration(s)
[seed] seed complete: 3 assets, 3 users, 9 system accounts, 9 wallets, 5 transactions, 0 balance drift
```

Do **not** wire this into the Vercel build step. Builds run on every deploy and
can run concurrently; migrations should be a deliberate, serialised action.

### 3. Deploy

```bash
npm i -g vercel
vercel login
vercel link                       # choose/create a project; framework: Other
```

Add the **pooled** connection string as an environment variable:

```bash
vercel env add DATABASE_URL production
# paste the -pooler URL when prompted
```

Then ship it:

```bash
vercel deploy --prod
```

`vercel.json` rewrites every path to `api/index.js`, which boots the Fastify app
once per warm instance and emits each request into it. Fastify's own router does
the matching, so all the routes in the README work unchanged.

### 4. Verify the live deployment

```bash
BASE=https://<your-project>.vercel.app

curl -s $BASE/ready
# {"status":"ready"}

curl -s $BASE/v1/admin/reconcile
# {"healthy":true,"cacheDrift":[], ...}

CAROL=33333333-3333-4333-8333-333333333333
curl -s -X POST $BASE/v1/transactions/bonus \
  -H 'content-type: application/json' \
  -H 'idempotency-key: live-check-001' \
  -d "{\"userId\":\"$CAROL\",\"asset\":\"LOYALTY\",\"amount\":100,\"reason\":\"achievement\"}"
```

The concurrency harness runs against a deployed URL too:

```bash
BASE_URL=https://<your-project>.vercel.app CONCURRENCY=50 npm run loadtest
```

### Environment variables

| Variable | Value | Notes |
| --- | --- | --- |
| `DATABASE_URL` | the **pooled** Neon URL | Required |
| `DB_POOL_MAX` | `1` | Already the default when `VERCEL` is set |
| `LOG_LEVEL` | `info` | |

`VERCEL=1` is injected by the platform. The service reads it (see
`isServerless()` in [src/config.js](src/config.js)) and adjusts three defaults on
its own: pool size 1, `lock_timeout` 2 s, `statement_timeout` 8 s — all well
inside the 30 s function limit set in `vercel.json`.

### Serverless caveats, and how they're handled

**Connection exhaustion.** Vercel scales by adding instances, each with its own
pool. Twenty instances × a pool of 20 would be 400 connections against a free
tier that allows a fraction of that. Hence `DB_POOL_MAX=1` per instance, with
Neon's PgBouncer multiplexing behind them. PgBouncer runs in *transaction*
pooling mode, which is compatible with this service: every transaction uses one
connection start to finish, and session state is set with `SET LOCAL` (scoped to
the transaction) rather than `SET`.

**Backpressure under load.** With a one-connection pool, concurrent requests on
one instance queue for it. If a request waits past `connectionTimeoutMillis`,
the pool rejects it — and because the transaction never began, nothing was
written. The service translates this into `503 SERVICE_BUSY` with a
`Retry-After` header rather than a 500, and the client's retry with the **same
`Idempotency-Key`** completes the work exactly once. This is verified: under a
deliberately starved one-connection pool, 8 of 400 requests were shed and all 8
succeeded on retry, with the ledger reconciling.

**Cold starts.** Each new instance opens a connection and runs one probe query
to confirm the schema is migrated. Expect a few hundred extra milliseconds on a
cold request.

**Correctness is unaffected.** All the concurrency guarantees live in Postgres —
row locks, the lock ordering, the idempotency primary key — not in the Node
process. Multiple instances behave exactly like multiple threads of one server.

---

## Option B — Container host (recommended)

The `Dockerfile` needs no changes. On **Render**, **Railway**, or **Fly.io**:

1. Provision a managed Postgres instance on the same platform.
2. Create a web service from this repo; it will detect the `Dockerfile`.
3. Set `DATABASE_URL` to the internal connection string, and `PORT` if the
   platform requires a specific one (`src/config.js` already reads `PORT`).
4. Point the health check at `/ready`.
5. Run the schema setup once, from your machine or a one-off shell:

```bash
DATABASE_URL="<connection string>" npm run db:setup
```

Keep `DB_POOL_MAX` at its default of 20 and size it under the database's
`max_connections`.

### Fly.io specifics

```bash
fly launch --no-deploy          # generates fly.toml from the Dockerfile
fly postgres create
fly postgres attach <db-name>   # sets DATABASE_URL automatically
fly deploy
fly ssh console -C "node scripts/migrate.js"
fly ssh console -C "node scripts/seed.js"
```

Set the health check to `/ready` in `fly.toml`.

---

## Post-deploy checklist

- [ ] `GET /ready` returns 200.
- [ ] `GET /v1/admin/reconcile` returns `"healthy": true`.
- [ ] A top-up, a bonus, and a spend each return 201, and the balances move.
- [ ] Replaying one of those with the same `Idempotency-Key` returns 200 and
      `"replayed": true` with an unchanged balance.
- [ ] `/v1/admin/*` is behind network restrictions or auth — it is **not**
      authenticated in this codebase.
- [ ] A cleanup job is scheduled for `idempotency_keys` older than the retry
      window; the table grows without bound otherwise.
- [ ] Monitoring alerts on `/v1/admin/reconcile` returning 500.

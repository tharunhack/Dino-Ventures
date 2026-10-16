-- ---------------------------------------------------------------------------
-- seed.sql — pre-seed data so the service is usable the moment it boots.
--
-- Safe to run repeatedly: every statement is idempotent, and opening balances
-- are only posted for wallets that have no ledger history yet.
--
-- Opening balances are NOT written straight into account_balances. They are
-- posted as real double-entry transactions out of TREASURY, so the ledger is
-- internally consistent from the very first row and `GET /v1/admin/reconcile`
-- passes on a freshly seeded database.
-- ---------------------------------------------------------------------------

-- --------------------------------------------------------------------------
-- 1. Asset types
-- --------------------------------------------------------------------------

INSERT INTO assets (code, name, scale) VALUES
  ('GOLD',    'Gold Coins',     0),
  ('DIAMOND', 'Diamonds',       0),
  ('LOYALTY', 'Loyalty Points', 0)
ON CONFLICT (code) DO NOTHING;

-- --------------------------------------------------------------------------
-- 2. System accounts — one set per asset.
--
--    TREASURY  source of purchased credits. Runs negative by design: its
--              balance is the negative of everything in circulation.
--    PROMO     source of free/bonus credits, kept separate from TREASURY so
--              "credits we sold" and "credits we gave away" never mix.
--    REVENUE   destination of spends. Its balance is credits consumed in-app.
-- --------------------------------------------------------------------------

INSERT INTO accounts (asset_id, kind, owner_id, name, allow_negative)
SELECT a.id, 'system', NULL, s.name, s.allow_negative
  FROM assets a
  CROSS JOIN (VALUES
      ('TREASURY', true),
      ('PROMO',    true),
      ('REVENUE',  false)
  ) AS s(name, allow_negative)
ON CONFLICT DO NOTHING;

-- --------------------------------------------------------------------------
-- 3. Users — fixed UUIDs so the README curl examples work verbatim.
-- --------------------------------------------------------------------------

INSERT INTO users (id, external_ref, display_name, email) VALUES
  ('11111111-1111-4111-8111-111111111111', 'player-alice', 'Alice Nguyen',  'alice@example.com'),
  ('22222222-2222-4222-8222-222222222222', 'player-bob',   'Bob Martinez',  'bob@example.com'),
  ('33333333-3333-4333-8333-333333333333', 'player-carol', 'Carol Fischer', 'carol@example.com')
ON CONFLICT (id) DO NOTHING;

-- --------------------------------------------------------------------------
-- 4. User wallets — one per (user, asset).
-- --------------------------------------------------------------------------

-- The matching account_balances rows are created by a trigger on `accounts`,
-- for both the system accounts above and the wallets here.
INSERT INTO accounts (asset_id, kind, owner_id, name)
SELECT a.id, 'user', u.id, u.display_name || ' · ' || a.code
  FROM users u CROSS JOIN assets a
ON CONFLICT DO NOTHING;

-- --------------------------------------------------------------------------
-- 5. Opening balances, posted as proper transactions.
-- --------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION pg_temp.seed_post(
  p_user_ref     text,
  p_asset_code   text,
  p_source_name  text,
  p_kind         transaction_kind,
  p_amount       bigint,
  p_reference    text
) RETURNS uuid
LANGUAGE plpgsql AS $fn$
DECLARE
  v_asset_id   smallint;
  v_dest_id    bigint;
  v_source_id  bigint;
  v_dest_bal   bigint;
  v_source_bal bigint;
  v_tx_id      uuid;
BEGIN
  SELECT id INTO v_asset_id FROM assets WHERE code = p_asset_code;

  SELECT acc.id INTO v_dest_id
    FROM accounts acc
    JOIN users u ON u.id = acc.owner_id
   WHERE u.external_ref = p_user_ref AND acc.asset_id = v_asset_id;

  SELECT id INTO v_source_id
    FROM accounts
   WHERE kind = 'system' AND asset_id = v_asset_id AND name = p_source_name;

  -- Already seeded? Leave it alone.
  IF EXISTS (SELECT 1 FROM ledger_entries WHERE account_id = v_dest_id) THEN
    RETURN NULL;
  END IF;

  INSERT INTO transactions (kind, asset_id, amount, reference, metadata)
  VALUES (p_kind, v_asset_id, p_amount, p_reference,
          jsonb_build_object('source', 'seed'))
  RETURNING id INTO v_tx_id;

  -- Lock in ascending account id: the same ordering rule the service uses.
  PERFORM 1 FROM account_balances
   WHERE account_id IN (v_dest_id, v_source_id)
   ORDER BY account_id
     FOR UPDATE;

  UPDATE account_balances
     SET balance = balance - p_amount, version = version + 1, updated_at = now()
   WHERE account_id = v_source_id
  RETURNING balance INTO v_source_bal;

  UPDATE account_balances
     SET balance = balance + p_amount, version = version + 1, updated_at = now()
   WHERE account_id = v_dest_id
  RETURNING balance INTO v_dest_bal;

  INSERT INTO ledger_entries (transaction_id, account_id, asset_id, amount, balance_after)
  VALUES (v_tx_id, v_source_id, v_asset_id, -p_amount, v_source_bal),
         (v_tx_id, v_dest_id,   v_asset_id,  p_amount, v_dest_bal);

  RETURN v_tx_id;
END $fn$;

SELECT pg_temp.seed_post('player-alice', 'GOLD',    'TREASURY', 'topup', 1000, 'seed-alice-gold');
SELECT pg_temp.seed_post('player-bob',   'GOLD',    'TREASURY', 'topup',  500, 'seed-bob-gold');
SELECT pg_temp.seed_post('player-carol', 'GOLD',    'PROMO',    'bonus',  250, 'seed-carol-welcome');
SELECT pg_temp.seed_post('player-alice', 'DIAMOND', 'TREASURY', 'topup',   75, 'seed-alice-diamond');
SELECT pg_temp.seed_post('player-bob',   'LOYALTY', 'PROMO',    'bonus', 2500, 'seed-bob-loyalty');

-- --------------------------------------------------------------------------
-- 6. Summary
-- --------------------------------------------------------------------------

DO $do$
DECLARE
  v_assets   bigint;
  v_users    bigint;
  v_system   bigint;
  v_wallets  bigint;
  v_tx       bigint;
  v_drift    bigint;
BEGIN
  SELECT count(*) INTO v_assets  FROM assets;
  SELECT count(*) INTO v_users   FROM users;
  SELECT count(*) INTO v_system  FROM accounts WHERE kind = 'system';
  SELECT count(*) INTO v_wallets FROM accounts WHERE kind = 'user';
  SELECT count(*) INTO v_tx      FROM transactions;

  SELECT count(*) INTO v_drift
    FROM account_balances b
    JOIN ledger_balances l ON l.account_id = b.account_id
   WHERE b.balance <> l.balance;

  RAISE NOTICE 'seed complete: % assets, % users, % system accounts, % wallets, % transactions, % balance drift',
    v_assets, v_users, v_system, v_wallets, v_tx, v_drift;

  IF v_drift <> 0 THEN
    RAISE EXCEPTION 'seed left % account(s) with cached balance != ledger balance', v_drift;
  END IF;
END $do$;

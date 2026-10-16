import { errors } from './errors.js';

/**
 * Transaction helpers.
 *
 * Postgres error classes we treat as "the transaction rolled back cleanly and
 * replaying it is safe":
 *
 *   40001 serialization_failure  — concurrent update under REPEATABLE READ+
 *   40P01 deadlock_detected      — the deadlock detector picked us as victim
 *   55P03 lock_not_available     — our lock_timeout fired while queueing
 *
 * Anything else (including 57014 statement_timeout and connection loss) is NOT
 * retried internally: the commit outcome may be unknown, and replaying it could
 * double-post. Those surface to the client, whose retry is made safe by the
 * Idempotency-Key instead.
 */
const RETRYABLE = new Set(['40001', '40P01', '55P03']);

export const isRetryable = (err) => RETRYABLE.has(err?.code);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Exponential backoff with full jitter, so retrying clients spread out. */
const backoffDelay = (attempt, { baseDelayMs, maxDelayMs }) => {
  const ceiling = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
  return Math.round(Math.random() * ceiling);
};

/**
 * Run `fn(client)` inside a single database transaction, rolling back on any
 * throw. The connection is always released.
 */
export const withTransaction = async (pool, fn, options = {}) => {
  const {
    isolationLevel = 'READ COMMITTED',
    lockTimeoutMs,
    statementTimeoutMs,
  } = options;

  const client = await pool.connect();
  try {
    await client.query(`BEGIN ISOLATION LEVEL ${isolationLevel}`);

    // Per-transaction, reverted automatically when the transaction ends.
    if (lockTimeoutMs != null) {
      await client.query(`SET LOCAL lock_timeout = '${lockTimeoutMs}ms'`);
    }
    if (statementTimeoutMs != null) {
      await client.query(`SET LOCAL statement_timeout = '${statementTimeoutMs}ms'`);
    }

    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // The connection is already broken; releasing it with an error below
      // removes it from the pool rather than handing it to the next caller.
    }
    throw err;
  } finally {
    client.release();
  }
};

/**
 * `withTransaction` plus automatic replay of deadlocks, serialization failures
 * and lock timeouts. `fn` must be side-effect free outside the database, since
 * it can run more than once.
 */
export const withRetryableTransaction = async (pool, fn, options = {}) => {
  const {
    maxAttempts = 5,
    baseDelayMs = 10,
    maxDelayMs = 250,
    logger,
    ...txOptions
  } = options;

  let lastError;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await withTransaction(pool, fn, txOptions);
    } catch (err) {
      if (!isRetryable(err)) throw err;

      lastError = err;
      logger?.warn(
        { pgCode: err.code, attempt, maxAttempts },
        'retryable transaction conflict, replaying',
      );

      if (attempt < maxAttempts) {
        await sleep(backoffDelay(attempt, { baseDelayMs, maxDelayMs }));
      }
    }
  }

  logger?.error(
    { pgCode: lastError?.code, maxAttempts },
    'transaction retries exhausted',
  );
  throw errors.walletLocked();
};

export default withRetryableTransaction;

import { createHash } from 'node:crypto';
import { errors } from './errors.js';

/**
 * Idempotency.
 *
 * The guarantee: for a given Idempotency-Key, at most one transaction is ever
 * posted, no matter how many times the request arrives or how those arrivals
 * overlap in time.
 *
 * How it holds under concurrency: the claim INSERT and the ledger writes happen
 * in ONE database transaction. A second request with the same key issues the
 * same INSERT, which blocks on the primary-key index until the first
 * transaction resolves — Postgres gives us the mutual exclusion for free, with
 * no separate lock table and no window between "check" and "write".
 *
 *   - first commits  -> the duplicate's INSERT conflicts, it reads the stored
 *                       response and replays it verbatim
 *   - first rolls back -> the duplicate's INSERT succeeds and it does the work
 *
 * The claim is always taken before any account row is locked, which also makes
 * it the first link in the service's global lock order.
 */

/** Stable JSON: object keys sorted, so key order in the body is irrelevant. */
const canonicalize = (value) => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize(value[k])}`).join(',')}}`;
};

export const fingerprint = (endpoint, payload) =>
  createHash('sha256')
    .update(endpoint)
    .update('\u0000')
    .update(canonicalize(payload))
    .digest('hex');

/**
 * Attempt to claim `key` for this request.
 *
 * @returns {{ state: 'fresh' }}
 *          when this request owns the key and must do the work, or
 *          {{ state: 'replay', statusCode, body }}
 *          when a previous request already completed it.
 * @throws  IDEMPOTENCY_KEY_REUSE when the key was used with a different body,
 *          REQUEST_IN_PROGRESS when an earlier attempt is unresolved.
 */
export const claimKey = async (client, { key, endpoint, requestHash }) => {
  const claimed = await client.query(
    `INSERT INTO idempotency_keys (key, endpoint, request_hash)
     VALUES ($1, $2, $3)
     ON CONFLICT (key) DO NOTHING
     RETURNING key`,
    [key, endpoint, requestHash],
  );

  if (claimed.rowCount === 1) return { state: 'fresh' };

  // Someone got here first. Their transaction has now resolved (our INSERT
  // waited on it), so the row below is the settled outcome.
  const { rows } = await client.query(
    `SELECT endpoint, request_hash, status, response_code, response_body
       FROM idempotency_keys
      WHERE key = $1`,
    [key],
  );

  const existing = rows[0];
  if (!existing) {
    // The holder rolled back between our conflict and this read. Treating it
    // as contention keeps the client's retry safe.
    throw errors.requestInProgress();
  }

  if (existing.endpoint !== endpoint || existing.request_hash !== requestHash) {
    throw errors.idempotencyKeyReuse({
      key,
      originalEndpoint: existing.endpoint,
      requestedEndpoint: endpoint,
    });
  }

  if (existing.status !== 'completed') throw errors.requestInProgress();

  return {
    state: 'replay',
    statusCode: existing.response_code ?? 200,
    body: existing.response_body,
  };
};

/** Record the outcome against the claimed key, in the same transaction. */
export const completeKey = async (
  client,
  { key, transactionId = null, statusCode, body },
) => {
  await client.query(
    `UPDATE idempotency_keys
        SET status = 'completed',
            transaction_id = $2,
            response_code = $3,
            response_body = $4::jsonb,
            completed_at = now()
      WHERE key = $1`,
    [key, transactionId, statusCode, JSON.stringify(body)],
  );
};

/**
 * Wrap a write handler in the claim/replay/complete cycle.
 *
 * `work(client)` must return `{ statusCode, body, transactionId }` and must not
 * have side effects outside the database — it can be replayed by the retry
 * wrapper above it.
 */
export const withIdempotency = async (client, context, work) => {
  const { key, endpoint, payload } = context;
  const requestHash = fingerprint(endpoint, payload);

  const claim = await claimKey(client, { key, endpoint, requestHash });
  if (claim.state === 'replay') {
    return { ...claim.body, replayed: true, __statusCode: claim.statusCode };
  }

  const { statusCode, body, transactionId } = await work(client);
  await completeKey(client, { key, transactionId, statusCode, body });

  return { ...body, replayed: false, __statusCode: statusCode };
};

export default withIdempotency;

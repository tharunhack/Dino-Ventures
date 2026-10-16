/**
 * Application errors as plain objects with a stable machine-readable `code`.
 * No error subclasses — `appError` tags an ordinary Error and the Fastify
 * error handler turns the tag into an HTTP response.
 */

const APP_ERROR = Symbol.for('wallet.appError');

export const appError = (code, statusCode, message, details) => {
  const err = new Error(message);
  err[APP_ERROR] = true;
  err.code = code;
  err.statusCode = statusCode;
  if (details !== undefined) err.details = details;
  return err;
};

export const isAppError = (err) => Boolean(err?.[APP_ERROR]);

export const errors = {
  validation: (message, details) =>
    appError('VALIDATION_ERROR', 400, message, details),

  missingIdempotencyKey: () =>
    appError(
      'IDEMPOTENCY_KEY_REQUIRED',
      400,
      'An Idempotency-Key header is required for this endpoint.',
    ),

  idempotencyKeyReuse: (details) =>
    appError(
      'IDEMPOTENCY_KEY_REUSE',
      409,
      'This Idempotency-Key was already used with a different request body.',
      details,
    ),

  requestInProgress: () =>
    appError(
      'REQUEST_IN_PROGRESS',
      409,
      'A request with this Idempotency-Key is still being processed. Retry shortly.',
    ),

  userNotFound: (userId) =>
    appError('USER_NOT_FOUND', 404, `No user with id ${userId}.`),

  assetNotFound: (code) =>
    appError('ASSET_NOT_FOUND', 404, `No active asset with code ${code}.`),

  accountNotFound: (describe) =>
    appError('ACCOUNT_NOT_FOUND', 404, `No account found: ${describe}.`),

  transactionNotFound: (id) =>
    appError('TRANSACTION_NOT_FOUND', 404, `No transaction with id ${id}.`),

  insufficientFunds: (details) =>
    appError(
      'INSUFFICIENT_FUNDS',
      422,
      'The wallet does not hold enough credits for this spend.',
      details,
    ),

  walletLocked: () =>
    appError(
      'WALLET_CONTENDED',
      503,
      'The wallet is under heavy contention and the request could not be completed. Retry with the same Idempotency-Key.',
    ),

  // Load shedding: every pooled connection is busy, so the transaction never
  // began and nothing was written. Safe to retry with the same key.
  serviceBusy: () =>
    appError(
      'SERVICE_BUSY',
      503,
      'All database connections are in use. No work was performed. Retry with the same Idempotency-Key.',
    ),

  userNotActive: (status) =>
    appError('USER_NOT_ACTIVE', 422, `The user account is ${status}.`),
};

export default errors;

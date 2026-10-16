import 'dotenv/config';

const int = (value, fallback) => {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const bool = (value, fallback) =>
  value === undefined ? fallback : /^(1|true|yes|on)$/i.test(value);

/**
 * True on Vercel / AWS Lambda. Serverless changes two defaults that matter:
 * the process is short-lived and massively replicated, so each instance must
 * hold a tiny pool, and a request cannot outlive the platform's function
 * timeout, so waiting on a contended lock has to give up sooner.
 */
export const isServerless = () =>
  Boolean(process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME);

export const loadConfig = () => ({
  env: process.env.NODE_ENV ?? 'development',
  host: process.env.HOST ?? '0.0.0.0',
  port: int(process.env.PORT, 3000),
  logLevel: process.env.LOG_LEVEL ?? 'info',
  // Never pretty-print in serverless: pino's transport runs in a worker
  // thread, which can be frozen or killed with the function instance. Plain
  // JSON to stdout is also what the platform's log viewer wants.
  prettyLogs: isServerless()
    ? false
    : bool(process.env.PRETTY_LOGS, process.env.NODE_ENV !== 'production'),
  serverless: isServerless(),

  db: {
    connectionString:
      process.env.DATABASE_URL ??
      'postgres://wallet:wallet@localhost:5432/wallet',
    // Long-running server: keep the pool comfortably under max_connections,
    // since each in-flight write holds a connection for the life of its locks.
    // Serverless: one connection per instance, because the platform scales the
    // *instances*, and an external pooler (PgBouncer) multiplexes behind them.
    max: int(process.env.DB_POOL_MAX, isServerless() ? 1 : 20),
    idleTimeoutMillis: int(process.env.DB_IDLE_TIMEOUT_MS, 30_000),
    connectionTimeoutMillis: int(process.env.DB_CONNECT_TIMEOUT_MS, 5_000),
    // Refuse to wait forever for a contended row; a timeout is retried, a
    // stuck connection is not. Kept well inside the function timeout so a
    // queued request fails cleanly rather than being killed mid-transaction.
    lockTimeoutMs: int(process.env.DB_LOCK_TIMEOUT_MS, isServerless() ? 2_000 : 3_000),
    statementTimeoutMs: int(
      process.env.DB_STATEMENT_TIMEOUT_MS,
      isServerless() ? 8_000 : 10_000,
    ),
  },

  retry: {
    // Serialization failures and deadlocks are expected under contention and
    // are safe to replay: the transaction rolled back entirely.
    maxAttempts: int(process.env.TX_MAX_ATTEMPTS, 5),
    baseDelayMs: int(process.env.TX_RETRY_BASE_MS, 10),
    maxDelayMs: int(process.env.TX_RETRY_MAX_MS, 250),
  },
});

export default loadConfig;

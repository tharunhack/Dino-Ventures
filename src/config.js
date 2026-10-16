import 'dotenv/config';

const int = (value, fallback) => {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const bool = (value, fallback) =>
  value === undefined ? fallback : /^(1|true|yes|on)$/i.test(value);

export const loadConfig = () => ({
  env: process.env.NODE_ENV ?? 'development',
  host: process.env.HOST ?? '0.0.0.0',
  port: int(process.env.PORT, 3000),
  logLevel: process.env.LOG_LEVEL ?? 'info',
  prettyLogs: bool(process.env.PRETTY_LOGS, process.env.NODE_ENV !== 'production'),

  db: {
    connectionString:
      process.env.DATABASE_URL ??
      'postgres://wallet:wallet@localhost:5432/wallet',
    // Keep the pool comfortably under Postgres max_connections. Each in-flight
    // write transaction holds one connection for the duration of its locks.
    max: int(process.env.DB_POOL_MAX, 20),
    idleTimeoutMillis: int(process.env.DB_IDLE_TIMEOUT_MS, 30_000),
    connectionTimeoutMillis: int(process.env.DB_CONNECT_TIMEOUT_MS, 5_000),
    // Refuse to wait forever for a contended row; a timeout is retried, a
    // stuck connection is not.
    lockTimeoutMs: int(process.env.DB_LOCK_TIMEOUT_MS, 3_000),
    statementTimeoutMs: int(process.env.DB_STATEMENT_TIMEOUT_MS, 10_000),
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

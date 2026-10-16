import { buildApp } from './app.js';

const start = async () => {
  const app = await buildApp();

  // Drain in-flight requests before exiting so no transaction is cut mid-commit.
  const shutdown = async (signal) => {
    app.log.info({ signal }, 'shutting down');
    try {
      await app.close();
      process.exit(0);
    } catch (err) {
      app.log.error({ err }, 'error during shutdown');
      process.exit(1);
    }
  };

  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, () => void shutdown(signal));
  }

  try {
    await app.listen({ host: app.config.host, port: app.config.port });
  } catch (err) {
    app.log.error({ err }, 'failed to start');
    process.exit(1);
  }
};

start().catch((err) => {
  console.error('fatal startup error:', err);
  process.exit(1);
});

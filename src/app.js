import Fastify from 'fastify';
import sensible from '@fastify/sensible';

import { loadConfig } from './config.js';
import dbPlugin from './plugins/db.js';
import { isAppError, errors } from './lib/errors.js';
import systemRoutes from './routes/system.js';
import walletRoutes from './routes/wallets.js';
import transactionRoutes from './routes/transactions.js';

const loggerOptions = (config) => {
  if (!config.prettyLogs) {
    return {
      level: config.logLevel,
      // Never let an Idempotency-Key or a body end up in a log aggregator by
      // accident; log the shape of a request, not its contents.
      redact: ['req.headers.authorization', 'req.headers["idempotency-key"]'],
    };
  }
  return {
    level: config.logLevel,
    transport: {
      target: 'pino-pretty',
      options: { translateTime: 'HH:MM:ss.l', ignore: 'pid,hostname' },
    },
  };
};

/**
 * Translate anything thrown in a handler into the single error envelope:
 *   { error: { code, message, details? } }
 */
const errorHandler = (error, request, reply) => {
  if (isAppError(error)) {
    if (error.statusCode >= 500) request.log.error({ err: error }, error.code);
    else request.log.info({ code: error.code }, 'request rejected');

    return reply.code(error.statusCode).send({
      error: {
        code: error.code,
        message: error.message,
        ...(error.details ? { details: error.details } : {}),
      },
    });
  }

  // Fastify schema validation.
  if (error.validation) {
    return reply.code(400).send({
      error: {
        code: 'VALIDATION_ERROR',
        message: error.message,
        details: { context: error.validationContext },
      },
    });
  }

  // Defence in depth: if application logic ever let an overdraft through, the
  // CHECK constraint stops it and we report the same 422 the logic would have.
  if (error.code === '23514' && /never_negative/.test(error.constraint ?? '')) {
    const mapped = errors.insufficientFunds({ source: 'database_constraint' });
    return reply.code(mapped.statusCode).send({
      error: { code: mapped.code, message: mapped.message, details: mapped.details },
    });
  }

  if (error.code === '23505') {
    return reply.code(409).send({
      error: {
        code: 'CONFLICT',
        message: 'A conflicting record already exists.',
        details: { constraint: error.constraint },
      },
    });
  }

  request.log.error({ err: error }, 'unhandled error');
  return reply.code(error.statusCode && error.statusCode < 500 ? error.statusCode : 500).send({
    error: {
      code: 'INTERNAL_ERROR',
      message: 'An unexpected error occurred.',
    },
  });
};

/**
 * Build a configured, not-yet-listening Fastify instance.
 * Exported separately from the server so tests can drive it via `inject`.
 */
export const buildApp = async (overrides = {}) => {
  const config = { ...loadConfig(), ...overrides };

  const fastify = Fastify({
    logger: loggerOptions(config),
    // Trust the proxy's X-Forwarded-* when deployed behind a load balancer.
    trustProxy: true,
    ajv: {
      customOptions: {
        removeAdditional: false,
        useDefaults: true,
        // Coercion must stay OFF. With it on, Ajv satisfies the integer branch
        // of an `anyOf` by casting a digit string to a double, which silently
        // truncates any amount above 2^53. Params that arrive as strings are
        // parsed explicitly in their handlers instead.
        coerceTypes: false,
      },
    },
  });

  fastify.decorate('config', config);
  fastify.setErrorHandler(errorHandler);
  fastify.setNotFoundHandler((request, reply) =>
    reply.code(404).send({
      error: { code: 'NOT_FOUND', message: `No route for ${request.method} ${request.url}.` },
    }),
  );

  await fastify.register(sensible);
  await fastify.register(dbPlugin, config.db);

  await fastify.register(systemRoutes);
  await fastify.register(walletRoutes, { prefix: '/v1' });
  await fastify.register(transactionRoutes, { prefix: '/v1/transactions' });

  return fastify;
};

export default buildApp;

/**
 * Request/response JSON Schemas. Fastify compiles these, so malformed requests
 * are rejected before any handler or database connection is touched.
 */

// Amounts are whole numbers of minor units. Accepted as a JSON integer for
// convenience or as a digit string for values beyond IEEE-754 safe range;
// either way the handler converts to BigInt.
// A digit string is listed first so it is matched as-is; a JSON integer is
// accepted for convenience and both are converted with BigInt in the handler.
// Amounts above 2^53 must be sent as strings to survive JSON parsing intact.
const amount = {
  anyOf: [
    { type: 'string', pattern: '^[1-9][0-9]{0,17}$' },
    { type: 'integer', minimum: 1, maximum: 9007199254740991 },
  ],
  description: 'Positive whole number of minor units, as an integer or a digit string.',
};

const assetCode = {
  type: 'string',
  pattern: '^[A-Z][A-Z0-9_]{1,31}$',
  description: 'Asset code, e.g. GOLD.',
};

const userId = { type: 'string', format: 'uuid' };

const metadata = {
  type: 'object',
  additionalProperties: true,
  default: {},
  description: 'Opaque caller context, stored with the transaction.',
};

export const idempotencyHeader = {
  type: 'object',
  required: ['idempotency-key'],
  properties: {
    'idempotency-key': {
      type: 'string',
      minLength: 8,
      maxLength: 255,
      description: 'Client-generated unique key. Retries must reuse it.',
    },
  },
};

const entry = {
  type: 'object',
  properties: {
    accountId: { type: 'string' },
    accountName: { type: 'string' },
    accountKind: { type: 'string' },
    amount: { type: 'string' },
    balanceAfter: { type: 'string' },
  },
};

export const transactionResponse = {
  type: 'object',
  properties: {
    transactionId: { type: 'string' },
    kind: { type: 'string' },
    asset: { type: 'string' },
    amount: { type: 'string' },
    reference: { type: ['string', 'null'] },
    userId: { type: 'string' },
    walletBalance: { type: 'string' },
    entries: { type: 'array', items: entry },
    createdAt: { type: 'string' },
    replayed: {
      type: 'boolean',
      description: 'true when this response was served from the idempotency record.',
    },
  },
};

const errorResponse = {
  type: 'object',
  properties: {
    error: {
      type: 'object',
      properties: {
        code: { type: 'string' },
        message: { type: 'string' },
        details: { type: 'object', additionalProperties: true },
      },
    },
  },
};

const writeResponses = {
  200: transactionResponse,
  201: transactionResponse,
  400: errorResponse,
  404: errorResponse,
  409: errorResponse,
  422: errorResponse,
  503: errorResponse,
};

export const topupSchema = {
  summary: 'Credit a wallet for a completed real-money purchase',
  tags: ['transactions'],
  headers: idempotencyHeader,
  body: {
    type: 'object',
    required: ['userId', 'asset', 'amount', 'paymentReference'],
    additionalProperties: false,
    properties: {
      userId,
      asset: assetCode,
      amount,
      paymentReference: {
        type: 'string',
        minLength: 1,
        maxLength: 128,
        description: 'Identifier from the (already settled) payment provider.',
      },
      metadata,
    },
  },
  response: writeResponses,
};

export const bonusSchema = {
  summary: 'Issue free credits (referral, welcome, compensation)',
  tags: ['transactions'],
  headers: idempotencyHeader,
  body: {
    type: 'object',
    required: ['userId', 'asset', 'amount', 'reason'],
    additionalProperties: false,
    properties: {
      userId,
      asset: assetCode,
      amount,
      reason: {
        type: 'string',
        enum: ['referral', 'welcome', 'promotion', 'compensation', 'achievement'],
      },
      campaignId: { type: 'string', maxLength: 128 },
      metadata,
    },
  },
  response: writeResponses,
};

export const spendSchema = {
  summary: 'Spend credits on an in-app service',
  tags: ['transactions'],
  headers: idempotencyHeader,
  body: {
    type: 'object',
    required: ['userId', 'asset', 'amount', 'orderReference'],
    additionalProperties: false,
    properties: {
      userId,
      asset: assetCode,
      amount,
      orderReference: {
        type: 'string',
        minLength: 1,
        maxLength: 128,
        description: 'Identifier of the item or service being bought.',
      },
      metadata,
    },
  },
  response: writeResponses,
};

export const getTransactionSchema = {
  summary: 'Fetch a transaction and its ledger entries',
  tags: ['transactions'],
  params: {
    type: 'object',
    required: ['transactionId'],
    properties: { transactionId: { type: 'string', format: 'uuid' } },
  },
  response: { 200: transactionResponse, 404: errorResponse },
};

export const getBalancesSchema = {
  summary: 'All wallet balances for a user',
  tags: ['wallets'],
  params: {
    type: 'object',
    required: ['userId'],
    properties: { userId },
  },
  response: {
    200: {
      type: 'object',
      properties: {
        userId: { type: 'string' },
        displayName: { type: 'string' },
        status: { type: 'string' },
        wallets: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              accountId: { type: 'string' },
              asset: { type: 'string' },
              assetName: { type: 'string' },
              scale: { type: 'integer' },
              balance: { type: 'string' },
              version: { type: 'string' },
              updatedAt: { type: 'string' },
            },
          },
        },
      },
    },
    404: errorResponse,
  },
};

export const getStatementSchema = {
  summary: 'Paginated ledger statement for one wallet',
  tags: ['wallets'],
  params: {
    type: 'object',
    required: ['userId', 'asset'],
    properties: { userId, asset: assetCode },
  },
  querystring: {
    type: 'object',
    additionalProperties: false,
    properties: {
      // Query values always arrive as strings and type coercion is disabled,
      // so this is parsed and clamped to 1..200 in the handler.
      limit: { type: 'string', pattern: '^[1-9][0-9]{0,2}$', default: '50' },
      // Keyset pagination: entry ids are monotonic, so `before` is stable
      // even while new entries are being appended.
      before: { type: 'string', pattern: '^[0-9]{1,19}$' },
    },
  },
  response: {
    200: {
      type: 'object',
      properties: {
        accountId: { type: 'string' },
        asset: { type: 'string' },
        balance: { type: 'string' },
        entries: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              entryId: { type: 'string' },
              transactionId: { type: 'string' },
              kind: { type: 'string' },
              amount: { type: 'string' },
              balanceAfter: { type: 'string' },
              reference: { type: ['string', 'null'] },
              metadata: { type: 'object', additionalProperties: true },
              createdAt: { type: 'string' },
            },
          },
        },
        nextBefore: { type: ['string', 'null'] },
      },
    },
    404: errorResponse,
  },
};

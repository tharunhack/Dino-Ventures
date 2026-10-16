#!/usr/bin/env node
/**
 * Runs db/seed.sql. Equivalent to piping the file through psql, but uses the
 * same DATABASE_URL and needs no psql client installed.
 */
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

import { loadConfig } from '../src/config.js';

const here = dirname(fileURLToPath(import.meta.url));
const seedFile = join(here, '..', 'db', 'seed.sql');

const run = async () => {
  const config = loadConfig();
  const sql = await readFile(seedFile, 'utf8');

  const client = new pg.Client({ connectionString: config.db.connectionString });
  client.on('notice', (notice) => console.log('[seed]', notice.message));
  await client.connect();

  try {
    await client.query(sql);
    console.log('[seed] db/seed.sql applied');
  } finally {
    await client.end();
  }
};

run().catch((err) => {
  console.error('[seed] failed:', err.message);
  process.exit(1);
});

#!/usr/bin/env node
/**
 * Minimal forward-only migration runner.
 *
 * Each file in db/migrations runs once, inside its own transaction, and is
 * recorded in schema_migrations with a checksum. Changing an applied file is
 * rejected rather than silently ignored.
 *
 *   node scripts/migrate.js            apply pending migrations
 *   node scripts/migrate.js --reset    drop and recreate the public schema first
 */
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

import { loadConfig } from '../src/config.js';

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', 'db', 'migrations');

const checksum = (text) => createHash('sha256').update(text).digest('hex');

const log = (...args) => console.log('[migrate]', ...args);

const run = async () => {
  const config = loadConfig();
  const reset = process.argv.includes('--reset');

  const client = new pg.Client({ connectionString: config.db.connectionString });
  client.on('notice', (notice) => log(notice.message));
  await client.connect();

  try {
    if (reset) {
      log('--reset: dropping schema public');
      await client.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    }

    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        filename    text        PRIMARY KEY,
        checksum    text        NOT NULL,
        applied_at  timestamptz NOT NULL DEFAULT now()
      )
    `);

    const applied = new Map(
      (await client.query('SELECT filename, checksum FROM schema_migrations')).rows.map(
        (r) => [r.filename, r.checksum],
      ),
    );

    const files = (await readdir(migrationsDir)).filter((f) => f.endsWith('.sql')).sort();

    let pending = 0;
    for (const filename of files) {
      const sql = await readFile(join(migrationsDir, filename), 'utf8');
      const sum = checksum(sql);
      const previous = applied.get(filename);

      if (previous === sum) continue;
      if (previous && previous !== sum) {
        throw new Error(
          `${filename} has changed since it was applied. Add a new migration instead of editing it.`,
        );
      }

      log(`applying ${filename}`);
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query(
          `INSERT INTO schema_migrations (filename, checksum) VALUES ($1, $2)`,
          [filename, sum],
        );
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      }
      pending += 1;
    }

    log(pending === 0 ? 'already up to date' : `applied ${pending} migration(s)`);
  } finally {
    await client.end();
  }
};

run().catch((err) => {
  console.error('[migrate] failed:', err.message);
  process.exit(1);
});

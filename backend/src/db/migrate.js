import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { pool, closeDatabase } from './postgres.js';
import logger from '../config/logger.js';

const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations');
// Stable advisory lock id: several API pods (or a Helm hook and a developer) can call this
// at the same time and only one will apply migrations.
const LOCK_ID = 728_311;

const checksum = (sql) => crypto.createHash('sha256').update(sql).digest('hex').slice(0, 16);

/** Waits for Postgres to accept connections — RDS failovers and cold compose starts. */
export async function waitForPostgres({ attempts = 30, delayMs = 2000 } = {}) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await pool.query('SELECT 1');
      return true;
    } catch (err) {
      if (attempt === attempts) throw err;
      logger.warn({ attempt, err: err.message }, 'waiting for postgres');
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  return false;
}

export async function runMigrations() {
  await waitForPostgres();
  const client = await pool.connect();
  const applied = [];
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        filename    text PRIMARY KEY,
        checksum    text NOT NULL,
        duration_ms integer NOT NULL DEFAULT 0,
        applied_at  timestamptz NOT NULL DEFAULT now()
      )
    `);
    await client.query('SELECT pg_advisory_lock($1)', [LOCK_ID]);

    const { rows } = await client.query('SELECT filename, checksum FROM schema_migrations');
    const known = new Map(rows.map((row) => [row.filename, row.checksum]));

    const files = (await fs.readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();
    for (const filename of files) {
      const sql = await fs.readFile(path.join(MIGRATIONS_DIR, filename), 'utf8');
      const sum = checksum(sql);

      if (known.has(filename)) {
        if (known.get(filename) !== sum) {
          // Editing an applied migration is how environments drift apart. Fail loudly.
          throw new Error(
            `Migration ${filename} changed after it was applied. Add a new migration instead of editing this one.`,
          );
        }
        continue;
      }

      const startedAt = Date.now();
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (filename, checksum, duration_ms) VALUES ($1, $2, $3)', [
          filename,
          sum,
          Date.now() - startedAt,
        ]);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`Migration ${filename} failed: ${err.message}`, { cause: err });
      }
      applied.push(filename);
      logger.info({ filename, ms: Date.now() - startedAt }, 'migration applied');
    }

    if (applied.length === 0) logger.info('database already up to date');
    return applied;
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [LOCK_ID]).catch(() => {});
    client.release();
  }
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  runMigrations()
    .then(async (applied) => {
      // eslint-disable-next-line no-console
      console.log(applied.length ? `Applied ${applied.length} migration(s): ${applied.join(', ')}` : 'No migrations to apply');
      await closeDatabase();
      process.exit(0);
    })
    .catch(async (err) => {
      logger.error({ err }, 'migration run failed');
      // eslint-disable-next-line no-console
      console.error(err.message);
      await closeDatabase().catch(() => {});
      process.exit(1);
    });
}

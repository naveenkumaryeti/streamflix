import pg from 'pg';
import config from '../config/env.js';
import logger from '../config/logger.js';

const { Pool, types } = pg;

// pg returns NUMERIC and BIGINT as strings to avoid precision loss. Our numerics are
// prices and durations, and our bigints are COUNT(*) results, so numbers are safe here.
types.setTypeParser(1700, (v) => (v === null ? null : Number.parseFloat(v)));
types.setTypeParser(20, (v) => (v === null ? null : Number.parseInt(v, 10)));

export const pool = new Pool({
  connectionString: config.db.url,
  max: config.db.poolMax,
  min: 0,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
  application_name: 'streamflix-api',
  // In AWS, RDS enforces TLS. Mount the RDS CA bundle and set
  // NODE_EXTRA_CA_CERTS so certificate verification actually verifies something.
  ssl: config.db.ssl ? { rejectUnauthorized: true } : undefined,
});

pool.on('error', (err) => {
  // An idle client died (failover, network blip). pg replaces it; we just record it.
  logger.error({ err }, 'idle postgres client error');
});

export async function query(text, params = []) {
  const startedAt = process.hrtime.bigint();
  try {
    const result = await pool.query(text, params);
    const ms = Number(process.hrtime.bigint() - startedAt) / 1e6;
    if (ms > config.db.slowQueryMs) {
      logger.warn({ ms: Math.round(ms), sql: text.replace(/\s+/g, ' ').slice(0, 220) }, 'slow query');
    }
    return result;
  } catch (err) {
    logger.error(
      { err, code: err.code, constraint: err.constraint, sql: text.replace(/\s+/g, ' ').slice(0, 220) },
      'query failed',
    );
    throw err;
  }
}

export async function queryOne(text, params = []) {
  const { rows } = await query(text, params);
  return rows[0] ?? null;
}

export async function queryMany(text, params = []) {
  const { rows } = await query(text, params);
  return rows;
}

/**
 * Runs `fn` inside a transaction on a dedicated client.
 * Used wherever two writes must agree — e.g. charging a payment and activating a subscription.
 */
export async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackErr) {
      logger.error({ err: rollbackErr }, 'rollback failed');
    }
    throw err;
  } finally {
    client.release();
  }
}

export async function checkDatabase() {
  const started = Date.now();
  await pool.query('SELECT 1');
  return { ok: true, latencyMs: Date.now() - started };
}

export async function closeDatabase() {
  await pool.end();
  logger.info('postgres pool closed');
}

export default { pool, query, queryOne, queryMany, withTransaction, checkDatabase, closeDatabase };

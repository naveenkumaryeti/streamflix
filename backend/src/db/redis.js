import { createClient } from 'redis';
import config from '../config/env.js';
import logger from '../config/logger.js';
import { cacheEvents } from '../config/metrics.js';

const NS = 'sf';
export const key = (...parts) => [NS, ...parts].join(':');

export const redis = createClient({
  url: config.redis.url,
  socket: {
    connectTimeout: 5_000,
    // Keep retrying with a ceiling: ElastiCache failovers resolve in seconds.
    reconnectStrategy: (retries) => Math.min(100 * 2 ** Math.min(retries, 6), 5_000),
  },
});

let ready = false;
let lastErrorLoggedAt = 0;

redis.on('ready', () => {
  ready = true;
  logger.info('redis ready');
});
redis.on('end', () => {
  ready = false;
});
redis.on('error', (err) => {
  ready = false;
  // Reconnect loops would otherwise flood the logs with the same line.
  if (Date.now() - lastErrorLoggedAt > 30_000) {
    lastErrorLoggedAt = Date.now();
    logger.error({ err: err.message }, 'redis error');
  }
});

export const isRedisReady = () => ready;

export async function connectRedis({ required = false } = {}) {
  try {
    if (!redis.isOpen) await redis.connect();
    return true;
  } catch (err) {
    if (required) throw err;
    // Cache and rate limiting degrade; the API still serves traffic from Postgres.
    logger.warn({ err: err.message }, 'redis unavailable at boot — continuing without cache');
    return false;
  }
}

export async function closeRedis() {
  if (redis.isOpen) await redis.quit();
  ready = false;
}

export async function cacheGet(cacheKey) {
  if (!ready) return null;
  try {
    const raw = await redis.get(cacheKey);
    cacheEvents.inc({ result: raw ? 'hit' : 'miss' });
    return raw ? JSON.parse(raw) : null;
  } catch (err) {
    logger.debug({ err: err.message, cacheKey }, 'cache get failed');
    return null;
  }
}

export async function cacheSet(cacheKey, value, ttlSeconds = config.redis.defaultTtl) {
  if (!ready) return false;
  try {
    await redis.set(cacheKey, JSON.stringify(value), { EX: ttlSeconds });
    return true;
  } catch (err) {
    logger.debug({ err: err.message, cacheKey }, 'cache set failed');
    return false;
  }
}

export async function cacheDel(cacheKeys) {
  const list = Array.isArray(cacheKeys) ? cacheKeys : [cacheKeys];
  if (!ready || list.length === 0) return 0;
  try {
    return await redis.del(list);
  } catch {
    return 0;
  }
}

/** Invalidate a whole family of keys (e.g. every browse row) after an admin publishes. */
export async function cacheDelByPrefix(prefix) {
  if (!ready) return 0;
  let removed = 0;
  try {
    for await (const found of redis.scanIterator({ MATCH: `${prefix}*`, COUNT: 200 })) {
      const batch = Array.isArray(found) ? found : [found];
      if (batch.length) removed += await redis.del(batch);
    }
  } catch (err) {
    logger.debug({ err: err.message, prefix }, 'cache prefix delete failed');
  }
  return removed;
}

/** Cache-aside helper: return the cached value or compute, store and return it. */
export async function remember(cacheKey, ttlSeconds, loader) {
  const cached = await cacheGet(cacheKey);
  if (cached !== null) return cached;
  const fresh = await loader();
  if (fresh !== undefined && fresh !== null) await cacheSet(cacheKey, fresh, ttlSeconds);
  return fresh;
}

/**
 * Fixed-window counter used by the rate limiter.
 * Returns null when Redis is unavailable so callers can fail open.
 */
export async function incrementWindow(windowKey, windowSeconds) {
  if (!ready) return null;
  try {
    const multi = redis.multi();
    multi.incr(windowKey);
    multi.ttl(windowKey);
    const [count, ttl] = await multi.exec();
    if (ttl === -1) await redis.expire(windowKey, windowSeconds);
    return { count: Number(count), ttl: ttl > 0 ? Number(ttl) : windowSeconds };
  } catch (err) {
    logger.debug({ err: err.message }, 'rate limit counter failed');
    return null;
  }
}

/** Access tokens are short-lived but logout must take effect immediately. */
export async function denylistToken(jti, ttlSeconds) {
  if (!ready || ttlSeconds <= 0) return;
  await redis.set(key('denylist', jti), '1', { EX: ttlSeconds }).catch(() => {});
}

export async function isTokenDenylisted(jti) {
  if (!ready || !jti) return false;
  try {
    return (await redis.exists(key('denylist', jti))) === 1;
  } catch {
    return false;
  }
}

export async function checkRedis() {
  if (!redis.isOpen) return { ok: false, error: 'not connected' };
  const started = Date.now();
  await redis.ping();
  return { ok: true, latencyMs: Date.now() - started };
}

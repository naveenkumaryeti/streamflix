import crypto from 'node:crypto';
import { redis, isRedisReady } from '../../db/redis.js';
import cacheKeys from '../../utils/cacheKeys.js';
import logger from '../../config/logger.js';
import AppError from '../../utils/AppError.js';

/**
 * Concurrent-stream limits — the "your plan allows 2 screens" rule.
 *
 * One sorted set per user: member = "<sessionId>::<titleId>", score = last heartbeat (ms).
 * Stale members are pruned by score on every read, so a laptop that closed its lid frees
 * its slot without any cleanup job.
 *
 * Redis, not Postgres: this is written every 30 seconds by every active player. It is also
 * the one place where losing state is acceptable — if Redis is unavailable the limiter
 * fails open, because refusing to let paying customers watch is worse than allowing an
 * extra screen for a few minutes.
 */
const SLOT_TTL_SECONDS = 90;
const HEARTBEAT_SECONDS = 30;

const slotKey = (userId) => cacheKeys.streams(userId);
const member = (sessionId, titleId) => `${sessionId}::${titleId}`;
const parse = (value) => {
  const [sessionId, titleId] = String(value).split('::');
  return { sessionId, titleId };
};

export const newSessionId = () => crypto.randomUUID();
export const heartbeatSeconds = HEARTBEAT_SECONDS;

async function prune(key, now) {
  await redis.zRemRangeByScore(key, 0, now - SLOT_TTL_SECONDS * 1000);
}

/**
 * Claims a slot. Re-requesting the same session is always allowed — a player that reloads
 * the page, or asks for a fresh manifest URL, must not be locked out by its own slot.
 */
export async function acquireSlot({ userId, titleId, maxStreams, sessionId = newSessionId() }) {
  if (!isRedisReady()) {
    logger.warn({ userId }, 'stream limiter unavailable — allowing playback');
    return { sessionId, active: 1, maxStreams, enforced: false };
  }

  const key = slotKey(userId);
  const now = Date.now();

  try {
    await prune(key, now);
    const existing = await redis.zRange(key, 0, -1);
    const mine = existing.filter((entry) => parse(entry).sessionId === sessionId);

    if (!mine.length && existing.length >= maxStreams) {
      throw AppError.streamLimit(maxStreams);
    }

    // A session that switches titles keeps one slot, not two.
    if (mine.length) await redis.zRem(key, mine);
    await redis.zAdd(key, [{ score: now, value: member(sessionId, titleId) }]);
    await redis.expire(key, SLOT_TTL_SECONDS * 4);

    const active = await redis.zCard(key);
    return { sessionId, active, maxStreams, enforced: true };
  } catch (err) {
    if (err instanceof AppError) throw err;
    logger.warn({ err: err.message, userId }, 'stream limiter failed — allowing playback');
    return { sessionId, active: 1, maxStreams, enforced: false };
  }
}

/** Called by the player every 30s alongside the progress ping. */
export async function heartbeat({ userId, titleId, sessionId }) {
  if (!isRedisReady() || !sessionId) return { ok: false };
  const key = slotKey(userId);
  const now = Date.now();
  try {
    await prune(key, now);
    // Only refresh an existing member: a slot that already expired must be re-acquired,
    // otherwise a paused tab could hold a screen forever.
    const score = await redis.zScore(key, member(sessionId, titleId));
    if (score === null) return { ok: false, expired: true };
    await redis.zAdd(key, [{ score: now, value: member(sessionId, titleId) }]);
    await redis.expire(key, SLOT_TTL_SECONDS * 4);
    return { ok: true };
  } catch {
    return { ok: false };
  }
}

export async function releaseSlot({ userId, titleId, sessionId }) {
  if (!isRedisReady() || !sessionId) return { released: false };
  try {
    const key = slotKey(userId);
    const removed = titleId
      ? await redis.zRem(key, member(sessionId, titleId))
      : await (async () => {
          const all = await redis.zRange(key, 0, -1);
          const mine = all.filter((entry) => parse(entry).sessionId === sessionId);
          return mine.length ? redis.zRem(key, mine) : 0;
        })();
    return { released: removed > 0 };
  } catch {
    return { released: false };
  }
}

/** Powers the "you are watching on 2 devices" panel in account settings. */
export async function listSlots(userId) {
  if (!isRedisReady()) return [];
  try {
    const key = slotKey(userId);
    await prune(key, Date.now());
    const entries = await redis.zRangeWithScores(key, 0, -1);
    return entries.map((entry) => ({ ...parse(entry.value), lastSeenAt: new Date(entry.score).toISOString() }));
  } catch {
    return [];
  }
}

export async function releaseAll(userId) {
  if (!isRedisReady()) return 0;
  try {
    return await redis.del(slotKey(userId));
  } catch {
    return 0;
  }
}

export default { acquireSlot, heartbeat, releaseSlot, listSlots, releaseAll, newSessionId, heartbeatSeconds };

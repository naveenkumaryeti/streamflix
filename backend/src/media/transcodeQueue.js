import { redis, isRedisReady } from '../db/redis.js';
import cacheKeys from '../utils/cacheKeys.js';
import logger from '../config/logger.js';

/**
 * Transcode work queue.
 *
 * Postgres is the queue of record: `transcode_jobs` rows in status `queued` are the truth,
 * and the worker claims them with `FOR UPDATE SKIP LOCKED`. Redis is only a doorbell, so
 * the worker reacts in milliseconds instead of waiting for its next poll.
 *
 * The consequence is the useful one: flushing Redis loses no work, and a worker that starts
 * after a Redis outage still finds every queued job.
 */
const QUEUE = cacheKeys.transcodeQueue();

export async function notify(jobId) {
  if (!isRedisReady()) return false;
  try {
    await redis.lPush(QUEUE, String(jobId));
    return true;
  } catch (err) {
    logger.debug({ err: err.message, jobId }, 'transcode doorbell failed — worker will poll');
    return false;
  }
}

/** Blocks for up to `timeoutSeconds`, then returns null so the caller can poll Postgres. */
export async function waitForSignal(timeoutSeconds = 5) {
  if (!isRedisReady()) return null;
  try {
    const popped = await redis.brPop(QUEUE, timeoutSeconds);
    return popped?.element ?? null;
  } catch {
    return null;
  }
}

export async function depth() {
  if (!isRedisReady()) return 0;
  try {
    return await redis.lLen(QUEUE);
  } catch {
    return 0;
  }
}

export default { notify, waitForSignal, depth };

import { key, cacheDel, cacheDelByPrefix } from '../db/redis.js';

/**
 * All cache keys live here. Scattered key strings are how caches end up stale:
 * the writer forgets one of the three places that cached the same row.
 */
export const cacheKeys = {
  user: (userId) => key('user', userId),
  entitlement: (userId) => key('entitlement', userId),
  plans: () => key('plans'),
  genres: () => key('genres'),
  title: (slugOrId) => key('title', slugOrId),
  titleListPrefix: () => key('titles'),
  titleList: (fingerprint) => key('titles', fingerprint),
  browseRows: () => key('browse', 'rows'),
  similar: (titleId) => key('similar', titleId),
  searchPrefix: () => key('search'),
  search: (fingerprint) => key('search', fingerprint),
  streams: (userId) => key('streams', userId),
  transcodeQueue: () => key('queue', 'transcode'),
  transcodeQueueProcessing: () => key('queue', 'transcode', 'processing'),
};

export async function invalidateUser(userId) {
  await cacheDel([cacheKeys.user(userId), cacheKeys.entitlement(userId)]);
}

export async function invalidateEntitlement(userId) {
  await cacheDel(cacheKeys.entitlement(userId));
}

/** Called whenever the catalogue changes (publish, unpublish, metadata edit, delete). */
export async function invalidateCatalog() {
  await Promise.all([
    cacheDel([cacheKeys.browseRows(), cacheKeys.genres()]),
    cacheDelByPrefix(cacheKeys.titleListPrefix()),
    cacheDelByPrefix(cacheKeys.searchPrefix()),
    cacheDelByPrefix(key('title')),
    cacheDelByPrefix(key('similar')),
  ]);
}

export default cacheKeys;

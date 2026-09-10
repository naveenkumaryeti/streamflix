import { remember } from '../../db/redis.js';
import cacheKeys, { invalidateEntitlement } from '../../utils/cacheKeys.js';
import * as subscriptionsRepo from './subscriptions.repository.js';

/**
 * "Entitlement" is the question playback actually asks: may this person watch, on how
 * many screens, at what quality. It is derived from the live subscription plus its plan,
 * cached for a minute because the player asks on every session start and progress ping.
 */
const TTL_SECONDS = 60;

export const QUALITY_ORDER = ['480p', '720p', '1080p', '4k'];

export const NO_ENTITLEMENT = Object.freeze({
  active: false,
  status: 'none',
  subscriptionId: null,
  planCode: null,
  planName: null,
  maxStreams: 0,
  maxQuality: '480p',
  currentPeriodEnd: null,
  cancelAtPeriodEnd: false,
  inGrace: false,
});

async function load(userId) {
  const sub = await subscriptionsRepo.findLive(userId);
  if (!sub) return { ...NO_ENTITLEMENT };

  // past_due keeps playing until the period ends: a failed retry should not lock someone
  // out mid-episode. The worker flips the row to `expired` once the period is over.
  const inGrace = sub.status === 'past_due';
  return {
    active: ['active', 'trialing', 'past_due'].includes(sub.status),
    status: sub.status,
    subscriptionId: sub.id,
    planCode: sub.planCode,
    planName: sub.planName,
    maxStreams: sub.maxStreams,
    maxQuality: sub.maxQuality,
    currentPeriodEnd: sub.currentPeriodEnd,
    cancelAtPeriodEnd: sub.cancelAtPeriodEnd,
    inGrace,
  };
}

export function getEntitlement(userId) {
  return remember(cacheKeys.entitlement(userId), TTL_SECONDS, () => load(userId));
}

/** Call after any billing change so the next request sees the new plan immediately. */
export async function refreshEntitlement(userId) {
  await invalidateEntitlement(userId);
  return getEntitlement(userId);
}

/**
 * Never offer a rendition above the plan ceiling, even if the asset exists.
 *
 * The two unknown cases are deliberately asymmetric. An unrecognised *plan* ceiling means we
 * cannot enforce anything, so playback continues unfiltered rather than handing the player an
 * empty ladder — a data problem must not look like an outage. An unrecognised *rendition*, on
 * the other hand, cannot be proven to sit under the ceiling, so it is dropped: `indexOf`
 * returns -1 for it, which would otherwise compare as lower than every real quality and let a
 * mobile plan be offered a stream it has not paid for.
 */
export function allowedRenditions(renditions, maxQuality) {
  const ceiling = QUALITY_ORDER.indexOf(maxQuality);
  if (ceiling < 0) return renditions;
  return renditions.filter((r) => {
    const rank = QUALITY_ORDER.indexOf(r.maxQuality ?? r.name);
    return rank >= 0 && rank <= ceiling;
  });
}

export default { getEntitlement, refreshEntitlement, allowedRenditions, NO_ENTITLEMENT, QUALITY_ORDER };

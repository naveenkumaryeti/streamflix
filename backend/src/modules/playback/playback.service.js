import config from '../../config/env.js';
import logger from '../../config/logger.js';
import AppError from '../../utils/AppError.js';
import { signPlaybackToken } from '../../utils/jwt.js';
import cdn from '../../media/cdn/index.js';
import { hlsPrefix } from '../../media/keys.js';
import { allowedRenditions } from '../subscriptions/entitlements.js';
import * as catalogRepo from '../catalog/catalog.repository.js';
import * as playbackRepo from './playback.repository.js';
import * as streamLimit from './streamLimit.js';

/**
 * Playback authorisation.
 *
 * The API never proxies video. It answers one question — "may this account play this title
 * right now, and at what ceiling?" — and returns a short-lived, CDN-level credential.
 * Bytes then flow from CloudFront (or the local media route) straight to the player, which
 * is what keeps a handful of API pods able to serve thousands of concurrent streams.
 */
const RESUME_TAIL_SECONDS = 15;

/** A title is playable if it has real HLS output, a demo manifest, or a configured fallback. */
function resolveSource(title) {
  if (title.hlsKey) return { kind: 'hls', storageKey: title.hlsKey, signed: true };
  if (title.demoManifestUrl) return { kind: 'hls', url: title.demoManifestUrl, signed: false };
  if (config.media.demoHlsUrl) return { kind: 'hls', url: config.media.demoHlsUrl, signed: false };
  return null;
}

export async function start({ user, entitlement, titleId, sessionId }) {
  const title = await catalogRepo.findPlayable(titleId);
  if (!title) throw AppError.notFound('We could not find that title', 'TITLE_NOT_FOUND');

  // Staff can preview their own uploads before publishing; nobody else can.
  if (title.status !== 'published' && user.role !== 'admin') {
    throw AppError.notFound('We could not find that title', 'TITLE_NOT_FOUND');
  }

  const source = resolveSource(title);
  if (!source) {
    throw AppError.conflict('This title is still being processed — try again shortly', 'TITLE_NOT_PLAYABLE');
  }

  const maxQuality = entitlement?.maxQuality ?? '480p';
  const slot = await streamLimit.acquireSlot({
    userId: user.id,
    titleId,
    maxStreams: Math.max(1, entitlement?.maxStreams ?? 1),
    sessionId,
  });

  const token = signPlaybackToken({ userId: user.id, titleId, sessionId: slot.sessionId, maxQuality });
  const delivery = source.signed
    ? cdn.manifestUrl({ storageKey: source.storageKey, prefix: hlsPrefix(titleId), playbackToken: token })
    : { url: source.url, strategy: 'public', cookies: [] };

  const progress = await playbackRepo.getProgress(user.id, titleId).catch(() => null);

  // Advisory counter for the "trending" row; a lost increment costs nothing.
  catalogRepo.bumpPopularity(titleId).catch(() => {});

  return {
    title: {
      id: title.id,
      slug: title.slug,
      title: title.title,
      runtimeSeconds: title.runtimeSeconds,
      posterUrl: title.posterUrl,
      backdropUrl: title.backdropUrl,
    },
    source: {
      type: 'hls',
      url: delivery.url,
      strategy: delivery.strategy,
      cookies: delivery.cookies ?? [],
    },
    playback: {
      token,
      expiresInSeconds: config.tokens.playbackTtlSeconds,
      maxQuality,
      renditions: allowedRenditions(config.media.renditions, maxQuality).map((r) => r.name),
    },
    session: {
      id: slot.sessionId,
      heartbeatSeconds: streamLimit.heartbeatSeconds,
      activeStreams: slot.active,
      maxStreams: slot.maxStreams,
      enforced: slot.enforced,
    },
    resumeAt: resumePosition(progress, title.runtimeSeconds),
    progress,
  };
}

/** Resume a few seconds early, and start over when the title was finished. */
function resumePosition(progress, runtimeSeconds) {
  if (!progress?.positionSeconds) return 0;
  if (progress.completed) return 0;
  if (runtimeSeconds && progress.positionSeconds >= runtimeSeconds - RESUME_TAIL_SECONDS) return 0;
  return Math.max(0, Math.floor(progress.positionSeconds - 5));
}

/**
 * Progress ping. Doubles as the stream-limit heartbeat, so an abandoned tab releases its
 * screen ~90 seconds later without any extra endpoint being called.
 */
export async function ping({ userId, titleId, positionSeconds, durationSeconds, completed, sessionId }) {
  const [beat, progress] = await Promise.all([
    streamLimit.heartbeat({ userId, titleId, sessionId }),
    playbackRepo.saveProgress({ userId, titleId, positionSeconds, durationSeconds, completed }),
  ]);

  return { progress, session: { id: sessionId, alive: beat.ok, expired: Boolean(beat.expired) } };
}

export async function stop({ userId, titleId, positionSeconds, durationSeconds, sessionId }) {
  const results = await Promise.allSettled([
    positionSeconds === undefined
      ? Promise.resolve(null)
      : playbackRepo.saveProgress({ userId, titleId, positionSeconds, durationSeconds }),
    streamLimit.releaseSlot({ userId, titleId, sessionId }),
  ]);

  const failed = results.find((result) => result.status === 'rejected');
  if (failed) logger.warn({ err: failed.reason?.message, userId, titleId }, 'playback stop partially failed');

  return { stopped: true, progress: results[0].status === 'fulfilled' ? results[0].value : null };
}

export function listActiveStreams(userId) {
  return streamLimit.listSlots(userId);
}

export function history(userId, { limit = 20, includeCompleted = true } = {}) {
  return playbackRepo.listRecent(userId, { limit, includeCompleted });
}

export async function forget({ userId, titleId }) {
  await playbackRepo.deleteProgress(userId, titleId);
  return { removed: true, titleId };
}

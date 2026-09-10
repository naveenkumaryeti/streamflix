import config from '../../config/env.js';
import asyncHandler from '../../utils/asyncHandler.js';
import * as playbackService from './playback.service.js';

const PLAYBACK_COOKIE = 'sf_playback';

/**
 * CloudFront cookies must be readable by the CDN host, so they are scoped to the
 * registrable domain shared by api.* and cdn.*. In local mode there is no CDN host and the
 * token already travels in the URL path — the cookie is only a fallback for players that
 * request a segment without the signed prefix.
 */
function cookieDomain() {
  const parts = String(config.cloudfront.domain || '').split('.');
  return parts.length >= 3 ? `.${parts.slice(-2).join('.')}` : undefined;
}

function applyPlaybackCookies(res, { source, playback }) {
  const maxAge = playback.expiresInSeconds * 1000;
  const base = { httpOnly: true, sameSite: 'lax', secure: config.isProduction, maxAge };

  if (config.media.cdnDriver === 'cloudfront') {
    for (const cookie of source.cookies ?? []) {
      res.cookie(cookie.name, cookie.value, { ...base, domain: cookieDomain(), path: '/' });
    }
    return;
  }

  res.cookie(PLAYBACK_COOKIE, playback.token, { ...base, path: '/media' });
}

export const start = asyncHandler(async (req, res) => {
  const result = await playbackService.start({
    user: req.user,
    entitlement: req.entitlement,
    titleId: req.valid.params.titleId,
    sessionId: req.valid.body.sessionId,
  });

  applyPlaybackCookies(res, result);
  res.json(result);
});

export const ping = asyncHandler(async (req, res) => {
  const { positionSeconds, durationSeconds, completed, sessionId } = req.valid.body;
  res.json(
    await playbackService.ping({
      userId: req.user.id,
      titleId: req.valid.params.titleId,
      positionSeconds,
      durationSeconds,
      completed,
      sessionId,
    }),
  );
});

export const stop = asyncHandler(async (req, res) => {
  const { positionSeconds, durationSeconds, sessionId } = req.valid.body;
  const result = await playbackService.stop({
    userId: req.user.id,
    titleId: req.valid.params.titleId,
    positionSeconds,
    durationSeconds,
    sessionId,
  });

  res.clearCookie(PLAYBACK_COOKIE, { path: '/media' });
  res.json(result);
});

export const history = asyncHandler(async (req, res) => {
  const { limit, includeCompleted } = req.valid.query;
  res.json({ items: await playbackService.history(req.user.id, { limit, includeCompleted }) });
});

export const activeStreams = asyncHandler(async (req, res) => {
  res.json({ items: await playbackService.listActiveStreams(req.user.id) });
});

export const forget = asyncHandler(async (req, res) => {
  res.json(await playbackService.forget({ userId: req.user.id, titleId: req.valid.params.titleId }));
});

import { Router } from 'express';
import AppError from '../../utils/AppError.js';
import asyncHandler from '../../utils/asyncHandler.js';
import { verifyPlaybackToken } from '../../utils/jwt.js';
import storage from '../../media/storage/index.js';
import { contentTypeFor, hlsPrefix, isSafeKey } from '../../media/keys.js';

/**
 * Local media delivery — what CloudFront does in production.
 *
 * Mounted outside the API prefix at /media, because these URLs are handed to a video
 * element, not to fetch(): they must work without an Authorization header. Authorisation
 * therefore rides in the path (`/media/t/<playbackToken>/hls/<id>/master.m3u8`), which is
 * inherited by every relative segment URI inside the playlist.
 *
 * In production CDN_DRIVER=cloudfront and none of this is reachable from the internet —
 * the CDN talks to S3 through an origin access control instead.
 */
const router = Router();

const IMMUTABLE = 'public, max-age=31536000, immutable';
const PLAYLIST = 'public, max-age=10';

function readToken(req) {
  return req.params.token && req.params.token !== '-'
    ? req.params.token
    : req.query.token || req.cookies?.sf_playback || null;
}

/** The token authorises one title, so the requested key must sit under that title's prefix. */
function authorise(req) {
  const token = readToken(req);
  if (!token) throw AppError.forbidden('This playback link is no longer valid', 'PLAYBACK_TOKEN_INVALID');

  const payload = verifyPlaybackToken(token);
  const key = String(req.params[0] ?? '');
  if (!isSafeKey(key)) throw AppError.badRequest('That media path is not valid');
  if (!key.startsWith(`${hlsPrefix(payload.titleId)}/`)) {
    throw AppError.forbidden('This playback link is not valid for that file', 'PLAYBACK_SCOPE_MISMATCH');
  }
  return key;
}

async function send(res, key, { cacheControl }) {
  const head = await storage.headObject(key);
  if (!head) throw AppError.notFound('That file is not available', 'MEDIA_NOT_FOUND');

  res.setHeader('Content-Type', contentTypeFor(key));
  res.setHeader('Cache-Control', cacheControl);

  // sendFile gives us Range, ETag and conditional requests for free — seeking depends on it.
  if (typeof storage.localPath === 'function') {
    return new Promise((resolve, reject) => {
      res.sendFile(storage.localPath(key), (err) => (err ? reject(err) : resolve()));
    });
  }

  const body = await storage.getObjectStream(key);
  res.setHeader('Content-Length', String(head.size));
  body.pipe(res);
  return new Promise((resolve, reject) => body.on('end', resolve).on('error', reject));
}

router.get(
  '/t/:token/*',
  asyncHandler(async (req, res) => {
    const key = authorise(req);
    await send(res, key, { cacheControl: key.endsWith('.m3u8') ? PLAYLIST : IMMUTABLE });
  }),
);

/** Artwork: no token, because posters are as public as the marketing pages that show them. */
router.get(
  '/public/*',
  asyncHandler(async (req, res) => {
    const key = String(req.params[0] ?? '');
    if (!isSafeKey(key) || !key.startsWith('images/')) throw AppError.notFound('That file is not available');
    await send(res, key, { cacheControl: 'public, max-age=86400' });
  }),
);

/**
 * Deliberately absent: a static mount over the storage directory. It would be convenient in
 * development and it would also serve `sources/` — the ungated original uploads — which is
 * exactly the mistake the signed prefix above exists to prevent.
 */

export default router;

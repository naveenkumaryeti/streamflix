import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import config from '../config/env.js';
import AppError from './AppError.js';

const ALGO = 'HS256';
const { issuer } = config.tokens;

/** SHA-256 hex digest — refresh tokens are only ever stored hashed. */
export function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

export function signAccessToken(user) {
  const jti = crypto.randomUUID();
  const token = jwt.sign(
    { sub: user.id, email: user.email, role: user.role, typ: 'access', jti },
    config.tokens.accessSecret,
    { algorithm: ALGO, issuer, expiresIn: config.tokens.accessTtl },
  );
  const { exp } = jwt.decode(token);
  return { token, jti, expiresAt: new Date(exp * 1000) };
}

export function verifyAccessToken(token) {
  try {
    const payload = jwt.verify(token, config.tokens.accessSecret, { algorithms: [ALGO], issuer });
    if (payload.typ !== 'access') throw new Error('wrong token type');
    return payload;
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      throw AppError.unauthorized('Your session expired — sign in again', 'TOKEN_EXPIRED');
    }
    throw AppError.unauthorized('That session is not valid', 'TOKEN_INVALID');
  }
}

/**
 * Refresh tokens are rotated on every use. `familyId` ties a chain of rotations together
 * so that replaying an old token can revoke the whole family (stolen-token detection).
 */
export function signRefreshToken({ userId, familyId = crypto.randomUUID() }) {
  const jti = crypto.randomUUID();
  const token = jwt.sign({ sub: userId, typ: 'refresh', jti, fam: familyId }, config.tokens.refreshSecret, {
    algorithm: ALGO,
    issuer,
    expiresIn: config.tokens.refreshTtl,
  });
  const { exp } = jwt.decode(token);
  return { token, jti, familyId, tokenHash: sha256(token), expiresAt: new Date(exp * 1000) };
}

export function verifyRefreshToken(token) {
  try {
    const payload = jwt.verify(token, config.tokens.refreshSecret, { algorithms: [ALGO], issuer });
    if (payload.typ !== 'refresh') throw new Error('wrong token type');
    return payload;
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      throw AppError.unauthorized('Your session expired — sign in again', 'REFRESH_EXPIRED');
    }
    throw AppError.unauthorized('That session is not valid', 'REFRESH_INVALID');
  }
}

/**
 * Short-lived token that authorises playback of one title. In CDN_DRIVER=local mode it is
 * checked by the /media guard; it is the stand-in for a CloudFront signed cookie.
 */
export function signPlaybackToken({ userId, titleId, sessionId, maxQuality }) {
  return jwt.sign({ sub: userId, titleId, sessionId, maxQuality, typ: 'playback' }, config.tokens.playbackSecret, {
    algorithm: ALGO,
    issuer,
    expiresIn: config.tokens.playbackTtlSeconds,
  });
}

export function verifyPlaybackToken(token) {
  try {
    const payload = jwt.verify(token, config.tokens.playbackSecret, { algorithms: [ALGO], issuer });
    if (payload.typ !== 'playback') throw new Error('wrong token type');
    return payload;
  } catch {
    throw AppError.forbidden('This playback link is no longer valid', 'PLAYBACK_TOKEN_INVALID');
  }
}

/** Seconds until a decoded token expires — used as the TTL of its Redis denylist entry. */
export function secondsUntilExpiry(payload) {
  if (!payload?.exp) return 0;
  return Math.max(0, payload.exp - Math.floor(Date.now() / 1000));
}

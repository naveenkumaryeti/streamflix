import { verifyAccessToken } from '../utils/jwt.js';
import { isTokenDenylisted, remember } from '../db/redis.js';
import { cacheKeys } from '../utils/cacheKeys.js';
import AppError from '../utils/AppError.js';
import asyncHandler from '../utils/asyncHandler.js';
import * as usersRepo from '../modules/users/users.repository.js';
import { getEntitlement } from '../modules/subscriptions/entitlements.js';

const USER_CACHE_TTL = 60;

function readBearer(req) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) return null;
  const token = header.slice(7).trim();
  return token || null;
}

// A cached read keeps hot paths (progress pings every few seconds) off Postgres.
const loadUser = (userId) => remember(cacheKeys.user(userId), USER_CACHE_TTL, () => usersRepo.findById(userId));

async function authenticate(req, { optional }) {
  const token = readBearer(req);
  if (!token) {
    if (optional) return null;
    throw AppError.unauthorized('Sign in to continue');
  }

  const payload = verifyAccessToken(token);
  if (await isTokenDenylisted(payload.jti)) {
    throw AppError.unauthorized('You have been signed out', 'TOKEN_REVOKED');
  }

  const user = await loadUser(payload.sub);
  if (!user) throw AppError.unauthorized('That account no longer exists', 'ACCOUNT_MISSING');
  if (user.status !== 'active') {
    throw AppError.forbidden('This account is suspended. Contact support.', 'ACCOUNT_SUSPENDED');
  }

  req.user = user;
  req.tokenPayload = payload;
  req.log?.setBindings?.({ userId: user.id });
  return user;
}

/** Rejects anonymous requests. */
export const requireAuth = asyncHandler(async (req, _res, next) => {
  await authenticate(req, { optional: false });
  next();
});

/** Populates req.user when a token is present, but never rejects. */
export const optionalAuth = asyncHandler(async (req, _res, next) => {
  try {
    await authenticate(req, { optional: true });
  } catch {
    req.user = undefined;
  }
  next();
});

export function requireRole(...roles) {
  return (req, _res, next) => {
    if (!req.user) return next(AppError.unauthorized('Sign in to continue'));
    if (!roles.includes(req.user.role)) {
      return next(AppError.forbidden('This area is limited to StreamFlix staff', 'ADMIN_ONLY'));
    }
    return next();
  };
}

export const requireAdmin = [requireAuth, requireRole('admin')];

/**
 * Playback gate. Staff can always watch (they need to check their own uploads);
 * everyone else needs a live subscription, and the resolved entitlement travels on the
 * request so the playback service knows the stream and quality ceiling.
 */
export const requireActiveSubscription = asyncHandler(async (req, _res, next) => {
  const entitlement = await getEntitlement(req.user.id);
  if (!entitlement.active && req.user.role !== 'admin') {
    return next(AppError.subscriptionRequired());
  }
  req.entitlement = entitlement.active
    ? entitlement
    : { active: true, planCode: 'staff', planName: 'Staff access', maxStreams: 1, maxQuality: '1080p', status: 'staff' };
  return next();
});

export default { requireAuth, optionalAuth, requireAdmin, requireRole, requireActiveSubscription };

import AppError from '../../utils/AppError.js';
import logger from '../../config/logger.js';
import { hashPassword, verifyPassword } from '../../utils/password.js';
import {
  secondsUntilExpiry,
  sha256,
  signAccessToken,
  signRefreshToken,
  verifyRefreshToken,
} from '../../utils/jwt.js';
import { denylistToken } from '../../db/redis.js';
import { invalidateUser } from '../../utils/cacheKeys.js';
import * as usersRepo from '../users/users.repository.js';
import * as tokenRepo from './refreshToken.repository.js';
import * as auditRepo from '../audit/audit.repository.js';
import { getEntitlement } from '../subscriptions/entitlements.js';

// Compared against when the email does not exist, so a wrong email and a wrong password
// take the same amount of time. Otherwise response latency leaks which emails are registered.
const TIMING_EQUALISER_HASH = '$2a$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy';

async function issueTokens(user, { familyId, ip, userAgent }) {
  const access = signAccessToken(user);
  const refresh = signRefreshToken({ userId: user.id, ...(familyId ? { familyId } : {}) });
  await tokenRepo.create({
    userId: user.id,
    tokenHash: refresh.tokenHash,
    familyId: refresh.familyId,
    expiresAt: refresh.expiresAt,
    userAgent,
    ip,
  });
  return {
    accessToken: access.token,
    accessTokenExpiresAt: access.expiresAt,
    refreshToken: refresh.token,
    refreshTokenExpiresAt: refresh.expiresAt,
  };
}

async function session(user, tokens) {
  return { user, ...tokens, entitlement: await getEntitlement(user.id) };
}

export async function register({ email, password, fullName, ip, userAgent }) {
  const existing = await usersRepo.findByEmail(email);
  if (existing) throw AppError.conflict('That email is already registered', 'EMAIL_TAKEN');

  const user = await usersRepo.create({ email, passwordHash: await hashPassword(password), fullName });
  auditRepo.record({ actorId: user.id, action: 'auth.register', entityType: 'user', entityId: user.id, ip });
  logger.info({ userId: user.id }, 'user registered');

  return session(user, await issueTokens(user, { ip, userAgent }));
}

export async function login({ email, password, ip, userAgent }) {
  const found = await usersRepo.findByEmailWithSecret(email);
  const ok = await verifyPassword(password, found?.passwordHash ?? TIMING_EQUALISER_HASH);

  if (!found || !ok) {
    auditRepo.record({ action: 'auth.login_failed', entityType: 'user', metadata: { email }, ip });
    throw AppError.unauthorized('Email or password is incorrect', 'INVALID_CREDENTIALS');
  }
  if (found.status !== 'active') {
    throw AppError.forbidden('This account is suspended. Contact support.', 'ACCOUNT_SUSPENDED');
  }

  const { passwordHash: _ignored, ...user } = found;
  await usersRepo.markLogin(user.id);
  await invalidateUser(user.id);
  auditRepo.record({ actorId: user.id, action: 'auth.login', entityType: 'user', entityId: user.id, ip });

  return session(user, await issueTokens(user, { ip, userAgent }));
}

/**
 * Rotation with reuse detection. Three failure modes are treated differently:
 *  - unknown hash: the token was never issued here (or was pruned) → refuse.
 *  - already-rotated hash: someone is replaying an old token → revoke the whole family.
 *  - expired/revoked row: normal end of life → refuse.
 */
export async function refresh({ token, ip, userAgent }) {
  const payload = verifyRefreshToken(token);
  const tokenHash = sha256(token);
  const row = await tokenRepo.findByHash(tokenHash);

  if (!row) {
    if (payload.fam) await tokenRepo.revokeFamily(payload.fam, 'unknown-token');
    throw AppError.unauthorized('Please sign in again', 'REFRESH_UNKNOWN');
  }

  if (row.revokedAt) {
    const revoked = await tokenRepo.revokeFamily(row.familyId, 'reuse-detected');
    auditRepo.record({
      actorId: row.userId,
      action: 'auth.refresh_reuse',
      entityType: 'user',
      entityId: row.userId,
      metadata: { familyId: row.familyId, revoked },
      ip,
    });
    logger.warn({ userId: row.userId, familyId: row.familyId }, 'refresh token reuse — family revoked');
    throw AppError.unauthorized('Please sign in again', 'REFRESH_REUSED');
  }

  if (new Date(row.expiresAt).getTime() < Date.now()) {
    throw AppError.unauthorized('Your session expired — sign in again', 'REFRESH_EXPIRED');
  }

  const user = await usersRepo.findById(row.userId);
  if (!user || user.status !== 'active') {
    await tokenRepo.revokeFamily(row.familyId, 'account-unavailable');
    throw AppError.unauthorized('Please sign in again', 'ACCOUNT_UNAVAILABLE');
  }

  const tokens = await issueTokens(user, { familyId: row.familyId, ip, userAgent });
  await tokenRepo.markRotated(tokenHash, sha256(tokens.refreshToken));
  return session(user, tokens);
}

/**
 * Logout revokes the refresh token *and* denylists the access token for its remaining
 * lifetime. Without the denylist, a 15-minute window would exist where a "signed out"
 * token still works — which is exactly what a stolen laptop needs.
 */
export async function logout({ userId, refreshToken, accessPayload, everywhere = false, ip }) {
  if (everywhere) {
    await tokenRepo.revokeAllForUser(userId, 'logout-all');
  } else if (refreshToken) {
    await tokenRepo.revokeByHash(sha256(refreshToken), 'logout');
  }

  if (accessPayload?.jti) {
    await denylistToken(accessPayload.jti, secondsUntilExpiry(accessPayload));
  }

  auditRepo.record({
    actorId: userId,
    action: everywhere ? 'auth.logout_all' : 'auth.logout',
    entityType: 'user',
    entityId: userId,
    ip,
  });
  return { revoked: true, everywhere };
}

export async function changePassword({ userId, currentPassword, newPassword, ip }) {
  const secret = await usersRepo.passwordHashFor(userId);
  const ok = await verifyPassword(currentPassword, secret?.passwordHash);
  if (!ok) throw AppError.badRequest('Your current password is not correct', { fields: [{ field: 'currentPassword', message: 'Incorrect password' }] });

  const user = await usersRepo.updatePasswordHash(userId, await hashPassword(newPassword));
  // Changing a password ends every other session — that is the point of changing it.
  const revoked = await tokenRepo.revokeAllForUser(userId, 'password-changed');
  await invalidateUser(userId);
  auditRepo.record({ actorId: userId, action: 'auth.password_changed', entityType: 'user', entityId: userId, metadata: { revoked }, ip });
  return { user, sessionsEnded: revoked };
}

export function listSessions(userId) {
  return tokenRepo.activeSessionsFor(userId);
}


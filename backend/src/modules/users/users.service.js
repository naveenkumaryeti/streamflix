import AppError from '../../utils/AppError.js';
import { invalidateUser } from '../../utils/cacheKeys.js';
import * as usersRepo from './users.repository.js';
import * as tokenRepo from '../auth/refreshToken.repository.js';
import * as auditRepo from '../audit/audit.repository.js';
import * as subscriptionsRepo from '../subscriptions/subscriptions.repository.js';
import { getEntitlement, refreshEntitlement } from '../subscriptions/entitlements.js';

export async function getAccount(userId) {
  const [user, entitlement, subscription, counts] = await Promise.all([
    usersRepo.findById(userId),
    getEntitlement(userId),
    subscriptionsRepo.findLatest(userId),
    usersRepo.counts(userId),
  ]);
  if (!user) throw AppError.notFound('That account no longer exists');
  return { user, entitlement, subscription, counts };
}

export async function updateProfile({ userId, fullName, email, ip }) {
  if (email) {
    const existing = await usersRepo.findByEmail(email);
    if (existing && existing.id !== userId) {
      throw AppError.conflict('That email is already registered', 'EMAIL_TAKEN');
    }
  }

  const user = await usersRepo.updateProfile(userId, { fullName, email });
  await invalidateUser(userId);
  auditRepo.record({
    actorId: userId,
    action: 'user.profile_updated',
    entityType: 'user',
    entityId: userId,
    metadata: { fields: Object.keys({ ...(fullName ? { fullName } : {}), ...(email ? { email } : {}) }) },
    ip,
  });
  return user;
}

/**
 * Account closure is a soft delete: the row stays (payments reference it, and auditors
 * ask "who watched what" long after someone leaves), but the account can no longer sign
 * in, every session dies and the live subscription is canceled immediately.
 */
export async function closeAccount({ userId, ip }) {
  const live = await subscriptionsRepo.findLive(userId);
  if (live) await subscriptionsRepo.markStatus(live.id, 'canceled');

  await usersRepo.setStatus(userId, 'deleted');
  const revoked = await tokenRepo.revokeAllForUser(userId, 'account-closed');
  await invalidateUser(userId);
  await refreshEntitlement(userId);

  auditRepo.record({
    actorId: userId,
    action: 'user.account_closed',
    entityType: 'user',
    entityId: userId,
    metadata: { sessionsEnded: revoked, subscriptionCanceled: Boolean(live) },
    ip,
  });
  return { closed: true, sessionsEnded: revoked };
}

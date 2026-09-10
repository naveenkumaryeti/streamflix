import logger from '../../config/logger.js';
import { withTransaction } from '../../db/postgres.js';
import AppError from '../../utils/AppError.js';
import { paginated, parsePagination } from '../../utils/pagination.js';
import { invalidateCatalog, invalidateUser } from '../../utils/cacheKeys.js';
import * as catalogRepo from '../catalog/catalog.repository.js';
import * as usersRepo from '../users/users.repository.js';
import * as plansRepo from '../subscriptions/plans.repository.js';
import * as subscriptionsRepo from '../subscriptions/subscriptions.repository.js';
import * as paymentsRepo from '../subscriptions/payments.repository.js';
import * as auditRepo from '../audit/audit.repository.js';
import * as mediaService from '../media/media.service.js';
import * as titlesRepo from './titles.repository.js';

/**
 * Admin service — the operator's half of StreamFlix.
 *
 * Everything an admin does that changes what customers can see funnels through here, and
 * every one of those paths does the same three things: write, drop the catalogue cache, and
 * leave an audit row. Forgetting the middle step is how a published title stays invisible
 * for two minutes; forgetting the third is how "who unpublished this?" becomes unanswerable.
 */
const PUBLISHABLE_FROM = new Set(['ready', 'published', 'archived']);

function audit(action, { actorId, entityId, metadata = {}, ip }) {
  return auditRepo.record({ actorId, action, entityType: 'title', entityId, metadata, ip });
}

/** The numbers on the dashboard, gathered concurrently — none of them depend on each other. */
export async function dashboard() {
  const [catalogue, users, subscriptions, revenue, queue] = await Promise.all([
    titlesRepo.stats(),
    usersRepo.stats(),
    subscriptionsRepo.countByStatus(),
    paymentsRepo.monthlyRevenue(6),
    mediaService.queueSnapshot(),
  ]);

  return {
    catalogue,
    users: {
      total: Number(users?.total ?? 0),
      newLast7Days: Number(users?.new_last_7_days ?? 0),
      activeLast30Days: Number(users?.active_last_30_days ?? 0),
      admins: Number(users?.admins ?? 0),
    },
    subscriptions,
    revenue,
    pipeline: queue,
  };
}

export async function listTitles({ query = {} } = {}) {
  const { page, limit, offset } = parsePagination(query, { defaultLimit: 20 });
  const { rows, total } = await titlesRepo.list({
    search: query.search ?? '',
    status: query.status ?? '',
    type: query.type ?? '',
    limit,
    offset,
  });
  return paginated(rows, { total, page, limit });
}

/** The detail view an admin edits against: the row, its media inventory and its newest job. */
export async function getTitle(id) {
  const title = await titlesRepo.findById(id);
  if (!title) throw AppError.notFound('That title does not exist', 'TITLE_NOT_FOUND');
  const media = await mediaService.mediaFor(id);
  return { ...title, media };
}

async function assertSlugFree(slug, exceptId = null) {
  if (!slug) return;
  if (await titlesRepo.slugTaken(slug, exceptId)) {
    throw AppError.conflict(`The address "${slug}" is already used by another title`, 'SLUG_TAKEN');
  }
}

/**
 * A title starts as a `draft` with no video: metadata first, bytes second. That order is what
 * lets an admin prepare a release, hand the upload to someone else, and publish later.
 */
export async function createTitle({ payload, actorId, ip }) {
  const { genres = [], ...fields } = payload;
  await assertSlugFree(fields.slug);

  const title = await withTransaction(async (client) => {
    const created = await titlesRepo.create({ ...fields, createdBy: actorId }, client);
    if (genres.length) await titlesRepo.replaceGenres(created.id, genres, client);
    return titlesRepo.findById(created.id, client);
  });

  audit('title.created', { actorId, entityId: title.id, metadata: { slug: title.slug }, ip });
  logger.info({ titleId: title.id, slug: title.slug }, 'title created');
  return title;
}

export async function updateTitle({ id, patch, actorId, ip }) {
  const existing = await titlesRepo.findById(id);
  if (!existing) throw AppError.notFound('That title does not exist', 'TITLE_NOT_FOUND');

  const { genres, ...fields } = patch;
  if (fields.slug && fields.slug !== existing.slug) await assertSlugFree(fields.slug, id);

  const title = await withTransaction(async (client) => {
    const updated = Object.keys(fields).length ? await titlesRepo.update(id, fields, client) : existing;
    if (genres) await titlesRepo.replaceGenres(id, genres, client);
    return genres ? titlesRepo.findById(id, client) : updated;
  });

  // Published titles are cached; an edit that skipped this would show up minutes later.
  await invalidateCatalog();
  audit('title.updated', { actorId, entityId: id, metadata: { fields: Object.keys(patch) }, ip });
  return title;
}

/**
 * Publishing is the gate between the admin's world and the customer's, so it checks the two
 * things a customer would notice immediately: something to play, and something to look at.
 * `demoManifestUrl` counts as playable — it is how the seeded catalogue works without anyone
 * having to transcode a single file first.
 */
export async function publishTitle({ id, actorId, ip }) {
  const title = await titlesRepo.findById(id);
  if (!title) throw AppError.notFound('That title does not exist', 'TITLE_NOT_FOUND');

  if (!title.hlsKey && !title.demoManifestUrl) {
    throw AppError.badRequest(
      'This title has nothing to play yet — upload a video and run the transcode first',
      'NOT_PLAYABLE',
    );
  }
  if (!PUBLISHABLE_FROM.has(title.status)) {
    throw AppError.badRequest(
      `A title in "${title.status}" cannot be published — wait for processing to finish`,
      'NOT_PUBLISHABLE',
    );
  }
  if (!title.posterUrl) {
    throw AppError.badRequest('Add poster artwork before publishing', 'POSTER_REQUIRED');
  }

  const published = await titlesRepo.publish(id);
  await invalidateCatalog();
  audit('title.published', { actorId, entityId: id, metadata: { slug: published.slug }, ip });
  logger.info({ titleId: id, slug: published.slug }, 'title published');
  return published;
}

export async function unpublishTitle({ id, status = 'ready', actorId, ip }) {
  const title = await titlesRepo.findById(id);
  if (!title) throw AppError.notFound('That title does not exist', 'TITLE_NOT_FOUND');

  const updated = await titlesRepo.unpublish(id, status);
  await invalidateCatalog();
  audit('title.unpublished', { actorId, entityId: id, metadata: { status }, ip });
  return updated;
}

/**
 * Delete removes the storage objects first and the row second. The other order would leave
 * rows pointing at objects that no longer exist if the delete failed halfway; this order can
 * only leave orphaned objects, which the storage report will show and a human can clean up.
 */
export async function deleteTitle({ id, actorId, ip }) {
  const title = await titlesRepo.findById(id);
  if (!title) throw AppError.notFound('That title does not exist', 'TITLE_NOT_FOUND');

  const purged = await mediaService.purge(id);
  const result = await titlesRepo.remove(id);
  await invalidateCatalog();

  audit('title.deleted', { actorId, entityId: id, metadata: { slug: title.slug, ...purged }, ip });
  logger.warn({ titleId: id, slug: title.slug }, 'title deleted');
  return result;
}

/* --------------------------------------------------------------------- people and money */

export async function listUsers({ query = {} } = {}) {
  const { page, limit, offset } = parsePagination(query, { defaultLimit: 20 });
  const { rows, total } = await usersRepo.list({
    search: query.search ?? '',
    role: query.role ?? '',
    status: query.status ?? '',
    limit,
    offset,
  });
  return paginated(rows, { total, page, limit });
}

/**
 * Suspending a user has to invalidate their cached row, otherwise `requireAuth` keeps reading
 * a cached "active" for as long as the TTL lasts and the suspension appears not to work.
 */
export async function setUserStatus({ id, status, actorId, ip }) {
  if (id === actorId && status !== 'active') {
    throw AppError.badRequest('You cannot suspend your own account', 'SELF_SUSPEND');
  }
  const user = await usersRepo.setStatus(id, status);
  if (!user) throw AppError.notFound('That account does not exist', 'USER_NOT_FOUND');

  await invalidateUser(id);
  auditRepo.record({ actorId, action: 'user.status', entityType: 'user', entityId: id, metadata: { status }, ip });
  return user;
}

export async function setUserRole({ id, role, actorId, ip }) {
  if (id === actorId && role !== 'admin') {
    throw AppError.badRequest('You cannot remove your own admin access', 'SELF_DEMOTE');
  }
  const user = await usersRepo.setRole(id, role);
  if (!user) throw AppError.notFound('That account does not exist', 'USER_NOT_FOUND');

  await invalidateUser(id);
  auditRepo.record({ actorId, action: 'user.role', entityType: 'user', entityId: id, metadata: { role }, ip });
  logger.warn({ userId: id, role, actorId }, 'user role changed');
  return user;
}

export async function listPayments({ query = {} } = {}) {
  const { page, limit, offset } = parsePagination(query, { defaultLimit: 30 });
  const { rows, total } = await paymentsRepo.list({ status: query.status ?? '', limit, offset });
  return paginated(rows, { total, page, limit });
}

export async function listAudit({ query = {} } = {}) {
  const { page, limit, offset } = parsePagination(query, { defaultLimit: 50, maxLimit: 100 });
  const { rows, total } = await auditRepo.list({
    action: query.action ?? '',
    actorId: query.actorId ?? '',
    limit,
    offset,
  });
  return paginated(rows, { total, page, limit });
}

/** Reference data the admin forms need: genre slugs and the plans customers can buy. */
export async function formOptions() {
  const [genres, plans] = await Promise.all([catalogRepo.listGenres(), plansRepo.listAll()]);
  return { genres, plans };
}

export default {
  dashboard,
  listTitles,
  getTitle,
  createTitle,
  updateTitle,
  publishTitle,
  unpublishTitle,
  deleteTitle,
  listUsers,
  setUserStatus,
  setUserRole,
  listPayments,
  listAudit,
  formOptions,
};

import { query, queryOne, queryMany } from '../../db/postgres.js';

/** A subscription row is never useful without its plan, so every read joins. */
const COLUMNS = `
  s.id,
  s.user_id                AS "userId",
  s.plan_id                AS "planId",
  s.status,
  s.current_period_start   AS "currentPeriodStart",
  s.current_period_end     AS "currentPeriodEnd",
  s.cancel_at_period_end   AS "cancelAtPeriodEnd",
  s.canceled_at            AS "canceledAt",
  s.trial_end              AS "trialEnd",
  s.provider,
  s.provider_subscription_id AS "providerSubscriptionId",
  s.created_at             AS "createdAt",
  p.code                   AS "planCode",
  p.name                   AS "planName",
  p.price_cents            AS "priceCents",
  p.currency,
  p.max_streams            AS "maxStreams",
  p.max_quality            AS "maxQuality",
  p.features
`;

const LIVE = `('trialing', 'active', 'past_due')`;

// Optional transaction client: billing writes two tables and must not half-apply.
async function one(client, text, params) {
  if (!client) return queryOne(text, params);
  const { rows } = await client.query(text, params);
  return rows[0] ?? null;
}

export function findLive(userId, client = null) {
  return one(
    client,
    `SELECT ${COLUMNS} FROM subscriptions s JOIN plans p ON p.id = s.plan_id
      WHERE s.user_id = $1 AND s.status IN ${LIVE}
      ORDER BY s.created_at DESC LIMIT 1`,
    [userId],
  );
}

export function findById(id, client = null) {
  return one(client, `SELECT ${COLUMNS} FROM subscriptions s JOIN plans p ON p.id = s.plan_id WHERE s.id = $1`, [id]);
}

export function findLatest(userId) {
  return queryOne(
    `SELECT ${COLUMNS} FROM subscriptions s JOIN plans p ON p.id = s.plan_id
      WHERE s.user_id = $1 ORDER BY s.created_at DESC LIMIT 1`,
    [userId],
  );
}

export function historyFor(userId, limit = 20) {
  return queryMany(
    `SELECT ${COLUMNS} FROM subscriptions s JOIN plans p ON p.id = s.plan_id
      WHERE s.user_id = $1 ORDER BY s.created_at DESC LIMIT $2`,
    [userId, limit],
  );
}

export async function create({ userId, planId, status = 'active', periodDays = 30, trialEnd = null, provider = 'mock', providerSubscriptionId = null }, client = null) {
  const row = await one(
    client,
    `INSERT INTO subscriptions (
       user_id, plan_id, status, current_period_start, current_period_end, trial_end, provider, provider_subscription_id
     ) VALUES ($1, $2, $3::subscription_status, now(), now() + ($4 || ' days')::interval, $5, $6, $7)
     RETURNING id`,
    [userId, planId, status, String(periodDays), trialEnd, provider, providerSubscriptionId],
  );
  return findById(row.id, client);
}

/** Plan change keeps the same row: history lives in `payments`, entitlement is current state. */
export async function changePlan(id, planId, client = null) {
  await one(
    client,
    `UPDATE subscriptions
        SET plan_id = $2, status = 'active', cancel_at_period_end = false, canceled_at = NULL,
            current_period_start = now(), current_period_end = now() + interval '30 days'
      WHERE id = $1 RETURNING id`,
    [id, planId],
  );
  return findById(id, client);
}

export async function renew(id, days = 30, client = null) {
  await one(
    client,
    `UPDATE subscriptions
        SET status = 'active',
            current_period_start = now(),
            current_period_end = greatest(current_period_end, now()) + ($2 || ' days')::interval
      WHERE id = $1 RETURNING id`,
    [id, String(days)],
  );
  return findById(id, client);
}

export async function setCancelAtPeriodEnd(id, cancel) {
  await query(
    `UPDATE subscriptions
        SET cancel_at_period_end = $2, canceled_at = CASE WHEN $2 THEN now() ELSE NULL END
      WHERE id = $1`,
    [id, cancel],
  );
  return findById(id);
}

export function markStatus(id, status, client = null) {
  return one(client, 'UPDATE subscriptions SET status = $2::subscription_status WHERE id = $1 RETURNING id', [id, status]);
}

/**
 * Worker sweep: anything whose period ended is either canceled (user asked) or expired.
 * Returns the affected user ids so their cached entitlement can be dropped.
 */
export function expireEnded() {
  return queryMany(
    `UPDATE subscriptions
        SET status = CASE WHEN cancel_at_period_end THEN 'canceled' ELSE 'expired' END::subscription_status
      WHERE status IN ('trialing', 'active', 'past_due')
        AND current_period_end < now()
      RETURNING id, user_id AS "userId", status`,
  );
}

export function countByStatus() {
  return queryMany('SELECT status, count(*) AS count FROM subscriptions GROUP BY status');
}

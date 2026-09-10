import { queryMany, queryOne } from '../../db/postgres.js';

/**
 * Payments are an append-mostly ledger: rows are inserted and then only ever move status.
 * Nothing here stores a card number — only the brand and last four, which is all a receipt
 * needs and all we are willing to be responsible for.
 */
const COLUMNS = `
  p.id,
  p.user_id             AS "userId",
  p.subscription_id     AS "subscriptionId",
  p.plan_id             AS "planId",
  p.amount_cents        AS "amountCents",
  p.currency,
  p.status,
  p.provider,
  p.provider_payment_id AS "providerPaymentId",
  p.idempotency_key     AS "idempotencyKey",
  p.method_brand        AS "methodBrand",
  p.method_last4        AS "methodLast4",
  p.failure_reason      AS "failureReason",
  p.created_at          AS "createdAt",
  pl.code               AS "planCode",
  pl.name               AS "planName"
`;

const FROM = `FROM payments p LEFT JOIN plans pl ON pl.id = p.plan_id`;

async function one(client, text, params) {
  if (!client) return queryOne(text, params);
  const { rows } = await client.query(text, params);
  return rows[0] ?? null;
}

export function findById(id, client = null) {
  return one(client, `SELECT ${COLUMNS} ${FROM} WHERE p.id = $1`, [id]);
}

/** The idempotency check: a retried charge finds its earlier row instead of billing again. */
export function findByIdempotencyKey(idempotencyKey, client = null) {
  return one(client, `SELECT ${COLUMNS} ${FROM} WHERE p.idempotency_key = $1`, [idempotencyKey]);
}

export function findByProviderPaymentId(providerPaymentId) {
  return queryOne(`SELECT ${COLUMNS} ${FROM} WHERE p.provider_payment_id = $1`, [providerPaymentId]);
}

export async function create(
  {
    userId,
    subscriptionId = null,
    planId = null,
    amountCents,
    currency,
    status = 'pending',
    provider = 'mock',
    providerPaymentId = null,
    idempotencyKey,
    methodBrand = null,
    methodLast4 = null,
    failureReason = null,
  },
  client = null,
) {
  const row = await one(
    client,
    `INSERT INTO payments (
       user_id, subscription_id, plan_id, amount_cents, currency, status, provider,
       provider_payment_id, idempotency_key, method_brand, method_last4, failure_reason
     ) VALUES ($1, $2, $3, $4, $5, $6::payment_status, $7, $8, $9, $10, $11, $12)
     ON CONFLICT (idempotency_key) DO NOTHING
     RETURNING id`,
    [
      userId,
      subscriptionId,
      planId,
      amountCents,
      currency,
      status,
      provider,
      providerPaymentId,
      idempotencyKey,
      methodBrand,
      methodLast4,
      failureReason,
    ],
  );

  // DO NOTHING means a concurrent request won the race — return the row it created.
  return row ? findById(row.id, client) : findByIdempotencyKey(idempotencyKey, client);
}

export async function markStatus(id, status, { providerPaymentId, failureReason, subscriptionId } = {}, client = null) {
  await one(
    client,
    `UPDATE payments
        SET status = $2::payment_status,
            provider_payment_id = coalesce($3, provider_payment_id),
            failure_reason = $4,
            subscription_id = coalesce($5, subscription_id)
      WHERE id = $1
      RETURNING id`,
    [id, status, providerPaymentId ?? null, failureReason ?? null, subscriptionId ?? null],
  );
  return findById(id, client);
}

export async function listFor(userId, { limit = 20, offset = 0 } = {}) {
  const rows = await queryMany(`SELECT ${COLUMNS} ${FROM} WHERE p.user_id = $1 ORDER BY p.created_at DESC LIMIT $2 OFFSET $3`, [
    userId,
    limit,
    offset,
  ]);
  const total = await queryOne('SELECT count(*) AS total FROM payments WHERE user_id = $1', [userId]);
  return { rows, total: total?.total ?? 0 };
}

/** Admin ledger view, optionally narrowed to one status. */
export async function list({ status = '', limit = 30, offset = 0 } = {}) {
  const params = [];
  let where = '';
  if (status) {
    params.push(status);
    where = `WHERE p.status = $${params.length}::payment_status`;
  }
  const rows = await queryMany(
    `SELECT ${COLUMNS}, u.email::text AS "userEmail"
       ${FROM} JOIN users u ON u.id = p.user_id
       ${where}
      ORDER BY p.created_at DESC
      LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, limit, offset],
  );
  const total = await queryOne(`SELECT count(*) AS total FROM payments p ${where}`, params);
  return { rows, total: total?.total ?? 0 };
}

/** Monthly gross for the admin revenue chart — succeeded payments only. */
export function monthlyRevenue(months = 6) {
  return queryMany(
    `SELECT date_trunc('month', created_at) AS month,
            sum(amount_cents)              AS "grossCents",
            count(*)                       AS payments
       FROM payments
      WHERE status = 'succeeded' AND created_at > now() - ($1 || ' months')::interval
      GROUP BY 1
      ORDER BY 1`,
    [String(months)],
  );
}

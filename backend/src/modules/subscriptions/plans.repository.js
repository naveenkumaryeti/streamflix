import { query, queryOne, queryMany } from '../../db/postgres.js';

const COLUMNS = `
  id,
  code,
  name,
  description,
  price_cents      AS "priceCents",
  currency,
  billing_interval AS "billingInterval",
  max_streams      AS "maxStreams",
  max_quality      AS "maxQuality",
  features,
  is_active        AS "isActive",
  sort_order       AS "sortOrder"
`;

export function listActive() {
  return queryMany(`SELECT ${COLUMNS} FROM plans WHERE is_active = true ORDER BY sort_order, price_cents`);
}

export function listAll() {
  return queryMany(`SELECT ${COLUMNS} FROM plans ORDER BY sort_order, price_cents`);
}

export function findByCode(code) {
  return queryOne(`SELECT ${COLUMNS} FROM plans WHERE code = $1 AND is_active = true`, [code]);
}

export function findById(id) {
  return queryOne(`SELECT ${COLUMNS} FROM plans WHERE id = $1`, [id]);
}

export function setActive(id, isActive) {
  return queryOne(`UPDATE plans SET is_active = $2 WHERE id = $1 RETURNING ${COLUMNS}`, [id, isActive]);
}

export function updatePrice(id, priceCents) {
  return query('UPDATE plans SET price_cents = $2 WHERE id = $1', [id, priceCents]);
}

import { query, queryMany, queryOne } from '../../db/postgres.js';
import logger from '../../config/logger.js';

/**
 * Audit trail. Deliberately fire-and-forget: an audit write must never be the reason a
 * login or a publish fails. Kept in Postgres rather than only in CloudWatch because log
 * groups expire and compliance questions arrive months later.
 */
export function record({ actorId = null, action, entityType = null, entityId = null, metadata = {}, ip = null }) {
  return query(
    `INSERT INTO audit_logs (actor_id, action, entity_type, entity_id, metadata, ip)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6)`,
    [actorId, action, entityType, entityId ? String(entityId) : null, JSON.stringify(metadata ?? {}), ip],
  ).catch((err) => {
    logger.warn({ err: err.message, action }, 'audit write failed');
    return null;
  });
}

export async function list({ action = '', actorId = '', limit = 50, offset = 0 } = {}) {
  const filters = ['1 = 1'];
  const params = [];
  if (action) {
    params.push(`${action}%`);
    filters.push(`a.action ILIKE $${params.length}`);
  }
  if (actorId) {
    params.push(actorId);
    filters.push(`a.actor_id = $${params.length}`);
  }
  const where = filters.join(' AND ');

  const rows = await queryMany(
    `SELECT a.id,
            a.action,
            a.entity_type AS "entityType",
            a.entity_id   AS "entityId",
            a.metadata,
            a.ip::text    AS ip,
            a.created_at  AS "createdAt",
            u.email::text AS "actorEmail"
       FROM audit_logs a
       LEFT JOIN users u ON u.id = a.actor_id
      WHERE ${where}
      ORDER BY a.created_at DESC
      LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, limit, offset],
  );
  const total = await queryOne(`SELECT count(*) AS total FROM audit_logs a WHERE ${where}`, params);
  return { rows, total: total?.total ?? 0 };
}

export default { record, list };

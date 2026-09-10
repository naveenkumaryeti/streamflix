import { query, queryOne, queryMany } from '../../db/postgres.js';

/**
 * Refresh tokens: stored as SHA-256 hashes, one row per issued token, grouped into a
 * `family` per login. Rotation inserts a new row and marks the old one replaced.
 *
 * If a token that was already rotated shows up again, the only two explanations are a
 * buggy client or a stolen token — so the whole family is revoked and the user has to
 * sign in again. This is the standard refresh-token-reuse detection pattern.
 */
export function create({ userId, tokenHash, familyId, expiresAt, userAgent = null, ip = null }) {
  return queryOne(
    `INSERT INTO refresh_tokens (user_id, token_hash, family_id, expires_at, user_agent, ip)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id, family_id AS "familyId", expires_at AS "expiresAt"`,
    [userId, tokenHash, familyId, expiresAt, userAgent ? String(userAgent).slice(0, 300) : null, ip],
  );
}

export function findByHash(tokenHash) {
  return queryOne(
    `SELECT id,
            user_id          AS "userId",
            token_hash       AS "tokenHash",
            family_id        AS "familyId",
            expires_at       AS "expiresAt",
            revoked_at       AS "revokedAt",
            revoked_reason   AS "revokedReason",
            replaced_by_hash AS "replacedByHash"
       FROM refresh_tokens WHERE token_hash = $1`,
    [tokenHash],
  );
}

export function markRotated(tokenHash, replacedByHash) {
  return query(
    `UPDATE refresh_tokens
        SET revoked_at = now(), revoked_reason = 'rotated', replaced_by_hash = $2
      WHERE token_hash = $1 AND revoked_at IS NULL`,
    [tokenHash, replacedByHash],
  );
}

export function revokeByHash(tokenHash, reason = 'logout') {
  return query(
    `UPDATE refresh_tokens SET revoked_at = now(), revoked_reason = $2
      WHERE token_hash = $1 AND revoked_at IS NULL`,
    [tokenHash, reason],
  );
}

export async function revokeFamily(familyId, reason = 'reuse-detected') {
  const { rowCount } = await query(
    `UPDATE refresh_tokens SET revoked_at = now(), revoked_reason = $2
      WHERE family_id = $1 AND revoked_at IS NULL`,
    [familyId, reason],
  );
  return rowCount;
}

export async function revokeAllForUser(userId, reason = 'logout-all') {
  const { rowCount } = await query(
    `UPDATE refresh_tokens SET revoked_at = now(), revoked_reason = $2
      WHERE user_id = $1 AND revoked_at IS NULL`,
    [userId, reason],
  );
  return rowCount;
}

export function activeSessionsFor(userId) {
  return queryMany(
    `SELECT id, family_id AS "familyId", user_agent AS "userAgent", ip::text AS ip,
            created_at AS "createdAt", expires_at AS "expiresAt"
       FROM refresh_tokens
      WHERE user_id = $1 AND revoked_at IS NULL AND expires_at > now()
      ORDER BY created_at DESC`,
    [userId],
  );
}

/** Housekeeping for the worker: expired rows are worthless and the table only grows. */
export async function deleteExpired({ olderThanDays = 7 } = {}) {
  const { rowCount } = await query(
    `DELETE FROM refresh_tokens
      WHERE expires_at < now() - ($1 || ' days')::interval
         OR (revoked_at IS NOT NULL AND revoked_at < now() - ($1 || ' days')::interval)`,
    [String(olderThanDays)],
  );
  return rowCount;
}

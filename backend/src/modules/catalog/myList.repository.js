import { query, queryMany, queryOne } from '../../db/postgres.js';
import { projections } from './catalog.repository.js';

const { CARD, GENRES_LATERAL } = projections;

/**
 * "My list" is a plain join table in Postgres, not DynamoDB: it is small, read as a set,
 * and needs to be joined against the catalogue on every read — a relational access pattern.
 */
export async function add(userId, titleId) {
  const { rowCount } = await query(
    'INSERT INTO my_list (user_id, title_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
    [userId, titleId],
  );
  return { added: rowCount > 0, inList: true };
}

export async function remove(userId, titleId) {
  const { rowCount } = await query('DELETE FROM my_list WHERE user_id = $1 AND title_id = $2', [userId, titleId]);
  return { removed: rowCount > 0, inList: false };
}

export async function has(userId, titleId) {
  const row = await queryOne('SELECT 1 AS present FROM my_list WHERE user_id = $1 AND title_id = $2', [
    userId,
    titleId,
  ]);
  return Boolean(row);
}

export async function list(userId, { limit = 24, offset = 0 } = {}) {
  const rows = await queryMany(
    `SELECT ${CARD}, ml.created_at AS "addedAt"
       FROM my_list ml
       JOIN titles t ON t.id = ml.title_id
       ${GENRES_LATERAL}
      WHERE ml.user_id = $1 AND t.status = 'published'
      ORDER BY ml.created_at DESC
      LIMIT $2 OFFSET $3`,
    [userId, limit, offset],
  );
  const total = await queryOne(
    `SELECT count(*) AS total FROM my_list ml JOIN titles t ON t.id = ml.title_id
      WHERE ml.user_id = $1 AND t.status = 'published'`,
    [userId],
  );
  return { rows, total: total?.total ?? 0 };
}

/**
 * Which of these titles are already in the list — one query for a whole row of posters,
 * so the UI can render the +/✓ state without N round trips.
 */
export async function filterInList(userId, titleIds = []) {
  if (!userId || !titleIds.length) return new Set();
  const rows = await queryMany(
    'SELECT title_id AS "titleId" FROM my_list WHERE user_id = $1 AND title_id = ANY($2::uuid[])',
    [userId, titleIds],
  );
  return new Set(rows.map((row) => row.titleId));
}

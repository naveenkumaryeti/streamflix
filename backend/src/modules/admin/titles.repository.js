import { query, queryMany, queryOne } from '../../db/postgres.js';
import { projections } from '../catalog/catalog.repository.js';

/**
 * The catalogue **write** model.
 *
 * Reads live in catalog.repository.js and are filtered to `status = 'published'`; this file
 * is the only place that changes a title, and it deliberately sees every status — an admin
 * has to be able to look at the draft that failed to transcode.
 */
const ADMIN = `
  ${projections.DETAIL},
  t.hls_key           AS "hlsKey",
  t.demo_manifest_url AS "demoManifestUrl",
  t.created_by        AS "createdBy"
`;

/**
 * Column allowlist for partial updates. A patch is built from this map, so an unexpected
 * key in a request body cannot reach the SQL at all — the schema rejects it first, and this
 * is the second lock on the same door.
 */
const COLUMNS = {
  slug: { column: 'slug' },
  title: { column: 'title' },
  synopsis: { column: 'synopsis' },
  type: { column: 'type', cast: '::title_type' },
  status: { column: 'status', cast: '::title_status' },
  releaseYear: { column: 'release_year' },
  runtimeSeconds: { column: 'runtime_seconds' },
  maturityRating: { column: 'maturity_rating' },
  language: { column: 'language' },
  country: { column: 'country' },
  director: { column: 'director' },
  cast: { column: 'cast_members', cast: '::text[]' },
  tags: { column: 'tags', cast: '::text[]' },
  posterUrl: { column: 'poster_url' },
  backdropUrl: { column: 'backdrop_url' },
  trailerUrl: { column: 'trailer_url' },
  hlsKey: { column: 'hls_key' },
  demoManifestUrl: { column: 'demo_manifest_url' },
  isFeatured: { column: 'is_featured' },
  averageRating: { column: 'average_rating' },
  popularity: { column: 'popularity' },
};

async function one(client, text, params) {
  if (!client) return queryOne(text, params);
  const { rows } = await client.query(text, params);
  return rows[0] ?? null;
}

export function findById(id, client = null) {
  return one(client, `SELECT ${ADMIN} FROM titles t ${projections.GENRES_LATERAL} WHERE t.id = $1`, [id]);
}

export function findBySlug(slug) {
  return queryOne(`SELECT ${ADMIN} FROM titles t ${projections.GENRES_LATERAL} WHERE t.slug = $1`, [slug]);
}

export async function slugTaken(slug, exceptId = null) {
  const row = await queryOne('SELECT 1 AS hit FROM titles WHERE slug = $1 AND ($2::uuid IS NULL OR id <> $2)', [
    slug,
    exceptId,
  ]);
  return Boolean(row);
}

export async function create({ slug, title, createdBy, ...rest }, client = null) {
  const row = await one(
    client,
    `INSERT INTO titles (slug, title, created_by) VALUES ($1, $2, $3) RETURNING id`,
    [slug, title, createdBy ?? null],
  );
  const patched = Object.keys(rest).length ? await update(row.id, rest, client) : await findById(row.id, client);
  return patched;
}

/** Partial update: only the keys present in `patch` are written. */
export async function update(id, patch = {}, client = null) {
  const sets = [];
  const params = [id];

  for (const [key, value] of Object.entries(patch)) {
    const spec = COLUMNS[key];
    if (!spec || value === undefined) continue;
    params.push(value);
    sets.push(`${spec.column} = $${params.length}${spec.cast ?? ''}`);
  }

  if (!sets.length) return findById(id, client);
  await one(client, `UPDATE titles SET ${sets.join(', ')} WHERE id = $1 RETURNING id`, params);
  return findById(id, client);
}

export function setStatus(id, status, client = null) {
  return update(id, { status }, client);
}

/**
 * Publish is the one status change with a side effect on a second column: `published_at`
 * is set once and then left alone, so "new on StreamFlix" ordering survives an unpublish
 * and re-publish.
 */
export async function publish(id) {
  await query(
    `UPDATE titles SET status = 'published', published_at = coalesce(published_at, now()) WHERE id = $1`,
    [id],
  );
  return findById(id);
}

export async function unpublish(id, status = 'ready') {
  await query('UPDATE titles SET status = $2::title_status WHERE id = $1', [id, status]);
  return findById(id);
}

/** Replaces the genre set in one statement pair; unknown slugs are simply ignored. */
export async function replaceGenres(id, slugs = [], client = null) {
  const run = client ? (text, params) => client.query(text, params) : (text, params) => query(text, params);
  await run('DELETE FROM title_genres WHERE title_id = $1', [id]);
  if (!slugs.length) return [];
  await run(
    `INSERT INTO title_genres (title_id, genre_id)
     SELECT $1, g.id FROM genres g WHERE g.slug = ANY($2::text[]) ON CONFLICT DO NOTHING`,
    [id, slugs],
  );
  return slugs;
}

export async function remove(id) {
  // Assets and transcode jobs cascade; storage objects are deleted by the service.
  const { rowCount } = await query('DELETE FROM titles WHERE id = $1', [id]);
  return { deleted: rowCount > 0 };
}

/**
 * Admin list. Unlike the public list it defaults to *no* status filter and orders by
 * `updated_at`, because the row an admin wants is almost always the one they just touched.
 * The lateral carries the newest transcode job so the table can show a progress bar.
 */
export async function list({ search = '', status = '', type = '', limit = 20, offset = 0 } = {}) {
  const filters = ['1 = 1'];
  const params = [];

  if (search) {
    params.push(`%${search}%`);
    filters.push(`(t.title ILIKE $${params.length} OR t.slug ILIKE $${params.length})`);
  }
  if (status) {
    params.push(status);
    filters.push(`t.status = $${params.length}::title_status`);
  }
  if (type) {
    params.push(type);
    filters.push(`t.type = $${params.length}::title_type`);
  }
  const where = filters.join(' AND ');

  const rows = await queryMany(
    `SELECT ${projections.CARD},
            t.updated_at   AS "updatedAt",
            t.published_at AS "publishedAt",
            t.hls_key      AS "hlsKey",
            job.status     AS "jobStatus",
            job.progress   AS "jobProgress",
            job.error_message AS "jobError"
       FROM titles t
       ${projections.GENRES_LATERAL}
       LEFT JOIN LATERAL (
         SELECT status, progress, error_message FROM transcode_jobs
          WHERE title_id = t.id ORDER BY created_at DESC LIMIT 1
       ) job ON true
      WHERE ${where}
      ORDER BY t.updated_at DESC
      LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, limit, offset],
  );

  const total = await queryOne(`SELECT count(*) AS total FROM titles t WHERE ${where}`, params);
  return { rows, total: total?.total ?? 0 };
}

/** Dashboard counters. The view keeps the aggregate SQL in the schema, not in the app. */
export function stats() {
  return queryOne(`
    SELECT total_titles          AS "totalTitles",
           published_titles      AS "publishedTitles",
           processing_titles     AS "processingTitles",
           draft_titles          AS "draftTitles",
           failed_titles         AS "failedTitles",
           total_runtime_seconds AS "totalRuntimeSeconds"
      FROM admin_catalogue_stats
  `);
}

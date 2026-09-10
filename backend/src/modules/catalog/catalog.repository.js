import { queryMany, queryOne } from '../../db/postgres.js';

/**
 * Catalogue reads. Two projections only:
 *   CARD   — what a poster in a row needs (browse, search, my list)
 *   DETAIL — CARD plus the long-form fields the title page shows
 *
 * Genres are aggregated in a LATERAL rather than with a GROUP BY over the join, so the
 * row count never depends on how many genres a title has and LIMIT means what it says.
 */
const GENRES_LATERAL = `
  LEFT JOIN LATERAL (
    SELECT array_agg(g.name ORDER BY g.sort_order) AS names,
           array_agg(g.slug ORDER BY g.sort_order) AS slugs
      FROM title_genres tg
      JOIN genres g ON g.id = tg.genre_id
     WHERE tg.title_id = t.id
  ) gg ON true
`;

const CARD = `
  t.id,
  t.slug,
  t.title,
  t.type,
  t.status,
  t.release_year                    AS "releaseYear",
  t.runtime_seconds                 AS "runtimeSeconds",
  t.maturity_rating                 AS "maturityRating",
  t.language,
  t.poster_url                      AS "posterUrl",
  t.backdrop_url                    AS "backdropUrl",
  t.average_rating                  AS "averageRating",
  t.popularity,
  t.is_featured                     AS "isFeatured",
  coalesce(gg.names, '{}')          AS genres,
  coalesce(gg.slugs, '{}')          AS "genreSlugs",
  (t.hls_key IS NOT NULL OR t.demo_manifest_url IS NOT NULL) AS playable
`;

const DETAIL = `
  ${CARD},
  t.synopsis,
  t.director,
  t.cast_members  AS "cast",
  t.tags,
  t.country,
  t.trailer_url   AS "trailerUrl",
  t.published_at  AS "publishedAt",
  t.created_at    AS "createdAt",
  t.updated_at    AS "updatedAt"
`;

const SORTS = {
  popular: 't.popularity DESC, t.published_at DESC NULLS LAST',
  newest: 't.published_at DESC NULLS LAST, t.release_year DESC',
  rating: 't.average_rating DESC, t.popularity DESC',
  title: 't.title ASC',
  year: 't.release_year DESC NULLS LAST, t.popularity DESC',
};

export function findPublishedBySlug(slug) {
  return queryOne(
    `SELECT ${DETAIL} FROM titles t ${GENRES_LATERAL} WHERE t.slug = $1 AND t.status = 'published'`,
    [slug],
  );
}

/** Admin/internal read: any status, by id or slug. */
export function findAny(idOrSlug) {
  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(idOrSlug));
  return queryOne(
    `SELECT ${DETAIL}, t.hls_key AS "hlsKey", t.demo_manifest_url AS "demoManifestUrl"
       FROM titles t ${GENRES_LATERAL}
      WHERE ${isUuid ? 't.id = $1' : 't.slug = $1'}`,
    [idOrSlug],
  );
}

/** Everything playback needs to build a manifest URL, and nothing else. */
export function findPlayable(titleId) {
  return queryOne(
    `SELECT t.id, t.slug, t.title, t.status, t.runtime_seconds AS "runtimeSeconds",
            t.hls_key AS "hlsKey", t.demo_manifest_url AS "demoManifestUrl",
            t.backdrop_url AS "backdropUrl", t.poster_url AS "posterUrl"
       FROM titles t WHERE t.id = $1`,
    [titleId],
  );
}

export async function listPublished({
  genre = '',
  type = '',
  language = '',
  year = null,
  sort = 'popular',
  limit = 24,
  offset = 0,
} = {}) {
  const filters = [`t.status = 'published'`];
  const params = [];

  if (genre) {
    params.push(genre);
    filters.push(`EXISTS (SELECT 1 FROM title_genres tg JOIN genres g ON g.id = tg.genre_id
                           WHERE tg.title_id = t.id AND g.slug = $${params.length})`);
  }
  if (type) {
    params.push(type);
    filters.push(`t.type = $${params.length}::title_type`);
  }
  if (language) {
    params.push(language);
    filters.push(`t.language = $${params.length}`);
  }
  if (year) {
    params.push(year);
    filters.push(`t.release_year = $${params.length}`);
  }

  const where = filters.join(' AND ');
  const rows = await queryMany(
    `SELECT ${CARD} FROM titles t ${GENRES_LATERAL}
      WHERE ${where}
      ORDER BY ${SORTS[sort] ?? SORTS.popular}
      LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, limit, offset],
  );
  const total = await queryOne(`SELECT count(*) AS total FROM titles t WHERE ${where}`, params);
  return { rows, total: total?.total ?? 0 };
}

/**
 * Search is deliberately three-pronged:
 *   1. the generated tsvector (weighted title > director > synopsis) for real matches,
 *   2. trigram similarity on the title so "nightshfit" still finds Nightshift,
 *   3. an ILIKE over cast_members, which cannot live in the tsvector because
 *      array_to_string() is not IMMUTABLE and generated columns require immutability.
 */
export async function search({ q, limit = 24, offset = 0 }) {
  const params = [q, limit, offset];
  const rows = await queryMany(
    `WITH needle AS (
       SELECT websearch_to_tsquery('english', $1) AS ts, $1::text AS raw
     )
     SELECT ${CARD},
            ts_rank(t.search_document, n.ts)                    AS "textRank",
            similarity(t.title, n.raw)                           AS "fuzzyRank"
       FROM titles t
       CROSS JOIN needle n
       ${GENRES_LATERAL}
      WHERE t.status = 'published'
        AND (
          t.search_document @@ n.ts
          OR t.title % n.raw
          OR t.title ILIKE '%' || n.raw || '%'
          OR EXISTS (SELECT 1 FROM unnest(t.cast_members) AS member WHERE member ILIKE '%' || n.raw || '%')
          OR EXISTS (SELECT 1 FROM unnest(t.tags) AS tag WHERE tag ILIKE '%' || n.raw || '%')
        )
      ORDER BY (t.search_document @@ n.ts) DESC,
               ts_rank(t.search_document, n.ts) DESC,
               similarity(t.title, n.raw) DESC,
               t.popularity DESC
      LIMIT $2 OFFSET $3`,
    params,
  );

  const total = await queryOne(
    `WITH needle AS (SELECT websearch_to_tsquery('english', $1) AS ts, $1::text AS raw)
     SELECT count(*) AS total
       FROM titles t CROSS JOIN needle n
      WHERE t.status = 'published'
        AND (
          t.search_document @@ n.ts
          OR t.title % n.raw
          OR t.title ILIKE '%' || n.raw || '%'
          OR EXISTS (SELECT 1 FROM unnest(t.cast_members) AS member WHERE member ILIKE '%' || n.raw || '%')
          OR EXISTS (SELECT 1 FROM unnest(t.tags) AS tag WHERE tag ILIKE '%' || n.raw || '%')
        )`,
    [q],
  );
  return { rows, total: total?.total ?? 0 };
}

/** Typeahead: cheap projection, capped, ordered by how well the prefix matches. */
export function suggest(q, limit = 8) {
  return queryMany(
    `SELECT t.id, t.slug, t.title, t.type, t.release_year AS "releaseYear", t.poster_url AS "posterUrl"
       FROM titles t
      WHERE t.status = 'published'
        AND (t.title ILIKE $1 || '%' OR t.title ILIKE '%' || $1 || '%')
      ORDER BY (t.title ILIKE $1 || '%') DESC, t.popularity DESC
      LIMIT $2`,
    [q, limit],
  );
}

/**
 * "More like this": ranked by how many genres are shared, then popularity.
 * A content-based recommendation this simple is honest about what it is — and it is the
 * shape a real recommender would replace without changing the API.
 */
export function similar(titleId, limit = 12) {
  return queryMany(
    `WITH source AS (
       SELECT array_agg(genre_id) AS genre_ids FROM title_genres WHERE title_id = $1
     )
     SELECT ${CARD},
            (SELECT count(*) FROM title_genres tg2, source s
              WHERE tg2.title_id = t.id AND tg2.genre_id = ANY(s.genre_ids)) AS "sharedGenres"
       FROM titles t ${GENRES_LATERAL}
      WHERE t.status = 'published' AND t.id <> $1
      ORDER BY "sharedGenres" DESC, t.popularity DESC
      LIMIT $2`,
    [titleId, limit],
  );
}

/** Continue watching: DynamoDB knows the ids and the order, Postgres has the metadata. */
export function listByIds(ids = []) {
  if (!ids.length) return Promise.resolve([]);
  return queryMany(
    `SELECT ${CARD} FROM titles t ${GENRES_LATERAL}
      WHERE t.id = ANY($1::uuid[]) AND t.status = 'published'`,
    [ids],
  );
}

export function featured(limit = 5) {
  return queryMany(
    `SELECT ${DETAIL} FROM titles t ${GENRES_LATERAL}
      WHERE t.status = 'published' AND t.is_featured = true
      ORDER BY t.popularity DESC LIMIT $1`,
    [limit],
  );
}

export function trending(limit = 12) {
  return queryMany(
    `SELECT ${CARD} FROM titles t ${GENRES_LATERAL}
      WHERE t.status = 'published' ORDER BY t.popularity DESC LIMIT $1`,
    [limit],
  );
}

export function newReleases(limit = 12) {
  return queryMany(
    `SELECT ${CARD} FROM titles t ${GENRES_LATERAL}
      WHERE t.status = 'published'
      ORDER BY t.published_at DESC NULLS LAST, t.release_year DESC LIMIT $1`,
    [limit],
  );
}

export function topRated(limit = 12) {
  return queryMany(
    `SELECT ${CARD} FROM titles t ${GENRES_LATERAL}
      WHERE t.status = 'published' AND t.average_rating > 0
      ORDER BY t.average_rating DESC, t.popularity DESC LIMIT $1`,
    [limit],
  );
}

export function byGenre(slug, limit = 12) {
  return queryMany(
    `SELECT ${CARD} FROM titles t ${GENRES_LATERAL}
      WHERE t.status = 'published'
        AND EXISTS (SELECT 1 FROM title_genres tg JOIN genres g ON g.id = tg.genre_id
                     WHERE tg.title_id = t.id AND g.slug = $1)
      ORDER BY t.popularity DESC LIMIT $2`,
    [slug, limit],
  );
}

/** Genres with a published count — the ones with nothing to show are not offered. */
export function listGenres() {
  return queryMany(
    `SELECT g.id, g.name, g.slug, g.sort_order AS "sortOrder", count(t.id) AS "titleCount"
       FROM genres g
       LEFT JOIN title_genres tg ON tg.genre_id = g.id
       LEFT JOIN titles t ON t.id = tg.title_id AND t.status = 'published'
      GROUP BY g.id
      ORDER BY g.sort_order, g.name`,
  );
}

/** Filter facets for the browse sidebar. */
export function facets() {
  return queryOne(
    `SELECT (SELECT array_agg(DISTINCT language ORDER BY language)
               FROM titles WHERE status = 'published')                        AS languages,
            (SELECT array_agg(DISTINCT release_year ORDER BY release_year DESC)
               FROM titles WHERE status = 'published' AND release_year IS NOT NULL) AS years,
            (SELECT array_agg(DISTINCT maturity_rating ORDER BY maturity_rating)
               FROM titles WHERE status = 'published')                         AS "maturityRatings"`,
  );
}

/** Shared so sibling repositories (my list) select exactly the same card shape. */
export const projections = { CARD, DETAIL, GENRES_LATERAL, SORTS };

/** Popularity is the only counter we bump on view; it is advisory, so no transaction. */
export function bumpPopularity(titleId, amount = 1) {
  return queryOne('UPDATE titles SET popularity = popularity + $2 WHERE id = $1 RETURNING popularity', [
    titleId,
    amount,
  ]);
}

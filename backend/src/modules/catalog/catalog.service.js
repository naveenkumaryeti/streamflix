import crypto from 'node:crypto';
import config from '../../config/env.js';
import AppError from '../../utils/AppError.js';
import { remember } from '../../db/redis.js';
import cacheKeys from '../../utils/cacheKeys.js';
import { paginated, parsePagination } from '../../utils/pagination.js';
import * as catalogRepo from './catalog.repository.js';
import * as myListRepo from './myList.repository.js';
import * as playbackRepo from '../playback/playback.repository.js';

const ROWS_TTL = config.redis.defaultTtl;
const LIST_TTL = 60;

// Cache keys have to be a pure function of the query, or two different filters share a row.
const fingerprint = (obj) =>
  crypto.createHash('sha1').update(JSON.stringify(obj, Object.keys(obj).sort())).digest('hex').slice(0, 16);

/** Adds `inList` to a set of cards with a single extra query (or none when anonymous). */
async function decorateWithList(userId, cards) {
  if (!userId || !cards.length) return cards.map((card) => ({ ...card, inList: false }));
  const inList = await myListRepo.filterInList(userId, cards.map((card) => card.id));
  return cards.map((card) => ({ ...card, inList: inList.has(card.id) }));
}

/**
 * The browse page is the most-requested endpoint in the product, and identical for every
 * signed-in user — so the expensive part (six catalogue queries) is cached under one key
 * and only the per-user parts (continue watching, my-list flags) are computed per request.
 */
export async function browse({ userId } = {}) {
  const shared = await remember(cacheKeys.browseRows(), ROWS_TTL, async () => {
    const [hero, trending, fresh, top, genres] = await Promise.all([
      catalogRepo.featured(5),
      catalogRepo.trending(14),
      catalogRepo.newReleases(14),
      catalogRepo.topRated(14),
      catalogRepo.listGenres(),
    ]);

    const populated = genres.filter((genre) => Number(genre.titleCount) > 0).slice(0, 6);
    const genreRows = await Promise.all(
      populated.map(async (genre) => ({
        key: `genre:${genre.slug}`,
        title: genre.name,
        genreSlug: genre.slug,
        items: await catalogRepo.byGenre(genre.slug, 14),
      })),
    );

    return {
      hero,
      genres,
      rows: [
        { key: 'trending', title: 'Trending now', items: trending },
        { key: 'new', title: 'New on StreamFlix', items: fresh },
        { key: 'top', title: 'Highest rated', items: top },
        ...genreRows.filter((row) => row.items.length > 0),
      ],
    };
  });

  const continueWatching = userId ? await continueWatchingFor(userId) : [];
  const rows = await Promise.all(
    shared.rows.map(async (row) => ({ ...row, items: await decorateWithList(userId, row.items) })),
  );

  return {
    hero: await decorateWithList(userId, shared.hero),
    genres: shared.genres,
    rows: continueWatching.length
      ? [{ key: 'continue', title: 'Continue watching', items: continueWatching }, ...rows]
      : rows,
  };
}

/**
 * DynamoDB holds the positions and the ordering; Postgres holds the metadata. Titles that
 * were unpublished since they were watched simply drop out of the row.
 */
export async function continueWatchingFor(userId, limit = 12) {
  let progress = [];
  try {
    progress = await playbackRepo.listRecent(userId, { limit });
  } catch {
    // Watch progress is a nice-to-have on the browse page; never fail the page for it.
    return [];
  }
  if (!progress.length) return [];

  const cards = await catalogRepo.listByIds(progress.map((entry) => entry.titleId));
  const byId = new Map(cards.map((card) => [card.id, card]));
  const ordered = progress
    .filter((entry) => byId.has(entry.titleId))
    .map((entry) => ({ ...byId.get(entry.titleId), progress: entry }));
  return decorateWithList(userId, ordered);
}

export async function listTitles({ query, userId }) {
  const { page, limit, offset } = parsePagination(query);
  const filters = {
    genre: query.genre ?? '',
    type: query.type ?? '',
    language: query.language ?? '',
    year: query.year ?? null,
    sort: query.sort ?? 'popular',
  };

  const { rows, total } = await remember(cacheKeys.titleList(fingerprint({ ...filters, page, limit })), LIST_TTL, () =>
    catalogRepo.listPublished({ ...filters, limit, offset }),
  );

  return paginated(await decorateWithList(userId, rows), { total, page, limit });
}

export async function getTitleBySlug({ slug, userId }) {
  const title = await remember(cacheKeys.title(slug), LIST_TTL, () => catalogRepo.findPublishedBySlug(slug));
  if (!title) throw AppError.notFound('We could not find that title', 'TITLE_NOT_FOUND');

  const [similar, inList, progress] = await Promise.all([
    remember(cacheKeys.similar(title.id), ROWS_TTL, () => catalogRepo.similar(title.id, 12)),
    userId ? myListRepo.has(userId, title.id) : false,
    userId ? playbackRepo.getProgress(userId, title.id).catch(() => null) : null,
  ]);

  return {
    title: { ...title, inList },
    similar: await decorateWithList(userId, similar),
    progress,
  };
}

export async function searchTitles({ q, query, userId }) {
  const { page, limit, offset } = parsePagination(query);
  const { rows, total } = await remember(cacheKeys.search(fingerprint({ q, page, limit })), LIST_TTL, () =>
    catalogRepo.search({ q, limit, offset }),
  );
  return { query: q, ...paginated(await decorateWithList(userId, rows), { total, page, limit }) };
}

export function suggest({ q, limit = 8 }) {
  return catalogRepo.suggest(q, limit);
}

export function listGenres() {
  return remember(cacheKeys.genres(), ROWS_TTL, () => catalogRepo.listGenres());
}

export function facets() {
  return catalogRepo.facets();
}

export async function myList({ userId, query }) {
  const { page, limit, offset } = parsePagination(query);
  const { rows, total } = await myListRepo.list(userId, { limit, offset });
  return paginated(
    rows.map((row) => ({ ...row, inList: true })),
    { total, page, limit },
  );
}

/** Guards against silently listing an unpublished or non-existent title. */
async function assertPublished(titleId) {
  const title = await catalogRepo.findPlayable(titleId);
  if (!title || title.status !== 'published') {
    throw AppError.notFound('We could not find that title', 'TITLE_NOT_FOUND');
  }
  return title;
}

export async function addToMyList({ userId, titleId }) {
  const title = await assertPublished(titleId);
  return { ...(await myListRepo.add(userId, titleId)), titleId, title: title.title };
}

export async function removeFromMyList({ userId, titleId }) {
  return { ...(await myListRepo.remove(userId, titleId)), titleId };
}

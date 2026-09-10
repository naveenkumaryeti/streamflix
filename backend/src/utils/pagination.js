const DEFAULT_LIMIT = 24;
const MAX_LIMIT = 60;

/** Turns ?page=&limit= into safe SQL LIMIT/OFFSET values. */
export function parsePagination(query = {}, { defaultLimit = DEFAULT_LIMIT, maxLimit = MAX_LIMIT } = {}) {
  const page = Math.max(1, Number.parseInt(query.page, 10) || 1);
  const requested = Number.parseInt(query.limit, 10) || defaultLimit;
  const limit = Math.min(Math.max(1, requested), maxLimit);
  return { page, limit, offset: (page - 1) * limit };
}

export function buildMeta({ total, page, limit }) {
  const totalItems = Number(total) || 0;
  const totalPages = limit > 0 ? Math.ceil(totalItems / limit) : 0;
  return {
    page,
    limit,
    totalItems,
    totalPages,
    hasNextPage: page < totalPages,
    hasPreviousPage: page > 1,
  };
}

export function paginated(items, { total, page, limit }) {
  return { items, meta: buildMeta({ total, page, limit }) };
}

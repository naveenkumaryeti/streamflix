import '../helpers/setup.js';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildMeta, paginated, parsePagination } from '../../src/utils/pagination.js';

/**
 * Pagination is the only place a query string becomes part of a SQL statement's LIMIT and
 * OFFSET. Even though both go through parameter binding, a negative or absurd value would
 * either error or ask Postgres to count through millions of rows, so the clamping matters.
 */
describe('parsePagination', () => {
  it('defaults to page 1 and the default limit', () => {
    assert.deepEqual(parsePagination({}), { page: 1, limit: 24, offset: 0 });
  });

  it('computes the offset from page and limit', () => {
    assert.deepEqual(parsePagination({ page: '3', limit: '10' }), { page: 3, limit: 10, offset: 20 });
  });

  it('clamps the limit to the ceiling', () => {
    assert.equal(parsePagination({ limit: '5000' }).limit, 60);
    assert.equal(parsePagination({ limit: '5000' }, { maxLimit: 12 }).limit, 12);
  });

  it('refuses page 0, negative pages and negative limits', () => {
    assert.equal(parsePagination({ page: '0' }).page, 1);
    assert.equal(parsePagination({ page: '-4' }).page, 1);
    assert.equal(parsePagination({ limit: '-10' }).limit, 1);
  });

  it('ignores junk instead of producing NaN', () => {
    // `LIMIT NaN` is a 500; a garbage query string must degrade to the default.
    assert.deepEqual(parsePagination({ page: 'abc', limit: 'xyz' }), { page: 1, limit: 24, offset: 0 });
    assert.deepEqual(parsePagination({ page: '2.7', limit: '9.9' }), { page: 2, limit: 9, offset: 9 });
  });

  it('honours a per-endpoint default', () => {
    assert.equal(parsePagination({}, { defaultLimit: 8 }).limit, 8);
  });
});

describe('buildMeta', () => {
  it('describes the middle of a result set', () => {
    assert.deepEqual(buildMeta({ total: 95, page: 2, limit: 24 }), {
      page: 2,
      limit: 24,
      totalItems: 95,
      totalPages: 4,
      hasNextPage: true,
      hasPreviousPage: true,
    });
  });

  it('has no next page on the last page', () => {
    const meta = buildMeta({ total: 48, page: 2, limit: 24 });
    assert.equal(meta.totalPages, 2);
    assert.equal(meta.hasNextPage, false);
    assert.equal(meta.hasPreviousPage, true);
  });

  it('handles an empty result set', () => {
    assert.deepEqual(buildMeta({ total: 0, page: 1, limit: 24 }), {
      page: 1,
      limit: 24,
      totalItems: 0,
      totalPages: 0,
      hasNextPage: false,
      hasPreviousPage: false,
    });
  });

  it('coerces the count Postgres returns as a string', () => {
    // `SELECT count(*)` comes back as '95' from node-postgres, not 95.
    assert.equal(buildMeta({ total: '95', page: 1, limit: 24 }).totalItems, 95);
  });
});

describe('paginated', () => {
  it('wraps items with their meta', () => {
    const result = paginated([{ id: 1 }], { total: 1, page: 1, limit: 24 });
    assert.deepEqual(result.items, [{ id: 1 }]);
    assert.equal(result.meta.totalPages, 1);
    assert.equal(result.meta.hasNextPage, false);
  });
});

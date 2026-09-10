import '../helpers/setup.js';
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { closeDependencies, databaseAvailable, startServer } from '../helpers/server.js';
import { API, anyPublishedTitle, registerUser } from '../helpers/fixtures.js';

/**
 * Browsing, searching and my-list, against the seeded catalogue.
 *
 * The through-line of this suite is that the catalogue is public but *personalised*: the same
 * endpoint serves an anonymous visitor and a signed-in viewer, and the difference is only ever
 * additive (my-list flags, continue watching, saved progress). If a personalisation lookup
 * fails, the page still renders — losing the "continue watching" row is a much smaller
 * problem than losing the home page.
 */
const online = await databaseAvailable();
let server;

before(async () => {
  server = await startServer();
});

after(async () => {
  await server.close();
  await closeDependencies();
});

const skip = online ? false : 'PostgreSQL is not reachable — start it with docker compose up postgres';

describe('browse', { skip }, () => {
  it('returns a hero, the genre list and named rows to an anonymous visitor', async () => {
    // No token: the landing page has to be useful before anyone signs up.
    const res = await server.get(`${API}/browse`);

    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body.hero));
    assert.ok(Array.isArray(res.body.genres));
    assert.ok(res.body.rows.length > 0, 'the seed publishes enough titles to fill a row');

    for (const row of res.body.rows) {
      assert.ok(row.key, 'every row has a stable key the frontend uses for React keys');
      assert.ok(row.title, 'and a human heading');
      assert.ok(Array.isArray(row.items));
    }
    const keys = res.body.rows.map((row) => row.key);
    assert.ok(keys.includes('trending') && keys.includes('new') && keys.includes('top'));
  });

  it('never leaks storage keys or unpublished rows into a card', async () => {
    // A card is rendered by a browser. `hlsKey` is where the video lives in the bucket, and
    // nothing outside the playback service has any business knowing it.
    const title = await anyPublishedTitle(server);
    assert.equal(title.hlsKey, undefined);
    assert.equal(title.sourceKey, undefined);
    assert.ok(title.id && title.slug && title.title);
  });

  it('has no continue-watching row until the viewer has actually watched something', async () => {
    const { token } = await registerUser(server);
    const res = await server.get(`${API}/browse`, { token });
    assert.equal(res.status, 200);
    assert.ok(!res.body.rows.some((row) => row.key === 'continue'));
  });

  it('serves the same rows to a signed-in viewer, plus their list flags', async () => {
    const { token } = await registerUser(server);
    const anonymous = await server.get(`${API}/browse`);
    const signedIn = await server.get(`${API}/browse`, { token });

    assert.deepEqual(
      signedIn.body.rows.map((row) => row.key),
      anonymous.body.rows.map((row) => row.key),
    );
    for (const item of signedIn.body.rows[0].items) {
      assert.equal(item.inList, false, 'a fresh account has an empty list, stated explicitly');
    }
  });
});

describe('titles and filters', { skip }, () => {
  it('paginates with meta the UI can build a pager from', async () => {
    const res = await server.get(`${API}/titles?page=1&limit=2`);

    assert.equal(res.status, 200);
    assert.ok(res.body.items.length <= 2);
    assert.equal(res.body.meta.page, 1);
    assert.equal(res.body.meta.limit, 2);
    assert.equal(res.body.meta.hasPreviousPage, false);
    assert.equal(typeof res.body.meta.totalItems, 'number');
    assert.equal(res.body.meta.totalPages, Math.ceil(res.body.meta.totalItems / 2));
  });

  it('returns a different page for page=2 when there is more than one', async () => {
    const first = await server.get(`${API}/titles?page=1&limit=1&sort=title`);
    if (!first.body.meta.hasNextPage) return; // a one-title catalogue is legitimate

    const second = await server.get(`${API}/titles?page=2&limit=1&sort=title`);
    assert.equal(second.body.meta.hasPreviousPage, true);
    assert.notEqual(second.body.items[0].id, first.body.items[0].id);
  });

  it('refuses a limit large enough to be a denial-of-service', async () => {
    const res = await server.get(`${API}/titles?limit=5000`);
    assert.equal(res.status, 422);
    assert.equal(res.body.error.details.fields[0].field, 'query.limit');
  });

  it('accepts every documented sort order', async () => {
    for (const sort of ['popular', 'newest', 'rating', 'title', 'year']) {
      const res = await server.get(`${API}/titles?sort=${sort}&limit=3`);
      assert.equal(res.status, 200, sort);
    }
    assert.equal((await server.get(`${API}/titles?sort=whatever`)).status, 422);
  });

  it('filters by genre using the slug the browse response handed out', async () => {
    const browse = await server.get(`${API}/browse`);
    const genre = browse.body.genres.find((entry) => Number(entry.titleCount) > 0);
    if (!genre) return;

    const res = await server.get(`${API}/titles?genre=${encodeURIComponent(genre.slug)}`);
    assert.equal(res.status, 200);
    assert.ok(res.body.items.length > 0, `${genre.slug} claims ${genre.titleCount} titles`);
  });

  it('returns an empty page rather than an error for a genre nobody has', async () => {
    const res = await server.get(`${API}/titles?genre=no-such-genre`);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.items, []);
    assert.equal(res.body.meta.totalItems, 0);
  });

  it('lists genres with a count, so an empty one can be hidden', async () => {
    const res = await server.get(`${API}/genres`);
    assert.equal(res.status, 200);
    assert.ok(res.body.items.length > 0);
    for (const genre of res.body.items) {
      assert.ok(genre.slug && genre.name);
      assert.ok(Number.isFinite(Number(genre.titleCount)));
    }
  });

  it('exposes the facet values the filter sidebar offers', async () => {
    const res = await server.get(`${API}/facets`);
    assert.equal(res.status, 200);
    assert.deepEqual(Object.keys(res.body).sort(), ['languages', 'maturityRatings', 'years']);
    assert.ok(Array.isArray(res.body.languages));
  });
});

describe('title detail', { skip }, () => {
  it('resolves a slug to the title, similar titles and any saved progress', async () => {
    const card = await anyPublishedTitle(server);
    const res = await server.get(`${API}/titles/${card.slug}`);

    assert.equal(res.status, 200);
    assert.equal(res.body.title.id, card.id);
    assert.ok(Array.isArray(res.body.similar));
    assert.equal(res.body.progress, null, 'no token, so nothing personal');
    assert.equal(res.body.title.hlsKey, undefined, 'still no storage keys');
  });

  it('404s a slug that does not exist with a code the UI can route on', async () => {
    const res = await server.get(`${API}/titles/definitely-not-a-real-title`);
    assert.equal(res.status, 404);
    assert.equal(res.body.error.code, 'TITLE_NOT_FOUND');
  });

  it('rejects a slug shaped like an injection attempt before it reaches SQL', async () => {
    const res = await server.get(`${API}/titles/${encodeURIComponent("' OR 1=1--")}`);
    assert.equal(res.status, 422);
    assert.equal(res.body.error.details.fields[0].field, 'params.slug');
  });

  it('prefers the literal /titles route over the slug pattern', async () => {
    // Route order is the only thing stopping `GET /titles` from being read as slug "titles".
    const res = await server.get(`${API}/titles`);
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body.items));
  });
});

describe('search and suggest', { skip }, () => {
  it('finds a seeded title by a word from its name', async () => {
    const card = await anyPublishedTitle(server);
    const term = card.title.split(' ')[0];

    const res = await server.get(`${API}/search?q=${encodeURIComponent(term)}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.query, term, 'echoed back so the UI can show "results for …"');
    assert.ok(res.body.items.some((item) => item.id === card.id));
    assert.ok(res.body.meta, 'search is paginated like any other list');
  });

  it('returns an empty result set for nonsense instead of an error', async () => {
    const res = await server.get(`${API}/search?q=zzzqqqxxnothing`);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.items, []);
  });

  it('insists on a search term', async () => {
    const res = await server.get(`${API}/search?q=`);
    assert.equal(res.status, 422);
    assert.equal(res.body.error.details.fields[0].message, 'Type something to search for');
  });

  it('answers typeahead with a short list of lightweight rows', async () => {
    const card = await anyPublishedTitle(server);
    const res = await server.get(`${API}/suggest?q=${encodeURIComponent(card.title.slice(0, 3))}&limit=5`);

    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body.items));
    assert.ok(res.body.items.length <= 5);
  });

  it('caps the suggest limit, because it fires on every keystroke', async () => {
    assert.equal((await server.get(`${API}/suggest?q=a&limit=50`)).status, 422);
  });
});

describe('my list', { skip }, () => {
  it('starts empty', async () => {
    const { token } = await registerUser(server);
    const res = await server.get(`${API}/my-list`, { token });

    assert.equal(res.status, 200);
    assert.deepEqual(res.body.items, []);
    assert.equal(res.body.meta.totalItems, 0);
  });

  it('adds a title, shows it as in-list everywhere, then removes it', async () => {
    const { token } = await registerUser(server);
    const card = await anyPublishedTitle(server, token);

    const added = await server.put(`${API}/my-list/${card.id}`, { token });
    assert.equal(added.status, 201);
    assert.equal(added.body.titleId, card.id);

    const list = await server.get(`${API}/my-list`, { token });
    assert.equal(list.body.items.length, 1);
    assert.equal(list.body.items[0].inList, true);

    const detail = await server.get(`${API}/titles/${card.slug}`, { token });
    assert.equal(detail.body.title.inList, true, 'the detail page reflects it too');

    const removed = await server.delete(`${API}/my-list/${card.id}`, { token });
    assert.equal(removed.status, 200);
    assert.equal((await server.get(`${API}/my-list`, { token })).body.items.length, 0);
  });

  it('is idempotent, because a double tap is a double tap', async () => {
    // PUT rather than POST for exactly this reason: adding twice is not an error worth
    // surfacing to someone who tapped a heart icon.
    const { token } = await registerUser(server);
    const card = await anyPublishedTitle(server, token);

    assert.equal((await server.put(`${API}/my-list/${card.id}`, { token })).status, 201);
    assert.equal((await server.put(`${API}/my-list/${card.id}`, { token })).status, 201);
    assert.equal((await server.get(`${API}/my-list`, { token })).body.items.length, 1);

    await server.delete(`${API}/my-list/${card.id}`, { token });
    assert.equal((await server.delete(`${API}/my-list/${card.id}`, { token })).status, 200);
  });

  it('will not list a title that is not published', async () => {
    const { token } = await registerUser(server);
    const res = await server.put(`${API}/my-list/00000000-0000-4000-8000-000000000000`, { token });
    assert.equal(res.status, 404);
    assert.equal(res.body.error.code, 'TITLE_NOT_FOUND');
  });

  it('needs an account, unlike the rest of the catalogue', async () => {
    assert.equal((await server.get(`${API}/my-list`)).status, 401);
    assert.equal((await server.get(`${API}/continue-watching`)).status, 401);
  });

  it('keeps one viewer out of another viewer list', async () => {
    const first = await registerUser(server);
    const second = await registerUser(server);
    const card = await anyPublishedTitle(server);

    await server.put(`${API}/my-list/${card.id}`, { token: first.token });
    const other = await server.get(`${API}/my-list`, { token: second.token });
    assert.deepEqual(other.body.items, [], 'lists are per-account, not global');
  });
});

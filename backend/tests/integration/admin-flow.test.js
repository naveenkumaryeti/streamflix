import '../helpers/setup.js';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { closeDependencies, databaseAvailable, startServer } from '../helpers/server.js';
import { API, TEST_PASSWORD, loginAdmin, registerUser, subscribedUser } from '../helpers/fixtures.js';

/**
 * The operator's half of the product, end to end: sign in as staff, create a title, push a
 * video into it, publish it, and see it appear in the customer catalogue.
 *
 * The publish gate is what this suite exists for. It is the single boundary between "an
 * admin is still working on this" and "a paying customer can see it", and it fails in a
 * deliberate order — nothing to play, wrong status, no artwork — because each answer tells
 * the admin a different thing to go and fix. Reordering those checks would still pass a
 * naive "cannot publish a draft" test while making the UI unhelpful, so the order is pinned.
 */
const online = await databaseAvailable();
const skip = online ? false : 'PostgreSQL is not reachable — start it with docker compose up postgres';

/** A public sample manifest counts as playable: it is how the seed ships a working catalogue. */
const DEMO_MANIFEST = 'https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8';
const POSTER = 'https://images.streamflix.test/poster.jpg';

let server;
let admin;

before(async () => {
  server = await startServer();
  // Throws with "has the database been seeded?" rather than a bare 401 if the seed never ran.
  if (online) admin = await loginAdmin(server);
});

after(async () => {
  await server.close();
  await closeDependencies();
});

const uniqueSlug = (prefix = 'test') => `${prefix}-${randomUUID().slice(0, 8)}`;

/**
 * Every test gets its own title. The pipeline mutates `status` in place, so a shared fixture
 * would make these tests order-dependent — the kind of coupling that only shows up as a
 * mystery failure once someone runs a single test with `--test-name-pattern`.
 */
async function createDraft(overrides = {}) {
  const slug = uniqueSlug();
  const res = await server.post(`${API}/admin/titles`, {
    token: admin.token,
    body: { slug, title: `Night Signal ${slug}`, type: 'movie', releaseYear: 2024, runtimeSeconds: 5400, ...overrides },
  });
  if (res.status !== 201) throw new Error(`could not create a draft (${res.status}): ${JSON.stringify(res.body)}`);
  return res.body;
}

const patchTitle = (id, body) => server.patch(`${API}/admin/titles/${id}`, { token: admin.token, body });
const publishTitle = (id) => server.post(`${API}/admin/titles/${id}/publish`, { token: admin.token });

/** The smallest valid PNG. Nothing decodes it — multer trusts the declared part type. */
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
  'base64',
);

/**
 * A multipart body built by hand. `FormData` would be JSON-stringified by the test client,
 * and the point of this is to send the exact bytes multer will parse.
 */
function multipart({ filename = 'poster.png', contentType = 'image/png', field = 'file', content = PNG_1X1 } = {}) {
  const boundary = `----streamflix${randomUUID().replace(/-/g, '')}`;
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="${field}"; filename="${filename}"\r\n` +
      `Content-Type: ${contentType}\r\n\r\n`,
  );
  return {
    body: Buffer.concat([head, content, Buffer.from(`\r\n--${boundary}--\r\n`)]),
    headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
  };
}

/**
 * Audit rows are written without being awaited — the operator's response should not wait on
 * a log insert — so a test that reads them immediately is racing the write. Polling makes the
 * asynchrony explicit instead of papering over it with a fixed sleep.
 */
async function auditRowFor(entityId, action, attempts = 20) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const res = await server.get(`${API}/admin/audit?action=${action}&limit=100`, { token: admin.token });
    const hit = (res.body.items ?? []).find((row) => row.entityId === entityId);
    if (hit) return hit;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return null;
}

describe('admin access', { skip }, () => {
  it('closes every route under the mount point to a customer, not just the ones it remembered', async () => {
    // The guard is `router.use(requireAdmin)`, so this is really a test that no route was
    // added above that line. Reads and writes are both checked because a forgotten guard on
    // a GET leaks the customer ledger just as effectively as one on a POST.
    const { token } = await registerUser(server);

    for (const [method, path] of [
      ['get', '/admin/dashboard'],
      ['get', '/admin/users'],
      ['get', '/admin/payments'],
      ['get', '/admin/audit'],
      ['get', '/admin/titles'],
      ['post', '/admin/titles'],
    ]) {
      const res = await server[method](`${API}${path}`, { token, body: method === 'post' ? {} : undefined });
      assert.equal(res.status, 403, `${method.toUpperCase()} ${path}`);
      assert.equal(res.body.error.code, 'ADMIN_ONLY');
    }
  });

  it('lets the seeded admin in and reports the numbers the dashboard renders', async () => {
    const res = await server.get(`${API}/admin/dashboard`, { token: admin.token });

    assert.equal(res.status, 200);
    assert.ok(Number(res.body.catalogue.totalTitles) >= 1, 'the seed published a catalogue');
    for (const key of ['total', 'newLast7Days', 'activeLast30Days', 'admins']) {
      assert.equal(typeof res.body.users[key], 'number', `users.${key} is a number, not a string from pg`);
    }
    assert.ok(res.body.subscriptions, 'subscription counts by status');
    assert.ok(Array.isArray(res.body.revenue), 'a month-by-month series for the chart');
    assert.deepEqual(res.body.pipeline.drivers, { storage: 'local', transcoder: 'ffmpeg', cdn: 'local' });
  });

  it('serves the reference data the admin forms are built from', async () => {
    const res = await server.get(`${API}/admin/options`, { token: admin.token });
    assert.equal(res.status, 200);
    assert.ok(res.body.genres.length > 0, 'genre slugs for the multi-select');
    assert.ok(res.body.plans.some((plan) => plan.code === 'standard'));
  });
});

describe('the catalogue write model', { skip }, () => {
  it('creates a draft with no video, because metadata comes first', async () => {
    // Drafting before uploading is what lets one person prepare a release and hand the
    // 4 GB upload to someone else — the two steps are hours apart in practice.
    const options = await server.get(`${API}/admin/options`, { token: admin.token });
    const genre = options.body.genres[0].slug;
    const slug = uniqueSlug('inception');

    const res = await server.post(`${API}/admin/titles`, {
      token: admin.token,
      body: {
        slug: `  ${slug.toUpperCase()}  `,
        title: 'Night Signal',
        synopsis: 'A courier discovers the city is listening back.',
        type: 'movie',
        releaseYear: 2024,
        runtimeSeconds: 7200,
        maturityRating: 'PG-13',
        language: 'en',
        genres: [genre],
        cast: ['Asha Menon', 'Ravi Kapoor'],
      },
    });

    assert.equal(res.status, 201);
    assert.equal(res.body.slug, slug, 'trimmed and lowercased, so the URL is predictable');
    assert.equal(res.body.status, 'draft');
    assert.equal(res.body.playable, false, 'nothing to play yet, and the column says so');
    assert.equal(res.body.publishedAt, null);
    assert.equal(res.body.hlsKey, null);
    assert.equal(res.body.demoManifestUrl, null);
    assert.equal(res.body.createdBy, admin.user.id, 'so "who added this?" is answerable');
    assert.ok(res.body.genreSlugs.includes(genre));
    assert.deepEqual(res.body.cast, ['Asha Menon', 'Ravi Kapoor']);
  });

  it('refuses a slug another title already owns', async () => {
    const existing = await createDraft();
    const res = await server.post(`${API}/admin/titles`, {
      token: admin.token,
      body: { slug: existing.slug, title: 'A Different Film' },
    });

    assert.equal(res.status, 409);
    assert.equal(res.body.error.code, 'SLUG_TAKEN');
  });

  it('rejects a field it does not recognise instead of dropping it silently', async () => {
    // `.strict()` on an admin payload is a typo detector: without it, `posterURL` would be
    // accepted, ignored, and leave the admin wondering why the artwork never appeared.
    const res = await server.post(`${API}/admin/titles`, {
      token: admin.token,
      body: { slug: uniqueSlug(), title: 'Typo Test', posterURL: 'https://images.example/poster.jpg' },
    });

    assert.equal(res.status, 422);
    assert.equal(res.body.error.code, 'VALIDATION_FAILED');
    assert.match(res.body.error.details.fields[0].message, /Unrecognized key/i);
  });

  it('reports an empty patch rather than pretending to save it', async () => {
    const title = await createDraft();
    const res = await patchTitle(title.id, {});

    assert.equal(res.status, 422);
    assert.equal(res.body.error.details.fields[0].message, 'Nothing to update');
  });

  it('writes only the fields in the patch', async () => {
    const title = await createDraft({ synopsis: 'Original synopsis.' });
    const res = await patchTitle(title.id, { maturityRating: 'R' });

    assert.equal(res.status, 200);
    assert.equal(res.body.maturityRating, 'R');
    assert.equal(res.body.synopsis, 'Original synopsis.', 'untouched by a patch that did not mention it');
    assert.equal(res.body.slug, title.slug);
  });

  it('filters and paginates the admin list, which shows every status', async () => {
    const title = await createDraft();

    const drafts = await server.get(`${API}/admin/titles?status=draft&limit=60`, { token: admin.token });
    assert.equal(drafts.status, 200);
    assert.ok(drafts.body.items.some((item) => item.id === title.id));
    assert.ok(drafts.body.items.every((item) => item.status === 'draft'));
    assert.equal(typeof drafts.body.meta.totalItems, 'number');

    const searched = await server.get(`${API}/admin/titles?search=${encodeURIComponent(title.slug)}`, {
      token: admin.token,
    });
    assert.equal(searched.body.items.length, 1, 'a slug is unique enough to find exactly one');

    assert.equal((await server.get(`${API}/admin/titles?status=nonsense`, { token: admin.token })).status, 422);
    assert.equal((await server.get(`${API}/admin/titles?limit=61`, { token: admin.token })).status, 422);
  });

  it('serves the detail view with the media inventory attached', async () => {
    const title = await createDraft();
    const res = await server.get(`${API}/admin/titles/${title.id}`, { token: admin.token });

    assert.equal(res.status, 200);
    assert.equal(res.body.id, title.id);
    assert.equal(res.body.media.hasSource, false, 'no upload yet');
    assert.equal(res.body.media.job, null, 'and no transcode job');
    assert.deepEqual(res.body.media.assets, []);
    assert.deepEqual(res.body.media.drivers, { storage: 'local', transcoder: 'ffmpeg', cdn: 'local' });
    assert.ok('hlsKey' in res.body, 'the admin projection sees the storage key the public one hides');
  });

  it('404s an id that does not exist and 422s one that is not an id', async () => {
    const missing = await server.get(`${API}/admin/titles/${randomUUID()}`, { token: admin.token });
    assert.equal(missing.status, 404);
    assert.equal(missing.body.error.code, 'TITLE_NOT_FOUND');

    const malformed = await server.get(`${API}/admin/titles/not-a-uuid`, { token: admin.token });
    assert.equal(malformed.status, 422);
    assert.equal(malformed.body.error.details.fields[0].field, 'params.id');
  });
});

describe('the publish gate', { skip }, () => {
  it('walks the whole ladder in order: playable, then status, then artwork', async () => {
    // One test rather than four, because each rung only becomes reachable once the one below
    // it is satisfied — and the *order* is the contract. An admin fixing the first complaint
    // should see the next real problem, not the same message again.
    const title = await createDraft();

    const nothing = await publishTitle(title.id);
    assert.equal(nothing.status, 400);
    assert.equal(nothing.body.error.code, 'NOT_PLAYABLE', 'checked before status: no video is the bigger problem');

    await patchTitle(title.id, { demoManifestUrl: DEMO_MANIFEST });
    const stillDraft = await publishTitle(title.id);
    assert.equal(stillDraft.status, 400);
    assert.equal(stillDraft.body.error.code, 'NOT_PUBLISHABLE');
    assert.match(stillDraft.body.error.message, /draft/, 'the message names the status it found');

    // `unpublish` is also the "mark it ready" lever, which is how a demo-manifest title
    // becomes publishable without transcoding anything.
    const ready = await server.post(`${API}/admin/titles/${title.id}/unpublish`, {
      token: admin.token,
      body: { status: 'ready' },
    });
    assert.equal(ready.status, 200);
    assert.equal(ready.body.status, 'ready');

    const noPoster = await publishTitle(title.id);
    assert.equal(noPoster.status, 400);
    assert.equal(noPoster.body.error.code, 'POSTER_REQUIRED');

    await patchTitle(title.id, { posterUrl: POSTER });
    const published = await publishTitle(title.id);
    assert.equal(published.status, 200);
    assert.equal(published.body.status, 'published');
    assert.ok(Date.parse(published.body.publishedAt) > 0);
  });

  /** A title that is playable and `ready`, but not yet visible to customers. */
  async function readyTitle() {
    const title = await createDraft({ demoManifestUrl: DEMO_MANIFEST, posterUrl: POSTER });
    await server.post(`${API}/admin/titles/${title.id}/unpublish`, {
      token: admin.token,
      body: { status: 'ready' },
    });
    return title;
  }

  it('hides an unpublished title from customers while letting staff preview it', async () => {
    // Staff preview is the whole reason `findPlayable` ignores status and `start` re-checks
    // it: an admin has to be able to watch what they just uploaded before publishing it.
    const title = await readyTitle();
    const viewer = await subscribedUser(server);

    const publicDetail = await server.get(`${API}/titles/${title.slug}`);
    assert.equal(publicDetail.status, 404);
    assert.equal(publicDetail.body.error.code, 'TITLE_NOT_FOUND');

    const staffPreview = await server.post(`${API}/playback/${title.id}/start`, { token: admin.token, body: {} });
    assert.equal(staffPreview.status, 200, 'an admin needs no subscription — entitlement falls back to staff');
    assert.equal(staffPreview.body.source.url, DEMO_MANIFEST);
    assert.equal(staffPreview.body.source.strategy, 'public', 'a third-party manifest is not signed by our CDN');
    assert.deepEqual(staffPreview.body.source.cookies, []);

    const customer = await server.post(`${API}/playback/${title.id}/start`, { token: viewer.token, body: {} });
    assert.equal(customer.status, 404, 'a paying customer sees the same 404 as for a title that never existed');
    assert.equal(customer.body.error.code, 'TITLE_NOT_FOUND');
  });

  it('makes the title playable for customers the moment it is published, and hides it again on unpublish', async () => {
    const title = await readyTitle();
    const viewer = await subscribedUser(server);

    const published = await publishTitle(title.id);
    assert.equal(published.status, 200);

    const detail = await server.get(`${API}/titles/${title.slug}`);
    assert.equal(detail.status, 200);
    assert.equal(detail.body.title.id, title.id);
    assert.equal(detail.body.title.playable, true);
    assert.equal(detail.body.title.hlsKey, undefined, 'the public projection still hides storage keys');

    const play = await server.post(`${API}/playback/${title.id}/start`, { token: viewer.token, body: {} });
    assert.equal(play.status, 200);
    assert.equal(play.body.title.slug, title.slug);

    const withdrawn = await server.post(`${API}/admin/titles/${title.id}/unpublish`, { token: admin.token, body: {} });
    assert.equal(withdrawn.status, 200);
    assert.equal(withdrawn.body.status, 'ready', 'the default landing status, not draft');
    assert.equal((await server.get(`${API}/titles/${title.slug}`)).status, 404);

    // published_at is set once and then left alone, so "new on StreamFlix" ordering survives
    // a title being pulled and put back.
    const again = await publishTitle(title.id);
    assert.equal(again.body.publishedAt, published.body.publishedAt);
  });

  it('rejects an unpublish status a title cannot land in', async () => {
    const title = await readyTitle();
    const res = await server.post(`${API}/admin/titles/${title.id}/unpublish`, {
      token: admin.token,
      body: { status: 'processing' },
    });
    assert.equal(res.status, 422, 'processing is a pipeline state, not something an admin sets by hand');
  });
});

describe('the media pipeline', { skip }, () => {
  /** The bytes stand in for a video file; nothing in this path decodes them. */
  const FAKE_VIDEO = Buffer.alloc(4096, 7);

  it('hands out an upload target derived from the title id, never from the filename', async () => {
    // The client supplies a filename and gets back a key it did not choose. That is what
    // stops "../../etc/passwd.mp4" from being interesting, and it is why the key is not in
    // the request schema at all.
    const title = await createDraft();
    const res = await server.post(`${API}/admin/titles/${title.id}/upload-url`, {
      token: admin.token,
      body: { filename: '../../../etc/passwd.mp4', contentType: 'video/mp4' },
    });

    assert.equal(res.status, 201);
    assert.equal(res.body.key, `sources/${title.id}/source.mp4`);
    assert.equal(res.body.mode, 'api-put', 'local mode uploads through this API; S3 mode returns a presigned PUT');
    assert.ok(res.body.url.includes('/admin/media/upload?key='));
    assert.equal(res.body.headers['content-type'], 'video/mp4');
    assert.equal(typeof res.body.maxBytes, 'number');

    const after = await server.get(`${API}/admin/titles/${title.id}`, { token: admin.token });
    assert.equal(after.body.status, 'uploading', 'the draft moved on, so the admin list shows progress');
    assert.equal(after.body.media.assets[0].status, 'pending', 'pending until the bytes are confirmed');
  });

  it('refuses a container it cannot transcode, before anything is written', async () => {
    const title = await createDraft();
    const res = await server.post(`${API}/admin/titles/${title.id}/upload-url`, {
      token: admin.token,
      body: { filename: 'notes.txt' },
    });

    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, 'UNSUPPORTED_SOURCE_FORMAT');
    assert.match(res.body.error.message, /MP4/);
  });

  it('will not register a source before the bytes have actually arrived', async () => {
    // The HEAD in registerSource is the point of the call: without it the admin UI reports
    // success and the failure surfaces minutes later, inside the worker.
    const title = await createDraft();
    await server.post(`${API}/admin/titles/${title.id}/upload-url`, {
      token: admin.token,
      body: { filename: 'movie.mp4' },
    });

    const res = await server.post(`${API}/admin/titles/${title.id}/source`, { token: admin.token, body: {} });
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, 'SOURCE_MISSING');
    assert.match(res.body.error.message, /did not arrive/);
  });

  it('takes the upload, registers it, and queues exactly one transcode', async () => {
    const title = await createDraft();
    const target = await server.post(`${API}/admin/titles/${title.id}/upload-url`, {
      token: admin.token,
      body: { filename: 'movie.mp4' },
    });

    const uploaded = await server.put(`${API}/admin/media/upload?key=${encodeURIComponent(target.body.key)}`, {
      token: admin.token,
      body: FAKE_VIDEO,
      headers: { 'Content-Type': 'video/mp4' },
    });
    assert.equal(uploaded.status, 201);
    assert.equal(uploaded.body.key, target.body.key);
    assert.equal(uploaded.body.sizeBytes, FAKE_VIDEO.length, 'the receiver streams to disk and reports what it wrote');

    const registered = await server.post(`${API}/admin/titles/${title.id}/source`, { token: admin.token, body: {} });
    assert.equal(registered.status, 201);
    assert.equal(registered.body.kind, 'source');
    assert.equal(registered.body.status, 'available', 'promoted from pending now that the object exists');
    assert.equal(Number(registered.body.sizeBytes), FAKE_VIDEO.length);

    const media = await server.get(`${API}/admin/titles/${title.id}/media`, { token: admin.token });
    assert.equal(media.body.hasSource, true);
    assert.equal(media.body.source.storageKey, target.body.key);

    const queued = await server.post(`${API}/admin/titles/${title.id}/transcode`, { token: admin.token });
    assert.equal(queued.status, 202, 'accepted, not created — the work happens in the worker');
    assert.equal(queued.body.alreadyRunning, false);
    assert.ok(['queued', 'submitted', 'processing'].includes(queued.body.job.status), queued.body.job.status);
    assert.equal(queued.body.job.inputKey, target.body.key);

    // A second click must not fan out into two ffmpeg runs over the same file.
    const again = await server.post(`${API}/admin/titles/${title.id}/transcode`, { token: admin.token });
    assert.equal(again.status, 200, 'nothing was created this time');
    assert.equal(again.body.alreadyRunning, true);
    assert.equal(again.body.job.id, queued.body.job.id);

    const listed = await server.get(`${API}/admin/titles?status=processing&limit=60`, { token: admin.token });
    const row = listed.body.items.find((item) => item.id === title.id);
    assert.ok(row, 'the title moved to processing');
    assert.ok(row.jobStatus, 'and the list carries the job status the progress bar reads');
  });

  it('refuses a transcode with nothing to transcode', async () => {
    const title = await createDraft();
    const res = await server.post(`${API}/admin/titles/${title.id}/transcode`, { token: admin.token });
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, 'SOURCE_MISSING');
  });

  it('accepts uploads only under the two prefixes it owns', async () => {
    // The receiver is authenticated and admin-only, but it still writes to a filesystem, so
    // the key is checked rather than trusted: traversal, absolute paths and a prefix the
    // pipeline does not manage are all refused.
    for (const key of ['hls/abc/master.m3u8', 'sources/../../etc/passwd', '/etc/passwd', 'sources\\win.mp4']) {
      const res = await server.put(`${API}/admin/media/upload?key=${encodeURIComponent(key)}`, {
        token: admin.token,
        body: Buffer.from('x'),
        headers: { 'Content-Type': 'application/octet-stream' },
      });
      assert.equal(res.status, 400, key);
      assert.equal(res.body.error.code, 'UPLOAD_KEY_INVALID', key);
    }

    const noKey = await server.put(`${API}/admin/media/upload`, { token: admin.token, body: Buffer.from('x') });
    assert.equal(noKey.status, 422);
    assert.equal(noKey.body.error.details.fields[0].field, 'query.key');
  });

  it('will not let one title claim another title upload', async () => {
    const mine = await createDraft();
    const theirs = await createDraft();

    const res = await server.post(`${API}/admin/titles/${mine.id}/source`, {
      token: admin.token,
      body: { key: `sources/${theirs.id}/source.mp4` },
    });

    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, 'KEY_SCOPE_MISMATCH');
  });

  it('stores poster artwork and points the title at it in one call', async () => {
    const title = await createDraft();
    const res = await server.post(`${API}/admin/titles/${title.id}/artwork/poster`, {
      token: admin.token,
      ...multipart({ filename: 'key-art.png' }),
    });

    assert.equal(res.status, 201);
    assert.equal(res.body.kind, 'poster');
    assert.equal(res.body.key, `images/${title.id}/poster.png`);
    assert.ok(res.body.url, 'a CDN URL the browser can load');
    assert.equal(res.body.title.posterUrl, res.body.url, 'the column is updated in the same request');
    assert.equal(res.body.title.backdropUrl, null, 'and only that column');
  });

  it('refuses a file that is not an image, an unknown artwork slot, and no file at all', async () => {
    const title = await createDraft();

    const wrongType = await server.post(`${API}/admin/titles/${title.id}/artwork/poster`, {
      token: admin.token,
      ...multipart({ filename: 'poster.svg', contentType: 'image/svg+xml' }),
    });
    assert.equal(wrongType.status, 400, 'SVG is an image and a script host; multer rejects it by mimetype');
    assert.equal(wrongType.body.error.code, 'UNSUPPORTED_IMAGE');

    const wrongSlot = await server.post(`${API}/admin/titles/${title.id}/artwork/thumbnail`, {
      token: admin.token,
      ...multipart(),
    });
    assert.equal(wrongSlot.status, 422);
    assert.equal(wrongSlot.body.error.details.fields[0].field, 'params.kind');

    const noFile = await server.post(`${API}/admin/titles/${title.id}/artwork/poster`, {
      token: admin.token,
      body: {},
    });
    assert.equal(noFile.status, 400);
    assert.equal(noFile.body.error.code, 'FILE_REQUIRED');
  });
});

describe('people, money and the paper trail', { skip }, () => {
  it('finds an account by address without ever returning its hash', async () => {
    const viewer = await registerUser(server, { fullName: 'Searchable Viewer' });
    const res = await server.get(`${API}/admin/users?search=${encodeURIComponent(viewer.email)}`, {
      token: admin.token,
    });

    assert.equal(res.status, 200);
    assert.equal(res.body.items.length, 1);
    assert.equal(res.body.items[0].email, viewer.email);
    assert.equal(res.body.items[0].role, 'user');
    assert.equal(res.body.items[0].status, 'active');
    assert.equal(res.body.items[0].passwordHash, undefined);
    assert.equal(res.body.items[0].subscriptionStatus, null, 'the list carries plan state for the operator view');
  });

  it('suspends an account and the next request from that device is refused', async () => {
    // The user row is cached, so a suspension that skipped cache invalidation would appear to
    // do nothing for as long as the TTL lasted — the bug this assertion exists to catch.
    const viewer = await registerUser(server);
    assert.equal((await server.get(`${API}/auth/me`, { token: viewer.token })).status, 200);

    const suspended = await server.patch(`${API}/admin/users/${viewer.user.id}/status`, {
      token: admin.token,
      body: { status: 'suspended' },
    });
    assert.equal(suspended.status, 200);
    assert.equal(suspended.body.status, 'suspended');

    const refused = await server.get(`${API}/auth/me`, { token: viewer.token });
    assert.equal(refused.status, 403);
    assert.equal(refused.body.error.code, 'ACCOUNT_SUSPENDED');

    const blocked = await server.post(`${API}/auth/login`, {
      body: { email: viewer.email, password: TEST_PASSWORD },
    });
    assert.equal(blocked.status, 403, 'and they cannot simply sign in again for a fresh token');
    assert.equal(blocked.body.error.code, 'ACCOUNT_SUSPENDED');

    await server.patch(`${API}/admin/users/${viewer.user.id}/status`, {
      token: admin.token,
      body: { status: 'active' },
    });
    assert.equal((await server.get(`${API}/auth/me`, { token: viewer.token })).status, 200, 'reversible');
  });

  it('promotes a customer to admin, which is a two-way door', async () => {
    const viewer = await registerUser(server);
    const promoted = await server.patch(`${API}/admin/users/${viewer.user.id}/role`, {
      token: admin.token,
      body: { role: 'admin' },
    });

    assert.equal(promoted.status, 200);
    assert.equal(promoted.body.role, 'admin');
    assert.equal((await server.get(`${API}/admin/dashboard`, { token: viewer.token })).status, 200);

    await server.patch(`${API}/admin/users/${viewer.user.id}/role`, { token: admin.token, body: { role: 'user' } });
    assert.equal((await server.get(`${API}/admin/dashboard`, { token: viewer.token })).status, 403);
  });

  it('stops an admin locking themselves out of their own console', async () => {
    // Both guards are about the same failure: the last admin removing their own access and
    // needing a database console to get it back.
    const suspendSelf = await server.patch(`${API}/admin/users/${admin.user.id}/status`, {
      token: admin.token,
      body: { status: 'suspended' },
    });
    assert.equal(suspendSelf.status, 400);
    assert.equal(suspendSelf.body.error.code, 'SELF_SUSPEND');

    const demoteSelf = await server.patch(`${API}/admin/users/${admin.user.id}/role`, {
      token: admin.token,
      body: { role: 'user' },
    });
    assert.equal(demoteSelf.status, 400);
    assert.equal(demoteSelf.body.error.code, 'SELF_DEMOTE');

    // Setting your own status to the value it already has is not a lockout, so it is allowed.
    const noop = await server.patch(`${API}/admin/users/${admin.user.id}/status`, {
      token: admin.token,
      body: { status: 'active' },
    });
    assert.equal(noop.status, 200);
  });

  it('404s an account that does not exist and 422s a status that is not one', async () => {
    const missing = await server.patch(`${API}/admin/users/${randomUUID()}/status`, {
      token: admin.token,
      body: { status: 'suspended' },
    });
    assert.equal(missing.status, 404);
    assert.equal(missing.body.error.code, 'USER_NOT_FOUND');

    const banned = await server.patch(`${API}/admin/users/${randomUUID()}/status`, {
      token: admin.token,
      body: { status: 'banned' },
    });
    assert.equal(banned.status, 422, 'the enum is the vocabulary; "banned" is not in it');

    const extra = await server.patch(`${API}/admin/users/${randomUUID()}/status`, {
      token: admin.token,
      body: { status: 'active', role: 'admin' },
    });
    assert.equal(extra.status, 422, 'a role cannot be smuggled through the status endpoint');
  });

  it('shows the payment ledger without the card that paid it', async () => {
    const viewer = await subscribedUser(server);
    const res = await server.get(`${API}/admin/payments?status=succeeded&limit=60`, { token: admin.token });

    assert.equal(res.status, 200);
    const row = res.body.items.find((item) => item.userEmail === viewer.email);
    assert.ok(row, 'the charge that just succeeded is in the ledger');
    assert.equal(row.status, 'succeeded');
    assert.equal(Number.isInteger(row.amountCents), true, 'cents as an integer — no floats near money');
    assert.equal(row.methodLast4, '4242');
    assert.equal(row.methodBrand, 'visa');
    assert.ok(row.planCode, 'joined to the plan, so the ledger reads without a second lookup');

    const serialised = JSON.stringify(res.body);
    assert.ok(!serialised.includes('4242424242424242'), 'the number itself is never stored, so it cannot leak');
    assert.ok(!serialised.includes('"cvc"'));

    const failedOnly = await server.get(`${API}/admin/payments?status=failed`, { token: admin.token });
    assert.ok(failedOnly.body.items.every((item) => item.status === 'failed'));
  });

  it('records who did what, and filters the log by action prefix', async () => {
    const title = await createDraft();
    const row = await auditRowFor(title.id, 'title.created');

    assert.ok(row, 'the create left a trail');
    assert.equal(row.entityType, 'title');
    assert.equal(row.actorEmail, admin.user.email, 'the log joins the email, so a deleted actor is still readable');
    assert.equal(row.metadata.slug, title.slug);
    assert.ok(Date.parse(row.createdAt) > 0);

    // `action` is a prefix match, which is what makes "everything that happened to titles" a
    // single query instead of a list of exact event names the UI has to keep in sync.
    const titleEvents = await server.get(`${API}/admin/audit?action=title.&limit=100`, { token: admin.token });
    assert.equal(titleEvents.status, 200);
    assert.ok(titleEvents.body.items.length > 0);
    assert.ok(titleEvents.body.items.every((entry) => entry.action.startsWith('title.')));

    const mine = await server.get(`${API}/admin/audit?actorId=${admin.user.id}&limit=100`, { token: admin.token });
    assert.ok(mine.body.items.length > 0, 'and by actor, for "what did this admin do?"');

    assert.equal((await server.get(`${API}/admin/audit?limit=101`, { token: admin.token })).status, 422);
    assert.equal((await server.get(`${API}/admin/audit?actorId=nobody`, { token: admin.token })).status, 422);
  });

  it('deletes a published title and takes it out of the catalogue with it', async () => {
    const title = await createDraft({ demoManifestUrl: DEMO_MANIFEST, posterUrl: POSTER });
    await server.post(`${API}/admin/titles/${title.id}/artwork/poster`, { token: admin.token, ...multipart() });
    await server.post(`${API}/admin/titles/${title.id}/unpublish`, { token: admin.token, body: { status: 'ready' } });
    assert.equal((await publishTitle(title.id)).status, 200);
    assert.equal((await server.get(`${API}/titles/${title.slug}`)).status, 200);

    const deleted = await server.delete(`${API}/admin/titles/${title.id}`, { token: admin.token });
    assert.equal(deleted.status, 200);
    assert.equal(deleted.body.deleted, true);

    assert.equal((await server.get(`${API}/admin/titles/${title.id}`, { token: admin.token })).status, 404);
    assert.equal((await server.get(`${API}/titles/${title.slug}`)).status, 404, 'and the cache was dropped with it');

    const second = await server.delete(`${API}/admin/titles/${title.id}`, { token: admin.token });
    assert.equal(second.status, 404, 'deleting it twice is a mistake, not a silent success');
    assert.equal(second.body.error.code, 'TITLE_NOT_FOUND');
  });
});

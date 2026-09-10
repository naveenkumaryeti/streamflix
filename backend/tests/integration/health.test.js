import '../helpers/setup.js';
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { closeDependencies, startServer } from '../helpers/server.js';
import { API } from '../helpers/fixtures.js';

/**
 * The wiring every other suite assumes: probes answer, the error handler shapes failures the
 * way the frontend parses them, and CORS rejects a foreign origin as a 403 rather than
 * collapsing into a 500.
 *
 * This is the one integration suite with no database requirement — `/readyz` is *supposed* to
 * return 503 when Postgres is missing, and asserting that is more valuable than skipping.
 */
let server;

before(async () => {
  server = await startServer();
});

after(async () => {
  await server.close();
  await closeDependencies();
});

describe('probes', () => {
  it('answers liveness without touching a single dependency', async () => {
    // If /healthz needed Postgres, a database blip would make kubelet restart every pod in
    // the deployment — turning a degraded API into no API at all.
    const res = await server.get('/healthz');
    assert.equal(res.status, 200);
    assert.equal(res.body.status, 'ok');
    assert.equal(res.body.service, 'streamflix-api');
    assert.equal(res.body.env, 'test');
    assert.equal(typeof res.body.uptimeSeconds, 'number');
  });

  it('reports every dependency by name on readiness', async () => {
    const res = await server.get('/readyz');
    assert.ok(res.status === 200 || res.status === 503, `unexpected ${res.status}`);
    assert.deepEqual(Object.keys(res.body.checks).sort(), ['dynamodb', 'postgres', 'redis']);
    // Postgres alone decides the verdict; Redis and DynamoDB are reported, not required.
    assert.equal(res.status === 200, res.body.checks.postgres.ok === true);
    assert.equal(res.body.status, res.status === 200 ? 'ready' : 'not-ready');
  });

  it('never throws when a dependency is unreachable', async () => {
    // A probe that 500s tells Kubernetes nothing useful. Each check is wrapped so an
    // unreachable host becomes `{ok:false,error}` in the payload instead of a stack trace.
    const res = await server.get('/readyz');
    for (const [name, check] of Object.entries(res.body.checks)) {
      assert.equal(typeof check.ok, 'boolean', name);
    }
  });

  it('publishes which build and which drivers are running', async () => {
    const res = await server.get('/version');
    assert.equal(res.status, 200);
    assert.equal(res.body.node, process.version);
    assert.deepEqual(res.body.drivers, {
      storage: 'local',
      transcoder: 'ffmpeg',
      cdn: 'local',
      payments: 'mock',
    });
    assert.ok(Date.parse(res.body.startedAt) > 0);
  });

  it('404s /metrics when scraping is disabled, instead of exposing an empty registry', async () => {
    const res = await server.get('/metrics');
    assert.equal(res.status, 404);
  });
});

describe('API surface', () => {
  it('advertises its resources at the prefix root', async () => {
    const res = await server.get(`${API}/`);
    assert.equal(res.status, 200);
    assert.equal(res.body.service, 'streamflix-api');
    for (const resource of ['auth', 'browse', 'titles', 'playback', 'subscriptions', 'admin']) {
      assert.ok(res.body.resources.includes(resource), resource);
    }
  });

  it('answers an unknown path with ROUTE_NOT_FOUND and a request id', async () => {
    const res = await server.get(`${API}/not-a-real-route`);
    assert.equal(res.status, 404);
    assert.equal(res.body.error.code, 'ROUTE_NOT_FOUND');
    assert.ok(res.body.error.requestId, 'the id in the response matches the one in the logs');
    assert.equal(res.headers.get('x-request-id'), res.body.error.requestId);
  });

  it('echoes a client-supplied request id so a trace spans both tiers', async () => {
    const requestId = 'test-req-0123456789';
    const res = await server.get('/healthz', { headers: { 'X-Request-Id': requestId } });
    assert.equal(res.headers.get('x-request-id'), requestId);
  });

  it('does not advertise Express to anyone scanning for a version', async () => {
    const res = await server.get('/healthz');
    assert.equal(res.headers.get('x-powered-by'), null);
    assert.ok(res.headers.get('x-content-type-options'), 'helmet is installed');
  });

  it('rejects a browser origin that is not on the allowlist', async () => {
    // `Access-Control-Allow-Origin: *` cannot be combined with credentials, and this API
    // sends both a bearer token and cookies — so the allowlist is the only workable option.
    // CORS runs ahead of routing, so this is rejected before the route is even resolved.
    const res = await server.get(`${API}/subscriptions/plans`, { headers: { Origin: 'https://evil.example' } });
    assert.equal(res.status, 403);
    assert.equal(res.body.error.code, 'ORIGIN_NOT_ALLOWED');
  });

  it('allows the frontend dev origin and reflects it back with credentials', async () => {
    const res = await server.get(`${API}/subscriptions/plans`, {
      headers: { Origin: 'http://localhost:5173' },
    });
    assert.equal(res.headers.get('access-control-allow-origin'), 'http://localhost:5173');
    assert.equal(res.headers.get('access-control-allow-credentials'), 'true');
  });

  it('allows a request with no Origin at all, because curl and kubelet have none', async () => {
    const res = await server.get('/healthz');
    assert.equal(res.status, 200);
  });

  it('answers a preflight with the headers the client actually sends', async () => {
    const res = await server.request('OPTIONS', `${API}/subscriptions`, {
      headers: {
        Origin: 'http://localhost:5173',
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'content-type,authorization,idempotency-key',
      },
    });
    assert.equal(res.status, 204);
    const allowed = String(res.headers.get('access-control-allow-headers')).toLowerCase();
    for (const header of ['content-type', 'authorization', 'idempotency-key']) {
      assert.ok(allowed.includes(header), header);
    }
  });

  it('rejects malformed JSON as a 400, not a 500', async () => {
    const res = await server.post(`${API}/auth/login`, {
      body: '{"email": "broken",',
      headers: { 'Content-Type': 'application/json' },
    });
    assert.equal(res.status, 400);
    assert.ok(res.body.error.code);
  });

  it('requires a token before it looks at the body', async () => {
    // Order matters: reporting validation errors on an unauthenticated request would leak
    // the shape of an admin payload to anyone who asks.
    const res = await server.post(`${API}/admin/titles`, { body: { nonsense: true } });
    assert.equal(res.status, 401);
    assert.equal(res.body.error.code, 'UNAUTHORIZED');
  });

  it('rejects a garbage bearer token as TOKEN_INVALID', async () => {
    const res = await server.get(`${API}/users/me`, { token: 'not.a.jwt' });
    assert.equal(res.status, 401);
    assert.equal(res.body.error.code, 'TOKEN_INVALID');
  });
});

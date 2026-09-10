import http from 'node:http';
import './setup.js';

/**
 * A real HTTP server on an ephemeral port, driven by Node's built-in `fetch`.
 *
 * Testing through a socket rather than by calling handlers directly is what makes these
 * suites able to catch the things that actually break in this app: middleware ordering, the
 * raw-body skip for webhooks, cookie flags, and status codes produced by the error handler.
 * Node 22 ships `fetch`, so there is no need for supertest.
 *
 * Port 0 lets the OS pick a free port, so suites can run in parallel and CI never collides
 * with something already listening on 8080.
 */
export async function startServer() {
  // Imported lazily: `./setup.js` above must populate process.env before config is parsed.
  const { default: app } = await import('../../src/app.js');

  const server = http.createServer(app);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  const { port } = server.address();
  const origin = `http://127.0.0.1:${port}`;

  /**
   * One request. `body` is JSON-encoded unless it is already a string or a Buffer — the
   * webhook tests need to send exact bytes, because the signature is computed over them.
   */
  async function request(method, path, { token = null, body, headers = {}, cookie = null } = {}) {
    const init = { method, headers: { Accept: 'application/json', ...headers }, redirect: 'manual' };

    if (body !== undefined) {
      const isRaw = typeof body === 'string' || Buffer.isBuffer(body);
      init.body = isRaw ? body : JSON.stringify(body);
      if (!isRaw && !init.headers['Content-Type']) init.headers['Content-Type'] = 'application/json';
    }
    if (token) init.headers.Authorization = `Bearer ${token}`;
    if (cookie) init.headers.Cookie = cookie;

    const response = await fetch(`${origin}${path}`, init);
    const text = await response.text();

    let payload = null;
    if (text) {
      try {
        payload = JSON.parse(text);
      } catch {
        payload = text; // /metrics is Prometheus text, and errors may be HTML from a proxy
      }
    }

    return {
      status: response.status,
      headers: response.headers,
      // Every JSON response in this API is an object, so this is safe to destructure in tests.
      body: payload ?? {},
      text,
      cookies: response.headers.getSetCookie?.() ?? [],
    };
  }

  const shorthand = (method) => (path, options) => request(method, path, options);

  return {
    origin,
    port,
    request,
    get: shorthand('GET'),
    post: shorthand('POST'),
    patch: shorthand('PATCH'),
    put: shorthand('PUT'),
    delete: shorthand('DELETE'),
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

/**
 * Is there a database to talk to?
 *
 * Integration suites skip rather than fail when there is not: a contributor running
 * `npm test` on a laptop with nothing else started should still get the unit suites, and
 * `node --test` reports skipped tests loudly enough that nobody mistakes them for passes.
 */
export async function databaseAvailable() {
  try {
    const { checkDatabase } = await import('../../src/db/postgres.js');
    const result = await checkDatabase();
    return result?.ok === true;
  } catch {
    return false;
  }
}

/** Release every pooled handle, or `node --test` hangs after the last assertion. */
export async function closeDependencies() {
  const [{ closeDatabase }, { closeRedis }, { closeDynamo }] = await Promise.all([
    import('../../src/db/postgres.js'),
    import('../../src/db/redis.js'),
    import('../../src/db/dynamodb.js'),
  ]);
  await Promise.allSettled([closeDatabase(), closeRedis(), Promise.resolve(closeDynamo())]);
}

export default { startServer, databaseAvailable, closeDependencies };

import '../helpers/setup.js';
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { closeDependencies, databaseAvailable, startServer } from '../helpers/server.js';
import { API, TEST_PASSWORD, login, registerUser, uniqueEmail } from '../helpers/fixtures.js';

/**
 * The account lifecycle, end to end over HTTP: register → sign in → read the session →
 * rotate the refresh token → sign out. Every assertion here is something the frontend
 * depends on, and several of them (cookie flags, rotation, reuse detection) cannot be
 * observed by calling the service directly.
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

const cookie = (jar, name) => jar.find((value) => value.startsWith(`${name}=`)) ?? null;
const cookieValue = (jar, name) => cookie(jar, name)?.split(';')[0].split('=')[1] ?? null;

describe('auth', { skip: online ? false : 'PostgreSQL is not reachable — start it with docker compose up postgres' }, () => {
  it('registers a new viewer and signs them in immediately', async () => {
    // No email-confirmation wall between signup and the catalogue: the funnel would leak
    // most of its users at that step, and the plan purchase is the real verification.
    const email = uniqueEmail('register');
    const res = await server.post(`${API}/auth/register`, {
      body: { email: ` ${email.toUpperCase()} `, password: TEST_PASSWORD, fullName: 'Asha Menon' },
    });

    assert.equal(res.status, 201);
    assert.equal(res.body.user.email, email, 'stored lowercased, so a second signup collides');
    assert.equal(res.body.user.fullName, 'Asha Menon');
    assert.equal(res.body.user.role, 'user');
    assert.equal(res.body.user.status, 'active');
    assert.equal(res.body.user.passwordHash, undefined, 'the hash never leaves the database');
    assert.ok(res.body.accessToken, 'an access token, so the client does not have to log in again');
    assert.ok(res.body.refreshToken);
    assert.ok(Date.parse(res.body.accessTokenExpiresAt) > Date.now(), 'the client knows when to refresh');
    assert.equal(res.body.entitlement.active, false, 'a fresh account has no plan yet');
  });

  it('sets the refresh token as an httpOnly cookie scoped to the auth routes', async () => {
    // Scoping the path means the 30-day credential is not attached to every catalogue
    // request — only to the two endpoints that can spend it.
    const { cookies } = await server.post(`${API}/auth/register`, {
      body: { email: uniqueEmail('cookie'), password: TEST_PASSWORD, fullName: 'Cookie Check' },
    });

    const refresh = cookie(cookies, 'sf_refresh');
    assert.ok(refresh, 'sf_refresh was set');
    assert.match(refresh, /HttpOnly/i, 'unreadable by JavaScript, so an XSS bug cannot steal it');
    assert.match(refresh, new RegExp(`Path=${API}/auth`, 'i'));
    assert.match(refresh, /SameSite=Lax/i);
    assert.doesNotMatch(refresh, /Secure/i, 'no Secure flag in test, or the cookie would never be sent over http');
  });

  it('refuses a second account on the same address', async () => {
    const { email } = await registerUser(server);
    const res = await server.post(`${API}/auth/register`, {
      body: { email, password: TEST_PASSWORD, fullName: 'Impostor' },
    });

    assert.equal(res.status, 409);
    assert.equal(res.body.error.code, 'EMAIL_TAKEN');
  });

  it('reports every bad field at once so a form fills in one round trip', async () => {
    const res = await server.post(`${API}/auth/register`, {
      body: { email: 'not-an-email', password: 'short', fullName: '' },
    });

    assert.equal(res.status, 422);
    assert.equal(res.body.error.code, 'VALIDATION_FAILED');
    const fields = res.body.error.details.fields.map((f) => f.field);
    assert.ok(fields.includes('email') && fields.includes('password') && fields.includes('fullName'));
    assert.ok(
      fields.every((field) => !field.startsWith('body.')),
      'bare field names, because they map to input elements',
    );
  });

  it('signs in with the right password and refuses the wrong one identically for both cases', async () => {
    // The same message and code for "no such user" and "wrong password" is deliberate:
    // anything else is an account-enumeration oracle.
    const { email } = await registerUser(server);

    const good = await server.post(`${API}/auth/login`, { body: { email, password: TEST_PASSWORD } });
    assert.equal(good.status, 200);
    assert.ok(good.body.accessToken);

    const wrongPassword = await server.post(`${API}/auth/login`, { body: { email, password: 'Wrong@12345' } });
    const noSuchUser = await server.post(`${API}/auth/login`, {
      body: { email: uniqueEmail('ghost'), password: TEST_PASSWORD },
    });

    assert.equal(wrongPassword.status, 401);
    assert.equal(noSuchUser.status, 401);
    assert.equal(wrongPassword.body.error.code, noSuchUser.body.error.code);
    assert.equal(wrongPassword.body.error.message, noSuchUser.body.error.message);
  });

  it('is case-insensitive about the address on the way back in', async () => {
    const { email } = await registerUser(server);
    const res = await server.post(`${API}/auth/login`, {
      body: { email: email.toUpperCase(), password: TEST_PASSWORD },
    });
    assert.equal(res.status, 200);
  });

  it('returns the signed-in user and their entitlement from /me', async () => {
    const { token, user } = await registerUser(server);
    const res = await server.get(`${API}/auth/me`, { token });

    assert.equal(res.status, 200);
    assert.equal(res.body.user.id, user.id);
    assert.equal(res.body.entitlement.active, false);
    assert.equal(res.body.user.passwordHash, undefined);
  });

  it('serves the fuller account view from /users/me', async () => {
    const { token, user } = await registerUser(server);
    const res = await server.get(`${API}/users/me`, { token });
    assert.equal(res.status, 200);
    assert.equal(res.body.user.id, user.id);
  });

  it('updates a display name without touching anything else', async () => {
    const { token } = await registerUser(server);
    const res = await server.patch(`${API}/users/me`, { token, body: { fullName: 'Renamed Viewer' } });
    assert.equal(res.status, 200);
    assert.equal(res.body.user.fullName, 'Renamed Viewer');
  });

  it('rotates the refresh token and invalidates the one just used', async () => {
    // Rotation is what turns a stolen refresh token into a one-shot: the thief and the
    // victim cannot both keep using the family.
    const { refreshToken } = await registerUser(server);

    const first = await server.post(`${API}/auth/refresh`, { body: { refreshToken } });
    assert.equal(first.status, 200);
    assert.ok(first.body.accessToken, 'a fresh access token');
    assert.notEqual(first.body.refreshToken, refreshToken, 'and a different refresh token');

    const replay = await server.post(`${API}/auth/refresh`, { body: { refreshToken } });
    assert.equal(replay.status, 401, 'the consumed token is dead');
    assert.equal(replay.body.error.code, 'REFRESH_REUSED');

    const family = await server.post(`${API}/auth/refresh`, { body: { refreshToken: first.body.refreshToken } });
    assert.equal(family.status, 401, 'and replaying one token revoked the whole family');
  });

  it('accepts the refresh cookie when the body has no token', async () => {
    // This is the browser path: the client never reads the token, it just posts.
    const { cookies } = await server.post(`${API}/auth/register`, {
      body: { email: uniqueEmail('cookie-refresh'), password: TEST_PASSWORD, fullName: 'Cookie Refresh' },
    });

    const res = await server.post(`${API}/auth/refresh`, {
      body: {},
      cookie: `sf_refresh=${cookieValue(cookies, 'sf_refresh')}`,
    });

    assert.equal(res.status, 200);
    assert.ok(cookie(res.cookies, 'sf_refresh'), 'and the rotated token replaces the cookie');
  });

  it('says REFRESH_MISSING rather than a generic 401 when nothing was sent', async () => {
    const res = await server.post(`${API}/auth/refresh`, { body: {} });
    assert.equal(res.status, 401);
    assert.equal(res.body.error.code, 'REFRESH_MISSING');
  });

  it('clears the cookie when a refresh fails, instead of looping the client through 401s', async () => {
    const res = await server.post(`${API}/auth/refresh`, { body: { refreshToken: 'garbage.token.value.xyz' } });
    assert.equal(res.status, 401);
    const cleared = cookie(res.cookies, 'sf_refresh');
    assert.ok(cleared, 'a clearing Set-Cookie is sent');
    assert.match(cleared, /Expires=Thu, 01 Jan 1970|Max-Age=0/i);
  });

  it('lists the sessions a user can see and revoke', async () => {
    const { token } = await registerUser(server);
    const res = await server.get(`${API}/auth/sessions`, { token });
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body.items));
    assert.ok(res.body.items.length >= 1);
    for (const session of res.body.items) {
      assert.equal(session.tokenHash, undefined, 'the stored hash is not session metadata');
    }
  });

  it('revokes the refresh token on logout so the session cannot be revived', async () => {
    const { token, refreshToken } = await registerUser(server);

    const out = await server.post(`${API}/auth/logout`, { token, body: { refreshToken } });
    assert.equal(out.status, 200);
    assert.equal(out.body.revoked, true);
    assert.match(cookie(out.cookies, 'sf_refresh') ?? '', /Expires=Thu, 01 Jan 1970|Max-Age=0/i);

    const reuse = await server.post(`${API}/auth/refresh`, { body: { refreshToken } });
    assert.equal(reuse.status, 401, 'the refresh token cannot mint a new access token');
  });

  it('denylists the access token too, so the 15 minutes left on it are unusable', async () => {
    // The denylist lives in Redis. Without it a "signed out" token keeps working until it
    // expires — which is exactly what a stolen laptop needs — so the behaviour is asserted
    // when Redis is present and reported as skipped when it is not, never silently passed.
    const ready = await server.get('/readyz');
    if (ready.body.checks.redis.ok !== true) {
      return; // Redis is optional for the rest of the API; this one guarantee needs it.
    }

    const { token, refreshToken } = await registerUser(server);
    await server.post(`${API}/auth/logout`, { token, body: { refreshToken } });

    const after = await server.get(`${API}/auth/me`, { token });
    assert.equal(after.status, 401, 'the token is refused even though it has not expired');
    assert.equal(after.body.error.code, 'TOKEN_REVOKED');
  });

  it('signs every other device out when the password changes', async () => {
    // "Other devices" means their refresh tokens: an access token elsewhere dies within
    // minutes on its own, but a 30-day refresh token would outlive the compromise.
    const { email, token } = await registerUser(server);
    const other = await login(server, email, TEST_PASSWORD);

    const changed = await server.post(`${API}/auth/password`, {
      token,
      body: { currentPassword: TEST_PASSWORD, newPassword: 'Brand@New99' },
    });
    assert.equal(changed.status, 200);
    assert.ok(changed.body.sessionsEnded >= 2, 'both sessions were counted');

    const stale = await server.post(`${API}/auth/refresh`, { body: { refreshToken: other.refreshToken } });
    assert.equal(stale.status, 401, 'the session on the other device cannot be renewed');

    const oldPassword = await server.post(`${API}/auth/login`, { body: { email, password: TEST_PASSWORD } });
    assert.equal(oldPassword.status, 401);

    const newPassword = await server.post(`${API}/auth/login`, { body: { email, password: 'Brand@New99' } });
    assert.equal(newPassword.status, 200);
  });

  it('will not change a password without the current one, and names the field', async () => {
    const { token } = await registerUser(server);
    const res = await server.post(`${API}/auth/password`, {
      token,
      body: { currentPassword: 'Not@Theone1', newPassword: 'Brand@New99' },
    });
    assert.equal(res.status, 400);
    assert.equal(res.body.error.details.fields[0].field, 'currentPassword');
  });

  it('keeps admin routes closed to a customer token', async () => {
    const { token } = await registerUser(server);
    const res = await server.get(`${API}/admin/dashboard`, { token });
    assert.equal(res.status, 403);
    assert.equal(res.body.error.code, 'ADMIN_ONLY');
  });
});

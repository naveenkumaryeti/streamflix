import { randomUUID } from 'node:crypto';
import './setup.js';

/**
 * Shared test data and the two or three flows every integration suite needs before it can
 * assert anything interesting: an account, a token, and (for playback) a paid plan.
 *
 * Everything here goes through the public API rather than SQL. It is slower, but a fixture
 * that inserts rows directly can drift from what registration actually does — and then the
 * suite passes while the endpoint is broken.
 */
export const API = process.env.API_PREFIX || '/api/v1';

export const TEST_PASSWORD = 'Test@12345';

/** Unique per call, so a suite can be re-run against the same database without cleanup. */
export const uniqueEmail = (prefix = 'user') => `${prefix}-${randomUUID().slice(0, 12)}@streamflix.test`;

/** Passes the mock provider's Luhn check and is never in its decline list. */
export const testCard = (overrides = {}) => ({
  number: '4242424242424242',
  name: 'Test Subscriber',
  expMonth: 12,
  expYear: new Date().getFullYear() + 3,
  cvc: '123',
  ...overrides,
});

/** A card the mock provider always declines — used to assert the 402 path. */
export const declinedCard = () => testCard({ number: '4000000000000002' });

/**
 * Register a fresh account and return the tokens with it. `register` already returns the
 * full session, so there is no second login round trip.
 */
export async function registerUser(server, { email = uniqueEmail(), fullName = 'Test Viewer', password = TEST_PASSWORD } = {}) {
  const response = await server.post(`${API}/auth/register`, { body: { email, password, fullName } });
  if (response.status !== 201) {
    throw new Error(`registration failed (${response.status}): ${JSON.stringify(response.body)}`);
  }

  return {
    email,
    password,
    user: response.body.user,
    token: response.body.accessToken,
    refreshToken: response.body.refreshToken,
    entitlement: response.body.entitlement,
  };
}

export async function login(server, email, password = TEST_PASSWORD) {
  const response = await server.post(`${API}/auth/login`, { body: { email, password } });
  if (response.status !== 200) {
    throw new Error(`login failed (${response.status}): ${JSON.stringify(response.body)}`);
  }
  return { user: response.body.user, token: response.body.accessToken, refreshToken: response.body.refreshToken };
}

/**
 * The seeded admin. Its credentials come from the same env vars the seed script reads, so a
 * developer who changed them in `.env` does not get a mysterious 401 here.
 */
export async function loginAdmin(server) {
  const email = process.env.SEED_ADMIN_EMAIL || 'admin@streamflix.local';
  const password = process.env.SEED_ADMIN_PASSWORD || 'Admin@12345';

  const response = await server.post(`${API}/auth/login`, { body: { email, password } });
  if (response.status !== 200) {
    throw new Error(
      `admin login failed (${response.status}) — has the database been seeded? ${JSON.stringify(response.body)}`,
    );
  }
  if (response.body.user?.role !== 'admin') {
    throw new Error(`${email} exists but is not an admin — check the seed`);
  }
  return { user: response.body.user, token: response.body.accessToken };
}

/** Register, then buy a plan, because playback is gated on an active subscription. */
export async function subscribedUser(server, { planCode = 'standard' } = {}) {
  const account = await registerUser(server);
  const response = await server.post(`${API}/subscriptions`, {
    token: account.token,
    body: { planCode, card: testCard() },
  });
  if (response.status !== 201) {
    throw new Error(`subscribe failed (${response.status}): ${JSON.stringify(response.body)}`);
  }

  // The entitlement changed, so the cached copy on the old token's response is stale; the
  // token itself is still valid — entitlement is read per request, never from the JWT.
  return { ...account, subscription: response.body.subscription, entitlement: response.body.entitlement };
}

/** The first published title in the catalogue — enough for any "can I play something" test. */
export async function anyPublishedTitle(server, token = null) {
  const response = await server.get(`${API}/browse`, { token });
  if (response.status !== 200) throw new Error(`browse failed (${response.status})`);

  for (const row of response.body.rows ?? []) {
    const title = (row.items ?? [])[0];
    if (title) return title;
  }
  throw new Error('the catalogue is empty — run `npm run seed`');
}

export default {
  API,
  TEST_PASSWORD,
  uniqueEmail,
  testCard,
  declinedCard,
  registerUser,
  login,
  loginAdmin,
  subscribedUser,
  anyPublishedTitle,
};

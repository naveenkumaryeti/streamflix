import '../helpers/setup.js';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { closeDependencies, databaseAvailable, startServer } from '../helpers/server.js';
import {
  API,
  anyPublishedTitle,
  declinedCard,
  registerUser,
  subscribedUser,
  testCard,
} from '../helpers/fixtures.js';
import { signWebhook } from '../../src/modules/subscriptions/providers/mockProvider.js';

/**
 * The money and the video, in the order a customer meets them: see the plans, pay, get a
 * stream, keep your place, cancel.
 *
 * Two guarantees here are worth more than the rest put together. Playback is refused without
 * a live plan — the only thing standing between the catalogue and free streaming — and
 * subscribing is idempotent, because a double-tapped button that charges twice is the kind of
 * bug customers tell their friends about.
 */
const online = await databaseAvailable();
let server;
let stores = { redis: false, dynamodb: false };

before(async () => {
  server = await startServer();
  if (online) {
    const ready = await server.get('/readyz');
    stores = {
      redis: ready.body.checks?.redis?.ok === true,
      dynamodb: ready.body.checks?.dynamodb?.ok === true,
    };
  }
});

after(async () => {
  await server.close();
  await closeDependencies();
});

const skip = online ? false : 'PostgreSQL is not reachable — start it with docker compose up postgres';

describe('plans', { skip }, () => {
  it('publishes the price list without a session, because pricing is a marketing page', async () => {
    const res = await server.get(`${API}/subscriptions/plans`);

    assert.equal(res.status, 200);
    assert.ok(res.body.items.length >= 3, 'the seed ships mobile, standard and premium');
    for (const plan of res.body.items) {
      assert.ok(plan.code && plan.name);
      assert.ok(Number.isInteger(plan.priceCents), 'money is an integer number of paise, never a float');
      assert.ok(plan.maxStreams >= 1);
      assert.ok(['480p', '720p', '1080p', '4k'].includes(plan.maxQuality));
    }
  });

  it('reports no plan for a fresh account rather than 404', async () => {
    const { token } = await registerUser(server);
    const res = await server.get(`${API}/subscriptions/me`, { token });

    assert.equal(res.status, 200);
    assert.equal(res.body.subscription, null);
    assert.equal(res.body.entitlement.active, false);
    assert.equal(res.body.entitlement.maxStreams, 0);
    assert.deepEqual(res.body.history, []);
  });
});

describe('subscribing', { skip }, () => {
  it('charges the card, activates the plan and returns the receipt', async () => {
    const { token } = await registerUser(server);
    const res = await server.post(`${API}/subscriptions`, {
      token,
      body: { planCode: 'standard', card: testCard() },
    });

    assert.equal(res.status, 201);
    assert.equal(res.body.replayed, false);
    assert.equal(res.body.subscription.status, 'active');
    assert.equal(res.body.payment.status, 'succeeded');
    assert.equal(res.body.payment.methodLast4, '4242', 'the last four, and nothing more of the card');
    assert.equal(res.body.payment.methodBrand, 'visa');
    assert.equal(res.body.entitlement.active, true);
    assert.equal(res.body.entitlement.planCode, 'standard');
    assert.equal(res.body.entitlement.maxStreams, 2);
    assert.equal(res.body.entitlement.maxQuality, '1080p');
  });

  it('stores nothing that could be used to charge the card again', async () => {
    const { token } = await registerUser(server);
    const res = await server.post(`${API}/subscriptions`, {
      token,
      body: { planCode: 'mobile', card: testCard() },
    });

    const serialised = JSON.stringify(res.body);
    assert.ok(!serialised.includes('4242424242424242'), 'the full PAN is never echoed');
    assert.ok(!serialised.includes('"cvc"'), 'and the CVC is not persisted at all');
  });

  it('returns 402 with the bank reason when the card is declined', async () => {
    // 402 rather than 400: nothing was wrong with the request, the payment simply failed —
    // and the frontend shows a retry form instead of a validation error.
    const { token } = await registerUser(server);
    const res = await server.post(`${API}/subscriptions`, {
      token,
      body: { planCode: 'standard', card: declinedCard() },
    });

    assert.equal(res.status, 402);
    assert.equal(res.body.error.code, 'PAYMENT_FAILED');
    assert.match(res.body.error.message, /declined/i);

    const me = await server.get(`${API}/subscriptions/me`, { token });
    assert.equal(me.body.entitlement.active, false, 'a failed charge grants nothing');
    assert.equal(me.body.history.length, 0, 'and starts no subscription');
  });

  it('records the failed attempt as a payment row, so support can see it', async () => {
    const { token } = await registerUser(server);
    await server.post(`${API}/subscriptions`, { token, body: { planCode: 'standard', card: declinedCard() } });

    const payments = await server.get(`${API}/subscriptions/payments`, { token });
    assert.equal(payments.status, 200);
    assert.equal(payments.body.items.length, 1);
    assert.equal(payments.body.items[0].status, 'failed');
    assert.ok(payments.body.items[0].failureReason);
  });

  it('charges once when the same request arrives twice', async () => {
    // A retry after a dropped connection, a double-clicked button and a webhook replay all
    // land here. The second call returns the first outcome with 200, not a second charge.
    const { token } = await registerUser(server);
    const idempotencyKey = randomUUID();
    const body = { planCode: 'premium', card: testCard() };

    const first = await server.post(`${API}/subscriptions`, { token, body, headers: { 'Idempotency-Key': idempotencyKey } });
    const second = await server.post(`${API}/subscriptions`, { token, body, headers: { 'Idempotency-Key': idempotencyKey } });

    assert.equal(first.status, 201);
    assert.equal(second.status, 200, '200 says "here is the earlier result", 201 would claim a new charge');
    assert.equal(second.body.replayed, true);
    assert.equal(second.body.payment.id, first.body.payment.id);

    const payments = await server.get(`${API}/subscriptions/payments`, { token });
    assert.equal(payments.body.meta.totalItems, 1, 'one row in the ledger, one charge on the card');
  });

  it('refuses to sell the plan the customer is already on', async () => {
    const { token } = await subscribedUser(server, { planCode: 'standard' });
    const res = await server.post(`${API}/subscriptions`, {
      token,
      body: { planCode: 'standard', card: testCard() },
    });

    assert.equal(res.status, 409);
    assert.equal(res.body.error.code, 'ALREADY_SUBSCRIBED');
  });

  it('upgrades an existing subscriber in place instead of opening a second one', async () => {
    const { token } = await subscribedUser(server, { planCode: 'mobile' });
    const upgrade = await server.post(`${API}/subscriptions`, {
      token,
      body: { planCode: 'premium', card: testCard() },
    });

    assert.equal(upgrade.status, 201);
    assert.equal(upgrade.body.entitlement.planCode, 'premium');
    assert.equal(upgrade.body.entitlement.maxQuality, '4k');

    const me = await server.get(`${API}/subscriptions/me`, { token });
    assert.equal(me.body.subscription.planCode, 'premium');
    assert.equal(me.body.history.length, 1, 'one subscription, changed — not two');
  });

  it('404s an unknown plan code and 422s a malformed one', async () => {
    const { token } = await registerUser(server);
    const unknown = await server.post(`${API}/subscriptions`, {
      token,
      body: { planCode: 'platinum-plus', card: testCard() },
    });
    assert.equal(unknown.status, 404);
    assert.equal(unknown.body.error.code, 'PLAN_NOT_FOUND');

    const malformed = await server.post(`${API}/subscriptions`, {
      token,
      body: { planCode: 'Premium; DROP TABLE plans', card: testCard() },
    });
    assert.equal(malformed.status, 422);
  });

  it('validates the card before it reaches the payment provider', async () => {
    const { token } = await registerUser(server);
    const res = await server.post(`${API}/subscriptions`, {
      token,
      body: { planCode: 'standard', card: testCard({ number: '4242', cvc: '1' }) },
    });

    assert.equal(res.status, 422);
    const fields = res.body.error.details.fields.map((f) => f.field);
    assert.ok(fields.includes('card.number'));
    assert.ok(fields.includes('card.cvc'));
  });

  it('needs an account: an anonymous visitor cannot buy a plan', async () => {
    const res = await server.post(`${API}/subscriptions`, { body: { planCode: 'standard', card: testCard() } });
    assert.equal(res.status, 401);
  });
});

describe('cancelling and resuming', { skip }, () => {
  it('cancels at period end by default, because the customer paid for the rest of it', async () => {
    const { token } = await subscribedUser(server);
    const res = await server.post(`${API}/subscriptions/cancel`, { token, body: {} });

    assert.equal(res.status, 200);
    assert.equal(res.body.subscription.cancelAtPeriodEnd, true);
    assert.equal(res.body.entitlement.active, true, 'still watching until the period ends');
  });

  it('undoes a scheduled cancellation', async () => {
    const { token } = await subscribedUser(server);
    await server.post(`${API}/subscriptions/cancel`, { token, body: {} });

    const resumed = await server.post(`${API}/subscriptions/resume`, { token });
    assert.equal(resumed.status, 200);
    assert.equal(resumed.body.subscription.cancelAtPeriodEnd, false);
    assert.equal(resumed.body.entitlement.active, true);
  });

  it('ends access immediately when asked to, and then refuses playback', async () => {
    const { token } = await subscribedUser(server);
    const title = await anyPublishedTitle(server, token);

    const cancelled = await server.post(`${API}/subscriptions/cancel`, { token, body: { immediate: true } });
    assert.equal(cancelled.status, 200);
    assert.equal(cancelled.body.subscription.status, 'canceled');
    assert.equal(cancelled.body.entitlement.active, false);

    const play = await server.post(`${API}/playback/${title.id}/start`, { token, body: {} });
    assert.equal(play.status, 403);
    assert.equal(play.body.error.code, 'SUBSCRIPTION_REQUIRED');
  });

  it('has nothing to cancel when there is no plan', async () => {
    const { token } = await registerUser(server);
    const res = await server.post(`${API}/subscriptions/cancel`, { token, body: {} });
    assert.equal(res.status, 404);
    assert.equal(res.body.error.code, 'NO_ACTIVE_SUBSCRIPTION');
  });
});

describe('webhooks', { skip }, () => {
  const post = (rawBody, header) =>
    server.post(`${API}/subscriptions/webhook`, {
      body: rawBody,
      headers: { 'Content-Type': 'application/json', ...(header ? { 'X-StreamFlix-Signature': header } : {}) },
    });

  it('accepts a correctly signed event', async () => {
    const rawBody = JSON.stringify({ type: 'payment.succeeded', data: { providerPaymentId: 'mock_unknown' } });
    const res = await post(rawBody, signWebhook(rawBody).header);

    assert.equal(res.status, 200);
    assert.equal(res.body.received, true);
    assert.equal(res.body.ignored, 'unknown payment', 'an event about a payment we never made is not an error');
  });

  it('rejects a body that was altered after signing', async () => {
    // The signature covers the exact bytes, which is why the JSON parser is skipped for this
    // path — re-serialising the body would break every signature in production.
    const rawBody = JSON.stringify({ type: 'payment.succeeded', data: { providerPaymentId: 'mock_1' } });
    const res = await post(rawBody.replace('mock_1', 'mock_2'), signWebhook(rawBody).header);

    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, 'WEBHOOK_INVALID');
    assert.match(res.body.error.message, /signature mismatch/);
  });

  it('rejects a replay of yesterday capture', async () => {
    const rawBody = JSON.stringify({ type: 'payment.succeeded', data: {} });
    const stale = signWebhook(rawBody, Math.floor(Date.now() / 1000) - 86400);
    const res = await post(rawBody, stale.header);

    assert.equal(res.status, 400);
    assert.match(res.body.error.message, /too old/);
  });

  it('rejects an unsigned request', async () => {
    const res = await post(JSON.stringify({ type: 'payment.succeeded' }), null);
    assert.equal(res.status, 400);
    assert.match(res.body.error.message, /missing signature header/);
  });

  it('is idempotent about an event it has already applied', async () => {
    const { token } = await subscribedUser(server);
    const payments = await server.get(`${API}/subscriptions/payments`, { token });
    const providerPaymentId = payments.body.items[0].providerPaymentId;

    const rawBody = JSON.stringify({ type: 'payment.succeeded', data: { providerPaymentId } });
    const res = await post(rawBody, signWebhook(rawBody).header);

    assert.equal(res.status, 200);
    assert.equal(res.body.idempotent, true, 'the payment was already succeeded — nothing to do');
  });
});

describe('playback', { skip }, () => {
  it('refuses to start a stream without a live plan', async () => {
    const { token } = await registerUser(server);
    const title = await anyPublishedTitle(server, token);

    const res = await server.post(`${API}/playback/${title.id}/start`, { token, body: {} });
    assert.equal(res.status, 403);
    assert.equal(res.body.error.code, 'SUBSCRIPTION_REQUIRED', 'the frontend opens the plans page on this code');
  });

  it('hands a subscriber a manifest, a session and the renditions their plan allows', async () => {
    const { token } = await subscribedUser(server, { planCode: 'mobile' });
    const title = await anyPublishedTitle(server, token);

    const res = await server.post(`${API}/playback/${title.id}/start`, { token, body: {} });

    assert.equal(res.status, 200);
    assert.equal(res.body.title.id, title.id);
    assert.equal(res.body.source.type, 'hls');
    assert.ok(res.body.source.url, 'a URL the player can hand to hls.js');
    assert.ok(res.body.playback.token, 'and a short-lived token that authorises the segments');
    assert.equal(res.body.playback.maxQuality, '480p');
    assert.deepEqual(res.body.playback.renditions, ['480p'], 'a mobile plan is not offered 1080p');
    assert.match(res.body.session.id, /^[0-9a-f-]{36}$/);
    assert.ok(res.body.session.heartbeatSeconds > 0, 'the client is told how often to ping');
  });

  it('offers the full ladder to a premium plan', async () => {
    const { token } = await subscribedUser(server, { planCode: 'premium' });
    const title = await anyPublishedTitle(server, token);

    const res = await server.post(`${API}/playback/${title.id}/start`, { token, body: {} });
    assert.equal(res.body.playback.maxQuality, '4k');
    assert.ok(res.body.playback.renditions.includes('1080p'));
  });

  it('scopes the playback cookie to /media and keeps it away from JavaScript', async () => {
    const { token } = await subscribedUser(server);
    const title = await anyPublishedTitle(server, token);

    const res = await server.post(`${API}/playback/${title.id}/start`, { token, body: {} });
    const cookie = res.cookies.find((value) => value.startsWith('sf_playback='));

    assert.ok(cookie, 'local mode sets a fallback cookie for players that drop the URL token');
    assert.match(cookie, /HttpOnly/i);
    assert.match(cookie, /Path=\/media/i);
  });

  it('reuses a session id the client already holds, so a reload is not a second screen', async () => {
    const { token } = await subscribedUser(server);
    const title = await anyPublishedTitle(server, token);

    const first = await server.post(`${API}/playback/${title.id}/start`, { token, body: {} });
    const again = await server.post(`${API}/playback/${title.id}/start`, {
      token,
      body: { sessionId: first.body.session.id },
    });

    assert.equal(again.body.session.id, first.body.session.id);
  });

  it('404s a title id that is not published, without saying which', async () => {
    const { token } = await subscribedUser(server);
    const res = await server.post(`${API}/playback/${randomUUID()}/start`, { token, body: {} });

    assert.equal(res.status, 404);
    assert.equal(res.body.error.code, 'TITLE_NOT_FOUND');
  });

  it('422s a title id that is not a uuid, before any lookup', async () => {
    const { token } = await subscribedUser(server);
    const res = await server.post(`${API}/playback/not-a-uuid/start`, { token, body: {} });
    assert.equal(res.status, 422);
    assert.equal(res.body.error.details.fields[0].field, 'params.titleId');
  });

  it('lets a lapsed subscriber read their history, which is what wins them back', async () => {
    const { token } = await registerUser(server);
    const res = await server.get(`${API}/playback/history`, { token });

    assert.equal(res.status, 200, 'no plan required to see where you left off');
    assert.ok(Array.isArray(res.body.items));
  });

  it('lists active streams so a viewer can free a screen themselves', async () => {
    const { token } = await subscribedUser(server);
    const res = await server.get(`${API}/playback/streams`, { token });

    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body.items));
  });
});

describe('watch progress', { skip }, () => {
  it('remembers a position and surfaces it as continue watching', async () => {
    if (!stores.dynamodb) return; // progress lives in DynamoDB; start it with docker compose up dynamodb

    const { token } = await subscribedUser(server);
    const title = await anyPublishedTitle(server, token);
    const started = await server.post(`${API}/playback/${title.id}/start`, { token, body: {} });

    const ping = await server.post(`${API}/playback/${title.id}/progress`, {
      token,
      body: { positionSeconds: 640, durationSeconds: 7200, sessionId: started.body.session.id },
    });

    assert.equal(ping.status, 200);
    assert.equal(ping.body.progress.positionSeconds, 640);
    assert.equal(ping.body.progress.percent, 8.9, 'a percentage the UI can draw a bar from');
    assert.equal(ping.body.progress.completed, false);

    const row = await server.get(`${API}/continue-watching`, { token });
    assert.equal(row.body.items[0].id, title.id);
    assert.equal(row.body.items[0].progress.positionSeconds, 640);

    const browse = await server.get(`${API}/browse`, { token });
    assert.equal(browse.body.rows[0].key, 'continue', 'and it is the first row on the home page');
  });

  it('marks a title finished past 95%, so credits do not sit in the row forever', async () => {
    if (!stores.dynamodb) return;

    const { token } = await subscribedUser(server);
    const title = await anyPublishedTitle(server, token);
    await server.post(`${API}/playback/${title.id}/start`, { token, body: {} });

    const ping = await server.post(`${API}/playback/${title.id}/progress`, {
      token,
      body: { positionSeconds: 6900, durationSeconds: 7200 },
    });
    assert.equal(ping.body.progress.completed, true);
  });

  it('keeps the last position when the stream stops', async () => {
    if (!stores.dynamodb) return;

    const { token } = await subscribedUser(server);
    const title = await anyPublishedTitle(server, token);
    const started = await server.post(`${API}/playback/${title.id}/start`, { token, body: {} });

    const stopped = await server.post(`${API}/playback/${title.id}/stop`, {
      token,
      body: { positionSeconds: 1200, durationSeconds: 7200, sessionId: started.body.session.id },
    });

    assert.equal(stopped.status, 200);
    assert.equal(stopped.body.stopped, true);
    assert.equal(stopped.body.progress.positionSeconds, 1200);

    const cleared = stopped.cookies.find((value) => value.startsWith('sf_playback='));
    assert.ok(cleared, 'the playback cookie is cleared on stop');
    assert.match(cleared, /Expires=Thu, 01 Jan 1970|Max-Age=0/i);

    const history = await server.get(`${API}/playback/history`, { token });
    assert.ok(history.body.items.some((entry) => entry.titleId === title.id));
  });

  it('forgets a title on request, and then it leaves the row', async () => {
    if (!stores.dynamodb) return;

    const { token } = await subscribedUser(server);
    const title = await anyPublishedTitle(server, token);
    await server.post(`${API}/playback/${title.id}/progress`, { token, body: { positionSeconds: 90 } });

    const forgotten = await server.delete(`${API}/playback/progress/${title.id}`, { token });
    assert.equal(forgotten.status, 200);
    assert.equal(forgotten.body.removed, true);

    const row = await server.get(`${API}/continue-watching`, { token });
    assert.ok(!row.body.items.some((item) => item.id === title.id));
  });

  it('rejects a negative position rather than storing it', async () => {
    const { token } = await subscribedUser(server);
    const title = await anyPublishedTitle(server, token);

    const res = await server.post(`${API}/playback/${title.id}/progress`, {
      token,
      body: { positionSeconds: -30 },
    });
    assert.equal(res.status, 422);
  });

  it('keeps one viewer progress out of another history', async () => {
    if (!stores.dynamodb) return;

    const first = await subscribedUser(server);
    const second = await subscribedUser(server);
    const title = await anyPublishedTitle(server);

    await server.post(`${API}/playback/${title.id}/progress`, { token: first.token, body: { positionSeconds: 300 } });
    const other = await server.get(`${API}/playback/history`, { token: second.token });
    assert.deepEqual(other.body.items, []);
  });
});

describe('stream limit', { skip }, () => {
  it('enforces the plan screen count when Redis is counting, and fails open when it is not', async () => {
    // Both branches are correct behaviour, and which one applies depends on the environment —
    // so the test asserts the one that is actually in force rather than skipping outright.
    // Refusing playback to paying customers because a cache node is rebooting would be a
    // worse outage than briefly allowing an extra screen.
    const { token } = await subscribedUser(server, { planCode: 'mobile' });
    const title = await anyPublishedTitle(server, token);

    const first = await server.post(`${API}/playback/${title.id}/start`, { token, body: {} });
    assert.equal(first.status, 200);

    const second = await server.post(`${API}/playback/${title.id}/start`, { token, body: {} });

    if (stores.redis) {
      assert.equal(second.status, 409, 'a one-screen plan allows one screen');
      assert.equal(second.body.error.code, 'STREAM_LIMIT_REACHED');
      assert.equal(second.body.error.details.maxStreams, 1);
      assert.match(second.body.error.message, /1 screen at a time/);

      const streams = await server.get(`${API}/playback/streams`, { token });
      assert.equal(streams.body.items.length, 1);

      await server.post(`${API}/playback/${title.id}/stop`, {
        token,
        body: { sessionId: first.body.session.id },
      });
      const retry = await server.post(`${API}/playback/${title.id}/start`, { token, body: {} });
      assert.equal(retry.status, 200, 'stopping the first stream frees the screen');
    } else {
      assert.equal(second.status, 200, 'without Redis the limiter degrades instead of denying');
      assert.equal(second.body.session.enforced ?? false, false);
    }
  });
});

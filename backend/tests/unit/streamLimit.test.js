import '../helpers/setup.js';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';
import streamLimit, { acquireSlot, heartbeat, listSlots, releaseAll, releaseSlot } from '../../src/modules/playback/streamLimit.js';

/**
 * Fail-open behaviour, asserted without Redis.
 *
 * This suite deliberately never connects: `isRedisReady()` is false, which is exactly the
 * production incident worth testing. Refusing playback to paying customers because a cache
 * node is rebooting would be a far worse outage than briefly allowing an extra screen, so
 * every entry point has to degrade rather than throw. The enforcing path is covered by the
 * integration suite, which does have Redis.
 */
const userId = randomUUID();
const titleId = randomUUID();

describe('stream limiter without Redis', () => {
  it('allows the stream and says so, so the client can hide the device panel', async () => {
    const slot = await acquireSlot({ userId, titleId, maxStreams: 2 });

    assert.equal(slot.enforced, false, 'the response tells the caller the limit was not applied');
    assert.equal(slot.active, 1);
    assert.equal(slot.maxStreams, 2);
    assert.match(slot.sessionId, /^[0-9a-f-]{36}$/);
  });

  it('honours a session id the client already has', async () => {
    const sessionId = randomUUID();
    const slot = await acquireSlot({ userId, titleId, maxStreams: 1, sessionId });
    assert.equal(slot.sessionId, sessionId);
  });

  it('mints a session id when the client has none', async () => {
    const first = await acquireSlot({ userId, titleId, maxStreams: 1 });
    const second = await acquireSlot({ userId, titleId, maxStreams: 1 });
    assert.notEqual(first.sessionId, second.sessionId);
  });

  it('never throws a stream-limit error when it cannot count streams', async () => {
    // maxStreams: 0 is what a lapsed account looks like. Even then the limiter must not be
    // the thing that fails — entitlement checks are what deny playback, not this.
    const slot = await acquireSlot({ userId, titleId, maxStreams: 0 });
    assert.equal(slot.enforced, false);
  });

  it('reports heartbeats and releases as no-ops instead of failing the request', async () => {
    const sessionId = randomUUID();
    assert.deepEqual(await heartbeat({ userId, titleId, sessionId }), { ok: false });
    assert.deepEqual(await releaseSlot({ userId, titleId, sessionId }), { released: false });
    assert.deepEqual(await listSlots(userId), []);
    assert.equal(await releaseAll(userId), 0);
  });

  it('ignores a heartbeat with no session id', async () => {
    assert.deepEqual(await heartbeat({ userId, titleId, sessionId: undefined }), { ok: false });
    assert.deepEqual(await releaseSlot({ userId, titleId, sessionId: null }), { released: false });
  });
});

describe('stream limiter constants', () => {
  it('heartbeats well inside the slot TTL', () => {
    // The slot expires after 90s; a 30s ping gives two chances to miss before a viewer
    // loses their screen to a dropped request.
    assert.equal(streamLimit.heartbeatSeconds, 30);
  });

  it('mints v4 session ids', () => {
    const id = streamLimit.newSessionId();
    assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});

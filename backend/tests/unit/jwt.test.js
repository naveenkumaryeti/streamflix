import '../helpers/setup.js';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';
import jwt from 'jsonwebtoken';
import config from '../../src/config/env.js';
import {
  secondsUntilExpiry,
  sha256,
  signAccessToken,
  signPlaybackToken,
  signRefreshToken,
  verifyAccessToken,
  verifyPlaybackToken,
  verifyRefreshToken,
} from '../../src/utils/jwt.js';

const user = { id: randomUUID(), email: 'viewer@streamflix.test', role: 'user' };

describe('access tokens', () => {
  it('carries the claims middleware and controllers rely on', () => {
    const { token, jti, expiresAt } = signAccessToken(user);
    const payload = verifyAccessToken(token);

    assert.equal(payload.sub, user.id);
    assert.equal(payload.email, user.email);
    assert.equal(payload.role, 'user');
    assert.equal(payload.typ, 'access');
    assert.equal(payload.jti, jti);
    assert.equal(payload.iss, config.tokens.issuer);
    assert.ok(expiresAt instanceof Date);
    assert.ok(expiresAt.getTime() > Date.now());
  });

  it('is signed with HS256 and nothing else', () => {
    const { token } = signAccessToken(user);
    const header = JSON.parse(Buffer.from(token.split('.')[0], 'base64url').toString());
    assert.equal(header.alg, 'HS256');
  });

  it('refuses a token signed with the wrong secret', () => {
    const forged = jwt.sign({ sub: user.id, typ: 'access' }, 'not-the-real-secret', {
      algorithm: 'HS256',
      issuer: config.tokens.issuer,
      expiresIn: '15m',
    });
    assert.throws(() => verifyAccessToken(forged), (err) => err.code === 'TOKEN_INVALID' && err.statusCode === 401);
  });

  it('refuses an unsigned "alg: none" token', () => {
    // The classic JWT bypass. jsonwebtoken is configured with an explicit algorithm list,
    // and this asserts that configuration rather than trusting it.
    const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
    const body = Buffer.from(JSON.stringify({ sub: user.id, typ: 'access', role: 'admin' })).toString('base64url');
    assert.throws(() => verifyAccessToken(`${header}.${body}.`), (err) => err.code === 'TOKEN_INVALID');
  });

  it('reports expiry separately from invalidity, so the client knows to refresh', () => {
    const expired = jwt.sign({ sub: user.id, typ: 'access' }, config.tokens.accessSecret, {
      algorithm: 'HS256',
      issuer: config.tokens.issuer,
      expiresIn: -10,
    });
    assert.throws(() => verifyAccessToken(expired), (err) => err.code === 'TOKEN_EXPIRED' && err.statusCode === 401);
  });

  it('will not accept a refresh token as an access token', () => {
    // Different secrets already prevent this; the `typ` check is the second line of defence
    // in case the secrets are ever misconfigured to the same value.
    const { token } = signRefreshToken({ userId: user.id });
    assert.throws(() => verifyAccessToken(token), (err) => err.code === 'TOKEN_INVALID');
  });

  it('gives every token a distinct jti, so one session can be denylisted alone', () => {
    const first = signAccessToken(user);
    const second = signAccessToken(user);
    assert.notEqual(first.jti, second.jti);
  });
});

describe('refresh tokens', () => {
  it('returns the hash to store and never expects the raw token in the database', () => {
    const issued = signRefreshToken({ userId: user.id });
    assert.equal(issued.tokenHash, sha256(issued.token));
    assert.match(issued.tokenHash, /^[0-9a-f]{64}$/);
    assert.notEqual(issued.tokenHash, issued.token);
  });

  it('keeps a rotation family together', () => {
    const first = signRefreshToken({ userId: user.id });
    const rotated = signRefreshToken({ userId: user.id, familyId: first.familyId });

    assert.equal(rotated.familyId, first.familyId);
    assert.notEqual(rotated.jti, first.jti);
    assert.equal(verifyRefreshToken(rotated.token).fam, first.familyId);
  });

  it('starts a new family when none is given', () => {
    assert.notEqual(signRefreshToken({ userId: user.id }).familyId, signRefreshToken({ userId: user.id }).familyId);
  });

  it('uses its own error codes so the client clears the cookie instead of retrying', () => {
    const expired = jwt.sign({ sub: user.id, typ: 'refresh' }, config.tokens.refreshSecret, {
      algorithm: 'HS256',
      issuer: config.tokens.issuer,
      expiresIn: -10,
    });
    assert.throws(() => verifyRefreshToken(expired), (err) => err.code === 'REFRESH_EXPIRED');
    assert.throws(() => verifyRefreshToken('not.a.token'), (err) => err.code === 'REFRESH_INVALID');
  });

  it('will not accept an access token as a refresh token', () => {
    const { token } = signAccessToken(user);
    assert.throws(() => verifyRefreshToken(token), (err) => err.code === 'REFRESH_INVALID');
  });
});

describe('playback tokens', () => {
  const claims = { userId: user.id, titleId: randomUUID(), sessionId: randomUUID(), maxQuality: '1080p' };

  it('binds a stream to one user, one title and one session', () => {
    const payload = verifyPlaybackToken(signPlaybackToken(claims));
    assert.equal(payload.sub, claims.userId);
    assert.equal(payload.titleId, claims.titleId);
    assert.equal(payload.sessionId, claims.sessionId);
    assert.equal(payload.maxQuality, '1080p');
    assert.equal(payload.typ, 'playback');
  });

  it('expires on the configured window', () => {
    const payload = verifyPlaybackToken(signPlaybackToken(claims));
    const lifetime = payload.exp - payload.iat;
    assert.equal(lifetime, config.tokens.playbackTtlSeconds);
  });

  it('fails as a 403, not a 401 — the session is fine, the link is not', () => {
    assert.throws(
      () => verifyPlaybackToken('garbage'),
      (err) => err.statusCode === 403 && err.code === 'PLAYBACK_TOKEN_INVALID',
    );
  });

  it('cannot be substituted with an access token', () => {
    const { token } = signAccessToken(user);
    assert.throws(() => verifyPlaybackToken(token), (err) => err.code === 'PLAYBACK_TOKEN_INVALID');
  });
});

describe('sha256 and secondsUntilExpiry', () => {
  it('hashes deterministically', () => {
    assert.equal(sha256('abc'), sha256('abc'));
    assert.notEqual(sha256('abc'), sha256('abd'));
    assert.equal(sha256('abc').length, 64);
  });

  it('measures the remaining life of a decoded token', () => {
    const soon = Math.floor(Date.now() / 1000) + 60;
    const remaining = secondsUntilExpiry({ exp: soon });
    assert.ok(remaining > 55 && remaining <= 60, `got ${remaining}`);
  });

  it('never returns a negative TTL, because Redis would reject it', () => {
    assert.equal(secondsUntilExpiry({ exp: Math.floor(Date.now() / 1000) - 500 }), 0);
    assert.equal(secondsUntilExpiry({}), 0);
    assert.equal(secondsUntilExpiry(null), 0);
  });
});

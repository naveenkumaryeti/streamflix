import '../helpers/setup.js';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { NO_ENTITLEMENT, QUALITY_ORDER, allowedRenditions } from '../../src/modules/subscriptions/entitlements.js';

/**
 * The quality ceiling is the difference between the plans people actually pay for, so it is
 * worth testing on its own rather than only through the playback endpoint.
 */
describe('QUALITY_ORDER', () => {
  it('is ordered cheapest to best, because comparisons use the index', () => {
    assert.deepEqual(QUALITY_ORDER, ['480p', '720p', '1080p', '4k']);
  });
});

describe('NO_ENTITLEMENT', () => {
  it('denies playback and offers zero streams', () => {
    assert.equal(NO_ENTITLEMENT.active, false);
    assert.equal(NO_ENTITLEMENT.status, 'none');
    assert.equal(NO_ENTITLEMENT.maxStreams, 0);
    assert.equal(NO_ENTITLEMENT.planCode, null);
  });

  it('is frozen, so a caller cannot mutate the shared default', () => {
    // `load()` spreads it into a fresh object for exactly this reason.
    assert.equal(Object.isFrozen(NO_ENTITLEMENT), true);
    assert.throws(() => {
      'use strict';
      NO_ENTITLEMENT.active = true;
    });
    assert.equal(NO_ENTITLEMENT.active, false);
  });
});

describe('allowedRenditions', () => {
  const renditions = [
    { name: '480p', height: 480 },
    { name: '720p', height: 720 },
    { name: '1080p', height: 1080 },
    { name: '4k', height: 2160 },
  ];

  it('caps a mobile plan at 480p', () => {
    assert.deepEqual(
      allowedRenditions(renditions, '480p').map((r) => r.name),
      ['480p'],
    );
  });

  it('gives a standard plan everything up to 1080p', () => {
    assert.deepEqual(
      allowedRenditions(renditions, '1080p').map((r) => r.name),
      ['480p', '720p', '1080p'],
    );
  });

  it('gives a premium plan the whole ladder', () => {
    assert.equal(allowedRenditions(renditions, '4k').length, 4);
  });

  it('prefers an explicit maxQuality over the rendition name', () => {
    // An asset may be named by height while its playable ceiling is set by the encoder.
    const tagged = [
      { name: 'low', maxQuality: '480p' },
      { name: 'high', maxQuality: '1080p' },
    ];
    assert.deepEqual(
      allowedRenditions(tagged, '720p').map((r) => r.name),
      ['low'],
    );
  });

  it('passes everything through when the ceiling is unknown', () => {
    // A plan with an unrecognised quality string is a data problem, not a reason to hand
    // the player an empty ladder and a black screen.
    assert.equal(allowedRenditions(renditions, 'ultra').length, 4);
    assert.equal(allowedRenditions(renditions, null).length, 4);
    assert.equal(allowedRenditions(renditions, undefined).length, 4);
  });

  it('drops renditions whose quality is not on the ladder at all', () => {
    // indexOf returns -1, which is <= any ceiling, so an unknown rendition would sneak
    // through if the comparison were naive. It must not: the player would offer a stream
    // the plan has not paid for.
    const withJunk = [...renditions, { name: '8k' }];
    const names = allowedRenditions(withJunk, '720p').map((r) => r.name);
    assert.deepEqual(names, ['480p', '720p']);
  });

  it('handles an empty ladder', () => {
    assert.deepEqual(allowedRenditions([], '1080p'), []);
  });
});

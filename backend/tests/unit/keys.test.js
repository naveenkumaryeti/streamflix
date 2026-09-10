import '../helpers/setup.js';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  assertSafeKey,
  contentTypeFor,
  hlsPrefix,
  imageKey,
  isSafeKey,
  masterPlaylistKey,
  renditionPlaylistKey,
  safeExtension,
  sourceKey,
} from '../../src/media/keys.js';

/**
 * Storage keys are the one place where a client-supplied string reaches a filesystem path,
 * so these tests are as much about what is *rejected* as about the happy path.
 */
const TITLE_ID = '7c9e6679-7425-40de-944b-e07fc1f90ae7';

describe('safeExtension', () => {
  it('keeps a normal extension and lowercases it', () => {
    assert.equal(safeExtension('Trailer.MP4'), 'mp4');
    assert.equal(safeExtension('clip.mov'), 'mov');
  });

  it('falls back when there is no usable extension', () => {
    assert.equal(safeExtension('no-extension'), 'mp4');
    assert.equal(safeExtension(''), 'mp4');
    assert.equal(safeExtension(null), 'mp4');
    assert.equal(safeExtension('poster', 'jpg'), 'jpg');
  });

  it('rejects anything that is not a short alphanumeric run', () => {
    // A six-character extension, punctuation, or a nested dot are all suspicious enough
    // to discard rather than sanitise.
    assert.equal(safeExtension('movie.mpeg4x'), 'mp4');
    assert.equal(safeExtension('movie.m p4'), 'mp4');
    assert.equal(safeExtension('movie.tar.gz'), 'gz'); // last extension only
  });

  it('ignores directory components in a filename', () => {
    // A browser on Windows can send "C:\\Users\\me\\clip.mkv" as the filename.
    assert.equal(safeExtension('C:\\Users\\me\\clip.mkv'), 'mkv');
    assert.equal(safeExtension('../../etc/passwd.mp4'), 'mp4');
  });
});

describe('key builders', () => {
  it('derives every key from the title id, never from the filename', () => {
    assert.equal(sourceKey(TITLE_ID, 'My Movie (final).mov'), `sources/${TITLE_ID}/source.mov`);
    assert.equal(hlsPrefix(TITLE_ID), `hls/${TITLE_ID}`);
    assert.equal(masterPlaylistKey(TITLE_ID), `hls/${TITLE_ID}/master.m3u8`);
    assert.equal(renditionPlaylistKey(TITLE_ID, '720p'), `hls/${TITLE_ID}/720p/index.m3u8`);
    assert.equal(imageKey(TITLE_ID, 'poster', 'art.png'), `images/${TITLE_ID}/poster.png`);
  });

  it('defaults artwork to jpg', () => {
    assert.equal(imageKey(TITLE_ID, 'backdrop', 'screenshot'), `images/${TITLE_ID}/backdrop.jpg`);
  });

  it('produces keys that pass its own safety check', () => {
    for (const key of [
      sourceKey(TITLE_ID, 'x.mp4'),
      masterPlaylistKey(TITLE_ID),
      renditionPlaylistKey(TITLE_ID, '1080p'),
      imageKey(TITLE_ID, 'poster', 'p.jpg'),
    ]) {
      assert.equal(isSafeKey(key), true, key);
    }
  });
});

describe('isSafeKey', () => {
  it('accepts the keys this app generates', () => {
    assert.equal(isSafeKey('hls/abc/master.m3u8'), true);
    assert.equal(isSafeKey('images/abc-123/poster.jpg'), true);
    assert.equal(isSafeKey('sources/a_b.c/source.mp4'), true);
  });

  it('rejects traversal, absolute paths and backslashes', () => {
    assert.equal(isSafeKey('../secrets'), false);
    assert.equal(isSafeKey('hls/../../etc/passwd'), false);
    assert.equal(isSafeKey('/etc/passwd'), false);
    assert.equal(isSafeKey('hls\\abc\\master.m3u8'), false);
  });

  it('rejects empty, oversized and exotic keys', () => {
    assert.equal(isSafeKey(''), false);
    assert.equal(isSafeKey(null), false);
    assert.equal(isSafeKey(undefined), false);
    assert.equal(isSafeKey(`hls/${'a'.repeat(520)}`), false);
    assert.equal(isSafeKey('hls/abc/master.m3u8?x=1'), false);
    assert.equal(isSafeKey('hls/abc master.m3u8'), false);
    assert.equal(isSafeKey('hls/abc/\u0000master.m3u8'), false);
  });

  it('assertSafeKey throws on a rejected key and returns a good one', () => {
    assert.equal(assertSafeKey('hls/abc/master.m3u8'), 'hls/abc/master.m3u8');
    assert.throws(() => assertSafeKey('../x'), /unsafe storage key/);
  });
});

describe('contentTypeFor', () => {
  it('maps the HLS types a player insists on', () => {
    // Get these wrong and Safari refuses to play the stream at all.
    assert.equal(contentTypeFor('hls/x/master.m3u8'), 'application/vnd.apple.mpegurl');
    assert.equal(contentTypeFor('hls/x/720p/seg00001.ts'), 'video/mp2t');
    assert.equal(contentTypeFor('hls/x/720p/seg00001.m4s'), 'video/iso.segment');
  });

  it('maps sources and artwork', () => {
    assert.equal(contentTypeFor('sources/x/source.mp4'), 'video/mp4');
    assert.equal(contentTypeFor('sources/x/source.mkv'), 'video/x-matroska');
    assert.equal(contentTypeFor('images/x/poster.jpg'), 'image/jpeg');
    assert.equal(contentTypeFor('images/x/poster.webp'), 'image/webp');
    assert.equal(contentTypeFor('subs/x/en.vtt'), 'text/vtt');
  });

  it('falls back to octet-stream rather than guessing', () => {
    assert.equal(contentTypeFor('sources/x/source'), 'application/octet-stream');
    assert.equal(contentTypeFor('x/y.weird'), 'application/octet-stream');
  });
});

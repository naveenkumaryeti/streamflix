import '../helpers/setup.js';
import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';
import config from '../../src/config/env.js';
import { buildArgs, chooseRenditions } from '../../src/media/transcoder/ffmpegTranscoder.js';

/**
 * The ffmpeg command line is the most fragile thing in this codebase: one wrong flag and the
 * output either fails to mux or plays as a single-rendition stream that silently loses ABR.
 * These tests pin the parts that HLS playback depends on. They never spawn ffmpeg — that
 * belongs to an end-to-end run, not a unit suite.
 */
const args = (overrides = {}) =>
  buildArgs({
    input: '/tmp/in.mp4',
    outDir: '/tmp/out',
    renditions: config.media.renditions,
    hasAudio: true,
    ...overrides,
  });

/** ffmpeg flags are positional: `-x value`. This reads the value that follows a flag. */
const valueAfter = (list, flag) => list[list.indexOf(flag) + 1];

describe('chooseRenditions', () => {
  it('never upscales — a 480p source gets one rendition', () => {
    assert.deepEqual(
      chooseRenditions(480).map((r) => r.name),
      ['480p'],
    );
  });

  it('gives a 1080p source the full ladder', () => {
    assert.deepEqual(
      chooseRenditions(1080).map((r) => r.name),
      ['1080p', '720p', '480p'],
    );
  });

  it('offers only what fits under the source height', () => {
    assert.deepEqual(
      chooseRenditions(720).map((r) => r.name),
      ['720p', '480p'],
    );
    // A 4K source still tops out at the configured ladder; we do not invent a 2160p rung.
    assert.deepEqual(
      chooseRenditions(2160).map((r) => r.name),
      ['1080p', '720p', '480p'],
    );
  });

  it('clamps to an even source height when nothing fits', () => {
    // libx264 requires even dimensions, and a 361px-tall source would otherwise produce
    // "height not divisible by 2" and fail the whole job.
    const [only] = chooseRenditions(361);
    assert.equal(only.height, 360);
    assert.equal(only.name, '480p', 'keeps the smallest rung’s bitrate profile');

    assert.equal(chooseRenditions(144)[0].height, 144);
    assert.equal(chooseRenditions(1)[0].height, 2, 'never zero — ffmpeg would reject it');
  });

  it('falls back to the full ladder when the probe found no height', () => {
    assert.equal(chooseRenditions(0).length, config.media.renditions.length);
    assert.equal(chooseRenditions(undefined).length, config.media.renditions.length);
  });

  it('does not mutate the configured ladder when it clamps', () => {
    chooseRenditions(200);
    assert.equal(config.media.renditions.at(-1).height, 480);
  });
});

describe('buildArgs', () => {
  it('splits the decoded video once per rendition', () => {
    const list = args();
    const filter = valueAfter(list, '-filter_complex');

    assert.match(filter, /^\[0:v\]split=3\[v0\]\[v1\]\[v2\];/);
    // -2 keeps the aspect ratio *and* rounds the width to an even number for libx264.
    assert.match(filter, /\[v0\]scale=w=-2:h=1080\[v0out\]/);
    assert.match(filter, /\[v2\]scale=w=-2:h=480\[v2out\]/);
  });

  it('gives every output stream its own indexed bitrate', () => {
    const list = args();
    assert.equal(valueAfter(list, '-b:v:0'), '5000k');
    assert.equal(valueAfter(list, '-b:v:1'), '3000k');
    assert.equal(valueAfter(list, '-b:v:2'), '1200k');
    // Without the :N suffix the last value would win and every rendition would encode at
    // the same bitrate — an ABR ladder in name only.
    assert.equal(valueAfter(list, '-maxrate:v:0'), '5350k');
    assert.equal(valueAfter(list, '-bufsize:v:0'), '7500k');
  });

  it('names the variants, because the storage keys are derived from those names', () => {
    // `name:720p` is what makes ffmpeg write out/720p/index.m3u8, which publishOutputs
    // turns into hls/<id>/720p/index.m3u8 and the master playlist references.
    const streamMap = valueAfter(args(), '-var_stream_map');
    assert.equal(streamMap, 'v:0,a:0,name:1080p v:1,a:1,name:720p v:2,a:2,name:480p');
  });

  it('omits audio mappings entirely for a silent source', () => {
    const list = args({ hasAudio: false });
    assert.equal(valueAfter(list, '-var_stream_map'), 'v:0,name:1080p v:1,name:720p v:2,name:480p');
    assert.equal(list.includes('-c:a:0'), false);
    assert.equal(list.includes('a:0'), false, 'mapping a nonexistent audio stream aborts ffmpeg');
  });

  it('produces a VOD master playlist under the expected filenames', () => {
    const list = args();
    assert.equal(valueAfter(list, '-f'), 'hls');
    assert.equal(valueAfter(list, '-hls_playlist_type'), 'vod');
    assert.equal(valueAfter(list, '-master_pl_name'), 'master.m3u8');
    // path.join, so this holds on a Windows workstation as well as in the Linux image.
    assert.equal(valueAfter(list, '-hls_segment_filename'), path.join('/tmp/out', '%v', 'segment_%04d.ts'));
    assert.equal(list.at(-1), path.join('/tmp/out', '%v', 'index.m3u8'));
  });

  it('keeps segments aligned so a player can switch rendition mid-stream', () => {
    const list = args();
    // Fixed GOP, no scene-cut detection: every rendition cuts at the same frame, which is
    // the whole precondition for seamless ABR switching.
    assert.equal(valueAfter(list, '-g'), '48');
    assert.equal(valueAfter(list, '-keyint_min'), '48');
    assert.equal(valueAfter(list, '-sc_threshold'), '0');
    assert.equal(valueAfter(list, '-hls_time'), '6');
    assert.equal(valueAfter(list, '-hls_flags'), 'independent_segments');
  });

  it('asks for machine-readable progress on stdout', () => {
    // The worker parses out_time_us from stdout; -nostats keeps the human progress bar out.
    const list = args();
    assert.equal(valueAfter(list, '-progress'), 'pipe:1');
    assert.ok(list.includes('-nostats'));
  });

  it('overwrites without prompting, since a retry reuses the scratch directory', () => {
    assert.equal(args()[0], '-y');
    assert.equal(valueAfter(args(), '-i'), '/tmp/in.mp4');
  });

  it('handles a single-rendition job', () => {
    const list = args({ renditions: chooseRenditions(480) });
    assert.match(valueAfter(list, '-filter_complex'), /^\[0:v\]split=1\[v0\];/);
    assert.equal(valueAfter(list, '-var_stream_map'), 'v:0,a:0,name:480p');
  });
});

import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import config from '../../config/env.js';
import logger from '../../config/logger.js';
import storage from '../storage/index.js';
import { hlsPrefix, imageKey, masterPlaylistKey } from '../keys.js';
import { notify } from '../transcodeQueue.js';

/**
 * ffmpeg transcoder — the local equivalent of MediaConvert.
 *
 * It produces the same artefacts as the AWS path (an ABR master playlist plus one playlist
 * and segment set per rendition, under the same storage keys), so the player, the database
 * rows and the CDN layout are identical in both modes. Only the machine doing the work
 * changes: a worker pod here, a managed service there.
 *
 * Execution is out-of-band: `submit` rings the doorbell and the worker calls `run`.
 * An API pod must never spend minutes of CPU on a request.
 */
export const name = 'ffmpeg';
export const isAsync = true;

const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
const FFPROBE = process.env.FFPROBE_PATH || 'ffprobe';
const SEGMENT_SECONDS = 6;

const even = (n) => Math.max(2, Math.floor(n / 2) * 2);

function execute(bin, args, { onStdout } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    const errTail = [];

    child.stdout.on('data', (chunk) => {
      const text = String(chunk);
      if (onStdout) onStdout(text);
      else out += text;
    });
    child.stderr.on('data', (chunk) => {
      errTail.push(String(chunk));
      if (errTail.length > 40) errTail.shift(); // keep the tail, not the whole build banner
    });
    child.on('error', (err) =>
      reject(new Error(err.code === 'ENOENT' ? `${bin} is not installed in this image` : err.message)),
    );
    child.on('close', (code) =>
      code === 0 ? resolve(out) : reject(new Error(`${bin} exited ${code}: ${errTail.join('').slice(-800)}`)),
    );
  });
}

/** What we need to know before choosing renditions: duration, size and whether audio exists. */
export async function probeMedia(inputPath) {
  const raw = await execute(FFPROBE, [
    '-v', 'error',
    '-show_entries', 'format=duration:stream=codec_type,width,height',
    '-of', 'json',
    inputPath,
  ]);
  const parsed = JSON.parse(raw || '{}');
  const streams = parsed.streams ?? [];
  const video = streams.find((s) => s.codec_type === 'video') ?? {};
  return {
    durationSeconds: Number(parsed.format?.duration ?? 0),
    width: Number(video.width ?? 0),
    height: Number(video.height ?? 0),
    hasAudio: streams.some((s) => s.codec_type === 'audio'),
  };
}

/**
 * Never upscale: a 480p source gets one 480p rendition, not three identical ones with
 * different bitrates. If the source is smaller than every configured rendition, the
 * smallest is clamped to the source height so there is always something to play.
 */
export function chooseRenditions(sourceHeight) {
  const all = config.media.renditions;
  if (!sourceHeight) return all;
  const fits = all.filter((r) => r.height <= sourceHeight);
  if (fits.length) return fits;
  const smallest = all[all.length - 1];
  return [{ ...smallest, height: even(sourceHeight) }];
}

/** ABR in one pass: split the video, scale each branch, then let the HLS muxer fan out. */
export function buildArgs({ input, outDir, renditions, hasAudio }) {
  const split = renditions.map((_, i) => `[v${i}]`).join('');
  const chains = renditions.map((r, i) => `[v${i}]scale=w=-2:h=${r.height}[v${i}out]`).join('; ');

  const args = ['-y', '-i', input, '-filter_complex', `[0:v]split=${renditions.length}${split}; ${chains}`];

  renditions.forEach((r, i) => {
    args.push(
      '-map', `[v${i}out]`,
      `-c:v:${i}`, 'libx264',
      `-b:v:${i}`, `${r.videoBitrate}k`,
      `-maxrate:v:${i}`, `${Math.round(r.videoBitrate * 1.07)}k`,
      `-bufsize:v:${i}`, `${Math.round(r.videoBitrate * 1.5)}k`,
      '-preset', 'veryfast',
      '-profile:v', 'main',
      '-sc_threshold', '0',
      '-g', '48',
      '-keyint_min', '48',
    );
    if (hasAudio) args.push('-map', 'a:0', `-c:a:${i}`, 'aac', `-b:a:${i}`, `${r.audioBitrate}k`, '-ac', '2');
  });

  const streamMap = renditions
    .map((r, i) => (hasAudio ? `v:${i},a:${i},name:${r.name}` : `v:${i},name:${r.name}`))
    .join(' ');

  args.push(
    '-f', 'hls',
    '-hls_time', String(SEGMENT_SECONDS),
    '-hls_playlist_type', 'vod',
    '-hls_flags', 'independent_segments',
    '-hls_segment_type', 'mpegts',
    '-hls_segment_filename', path.join(outDir, '%v', 'segment_%04d.ts'),
    '-master_pl_name', 'master.m3u8',
    '-var_stream_map', streamMap,
    '-progress', 'pipe:1',
    '-nostats',
    path.join(outDir, '%v', 'index.m3u8'),
  );

  return args;
}

/** ffmpeg needs a real file. Local storage already has one; S3 gets streamed to /tmp. */
async function materialiseInput(inputKey, workDir) {
  if (typeof storage.localPath === 'function') return storage.localPath(inputKey);
  const target = path.join(workDir, path.basename(inputKey));
  const body = await storage.getObjectStream(inputKey);
  await pipeline(body, createWriteStream(target));
  return target;
}

async function walk(dir, base = dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await walk(full, base)));
    else files.push({ full, rel: path.relative(base, full).split(path.sep).join('/') });
  }
  return files;
}

/** Upload playlists last: until master.m3u8 exists, a player cannot start a partial stream. */
async function publishOutputs({ outDir, titleId }) {
  const files = await walk(outDir);
  const ordered = [...files.filter((f) => !f.rel.endsWith('.m3u8')), ...files.filter((f) => f.rel.endsWith('.m3u8'))];
  const prefix = hlsPrefix(titleId);
  let sizeBytes = 0;

  for (const file of ordered) {
    const stat = await fs.stat(file.full);
    sizeBytes += stat.size;
    await storage.putObject({ key: `${prefix}/${file.rel}`, body: createReadStream(file.full) });
  }

  const renditions = files
    .filter((f) => f.rel.endsWith('/index.m3u8'))
    .map((f) => ({ name: f.rel.split('/')[0], playlistKey: `${prefix}/${f.rel}` }));

  return { sizeBytes, renditions, masterKey: `${prefix}/master.m3u8` };
}

/** A frame from 10% in makes a better poster than frame 0, which is usually black. */
async function extractPoster({ input, workDir, titleId, atSeconds }) {
  const local = path.join(workDir, 'poster.jpg');
  try {
    await execute(FFMPEG, [
      '-y', '-ss', String(Math.max(1, Math.round(atSeconds))), '-i', input,
      '-frames:v', '1', '-vf', 'scale=w=-2:h=720', '-q:v', '3', local,
    ]);
    const key = imageKey(titleId, 'poster', 'poster.jpg');
    await storage.putObject({ key, body: createReadStream(local), contentType: 'image/jpeg' });
    return key;
  } catch (err) {
    logger.warn({ err: err.message, titleId }, 'poster extraction failed — keeping existing artwork');
    return null;
  }
}

/**
 * Called by the worker. Everything happens in a scratch directory that is removed on the
 * way out, so a crashed job leaves no half-written renditions in the storage bucket.
 */
export async function run(job, { onProgress } = {}) {
  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'streamflix-'));
  try {
    const input = await materialiseInput(job.inputKey, workDir);
    const probe = await probeMedia(input);
    if (!probe.height) throw new Error('the uploaded file has no readable video stream');

    const renditions = chooseRenditions(probe.height);
    const outDir = path.join(workDir, 'out');
    await Promise.all(renditions.map((r) => fs.mkdir(path.join(outDir, r.name), { recursive: true })));

    logger.info(
      { titleId: job.titleId, renditions: renditions.map((r) => r.name), durationSeconds: probe.durationSeconds },
      'transcode started',
    );

    let lastReported = 0;
    await execute(FFMPEG, buildArgs({ input, outDir, renditions, hasAudio: probe.hasAudio }), {
      onStdout: (text) => {
        const match = /out_time_us=(\d+)/.exec(text);
        if (!match || !probe.durationSeconds || !onProgress) return;
        const percent = Math.min(99, Math.round((Number(match[1]) / 1e6 / probe.durationSeconds) * 100));
        if (percent > lastReported + 4) {
          lastReported = percent;
          onProgress(percent);
        }
      },
    });

    const published = await publishOutputs({ outDir, titleId: job.titleId });
    const posterKey = await extractPoster({ input, workDir, titleId: job.titleId, atSeconds: probe.durationSeconds * 0.1 });

    return {
      durationSeconds: Math.round(probe.durationSeconds),
      width: probe.width,
      height: probe.height,
      hlsKey: masterPlaylistKey(job.titleId),
      posterKey,
      sizeBytes: published.sizeBytes,
      renditions: published.renditions.map((r) => {
        const spec = config.media.renditions.find((candidate) => candidate.name === r.name);
        return { ...r, height: spec?.height ?? probe.height, bitrateKbps: spec?.videoBitrate ?? null };
      }),
    };
  } finally {
    await fs.rm(workDir, { recursive: true, force: true });
  }
}

/** Submit = enqueue. The row is already in Postgres; this only wakes a worker. */
export async function submit({ jobId }) {
  await notify(jobId);
  return { provider: name, externalJobId: null, status: 'queued' };
}

/** Nothing to poll: the worker owns the row and updates it as it goes. */
export async function poll() {
  return null;
}

export default { name, isAsync, submit, poll, run, probeMedia, chooseRenditions, buildArgs };

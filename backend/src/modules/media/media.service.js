import config from '../../config/env.js';
import logger from '../../config/logger.js';
import { withTransaction } from '../../db/postgres.js';
import { transcodeJobs as transcodeJobsCounter } from '../../config/metrics.js';
import AppError from '../../utils/AppError.js';
import { invalidateCatalog } from '../../utils/cacheKeys.js';
import storage from '../../media/storage/index.js';
import cdn from '../../media/cdn/index.js';
import transcoder from '../../media/transcoder/index.js';
import { depth as queueDepth } from '../../media/transcodeQueue.js';
import { contentTypeFor, hlsPrefix, imageKey, isSafeKey, masterPlaylistKey, safeExtension, sourceKey } from '../../media/keys.js';
import * as titlesRepo from '../admin/titles.repository.js';
import * as auditRepo from '../audit/audit.repository.js';
import * as mediaRepo from './media.repository.js';

/**
 * The media pipeline: from "an admin picked a file" to "a player can start the stream".
 *
 * The sequence is the same in both modes, and each step is a separate call so a browser
 * upload that takes twenty minutes never sits inside one HTTP request:
 *
 *   1. POST /admin/titles/:id/upload-url   → a presigned S3 PUT, or a PUT against this API
 *   2. the browser uploads the bytes       → straight to S3 in production, never through a pod
 *   3. POST /admin/titles/:id/source       → we HEAD the object; no object, no job
 *   4. POST /admin/titles/:id/transcode    → a queued row, and a doorbell for the worker
 *   5. the worker (or MediaConvert) runs   → progress lands on the job row
 *   6. applyResult                         → assets + titles.hls_key, status 'ready'
 *   7. POST /admin/titles/:id/publish      → status 'published', catalogue cache dropped
 *
 * Nothing here trusts a key that arrived from a client: every one is rebuilt from the title
 * id, or checked against that title's own prefix before it reaches storage.
 */
const ACTIVE_JOB_STATES = new Set(['queued', 'submitted', 'processing']);
const SOURCE_EXTENSIONS = new Set(['mp4', 'mov', 'mkv', 'webm', 'm4v', 'mpg', 'mpeg', 'avi']);
const ARTWORK_COLUMNS = { poster: 'posterUrl', backdrop: 'backdropUrl' };

async function mustFindTitle(titleId) {
  const title = await titlesRepo.findById(titleId);
  if (!title) throw AppError.notFound('That title does not exist', 'TITLE_NOT_FOUND');
  return title;
}

/** Keys we accept from a client are always re-derived; this only guards the ones we cannot. */
function assertOwnedBy(titleId, key, prefix) {
  if (!isSafeKey(key) || !key.startsWith(`${prefix}/${titleId}/`)) {
    throw AppError.badRequest('That storage key does not belong to this title', 'KEY_SCOPE_MISMATCH');
  }
  return key;
}

/**
 * Step 1. The upload target is whatever the driver can offer: a presigned S3 PUT in
 * production, a PUT against this API in local mode. The frontend treats both the same way —
 * `PUT url` with the given headers — which is the whole point of the adapter.
 */
export async function createUploadTarget({ titleId, filename, contentType = null, actorId = null, ip = null }) {
  const title = await mustFindTitle(titleId);
  const extension = safeExtension(filename);
  if (!SOURCE_EXTENSIONS.has(extension)) {
    throw AppError.badRequest(
      `"${extension}" is not a video container we can transcode — use MP4, MOV, MKV or WebM`,
      'UNSUPPORTED_SOURCE_FORMAT',
    );
  }

  const key = sourceKey(title.id, filename);
  const resolvedType = contentType || contentTypeFor(key);
  const target = await storage.createUploadTarget({ key, contentType: resolvedType });

  // 'pending' until the bytes are confirmed present — see registerSource.
  await mediaRepo.upsertAsset({
    titleId: title.id,
    kind: 'source',
    storageKey: key,
    storageDriver: storage.name,
    bucket: target.bucket ?? null,
    contentType: resolvedType,
    status: 'pending',
  });
  if (title.status === 'draft') await titlesRepo.setStatus(title.id, 'uploading');

  auditRepo.record({
    actorId,
    action: 'title.upload.requested',
    entityType: 'title',
    entityId: title.id,
    metadata: { key, driver: storage.name, mode: target.mode },
    ip,
  });

  return { ...target, titleId: title.id, maxBytes: config.media.maxUploadBytes };
}

/**
 * Step 2, local mode only. In production this code path does not exist: the browser PUTs to
 * S3 and the bytes never touch a pod. Here the request body is streamed straight to disk, so
 * memory stays flat regardless of file size.
 */
export async function acceptUpload({ key, stream, contentType = null }) {
  if (typeof storage.localPath !== 'function') {
    throw AppError.badRequest('This deployment uploads directly to object storage', 'UPLOAD_MODE_MISMATCH');
  }
  if (!isSafeKey(key) || !/^(sources|images)\//.test(key)) {
    throw AppError.badRequest('That upload key is not valid', 'UPLOAD_KEY_INVALID');
  }

  const written = await storage.putObject({ key, body: stream, contentType: contentType || contentTypeFor(key) });
  logger.info({ key, sizeBytes: written.size }, 'upload stored');
  return { key, sizeBytes: written.size ?? null };
}

/**
 * Step 3. The HEAD is the point of this call: without it a client could claim an upload
 * finished and enqueue a transcode for an object that does not exist, and the failure would
 * surface minutes later inside the worker instead of immediately in the admin UI.
 */
export async function registerSource({ titleId, key = null, actorId = null, ip = null }) {
  const title = await mustFindTitle(titleId);
  const existing = await mediaRepo.findAsset(title.id, 'source');
  const storageKey = key ? assertOwnedBy(title.id, key, 'sources') : existing?.storageKey;
  if (!storageKey) throw AppError.badRequest('Upload the video file first', 'SOURCE_MISSING');

  const head = await storage.headObject(storageKey);
  if (!head) {
    throw AppError.badRequest(
      'That upload did not arrive — the file is not in storage. Try uploading again.',
      'SOURCE_MISSING',
    );
  }

  const asset = await mediaRepo.upsertAsset({
    titleId: title.id,
    kind: 'source',
    storageKey,
    storageDriver: storage.name,
    bucket: existing?.bucket ?? null,
    sizeBytes: head.size ?? null,
    contentType: head.contentType ?? contentTypeFor(storageKey),
    status: 'available',
  });
  if (['draft', 'failed'].includes(title.status)) await titlesRepo.setStatus(title.id, 'uploading');

  auditRepo.record({
    actorId,
    action: 'title.source.registered',
    entityType: 'title',
    entityId: title.id,
    metadata: { key: storageKey, sizeBytes: head.size },
    ip,
  });
  return asset;
}

/**
 * Step 4. Creating the row is the durable part; `submit` is best-effort notification. That
 * ordering matters: if Redis is down the doorbell fails silently and the worker still finds
 * the job on its next poll, whereas the reverse ordering would lose the work entirely.
 */
export async function startTranscode({ titleId, actorId = null, ip = null }) {
  const title = await mustFindTitle(titleId);

  const running = await mediaRepo.latestJobFor(title.id);
  if (running && ACTIVE_JOB_STATES.has(running.status)) {
    return { job: running, alreadyRunning: true };
  }

  const source = await mediaRepo.findAsset(title.id, 'source');
  if (!source) throw AppError.badRequest('Upload a video for this title first', 'SOURCE_MISSING');
  if (!(await storage.headObject(source.storageKey))) {
    throw AppError.badRequest('The uploaded file is gone from storage — upload it again', 'SOURCE_MISSING');
  }

  const job = await mediaRepo.createJob({
    titleId: title.id,
    provider: transcoder.name,
    inputKey: source.storageKey,
    outputPrefix: hlsPrefix(title.id),
  });
  await titlesRepo.setStatus(title.id, 'processing');

  try {
    const submitted = await transcoder.submit({ jobId: job.id, titleId: title.id, inputKey: source.storageKey });
    // Remote providers hand back an id we have to poll; the local worker owns the row instead.
    if (submitted?.externalJobId) await mediaRepo.markSubmitted(job.id, submitted.externalJobId);
    transcodeJobsCounter.inc({ provider: transcoder.name, state: 'submitted' });

    auditRepo.record({
      actorId,
      action: 'title.transcode.started',
      entityType: 'title',
      entityId: title.id,
      metadata: { jobId: job.id, provider: transcoder.name, externalJobId: submitted?.externalJobId ?? null },
      ip,
    });
    return { job: (await mediaRepo.findJob(job.id)) ?? job, alreadyRunning: false };
  } catch (err) {
    await mediaRepo.markFailed(job.id, err.message);
    await titlesRepo.setStatus(title.id, 'failed');
    transcodeJobsCounter.inc({ provider: transcoder.name, state: 'submit_failed' });
    logger.error({ err: err.message, titleId: title.id }, 'transcode submission failed');
    throw AppError.unavailable(`The transcoder rejected this job: ${err.message}`);
  }
}

/** Progress is advisory — it drives a bar in the admin UI and nothing else. */
export function reportProgress(job, percent) {
  return mediaRepo.markProgress(job.id, percent);
}

/**
 * Step 6. One transaction turns a finished transcode into a playable title: the rendition
 * inventory, the duration, and `titles.hls_key` — the single column playback actually reads.
 * If any part fails the title stays in 'processing' rather than becoming half-playable.
 */
export async function applyResult(job, result) {
  const hlsKey = result.hlsKey || masterPlaylistKey(job.titleId);
  const durationSeconds = Math.round(Number(result.durationSeconds ?? 0)) || null;

  const title = await withTransaction(async (client) => {
    await mediaRepo.upsertAsset(
      {
        titleId: job.titleId,
        kind: 'hls',
        storageKey: hlsKey,
        storageDriver: storage.name,
        width: result.width ?? null,
        height: result.height ?? null,
        sizeBytes: result.sizeBytes ?? null,
        durationSeconds,
        contentType: contentTypeFor(hlsKey),
        status: 'available',
      },
      client,
    );

    for (const rendition of result.renditions ?? []) {
      await mediaRepo.upsertAsset(
        {
          titleId: job.titleId,
          kind: 'hls',
          rendition: rendition.name,
          storageKey: rendition.playlistKey,
          storageDriver: storage.name,
          height: rendition.height ?? null,
          bitrateKbps: rendition.bitrateKbps ?? null,
          contentType: contentTypeFor(rendition.playlistKey),
          status: 'available',
        },
        client,
      );
    }

    const patch = { hlsKey, status: 'ready' };
    // The measured duration wins: "continue watching" percentages are computed from it.
    if (durationSeconds) patch.runtimeSeconds = durationSeconds;

    if (result.posterKey) {
      await mediaRepo.upsertAsset(
        {
          titleId: job.titleId,
          kind: 'poster',
          storageKey: result.posterKey,
          storageDriver: storage.name,
          contentType: contentTypeFor(result.posterKey),
          status: 'available',
        },
        client,
      );
      // Generated artwork only fills a gap — it never replaces a poster an admin chose.
      const current = await titlesRepo.findById(job.titleId, client);
      if (!current?.posterUrl) patch.posterUrl = cdn.publicUrl(result.posterKey);
    }

    const updated = await titlesRepo.update(job.titleId, patch, client);
    await mediaRepo.markSucceeded(job.id, client);
    return updated;
  });

  await invalidateCatalog();
  transcodeJobsCounter.inc({ provider: job.provider, state: 'succeeded' });
  auditRepo.record({
    action: 'title.transcode.succeeded',
    entityType: 'title',
    entityId: job.titleId,
    metadata: { jobId: job.id, hlsKey, durationSeconds, renditions: (result.renditions ?? []).map((r) => r.name) },
  });
  logger.info({ titleId: job.titleId, jobId: job.id, hlsKey }, 'title is ready to publish');
  return title;
}

/**
 * A failure that may be transient (a killed pod, a 500 from S3) goes back on the queue until
 * the attempt ceiling; anything else is terminal and the title turns 'failed' so an admin can
 * see it in the list and read the message instead of watching a spinner forever.
 */
export async function failJob(job, error, { retryable = false } = {}) {
  const message = error?.message ?? String(error ?? 'transcode failed');
  const updated = await mediaRepo.markFailed(job.id, message, { retryable });

  if (updated?.status === 'failed') {
    await titlesRepo.setStatus(job.titleId, 'failed');
    transcodeJobsCounter.inc({ provider: job.provider, state: 'failed' });
    auditRepo.record({
      action: 'title.transcode.failed',
      entityType: 'title',
      entityId: job.titleId,
      metadata: { jobId: job.id, error: message, attempts: updated.attempts },
    });
  } else {
    transcodeJobsCounter.inc({ provider: job.provider, state: 'requeued' });
  }

  logger.warn({ jobId: job.id, titleId: job.titleId, status: updated?.status, err: message }, 'transcode job failed');
  return updated;
}

/**
 * MediaConvert path only. The worker asks the service how each outstanding job is doing;
 * ffmpeg's `poll` returns null because the worker that runs it owns the row directly.
 */
export async function pollRemoteJobs({ limit = 25 } = {}) {
  const jobs = await mediaRepo.pendingRemoteJobs(limit);
  let finished = 0;

  for (const job of jobs) {
    try {
      const state = await transcoder.poll({ externalJobId: job.externalJobId, titleId: job.titleId });
      if (!state) continue;

      if (state.status === 'succeeded') {
        await applyResult(job, state);
        finished += 1;
      } else if (state.status === 'failed' || state.status === 'canceled') {
        await failJob(job, new Error(state.errorMessage || 'the transcoder reported a failure'));
        finished += 1;
      } else {
        await mediaRepo.markProgress(job.id, state.progress ?? 0);
      }
    } catch (err) {
      // A polling error is not a job failure — the next tick asks again.
      logger.warn({ err: err.message, jobId: job.id }, 'could not poll transcode job');
    }
  }

  return { polled: jobs.length, finished };
}

/** Crash recovery, called on a timer by the worker. */
export async function reapStaleJobs({ staleMinutes = config.worker.staleMinutes } = {}) {
  const rows = await mediaRepo.reapStale({ staleMinutes });
  for (const job of rows) {
    if (job.status === 'failed') await titlesRepo.setStatus(job.titleId, 'failed');
    transcodeJobsCounter.inc({ provider: job.provider, state: job.status === 'failed' ? 'failed' : 'requeued' });
  }
  if (rows.length) logger.warn({ count: rows.length }, 'stale transcode jobs reaped');
  return rows;
}

/**
 * Artwork upload. Small files, so these do go through the API: a poster is a few hundred
 * kilobytes and multipart is simpler than a presigned round trip for something that size.
 */
export async function uploadArtwork({ titleId, kind, filename, body, contentType = null, actorId = null, ip = null }) {
  const column = ARTWORK_COLUMNS[kind];
  if (!column) throw AppError.badRequest('Artwork is either a poster or a backdrop', 'UNSUPPORTED_ARTWORK_KIND');

  const title = await mustFindTitle(titleId);
  const key = imageKey(title.id, kind, filename);
  const resolvedType = contentType || contentTypeFor(key);
  const stored = await storage.putObject({ key, body, contentType: resolvedType });

  await mediaRepo.upsertAsset({
    titleId: title.id,
    kind,
    storageKey: key,
    storageDriver: storage.name,
    sizeBytes: stored.size ?? null,
    contentType: resolvedType,
    status: 'available',
  });

  const url = cdn.publicUrl(key);
  const updated = await titlesRepo.update(title.id, { [column]: url });
  await invalidateCatalog();

  auditRepo.record({
    actorId,
    action: `title.artwork.${kind}`,
    entityType: 'title',
    entityId: title.id,
    metadata: { key, url },
    ip,
  });
  return { kind, key, url, title: updated };
}

/** What the admin detail page shows under "media": the inventory plus the newest job. */
export async function mediaFor(titleId) {
  const [assets, job] = await Promise.all([mediaRepo.listAssets(titleId), mediaRepo.latestJobFor(titleId)]);
  const source = assets.find((asset) => asset.kind === 'source' && asset.status === 'available') ?? null;
  return {
    assets,
    job,
    source,
    hasSource: Boolean(source),
    drivers: { storage: storage.name, transcoder: transcoder.name, cdn: cdn.name },
  };
}

/**
 * Deleting a title cascades its rows; the objects in storage are nobody's dependency and
 * have to be removed explicitly, or the bucket keeps paying for renditions of a title that
 * no longer exists.
 */
export async function purge(titleId) {
  await mediaRepo.cancelJobs(titleId);
  const prefixes = [`${hlsPrefix(titleId)}/`, `sources/${titleId}/`, `images/${titleId}/`];
  const removed = [];

  for (const prefix of prefixes) {
    try {
      await storage.deletePrefix(prefix);
      removed.push(prefix);
    } catch (err) {
      // Best effort: a failed cleanup must not block the delete the admin asked for.
      logger.warn({ err: err.message, prefix }, 'storage cleanup failed — object may be orphaned');
    }
  }

  await mediaRepo.deleteAssets(titleId);
  return { prefixes: removed };
}

/** Pipeline health for the admin dashboard: what is queued, and who is doing the work. */
export async function queueSnapshot() {
  const [counts, doorbell] = await Promise.all([mediaRepo.jobCounts(), queueDepth()]);
  return {
    counts,
    doorbell,
    drivers: { storage: storage.name, transcoder: transcoder.name, cdn: cdn.name },
  };
}

export default {
  createUploadTarget,
  acceptUpload,
  registerSource,
  startTranscode,
  reportProgress,
  applyResult,
  failJob,
  pollRemoteJobs,
  reapStaleJobs,
  uploadArtwork,
  mediaFor,
  purge,
  queueSnapshot,
};

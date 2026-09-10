import { query, queryMany, queryOne } from '../../db/postgres.js';
import config from '../../config/env.js';

/**
 * Assets and transcode jobs.
 *
 * `assets` is the inventory of every object we produced for a title (the source, the HLS
 * renditions, the artwork). Nothing plays from it — playback only needs `titles.hls_key` —
 * but it is what makes cleanup, re-transcoding and storage accounting possible instead of
 * guesswork over bucket listings.
 */
const ASSET = `
  a.id,
  a.title_id         AS "titleId",
  a.kind,
  a.storage_driver   AS "storageDriver",
  a.bucket,
  a.storage_key      AS "storageKey",
  a.rendition,
  a.width,
  a.height,
  a.bitrate_kbps     AS "bitrateKbps",
  a.size_bytes       AS "sizeBytes",
  a.duration_seconds AS "durationSeconds",
  a.content_type     AS "contentType",
  a.status,
  a.created_at       AS "createdAt"
`;

const JOB = `
  j.id,
  j.title_id        AS "titleId",
  j.provider,
  j.external_job_id AS "externalJobId",
  j.status,
  j.progress,
  j.input_key       AS "inputKey",
  j.output_prefix   AS "outputPrefix",
  j.error_message   AS "errorMessage",
  j.attempts,
  j.submitted_at    AS "submittedAt",
  j.completed_at    AS "completedAt",
  j.created_at      AS "createdAt"
`;

async function one(client, text, params) {
  if (!client) return queryOne(text, params);
  const { rows } = await client.query(text, params);
  return rows[0] ?? null;
}

/**
 * Idempotent by (title, kind, rendition) — the expression unique index in migration 003.
 * Re-running a transcode overwrites the previous rendition row instead of accumulating
 * duplicates that all point at the same key.
 */
export async function upsertAsset(
  {
    titleId,
    kind,
    storageKey,
    storageDriver = 'local',
    bucket = null,
    rendition = null,
    width = null,
    height = null,
    bitrateKbps = null,
    sizeBytes = null,
    durationSeconds = null,
    contentType = null,
    status = 'available',
  },
  client = null,
) {
  return one(
    client,
    `INSERT INTO assets (
       title_id, kind, storage_driver, bucket, storage_key, rendition, width, height,
       bitrate_kbps, size_bytes, duration_seconds, content_type, status
     ) VALUES ($1, $2::asset_kind, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::asset_status)
     ON CONFLICT (title_id, kind, coalesce(rendition, '')) DO UPDATE SET
       storage_driver = EXCLUDED.storage_driver,
       bucket         = EXCLUDED.bucket,
       storage_key    = EXCLUDED.storage_key,
       width          = EXCLUDED.width,
       height         = EXCLUDED.height,
       bitrate_kbps   = EXCLUDED.bitrate_kbps,
       size_bytes     = EXCLUDED.size_bytes,
       duration_seconds = EXCLUDED.duration_seconds,
       content_type   = EXCLUDED.content_type,
       status         = EXCLUDED.status
     RETURNING ${ASSET.replaceAll('a.', '')}`,
    [
      titleId,
      kind,
      storageDriver,
      bucket,
      storageKey,
      rendition,
      width,
      height,
      bitrateKbps,
      sizeBytes,
      durationSeconds,
      contentType,
      status,
    ],
  );
}

export function listAssets(titleId) {
  return queryMany(`SELECT ${ASSET} FROM assets a WHERE a.title_id = $1 ORDER BY a.kind, a.rendition NULLS FIRST`, [
    titleId,
  ]);
}

export function findAsset(titleId, kind, rendition = null) {
  return queryOne(
    `SELECT ${ASSET} FROM assets a
      WHERE a.title_id = $1 AND a.kind = $2::asset_kind AND coalesce(a.rendition, '') = coalesce($3, '')`,
    [titleId, kind, rendition],
  );
}

export async function deleteAssets(titleId, kind = null) {
  const { rowCount } = await query(
    `DELETE FROM assets WHERE title_id = $1 AND ($2::text IS NULL OR kind = $2::asset_kind)`,
    [titleId, kind],
  );
  return rowCount;
}

/** Storage bill by title, biggest first — the report that answers "why is S3 so expensive". */
export function storageTotals(limit = 10) {
  return queryMany(
    `SELECT t.id, t.title, t.slug, coalesce(sum(a.size_bytes), 0) AS "sizeBytes", count(a.id) AS assets
       FROM titles t LEFT JOIN assets a ON a.title_id = t.id
      GROUP BY t.id ORDER BY "sizeBytes" DESC LIMIT $1`,
    [limit],
  );
}

/* ------------------------------------------------------------------ transcode jobs */

export function createJob({ titleId, provider, inputKey, outputPrefix }, client = null) {
  return one(
    client,
    `INSERT INTO transcode_jobs (title_id, provider, input_key, output_prefix, status)
     VALUES ($1, $2, $3, $4, 'queued')
     RETURNING ${JOB.replaceAll('j.', '')}`,
    [titleId, provider, inputKey, outputPrefix],
  );
}

export function findJob(id) {
  return queryOne(`SELECT ${JOB} FROM transcode_jobs j WHERE j.id = $1`, [id]);
}

export function latestJobFor(titleId) {
  return queryOne(`SELECT ${JOB} FROM transcode_jobs j WHERE j.title_id = $1 ORDER BY j.created_at DESC LIMIT 1`, [
    titleId,
  ]);
}

export function listJobs({ status = '', limit = 50 } = {}) {
  return queryMany(
    `SELECT ${JOB}, t.title, t.slug
       FROM transcode_jobs j JOIN titles t ON t.id = j.title_id
      WHERE ($1::text = '' OR j.status = $1::transcode_status)
      ORDER BY j.created_at DESC LIMIT $2`,
    [status, limit],
  );
}

/**
 * The heart of the worker.
 *
 * `FOR UPDATE SKIP LOCKED` is what lets N workers share one queue table without a broker:
 * each transaction locks the row it takes and every other worker steps over it instead of
 * blocking. The `UPDATE … WHERE id = (SELECT …)` shape keeps claim-and-mark atomic, so a
 * worker that dies after claiming leaves a `processing` row we can reap (see `reapStale`)
 * rather than a job two workers both believe they own.
 *
 * Redis only rings a doorbell to wake the loop; this statement is the queue of record, so a
 * flushed Redis costs latency and nothing else.
 *
 * `submitted_at` means the same thing in both drivers — the moment the job was handed to
 * whoever does the work — so the staleness reaper below needs no per-provider special case.
 */
export async function claimNext({ provider, maxAttempts = config.worker.maxAttempts } = {}) {
  return queryOne(
    `UPDATE transcode_jobs SET
       status       = 'processing',
       attempts     = attempts + 1,
       progress     = 0,
       submitted_at = now(),
       error_message = NULL
     WHERE id = (
       SELECT j.id FROM transcode_jobs j
        WHERE j.status = 'queued' AND j.provider = $1 AND j.attempts < $2
        ORDER BY j.created_at
        FOR UPDATE SKIP LOCKED
        LIMIT 1
     )
     RETURNING ${JOB.replaceAll('j.', '')}`,
    [provider, maxAttempts],
  );
}

/** MediaConvert path: we hand off and then poll, so the row remembers the provider's id. */
export function markSubmitted(id, externalJobId, client = null) {
  return one(
    client,
    `UPDATE transcode_jobs SET status = 'submitted', external_job_id = $2, submitted_at = now(), attempts = attempts + 1
      WHERE id = $1 RETURNING ${JOB.replaceAll('j.', '')}`,
    [id, externalJobId],
  );
}

/**
 * Progress writes are deliberately not wrapped in a transaction and never fail the job:
 * a progress bar is not worth losing a transcode over.
 */
export async function markProgress(id, progress, status = 'processing') {
  const { rowCount } = await query(
    `UPDATE transcode_jobs SET progress = greatest(0, least(100, $2::int)), status = $3::transcode_status
      WHERE id = $1 AND status <> 'canceled'`,
    [id, Math.round(progress ?? 0), status],
  );
  return rowCount > 0;
}

export function markSucceeded(id, client = null) {
  return one(
    client,
    `UPDATE transcode_jobs SET status = 'succeeded', progress = 100, completed_at = now(), error_message = NULL
      WHERE id = $1 RETURNING ${JOB.replaceAll('j.', '')}`,
    [id],
  );
}

/**
 * A failure is retryable until `attempts` hits the ceiling; putting the row back to `queued`
 * is how the next worker picks it up, and `failed` is the terminal state an admin sees.
 *
 * The ceiling is the same value `claimNext` filters on — if the two ever disagreed, a job
 * would be requeued into a state no worker would ever claim, and it would sit there forever.
 */
export function markFailed(
  id,
  errorMessage,
  { retryable = false, maxAttempts = config.worker.maxAttempts } = {},
  client = null,
) {
  return one(
    client,
    `UPDATE transcode_jobs SET
       status        = CASE WHEN $3 AND attempts < $4 THEN 'queued'::transcode_status ELSE 'failed'::transcode_status END,
       error_message = left($2, 2000),
       completed_at  = CASE WHEN $3 AND attempts < $4 THEN NULL ELSE now() END
     WHERE id = $1
     RETURNING ${JOB.replaceAll('j.', '')}`,
    [id, String(errorMessage ?? 'transcode failed'), retryable, maxAttempts],
  );
}

export function cancelJobs(titleId) {
  return query(
    `UPDATE transcode_jobs SET status = 'canceled', completed_at = now()
      WHERE title_id = $1 AND status IN ('queued', 'submitted', 'processing')`,
    [titleId],
  );
}

/** Rows the MediaConvert poller still has to ask about. */
export function pendingRemoteJobs(limit = 25) {
  return queryMany(
    `SELECT ${JOB} FROM transcode_jobs j
      WHERE j.status IN ('submitted', 'processing') AND j.external_job_id IS NOT NULL
      ORDER BY j.submitted_at NULLS FIRST LIMIT $1`,
    [limit],
  );
}

/**
 * Crash recovery. A worker killed mid-transcode leaves a `processing` row nobody owns; after
 * `staleMinutes` we assume the owner is gone and hand the job back to the queue.
 */
export async function reapStale({ staleMinutes = config.worker.staleMinutes, maxAttempts = config.worker.maxAttempts } = {}) {
  const rows = await queryMany(
    `UPDATE transcode_jobs SET
       status        = CASE WHEN attempts < $2 THEN 'queued'::transcode_status ELSE 'failed'::transcode_status END,
       error_message = 'worker stopped responding — job requeued',
       progress      = 0
     WHERE status = 'processing' AND external_job_id IS NULL
       AND coalesce(submitted_at, created_at) < now() - make_interval(mins => $1::int)
     RETURNING ${JOB.replaceAll('j.', '')}`,
    [staleMinutes, maxAttempts],
  );
  return rows;
}

export function jobCounts() {
  return queryOne(`
    SELECT count(*) FILTER (WHERE status = 'queued')     AS "queued",
           count(*) FILTER (WHERE status = 'submitted')  AS "submitted",
           count(*) FILTER (WHERE status = 'processing') AS "processing",
           count(*) FILTER (WHERE status = 'succeeded')  AS "succeeded",
           count(*) FILTER (WHERE status = 'failed')     AS "failed"
      FROM transcode_jobs
  `);
}

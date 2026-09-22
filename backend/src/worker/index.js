import http from 'node:http';
import config from '../config/env.js';
import logger from '../config/logger.js';
import { registry, transcodeJobs as transcodeJobsCounter } from '../config/metrics.js';
import { checkDatabase, closeDatabase } from '../db/postgres.js';
import { connectRedis, closeRedis } from '../db/redis.js';
import { closeDynamo } from '../db/dynamodb.js';
import transcoder from '../media/transcoder/index.js';
import { depth as queueDepth, waitForSignal } from '../media/transcodeQueue.js';
import * as mediaRepo from '../modules/media/media.repository.js';
import * as mediaService from '../modules/media/media.service.js';
import * as subscriptionsService from '../modules/subscriptions/subscriptions.service.js';
import * as refreshTokenRepo from '../modules/auth/refreshToken.repository.js';

/**
 * The worker: everything that must not happen inside an HTTP request.
 *
 * It is a separate process (and a separate Deployment) from the API for two reasons that both
 * come down to resources. A transcode pins a CPU for minutes, so it must not compete with
 * request handling; and video work scales on a different axis from traffic, so the two need
 * their own replica counts and their own instance types.
 *
 * Three things run here:
 *
 *   1. the transcode loop      — claims `queued` jobs from Postgres and runs ffmpeg
 *   2. the MediaConvert poller — asks AWS how the jobs it submitted are doing
 *   3. maintenance timers      — stale-job reaping, subscription expiry, token cleanup
 *
 * Only one of (1) and (2) is ever active: the transcoder driver decides which. In local mode
 * the worker does the encoding itself; with MediaConvert the encoding happens in AWS and the
 * worker's job is to notice when it finished.
 */
const DOORBELL_TIMEOUT_SECONDS = 5;
const IDLE_SLEEP_MS = 2_000;

/** ffmpeg can run locally; MediaConvert only hands work to AWS and polls it. */
const canTranscodeLocally = typeof transcoder.run === 'function';

const state = {
  running: true,
  startedAt: Date.now(),
  lastTickAt: Date.now(),
  active: new Map(), // jobId -> { titleId, startedAt, percent }
  completed: 0,
  failed: 0,
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Retry or give up?
 *
 * The distinction is whether a second attempt could plausibly succeed. A dead socket, a 500
 * from S3 or a killed process are all worth retrying. A file with no video stream, or an
 * ffmpeg exit caused by unsupported input, will fail identically forever — retrying it three
 * times only delays the moment an admin sees a useful error message.
 */
const TRANSIENT_PATTERNS = [
  /ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|EAI_AGAIN|ENOTFOUND/i,
  /socket hang up|network|timeout/i,
  /SlowDown|ServiceUnavailable|InternalError|RequestTimeout|503|500/,
  /ENOSPC|EMFILE/i, // disk or descriptors: another pod may have room
];

function looksTransient(err) {
  const text = `${err?.name ?? ''} ${err?.code ?? ''} ${err?.message ?? ''}`;
  if (/no readable video stream|unsupported|invalid data|moov atom not found/i.test(text)) return false;
  return TRANSIENT_PATTERNS.some((pattern) => pattern.test(text));
}

/**
 * One job, start to finish. Progress is throttled to whole steps of 5% because the admin UI
 * polls it — writing every ffmpeg heartbeat would be a UPDATE per second per job for a bar
 * nobody watches that closely.
 */
async function processJob(job) {
  const startedAt = Date.now();
  state.active.set(job.id, { titleId: job.titleId, startedAt, percent: 0 });
  logger.info({ jobId: job.id, titleId: job.titleId, attempt: job.attempts }, 'transcode claimed');

  try {
    const result = await transcoder.run(job, {
      onProgress: (percent) => {
        const entry = state.active.get(job.id);
        if (entry) entry.percent = percent;
        // Fire-and-forget: a failed progress write must never abort a transcode.
        void mediaService.reportProgress(job, percent).catch(() => {});
      },
    });

    await mediaService.applyResult(job, result);
    state.completed += 1;
    logger.info(
      { jobId: job.id, titleId: job.titleId, seconds: Math.round((Date.now() - startedAt) / 1000) },
      'transcode finished',
    );
  } catch (err) {
    state.failed += 1;
    const retryable = looksTransient(err);
    await mediaService.failJob(job, err, { retryable }).catch((failErr) => {
      // If even the failure write fails, the reaper will pick the row up later.
      logger.error({ err: failErr.message, jobId: job.id }, 'could not record the job failure');
    });
  } finally {
    state.active.delete(job.id);
  }
}

/**
 * One consumer. `config.worker.concurrency` of these run side by side; `FOR UPDATE SKIP
 * LOCKED` inside `claimNext` is what keeps them from stepping on each other, both within this
 * process and across every other worker pod.
 *
 * The wait order matters: claim first, *then* block on the doorbell. Starting the other way
 * round would leave jobs that were queued while the worker was busy sitting until the next
 * signal arrived — which, if the admin uploaded only one file, would be never.
 */
async function consume(slot) {
  const log = logger.child({ slot });

  while (state.running) {
    state.lastTickAt = Date.now();
    try {
      const job = await mediaRepo.claimNext({ provider: transcoder.name });
      if (job) {
        await processJob(job);
        continue;
      }

      // Nothing queued: block on Redis so a new job wakes us in milliseconds, and fall back
      // to a short sleep when Redis is unavailable so the queue still drains.
      const signal = await waitForSignal(DOORBELL_TIMEOUT_SECONDS);
      if (!signal) await sleep(IDLE_SLEEP_MS);
    } catch (err) {
      // Usually a dropped Postgres connection. Back off so a restarting database is not
      // hammered by every slot in every pod at once.
      log.error({ err: err.message }, 'transcode loop error — backing off');
      await sleep(5_000);
    }
  }

  log.debug('consumer stopped');
}

/* -------------------------------------------------------------------- periodic work */

/**
 * A timer that cannot overlap itself and cannot crash the process. Long tasks (polling a
 * hundred MediaConvert jobs) would otherwise stack up if one tick outlived its interval.
 */
function every(name, intervalMs, task) {
  let inFlight = false;

  const tick = async () => {
    if (inFlight || !state.running) return;
    inFlight = true;
    try {
      const result = await task();
      if (result) logger.debug({ task: name, result }, 'maintenance tick');
    } catch (err) {
      logger.error({ err: err.message, task: name }, 'maintenance task failed');
    } finally {
      inFlight = false;
    }
  };

  const timer = setInterval(tick, intervalMs);
  timer.unref();
  return { name, timer, tick };
}

const timers = [];

function scheduleMaintenance() {
  if (canTranscodeLocally) {
    // Locally-run jobs are the only ones that can be orphaned by a killed pod: the row says
    // `processing` and the process that owned it is gone. MediaConvert jobs are recovered by
    // polling instead, which is why this only runs on the ffmpeg path.
    timers.push(every('reap-stale-jobs', 5 * 60_000, () => mediaService.reapStaleJobs()));
  } else {
    timers.push(
      every('poll-remote-jobs', config.worker.remotePollSeconds * 1_000, async () => {
        state.lastTickAt = Date.now();
        const { polled, finished } = await mediaService.pollRemoteJobs();
        return polled ? { polled, finished } : null;
      }),
    );
  }

  /**
   * Subscriptions end on a date, not on an event: nothing tells us the moment a plan lapses.
   * This sweep is what turns "period_end has passed" into an actual loss of entitlement, and
   * it also refreshes the cached entitlement so playback stops allowing new streams.
   */
  timers.push(
    every('sweep-subscriptions', 10 * 60_000, async () => {
      const ended = await subscriptionsService.sweepExpired();
      return ended.length ? { expired: ended.length } : null;
    }),
  );

  /** Revoked and long-expired refresh tokens are dead weight; keeping them grows the index. */
  timers.push(
    every('prune-refresh-tokens', 6 * 3_600_000, async () => {
      const removed = await refreshTokenRepo.deleteExpired({ olderThanDays: 7 });
      return removed ? { removed } : null;
    }),
  );
}

/* ------------------------------------------------------------------ probes and metrics */

/**
 * A worker has no traffic, so Kubernetes needs another way to tell a healthy process from a
 * wedged one. Liveness here is "the loop is moving *or* a job is in progress" — the second
 * half matters, because a two-hour 4K encode is a perfectly healthy pod that has not ticked.
 */
const LIVENESS_STALL_MS = 120_000;

function livenessPayload() {
  const stalled = Date.now() - state.lastTickAt > LIVENESS_STALL_MS && state.active.size === 0;
  return {
    status: stalled ? 'stalled' : 'ok',
    service: 'streamflix-worker',
    driver: transcoder.name,
    mode: canTranscodeLocally ? 'encoder' : 'poller',
    uptimeSeconds: Math.round((Date.now() - state.startedAt) / 1000),
    active: [...state.active.entries()].map(([jobId, entry]) => ({
      jobId,
      titleId: entry.titleId,
      percent: entry.percent,
      seconds: Math.round((Date.now() - entry.startedAt) / 1000),
    })),
    completed: state.completed,
    failed: state.failed,
    stalled,
  };
}

const health = http.createServer(async (req, res) => {
  const send = (status, body) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  };

  try {
    if (req.url === '/healthz') {
      const payload = livenessPayload();
      return send(payload.stalled ? 503 : 200, payload);
    }

    if (req.url === '/readyz') {
      const db = await checkDatabase().catch((err) => ({ ok: false, error: err.message }));
      const queued = await queueDepth();
      return send(db.ok ? 200 : 503, { status: db.ok ? 'ready' : 'not-ready', postgres: db, doorbell: queued });
    }

    if (req.url === '/metrics' && config.metricsEnabled) {
      res.writeHead(200, { 'Content-Type': registry.contentType });
      return res.end(await registry.metrics());
    }

    return send(404, { error: { message: `No route matches ${req.url}` } });
  } catch (err) {
    logger.error({ err: err.message, url: req.url }, 'worker probe failed');
    return send(500, { error: { message: 'probe failed' } });
  }
});

/* --------------------------------------------------------------------------- lifecycle */

let shuttingDown = false;

async function start() {
  const db = await checkDatabase().catch((err) => ({ ok: false, error: err.message }));
  if (!db.ok) {
    logger.fatal({ error: db.error }, 'cannot reach PostgreSQL — refusing to start');
    process.exit(1);
  }

  // The doorbell needs Redis, but the queue does not: without it the loop polls every 2s.
  await connectRedis({ required: false });

  scheduleMaintenance();
  for (const timer of timers) void timer.tick(); // don't wait for the first interval

  const consumers = canTranscodeLocally
    ? Array.from({ length: config.worker.concurrency }, (_, slot) => consume(slot + 1))
    : [];

  health.listen(config.worker.port, () => {
    logger.info(
      {
        port: config.worker.port,
        driver: transcoder.name,
        mode: canTranscodeLocally ? 'encoder' : 'poller',
        concurrency: consumers.length,
        maxAttempts: config.worker.maxAttempts,
      },
      'streamflix worker started',
    );
  });

  await Promise.all(consumers);
}

/**
 * Shutdown is where a worker differs most from an API. A transcode in flight is minutes of
 * CPU we would rather not throw away, so SIGTERM stops *claiming* new work and then waits.
 * If the grace period runs out the process exits anyway and the row is left `processing`,
 * which `reapStaleJobs` hands back to the queue — no job is silently lost either way.
 */
async function shutdown(signal) {
  if (shuttingDown) {
    logger.warn({ signal }, 'second signal during shutdown — exiting now');
    process.exit(1);
  }
  shuttingDown = true;
  state.running = false;

  const active = state.active.size;
  logger.info({ signal, active }, active ? 'draining — waiting for jobs in flight' : 'shutting down');

  for (const { timer } of timers) clearInterval(timer);
  health.close();

  const deadline = Date.now() + config.shutdownTimeoutMs;
  while (state.active.size > 0 && Date.now() < deadline) await sleep(500);

  if (state.active.size > 0) {
    logger.warn(
      { active: state.active.size },
      'grace period expired with jobs still running — they will be requeued by the reaper',
    );
    for (const [, entry] of state.active) {
      transcodeJobsCounter.inc({ provider: transcoder.name, state: 'interrupted' });
      logger.warn({ titleId: entry.titleId, percent: entry.percent }, 'transcode interrupted');
    }
  }

  const results = await Promise.allSettled([closeRedis(), closeDatabase(), Promise.resolve(closeDynamo())]);
  for (const result of results) {
    if (result.status === 'rejected') logger.error({ err: result.reason }, 'error closing a dependency');
  }

  logger.info({ completed: state.completed, failed: state.failed }, 'worker stopped');
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

process.on('unhandledRejection', (reason) => {
  logger.fatal({ err: reason }, 'unhandled promise rejection');
  void shutdown('unhandledRejection');
});

process.on('uncaughtException', (err) => {
  logger.fatal({ err }, 'uncaught exception');
  void shutdown('uncaughtException');
});

start().catch((err) => {
  logger.fatal({ err }, 'worker failed to start');
  process.exit(1);
});

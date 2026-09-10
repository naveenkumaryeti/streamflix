import { Router } from 'express';
import config from '../../config/env.js';
import logger from '../../config/logger.js';
import { registry } from '../../config/metrics.js';
import { checkDatabase } from '../../db/postgres.js';
import { checkRedis, isRedisReady } from '../../db/redis.js';
import { checkDynamo } from '../../db/dynamodb.js';

/**
 * Probes and metrics, mounted at the root rather than under /api/v1 — kubelet and Prometheus
 * do not speak versioned APIs, and the paths here are what the Deployment and the
 * ServiceMonitor in the Helm chart point at.
 *
 * The split between the two probes is the important part:
 *
 *   /healthz  liveness  — "is this process wedged?" It touches nothing external, because a
 *                          Postgres outage must not make Kubernetes restart every pod.
 *   /readyz   readiness — "should traffic come here?" Postgres is required; Redis and
 *                          DynamoDB are reported but do not remove a pod from the load
 *                          balancer, since the API degrades rather than fails without them.
 */
const router = Router();

const startedAt = Date.now();

router.get('/healthz', (_req, res) => {
  res.json({ status: 'ok', service: 'streamflix-api', env: config.env, uptimeSeconds: process.uptime() });
});

async function probe(name, fn) {
  try {
    return [name, await fn()];
  } catch (err) {
    return [name, { ok: false, error: err.message }];
  }
}

router.get('/readyz', async (_req, res) => {
  const checks = Object.fromEntries(
    await Promise.all([
      probe('postgres', checkDatabase),
      probe('redis', () => (isRedisReady() ? checkRedis() : { ok: false, error: 'not connected', required: false })),
      probe('dynamodb', checkDynamo),
    ]),
  );

  const ready = checks.postgres.ok === true;
  if (!ready) logger.warn({ checks }, 'readiness probe failed');
  res.status(ready ? 200 : 503).json({ status: ready ? 'ready' : 'not-ready', checks });
});

/** Prometheus scrape target. Disabled by config in environments that do not scrape. */
router.get('/metrics', async (_req, res, next) => {
  if (!config.metricsEnabled) return res.status(404).json({ error: { message: 'Metrics are disabled' } });
  try {
    res.setHeader('Content-Type', registry.contentType);
    return res.end(await registry.metrics());
  } catch (err) {
    return next(err);
  }
});

/** Handy in a cluster: which build is actually running here. */
router.get('/version', (_req, res) => {
  res.json({
    service: 'streamflix-api',
    env: config.env,
    version: process.env.APP_VERSION || 'dev',
    commit: process.env.GIT_COMMIT || null,
    node: process.version,
    startedAt: new Date(startedAt).toISOString(),
    drivers: {
      storage: config.media.storageDriver,
      transcoder: config.media.transcoderDriver,
      cdn: config.media.cdnDriver,
      payments: config.payments.provider,
    },
  });
});

export default router;

import client from 'prom-client';
import config from './env.js';

/**
 * Prometheus metrics scraped by the Prometheus Operator in EKS (Phase 12).
 * Labels stay low-cardinality: we report the Express route pattern, never the raw URL,
 * otherwise every title id would create a new time series.
 */
export const registry = new client.Registry();
registry.setDefaultLabels({ service: 'streamflix-api', env: config.env });
client.collectDefaultMetrics({ register: registry });

export const httpRequestDuration = new client.Histogram({
  name: 'http_request_duration_seconds',
  help: 'HTTP request duration in seconds',
  labelNames: ['method', 'route', 'status'],
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [registry],
});

export const httpRequestsTotal = new client.Counter({
  name: 'http_requests_total',
  help: 'Total HTTP requests',
  labelNames: ['method', 'route', 'status'],
  registers: [registry],
});

export const playbackSessionsStarted = new client.Counter({
  name: 'streamflix_playback_sessions_started_total',
  help: 'Playback sessions successfully started',
  labelNames: ['quality'],
  registers: [registry],
});

export const transcodeJobs = new client.Counter({
  name: 'streamflix_transcode_jobs_total',
  help: 'Transcode jobs by terminal state',
  labelNames: ['provider', 'state'],
  registers: [registry],
});

export const cacheEvents = new client.Counter({
  name: 'streamflix_cache_events_total',
  help: 'Redis cache hits and misses',
  labelNames: ['result'],
  registers: [registry],
});

function routeLabel(req) {
  if (req.route?.path) {
    const base = req.baseUrl || '';
    const suffix = req.route.path === '/' ? '' : req.route.path;
    return `${base}${suffix}` || '/';
  }
  return req.originalUrl?.startsWith('/media') ? '/media/*' : 'unmatched';
}

export function metricsMiddleware(req, res, next) {
  if (!config.metricsEnabled) return next();
  const end = httpRequestDuration.startTimer();
  res.on('finish', () => {
    const labels = { method: req.method, route: routeLabel(req), status: String(res.statusCode) };
    end(labels);
    httpRequestsTotal.inc(labels);
  });
  return next();
}

export default registry;

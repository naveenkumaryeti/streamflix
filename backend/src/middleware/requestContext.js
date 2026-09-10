import crypto from 'node:crypto';
import logger from '../config/logger.js';

const HEALTH_PATHS = new Set(['/healthz', '/readyz', '/metrics']);

/**
 * Gives every request an id (reused from the ALB/CloudFront header when present) and a
 * child logger, then logs one line per completed request. Trace ids make it possible to
 * follow a single user action across api, worker and CloudWatch.
 */
export function requestContext(req, res, next) {
  const incoming = req.headers['x-request-id'] || req.headers['x-amzn-trace-id'];
  req.id = typeof incoming === 'string' && incoming.length <= 200 ? incoming : crypto.randomUUID();
  res.setHeader('X-Request-Id', req.id);

  req.log = logger.child({ requestId: req.id });
  const startedAt = process.hrtime.bigint();

  res.on('finish', () => {
    if (HEALTH_PATHS.has(req.path)) return; // probes every few seconds; not worth a log line
    const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
    const payload = {
      method: req.method,
      url: req.originalUrl,
      status: res.statusCode,
      durationMs: Math.round(durationMs),
      ip: req.ip,
      userId: req.user?.id,
    };
    if (res.statusCode >= 500) req.log.error(payload, 'request failed');
    else if (res.statusCode >= 400) req.log.warn(payload, 'request rejected');
    else req.log.info(payload, 'request completed');
  });

  next();
}

export default requestContext;

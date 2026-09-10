import config from '../config/env.js';
import { incrementWindow, key } from '../db/redis.js';
import AppError from '../utils/AppError.js';

/**
 * Redis-backed fixed-window rate limiter.
 *
 * Why Redis and not an in-process counter: in EKS the API runs as N pods behind an ALB,
 * so a per-process counter would let an attacker send N× the intended traffic.
 * If Redis is unreachable the limiter fails open — availability beats throttling here,
 * and the WAF rate rule in front of CloudFront is the second line of defence.
 */
export function rateLimit({
  name = 'global',
  max = config.rateLimit.max,
  windowSeconds = config.rateLimit.windowSeconds,
  by = 'ip',
  message,
} = {}) {
  return async function rateLimiter(req, res, next) {
    try {
      const identity =
        by === 'user' ? req.user?.id ?? req.ip : by === 'email' ? String(req.body?.email ?? req.ip).toLowerCase() : req.ip;
      const windowKey = key('rl', name, identity);
      const result = await incrementWindow(windowKey, windowSeconds);
      if (!result) return next(); // fail open

      res.setHeader('X-RateLimit-Limit', String(max));
      res.setHeader('X-RateLimit-Remaining', String(Math.max(0, max - result.count)));
      res.setHeader('X-RateLimit-Reset', String(result.ttl));

      if (result.count > max) {
        return next(AppError.tooMany(message ?? 'Too many requests — try again shortly', result.ttl));
      }
      return next();
    } catch {
      return next();
    }
  };
}

/** Tight limit for credential endpoints: brute force protection per email and per IP. */
export const authRateLimit = () => [
  rateLimit({ name: 'auth-ip', max: config.rateLimit.authMax, windowSeconds: 300, by: 'ip' }),
  rateLimit({
    name: 'auth-email',
    max: config.rateLimit.authMax,
    windowSeconds: 900,
    by: 'email',
    message: 'Too many attempts for this account — wait a few minutes',
  }),
];

export default rateLimit;

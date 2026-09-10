import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import compression from 'compression';
import cookieParser from 'cookie-parser';
import config from './config/env.js';
import { metricsMiddleware } from './config/metrics.js';
import AppError from './utils/AppError.js';
import requestContext from './middleware/requestContext.js';
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js';
import { rateLimit } from './middleware/rateLimit.js';
import healthRoutes from './modules/health/health.routes.js';
import mediaRoutes from './modules/media/media.routes.js';
import apiRoutes from './routes.js';

/**
 * The Express application, kept separate from the server that listens on a port so tests can
 * import it without binding one and so the worker can reuse the same modules without
 * accidentally starting an HTTP listener.
 *
 * The middleware order below is deliberate; each step assumes the previous one ran:
 *
 *   trust proxy → request id/logging → metrics → security headers → CORS → compression
 *   → cookies → body parsing → global rate limit → routes → 404 → error handler
 */
const app = express();

/**
 * Behind an ALB (and CloudFront in front of that), `req.ip` is only trustworthy if Express
 * knows how many proxies to skip. Rate limiting and audit rows both record it, so getting
 * this wrong either throttles the whole internet as one client or lets a header spoof it.
 */
app.set('trust proxy', config.trustProxy);
app.disable('x-powered-by');
app.set('etag', 'strong');

app.use(requestContext);
app.use(metricsMiddleware);

app.use(
  helmet({
    // This process serves JSON and video, never HTML, so a CSP here protects nothing while
    // reliably breaking media players. The frontend's nginx sets its own.
    contentSecurityPolicy: false,
    // helmet defaults to `same-origin`, which stops a <video> on the web origin from loading
    // HLS segments served here. The playback token is the access control, not the header.
    crossOriginResourcePolicy: { policy: 'cross-origin' },
    referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
  }),
);

/**
 * An allowlist, not a wildcard: credentials ride in the Authorization header and the
 * playback cookie, and `Access-Control-Allow-Origin: *` cannot be combined with those.
 * Requests without an Origin (curl, the compose healthcheck, server-to-server) are allowed —
 * CORS is a browser mechanism and rejecting them would only break tooling.
 */
const allowedOrigins = new Set(config.corsOrigins);
app.use(
  cors({
    origin(origin, done) {
      if (!origin || allowedOrigins.has(origin)) return done(null, true);
      return done(AppError.forbidden(`Origin ${origin} is not allowed`, 'ORIGIN_NOT_ALLOWED'));
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'Idempotency-Key', 'X-Request-Id', 'X-StreamFlix-Signature'],
    exposedHeaders: ['X-Request-Id', 'Retry-After'],
    maxAge: 600,
  }),
);

/**
 * Compression pays for itself on JSON and manifests. It must never touch `/media`: video
 * segments are already compressed, and gzipping them would buffer megabytes per request for
 * no gain — and would strip the Content-Length that seeking depends on.
 */
app.use(
  compression({
    filter: (req, res) => !req.path.startsWith('/media') && compression.filter(req, res),
  }),
);

app.use(cookieParser());

/**
 * Body parsing, with two carve-outs.
 *
 * `/subscriptions/webhook` verifies an HMAC over the exact bytes the provider sent, so the
 * JSON parser must not consume them first — body-parser marks a request as parsed and the
 * route's own `express.raw` would then be skipped, leaving the controller an object where it
 * expects a Buffer. That failure looks exactly like a wrong secret, which is a miserable
 * afternoon, so the parser is skipped by path instead.
 *
 * `/admin/media/upload` receives multi-gigabyte video and is piped straight to storage.
 */
const RAW_BODY_PATHS = [`${config.apiPrefix}/subscriptions/webhook`, `${config.apiPrefix}/admin/media/upload`];
const jsonParser = express.json({ limit: '1mb' });
const formParser = express.urlencoded({ extended: false, limit: '1mb' });

app.use((req, res, next) => {
  if (RAW_BODY_PATHS.includes(req.path)) return next();
  return jsonParser(req, res, (err) => (err ? next(err) : formParser(req, res, next)));
});

/**
 * A coarse per-IP ceiling in front of everything. The interesting limits are per-route and
 * per-user (login, search, playback start, subscribe); this one exists so a single client
 * cannot exhaust the connection pool while those finer limits are still counting.
 */
app.use(
  config.apiPrefix,
  rateLimit({ name: 'global', max: config.rateLimit.max, windowSeconds: config.rateLimit.windowSeconds }),
);

// Probes and metrics live at the root: kubelet and Prometheus do not speak /api/v1.
app.use('/', healthRoutes);

// Local CDN. In production CDN_DRIVER=cloudfront and nothing routes here.
app.use('/media', mediaRoutes);

app.use(config.apiPrefix, apiRoutes);

app.use(notFoundHandler);
app.use(errorHandler);

export default app;

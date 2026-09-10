import http from 'node:http';
import config from './config/env.js';
import logger from './config/logger.js';
import app from './app.js';
import { closeDatabase, checkDatabase } from './db/postgres.js';
import { connectRedis, closeRedis } from './db/redis.js';
import { closeDynamo } from './db/dynamodb.js';

/**
 * API entrypoint.
 *
 * The shape of this file is dictated by running under Kubernetes:
 *
 *  - Postgres is verified once before the port opens, so a pod with a bad DATABASE_URL fails
 *    visibly at boot instead of serving 500s that look like application bugs.
 *  - Redis is connected but not required. Cache and rate limiting fail open, so a Redis
 *    outage should cost latency, never availability.
 *  - SIGTERM drains rather than exits: kubelet sends it, then waits, then sends SIGKILL.
 *    In-flight requests get to finish, and `/readyz` starts failing immediately so the
 *    Service stops sending new ones.
 */
const server = http.createServer(app);

/**
 * Keep-alive must outlive the load balancer's idle timeout (60s by default on an ALB),
 * otherwise the balancer occasionally reuses a socket the server is closing and the client
 * sees a 502 that no log explains.
 */
server.keepAliveTimeout = 65_000;
server.headersTimeout = 66_000;

/**
 * Node's default 5-minute request timeout is fine for JSON and fatal for a multi-gigabyte
 * upload on a slow connection. Uploads are bounded by MAX_UPLOAD_BYTES and by the
 * Content-Length guard on the route, so bytes — not wall clock — are the limit that matters.
 * `headersTimeout` above still protects against a client that dribbles out its headers.
 */
server.requestTimeout = 30 * 60_000;

let shuttingDown = false;

async function start() {
  const db = await checkDatabase().catch((err) => ({ ok: false, error: err.message }));
  if (!db.ok) {
    logger.fatal({ error: db.error }, 'cannot reach PostgreSQL — refusing to start');
    process.exit(1);
  }

  // required:false — see the note above about failing open.
  await connectRedis({ required: false });

  server.listen(config.port, () => {
    logger.info(
      {
        port: config.port,
        env: config.env,
        apiPrefix: config.apiPrefix,
        drivers: {
          storage: config.media.storageDriver,
          transcoder: config.media.transcoderDriver,
          cdn: config.media.cdnDriver,
          payments: config.payments.provider,
        },
      },
      'streamflix api listening',
    );
  });
}

/**
 * Drain, then close dependencies. The timer is the important part: if a socket refuses to
 * close (a stalled upload, a hung query), the process still exits before kubelet escalates
 * to SIGKILL, which would otherwise cut the logs off mid-shutdown.
 */
async function shutdown(signal) {
  if (shuttingDown) {
    logger.warn({ signal }, 'second signal during shutdown — exiting now');
    process.exit(1);
  }
  shuttingDown = true;
  logger.info({ signal }, 'shutting down');

  const forced = setTimeout(() => {
    logger.error('graceful shutdown timed out — forcing exit');
    process.exit(1);
  }, config.shutdownTimeoutMs);
  forced.unref();

  server.close(async (err) => {
    if (err) logger.error({ err }, 'error while closing the http server');
    const results = await Promise.allSettled([closeRedis(), closeDatabase(), Promise.resolve(closeDynamo())]);
    for (const result of results) {
      if (result.status === 'rejected') logger.error({ err: result.reason }, 'error closing a dependency');
    }
    logger.info('shutdown complete');
    process.exit(err ? 1 : 0);
  });

  // Idle keep-alive sockets would otherwise hold the server open for the full timeout.
  if (typeof server.closeIdleConnections === 'function') server.closeIdleConnections();
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

/**
 * A rejected promise nobody handled means some invariant is already broken. Log it with the
 * stack and let the orchestrator replace the pod rather than keep serving from an unknown
 * state — a restart is cheap when there are three replicas behind a Service.
 */
process.on('unhandledRejection', (reason) => {
  logger.fatal({ err: reason }, 'unhandled promise rejection');
  void shutdown('unhandledRejection');
});

process.on('uncaughtException', (err) => {
  logger.fatal({ err }, 'uncaught exception');
  void shutdown('uncaughtException');
});

start().catch((err) => {
  logger.fatal({ err }, 'failed to start');
  process.exit(1);
});

export default server;

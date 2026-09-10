import { ZodError } from 'zod';
import config from '../config/env.js';
import logger from '../config/logger.js';
import AppError from '../utils/AppError.js';

// Postgres error codes we can translate into something a user can act on.
const PG_CODES = {
  '23505': (err) => AppError.conflict(uniqueMessage(err), 'ALREADY_EXISTS'),
  '23503': () => AppError.badRequest('That reference does not exist'),
  '23514': () => AppError.badRequest('A value is outside the allowed range'),
  '22P02': () => AppError.badRequest('Malformed identifier'),
  '40001': () => AppError.conflict('The record changed while you were saving — try again', 'RETRY'),
  '57014': () => new AppError(503, 'QUERY_TIMEOUT', 'That query took too long'),
};

function uniqueMessage(err) {
  if (String(err.constraint).includes('email')) return 'That email is already registered';
  if (String(err.constraint).includes('slug')) return 'A title with that name already exists';
  if (String(err.constraint).includes('idempotency')) return 'This payment was already submitted';
  return 'That already exists';
}

function normalise(err) {
  if (err instanceof AppError) return err;

  if (err instanceof ZodError) {
    return AppError.validation('Some fields need attention', {
      fields: err.issues.map((issue) => ({ field: issue.path.join('.') || '_', message: issue.message })),
    });
  }

  if (err?.code && PG_CODES[err.code]) return PG_CODES[err.code](err);

  // body-parser: malformed JSON / oversized payload
  if (err?.type === 'entity.parse.failed') return AppError.badRequest('Request body is not valid JSON');
  if (err?.type === 'entity.too.large') return new AppError(413, 'PAYLOAD_TOO_LARGE', 'Request body is too large');

  // multer
  if (err?.code === 'LIMIT_FILE_SIZE') {
    return new AppError(413, 'FILE_TOO_LARGE', 'That file is larger than the upload limit');
  }
  if (err?.code === 'LIMIT_UNEXPECTED_FILE') return AppError.badRequest('Unexpected file field');

  // AWS SDK / network problems surface as service unavailable, never as a 500 with a stack.
  if (err?.name === 'TimeoutError' || err?.code === 'ECONNREFUSED' || err?.code === 'ETIMEDOUT') {
    return AppError.unavailable('A dependency is not responding — try again in a moment');
  }

  return null;
}

// eslint-disable-next-line no-unused-vars -- Express identifies error handlers by arity (4).
export function errorHandler(err, req, res, next) {
  const known = normalise(err);
  const log = req.log ?? logger;

  if (!known) {
    log.error({ err, url: req.originalUrl, method: req.method }, 'unhandled error');
    return res.status(500).json({
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Something went wrong on our side',
        requestId: req.id,
        ...(config.isProduction ? {} : { debug: err?.message, stack: err?.stack?.split('\n').slice(0, 5) }),
      },
    });
  }

  if (known.statusCode >= 500) log.error({ err: known }, known.message);
  else log.debug({ code: known.code, status: known.statusCode }, known.message);

  if (known.code === 'RATE_LIMITED' && known.details?.retryAfterSeconds) {
    res.setHeader('Retry-After', String(known.details.retryAfterSeconds));
  }

  return res.status(known.statusCode).json({
    error: {
      code: known.code,
      message: known.message,
      ...(known.details ? { details: known.details } : {}),
      requestId: req.id,
    },
  });
}

export function notFoundHandler(req, res) {
  res.status(404).json({
    error: {
      code: 'ROUTE_NOT_FOUND',
      message: `No route matches ${req.method} ${req.path}`,
      requestId: req.id,
    },
  });
}

export default errorHandler;

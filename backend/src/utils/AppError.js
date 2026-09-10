/**
 * Every failure the API returns on purpose is an AppError, so the error handler can
 * distinguish "expected, tell the client" from "bug, log it and return 500".
 *
 * `code` is a stable machine-readable string the frontend can switch on
 * (e.g. SUBSCRIPTION_REQUIRED opens the plans page instead of showing a toast).
 */

/**
 * The 4xx factories that carry structured details (`badRequest`, `payment`) accept either a
 * specific code or a details object in the same position. Both are common — "this is a bad
 * request *because* POSTER_REQUIRED" and "this is a bad request, here are the fields" — and
 * requiring the caller to remember the order of two optional arguments is how you end up with
 * `code: { fields: [...] }` in a JSON response and a frontend that cannot switch on it.
 */
function split(codeOrDetails, fallbackCode) {
  if (typeof codeOrDetails === 'string' && codeOrDetails) return { code: codeOrDetails, details: undefined };
  return { code: fallbackCode, details: codeOrDetails ?? undefined };
}

export class AppError extends Error {
  constructor(statusCode, code, message, details = undefined) {
    super(message);
    this.name = 'AppError';
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
    this.expected = true;
    Error.captureStackTrace?.(this, AppError);
  }

  static badRequest(message = 'Invalid request', codeOrDetails) {
    const { code, details } = split(codeOrDetails, 'BAD_REQUEST');
    return new AppError(400, code, message, details);
  }

  static validation(message = 'Some fields need attention', details) {
    return new AppError(422, 'VALIDATION_FAILED', message, details);
  }

  static unauthorized(message = 'Sign in to continue', code = 'UNAUTHORIZED') {
    return new AppError(401, code, message);
  }

  static forbidden(message = 'You do not have access to this', code = 'FORBIDDEN') {
    return new AppError(403, code, message);
  }

  static notFound(message = 'Not found', code = 'NOT_FOUND') {
    return new AppError(404, code, message);
  }

  static conflict(message = 'That already exists', code = 'CONFLICT') {
    return new AppError(409, code, message);
  }

  static tooMany(message = 'Too many requests — try again shortly', retryAfterSeconds) {
    return new AppError(429, 'RATE_LIMITED', message, { retryAfterSeconds });
  }

  static payment(message = 'Payment could not be completed', codeOrDetails) {
    const { code, details } = split(codeOrDetails, 'PAYMENT_FAILED');
    return new AppError(402, code, message, details);
  }

  static subscriptionRequired(message = 'An active plan is needed to watch this') {
    return new AppError(403, 'SUBSCRIPTION_REQUIRED', message);
  }

  static streamLimit(maxStreams) {
    return new AppError(
      409,
      'STREAM_LIMIT_REACHED',
      `Your plan allows ${maxStreams} ${maxStreams === 1 ? 'screen' : 'screens'} at a time. Stop watching on another device to continue.`,
      { maxStreams },
    );
  }

  static unavailable(message = 'Service temporarily unavailable') {
    return new AppError(503, 'SERVICE_UNAVAILABLE', message);
  }
}

export default AppError;
